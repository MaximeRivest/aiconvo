/* Voice commands: always listening, on this device, when switched on.

   The microphone streams to the server (/api/voice/listen), which keeps a
   sliding window of the last minute or so of speech (voice-window.js),
   transcribes it again with that context at every pause, and hands each
   utterance back. Each utterance goes to /api/voice/decide with what the
   screen offers now — the actions that apply, the conversations listed,
   the models, the files, the text at the cursor (voice-actions.js) — and
   Jev answers which action, with which arguments, how sure. Sure enough,
   it runs; less sure, it is suggested ("Did you mean…?") and waits for a
   yes, a no, or a click; "not a command" is ignored.

   "Start the microphone" switches to dictation: utterances are written
   into the message box (or the ask box) until "send" or "stop".

   The overlay shows what is heard (final text faint, settled text, the
   changing tail in italics) and each decision with its timing — the debug
   view; off, only a small pill says the microphone is on.

   Toggle: Alt+L anywhere, the pill, Settings → sound. Saved per device.
   Globals from app.html (the composer, navigation, settings) and the file
   workspace (fileWs, docState, the ask box). */
'use strict';

const VOICE_PREFS_KEY = 'chattering.voice.v1';
const VOICE_ACT_AT = 0.8;        // confidence to act without asking
const VOICE_RISKY_AT = 0.92;     // … for actions that are hard to take back
const VOICE_RISKY = new Set(['send', 'stop_listening', 'replace', 'rewrite', 'reject_change']);
const VOICE_PENDING_MS = 12000;  // a suggestion waits this long for a yes
const VOICE_DECISIONS_SHOWN = 8;
const VOICE_WINDOWS = [30, 60, 90, 120, 180];

const voice = {
  on: false,          // wanted on (this device)
  status: 'off',      // off | starting | listening | paused | error
  error: '',
  ws: null, audio: null, retry: 0, retryTimer: 0,
  heard: { committed: '', stable: '', volatile: '', windowSeconds: 0, asrMs: 0 },
  mode: 'command',    // command | dictation
  target: null,       // dictation: {ta, label, grow}
  pending: null,      // a suggestion: {decision, id, label, expires, timer}
  decisions: [],      // shown in the overlay, newest last
  queue: Promise.resolve(),
};

function voicePrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || 'null'); } catch {}
  const r = raw && typeof raw === 'object' ? raw : {};
  return { on: r.on === true, window: VOICE_WINDOWS.includes(r.window) ? r.window : 60, overlay: r.overlay !== false };
}
function saveVoicePrefs(patch) {
  const next = { ...voicePrefs(), ...patch };
  try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

// ---- on / off ----

async function voiceSetOn(on) {
  saveVoicePrefs({ on: !!on });
  voice.on = !!on;
  if (on) await voiceStart();
  else voiceStop();
  voicePaint();
}
function voiceToggle() { return voiceSetOn(!voice.on); }

async function voiceStart() {
  if (voice.audio) return voiceConnect();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return voiceFail('this browser gives no microphone to the page');
  voice.status = 'starting';
  voicePaint();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const context = new AudioCtx();
    // Echo cancellation keeps the app's own read-aloud out of the
    // microphone; noise suppression and gain stay off (they hurt recognition).
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    if (!voice.on) { stream.getTracks().forEach(t => t.stop()); context.close(); return; }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    const resampler = new AgentSpeechResampler(context.sampleRate);
    processor.onaudioprocess = e => {
      const pcm = resampler.process(e.inputBuffer.getChannelData(0));
      if (pcm.length && voice.ws && voice.ws.readyState === WebSocket.OPEN) voice.ws.send(pcm);
    };
    source.connect(processor); processor.connect(mute); mute.connect(context.destination);
    voice.audio = { context, stream, source, processor, mute };
    // A context made without a tap starts suspended (a reload with the
    // setting on): the next tap or key resumes it.
    if (context.state === 'suspended') {
      voice.status = 'paused';
      voice.error = 'tap anywhere to resume listening';
      const resume = () => { context.resume().then(() => { if (voice.status === 'paused') { voice.status = 'listening'; voice.error = ''; voicePaint(); } }); };
      document.addEventListener('pointerdown', resume, { once: true, capture: true });
      document.addEventListener('keydown', resume, { once: true, capture: true });
    }
    voiceConnect();
  } catch (e) {
    voiceFail(e && e.name === 'NotAllowedError' ? 'the microphone is blocked for this site' : 'microphone: ' + (e.message || e));
  }
}

function voiceConnect() {
  if (!voice.on || (voice.ws && voice.ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(voice.retryTimer);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = voice.ws = new WebSocket(scheme + '//' + location.host + '/api/voice/listen?window=' + voicePrefs().window);
  ws.onopen = () => { voice.retry = 0; if (voice.status !== 'paused') voice.status = 'listening'; voice.error = ''; voicePaint(); };
  ws.onmessage = m => { let e; try { e = JSON.parse(m.data); } catch { return; } voiceEvent(e); };
  ws.onclose = () => {
    if (voice.ws !== ws) return;
    voice.ws = null;
    if (!voice.on) return;
    // The server restarted, or the speech service is off: try again, slower each time.
    const wait = Math.min(30000, 1000 * 2 ** voice.retry++);
    voice.status = 'error';
    voice.error = 'the connection to the server dropped — retrying in ' + Math.round(wait / 1000) + ' s';
    voicePaint();
    voice.retryTimer = setTimeout(voiceConnect, wait);
  };
}

function voiceStop() {
  clearTimeout(voice.retryTimer);
  if (voice.ws) { const ws = voice.ws; voice.ws = null; try { ws.send(JSON.stringify({ type: 'stop' })); } catch {} setTimeout(() => { try { ws.close(); } catch {} }, 1500); }
  const a = voice.audio;
  voice.audio = null;
  if (a) {
    try { a.source.disconnect(); a.processor.disconnect(); a.mute.disconnect(); } catch {}
    a.stream.getTracks().forEach(t => t.stop());
    a.context.close().catch(() => {});
  }
  voiceEndDictation();
  voiceDropPending('cancelled');
  voice.status = 'off';
  voice.error = '';
}

function voiceFail(message) {
  voice.status = 'error';
  voice.error = message;
  voicePaint();
}

// ---- what the server sends ----

let voiceErrorShown = '';
function voiceEvent(e) {
  if (e.type === 'heard') {
    voice.heard = { committed: e.committed, stable: e.stable, volatile: e.volatile, windowSeconds: e.windowSeconds, asrMs: e.asrMs };
    if (voice.status === 'error') { voice.status = 'listening'; voice.error = ''; }
    voicePaintHeard();
  } else if (e.type === 'utterance') {
    // One at a time, in order: an action may change what the next one sees.
    voice.queue = voice.queue.then(() => voiceUnderstand(e.text, e.asrMs)).catch(err => console.error('voice', err));
  } else if (e.type === 'error') {
    voice.status = 'error';
    voice.error = e.message;
    voicePaint();
    if (voiceErrorShown !== e.message) { voiceErrorShown = e.message; console.warn('voice:', e.message); }
  } else if (e.type === 'ready' || e.type === 'window') {
    voice.heard.windowSeconds = voice.heard.windowSeconds || 0;
    voicePaint();
  }
}

// ---- the actions ----
// Each: available() — it applies on screen now; lists() — candidates for
// its arguments; run(args, said) — does it, returns a short summary.

const voiceEditor = () => (typeof fileWs !== 'undefined' && fileWs && fileWs.editor && fileWs.editor.view ? fileWs.editor : null);
const voiceAskOpen = () => typeof askBox !== 'undefined' && askBox && askBox.root && askBox.root.isConnected;
const voiceVisible = el => !!(el && el.offsetParent !== null);

// The conversations listed on screen, in order: the side panel's open
// conversations and agents (data-key), and lists of conversations in the
// page — the phone's list, search results (data-rel).
function voiceConversationRows() {
  const rows = [...document.querySelectorAll('.ag-row[data-key], .item[data-rel]')]
    .filter(r => voiceRowKey(r) && voiceVisible(r) && !r.classList.contains('ag-file'));
  const seen = new Set();
  return rows.filter(r => !seen.has(voiceRowKey(r)) && seen.add(voiceRowKey(r)));
}
const voiceRowKey = row => row.dataset.key || row.dataset.rel || '';
function voiceRowTitle(row) {
  const t = row.querySelector('.ag-title span') || row.querySelector('.ag-title') || row.querySelector('.sr-title, .mobile-work-title') || row;
  return t.textContent.replace(/\s+/g, ' ').trim().slice(0, 140);
}

// Where the text for dictation goes: the ask box, else the composer.
function voiceTextTarget() {
  if (voiceAskOpen()) return { ta: askBox.ta, label: 'the ask box', grow: askBubbleGrow, send: () => askBubbleSend() };
  const ta = $('agentText');
  if (ta && voiceVisible(ta)) return { ta, label: 'the message box', grow: autoGrowCompose, send: () => { const run = $('agentRun'); if (!run) throw new Error('this conversation sends from the terminal'); return headlessSendFromComposer(run); } };
  return null;
}

const VOICE_ACTIONS = {
  stop_listening: { available: () => true, run: async () => { await voiceSetOn(false); return 'stopped listening'; } },
  dictate: {
    available: () => !!voiceTextTarget(),
    run: () => { const t = voiceTextTarget(); voiceBeginDictation(t); return 'dictating into ' + t.label; },
  },
  send: {
    available: () => { const t = voiceTextTarget(); return !!(t && t.ta.value.trim()); },
    run: async () => { await voiceTextTarget().send(); return 'sent'; },
  },
  model: {
    available: () => voiceAskOpen() || !!$('modelStrip'),
    lists: async () => {
      const cat = await modelCatalog().catch(() => null);
      const ready = new Set((cat && cat.readyProviders) || []);
      const models = ((cat && cat.models) || []).filter(m => !ready.size || ready.has(m.provider));
      return { models: models.map(m => ({ id: m.provider + '/' + m.model, label: m.provider + '/' + m.model })) };
    },
    run: async ({ model }) => {
      const at = model.indexOf('/'), pick = { provider: model.slice(0, at), modelId: model.slice(at + 1) };
      if (voiceAskOpen()) { saveAskPrefs({ model }); askBubblePaintControls(); return 'ask box model: ' + shortModelName(model); }
      await setFanModels([pick]);
      return 'model: ' + shortModelName(model);
    },
  },
  reasoning: {
    available: () => voiceAskOpen() || !!$('agentThink'),
    run: async ({ level }) => {
      if (voiceAskOpen()) { saveAskPrefs({ thinking: level }); askBubblePaintControls(); return 'ask box reasoning: ' + level; }
      await cycleThinking(level);
      return 'reasoning: ' + level;
    },
  },
  open_conversation: {
    available: () => voiceConversationRows().length > 0,
    lists: () => ({ conversations: voiceConversationRows().slice(0, 60).map((r, i) => ({ id: voiceRowKey(r), label: (i + 1) + '. ' + voiceRowTitle(r) })) }),
    run: async ({ conversation }) => { await open(conversation, 'bottom'); return 'opened ' + ((sessions.find(s => s.key === conversation) || {}).title || 'the conversation'); },
  },
  open_file: {
    available: () => true,
    lists: () => {
      const files = [...document.querySelectorAll('[data-path]')].filter(voiceVisible)
        .map(el => el.dataset.path).filter(p => p && p.startsWith('/'));
      return { files: [...new Set(files)].slice(0, 150).map(p => ({ id: p, label: p.split('/').slice(-2).join('/') })) };
    },
    run: async ({ file }) => { await openLiveFile(file, { project: voiceProject() || null, back: currentHash }); return 'opened ' + file.split('/').pop(); },
  },
  settings: { available: () => true, run: async ({ pane }) => { await showSettings(pane || 'profile'); return 'settings: ' + (pane || 'profile'); } },
  go_home: { available: () => viewKind !== 'home', run: () => { goHome(); return 'home'; } },
  go_back: { available: () => true, run: () => { nav.back(); return 'back'; } },
  go_forward: { available: () => true, run: () => { nav.forward(); return 'forward'; } },
  ask_box: { available: () => !!voiceEditor(), run: async () => { await fileWsToggleAsk(true); return 'ask box open'; } },
  command_box: { available: () => !!(voiceEditor() && voiceEditor().openAiMenu), run: () => { voiceEditor().focus(); voiceEditor().openAiMenu(); return 'command box open'; } },
  ai_command: {
    available: () => !!(voiceEditor() && voiceEditor().runAiCommand),
    lists: () => ({ commands: ChatteringAiCommands.publicCommands(ChatteringAiCommands.surfaceOf(fileWs.path)).filter(c => !c.instruction).map(c => ({ id: c.id, label: c.label })) }),
    run: ({ command }) => { if (!voiceEditor().runAiCommand(command)) throw new Error('that command does not apply here'); return 'running ' + command; },
  },
  rewrite: {
    available: () => !!(voiceEditor() && voiceEditor().runAiCommand),
    run: (_, said) => { if (!voiceEditor().runAiCommand('edit', { instruction: said })) throw new Error('nothing to rewrite here'); return 'rewriting: \u201c' + said + '\u201d'; },
  },
  go_to_line: {
    available: () => !!voiceEditor(),
    run: ({ line }) => { voiceEditor().gotoLine(Number(line)); voiceEditor().focus(); return 'line ' + line; },
  },
  replace: {
    available: () => !!voiceEditor(),
    run: ({ old, new: insert }) => voiceReplace(old, insert),
  },
  accept_change: {
    available: () => !!(voiceEditor() && voiceEditor().review && voiceEditor().review.summary().changes),
    run: ({ all }) => voiceReview('accept', all),
  },
  reject_change: {
    available: () => !!(voiceEditor() && voiceEditor().review && voiceEditor().review.summary().changes),
    run: ({ all }) => voiceReview('reject', all),
  },
  text_size: {
    available: () => !!voiceEditor(),
    run: ({ direction }) => { stepFileTextSize({ larger: 1, smaller: -1, reset: 0 }[direction] ?? 0); return 'text ' + direction; },
  },
};

function voiceProject() {
  if (typeof fileWs !== 'undefined' && fileWs && fileWs.project) return fileWs.project;
  return typeof current !== 'undefined' && current && typeof projectOf === 'function' ? projectOf(current) : null;
}

// Replace the old words (nearest to the cursor) with the new ones — as a
// change to review when the editor has reviews, so a misheard word is one
// click away from undone.
function voiceReplace(old, insert) {
  const ed = voiceEditor();
  const state = ed.view.state, text = state.doc.toString(), sel = state.selection.main;
  let from, to;
  if (old && old.selection) {
    if (sel.empty) throw new Error('nothing is selected');
    ({ from, to } = sel);
  } else {
    const needle = String(old).toLowerCase(), hay = text.toLowerCase();
    let best = -1;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) if (best < 0 || Math.abs(i - sel.head) < Math.abs(best - sel.head)) best = i;
    if (best < 0) throw new Error('\u201c' + old + '\u201d is not in the text');
    from = best; to = best + needle.length;
  }
  const meta = { source: 'voice', label: 'Voice: \u201c' + (old && old.selection ? 'the selection' : old) + '\u201d \u2192 \u201c' + insert + '\u201d' };
  if (ed.review && ed.review.propose) {
    if (!ed.review.propose({ from, to, insert, meta })) throw new Error('a change is under review there: accept or reject it first');
    return 'replaced, to review (Alt+Y keeps it)';
  }
  ed.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.voice' });
  return 'replaced';
}

function voiceReview(what, all) {
  const r = voiceEditor().review;
  const n = r.summary().changes;
  if (all === 'all' || n === 1) { what === 'accept' ? r.acceptAll() : r.rejectAll(); return (what === 'accept' ? 'accepted ' : 'rejected ') + (n === 1 ? 'the change' : 'all ' + n + ' changes'); }
  const ok = what === 'accept' ? r.accept() : r.reject();
  if (!ok) throw new Error('the cursor is not on a change — say "all", or move to one');
  return what === 'accept' ? 'accepted the change' : 'rejected the change';
}

// ---- dictation ----

function voiceBeginDictation(target) {
  voice.mode = 'dictation';
  voice.target = target;
  target.ta.focus();
  voicePaint();
}
function voiceEndDictation() {
  voice.mode = 'command';
  voice.target = null;
  voicePaint();
}
function voiceWrite(text) {
  const t = voice.target;
  if (!t || !t.ta.isConnected) { voiceEndDictation(); throw new Error('the box went away; dictation stopped'); }
  t.ta.value = joinAgentSpeech(t.ta.value, text);
  t.ta.selectionStart = t.ta.selectionEnd = t.ta.value.length;
  t.ta.dispatchEvent(new Event('input', { bubbles: true }));
  if (t.grow) t.grow();
  t.ta.scrollTop = t.ta.scrollHeight;
}

// ---- understanding an utterance ----

function voiceScreen() {
  if (settingsOpen) return 'the settings';
  if (viewKind === 'file' && typeof fileWs !== 'undefined' && fileWs) return 'a file open in the editor: ' + fileWs.path.split('/').pop() + (voiceAskOpen() ? ', with the ask box open' : '');
  if (viewKind === 'conversation' && current) return 'a conversation: ' + (current.title || 'untitled') + ', with its message box';
  return viewKind === 'home' ? 'the home page (the timeline of conversations)' : viewKind || 'the app';
}

async function voiceContext(said) {
  const context = { said, heard: voice.heard.committed.split(' ').slice(-120).join(' '), screen: voiceScreen(), mode: voice.mode, debug: voicePrefs().overlay, lists: {} };
  if (voice.mode === 'dictation') return context;
  context.actions = Object.entries(VOICE_ACTIONS).filter(([, a]) => { try { return a.available(); } catch { return false; } }).map(([id]) => id);
  for (const id of context.actions) if (VOICE_ACTIONS[id].lists) Object.assign(context.lists, await VOICE_ACTIONS[id].lists());
  const ed = voiceEditor();
  if (ed) {
    const st = ed.view.state, sel = st.selection.main;
    context.doc = { selection: st.doc.sliceString(sel.from, sel.to).slice(0, 2000), nearby: st.doc.sliceString(Math.max(0, sel.head - 4000), sel.head + 4000) };
  }
  if (voice.pending) context.pending = voice.pending.label;
  const project = voiceProject();
  if (project && context.actions.includes('open_file')) context.project = project;
  return context;
}

async function voiceUnderstand(said, asrMs) {
  const entry = { said, asrMs, at: Date.now(), status: 'deciding' };
  voiceRecord(entry);
  let out;
  try {
    const context = await voiceContext(said);
    const r = await fetch('/api/voice/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
    out = await r.json();
    if (!r.ok || out.error) throw new Error(out.error || 'the server did not decide');
  } catch (e) {
    Object.assign(entry, { status: 'failed', note: e.message });
    return voicePaintDecisions();
  }
  const d = out.decision;
  Object.assign(entry, { id: out.id, decision: d, jevMs: out.ms });
  if (d.dictating) return voiceDictation(entry, d);
  if (d.action === 'none') { Object.assign(entry, { status: 'ignored' }); return voicePaintDecisions(); }
  if (d.action === 'confirm' || d.action === 'cancel') return voiceAnswerPending(entry, d.action === 'confirm');
  const needs = VOICE_RISKY.has(d.action) ? VOICE_RISKY_AT : VOICE_ACT_AT;
  if (d.missing || d.confidence < needs) return voiceSuggest(entry, d);
  await voiceRun(entry, d);
}

async function voiceRun(entry, d) {
  const action = VOICE_ACTIONS[d.action];
  try {
    if (!action || !action.available()) throw new Error('that does not apply here now');
    entry.summary = await action.run(d.args || {}, entry.said);
    entry.status = 'done';
    if (!voicePrefs().overlay) toast('\u{1F399} ' + entry.summary);
  } catch (e) {
    entry.status = 'failed';
    entry.note = e.message;
    if (!voicePrefs().overlay) toast('\u{1F399} ' + e.message, null, 'err');
  }
  voiceOutcome(entry.id, entry.status === 'done' ? (entry.confirmed ? 'confirmed' : 'done') : 'failed', entry.note);
  voicePaintDecisions();
}

function voiceDictation(entry, d) {
  try {
    if (d.action === 'text' || d.action === 'text_send') { if (d.text) voiceWrite(d.text); entry.summary = 'wrote it'; }
    if (d.action === 'text_send' || d.action === 'send') { voice.target.send(); entry.summary = 'sent'; voiceEndDictation(); }
    else if (d.action === 'stop') { voiceEndDictation(); entry.summary = 'stopped dictating'; }
    else if (d.action === 'clear') { voice.target.ta.value = ''; voice.target.ta.dispatchEvent(new Event('input', { bubbles: true })); entry.summary = 'cleared the box'; }
    entry.status = 'done';
  } catch (e) { entry.status = 'failed'; entry.note = e.message; }
  voiceOutcome(entry.id, entry.status === 'done' ? 'done' : 'failed', entry.note);
  voicePaintDecisions();
}

// A suggestion: shown with Do it / No; a spoken yes or no answers it.
function voiceSuggest(entry, d) {
  voiceDropPending('expired');
  const label = voiceDescribe(d);
  entry.status = 'asked';
  entry.summary = d.missing ? label + ' — which ' + d.missing + '?' : 'did you mean: ' + label + '?';
  if (!d.missing) {
    voice.pending = { entry, decision: d, label, timer: setTimeout(() => voiceDropPending('expired'), VOICE_PENDING_MS) };
    voiceShowOverlay(true);
  }
  voiceOutcome(entry.id, 'asked');
  voicePaintDecisions();
}
function voiceAnswerPending(entry, yes) {
  const p = voice.pending;
  if (!p) { entry.status = 'ignored'; entry.summary = 'nothing to answer'; return voicePaintDecisions(); }
  clearTimeout(p.timer);
  voice.pending = null;
  entry.status = 'done';
  entry.summary = yes ? 'yes' : 'no';
  voiceOutcome(entry.id, 'done');
  if (yes) { p.entry.confirmed = true; return voiceRun(p.entry, p.decision); }
  p.entry.status = 'cancelled';
  voiceOutcome(p.entry.id, 'cancelled');
  voicePaintDecisions();
}
function voiceDropPending(why) {
  const p = voice.pending;
  if (!p) return;
  clearTimeout(p.timer);
  voice.pending = null;
  p.entry.status = why === 'expired' ? 'expired' : 'cancelled';
  voiceOutcome(p.entry.id, why === 'expired' ? 'expired' : 'cancelled');
  voicePaintDecisions();
}

function voiceDescribe(d) {
  const a = ChatteringVoiceActions.ACTIONS[d.action];
  const args = Object.entries(d.args || {}).map(([k, v]) => (v && typeof v === 'object' ? 'the selection' : String(v).split('/').pop())).filter(Boolean);
  return (a ? a.label : d.action) + (args.length ? ': ' + args.join(' → ') : '');
}

function voiceOutcome(id, outcome, detail) {
  if (!id) return;
  fetch('/api/voice/outcome', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, outcome, detail }) }).catch(() => {});
}

function voiceRecord(entry) {
  voice.decisions.push(entry);
  if (voice.decisions.length > 40) voice.decisions.shift();
  voicePaintDecisions();
}

// ---- on screen: the pill and the overlay ----
// In their own dock at the bottom right, lifted above whatever is docked at
// the bottom of the screen (the message box, a notebook's run strip, the
// phone's bar) so they never cover its controls.

function voiceDock() {
  let dock = $('voiceDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'voiceDock';
    document.body.appendChild(dock);
    window.addEventListener('resize', voicePlaceDock);
  }
  return dock;
}
const VOICE_BOTTOM_BARS = '#composerDock, .doc-run-strip, .doc-run-setup, .doc-run-fix, #phoneBar';
function voicePlaceDock() {
  const dock = $('voiceDock');
  if (!dock) return;
  let top = window.innerHeight;
  for (const el of document.querySelectorAll(VOICE_BOTTOM_BARS)) {
    if (!voiceVisible(el) && getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    // Only what sits along the bottom edge and spans under the dock.
    if (r.height && r.bottom >= window.innerHeight - 4 - (window.innerHeight - top) && r.right > window.innerWidth - 440) top = Math.min(top, r.top);
  }
  dock.style.bottom = Math.max(10, window.innerHeight - top + 8) + 'px';
}

function voicePill() {
  let pill = $('voiceListenPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'voiceListenPill';
    pill.innerHTML = `<button type="button" class="vl-main" title="What is heard and decided (click) · Alt+L stops listening"><span class="vl-dot" aria-hidden="true"></span><span class="vl-state"></span></button><button type="button" class="vl-off" title="Stop listening (Alt+L)" aria-label="Stop listening">✕</button>`;
    pill.querySelector('.vl-main').onclick = () => voiceShowOverlay(!voiceOverlayShown());
    pill.querySelector('.vl-off').onclick = () => voiceSetOn(false);
    voiceDock().appendChild(pill);
  }
  return pill;
}

function voicePaint() {
  const shown = voice.on || voice.status === 'error';
  const pill = $('voiceListenPill');
  if (!shown) { if (pill) pill.remove(); voiceShowOverlay(false); voicePaintSettings(); clearInterval(voice.placeTimer); voice.placeTimer = 0; return; }
  // The bars below move with the view (a conversation opens, a run strip appears).
  if (!voice.placeTimer) voice.placeTimer = setInterval(voicePlaceDock, 700);
  voicePlaceDock();
  const p = voicePill();
  p.dataset.state = voice.status;
  p.dataset.mode = voice.mode;
  const words = voice.mode === 'dictation' ? 'dictating into ' + voice.target.label
    : voice.status === 'listening' ? 'listening' : voice.status === 'starting' ? 'starting…' : voice.status === 'paused' ? 'paused' : 'not listening';
  p.querySelector('.vl-state').textContent = words;
  p.querySelector('.vl-main').setAttribute('aria-label', words + (voice.error ? ': ' + voice.error : ''));
  p.title = voice.error || '';
  if (voicePrefs().overlay && voice.on && !$('voiceOverlay')) voiceShowOverlay(true);
  voicePaintOverlayHead();
  voicePaintSettings();
}

const voiceOverlayShown = () => !!$('voiceOverlay');
function voiceShowOverlay(show) {
  const el = $('voiceOverlay');
  if (!show) { if (el) el.remove(); return; }
  if (el) return;
  const o = document.createElement('section');
  o.id = 'voiceOverlay';
  o.setAttribute('aria-label', 'Voice: what is heard and decided');
  o.innerHTML = `<header><b>✦ Voice</b><span class="vo-meta"></span><button type="button" class="vo-close" title="Hide (the pill shows it again)" aria-label="Hide">✕</button></header>
    <div class="vo-error" hidden></div>
    <div class="vo-heard" aria-live="off"></div>
    <ol class="vo-decisions" aria-live="polite"></ol>`;
  o.querySelector('.vo-close').onclick = () => voiceShowOverlay(false);
  o.addEventListener('click', e => {
    const b = e.target.closest('[data-vo]');
    if (!b || !voice.pending) return;
    const entry = { said: b.dataset.vo === 'yes' ? '(clicked yes)' : '(clicked no)', at: Date.now(), status: 'done' };
    voiceAnswerPending(entry, b.dataset.vo === 'yes');
  });
  voiceDock().prepend(o);
  voicePlaceDock();
  voicePaintOverlayHead();
  voicePaintHeard();
  voicePaintDecisions();
}

function voicePaintOverlayHead() {
  const o = $('voiceOverlay');
  if (!o) return;
  const last = [...voice.decisions].reverse().find(d => d.jevMs);
  o.querySelector('.vo-meta').textContent = [
    voice.mode === 'dictation' ? '✎ dictating into ' + voice.target.label : 'commands',
    'window ' + Math.round(voice.heard.windowSeconds || 0) + ' / ' + voicePrefs().window + ' s',
    voice.heard.asrMs ? 'speech ' + voice.heard.asrMs + ' ms' : '',
    last ? 'Jev ' + last.jevMs + ' ms' : '',
  ].filter(Boolean).join(' · ');
  const err = o.querySelector('.vo-error');
  err.hidden = !voice.error;
  err.textContent = voice.error;
}

function voicePaintHeard() {
  const o = $('voiceOverlay');
  if (!o) return;
  const h = voice.heard;
  const box = o.querySelector('.vo-heard');
  // The last few hundred characters: final (faint), settled, changing (italic).
  const committed = h.committed.length > 400 ? '…' + h.committed.slice(-400) : h.committed;
  box.innerHTML = `<span class="vo-committed">${esc(committed)}</span> <span class="vo-stable">${esc(h.stable)}</span> <em class="vo-volatile">${esc(h.volatile)}</em>`;
  box.scrollTop = box.scrollHeight;
  voicePaintOverlayHead();
}

const VOICE_STATUS = { deciding: '…', done: '✓', asked: '?', ignored: '·', failed: '✗', cancelled: '✗', expired: '–' };
function voicePaintDecisions() {
  const o = $('voiceOverlay');
  if (!o) return;
  const rows = voice.decisions.slice(-VOICE_DECISIONS_SHOWN);
  o.querySelector('.vo-decisions').innerHTML = rows.map(d => {
    const dec = d.decision;
    const what = d.status === 'deciding' ? 'deciding…'
      : d.status === 'ignored' ? 'not a command' + (dec ? ' · ' + Math.round(dec.confidence * 100) + '%' : '')
      : (d.summary || (dec ? voiceDescribe(dec) : '')) + (d.note ? ' — ' + d.note : '') + (dec && d.status !== 'failed' ? ' · ' + Math.round(dec.confidence * 100) + '%' : '');
    const ask = voice.pending && voice.pending.entry === d ? '<span class="vo-ask"><button type="button" data-vo="yes">Do it</button><button type="button" data-vo="no">No</button></span>' : '';
    return `<li data-status="${d.status}"><span class="vo-mark" aria-hidden="true">${VOICE_STATUS[d.status] || ''}</span><span class="vo-said">\u201c${esc(d.said)}\u201d</span><span class="vo-what">${esc(what)}</span>${ask}</li>`;
  }).join('');
  voicePaintOverlayHead();
}

// ---- settings (Settings → sound) ----

function voiceSettingsHtml() {
  const p = voicePrefs();
  return `<div class="set-group" id="voiceSettings">
    <h3>voice commands</h3>
    <label class="set-check"><input type="checkbox" data-voice="on"${voice.on ? ' checked' : ''}> Always listening on this device <kbd>Alt+L</kbd></label>
    <div class="set-help">Say what you want: “change the model to sonnet”, “reasoning off”, “open the third conversation”, “open the file called…”, “open the settings”, “start the microphone” (then talk, then “send”), in a file “go to line 40”, “change X to Y”, “fix the grammar”, “accept”. The speech goes to this machine’s speech-to-text; each sentence goes to TypeSafe’s Jev to pick the action. Silence is not sent to either.</div>
    <label class="set-field"><span>context window</span> <select data-voice="window">${VOICE_WINDOWS.map(s => `<option value="${s}"${s === p.window ? ' selected' : ''}>${s < 60 ? s + ' s' : s / 60 + ' min'}</option>`).join('')}</select></label>
    <div class="set-help">How much of what you said recently the speech-to-text rereads, for better words. Longer is more accurate and slower: about 4 ms per second of window on this GPU (1 min ≈ 0.23 s, 2 min ≈ 0.48 s after each pause).</div>
    <label class="set-check"><input type="checkbox" data-voice="overlay"${p.overlay ? ' checked' : ''}> Show what is heard and decided (debug view)</label>
    <div class="set-help">Also keeps the words of sentences that were not commands in the record, to tune it (~/.local/share/chattering/voice-commands.jsonl). Off: only commands are kept, and a small note says what was done.</div>
    <div class="set-field" id="voiceKeyField"><span class="hint">checking the TypeSafe key…</span></div>
  </div>`;
}

async function voiceBindSettings(root) {
  const box = root.querySelector('#voiceSettings');
  if (!box) return;
  box.addEventListener('change', e => {
    const f = e.target.dataset.voice;
    if (f === 'on') voiceSetOn(e.target.checked);
    else if (f === 'window') {
      saveVoicePrefs({ window: Number(e.target.value) });
      if (voice.ws && voice.ws.readyState === WebSocket.OPEN) voice.ws.send(JSON.stringify({ type: 'window', seconds: Number(e.target.value) }));
      voicePaintOverlayHead();
    } else if (f === 'overlay') { saveVoicePrefs({ overlay: e.target.checked }); voiceShowOverlay(e.target.checked && voice.on); }
  });
  let st = {};
  try { st = await (await fetch('/api/voice/status')).json(); } catch {}
  const field = box.querySelector('#voiceKeyField');
  if (!field) return;
  if (st.refused) { field.innerHTML = `<span class="hint">${esc(st.refused)}</span>`; box.querySelectorAll('input, select').forEach(i => { i.disabled = true; }); return; }
  const speech = st.speech ? '' : '<div class="hint">No speech-to-text server is set (Settings → advanced settings file: speechUrl).</div>';
  if (st.keyFromEnv) { field.innerHTML = `<span class="hint">TypeSafe key: from the server’s environment · model ${esc(st.model)}</span>${speech}`; return; }
  field.innerHTML = `<label for="voiceKey">TypeSafe API key ${st.key ? '<span class="hint">(set — enter a new one to replace it, empty to remove)</span>' : '<span class="hint">(needed: get one at typesafe.ai)</span>'}</label>
    <div class="set-row"><input id="voiceKey" type="password" autocomplete="off" spellcheck="false"${st.canSetKey ? '' : ' disabled'} placeholder="${st.key ? '••••••••' : 'apikey_…'}"><button type="button" id="voiceKeySave"${st.canSetKey ? '' : ' disabled'}>save</button></div>
    <div class="set-help">Kept on this machine only (~/.config/chattering/typesafe-api-key, readable by you alone); never sent back to a page.${st.canSetKey ? '' : ' Only the owner or an admin sets it.'}</div>${speech}`;
  const save = field.querySelector('#voiceKeySave');
  if (save) save.onclick = async () => {
    const out = await postJson('/api/voice/key', { key: field.querySelector('#voiceKey').value });
    if (out.error) return errToast(out.error);
    toast(out.key ? 'TypeSafe key saved' : 'TypeSafe key removed');
    voiceBindSettings(root);
  };
}

function voicePaintSettings() {
  const box = $('voiceSettings');
  if (box) { const c = box.querySelector('[data-voice="on"]'); if (c) c.checked = voice.on; }
}

// ---- keys, and starting with the page ----

// Alt+L anywhere, typing included (capture phase, like Ctrl+?). By key
// position: layouts and Alt characters do not matter.
document.addEventListener('keydown', e => {
  if (e.code === 'KeyL' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat) {
    e.preventDefault();
    e.stopPropagation();
    voiceToggle();
  }
}, true);

if (voicePrefs().on) setTimeout(() => voiceSetOn(true), 0);
