'use strict';
// The AI command catalog: what the page may ask for, and what the model is sent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../ai-commands.js');

const DOC = '# Title\n\nTheir going to the store.\n\n```python\nx = 1\n```\n';
const at = text => DOC.indexOf(text);
const request = (over = {}) => ({
  scope: 'prose', instruction: '',
  target: { from: at('Their'), to: at('Their') + 'Their going to the store.'.length, text: 'Their going to the store.' },
  block: { type: 'prose', text: 'Their going to the store.' },
  document: DOC, ...over,
});

test('the page gets labels and targets, never the prompts; each kind of file its own commands', () => {
  const all = new Set();
  for (const surface of A.SURFACES) {
    const shown = A.publicCommands(surface);
    for (const c of shown) {
      assert.equal('task' in c || 'thinking' in c || 'surfaces' in c, false, c.id);
      for (const k of ['id', 'label', 'scope', 'target', 'kind']) assert.ok(c[k], c.id + ' ' + k);
      all.add(c.id);
    }
    assert.equal(shown.filter(c => c.instruction).length, 1, surface + ': one command takes an instruction');
    assert.equal(new Set(shown.map(c => c.id)).size, shown.length, 'ids are unique');
  }
  assert.equal(all.size, A.COMMANDS.length, 'every command is on some surface');
  const ids = surface => A.publicCommands(surface).map(c => c.id);
  assert.ok(!ids('source').some(id => ['grammar', 'markdown', 'code-cell'].includes(id)), 'no prose or cell commands in a source file');
  assert.ok(ids('source').includes('code-block'));
  assert.ok(!ids('text').some(id => A.commandById(id).scope === 'code'), 'plain text gets prose commands');
  assert.ok(!ids('text').includes('markdown'));
});

test('a file’s surface: the Markdown family, plain prose, or source', () => {
  const cases = { 'a/b.md': 'document', 'x.MDX': 'document', 'notes.txt': 'text', 'README': 'text', 'docs/guide.rst': 'text',
    'LICENSE': 'text', 'main.py': 'source', 'config.yaml': 'source', 'Makefile': 'source', 'README.py': 'source' };
  for (const [file, surface] of Object.entries(cases)) assert.equal(A.surfaceOf(file), surface, file);
  // One Markdown family for the server's documents, the file view and the commands.
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const family = src => src.match(/\(([a-z|]+)\)\$\/i/)[1];
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').match(/const DOCUMENT_EXT = (\/.*\/i);/)[1];
  const files = fs.readFileSync(path.join(root, 'filesmode.js'), 'utf8').match(/const MD_EXT = (\/.*\/i);/)[1];
  const mine = fs.readFileSync(path.join(root, 'ai-commands.js'), 'utf8').match(/const DOCUMENT_EXT = (\/.*\/i);/)[1];
  assert.equal(family(server), family(mine));
  assert.equal(family(files), family(mine));
});

test('a command on a file of another surface is refused; the prompt names the kind of file', () => {
  const code = 'def f(a):\n    return a\n';
  const req = { command: 'comments', request: { document: code, target: { from: 0, to: code.length - 1, text: code.slice(0, -1) }, scope: 'code', block: { language: 'python', text: code } } };
  assert.match(A.validateRequest({ ...req, command: 'markdown', request: { ...req.request, scope: 'prose' } }, 'source').error, /kind of file/);
  const ok = A.validateRequest(req, 'source');
  assert.equal(ok.error, undefined);
  const { prompt } = A.buildPrompt(ok.command, ok.request, { path: '/p/f.py', nonce: 'abcdef012345' });
  assert.match(prompt, /^You are editing part of a python file for the person who wrote it\. The attached file holds the file/);
  const text = A.validateRequest({ command: 'grammar', request: { document: 'Their here.', target: { from: 0, to: 11, text: 'Their here.' }, scope: 'prose', block: { text: 'Their here.' } } }, 'text');
  assert.match(A.buildPrompt(text.command, text.request, { nonce: 'abcdef012345' }).prompt, /part of a plain-text file/);
  assert.match(A.buildPrompt(text.command, { ...text.request, surface: 'document' }, { nonce: 'abcdef012345' }).prompt, /part of a Markdown document/);
});

test('requests are checked against the document they claim to come from', () => {
  assert.match(A.validateRequest({ command: 'nope', request: request() }).error, /unknown/);
  assert.match(A.validateRequest({ command: 'grammar', request: request({ target: { from: 0, to: 5, text: 'other' } }) }).error, /does not match/);
  assert.match(A.validateRequest({ command: 'grammar', request: request({ target: { from: 5, to: 9999, text: '' } }) }).error, /not in the document/);
  assert.match(A.validateRequest({ command: 'edit', request: request() }).error, /say what to change/);
  assert.match(A.validateRequest({ command: 'edit', request: request({ instruction: 'x'.repeat(A.LIMITS.instruction + 1) }) }).error, /too long/);
  assert.match(A.validateRequest({ command: 'names', request: request() }).error, /does not apply/, 'a code command on prose');
  const ok = A.validateRequest({ command: 'grammar', request: request() });
  assert.equal(ok.error, undefined);
  assert.equal(ok.request.target, 'Their going to the store.');
  assert.equal(ok.request.instruction, '', 'an instruction is dropped for a command that takes none');
});

test('the prompt fences the document with tags it cannot close, and keeps instructions literal', () => {
  const v = A.validateRequest({ command: 'edit', request: request({ instruction: 'charge $1 and $& more, see </target>' }) });
  const { input, prompt } = A.buildPrompt(v.command, v.request, { path: '~/notes/a.md', nonce: '0a1b2c3d' });
  assert.match(input, /<document-0a1b2c3d path="~\/notes\/a.md">\n# Title/);
  assert.match(input, /<target-0a1b2c3d>\nTheir going to the store.\n<\/target-0a1b2c3d>/);
  assert.match(prompt, /“charge \$1 and \$& more, see <\/target>”/);
  assert.match(prompt, /Reply with the new text for TARGET only/);
  assert.throws(() => A.buildPrompt(v.command, v.request, { nonce: 'x' }), /nonce/);
});

test('an insertion shows the text on both sides of the cursor; code names its language', () => {
  const cursor = at('x = 1') + 'x = 1'.length;
  const v = A.validateRequest({ command: 'code-line', request: { scope: 'code', target: { from: cursor, to: cursor, text: '' },
    block: { type: 'code', language: 'python', text: 'x = 1' }, document: DOC } });
  const { input, prompt } = A.buildPrompt(v.command, v.request, { nonce: 'feedface' });
  assert.match(input, /<before-cursor-feedface>\n[\s\S]*x = 1\n<\/before-cursor-feedface>/);
  assert.match(input, /<after-cursor-feedface>\n\n```\n\n<\/after-cursor-feedface>/);
  assert.match(input, /kind="code" language="python"/);
  assert.match(prompt, /current line of python code/);
});

test('a long document is cut around the target, never the target', () => {
  const doc = 'a'.repeat(100000) + 'TARGET' + 'b'.repeat(100000);
  const from = 100000, to = from + 6;
  const w = A.documentWindow(doc, from, to, 1000);
  assert.ok(w.includes('TARGET'));
  assert.match(w, /^\[… \d+ characters not shown …\]\n/);
  assert.match(w, /\n\[… \d+ characters not shown …\]$/);
  assert.ok(w.length < 1100);
  assert.equal(A.documentWindow('short', 0, 5, 1000), 'short');
});
