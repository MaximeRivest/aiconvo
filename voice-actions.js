// Voice commands: what can be said, and how a sentence becomes one request
// to Jev (TypeSafe's System One model) and back into an action with its
// arguments. Shared by the server (which builds and sends the request with
// the key) and the page (which lists what applies on screen and runs it).
//
// The pattern is TypeSafe's function calling: one Choice picks the action
// among those that apply now (plus "not a command"), and every argument of
// every applicable action is asked at once, speculatively, as a Choice over
// real candidates — the conversations on screen, the models, the files, the
// words actually said. Code finds candidates; Jev only selects. Nothing is
// generated, so an answer is always something the app can do.
//
// A decision's confidence is its least certain part (the action, or an
// argument it uses), as TypeSafe recommends: one wrong argument spoils the
// action.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatteringVoiceActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ said: 600, heard: 1500, screen: 200, label: 160, list: 250, selection: 2000, nearby: 8000, spanWords: 6 });
  const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const SETTINGS_PANES = { profile: 'your profile', model: 'the model for notes, titles and memory', sound: 'sound and voice', search: 'search', snippets: 'snippets', machines: 'machines', people: 'people', appearance: 'appearance: theme, fonts, text size', jobs: 'background jobs', advanced: 'advanced' };
  const NOT_SAID = '(not said)';
  const THE_SELECTION = '(the selected text)';
  const DELETE_IT = '(nothing: delete it)';
  const DEICTIC = /^(this|that|it|these|those|this text|that text|the selection)$/i;

  // Argument kinds: `list` (candidates the page sends), `fixed` (options
  // here), `numbers` / `spans` / `oldSpans` (found in what was said).
  const ACTIONS = {
    none: { label: 'Not a request to the app', say: 'talking to someone else, thinking aloud, dictating a thought, or noise' },
    confirm: { label: 'Yes: do the suggested action', say: 'yes, do it, go ahead, correct, that one' },
    cancel: { label: 'No: drop the suggested action', say: 'no, never mind, cancel, not that' },
    stop_listening: { label: 'Stop listening', say: 'stop listening, turn off voice commands, go to sleep' },
    dictate: { label: 'Start dictating into the message box', say: 'start the microphone, start dictating, take a note, let me write' },
    send: { label: 'Send the message in the box', say: 'send, send it, submit' },
    model: { label: 'Change the model that answers', say: 'change the model to…, switch to…, use…', args: { model: { kind: 'list', list: 'models', question: 'Which model does the user want to use?' } } },
    reasoning: { label: 'Change the reasoning (thinking) level', say: 'reasoning off, think harder, set thinking to high', args: { level: { kind: 'fixed', options: Object.fromEntries(THINKING.map(l => [l, null])), question: 'Which reasoning level does the user want (off is no reasoning, max is the most)?' } } },
    open_conversation: { label: 'Open a conversation from the list on the left', say: 'open the third conversation, go to the one about…', args: { conversation: { kind: 'list', list: 'conversations', question: 'Which conversation of the list does the user mean, by its position (first, third, last) or by what it is about?' } } },
    open_file: { label: 'Open a file', say: 'open the file called…, go to…', args: { file: { kind: 'list', list: 'files', question: 'Which file does the user name? Speech-to-text may spell a name as words: "dot js" for .js, spaces for dashes or underscores.' } } },
    settings: { label: 'Open the settings', say: 'open the settings, show the appearance settings', args: { pane: { kind: 'fixed', options: SETTINGS_PANES, question: 'Which part of the settings does the user want? Without a part named, profile.' } } },
    go_home: { label: 'Go to the home page (all conversations, the timeline)', say: 'go home' },
    go_back: { label: 'Go back to the previous screen', say: 'go back, previous' },
    go_forward: { label: 'Go forward to the next screen', say: 'go forward' },
    ask_box: { label: 'Open the ask box, to ask an agent for a change to this file (Ctrl+K)', say: 'open the ask box, ask an agent, control K' },
    command_box: { label: 'Open the AI command box (Ctrl+J)', say: 'open the command box, AI commands, control J' },
    ai_command: { label: 'Run one AI command on the text here', say: 'fix the grammar, document this code, finish the sentence', args: { command: { kind: 'list', list: 'commands', question: 'Which AI command does the user want to run?' } } },
    go_to_line: { label: 'Go to a line of the file', say: 'go to line forty two', args: { line: { kind: 'numbers', question: 'Which line number does the user want to go to?' } } },
    replace: { label: 'Replace exact words in the text with other exact words the user dictates', say: 'change X to Y, replace X with Y, change this to Y — Y being the very words to write', args: {
      old: { kind: 'oldSpans', question: 'In a request like "change OLD to NEW" or "replace OLD with NEW", which words are OLD: the text that is there now? Only those words, without "to", "with" or "for" after them. "this", "that" or "it" alone mean the selected text.' },
      new: { kind: 'spans', question: 'In a request like "change OLD to NEW" or "replace OLD with NEW", which words are NEW: the exact words to write in place of OLD?' },
    } },
    rewrite: { label: 'Rewrite the text here as the user describes, not with exact words', say: 'make this shorter, make it more formal, change this to a friendlier tone, turn this into a list' },
    accept_change: { label: 'Accept the change under review here', say: 'accept, keep it, accept all' , args: { all: { kind: 'fixed', options: { one: 'the change at the cursor', all: 'every change' }, question: 'Does the user accept one change or all of them?' } } },
    reject_change: { label: 'Reject the change under review here', say: 'reject, undo that change, reject all', args: { all: { kind: 'fixed', options: { one: 'the change at the cursor', all: 'every change' }, question: 'Does the user reject one change or all of them?' } } },
    text_size: { label: 'Make the text of the file larger or smaller', say: 'bigger text, zoom in, smaller, reset the text size', args: { direction: { kind: 'fixed', options: { larger: 'larger, bigger, zoom in', smaller: 'smaller, zoom out', reset: 'back to normal, 100%' }, question: 'Larger, smaller, or back to normal?' } } },
  };

  // While dictating, sentences are text for the box unless they steer it.
  const DICTATION = {
    text: { label: 'Words to write in the message', say: 'anything that is part of the message' },
    text_send: { label: 'Words to write, then send the message', say: 'the message, ending with send / send it / that is all, send' },
    send: { label: 'Send the message as it is', say: 'send, send it (alone)' },
    stop: { label: 'Stop dictating, keep the text', say: 'stop dictating, stop the microphone, pause' },
    clear: { label: 'Clear the message box', say: 'clear it, delete everything, start over' },
  };

  const SEND_TAIL = /[\s,.;:!?-]*\b(?:and\s+)?(?:send(?:\s+it)?|submit|that(?:'s| is) all[,.\s]*send)[\s.!?]*$/i;

  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const tokens = s => str(s, 2000).toLowerCase()
    .replace(/\bdot\b/g, '.').replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  /**
   * The items most like what was said, best first, at most `keep`: shared
   * words (whole, or a said word starting a label word), then list order.
   */
  function rankByOverlap(items, said, keep = LIMITS.list) {
    if (items.length <= keep) return items;
    const words = new Set(tokens(said).filter(w => w.length > 1));
    const score = item => {
      let s = 0;
      for (const t of tokens(item.label)) {
        if (words.has(t)) s += 2;
        else for (const w of words) if (w.length >= 3 && t.startsWith(w)) { s += 1; break; }
      }
      return s;
    };
    return items.map((item, i) => ({ item, i, s: score(item) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, keep).map(x => x.item);
  }

  // ---- numbers said ----
  const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  /** The numbers in a sentence, as digits or words ("two hundred and twelve"), in order. */
  function numbersIn(text) {
    const out = [];
    const words = String(text || '').toLowerCase().replace(/-/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
    let cur = null, total = 0;
    const end = () => { if (cur !== null || total) out.push(total + (cur || 0)); cur = null; total = 0; };
    for (const w of words) {
      if (/^\d+$/.test(w)) { end(); out.push(Number(w)); continue; }
      if (w in UNITS) { cur = (cur || 0) + UNITS[w]; continue; }
      if (w in TENS) { cur = (cur || 0) + TENS[w]; continue; }
      if (w === 'hundred' && cur !== null) { cur *= 100; continue; }
      if (w === 'thousand' && cur !== null) { total += cur * 1000; cur = null; continue; }
      if (w === 'and' && (cur !== null || total)) continue;
      end();
    }
    end();
    return [...new Set(out)];
  }

  /** Runs of 1..LIMITS.spanWords consecutive words of `said`, as said (punctuation at the edges trimmed). */
  function spansOf(said) {
    const w = str(said, LIMITS.said).split(' ').filter(Boolean);
    const out = [];
    for (let i = 0; i < w.length; i++) {
      for (let j = i + 1; j <= Math.min(w.length, i + LIMITS.spanWords); j++) {
        const s = w.slice(i, j).join(' ').replace(/^[^\p{L}\p{N}'"]+|[^\p{L}\p{N}'"]+$/gu, '');
        if (s && !out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  /**
   * The request to Jev for one sentence. `context` is the page's (checked
   * here): {said, heard, mode, screen, actions, lists: {name: [{id, label}]},
   * doc: {selection, nearby}, pending}. Returns {request, keys} — keys maps
   * each question's option keys back to ids.
   */
  function buildRequest(context, { model = 'jev-latest' } = {}) {
    const c = context && typeof context === 'object' ? context : {};
    const said = str(c.said, LIMITS.said);
    if (!said) throw new Error('nothing was said');
    const dictating = c.mode === 'dictation';
    const state = { said, earlier: str(c.heard, LIMITS.heard), screen: str(c.screen, LIMITS.screen) };
    const questions = {}, keys = {};
    if (dictating) {
      questions.action = { type: 'choice', instructions: 'The user is dictating a message into a text box. What is `said`: more words for the message, or a request to send it, stop dictating, or clear it?', criteria: Object.fromEntries(Object.entries(DICTATION).map(([id, a]) => [id, a.label + ' — e.g. ' + a.say])) };
      return { request: { model, state, questions }, keys, dictating: true };
    }
    const catalog = (Array.isArray(c.actions) ? c.actions : []).filter(id => Object.hasOwn(ACTIONS, id) && id !== 'none');
    const available = [...new Set(c.pending ? ['confirm', 'cancel', ...catalog] : catalog.filter(id => id !== 'confirm' && id !== 'cancel'))];
    if (c.pending) state.suggested = str(c.pending, LIMITS.label);
    const optionsFor = ids => Object.fromEntries(ids.concat('none').map(id => [id, ACTIONS[id].label + ' — e.g. ' + ACTIONS[id].say]));
    questions.action = { type: 'choice', instructions: 'Which request to the app does the user make in `said`? `earlier` is what they said before, for context only; `screen` is what the app shows.' + (c.pending ? ' The app just suggested `suggested` and waits for a yes or no.' : ''), criteria: optionsFor(available) };
    const lists = c.lists && typeof c.lists === 'object' ? c.lists : {};
    const doc = c.doc && typeof c.doc === 'object' ? c.doc : {};
    for (const id of available) {
      for (const [name, arg] of Object.entries(ACTIONS[id].args || {})) {
        let options;
        if (arg.kind === 'fixed') options = arg.options;
        else if (arg.kind === 'list') {
          const items = (Array.isArray(lists[arg.list]) ? lists[arg.list] : [])
            .filter(x => x && x.id != null && x.label).map(x => ({ id: String(x.id), label: str(x.label, LIMITS.label) }));
          if (!items.length) continue;
          const chosen = rankByOverlap(items, said, LIMITS.list - 1);
          // The label is the option (what the model reads); the key maps it back.
          const map = {};
          for (const x of chosen) { let k = x.label, n = 2; while (Object.hasOwn(map, k)) k = x.label + ' (' + n++ + ')'; map[k] = x.id; }
          keys[id + '.' + name] = map;
          options = Object.fromEntries(Object.keys(map).map(k => [k, null]).concat([[NOT_SAID, 'none of these']]));
        } else if (arg.kind === 'numbers') {
          const nums = numbersIn(said);
          if (!nums.length) continue;
          options = Object.fromEntries(nums.map(n => [String(n), null]).concat([[NOT_SAID, 'no number given']]));
        } else if (arg.kind === 'spans' || arg.kind === 'oldSpans') {
          let spans = spansOf(said);
          if (arg.kind === 'oldSpans') {
            // Old text must be in the text near the cursor, and is never
            // the request's own verb. "this" alone is the selection.
            const nearby = String(doc.nearby || '').toLowerCase();
            const hasSelection = !!str(doc.selection, LIMITS.selection);
            spans = spans.filter(s => nearby.includes(s.toLowerCase()) && !/^(change|replace|swap)\b/i.test(s) && !(hasSelection && DEICTIC.test(s)));
            if (hasSelection) spans.unshift(THE_SELECTION);
          } else spans = spans.filter(s => !/^(change|replace|swap)\b/i.test(s)).concat(DELETE_IT);
          if (!spans.length) continue;
          options = Object.fromEntries(spans.slice(0, LIMITS.list - 1).map(s => [s, null]).concat([[NOT_SAID, 'not said']]));
        }
        if (options) questions[id + '.' + name] = { type: 'choice', instructions: arg.question, criteria: options };
      }
    }
    return { request: { model, state, questions }, keys, dictating: false };
  }

  const pickOf = a => a && typeof a === 'object' ? { choice: a.choice, confidence: Number(a.confidence) || 0, probabilities: a.probabilities || {} } : null;

  /**
   * Jev's answers → {action, args, confidence, alternatives, text?}. An
   * action whose required argument was not found, or was "not said",
   * becomes a suggestion with low confidence (the page asks). `said` is
   * needed to cut the send words off dictated text.
   */
  function readDecision(built, answers, said = '') {
    const a = pickOf(answers && answers.action);
    if (!a) throw new Error('no action in the answer');
    const alternatives = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id, p]) => ({ action: id, probability: p }));
    if (built.dictating) {
      const text = a.choice === 'text_send' ? String(said).replace(SEND_TAIL, '').trim() : a.choice === 'text' ? String(said).trim() : '';
      return { action: a.choice, args: {}, confidence: a.confidence, alternatives, text, dictating: true };
    }
    const args = {};
    let confidence = a.confidence, missing = null;
    for (const [name] of Object.entries((ACTIONS[a.choice] && ACTIONS[a.choice].args) || {})) {
      const q = pickOf(answers[a.choice + '.' + name]);
      if (!q) { missing = missing || name; continue; }
      confidence = Math.min(confidence, q.confidence);
      if (q.choice === NOT_SAID) { missing = missing || name; continue; }
      const map = built.keys[a.choice + '.' + name];
      args[name] = map ? map[q.choice] : q.choice === THE_SELECTION ? { selection: true } : q.choice === DELETE_IT ? '' : q.choice;
    }
    // Optional arguments: the settings pane, one-or-all of a review.
    if (missing === 'pane' || missing === 'all') missing = null;
    return { action: a.choice, args, confidence: missing ? Math.min(confidence, 0.3) : confidence, missing, alternatives };
  }

  return { LIMITS, ACTIONS, DICTATION, THINKING, SETTINGS_PANES, SEND_TAIL, NOT_SAID, buildRequest, readDecision, rankByOverlap, numbersIn, spansOf };
});
