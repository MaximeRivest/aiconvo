'use strict';
// Tests for mdRender in app.html: lists (nesting, continuation, tasks),
// blockquotes, tables, rules. The function lives inside app.html, so we
// extract its source text and evaluate it with small stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('function mdRender');
const end = html.indexOf('function noteViewer');
assert.ok(start > 0 && end > start, 'mdRender source found in app.html');

// Stubs for the app-scope helpers mdRender uses.
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const termRegex = q => new RegExp(q.trim().split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
const fenceLang = s => (s.split(/\s+/)[0] || 'txt');
const highlightCodeLine = l => esc(l);
// eslint-disable-next-line no-eval
const mdRender = eval('(' + html.slice(start, end).replace(/^function mdRender/, 'function') + ')');

const squash = h => h.replace(/\n/g, '');

test('nested bullet lists follow indentation', () => {
  const h = squash(mdRender('- a\n  - b\n    - c\n  - d\n- e'));
  assert.strictEqual(h,
    '<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>');
});

test('numbered list nests a bullet sublist', () => {
  const h = squash(mdRender('1. one\n   - sub\n2. two'));
  assert.strictEqual(h, '<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>');
});

test('a blank line does not split a list', () => {
  const h = squash(mdRender('- a\n\n- b'));
  assert.strictEqual(h, '<ul><li>a</li><li>b</li></ul>');
});

test('a plain line after a list closes it', () => {
  const h = squash(mdRender('- a\nafter'));
  assert.strictEqual(h, '<ul><li>a</li></ul><p>after</p>');
});

test('an indented line continues the open item', () => {
  const h = squash(mdRender('- item one\n  continues here\n- two'));
  assert.strictEqual(h, '<ul><li>item one continues here</li><li>two</li></ul>');
});

test('an ordered list keeps its start number', () => {
  assert.match(mdRender('3. three\n4. four'), /<ol start="3">/);
});

test('a bullet list and a numbered list at one level stay separate', () => {
  const h = squash(mdRender('- bullet\n1. number'));
  assert.strictEqual(h, '<ul><li>bullet</li></ul><ol><li>number</li></ol>');
});

test('task items render as disabled checkboxes', () => {
  const h = mdRender('- [ ] todo\n- [x] done');
  assert.match(h, /<input type="checkbox" disabled> todo/);
  assert.match(h, /<input type="checkbox" disabled checked> done/);
});

test('a quote before a list closes cleanly', () => {
  const h = squash(mdRender('> quoted\n- item'));
  assert.strictEqual(h, '<blockquote><p>quoted</p></blockquote><ul><li>item</li></ul>');
});

test('tables, rules, and headings still work', () => {
  assert.match(mdRender('| a |\n| --- |\n| 1 |'), /<th>a<\/th>.*<td>1<\/td>/s);
  assert.match(mdRender('___'), /<hr>/);
  assert.match(mdRender('## Title'), /<h2>Title<\/h2>/);
});

test('fenced code is untouched by list logic', () => {
  const h = mdRender('```js\n- not a list\n```');
  assert.match(h, /<pre class="md-code"/);
  assert.ok(!h.includes('<li>'));
});

test('search marks apply inside list items', () => {
  assert.match(mdRender('- find me', 'find'), /<mark>find<\/mark>/);
});

test('a bare URL inside bold or code becomes a link', () => {
  const h = mdRender('Open **https://portal.azure.com/#view/Billing/Sub** now');
  assert.strictEqual(squash(h),
    '<p>Open <b><a href="https://portal.azure.com/#view/Billing/Sub" target="_blank" rel="noopener">https://portal.azure.com/#view/Billing/Sub</a></b> now</p>');
  assert.match(mdRender('run `https://localhost:7433/x`'), /<code><a href="https:\/\/localhost:7433\/x"/);
});

test('trailing punctuation and quotes stay outside the link', () => {
  assert.match(mdRender('see https://a.io/b.'), /<a href="https:\/\/a\.io\/b"[^>]*>https:\/\/a\.io\/b<\/a>\./);
  // The test stub escapes quotes; the app's esc does not. Both must link.
  assert.match(mdRender('go to "https://a.io/b", then'), /("|&quot;)<a href="https:\/\/a\.io\/b"[^>]*>https:\/\/a\.io\/b<\/a>("|&quot;), then/);
  assert.match(mdRender('(https://a.io/b)'), /\(<a href="https:\/\/a\.io\/b"[^>]*>https:\/\/a\.io\/b<\/a>\)/);
  assert.match(mdRender('https://en.wikipedia.org/wiki/Foo_(bar) ok'), /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});

test('query strings keep their ampersands and a markdown link is not re-linked', () => {
  assert.match(mdRender('https://a.io/?x=1&y=2'), /<a href="https:\/\/a\.io\/\?x=1&amp;y=2"[^>]*>https:\/\/a\.io\/\?x=1&amp;y=2<\/a>/);
  const h = mdRender('[https://a.io](https://a.io)');
  assert.strictEqual((h.match(/<a /g) || []).length, 1);
  assert.match(h, /<a href="https:\/\/a\.io"[^>]*>https:\/\/a\.io<\/a>/);
});

// relPathCandidate lives next to mdRender: same extraction trick.
const rpStart = html.indexOf('function relPathCandidate');
const rpEnd = html.indexOf('// Small markdown renderer');
// eslint-disable-next-line no-eval
const relPathCandidate = eval('(' + html.slice(rpStart, rpEnd).replace(/^function relPathCandidate/, 'function') + ')');

test('relative file mentions in code spans are candidates', () => {
  for (const ok of ['README.md', 'GUIDE.md', 'contract/spec/errors.md', 'plans/', 'src/a.py:12', 'src/a.py:12:3', './lib/x.js', 'Makefile', '.gitignore', 'src/lib'])
    assert.ok(relPathCandidate(ok), 'expected candidate: ' + ok);
  for (const no of ['plan.describe()', 'lmcc_std.install(registry=None)', 'json_object', '/abs/path.md', '~/x.md', 'a b.md', '../x.md', 'x=1', '1.2.3', 'a&amp;b.md', '<b>x</b>.md', 'Streaming'])
    assert.strictEqual(relPathCandidate(no), '', 'unexpected candidate: ' + no);
  assert.strictEqual(relPathCandidate('./lib/x.js'), 'lib/x.js');
});

test('mdRender marks path-like code spans as candidates only', () => {
  const h = mdRender('read `README.md` and `plan.describe()`');
  assert.match(h, /<code data-path-candidate="README\.md">README\.md<\/code>/);
  assert.match(h, /<code>plan\.describe\(\)<\/code>/);
  assert.ok(!h.includes('data-transcript-path'));
});
