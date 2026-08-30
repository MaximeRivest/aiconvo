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
