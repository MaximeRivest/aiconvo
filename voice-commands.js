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
   view; off, only a small pill says the microphone is on. Its "?" (or
   "what can I say") lists what can be said on this screen.

   What can be picked — conversations, files, projects, files-browser rows,
   search results — is numbered on screen while listening; "open seven",
   "the third one", "the last file", "the previous one" or a name pick it,
   and picking clicks it, as the mouse would.

   Toggle: Alt+L anywhere, the pill, Settings → sound. Saved per device.
   Globals from app.html (the composer, navigation, settings) and the file
   workspace (fileWs, docState, the ask box). */
'use strict';

const VOICE_PREFS_KEY = 'chattering.voice.v1';
// How sure Jev must be to act without asking, by what a mistake costs.
const VOICE_ACT_AT = 0.8;        // most actions
const VOICE_EASY_AT = 0.6;       // going somewhere: "go back" undoes it
const VOICE_RISKY_AT = 0.92;     // hard to take back
const VOICE_EASY = new Set(['open', 'help', 'settings', 'go_home', 'go_back', 'go_forward', 'text_size', 'go_to_line', 'ask_box', 'command_box']);
const VOICE_RISKY = new Set(['send', 'stop_listening', 'replace', 'rewrite', 'reject_change']);
const VOICE_PENDING_MS = 12000;  // a suggestion waits this long for a yes
const VOICE_DECISIONS_SHOWN = 8;
const VOICE_WINDOWS = [30, 60, 90, 120, 180];
const VOICE_OFFSCREEN_CONVERSATIONS = 300; // recent conversations nameable when not on screen
const VOICE_HINTS_MAX = 80;

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
  numbers: new Map(), // pick key → the number shown beside it
  helpOpen: false,
};

function voicePrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || 'null'); } catch {}
  const r = raw && typeof raw === 'object' ? raw : {};
  return { on: r.on === true, window: VOICE_WINDOWS.includes(r.window) ? r.window : 60, overlay: r.overlay !== false, numbers: r.numbers !== false };
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

// ---- what can be picked on screen ----
// Each kind: the rows that are it, the key that names one across
// re-renders, its title, and what to click. Picking clicks it: the list's
// own handler does what the mouse does.
const voiceText = el => (el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : '');
const VOICE_PICKABLE = [
  { sel: '.ag-row[data-key]:not(.ag-file)', kind: 'conversation', key: el => el.dataset.key && 'conv:' + el.dataset.key,
    title: el => voiceText(el.querySelector('.ag-title span') || el.querySelector('.ag-title')) },
  { sel: '.ag-row[data-open-project]', kind: 'project', key: el => 'proj:' + el.dataset.openProject,
    title: el => voiceText(el.querySelector('.ag-title span') || el) },
  { sel: '.ag-row.ag-file[data-path]', kind: 'file', key: el => 'file:' + el.dataset.path,
    title: el => el.dataset.path.split('/').slice(-2).join('/'), target: el => el.querySelector('.ag-file-open') || el },
  { sel: '#view .item[data-rel]', kind: 'conversation', key: el => 'conv:' + el.dataset.rel,
    title: el => voiceText(el.querySelector('.sr-title, .mobile-work-title, .title, .t') || el) },
  { sel: '#fbList button[data-fb-entry]:not([disabled])', kind: el => (/^▸/.test(voiceText(el)) ? 'folder' : 'file'),
    key: el => 'fb:' + voiceText(el).replace(/^[▸·]\s*/, ''), title: el => voiceText(el).replace(/^[▸·]\s*/, '') },
];
const VOICE_REGIONS = [['#side', 'left panel'], ['#rightFiles', 'right panel'], ['#agentsPop', 'agents panel'], ['#view', 'main view']];
const VOICE_PLURAL = { conversation: 'conversations', file: 'files', folder: 'files and folders', project: 'projects' };

/**
 * What can be picked now: {items: [{key, kind, title, region, group, el,
 * target}], groups: [{id, label, keys, current}], defaultGroup}. Items in
 * document order; a group is one kind in one region (files and folders of
 * the files browser share one), in its on-screen order.
 */
function voicePicks() {
  const items = [], seen = new Set();
  for (const p of VOICE_PICKABLE) {
    for (const el of document.querySelectorAll(p.sel)) {
      if (!voiceVisible(el)) continue;
      const key = p.key(el);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const kind = typeof p.kind === 'function' ? p.kind(el) : p.kind;
      const region = (VOICE_REGIONS.find(([sel]) => el.closest(sel)) || [null, 'screen'])[1];
      const group = region + '/' + (kind === 'folder' ? 'file' : kind);
      items.push({ key, kind, title: p.title(el) || key, region, group, el, target: p.target ? p.target(el) : el,
        current: el.classList.contains('current') || el.getAttribute('aria-current') === 'page' });
    }
  }
  items.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const groups = [];
  for (const it of items) {
    let g = groups.find(x => x.id === it.group);
    if (!g) groups.push(g = { id: it.group, label: VOICE_PLURAL[it.kind === 'folder' ? 'file' : it.kind] + ' in the ' + it.region, keys: [], current: null });
    if (it.current) g.current = g.keys.length;
    g.keys.push(it.key);
  }
  // Counted in by default: the list with the open item, else the first.
  const def = groups.find(g => g.current !== null) || groups[0];
  return { items, groups, defaultGroup: def ? def.id : null };
}

// Numbers stay with their item while it is on screen; a new item gets the
// smallest free number. Only items in view are numbered.
function voiceNumber(picks) {
  const inView = picks.items.filter(it => { const r = it.el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight && r.height > 0; }).slice(0, VOICE_HINTS_MAX);
  const keep = new Set(inView.map(it => it.key));
  for (const k of [...voice.numbers.keys()]) if (!keep.has(k)) voice.numbers.delete(k);
  const used = new Set(voice.numbers.values());
  let next = 1;
  for (const it of inView) {
    if (voice.numbers.has(it.key)) continue;
    while (used.has(next)) next++;
    voice.numbers.set(it.key, next);
    used.add(next);
  }
  return inView;
}

// The pick an `open` decision means: {item} on screen, or {key} to open by name.
function voiceResolvePick({ number, place, list, name }) {
  const picks = voicePicks();
  const onScreen = key => picks.items.find(it => it.key === key);
  if (number) {
    const key = [...voice.numbers].find(([, n]) => n === number)?.[0];
    if (!key || !onScreen(key)) throw new Error('nothing on screen is numbered ' + number);
    return { item: onScreen(key) };
  }
  if (place) {
    const g = picks.groups.find(x => x.id === list) || picks.groups.find(x => x.id === picks.defaultGroup);
    if (!g) throw new Error('there is no list on screen');
    const ord = ChatteringVoiceActions.ORDINALS.indexOf(place);
    let i = ord >= 0 ? ord : place === 'last' ? g.keys.length - 1 : place === 'second_last' ? g.keys.length - 2 : -1;
    if (place === 'above' || place === 'below') {
      if (g.current === null) throw new Error('nothing is open in the ' + g.label + ', so there is no previous or next one');
      i = g.current + (place === 'above' ? -1 : 1);
    }
    if (i < 0 || i >= g.keys.length) throw new Error('the ' + g.label + ' ' + (g.keys.length === 1 ? 'has one item' : 'have ' + g.keys.length));
    return { item: onScreen(g.keys[i]) };
  }
  if (name) return onScreen(name) ? { item: onScreen(name) } : { key: name };
  throw new Error('which one?');
}

// Open by key when the item is not on screen: a conversation, a file.
async function voiceOpenKey(key) {
  const [kind, ...rest] = key.split(':'), id = rest.join(':');
  if (kind === 'conv') { await open(id, 'bottom'); return 'opened ' + ((sessions.find(x => x.key === id) || {}).title || 'the conversation'); }
  if (kind === 'file') { await openLiveFile(id, { project: voiceProject() || null, back: currentHash }); return 'opened ' + id.split('/').pop(); }
  if (kind === 'proj') { await showProjectOverview(id); return 'opened the project ' + id; }
  throw new Error('that is no longer on screen');
}

// What `open` offers Jev: the lists on screen, and every name — on screen
// first (kept), then the recent conversations that are not.
function voiceOpenLists() {
  const picks = voicePicks();
  // A name is the kind and the title: the place and the number have their
  // own questions, and extra words here only blur the match.
  const targets = picks.items.map(it => ({ id: it.key, keep: true, label: it.kind + ' · ' + it.title }));
  const shown = new Set(picks.items.map(it => it.key));
  const recent = (typeof sessions !== 'undefined' ? sessions : []).filter(x => x && x.key && !shown.has('conv:' + x.key))
    .slice().sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || ''))).slice(0, VOICE_OFFSCREEN_CONVERSATIONS);
  for (const x of recent) targets.push({ id: 'conv:' + x.key, label: 'conversation · ' + (x.timelineTitle || x.title || x.key) });
  return { targets, groups: picks.groups.map(g => ({ id: g.id, label: g.label })), defaultGroup: picks.defaultGroup };
}

// Where the text for dictation goes: the ask box, else the composer.
function voiceTextTarget() {
  if (voiceAskOpen()) return { ta: askBox.ta, label: 'the ask box', grow: askBubbleGrow, send: () => askBubbleSend() };
  const ta = $('agentText');
  if (ta && voiceVisible(ta)) return { ta, label: 'the message box', grow: autoGrowCompose, send: () => { const run = $('agentRun'); if (!run) throw new Error('this conversation sends from the terminal'); return headlessSendFromComposer(run); } };
  return null;
}

// What scrolls here: the file's text, else the page's view.
function voiceScroller() {
  const ed = voiceEditor();
  if (ed) {
    const host = ed.view.dom.closest('.doc-editor-host');
    const inner = ed.view.scrollDOM;
    return inner.scrollHeight > inner.clientHeight + 1 ? inner : host || inner;
  }
  return $('view');
}
const voiceLast = sel => [...document.querySelectorAll(sel)].filter(voiceVisible).pop() || null;

const VOICE_ACTIONS = {
  stop_listening: { available: () => true, run: async () => { await voiceSetOn(false); return 'stopped listening'; } },
  stop_dictation: { available: () => voice.mode === 'command', run: () => 'you were not dictating — still listening for commands' },
  status: {
    available: () => true,
    run: () => (voice.mode === 'dictation' ? 'yes: dictating into ' + voice.target.label : 'yes: listening for commands') + ' · window ' + Math.round(voice.heard.windowSeconds || 0) + ' s',
  },
  focus_box: { available: () => !!voiceTextTarget(), run: () => { const t = voiceTextTarget(); t.ta.focus(); return 'cursor in ' + t.label; } },
  new_conversation: { available: () => typeof startNewConversation === 'function', run: async () => { await startNewConversation(); return 'new conversation'; } },
  regenerate: {
    available: () => !!voiceLast('#view .msg-regenerate'),
    run: () => { const b = voiceLast('#view .msg-regenerate'); b.scrollIntoView({ block: 'nearest' }); b.click(); return 'asking again'; },
  },
  expand: {
    available: () => !!voiceLast('#view .msg .more, #view .msg .unfold'),
    run: () => { voiceLast('#view .msg .more, #view .msg .unfold').click(); return 'expanded'; },
  },
  scroll: {
    available: () => !!voiceScroller(),
    run: ({ direction }) => {
      const el = voiceScroller(), page = Math.max(120, el.clientHeight * 0.9);
      const by = { up: -page / 3, down: page / 3, page_up: -page, page_down: page }[direction];
      if (by !== undefined) el.scrollBy({ top: by });
      else el.scrollTop = direction === 'top' ? 0 : el.scrollHeight;
      return 'scrolled ' + String(direction || 'down').replace('_', ' ');
    },
  },
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
  open: {
    available: () => true,
    lists: () => voiceOpenLists(),
    run: async args => {
      const pick = voiceResolvePick(args);
      if (!pick.item) return voiceOpenKey(pick.key);
      const it = pick.item;
      it.target.scrollIntoView({ block: 'nearest' });
      it.target.click();
      return 'opened ' + it.title;
    },
  },
  help: { available: () => true, run: () => { voiceShowHelp(true); return 'here is what you can say'; } },
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
  const context = { said, heard: voice.heard.committed.split(' ').slice(-120).join(' '), screen: voiceScreen(), mode: voice.mode, lists: {} };
  if (voice.mode === 'dictation') return context;
  context.actions = Object.entries(VOICE_ACTIONS).filter(([, a]) => { try { return a.available(); } catch { return false; } }).map(([id]) => id);
  for (const id of context.actions) if (VOICE_ACTIONS[id].lists) Object.assign(context.lists, await VOICE_ACTIONS[id].lists());
  if (context.actions.includes('open') && voicePrefs().numbers) voicePaintHints(); // the numbers Jev sees are the ones shown
  const ed = voiceEditor();
  if (ed) {
    const st = ed.view.state, sel = st.selection.main;
    context.doc = { selection: st.doc.sliceString(sel.from, sel.to).slice(0, 2000), nearby: st.doc.sliceString(Math.max(0, sel.head - 4000), sel.head + 4000) };
  }
  if (voice.pending) context.pending = voice.pending.label;
  const project = voiceProject();
  if (project && context.actions.includes('open')) context.project = project;
  return context;
}

async function voiceUnderstand(said, asrMs) {
  const entry = { said, asrMs, at: Date.now(), status: 'deciding' };
  voiceRecord(entry);
  let out;
  try {
    const context = await voiceContext(said);
    if (Number.isFinite(asrMs)) context.asrMs = asrMs;
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
  const needs = VOICE_RISKY.has(d.action) ? VOICE_RISKY_AT : VOICE_EASY.has(d.action) ? VOICE_EASY_AT : VOICE_ACT_AT;
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
  if (d.action === 'open') {
    const { number, place, list, name } = d.args || {};
    const where = list ? (voicePicks().groups.find(g => g.id === list) || {}).label : '';
    const what = number ? 'number ' + number
      : place ? (ChatteringVoiceActions.PLACES[place] || place).replace(/ \(.*\)$/, '') + (where ? ' in the ' + where : '')
      : name ? name.replace(/^[a-z]+:/, '').split('/').pop() : '';
    return 'open' + (what ? ': ' + what : '');
  }
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
  if (!shown) { if (pill) pill.remove(); voiceShowOverlay(false); voicePaintSettings(); clearInterval(voice.placeTimer); voice.placeTimer = 0; voicePaintHints(); return; }
  // The bars below move with the view (a conversation opens, a run strip appears).
  if (!voice.placeTimer) voice.placeTimer = setInterval(() => { voicePlaceDock(); voicePaintHints(); }, 700);
  voicePlaceDock();
  voicePaintHints();
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
  o.innerHTML = `<header><b>✦ Voice</b><span class="vo-meta"></span><button type="button" class="vo-help-btn" aria-pressed="false" title="What can I say here? (or say it)">?</button><button type="button" class="vo-close" title="Hide (the pill shows it again)" aria-label="Hide">✕</button></header>
    <div class="vo-error" hidden></div>
    <div class="vo-help" hidden></div>
    <div class="vo-heard" aria-live="off"></div>
    <ol class="vo-decisions" aria-live="polite"></ol>`;
  o.querySelector('.vo-close').onclick = () => voiceShowOverlay(false);
  o.querySelector('.vo-help-btn').onclick = () => voiceShowHelp(!voice.helpOpen);
  o.addEventListener('click', e => {
    const b = e.target.closest('[data-vo]');
    if (!b || !voice.pending) return;
    const entry = { said: b.dataset.vo === 'yes' ? '(clicked yes)' : '(clicked no)', at: Date.now(), status: 'done' };
    voiceAnswerPending(entry, b.dataset.vo === 'yes');
  });
  voiceDock().prepend(o);
  voicePlaceDock();
  voicePaintOverlayHead();
  voicePaintHelp();
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

// ---- what can I say ----
// The actions that apply on this screen now, from the same list Jev picks
// from, with example phrasings; while dictating, what steers dictation.

// The catalog's labels are written for the model ("the user"); the help speaks to you.
const voiceSpeakToYou = label => label.replace(/\bthe user's\b/g, 'your').replace(/\bthe user\b/g, 'you').replace(/\bthe user\b/gi, 'You');

function voiceShowHelp(open) {
  voice.helpOpen = !!open;
  if (open && !voiceOverlayShown()) voiceShowOverlay(true);
  voicePaintHelp();
}

function voiceHelpHtml() {
  const A = ChatteringVoiceActions;
  if (voice.mode === 'dictation') {
    return `<p class="vo-help-lead">Dictating into ${esc(voice.target.label)}: what you say is written there, except</p><ul>` +
      Object.entries(A.DICTATION).filter(([id]) => id !== 'text').map(([, a]) => `<li><b>${esc(a.say)}</b> — ${esc(voiceSpeakToYou(a.label))}</li>`).join('') + '</ul>';
  }
  const ids = Object.entries(VOICE_ACTIONS).filter(([, a]) => { try { return a.available(); } catch { return false; } }).map(([id]) => id);
  const rows = ids.filter(id => A.ACTIONS[id]).map(id => `<li><b>${esc(A.ACTIONS[id].say)}</b> — ${esc(voiceSpeakToYou(A.ACTIONS[id].label))}</li>`).join('');
  const picks = voicePicks();
  const numbers = voicePrefs().numbers && voice.numbers.size;
  return `<p class="vo-help-lead">Here, now — say it your way, Jev goes by meaning:</p><ul>${rows}</ul>` +
    (picks.items.length ? `<p class="vo-help-lead">To pick something: ${numbers ? 'its <b>number</b> on screen, ' : ''}its <b>place</b> (the third one, the last file, the previous one, the one before the last) or <b>words of its name</b>. Lists here: ${esc(picks.groups.map(g => g.label).join('; '))}.</p>` : '') +
    '<p class="vo-help-lead">When it is not sure it asks: say yes or no.</p>';
}

function voicePaintHelp() {
  const o = $('voiceOverlay');
  if (!o) return;
  const box = o.querySelector('.vo-help');
  box.hidden = !voice.helpOpen;
  o.querySelector('.vo-help-btn').setAttribute('aria-pressed', String(voice.helpOpen));
  if (voice.helpOpen) box.innerHTML = voiceHelpHtml();
}

// ---- numbers beside what can be picked ----

function voicePaintHints() {
  const want = voice.on && voice.status !== 'off' && voicePrefs().numbers;
  let layer = $('voiceHints');
  if (!want) { if (layer) layer.remove(); voice.numbers.clear(); return; }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'voiceHints';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    // Scrolling moves the items: follow at the next frame.
    let frame = 0;
    document.addEventListener('scroll', () => { if (!frame && $('voiceHints')) frame = requestAnimationFrame(() => { frame = 0; voicePaintHints(); }); }, true);
  }
  const inView = voiceNumber(voicePicks());
  const html = inView.map(it => {
    const r = it.el.getBoundingClientRect();
    // In the row's left margin, beside its first line: the title stays readable.
    return `<span class="vh" style="left:${Math.max(0, Math.round(r.left - 7))}px;top:${Math.max(0, Math.round(r.top + Math.min(r.height, 24) / 2 - 7))}px">${voice.numbers.get(it.key)}</span>`;
  }).join('');
  if (layer._html !== html) { layer._html = html; layer.innerHTML = html; }
  if (voice.helpOpen) voicePaintHelp();
}

// ---- settings (Settings → sound) ----

function voiceSettingsHtml() {
  const p = voicePrefs();
  return `<div class="set-group" id="voiceSettings">
    <h3>voice commands</h3>
    <label class="set-check"><input type="checkbox" data-voice="on"${voice.on ? ' checked' : ''}> Always listening on this device <kbd>Alt+L</kbd></label>
    <div class="set-help">Say what you want — “what can I say” lists it for the screen you are on: “change the model to sonnet”, “reasoning off”, “open the third one”, “the last file”, “the previous one”, “open seven”, “open the file called…”, “open the settings”, “start the microphone” (then talk, then “send”), in a file “go to line 40”, “change X to Y”, “fix the grammar”, “accept”. The speech goes to this machine’s speech-to-text; each sentence goes to TypeSafe’s Jev to pick the action. Silence is not sent to either.</div>
    <label class="set-field"><span>context window</span> <select data-voice="window">${VOICE_WINDOWS.map(s => `<option value="${s}"${s === p.window ? ' selected' : ''}>${s < 60 ? s + ' s' : s / 60 + ' min'}</option>`).join('')}</select></label>
    <div class="set-help">How much of what you said recently the speech-to-text rereads, for better words. Longer is more accurate and slower: about 4 ms per second of window on this GPU (1 min ≈ 0.23 s, 2 min ≈ 0.48 s after each pause).</div>
    <label class="set-check"><input type="checkbox" data-voice="numbers"${p.numbers ? ' checked' : ''}> Number what I can pick (conversations, files, projects) while listening</label>
    <div class="set-help">Say “open seven”. Without numbers, a place (“the third one”, “the last file”, “the previous one”) or words of the name still pick.</div>
    <label class="set-check"><input type="checkbox" data-voice="overlay"${p.overlay ? ' checked' : ''}> Show what is heard and decided (debug view)</label>
    <div class="set-help">Off: a small note says what was done.</div>
    <h3>what you said</h3>
    <div class="set-help">Every sentence heard while listening is kept on this machine, with what the screen offered, what Jev chose and how sure, and what became of it — so you can see what you meant and which command was missing, and write it down. ~/.local/share/chattering/voice-commands.jsonl, readable by you alone.</div>
    <div class="set-row"><button type="button" data-voice-history="all">Show all</button><button type="button" data-voice-history="missed">Show what was not understood</button><button type="button" class="ghost" data-voice-history="clear">Forget my history</button></div>
    <div id="voiceHistory"></div>
    <div class="set-field" id="voiceKeyField"><span class="hint">checking the TypeSafe key…</span></div>
  </div>`;
}

// ---- the history: what was said, what it became, what was meant ----

// Not understood: not taken for a command, asked about and not confirmed,
// failed, or never decided.
const voiceMissed = r => r.action === 'none' || r.error || r.missing || r.outcomes.some(o => /^(expired|cancelled|failed)/.test(o)) && !r.outcomes.includes('confirmed');

async function voiceShowHistory(host, which) {
  host.innerHTML = '<div class="hint">loading…</div>';
  let data;
  try { data = await (await fetch('/api/voice/history?limit=500')).json(); } catch { data = { error: 'network failure' }; }
  if (data.error) { host.innerHTML = `<div class="hint">${esc(data.error)}</div>`; return; }
  const rows = which === 'missed' ? data.rows.filter(voiceMissed) : data.rows;
  if (!rows.length) { host.innerHTML = `<div class="hint">${which === 'missed' ? 'Everything was understood.' : 'Nothing said yet.'}</div>`; return; }
  const decided = r => r.error ? '✗ ' + r.error
    : r.action === 'none' ? 'not a command' + (r.alternatives && r.alternatives[1] ? ' (next: ' + r.alternatives[1].action + ' ' + Math.round(r.alternatives[1].probability * 100) + '%)' : '')
    : r.action + (r.args && Object.keys(r.args).length ? ' ' + Object.values(r.args).map(v => (v && typeof v === 'object' ? 'selection' : String(v).split('/').pop())).join(' → ') : '') + (r.missing ? ' — which ' + r.missing + '?' : '');
  host.innerHTML = `<div class="hint">${rows.length} of ${data.rows.length} · newest first · a note says what you meant</div><ol class="voice-history">` + rows.map(r => `<li data-id="${esc(r.id)}">
      <div class="vhist-head"><span class="vhist-time">${esc(new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>${r.mode === 'dictation' ? '<span class="vhist-mode">dictating</span>' : ''}<span class="vhist-said">\u201c${esc(r.said || '')}\u201d</span></div>
      <div class="vhist-what">→ ${esc(decided(r))}${r.confidence != null && !r.error ? ' · ' + Math.round(r.confidence * 100) + '%' : ''}${r.outcomes.length ? ' · ' + esc(r.outcomes.join(', ')) : ''}<span class="vhist-screen"> · on ${esc(r.screen || '?')}</span></div>
      <input class="vhist-note" type="text" placeholder="what did you want?" value="${esc(r.note || '')}" aria-label="What you wanted">
    </li>`).join('') + '</ol>';
  host.querySelectorAll('.vhist-note').forEach(input => {
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    input.addEventListener('change', async () => {
      const out = await postJson('/api/voice/note', { id: input.closest('li').dataset.id, wanted: input.value });
      if (out.error) return errToast(out.error);
      input.classList.add('saved');
    });
  });
}

async function voiceBindSettings(root) {
  const box = root.querySelector('#voiceSettings');
  if (!box) return;
  box.querySelectorAll('[data-voice-history]').forEach(b => b.onclick = async () => {
    const which = b.dataset.voiceHistory, host = box.querySelector('#voiceHistory');
    if (which !== 'clear') return voiceShowHistory(host, which);
    if (!confirm('Forget everything you said to voice commands on this machine? This cannot be undone.')) return;
    const out = await postJson('/api/voice/history/clear', {});
    if (out.error) return errToast(out.error);
    toast('forgot ' + out.removed + ' sentences');
    host.innerHTML = '';
  });
  box.addEventListener('change', e => {
    const f = e.target.dataset.voice;
    if (f === 'on') voiceSetOn(e.target.checked);
    else if (f === 'window') {
      saveVoicePrefs({ window: Number(e.target.value) });
      if (voice.ws && voice.ws.readyState === WebSocket.OPEN) voice.ws.send(JSON.stringify({ type: 'window', seconds: Number(e.target.value) }));
      voicePaintOverlayHead();
    } else if (f === 'overlay') { saveVoicePrefs({ overlay: e.target.checked }); voiceShowOverlay(e.target.checked && voice.on); }
    else if (f === 'numbers') { saveVoicePrefs({ numbers: e.target.checked }); voicePaintHints(); }
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
