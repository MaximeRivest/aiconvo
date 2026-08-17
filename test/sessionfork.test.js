// Run: node --test test/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { chainIds, claudeForkContent } = require('../sessionfork.js');

function line(obj) { return JSON.stringify(obj); }

// A small Claude-style tree:
//   a ── b ── c        (main path)
//        └── d ── e    (sibling branch under b)
const CLAUDE = [
  line({ uuid: 'a', parentUuid: null, sessionId: 'old', type: 'user', message: { content: 'root' } }),
  line({ uuid: 'b', parentUuid: 'a', sessionId: 'old', type: 'assistant', message: { content: 'reply' } }),
  line({ uuid: 'c', parentUuid: 'b', sessionId: 'old', type: 'user', message: { content: 'main' } }),
  'not json at all',
  line({ uuid: 'd', parentUuid: 'b', sessionId: 'old', type: 'user', message: { content: 'branch' } }),
  line({ uuid: 'e', parentUuid: 'd', sessionId: 'old', type: 'assistant', message: { content: 'leaf' } }),
].join('\n') + '\n';

test('chainIds keeps only the root→node path', () => {
  const parsed = CLAUDE.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } });
  assert.deepStrictEqual([...chainIds(parsed, 'c', 'uuid', 'parentUuid')].sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual([...chainIds(parsed, 'e', 'uuid', 'parentUuid')].sort(), ['a', 'b', 'd', 'e']);
});

test('chainIds throws when the node is missing', () => {
  const parsed = [{ uuid: 'a', parentUuid: null }];
  assert.throws(() => chainIds(parsed, 'zz', 'uuid', 'parentUuid'), /not found/);
});

test('claudeForkContent rewrites sessionId on every kept line', () => {
  const content = claudeForkContent(CLAUDE, 'e', 'new-id');
  const rows = content.trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map(r => r.uuid), ['a', 'b', 'd', 'e']);
  for (const r of rows) assert.strictEqual(r.sessionId, 'new-id');
});

test('claudeForkContent excludes the sibling branch', () => {
  const content = claudeForkContent(CLAUDE, 'c', 'new-id');
  const ids = content.trim().split('\n').map(l => JSON.parse(l).uuid);
  assert.deepStrictEqual(ids, ['a', 'b', 'c']);
  assert.ok(!content.includes('"d"') && !content.includes('"e"'));
});

test('claudeForkContent skips unparseable lines and ends with a newline', () => {
  const content = claudeForkContent(CLAUDE, 'a', 'x');
  assert.ok(content.endsWith('\n'));
  assert.strictEqual(content.trim().split('\n').length, 1);
});

test('claudeForkContent throws for an unknown node', () => {
  assert.throws(() => claudeForkContent(CLAUDE, 'nope', 'x'), /not found/);
});

test('mid-node fork keeps the node itself ("through", not "before")', () => {
  const content = claudeForkContent(CLAUDE, 'b', 'x');
  const ids = content.trim().split('\n').map(l => JSON.parse(l).uuid);
  assert.deepStrictEqual(ids, ['a', 'b']);
});
