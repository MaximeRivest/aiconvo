'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutomation, revision, validate } = require('../memory-automation');
const mode = 'changes-after-enable', a = revision('a'), b = revision('b'), c = revision('c');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory-automation.json'); let now = 100;
  const load = () => createAutomation({ file, now: () => now });
  return { file, load, tick: n => { now += n; }, policy: load() };
}

test('activation baselines without inference; only observed source changes qualify, not cache rebuilds', t => {
  const { policy, tick } = setup(t);
  policy.activate(mode, { historical: a });
  assert.throws(() => policy.discard('__proto__'), /Unknown pending/);
  assert.deepEqual(policy.ready(), []);
  policy.observe('historical', a); assert.deepEqual(policy.ready(), []);
  policy.observe('historical', b); assert.deepEqual(policy.ready(10), []);
  tick(10); assert.deepEqual(policy.ready(10), ['historical']);
  const ticket = policy.claim('historical');
  policy.check(ticket, b, mode); policy.stage(ticket, 'note-and-leaf'); policy.finish(ticket);
  assert.deepEqual(policy.ready(), []);
});

test('unknown historical/imported files after restart baseline conservatively; a subsequent observed revision qualifies', t => {
  const { policy, load } = setup(t); policy.activate(mode, {});
  const restarted = load(); restarted.observe('import', a); assert.deepEqual(restarted.ready(), []);
  restarted.observe('import', b); assert.deepEqual(restarted.ready(), ['import']);
});

test('pending revisions survive restart, while in-flight work becomes interrupted and never replays', t => {
  const { policy, load } = setup(t); policy.activate(mode, { first: a, second: a });
  policy.observe('first', b); policy.observe('second', b);
  const restarted = load(); assert.equal(restarted.ready().length, 2);
  restarted.claim('first');
  const crashed = load();
  assert.deepEqual(crashed.ready(), ['second']);
  assert.equal(crashed.status(mode).pending.find(p => p.key === 'first').status, 'interrupted');
  crashed.observe('first', c); assert.deepEqual(crashed.ready(), ['second']);
  crashed.discard('first'); assert.deepEqual(crashed.ready(), ['second']);
});

test('disable/re-enable rotates consent; stale completion cannot acknowledge or publish newer pending work', t => {
  const { policy } = setup(t); policy.activate(mode, { session: a }); policy.observe('session', b);
  const old = policy.claim('session'); policy.activate('off');
  assert.equal(policy.status('off').retired[0].revision, b);
  assert.equal(policy.status('off').retired[0].status, 'interrupted');
  assert.throws(() => policy.check(old, b, 'off'), /consent/);
  policy.activate(mode, { session: b }); policy.observe('session', c);
  policy.finish(old); assert.deepEqual(policy.ready(), ['session']);
  const fresh = policy.claim('session'); assert.notEqual(fresh.epoch, old.epoch);
  assert.throws(() => policy.check(old, c, mode), /consent/);
  policy.check(fresh, c, mode);
});

test('source drift invalidates a ticket even before reindex; changes during an in-flight call remain interrupted', t => {
  const { policy } = setup(t); policy.activate(mode, { session: a }); policy.observe('session', b);
  const old = policy.claim('session'); assert.throws(() => policy.check(old, c, mode), /source revision/);
  policy.observe('session', c); policy.finish(old);
  assert.equal(policy.status(mode).pending[0].revision, c);
  assert.equal(policy.status(mode).pending[0].status, 'interrupted');
  assert.deepEqual(policy.ready(), []);
});

test('automatic work is serial; failed calls require explicit discard rather than inherited health/backfill retries', t => {
  const { policy, load } = setup(t); policy.activate(mode, { first: a, second: a });
  policy.observe('first', b); policy.observe('second', b);
  const ticket = policy.claim('first'); assert.deepEqual(policy.ready(), []);
  assert.throws(() => policy.claim('second'), /not ready/);
  policy.finish(ticket, new Error('provider effects unknown'));
  assert.deepEqual(load().ready(), ['second']);
  // A health retry key has no API to enter consent. It must be a new observed source revision.
  assert.throws(() => policy.claim('old-manual-backfill'), /not ready/);
});

test('missing, corrupt, mismatched and unwritable state fail closed; ordinary reads cannot activate consent', t => {
  const { file, policy, load } = setup(t);
  assert.equal(policy.status(mode).active, false); policy.observe('session', a); assert.deepEqual(policy.ready(), []);
  fs.writeFileSync(file, '{broken'); assert.match(load().status(mode).error, /corrupt/);
  fs.writeFileSync(file, JSON.stringify({ v: 1, mode, epoch: 'e', activatedAt: 0, baseline: {}, pending: { k: { revision: b, epoch: 'e', at: 0, status: 'running', completed: [] } } }));
  assert.match(load().status(mode).error, /corrupt/);
  assert.throws(() => validate({}), /Invalid/);
  const unwritable = createAutomation({ file, write: () => { throw new Error('disk full'); } });
  assert.throws(() => unwritable.activate(mode), /disk full/); assert.deepEqual(unwritable.ready(), []);
  policy.activate('off'); assert.match(policy.status(mode).error, /disagree/);
});

test('state disappearing during a live epoch fails closed instead of recreating consent', t => {
  const { policy, file } = setup(t); policy.activate(mode, { session: a }); policy.observe('session', b);
  const ticket = policy.claim('session'); fs.unlinkSync(file);
  assert.throws(() => policy.check(ticket, b, mode), /consent/);
  policy.observe('session', c); policy.finish(ticket, new Error('state missing'));
  assert.deepEqual(policy.ready(), []); assert.equal(fs.existsSync(file), false);
});

test('state is owner-readable, durable, and outside disposable cache roots', t => {
  const { policy, file, load } = setup(t); policy.activate(mode, { session: a }); policy.observe('session', b);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(load().ready(), ['session']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['memory-automation.json']);
});
