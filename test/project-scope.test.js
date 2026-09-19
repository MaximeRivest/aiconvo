'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../project-scope');

test('all, a named project, and no project are distinct scopes', () => {
  assert.equal(S.label(''), 'All projects');
  assert.equal(S.label(S.NONE), 'No project');
  assert.equal(S.contains('', 'alpha'), true);
  assert.equal(S.contains('', null), true);
  assert.equal(S.contains('alpha', 'beta'), false);
  assert.equal(S.contains('alpha', null), false);
  assert.equal(S.contains(S.NONE, null), false, 'unknown is not proof of no project');
  assert.equal(S.contains(S.NONE, S.NONE), true);
  assert.equal(S.contains('alpha', 'worktree', { worktree: 'alpha' }), true);
});

test('ordinary all-project browsing stays broad; explicit picks and Inbox adopt the destination', () => {
  assert.equal(S.afterNavigation('', 'alpha'), '');
  assert.equal(S.afterNavigation('alpha', 'beta'), 'beta');
  assert.equal(S.afterNavigation('alpha', 'alpha'), 'alpha');
  assert.equal(S.afterNavigation('', 'beta', { select: true }), 'beta');
  assert.equal(S.afterNavigation('alpha', S.NONE), S.NONE);
  assert.equal(S.afterNavigation('alpha', null), 'alpha');
});

test('file scope uses explicit attribution or longest known folder, never the last chat', () => {
  const projects = [{ name: 'alpha', cwd: '/work/a' }, { name: 'nested', cwd: '/work/a/nested' }];
  assert.equal(S.fileProject({ path: '/work/a/file.md' }, projects), 'alpha');
  assert.equal(S.fileProject({ path: '/work/a/nested/file.md' }, projects), 'nested');
  assert.equal(S.fileProject({ path: '/work/another/file.md' }, projects), S.NONE);
  assert.equal(S.fileProject({ path: '/tmp/file.md', project: 'old' }, projects, { old: 'alpha' }), 'alpha');
});
