'use strict';
// Always-listening speech: one sliding window of audio per listener,
// transcribed again, whole, at every pause, so each word is recognized with
// up to a minute or two of context before it.
//
// Audio arrives as 16 kHz mono 16-bit PCM. A voice-activity gate with an
// adaptive noise floor (the InkType speech bridge's: the quietest frame of
// the last ten seconds, times 2.5, never below a fixed minimum) splits it
// into speech and silence:
// - Silence is not kept: at most SILENCE_KEEP of each pause stays in the
//   window. Listening all day costs nothing while nobody talks, and the
//   window's length is speech, not time.
// - A short pause (ROUND_PAUSE) after speech transcribes the window again:
//   the live text.
// - A longer pause (UTTERANCE_PAUSE) ends an utterance: what was said since
//   the last one is handed on to be understood (a command, dictation…).
// - Past 1.2 × its target length the window slides back to about 0.8 ×:
//   the audio before a pause near that point is transcribed once more on
//   its own, that text becomes final ("committed") and the audio leaves the
//   window. The window averages its target; a slide (one extra pass over
//   the head) comes once per ~0.4 × target of speech.
//
// The transcriber is injected (transcribe(pcm) → text), so the whole
// behavior runs faster than real time in tests.

const RATE = 16000;
const BYTES_PER_SECOND = RATE * 2;
const FRAME_BYTES = BYTES_PER_SECOND / 10;            // one 100 ms frame
const FLOOR_FRAMES = 100;                              // ~10 s of noise-floor history
const FLOOR_WARMUP = 20;                               // ~2 s before the floor is trusted
const SILENCE_RMS_MIN = 30;
const SILENCE_FACTOR = 2.5;
const ROUND_PAUSE = 3;                                 // frames: ~300 ms → transcribe
const UTTERANCE_PAUSE = 8;                             // frames: ~800 ms → end of utterance
const SILENCE_KEEP = 4;                                // frames of each pause kept in the window
const MIN_ROUND_BYTES = BYTES_PER_SECOND / 4;          // a quarter second: "send" is short
const MIN_HEAD_BYTES = BYTES_PER_SECOND * 4;           // never commit less than this
const MIN_TAIL_BYTES = BYTES_PER_SECOND * 2;           // always keep this much rolling
const COMMITTED_KEEP_WORDS = 400;
const SLIDE_OVER = 1.2;                                // slide past this × target…
const SLIDE_TO = 0.8;                                  // …back to about this × target                      // final text kept for display and alignment

const WINDOW_SECONDS = Object.freeze({ min: 15, default: 60, max: 180 });

function clampWindowSeconds(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(WINDOW_SECONDS.min, Math.min(WINDOW_SECONDS.max, n)) : WINDOW_SECONDS.default;
}

function frameRms(buf, offset) {
  let sum = 0;
  const n = FRAME_BYTES / 2;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(offset + i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

const normWord = w => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/**
 * Where word `index` of `prev` is in `next`, when `next` is a later
 * transcription of mostly the same speech (words revised, merged, split).
 * Aligns by the longest common subsequence over normalized words, looking
 * only at the last `span` words of each. Returns the index in `next` right
 * after the last aligned word at or before `index`.
 */
function mapWordIndex(prev, index, next, span = 80) {
  return alignWordIndex(prev, index, next, span).index;
}

/**
 * mapWordIndex, and whether the mapping is sure: the word just before
 * `index` is itself found in `next`. When the recognizer rewrote it (more
 * context, another language), the count is a guess.
 */
function alignWordIndex(prev, index, next, span = 80) {
  if (index <= 0) return { index: 0, sure: true };
  const a0 = Math.max(0, index - span), b0 = Math.max(0, next.length - span * 2);
  const a = prev.slice(a0, index).map(normWord), b = next.slice(b0).map(normWord);
  // LCS table (small: ≤ span × 2·span).
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the alignment; remember where the last matched word of `a` sits in `b`.
  let i = 0, j = 0, lastA = -1, lastB = -1;
  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) { lastA = i; lastB = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  if (lastB < 0) return { index: Math.min(next.length, b0 + Math.max(0, index - a0)), sure: false }; // nothing in common: keep the count
  // After the last word both share, as many words as `prev` had after it:
  // a rewritten word is usually replaced by one word.
  if (lastA === a.length - 1) return { index: b0 + lastB + 1, sure: true };
  return { index: Math.min(next.length, b0 + lastB + 1 + (a.length - 1 - lastA)), sure: false };
}

class VoiceWindow {
  /**
   * @param {object} o
   * @param {(pcm: Buffer) => Promise<string>} o.transcribe
   * @param {(event: object) => void} o.emit  heard / utterance / slide / error events
   * @param {number} [o.windowSeconds]
   */
  constructor({ transcribe, emit, windowSeconds = WINDOW_SECONDS.default }) {
    this.transcribe = transcribe;
    this.emit = emit;
    this.setWindowSeconds(windowSeconds);
    this.window = Buffer.alloc(0);   // speech audio (silences shortened)
    this.pending = Buffer.alloc(0);  // bytes short of a whole frame
    this.floor = [];                 // recent frame RMS
    this.silentRun = 0;              // silent frames in a row
    this.speechSinceRound = false;
    this.speechSinceUtterance = false;
    this.cuts = [];                  // window offsets at the ends of pauses (where a slide may cut)
    this.committed = [];             // final words (last COMMITTED_KEEP_WORDS)
    this.windowWords = [];           // the last round's words of the window
    this.prevWindowWords = [];
    this.decided = 0;                // words (committed + window) already handed on as utterances
    this.decidedBytes = 0;           // the window audio those words came from
    this.round = 0;
    this.busy = null;                // the round in progress
    this.wantRound = false;
    this.wantUtterance = false;
    this.closed = false;
  }

  setWindowSeconds(s) {
    this.windowSeconds = clampWindowSeconds(s);
    this.targetBytes = this.windowSeconds * BYTES_PER_SECOND;
  }

  // Until the floor has a little history, only the fixed minimum: learning
  // "silence" from the first sound would make speech that starts at once
  // count as quiet.
  threshold() {
    if (this.floor.length < FLOOR_WARMUP) return SILENCE_RMS_MIN;
    return Math.max(SILENCE_RMS_MIN, Math.min(...this.floor) * SILENCE_FACTOR);
  }

  /** Feed PCM. Rounds run in order; feeding never waits for them. */
  feed(chunk) {
    if (this.closed) return;
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    let at = 0;
    const kept = [];
    for (; at + FRAME_BYTES <= buf.length; at += FRAME_BYTES) {
      const rms = frameRms(buf, at);
      this.floor.push(rms);
      if (this.floor.length > FLOOR_FRAMES) this.floor.shift();
      const silent = rms < this.threshold();
      const frame = buf.subarray(at, at + FRAME_BYTES);
      if (!silent) {
        if (this.silentRun >= ROUND_PAUSE) this.cuts.push(this.window.length + kept.reduce((n, f) => n + f.length, 0));
        this.silentRun = 0;
        this.speechSinceRound = true;
        this.speechSinceUtterance = true;
        kept.push(frame);
        continue;
      }
      this.silentRun++;
      // Before any speech the window holds nothing; inside a pause, a little.
      if ((this.window.length || kept.length) && this.silentRun <= SILENCE_KEEP) kept.push(frame);
      if (this.silentRun === ROUND_PAUSE && this.speechSinceRound) this.wantRound = true;
      if (this.silentRun === UTTERANCE_PAUSE && this.speechSinceUtterance) this.wantUtterance = true;
    }
    this.pending = Buffer.from(buf.subarray(at));
    if (kept.length) this.window = Buffer.concat([this.window, ...kept]);
    if (this.wantRound || this.wantUtterance) this.kick();
  }

  // Run a round unless one is running (it runs again after, if still wanted).
  kick() {
    if (this.busy || this.closed) return this.busy;
    if (!this.wantRound && !this.wantUtterance) return null;
    this.busy = this.runRound().finally(() => { this.busy = null; if (this.wantRound || this.wantUtterance) this.kick(); });
    return this.busy;
  }

  /** Resolves when no round is running or wanted (tests; a stop). */
  async idle() { while (this.busy) await this.busy; }

  words() { return this.committed.concat(this.windowWords); }

  async runRound() {
    const utterance = this.wantUtterance;
    // The end of an utterance comes a moment after the short pause's round:
    // with no speech since, that round's words are current; no new pass.
    const transcribe = this.wantRound || this.speechSinceRound;
    this.wantRound = false;
    this.wantUtterance = false;
    if (utterance) this.speechSinceUtterance = false;
    this.speechSinceRound = false;
    if (!transcribe || this.window.length < MIN_ROUND_BYTES) {
      if (utterance) this.flushUtterance(0);
      return;
    }
    const before = this.words();
    const t0 = Date.now();
    let text;
    try { text = await this.transcribe(this.window); }
    catch (e) { this.emit({ type: 'error', message: 'speech-to-text: ' + e.message }); return; }
    if (this.closed) return;
    const asrMs = Date.now() - t0;
    this.round++;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    // Where the decided part now ends, in the new transcription. When the
    // recognizer rewrote the words at the boundary, text alone cannot tell:
    // transcribe exactly the decided audio once, and count its words (the
    // same audio, the same context before it) — so nothing is handed on twice.
    const committedN = this.committed.length;
    const decidedInWindow = Math.max(0, this.decided - committedN);
    let align = alignWordIndex(before.slice(committedN), decidedInWindow, words);
    if (!align.sure && this.decidedBytes >= MIN_ROUND_BYTES && this.decidedBytes < this.window.length) {
      try {
        const head = String(await this.transcribe(this.window.subarray(0, this.decidedBytes)) || '').split(/\s+/).filter(Boolean);
        if (this.closed) return;
        const byHead = alignWordIndex(head, head.length, words);
        align = { index: byHead.sure ? byHead.index : Math.min(words.length, head.length), sure: true };
        this.emit({ type: 'realign', words: head.length });
      } catch (e) { this.emit({ type: 'error', message: 'speech-to-text (realign): ' + e.message }); }
    }
    this.decided = committedN + align.index;
    this.prevWindowWords = this.windowWords;
    this.windowWords = words;
    let slideMs = 0;
    if (this.window.length > this.targetBytes * SLIDE_OVER) slideMs = await this.slide();
    const stableN = this.stableCount();
    this.emit({
      type: 'heard', round: this.round, asrMs, slideMs,
      committed: this.committed.join(' '),
      stable: this.windowWords.slice(0, stableN).join(' '),
      volatile: this.windowWords.slice(stableN).join(' '),
      windowSeconds: Math.round(this.window.length / BYTES_PER_SECOND * 10) / 10,
      decided: this.decided,
    });
    if (utterance) this.flushUtterance(asrMs);
  }

  // Words the last two rounds agree on, from the start of the window.
  stableCount() {
    const a = this.prevWindowWords, b = this.windowWords;
    let n = 0;
    while (n < a.length && n < b.length && normWord(a[n]) === normWord(b[n])) n++;
    return n;
  }

  flushUtterance(asrMs) {
    const all = this.words();
    const text = all.slice(this.decided).join(' ').trim();
    this.decided = all.length;
    this.decidedBytes = this.window.length;
    if (text) this.emit({ type: 'utterance', text, asrMs, at: Date.now() });
  }

  // Commit the audio before the pause nearest to (length − SLIDE_TO ×
  // target): one transcription of exactly that audio, so the final text
  // matches the cut.
  async slide() {
    const want = this.window.length - this.targetBytes * SLIDE_TO;
    const limit = this.window.length - MIN_TAIL_BYTES;
    let cut = 0;
    for (const c of this.cuts) if (c >= MIN_HEAD_BYTES && c <= limit && Math.abs(c - want) < Math.abs(cut - want)) cut = c;
    // No usable pause (long unbroken speech): cut anyway, at the target.
    if (!cut && this.window.length > this.targetBytes * 2) cut = Math.max(MIN_HEAD_BYTES, want - (want % FRAME_BYTES));
    if (!cut) return 0;
    const t0 = Date.now();
    let head;
    try { head = await this.transcribe(this.window.subarray(0, cut)); }
    catch (e) { this.emit({ type: 'error', message: 'speech-to-text (slide): ' + e.message }); return 0; }
    if (this.closed) return 0;
    const headWords = String(head || '').split(/\s+/).filter(Boolean);
    // The head's words move from the window to the committed text; the
    // words after them stay the window's until the next round retranscribes
    // it. The decided mark counts words of both, so it keeps its place.
    this.window = Buffer.from(this.window.subarray(cut));
    this.cuts = this.cuts.map(c => c - cut).filter(c => c > 0);
    this.decidedBytes = Math.max(0, this.decidedBytes - cut);
    this.committed.push(...headWords);
    this.windowWords = this.windowWords.slice(Math.min(this.windowWords.length, headWords.length));
    this.prevWindowWords = [];
    this.decided = Math.min(this.decided, this.committed.length + this.windowWords.length);
    // Bound the committed text; the decided mark moves with it.
    const drop = Math.max(0, this.committed.length - COMMITTED_KEEP_WORDS);
    if (drop) { this.committed.splice(0, drop); this.decided = Math.max(0, this.decided - drop); }
    this.emit({ type: 'slide', committedSeconds: Math.round(cut / BYTES_PER_SECOND * 10) / 10, text: headWords.join(' ') });
    return Date.now() - t0;
  }

  /** Stop: the last pause's words are handed on, then nothing more runs. */
  async close({ flush = true } = {}) {
    if (this.closed) return;
    if (flush && this.speechSinceUtterance) { this.wantUtterance = true; this.kick(); }
    await this.idle();
    this.closed = true;
  }
}

module.exports = { VoiceWindow, mapWordIndex, alignWordIndex, clampWindowSeconds, WINDOW_SECONDS, RATE, FRAME_BYTES, BYTES_PER_SECOND };
