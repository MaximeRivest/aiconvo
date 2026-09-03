'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileWithActivityTimeout } = require('../modelprocess.js');

function fakeExec() {
  let callback = null;
  const child = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end() {} },
    kills: [],
    kill(signal) {
      this.kills.push(signal);
      if (callback) queueMicrotask(() => callback(Object.assign(new Error('killed'), { code: null }), '', ''));
      return true;
    },
  };
  const exec = (_file, _args, _options, cb) => { callback = cb; return child; };
  exec.child = child;
  exec.finish = (error, stdout = '', stderr = '') => callback(error, stdout, stderr);
  return exec;
}

test('a silent child is stopped after the activity timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exec = fakeExec();
  const result = execFileWithActivityTimeout(exec, 'pi', [], {}, { activityTimeoutMs: 100, killGraceMs: 50 });
  t.mock.timers.tick(101);
  await assert.rejects(result, error => error.code === 'MODEL_ACTIVITY_TIMEOUT');
  assert.deepEqual(exec.child.kills, ['SIGTERM']);
});

test('stdout activity restarts the silence clock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exec = fakeExec();
  const chunks = [];
  const result = execFileWithActivityTimeout(exec, 'pi', [], {}, {
    activityTimeoutMs: 100,
    onStdout: data => chunks.push(String(data)),
  });
  t.mock.timers.tick(90);
  exec.child.stdout.emit('data', 'working');
  t.mock.timers.tick(90);
  exec.finish(null, 'done', '');
  assert.deepEqual(await result, { stdout: 'done', stderr: '' });
  assert.deepEqual(chunks, ['working']);
  assert.deepEqual(exec.child.kills, []);
});

test('stderr activity also restarts the silence clock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exec = fakeExec();
  const result = execFileWithActivityTimeout(exec, 'pi', [], {}, { activityTimeoutMs: 100 });
  t.mock.timers.tick(90);
  exec.child.stderr.emit('data', 'provider retry');
  t.mock.timers.tick(90);
  exec.finish(null, 'done', '');
  await result;
  assert.deepEqual(exec.child.kills, []);
});
