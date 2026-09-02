'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStallWatch } = require('../stallwatch.js');

const MIN = 60 * 1000;

// A fake clock: the watch only reads `now`, so no timer mocking is needed to
// test the rule itself.
function clock() {
  let t = 1_000_000;
  const now = () => t;
  now.tick = ms => { t += ms; };
  return now;
}

test('silence while waiting for the model is a stall after stallMs', () => {
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, now });
  w.note({ type: 'message_start' });
  now.tick(14 * MIN);
  assert.equal(w.isStalled(), false);
  now.tick(2 * MIN);
  assert.equal(w.isStalled(), true);
  assert.equal(w.legitSilence(), null);
});

test('a running tool is legitimate silence, however long it runs', () => {
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, now });
  w.note({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' });
  now.tick(3 * 60 * MIN); // a three-hour build with no output
  assert.equal(w.isStalled(), false);
  assert.equal(w.legitSilence(), 'tool');
  assert.deepEqual(w.runningTools.map(t => t.name), ['bash']);
  // The tool returns: the clock restarts from that event.
  w.note({ type: 'tool_execution_end', toolCallId: 't1' });
  assert.equal(w.runningTools.length, 0);
  now.tick(16 * MIN);
  assert.equal(w.isStalled(), true);
});

test('any event resets the silence clock', () => {
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, now });
  now.tick(10 * MIN);
  w.note({ type: 'message_update' });
  now.tick(10 * MIN);
  assert.equal(w.isStalled(), false);
});

test('parallel tools: silence stays legitimate until the last one returns', () => {
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, now });
  w.note({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash' });
  w.note({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read' });
  w.note({ type: 'tool_execution_end', toolCallId: 'b' });
  now.tick(60 * MIN);
  assert.equal(w.isStalled(), false);
  w.note({ type: 'tool_execution_end', toolCallId: 'a' });
  now.tick(60 * MIN);
  assert.equal(w.isStalled(), true);
});

test('a missed tool_execution_end cannot disable the guard: a new message flushes tools', () => {
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, now });
  w.note({ type: 'tool_execution_start', toolCallId: 'lost', toolName: 'bash' });
  w.note({ type: 'message_start' }); // the model speaks again: no tool can still run
  assert.equal(w.runningTools.length, 0);
  now.tick(16 * MIN);
  assert.equal(w.isStalled(), true);
});

test('a pending dialog is legitimate silence', () => {
  const now = clock();
  let pending = true;
  const w = createStallWatch({ stallMs: 15 * MIN, now, hasPendingUi: () => pending });
  now.tick(60 * MIN);
  assert.equal(w.legitSilence(), 'dialog');
  assert.equal(w.isStalled(), false);
  pending = false;
  assert.equal(w.isStalled(), true);
});

test('watch() rejects on a stall and stop() silences it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, checkEveryMs: 1000, now });
  let err = null;
  const p = w.watch().catch(e => { err = e; });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(err, null);
  now.tick(16 * MIN);
  t.mock.timers.tick(1000);
  await p;
  assert.match(err.message, /stalled — no pi events for 15 minutes while waiting for the model/);
  w.stop();
});

test('watch() keeps polling quietly while a tool runs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = clock();
  const w = createStallWatch({ stallMs: 15 * MIN, checkEveryMs: 1000, now });
  let err = null;
  w.watch().catch(e => { err = e; });
  w.note({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash' });
  for (let i = 0; i < 100; i++) { now.tick(MIN); t.mock.timers.tick(1000); }
  await Promise.resolve();
  assert.equal(err, null);
  w.stop();
});
