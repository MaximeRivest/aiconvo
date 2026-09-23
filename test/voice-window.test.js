'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceWindow, mapWordIndex, clampWindowSeconds, FRAME_BYTES, BYTES_PER_SECOND } = require('../voice-window.js');

// A fake microphone: each "word" is 400 ms of tone whose loudness names it
// (word k at amplitude 1000·k); a gap is quiet noise. The fake recognizer
// reads the audio back: one word per run of loud frames. So a window that
// lost or duplicated audio shows as lost or duplicated words.
const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)) + (i % 7) - 3, i * 2); return b; };
const word = k => Buffer.concat(Array.from({ length: 4 }, () => frame(1000 * k)));
const pause = ms => Buffer.concat(Array.from({ length: Math.round(ms / 100) }, () => frame(0)));
function recognize(pcm) {
  const words = [];
  let run = null;
  for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) {
    let peak = 0;
    for (let i = 0; i < FRAME_BYTES / 2; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(at + i * 2)));
    const k = Math.round(peak / 1000);
    if (k >= 1) { if (run !== k) words.push('w' + k); run = k; } else run = null;
  }
  return words.join(' ');
}
function listener(opts = {}) {
  const events = [], calls = [];
  const w = new VoiceWindow({ windowSeconds: opts.windowSeconds, emit: e => events.push(e), transcribe: async pcm => { calls.push(pcm.length); return recognize(pcm); } });
  return { w, events, calls, utterances: () => events.filter(e => e.type === 'utterance').map(e => e.text) };
}
const say = async (l, ...parts) => { for (const p of parts) { l.w.feed(p); await l.w.idle(); } };

test('silence alone costs nothing: no rounds, an empty window', async () => {
  const l = listener();
  await say(l, pause(5000));
  assert.equal(l.calls.length, 0);
  assert.equal(l.w.window.length, 0);
});

test('a pause shows the words; a longer one hands on the utterance, once', async () => {
  const l = listener();
  await say(l, pause(1000), word(1), pause(100), word(2), pause(400));
  const heard = l.events.filter(e => e.type === 'heard');
  assert.equal(heard.at(-1).stable + ' ' + heard.at(-1).volatile, ' w1 w2'.replace(/^ /, ' '));
  assert.deepEqual(l.utterances(), []);
  await say(l, pause(600));
  assert.deepEqual(l.utterances(), ['w1 w2']);
  assert.equal(l.calls.length, 1, 'the end of the utterance reuses the pause\u2019s round');
  await say(l, word(3), pause(1200));
  assert.deepEqual(l.utterances(), ['w1 w2', 'w3'], 'the next utterance is only the new words');
  assert.ok(l.calls.at(-1) > word(3).length, 'with the earlier words as context');
});

test('a short word alone is heard (send)', async () => {
  const l = listener();
  await say(l, frame(3000), frame(3000), frame(3000), pause(1000));
  assert.deepEqual(l.utterances(), ['w3']);
});

test('pauses are shortened in the window: its length is speech', async () => {
  const l = listener();
  await say(l, word(1), pause(10000), word(2), pause(900));
  assert.ok(l.w.window.length <= word(1).length * 2 + 8 * FRAME_BYTES, l.w.window.length);
});

test('past its target the window slides: final text, nothing lost or said twice', async () => {
  const l = listener({ windowSeconds: 15 });
  const spoken = [];
  for (let i = 0; i < 40; i++) {
    const k = 1 + (i % 9);
    spoken.push('w' + k);
    await say(l, word(k), pause(i % 3 === 2 ? 900 : 350));
  }
  await say(l, pause(1000));
  assert.ok(l.events.some(e => e.type === 'slide'), 'it slid');
  assert.ok(l.w.window.length <= 15 * 1.2 * BYTES_PER_SECOND + 8 * FRAME_BYTES, 'the window stays near its target');
  assert.ok(l.events.filter(e => e.type === 'slide').every(e => e.committedSeconds >= 5), 'slides in steps, not word by word');
  assert.deepEqual(l.utterances().join(' ').split(' '), spoken, 'every word handed on exactly once, in order');
  const last = l.events.filter(e => e.type === 'heard').at(-1);
  assert.deepEqual((last.committed + ' ' + last.stable + ' ' + last.volatile).trim().split(/\s+/), spoken, 'final + live text is everything said');
});

test('an index follows a word through a revised transcription', () => {
  const prev = 'please open the sittings now'.split(' ');
  const next = 'please open the settings now and send'.split(' ');
  assert.equal(mapWordIndex(prev, 5, next), 5, 'a revised word keeps its place');
  assert.equal(mapWordIndex('a b c'.split(' '), 3, 'x a b c d'.split(' ')), 4);
  assert.equal(mapWordIndex([], 0, ['a']), 0);
  assert.deepEqual([clampWindowSeconds(5), clampWindowSeconds('90'), clampWindowSeconds(999), clampWindowSeconds('x')], [15, 90, 180, 60]);
});
