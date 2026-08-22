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
