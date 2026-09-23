// AI commands in documents: what each one asks a model, shared by the
// server (which builds the prompt) and the page (which lists the commands
// in mrmd's command box).
//
// The editor (mrmd-document's `ai` option, document-ai.js) owns the surface:
// where a command acts, the suggestion beside the text, accept and discard.
// Chattering owns the rest: this catalog, the model (Chattering's own, the
// one in settings → model), the call (a no-session, tool-less `pi` run),
// and the provenance of an accepted edit.
//
// The server answers only commands listed here; a request never carries its
// own prompt, so the route is not a general model proxy. The one free-form
// field is the instruction of the `edit` command, capped in length.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatteringAiCommands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // What goes to the model, at most. Past these, the document is cut
  // around the target (with a marker saying so), never the target itself.
  const LIMITS = Object.freeze({ document: 60000, target: 20000, before: 6000, after: 2000, block: 20000, instruction: 2000 });

  // The reply contract every task ends with, by kind.
  const REPLY = {
    replace: 'Reply with the new text for TARGET only — no explanation, no quotation marks, no code fence around it.',
    insert: 'Reply with the text to insert at the cursor only — no explanation, no quotation marks, no code fence around it, and nothing that is already before the cursor. Begin with a space or a line break if the text needs one.',
  };

  // thinking: the pi thinking level of the call. Quick prose fixes need
  // none; code and free-form edits get a little.
  const COMMANDS = [
    { id: 'grammar', label: 'Fix grammar and spelling', hint: 'minimal changes', keywords: ['spelling', 'typos', 'punctuation', 'correct'],
      scope: 'prose', target: 'selection-or-block', kind: 'replace', thinking: 'off',
      task: 'Correct the grammar, spelling and punctuation of TARGET. Change as little as possible: keep the wording, the tone, the Markdown formatting, the line breaks and the technical terms. If nothing needs fixing, reply with TARGET unchanged.' },
    { id: 'transcription', label: 'Fix dictation', hint: 'speech-to-text errors', keywords: ['speech', 'voice', 'transcript', 'dictated'],
      scope: 'prose', target: 'selection-or-block', kind: 'replace', thinking: 'off',
      task: 'TARGET was dictated with speech-to-text. Fix misheard words (the document shows the names and terms in use), punctuation and capitalization. Keep the speaker\u2019s meaning and wording otherwise: do not rephrase, shorten or summarize.' },
    { id: 'sentence', label: 'Finish the sentence', hint: 'at the cursor', keywords: ['complete', 'continue', 'autocomplete'],
      scope: 'prose', target: 'cursor', kind: 'insert', thinking: 'off',
      task: 'Continue the text at the cursor to the end of the current sentence, in the document\u2019s voice and language. Stop at the end of that sentence.' },
    { id: 'paragraph', label: 'Finish the paragraph', hint: 'at the cursor', keywords: ['complete', 'continue', 'write'],
      scope: 'prose', target: 'cursor', kind: 'insert', thinking: 'off',
      task: 'Continue the text at the cursor to the end of the current paragraph, in the document\u2019s voice and language, bringing its thought to a close. Do not start a new paragraph.' },
    { id: 'markdown', label: 'Tidy the Markdown', hint: 'formatting only', keywords: ['format', 'clean', 'lists', 'headings'],
      scope: 'prose', target: 'selection-or-block', kind: 'replace', thinking: 'off',
      task: 'Fix the Markdown formatting of TARGET: list markers and indentation, emphasis, headings, links, tables, spacing. Do not change a single word.' },
    { id: 'code-line', label: 'Finish this line', hint: 'at the cursor', keywords: ['complete', 'continue'],
      scope: 'code', target: 'cursor', kind: 'insert', thinking: 'low',
      task: 'Complete the current line of {language} code at the cursor. Reply with the rest of that line only: no line break, nothing after it.' },
    { id: 'code-cell', label: 'Finish this cell', hint: 'at the cursor', keywords: ['complete', 'continue', 'function', 'block'],
      scope: 'code', target: 'cursor', kind: 'insert', thinking: 'low',
      task: 'Continue the {language} code at the cursor to finish the current function, block or cell, following the style of the code around it and of the other cells in the document.' },
    { id: 'comments', label: 'Document the code', hint: 'docstrings, comments', keywords: ['docstring', 'comments', 'explain'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'low',
      task: 'Add docstrings and comments to the {language} code in TARGET where they help a reader understand why and how. Do not change what the code does, its names, or its formatting.' },
    { id: 'types', label: 'Add type hints', hint: 'annotations', keywords: ['types', 'annotations', 'typing'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'low',
      task: 'Add type annotations to the {language} code in TARGET where the language supports them, using the types the code actually works with. Do not change what the code does, its names, or its formatting otherwise.' },
    { id: 'names', label: 'Improve names', hint: 'clearer identifiers', keywords: ['rename', 'variables', 'identifiers'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'low',
      task: 'Give clearer names to the variables, functions and parameters that TARGET defines. A name that the rest of the document uses must keep its name, since renaming it here would break the other cells. Change nothing else.' },
    { id: 'format', label: 'Format the code', hint: 'standard style', keywords: ['format', 'style', 'indent', 'lint'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'off',
      task: 'Reformat the {language} code in TARGET the way its standard formatter would. Do not change what the code does or its names.' },
    { id: 'edit', label: 'Change it', hint: 'as you describe', keywords: [],
      scope: 'any', target: 'selection-or-block', kind: 'replace', instruction: true, thinking: 'low',
      task: 'Rewrite TARGET as the person asks: {instruction}\nChange only what this request needs; keep everything else as it is (formatting, style, language).' },
  ];

  const byId = new Map(COMMANDS.map(c => [c.id, c]));

  /** The commands as mrmd's `ai.commands` option wants them (no prompts). */
  function publicCommands() {
    return COMMANDS.map(({ task, thinking, ...shown }) => shown);
  }

  function commandById(id) {
    return byId.get(String(id || '')) || null;
  }

  const str = v => (typeof v === 'string' ? v : '');
  const int = v => (Number.isInteger(v) && v >= 0 ? v : null);

  /**
   * Check a request from the page (mrmd's request, see document-ai.js) and
   * keep only what the prompt uses. Returns {error} or {command, request}.
   */
  function validateRequest(body) {
    const command = commandById(body && body.command);
    if (!command) return { error: 'unknown AI command' };
    const r = body.request && typeof body.request === 'object' ? body.request : null;
    if (!r) return { error: 'request required' };
    const document = str(r.document);
    const target = r.target && typeof r.target === 'object' ? r.target : {};
    const from = int(target.from), to = int(target.to);
    if (from === null || to === null || to < from || to > document.length) return { error: 'the target is not in the document' };
    // The target must be the document's own text at that place: the prompt
    // shows it in context, and a mismatch means the request is inconsistent.
    if (document.slice(from, to) !== str(target.text)) return { error: 'the target does not match the document' };
    if (command.kind === 'replace' && !str(target.text).trim()) return { error: 'there is no text to change' };
    if (to - from > LIMITS.target) return { error: `the selection is too long for an AI command (over ${LIMITS.target} characters)` };
    const instruction = str(r.instruction).trim();
    if (command.instruction && !instruction) return { error: 'say what to change' };
    if (instruction.length > LIMITS.instruction) return { error: `the instruction is too long (over ${LIMITS.instruction} characters)` };
    const block = r.block && typeof r.block === 'object' ? r.block : {};
    const scope = r.scope === 'code' ? 'code' : 'prose';
    if (command.scope !== 'any' && command.scope !== scope) return { error: 'this command does not apply here' };
    return {
      command,
      request: {
        scope, from, to, document, instruction: command.instruction ? instruction : '',
        target: document.slice(from, to),
        language: scope === 'code' ? (str(block.language).replace(/[^\w+#.-]/g, '').slice(0, 40) || 'text') : '',
        block: str(block.text).slice(0, LIMITS.block),
      },
    };
  }

  // A tag no document text can close: the document could contain
  // "</target>", but not a random suffix it never saw.
  function fence(name, nonce, body, attrs = '') {
    return `<${name}-${nonce}${attrs}>\n${body}\n</${name}-${nonce}>`;
  }

  /** The document, cut around [from, to) to fit `limit`, with markers where text was left out. */
  function documentWindow(document, from, to, limit) {
    if (document.length <= limit) return document;
    const room = Math.max(0, limit - (to - from));
    const start = Math.max(0, from - Math.floor(room * 0.7));
    const end = Math.min(document.length, to + (room - (from - start)));
    return (start > 0 ? `[… ${start} characters not shown …]\n` : '')
      + document.slice(start, end)
      + (end < document.length ? `\n[… ${document.length - end} characters not shown …]` : '');
  }

  /**
   * The model call for a validated request: `input` goes to the model as an
   * attached file, `prompt` as the message.
   * @param {object} command  from commandById
   * @param {object} request  from validateRequest
   * @param {{path: string, nonce: string}} opts  the document's path as the person sees it; a fresh random nonce
   */
  function buildPrompt(command, request, { path = '', nonce }) {
    if (!/^[0-9a-f]{8,}$/.test(String(nonce || ''))) throw new Error('buildPrompt needs a random hex nonce');
    const { document, from, to, scope, language, block, target, instruction } = request;
    const parts = [
      fence('document', nonce, documentWindow(document, from, to, LIMITS.document), path ? ` path="${path.replace(/"/g, '')}"` : ''),
      fence('block', nonce, block, scope === 'code' ? ` kind="code" language="${language}"` : ' kind="prose"'),
    ];
    if (command.kind === 'insert') {
      parts.push(fence('before-cursor', nonce, document.slice(Math.max(0, from - LIMITS.before), from)));
      parts.push(fence('after-cursor', nonce, document.slice(to, to + LIMITS.after)));
    } else {
      parts.push(fence('target', nonce, target));
    }
    const input = parts.join('\n\n') + '\n';
    const where = command.kind === 'insert'
      ? `The cursor is between before-cursor-${nonce} and after-cursor-${nonce}, inside block-${nonce} of document-${nonce}.`
      : `TARGET is the text in target-${nonce}; it sits inside block-${nonce} of document-${nonce}.`;
    // Replacer functions: an instruction may contain "$&" or "$1", which a
    // replacement string would expand.
    const task = command.task
      .replace(/\{language\}/g, () => language || 'text')
      .replace(/\{instruction\}/g, () => `\u201c${instruction}\u201d`);
    const prompt = [
      'You are editing part of a Markdown document for the person who wrote it. The attached file holds the document and the part to work on.',
      where,
      task,
      REPLY[command.kind],
    ].join('\n\n');
    return { input, prompt };
  }

  return { LIMITS, COMMANDS, publicCommands, commandById, validateRequest, buildPrompt, documentWindow };
});
