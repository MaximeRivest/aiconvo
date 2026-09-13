'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('const SOURCES = {');
const end = source.indexOf('\n};', start) + 3;
function sources(env) {
  assert.ok(start >= 0 && end > start);
  return JSON.parse(JSON.stringify(vm.runInNewContext(source.slice(start, end) + '\nSOURCES', {
    process: { env }, os: { homedir: () => '/fixture' }, path,
  })));
}
test('source overrides default to upstream paths when unset', () => {
  assert.deepEqual(sources({}), { claude: '/fixture/.claude/projects', pi: '/fixture/.pi/agent/sessions', 'pi-remote': '/fixture/.pi/remote/sessions' });
});
test('each source can be scoped without altering the real agent home', () => {
  assert.deepEqual(sources({ AICONVO_CLAUDE_PROJECTS_DIR: '/empty/claude', AICONVO_PI_SESSIONS_DIR: '/sessions/selected', AICONVO_PI_REMOTE_SESSIONS_DIR: '/empty/remote' }), {
    claude: '/empty/claude', pi: '/sessions/selected', 'pi-remote': '/empty/remote',
  });
});
