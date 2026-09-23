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
//
// Picking something ("open the third one", "the last file", "the one
// about air bills", "number seven") is one action, `open`, asked as three
// small judgments rather than one over every label: which list on screen,
// which place in it, which name — and the number said, when there is one.
// The page counts places; Jev never has to. Measured on a screen of 12
// conversations and 8 files: 13 of 13 right this way, 4 of 12 with one
// question over "1. Title" labels (design/64).
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
    stop_listening: { label: 'Stop listening entirely: turn voice commands off (not: stop dictating)', say: 'stop listening, turn off voice commands, go to sleep' },
    // "Stop dictation" when nothing is being dictated: said often, and must
    // never switch listening off (the record shows it did).
    stop_dictation: { label: 'Stop dictating (stop writing what is said into the box)', say: 'stop dictation, stop dictating, stop writing' },
    status: { label: 'Ask whether the app is listening, and in which mode', say: 'are you listening, is it still listening, can you hear me' },
    dictate: { label: 'Start dictating into the message box', say: 'start the microphone, start dictating, take a note, let me write' },
    focus_box: { label: 'Put the cursor in the message box, without dictating', say: 'focus the message box, go to the input box, into the compose box' },
    send: { label: 'Send the message in the box', say: 'send, send it, submit' },
    new_conversation: { label: 'Start a new conversation', say: 'start a new conversation, new chat, new conversation' },
    regenerate: { label: 'Regenerate the last answer: ask the model again', say: 'regenerate, regenerate the last answer, ask again, try that again' },
    scroll: { label: 'Scroll the conversation or the file once, by a step', say: 'scroll up, scroll down, page down, one page up, go to the top, go to the bottom', args: { direction: { kind: 'fixed', options: { up: 'up a little', down: 'down a little', page_up: 'one page up', page_down: 'one page down', top: 'to the very top', bottom: 'to the very bottom, the latest' }, question: 'In `said`, which way, and how far, does the user want to scroll?' } } },
    autoscroll: { label: 'Start scrolling continuously, slowly, until told to stop', say: 'start scrolling down, keep scrolling up, scroll slowly, read down', args: {
      direction: { kind: 'fixed', optional: true, options: { down: 'down, towards the end', up: 'up, towards the start' }, question: 'Which way does the user want the page to keep scrolling? Without a way said, down.' },
      speed: { kind: 'fixed', optional: true, options: { slow: 'slowly, reading speed', normal: 'not said', fast: 'fast, quickly' }, question: 'How fast does the user want it to scroll?' },
    } },
    autoscroll_adjust: { label: 'Stop or change the continuous scrolling going on now', say: 'stop, stop scrolling, faster, slower, the other way, go back up', args: { how: { kind: 'fixed', options: { stop: 'stop, halt, enough, there', faster: 'faster', slower: 'slower', reverse: 'the other way, reverse' }, question: 'What does the user want the scrolling to do?' } } },
    point: { label: 'Go to and highlight a message, a step or the thinking in the conversation, to act on it (copy, read, fork, fold…)', say: 'highlight the last answer, go to the previous message, the next message, the first message, go to my last message, next step, previous step, the thinking', args: {
      thing: { kind: 'fixed', optional: true, options: { message: 'a message, no kind named', answer: 'an answer, a reply from the assistant, the model, the AI', mine: 'a message the user wrote: their question, their prompt', steps: 'a step, steps, a group of steps, tool calls, the work', thinking: 'the thinking, the reasoning' }, question: 'Which kind of item does `said` name? "step" or "steps" is steps; "answer" or "reply" is answer; none named: message.' },
      place: { kind: 'fixed', options: { last: 'the last one, the latest', second_last: 'the one before the last', first: 'the first one', next: 'the next one, the one after, below', previous: 'the previous one, the one before, above', here: 'this one, the one on screen now' }, question: 'In `said`, which one of them?' },
    } },
    press: { label: 'Press a button or a menu item on screen by its name (on the highlighted message when it has it)', say: 'copy it, read it, make a notebook, fork, edit, continue here, review the turn, review changes, open the attachments, context, the conversation tree, zoom in, fit, project memory, open it', args: { control: { kind: 'list', list: 'controls', question: 'Which of these buttons or menu items does the user want to press? Only one `said` names by its words or its meaning ("copy it" is copy; "read it aloud" is read).' } } },
    fold: { label: 'Unfold (open, expand, show) or fold (close, collapse, hide) something: the highlighted item, all the steps, the thinking, the live stream of the reply being written', say: 'expand it, show more, collapse the steps, open the thinking, show the live thinking, hide the thinking, fold everything', args: {
      how: { kind: 'fixed', options: { open: 'open, expand, unfold, show', close: 'close, collapse, fold, hide' }, question: 'Does the user want it opened or closed?' },
      what: { kind: 'fixed', options: { this: 'the highlighted item, or the last message ("it", "this", "the last message", "more")', steps: 'every group of steps', thinking: 'every thinking block', live: 'the live stream of the reply being written, with its thinking as it comes', everything: 'everything' }, question: 'What does the user want opened or closed?' },
    } },
    zen: { label: 'Zen mode: show only the conversation or file, nothing around it (on, off)', say: 'zen mode, turn on zen, leave zen, zen off', args: { how: { kind: 'fixed', optional: true, options: { on: 'on, enter', off: 'off, leave, exit', toggle: 'not said' }, question: 'On or off?' } } },
    unread: { label: 'Open the newest conversation with a reply not read yet', say: 'the latest unread, next unread, what is new, open the new reply' },
    tree_move: { label: 'Move the selection in the conversation tree, or open the selected box', say: 'up, down, go to the parent, the child, left, right, next branch, open it, open this box, read it', args: { move: { kind: 'fixed', options: { up: 'up, to the parent, earlier', down: 'down, to the child, later', left: 'left, the previous branch', right: 'right, the next branch', open: 'open it, read it, go there' }, question: 'Where does the user want to move in the tree?' } } },
    delegate: { label: 'Ask the coding agent to find something and bring it on screen, when no other request here does it (it searches files, conversations and projects)', say: 'find the conversation where we fixed the login, show me where the parser is defined, ask the agent to find…' },
    model: { label: 'Change the model that answers', say: 'change the model to…, switch to…, use…', args: { model: { kind: 'list', list: 'models', question: 'Which model does the user want to use?' } } },
    reasoning: { label: 'Change the reasoning (thinking) level', say: 'reasoning off, think harder, set thinking to high', args: { level: { kind: 'fixed', options: Object.fromEntries(THINKING.map(l => [l, null])), question: 'Which reasoning level does the user want (off is no reasoning, max is the most)?' } } },
    open: { label: 'Open or pick something by its number, place or name: a conversation, a file (of any project), a project, a timeline mark, a box of the tree, a search result', say: 'open the third one, the last file, the previous one, the one about air bills, open the file called… in the … project, the chattering project, select the third mark, number seven', args: {
      number: { kind: 'numbers', question: 'In `said`, does the user pick a numbered item on screen by its number ("number seven", "open 12")? Which number?' },
      list: { kind: 'groups', question: 'In `said`, which of these lists does the user mean? A kind of item ("file", "conversation", "project") or a side ("on the right", "on the left") says it.' },
      place: { kind: 'fixed', options: null, question: 'In `said`, does the user pick the item by its place in its list? Which place?' },
      name: { kind: 'list', list: 'targets', question: 'Which of these items does the user name in `said`, by words of its title or file name ("dot js" said for .js, spaces for dashes)? Only what `said` names: not the item open now unless it is named.' },
    } },
    help: { label: 'Show what the user can say here: the list of voice commands', say: 'what can I say, show the commands, open the command panel, list the commands, help' },
    settings: { label: 'Open the settings', say: 'open the settings, show the appearance settings', args: { pane: { kind: 'fixed', optional: true, options: SETTINGS_PANES, question: 'Which part of the settings does the user want? Without a part named, profile.' } } },
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
    accept_change: { label: 'Accept the change under review here', say: 'accept, keep it, accept all' , args: { all: { kind: 'fixed', optional: true, options: { one: 'the change at the cursor', all: 'every change' }, question: 'Does the user accept one change or all of them?' } } },
    reject_change: { label: 'Reject the change under review here', say: 'reject, undo that change, reject all', args: { all: { kind: 'fixed', optional: true, options: { one: 'the change at the cursor', all: 'every change' }, question: 'Does the user reject one change or all of them?' } } },
    find: { label: 'Find words in the file and select them', say: 'find parse config, search for TODO, where is the word total', args: { text: { kind: 'list', list: 'found', question: 'Which words does the user want to find in the file (only words to search, not "find" or "search for")?' } } },
    find_again: { label: 'Go to the next or previous place of the words last found', say: 'next, the next one, find again, previous match', args: { which: { kind: 'fixed', optional: true, options: { next: 'next, again', previous: 'previous, back' }, question: 'Next or previous?' } } },
    select: { label: 'Select text in the file: a line, a paragraph, a sentence, the code chunk, everything, lines N to M, or from some words to other words', say: 'select this line, select the paragraph, select all, select lines 3 to 10, select from dear to regards, unselect', args: {
      what: { kind: 'fixed', options: { line: 'the line', paragraph: 'the paragraph', sentence: 'the sentence', word: 'the word', chunk: 'the code chunk, the cell', all: 'everything, all', lines: 'lines by their numbers', between: 'from some words to other words', none: 'nothing: unselect' }, question: 'What does the user want to select?' },
      from_line: { kind: 'numbers', optional: true, question: 'The first line number to select?' },
      to_line: { kind: 'numbers', optional: true, question: 'The last line number to select?' },
      from: { kind: 'list', optional: true, list: 'found', question: 'The words where the selection starts (after "from")?' },
      to: { kind: 'list', optional: true, list: 'found', question: 'The words where the selection ends (after "to" or "until")?' },
    } },
    chunk: { label: 'Go to a code chunk (a cell) of the notebook', say: 'next chunk, previous cell, the first chunk, the last cell', args: { place: { kind: 'fixed', optional: true, options: { next: 'the next one', previous: 'the previous one', first: 'the first', last: 'the last', here: 'this one' }, question: 'Which chunk?' } } },
    chunk_run: { label: 'Run code of the notebook: this chunk, this one then the next, every chunk, or stop the run', say: 'run this chunk, run it, run and go to the next, run all, stop the run', args: { which: { kind: 'fixed', optional: true, options: { this: 'this chunk', advance: 'this chunk, then move to the next', all: 'every chunk, run all', stop: 'stop, cancel, interrupt the run' }, question: 'What does the user want to run?' } } },
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

  // Places in a list, for `open`: the page turns one into an item.
  const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  const PLACES = {
    ...Object.fromEntries(ORDINALS.map((o, i) => [o, `the ${o} from the top` + (i === 0 ? ' (the top one)' : '')])),
    last: 'the last one, at the bottom', second_last: 'the one before the last',
    above: 'the one just above the one open now (the previous one)', below: 'the one just below the one open now (the next one)',
    none: 'not by place: by name, by number, or not said',
  };
  ACTIONS.open.args.place.options = PLACES;
  const UNCLEAR = 'unclear';

  const SEND_TAIL = /[\s,.;:!?-]*\b(?:and\s+)?(?:send(?:\s+it)?|submit|that(?:'s| is) all[,.\s]*send)[\s.!?]*$/i;

  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const tokens = s => str(s, 2000).toLowerCase()
    .replace(/\bdot\b/g, '.').replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  /**
   * The items most like what was said, best first, at most `keep`: those
   * marked `keep` (on screen) first, then shared words (whole, or a said
   * word starting a label word), then list order.
   */
  function rankByOverlap(items, said, keep = LIMITS.list) {
    if (items.length <= keep) return items;
    const kept = items.filter(x => x.keep).slice(0, keep);
    if (kept.length) return kept.concat(rankByOverlap(items.filter(x => !x.keep), said, keep - kept.length));
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
        else if (arg.kind === 'groups') {
          // The lists on screen, in words ("files in the right panel"): a
          // model reads the option itself; the key maps it back to the id.
          const groups = (Array.isArray(lists.groups) ? lists.groups : []).filter(g => g && g.id && g.label).slice(0, 30);
          if (groups.length < 2) continue;
          keys[id + '.' + name] = Object.fromEntries(groups.map(g => [str(g.label, LIMITS.label), String(g.id)]));
          options = Object.fromEntries(groups.map(g => [str(g.label, LIMITS.label), null]).concat([[UNCLEAR, 'no kind of item and no side is said']]));
        }
        else if (arg.kind === 'list') {
          const items = (Array.isArray(lists[arg.list]) ? lists[arg.list] : [])
            .filter(x => x && x.id != null && x.label).map(x => ({ id: String(x.id), label: str(x.label, LIMITS.label), keep: x.keep === true }));
          if (!items.length) continue;
          const chosen = rankByOverlap(items, said, LIMITS.list - 1);
          // The label is the option (what the model reads); the key maps it back.
          const map = {};
          for (const x of chosen) { let k = x.label, n = 2; while (Object.hasOwn(map, k)) k = x.label + ' (' + n++ + ')'; map[k] = x.id; }
          keys[id + '.' + name] = map;
          options = Object.fromEntries(Object.keys(map).map(k => [k, null]).concat([[NOT_SAID, 'none of these']]));
        } else if (arg.kind === 'numbers') {
          // "the r stats one" is no number: a lone "one" counts only as
          // "number one" (or the digit).
          const nums = numbersIn(said).filter(n => n !== 1 || /\b1\b|\bnumber\s+one\b|\bline\s+one\b/i.test(said));
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
    const groups = (Array.isArray(lists.groups) ? lists.groups : []).filter(g => g && g.id && g.label).map(g => ({ id: String(g.id), label: str(g.label, LIMITS.label) }));
    return { request: { model, state, questions }, keys, dictating: false, defaultGroup: str(lists.defaultGroup, 100) || null, groups };
  }

  // The list a sentence names by its words, when exactly one list on
  // screen matches them: a kind ("the last file", "chats") and a side ("on
  // the right"). An exact lookup, kept in code.
  const KIND_WORDS = [[/\b(files?|folders?)\b/i, /^files/], [/\b(conversations?|chats?)\b/i, /^conversations/], [/\bprojects?\b/i, /^projects/], [/\bmarks?\b/i, /^marks/], [/\bbox(es)?\b/i, /^boxes/]];
  const SIDE_WORDS = [[/\b(right|right-hand)\b/i, /right panel/], [/\b(left|left-hand|sidebar)\b/i, /left panel/]];
  function listNamed(groups, said) {
    let hits = groups;
    for (const [words, label] of KIND_WORDS.concat(SIDE_WORDS)) if (words.test(said)) hits = hits.filter(g => label.test(g.label));
    return hits.length === 1 && hits.length < groups.length ? hits[0].id : null;
  }

  // `open`: the number said; else the surer of a place in a list and a
  // name ("the r stats one" is a name, though "one" may sound like "the
  // first one"). A place counts in the list the words name, else the list
  // Jev heard, else the page's default; Jev's doubt about the list counts
  // only when it moved the count off the default. A name is judged among
  // the items: the "(not said)" share is what the other questions answer.
  function readOpen(built, answers, actionConfidence, said) {
    const get = name => pickOf(answers['open.' + name]);
    const number = get('number'), list = get('list'), place = get('place'), name = get('name');
    if (number && number.choice !== NOT_SAID) return { args: { number: Number(number.choice) }, confidence: Math.min(actionConfidence, number.confidence) };
    let byPlace = null, byName = null;
    if (place && place.choice !== 'none') {
      const byWords = listNamed(built.groups || [], said);
      const heard = !byWords && list && list.choice !== UNCLEAR ? (built.keys['open.list'] || {})[list.choice] || null : null;
      const doubt = heard && heard !== built.defaultGroup ? list.confidence : 1;
      byPlace = { args: { place: place.choice, list: byWords || heard || built.defaultGroup }, confidence: Math.min(actionConfidence, place.confidence, doubt) };
    }
    if (name) {
      const map = built.keys['open.name'] || {};
      const items = Object.entries(name.probabilities).filter(([k]) => k !== NOT_SAID).sort((a, b) => b[1] - a[1]);
      const total = items.reduce((n, [, p]) => n + p, 0);
      if (items.length && total > 0) {
        const [best, p] = items[0];
        const among = p / total;
        // Jev leaned to "nothing named": a guess worth asking about, never acting on.
        if (name.choice !== NOT_SAID) byName = { args: { name: map[best] }, confidence: Math.min(actionConfidence, among) };
        else if (p >= 0.25) byName = { args: { name: map[best] }, confidence: Math.min(actionConfidence, among, 0.5) };
      }
    }
    if (byPlace && byName) return byName.confidence > byPlace.confidence ? byName : byPlace;
    if (byPlace || byName) return byPlace || byName;
    return { args: {}, confidence: Math.min(actionConfidence, 0.3), missing: 'item' };
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
    if (a.choice === 'open') {
      const o = readOpen(built, answers, a.confidence, String(said || ''));
      return { action: 'open', args: o.args, confidence: o.confidence, missing: o.missing || null, alternatives };
    }
    const args = {};
    let confidence = a.confidence, missing = null;
    // An optional argument (the settings pane, a speed, where a selection
    // starts…) has a default when not asked or not said, and its doubt does
    // not hold the action back: a wrong one costs little and shows at once.
    for (const [name, arg] of Object.entries((ACTIONS[a.choice] && ACTIONS[a.choice].args) || {})) {
      const q = pickOf(answers[a.choice + '.' + name]);
      if (!q) { if (!arg.optional) missing = missing || name; continue; }
      if (!arg.optional) confidence = Math.min(confidence, q.confidence);
      if (q.choice === NOT_SAID) { if (!arg.optional) missing = missing || name; continue; }
      const map = built.keys[a.choice + '.' + name];
      args[name] = map ? map[q.choice] : q.choice === THE_SELECTION ? { selection: true } : q.choice === DELETE_IT ? '' : q.choice;
    }
    return { action: a.choice, args, confidence: missing ? Math.min(confidence, 0.3) : confidence, missing, alternatives };
  }

  /**
   * The coding agent's answer to a handed-on request ends with one line
   * naming what to show (server.js voiceDelegatePrompt). → {kind: file |
   * conversation | project | nothing, target, line} from the last such
   * line, or null. Markdown around it (bold, backticks) is tolerated.
   */
  function parseShowLine(text) {
    const lines = String(text || '').split('\n').map(l => l.trim().replace(/^[>*_`\s-]+|[*_`\s]+$/g, '')).filter(l => /^SHOW\s*:/i.test(l));
    const line = lines.pop();
    if (!line) return null;
    const m = line.replace(/^SHOW\s*:[*_\s]*/i, '').replace(/`/g, '').match(/^(file|conversation|project|nothing)\b\s*(.*)$/i);
    if (!m) return null;
    const kind = m[1].toLowerCase(), rest = m[2].trim();
    if (kind === 'nothing') return { kind, target: null, why: rest.slice(0, 200) };
    if (!rest) return null;
    if (kind === 'file') {
      const f = rest.match(/^(.+?)(?::(\d+)(?::\d+)?)?$/);
      return { kind, target: f[1].trim(), line: f[2] ? Number(f[2]) : null };
    }
    return { kind, target: rest.split(/\s+/)[0] };
  }

  return { parseShowLine, LIMITS, ACTIONS, DICTATION, THINKING, SETTINGS_PANES, PLACES, ORDINALS, SEND_TAIL, NOT_SAID, buildRequest, readDecision, rankByOverlap, numbersIn, spansOf };
});
