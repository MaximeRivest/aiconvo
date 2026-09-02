'use strict';
// Tests for unwrapHardLines in app.html: it joins hard-wrapped prose
// lines (AI agents wrap at ~80 columns) back into paragraphs, and it
// must never touch structure: front matter, fences, tables, headings,
// lists starts, quotes, hard breaks, reference definitions.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('function unwrapHardLines');
const end = html.indexOf('async function openDocument');
assert.ok(start > 0 && end > start, 'unwrapHardLines source found in app.html');
// The slice may end with a line comment that belongs to the next function;
// a newline before the closing paren keeps that comment from eating it.
// eslint-disable-next-line no-eval
const unwrapHardLines = eval('(' + html.slice(start, end).trim() + '\n)');

test('joins a hard-wrapped paragraph into one line', () => {
  const out = unwrapHardLines('This is a paragraph that an agent\nwrapped at eighty columns for no\ngood display reason.');
  assert.strictEqual(out.text, 'This is a paragraph that an agent wrapped at eighty columns for no good display reason.');
  assert.strictEqual(out.joins, 2);
});

test('keeps separate paragraphs separate', () => {
  const out = unwrapHardLines('first paragraph\nstill first\n\nsecond paragraph');
  assert.strictEqual(out.text, 'first paragraph still first\n\nsecond paragraph');
});

test('joins wrapped list item continuations, keeps item starts', () => {
  const out = unwrapHardLines('- item one that\n  wraps onto a second line\n- item two');
  assert.strictEqual(out.text, '- item one that wraps onto a second line\n- item two');
});

test('never touches fenced code', () => {
  const src = 'intro line\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\noutro';
  assert.strictEqual(unwrapHardLines(src).text, src);
});

test('never touches front matter', () => {
  const src = '---\ntitle: x\ndate: y\n---\nbody text that\nwraps';
  assert.strictEqual(unwrapHardLines(src).text, '---\ntitle: x\ndate: y\n---\nbody text that wraps');
});

test('keeps tables, headings, quotes, and rules intact', () => {
  const src = '# title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quoted\n> more\n\n---\ndone';
  assert.strictEqual(unwrapHardLines(src).text, src);
});

test('keeps a pipeless table delimiter row out of the header line', () => {
  const src = 'a | b\n--- | ---\n1 | 2';
  assert.strictEqual(unwrapHardLines(src).text, src);
});

test('respects hard line breaks (two spaces and backslash)', () => {
  const src = 'line with break  \nnext line\nand more';
  assert.strictEqual(unwrapHardLines(src).text, 'line with break  \nnext line and more');
  const src2 = 'line with break\\\nnext line';
  assert.strictEqual(unwrapHardLines(src2).text, src2);
});

test('keeps setext headings', () => {
  const src = 'My Heading\n===\nbody that\nwraps';
  assert.strictEqual(unwrapHardLines(src).text, 'My Heading\n===\nbody that wraps');
});

test('does not absorb a following list, heading, or reference definition', () => {
  const src = 'prose line\n- a list starts\n\nmore prose\n# heading\n\ntext\n[ref]: https://example.com';
  assert.strictEqual(unwrapHardLines(src).text, src);
});

test('leaves indented code alone', () => {
  const src = 'para\n\n    indented code\n    second code line\n\nafter';
  assert.strictEqual(unwrapHardLines(src).text, src);
});

test('reports zero joins on an already-clean document', () => {
  assert.strictEqual(unwrapHardLines('one paragraph on one line\n\nanother one').joins, 0);
});
