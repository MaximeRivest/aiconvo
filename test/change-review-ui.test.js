'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const LineDiff = require('../linediff');
function client() {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const context = vm.createContext({ LineDiff, esc, fgAttr: esc });
  vm.runInContext(fs.readFileSync(require.resolve('../change-review-ui'), 'utf8'), context);
  return context;
}
test('replacement lines are paired, with real line numbers on each side', () => {
  const c = client();
  const rows = c.crDiffRows({ text: 'a\nbefore 1\nbefore 2\nz' }, { text: 'a\nafter 1\nafter 2\nz' });
  assert.deepEqual(Array.from(rows, r => [r.old?.line, r.next?.line, r.same]), [[1, 1, true], [2, 2, false], [3, 3, false], [4, 4, true]]);
  const html = c.crDiff({ text: 'old' }, { text: 'new' });
  assert.equal((html.match(/class="cr-diff-row/g) || []).length, 1);
  assert.ok(html.includes('data-cr-anchor="old:1"'));
  assert.ok(html.includes('data-cr-anchor="next:1"'));
});
test('unrelated context is collapsed, but comments keep their exact lines visible', () => {
  const c = client();
  const old = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`), next = old.slice();
  next[79] = 'changed';
  const plain = c.crDiff({ text: old.join('\n') }, { text: next.join('\n') });
  assert.ok(!plain.includes('data-cr-anchor="next:20"'));
  assert.ok(plain.includes('Show 76 unchanged lines'));
  const anchored = c.crDiff({ text: old.join('\n') }, { text: next.join('\n') }, { anchors: new Set(['next:20', 'old:25']) });
  assert.ok(anchored.includes('data-cr-anchor="next:20"'));
  assert.ok(anchored.includes('data-cr-anchor="old:25"'));
  const expanded = c.crDiff({ text: old.join('\n') }, { text: next.join('\n') }, { expanded: [[0, 75]] });
  assert.ok(expanded.includes('data-cr-anchor="next:20"'));
});
test('comments anchor only to their recorded content and exact quoted range', () => {
  const c = client();
  const data = { base: 'a', head: 'b', old: { text: 'old', oid: 'old-blob' }, next: { text: 'one\ntwo\nthree', oid: 'new-blob' } };
  const comment = { line: 2, end: 3, side: 'next', blob: 'new-blob', quote: 'two\nthree' };
  assert.equal(c.crCanAnchor(comment, data), true);
  assert.equal(c.crCanAnchor({ ...comment, line: 1, end: 1, side: 'old', blob: 'old-blob', quote: 'old' }, data), true);
  assert.equal(c.crCanAnchor({ ...comment, blob: 'different-version' }, data), false);
  assert.equal(c.crCanAnchor({ ...comment, quote: 'other code' }, data), false);
  assert.equal(c.crCanAnchor({ ...comment, end: 4 }, data), false);
  assert.equal(c.crCanAnchor(comment, { ...data, next: { ...data.next, unavailable: 'not captured' } }), false);
  assert.equal(c.crCanAnchor({ ...comment, blob: undefined, base: 'a', head: 'b' }, data), true);
  assert.equal(c.crCanAnchor({ ...comment, blob: undefined, base: 'other', head: 'b' }, data), false);
});
test('unified unchanged context retains both real line numbers after insertions', () => {
  const c = client();
  const html = c.crDiff({ text: 'one\ntwo' }, { text: 'inserted\none\ntwo' });
  assert.match(html, /class="cr-line cr-unified-next" data-cr-line="2" data-cr-side="next"/);
  assert.ok(html.includes('data-cr-anchor="old:1"'));
  assert.ok(html.includes('data-cr-anchor="next:2"'));
});
test('absent files have no fictitious line; source code is escaped', () => {
  const c = client();
  const html = c.crDiff({ text: '', absent: true }, { text: '<script>alert(1)</script>' });
  assert.ok(!html.includes('data-cr-anchor="old:1"'));
  assert.ok(html.includes('data-cr-anchor="next:1"'));
  assert.ok(!html.includes('<script>'));
});
test('inline comments omit duplicate code quotes, while fallback contexts retain them', () => {
  const c = client(), comment = { id: 'c', path: 'file', side: 'next', line: 3, end: 3, quote: 'source code', text: 'Please change this' };
  assert.ok(!c.crCommentHTML(comment, { inline: true }).includes('source code'));
  assert.ok(c.crCommentHTML(comment, { otherVersion: true }).includes('source code'));
  assert.ok(c.crCommentHTML(comment, { otherVersion: true }).includes('Open context'));
  assert.ok(c.crCommentHTML({ ...comment, resolved: true }, { inline: true }).startsWith('<details'));
});
