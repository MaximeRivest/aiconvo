'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { supervisionPlan } = require('../process-supervision');
const id = '00000000-0000-0000-0000-000000000001';

test('uses a separate user scope and preserves argument boundaries', () => {
  const result = supervisionPlan('/node path/node', ['/repo path/worker.js', 'quoted " input'], { id, platform: 'linux', probe: () => true });
  assert.equal(result.kind, 'user-scope');
  assert.deepEqual(result.args.slice(-3), ['/node path/node', '/repo path/worker.js', 'quoted " input']);
  assert.equal(result.survivesServiceRestart, true);
});
test('fails closed inside a service without a user manager', () => {
  assert.throws(() => supervisionPlan('node', [], { id, platform: 'linux', cgroup: '/aiconvo.service\n', probe: () => false }), /still belong/);
});
test('standalone fallback makes no service-survival promise', () => {
  const result = supervisionPlan('node', [], { id, platform: 'linux', cgroup: '/session-1.scope\n', probe: () => false });
  assert.equal(result.survivesServiceRestart, false);
});
test('explicit detached test mode never probes or mutates systemd', () => {
  const result = supervisionPlan('node', [], { id, mode: 'detached', probe: () => assert.fail('Unexpected probe') });
  assert.equal(result.kind, 'process-group');
});
test('rejects invalid unit identity instead of interpolating it', () => {
  assert.throws(() => supervisionPlan('node', [], { id: 'a;rm -rf /' }), /valid task ID/);
});
