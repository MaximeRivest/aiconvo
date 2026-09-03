'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelHealth } = require('../modelhealth.js');

function clock() {
  let time = 1_000_000;
  const now = () => time;
  now.tick = ms => { time += ms; };
  return now;
}

const MIN = 60 * 1000;

test('three failed calls open the circuit and pause automatic work', () => {
  const now = clock();
  const health = createModelHealth({ now, failureThreshold: 3, baseCooldownMs: 10 * MIN, maxCooldownMs: 30 * MIN });
  for (let i = 0; i < 3; i++) {
    const permit = health.begin({ automatic: true });
    health.failure(permit, new Error('provider unavailable'));
  }
  const state = health.snapshot();
  assert.equal(state.mode, 'open');
  assert.equal(state.consecutiveFailures, 3);
  assert.equal(state.openUntil, now() + 10 * MIN);
  assert.throws(() => health.begin({ automatic: true }), error => error.code === 'MODEL_CALLS_PAUSED' && error.retryAt === state.openUntil);
});

test('only one manual probe can run during an open pause', () => {
  const now = clock();
  const health = createModelHealth({ now, failureThreshold: 1, baseCooldownMs: 10 * MIN, maxCooldownMs: 30 * MIN });
  health.failure(health.begin(), new Error('down'));
  const probe = health.begin({ automatic: false });
  assert.equal(probe.probe, true);
  health.failure(probe, new Error('still down'));
  assert.equal(health.snapshot().openUntil, now() + 20 * MIN);
  assert.throws(() => health.begin({ automatic: false }), error => error.code === 'MODEL_CALLS_PAUSED');
});

test('one half-open probe runs after cooldown and success closes the circuit', () => {
  const now = clock();
  const health = createModelHealth({ now, failureThreshold: 1, baseCooldownMs: 10 * MIN });
  health.failure(health.begin(), new Error('down'));
  now.tick(10 * MIN);
  const probe = health.begin({ automatic: true });
  assert.equal(probe.probe, true);
  assert.throws(() => health.begin({ automatic: true }), error => error.code === 'MODEL_CALLS_PAUSED');
  health.success(probe);
  assert.equal(health.snapshot().mode, 'closed');
  assert.doesNotThrow(() => health.begin({ automatic: true }));
});

test('leaf retries use durable 10, 20, then 30 minute backoff', () => {
  const now = clock();
  const health = createModelHealth({ now, baseCooldownMs: 10 * MIN, maxCooldownMs: 30 * MIN });
  let retry = health.leafFailure('leaf', new Error('one'));
  assert.equal(retry.nextRetryAt, now() + 10 * MIN);
  assert.equal(health.canRunLeaf('leaf'), false);
  now.tick(10 * MIN);
  assert.deepEqual(health.dueLeafKeys(), ['leaf']);
  retry = health.leafFailure('leaf', new Error('two'));
  assert.equal(retry.nextRetryAt, now() + 20 * MIN);
  now.tick(20 * MIN);
  retry = health.leafFailure('leaf', new Error('three'));
  assert.equal(retry.nextRetryAt, now() + 30 * MIN);
  now.tick(30 * MIN);
  retry = health.leafFailure('leaf', new Error('four'));
  assert.equal(retry.nextRetryAt, now() + 30 * MIN);
  health.leafSuccess('leaf');
  assert.equal(health.snapshot().leafRetries.leaf, undefined);
});

test('saved circuit and retry state survives recreation', () => {
  const now = clock();
  const first = createModelHealth({ now, failureThreshold: 1, baseCooldownMs: 10 * MIN });
  first.setIdentity('provider/old');
  first.failure(first.begin(), new Error('down'));
  first.leafFailure('a', new Error('leaf down'));
  const second = createModelHealth({ now, initialState: first.snapshot() });
  assert.equal(second.setIdentity('provider/old'), false);
  assert.equal(second.snapshot().mode, 'open');
  assert.equal(second.canRunLeaf('a'), false);
  assert.throws(() => second.begin({ automatic: true }), error => error.code === 'MODEL_CALLS_PAUSED');
});

test('changing the selected model clears the old model pause and leaf delays', () => {
  const now = clock();
  const health = createModelHealth({ now, failureThreshold: 1, baseCooldownMs: 10 * MIN });
  health.setIdentity('provider/old');
  health.failure(health.begin(), new Error('down'));
  health.leafFailure('leaf', new Error('down'));
  assert.equal(health.setIdentity('provider/new'), true);
  assert.equal(health.snapshot().mode, 'closed');
  assert.equal(health.snapshot().identity, 'provider/new');
  assert.equal(health.canRunLeaf('leaf'), true);
  assert.doesNotThrow(() => health.begin({ automatic: true }));
});
