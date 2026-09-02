'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../agentread.js');

test('fresh state guards with since = now', () => {
  const s = R.createState(1000);
  assert.equal(s.since, 1000);
  assert.equal(R.unreadAt(s, 'a', 900), 0, 'activity before since is read');
  assert.equal(R.unreadAt(s, 'a', 1100), 1100, 'activity after since is unread');
});

test('normalize drops junk and keeps valid numbers', () => {
  const s = R.normalize({ since: '5', read: { a: 10, b: 'x', '': 3 }, finished: { c: -1, d: 7 } }, 99);
  assert.deepEqual(s, { since: 5, read: { a: 10 }, finished: { d: 7 } });
  assert.deepEqual(R.normalize(null, 42), { since: 42, read: {}, finished: {} });
});

test('markRead uses the server clock and clears the finish marker', () => {
  const s = R.createState(1000);
  R.markFinished(s, 'a', 5000);
  assert.equal(R.unreadAt(s, 'a', 1200), 5000);
  // A device with a clock behind the server cannot leave the reply unread.
  const delta = R.markRead(s, 'a', { now: 2000, mtimeMs: 1200 });
  assert.deepEqual(delta, { read: { a: 5000 } });
  assert.equal('a' in s.finished, false);
  assert.equal(R.unreadAt(s, 'a', 1200), 0);
});

test('markRead never moves a read backwards and reports no change when idle', () => {
  const s = R.createState(1000);
  R.markRead(s, 'a', { now: 9000 });
  assert.equal(R.markRead(s, 'a', { now: 3000 }), null);
  assert.equal(s.read.a, 9000);
});

test('a later reply after a read is unread again on every device', () => {
  const s = R.createState(1000);
  R.markRead(s, 'a', { now: 2000, mtimeMs: 1500 });
  assert.equal(R.unreadAt(s, 'a', 1500), 0);
  assert.equal(R.unreadAt(s, 'a', 2500), 2500, 'new mtime after the read');
  R.markFinished(s, 'a', 2600);
  assert.equal(R.unreadAt(s, 'a', 1500), 2600, 'a finish with no file change still counts');
});

test('markFinished keeps the newest time and reports no change otherwise', () => {
  const s = R.createState(1000);
  assert.deepEqual(R.markFinished(s, 'a', 3000), { finished: { a: 3000 } });
  assert.equal(R.markFinished(s, 'a', 2500), null);
  assert.equal(R.markFinished(s, '', 2500), null);
});

test('import keeps original read times and takes the earliest since', () => {
  const s = R.createState(5000);
  const delta = R.importState(s, { since: 3000, read: { a: 3500, b: 100 }, finished: { c: 4000 } });
  assert.deepEqual(delta, { since: 3000, read: { a: 3500, b: 100 }, finished: { c: 4000 } });
  assert.equal(s.since, 3000);
  // A read at 3500 must NOT hide a reply at 4500 (a naive "read now" would).
  assert.equal(R.unreadAt(s, 'a', 4500), 4500);
  assert.equal(R.unreadAt(s, 'a', 3400), 0);
  assert.equal(R.unreadAt(s, 'c', 0), 4000);
});

test('import from a second device merges by max and ignores covered finishes', () => {
  const s = R.createState(5000);
  R.importState(s, { since: 3000, read: { a: 3500 } });
  const delta = R.importState(s, { since: 4000, read: { a: 3000, b: 4200 }, finished: { a: 3400 } });
  assert.deepEqual(delta, { read: { b: 4200 }, finished: {} });
  assert.equal(s.since, 3000, 'later since does not raise the guard');
  assert.equal(s.read.a, 3500, 'older read does not lower the newer one');
  assert.equal('a' in s.finished, false, 'finish before the read is not activity');
  assert.equal(R.importState(s, { since: 3000, read: { a: 3500 } }), null, 'no-op import reports null');
});
