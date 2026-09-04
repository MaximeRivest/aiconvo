'use strict';
// Tests for areas.js: rel normalization, root/rel resolution, membership.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeAreaRel, projectRootOfCwd, relOfCwd, deepestAreaOf, relInArea, areaSlug,
} = require('../areas.js');

test('normalizeAreaRel: cleans, joins, and rejects escapes', () => {
  assert.strictEqual(normalizeAreaRel('experiments/vector-search'), 'experiments/vector-search');
  assert.strictEqual(normalizeAreaRel(' experiments / vector-search '), 'experiments/vector-search');
  assert.strictEqual(normalizeAreaRel('experiments\\win\\path'), 'experiments/win/path');
  assert.strictEqual(normalizeAreaRel('a//b/'), 'a/b');
  assert.strictEqual(normalizeAreaRel('../escape'), '');
  assert.strictEqual(normalizeAreaRel('a/../b'), '');
  assert.strictEqual(normalizeAreaRel('/abs'), 'abs');
  assert.strictEqual(normalizeAreaRel(''), '');
  assert.strictEqual(normalizeAreaRel('.hidden'), '');
});

test('projectRootOfCwd: /Projects/<name> wins; other dirs are their own root', () => {
  assert.strictEqual(projectRootOfCwd('/home/u/Projects/foo/sub/x'), '/home/u/Projects/foo');
  assert.strictEqual(projectRootOfCwd('/home/u/Projects/foo'), '/home/u/Projects/foo');
  assert.strictEqual(projectRootOfCwd('/home/u/work/thing'), '/home/u/work/thing');
  assert.strictEqual(projectRootOfCwd('/home/u'), null); // loose
  assert.strictEqual(projectRootOfCwd('/tmp/x'), null); // loose
  // Case-insensitive and first-match, the same rule as rawProjectOf.
  assert.strictEqual(projectRootOfCwd('/home/u/projects/foo/sub'), '/home/u/projects/foo');
  assert.strictEqual(projectRootOfCwd('/home/u/Projects/foo/Projects/bar'), '/home/u/Projects/foo');
});

test('relOfCwd: rel path under the root, empty at the root', () => {
  assert.strictEqual(relOfCwd('/home/u/Projects/foo/sub/x'), 'sub/x');
  assert.strictEqual(relOfCwd('/home/u/Projects/foo'), '');
  assert.strictEqual(relOfCwd('/home/u/Projects/foo/'), '');
  assert.strictEqual(relOfCwd('/home/u/work/thing'), '');
  assert.strictEqual(relOfCwd('/home/u'), '');
});

test('deepestAreaOf: deepest declared prefix wins, inclusive membership', () => {
  const declared = ['experiments', 'experiments/vector-search', 'docs'];
  assert.strictEqual(deepestAreaOf('experiments/vector-search/run1', declared), 'experiments/vector-search');
  assert.strictEqual(deepestAreaOf('experiments/other', declared), 'experiments');
  assert.strictEqual(deepestAreaOf('experiments', declared), 'experiments');
  assert.strictEqual(deepestAreaOf('src/lib', declared), null);
  assert.strictEqual(deepestAreaOf('', declared), null);
  assert.strictEqual(deepestAreaOf('docsx', declared), null); // no partial-segment match
});

test('relInArea: inclusive prefix on whole segments', () => {
  assert.strictEqual(relInArea('experiments', 'experiments'), true);
  assert.strictEqual(relInArea('experiments/x', 'experiments'), true);
  assert.strictEqual(relInArea('experimentsx', 'experiments'), false);
  assert.strictEqual(relInArea('', 'experiments'), false);
});

test('areaSlug: filesystem safe', () => {
  assert.strictEqual(areaSlug('experiments/vector-search'), 'experiments-vector-search');
  assert.strictEqual(areaSlug('A B/C'), 'a-b-c');
  assert.strictEqual(areaSlug(''), 'area');
});

test('folderRows: joins the walk with conversation folders, inclusive counts, nesting', () => {
  const { folderRows } = require('../areas.js');
  const found = new Map([
    ['cattle', { exists: true, git: false }],
    ['cattle/feed', { exists: true, git: false }],
    ['docs', { exists: true, git: true }],
  ]);
  const own = new Map([
    ['cattle', { n: 3, lastMs: 1000 }],
    ['cattle/feed', { n: 2, lastMs: 5000 }],
    ['deep/a/b/c', { n: 1, lastMs: 2000 }], // beyond the walk, folder gone
  ]);
  const declared = { docs: { title: 'Docs' }, 'cattle/feed': {} };
  const rows = folderRows({ found, own, declared, exists: rel => rel === 'deep' });
  const by = Object.fromEntries(rows.map(r => [r.rel, r]));
  // inclusive count: cattle counts its own 3 plus feed's 2; lastTs is the max
  assert.strictEqual(by.cattle.conversations, 5);
  assert.strictEqual(by.cattle.own, 3);
  assert.strictEqual(by.cattle.lastTs, new Date(5000).toISOString());
  assert.strictEqual(by.cattle.declared, false);
  assert.strictEqual(by.cattle.inside, null);
  // a declared folder knows it; a folder under it knows which area it is in
  assert.strictEqual(by['cattle/feed'].declared, true);
  assert.strictEqual(by['cattle/feed'].inside, null); // self excluded
  assert.strictEqual(by.docs.title, 'Docs');
  assert.strictEqual(by.docs.git, true);
  // conversation-only folders appear with their ancestors; existence comes from the callback
  assert.deepStrictEqual(rows.filter(r => r.rel.startsWith('deep')).map(r => r.rel), ['deep', 'deep/a', 'deep/a/b', 'deep/a/b/c']);
  assert.strictEqual(by.deep.exists, true);
  assert.strictEqual(by['deep/a/b/c'].exists, false);
  assert.strictEqual(by.deep.conversations, 1);
  assert.strictEqual(by['deep/a/b/c'].depth, 4);
  // sorted by path
  assert.deepStrictEqual(rows.map(r => r.rel), [...rows.map(r => r.rel)].sort((a, b) => a.localeCompare(b)));
});

test('folderRows: a subfolder of a declared area reports inside', () => {
  const { folderRows } = require('../areas.js');
  const found = new Map([['exp', {}], ['exp/vs', {}], ['exp/vs/run1', {}]]);
  const rows = folderRows({ found, own: new Map(), declared: { exp: {}, 'exp/vs': {} } });
  const by = Object.fromEntries(rows.map(r => [r.rel, r]));
  assert.strictEqual(by['exp/vs'].inside, 'exp');
  assert.strictEqual(by['exp/vs/run1'].inside, 'exp/vs');
  assert.strictEqual(by['exp/vs/run1'].conversations, 0);
  assert.strictEqual(by['exp/vs/run1'].lastTs, null);
});
