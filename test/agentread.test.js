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
  assert.deepEqual(s, { since: 5, read: { a: 10 }, finished: { d: 7 }, flagged: {}, dismissed: {}, pinned: {} });
  assert.deepEqual(R.normalize(null, 42), { since: 42, read: {}, finished: {}, flagged: {}, dismissed: {}, pinned: {} });
  const marks = R.normalize({ flagged: { a: 3, b: 0 }, dismissed: { c: '9' }, pinned: { d: 4, '': 5 } }, 1);
  assert.deepEqual([marks.flagged, marks.dismissed, marks.pinned], [{ a: 3 }, { c: 9 }, { d: 4 }]);
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

test('mark unread beats the since guard and any later read lifts it', () => {
  const s = R.createState(5000);
  assert.equal(R.unreadAt(s, 'old', 1000), 0, 'older than the guard: read');
  assert.deepEqual(R.markUnread(s, 'old', { now: 6000 }), { flagged: { old: 6000 } });
  assert.equal(R.unreadAt(s, 'old', 1000), 6000, 'flagged: unread, sorted at the flag time');
  const delta = R.markRead(s, 'old', { now: 7000, mtimeMs: 1000 });
  assert.deepEqual(delta, { read: { old: 7000 }, flagged: { old: 0 } });
  assert.equal(R.unreadAt(s, 'old', 1000), 0);
  assert.equal('old' in s.flagged, false);
});

test('mark unread lands after a read stamped in the future', () => {
  const s = R.createState(1000);
  R.markRead(s, 'a', { now: 2000, mtimeMs: 9000 }); // a skewed mtime pushed the read forward
  R.markUnread(s, 'a', { now: 3000 });
  assert.equal(s.flagged.a, 9001);
  assert.equal(R.unreadAt(s, 'a', 9000), 9001);
});

test('dismiss reads and hides until newer activity arrives', () => {
  const s = R.createState(1000);
  R.markFinished(s, 'a', 3000);
  assert.equal(R.unreadAt(s, 'a', 2000), 3000);
  const delta = R.dismiss(s, 'a', { now: 4000, mtimeMs: 2000 });
  assert.deepEqual(delta, { read: { a: 4000 }, dismissed: { a: 4000 } });
  assert.equal(R.unreadAt(s, 'a', 2000), 0, 'dismissing also reads');
  assert.equal(R.isDismissed(s, 'a', 2000), true);
  assert.equal(R.isDismissed(s, 'a', 4500), false, 'a newer transcript write brings it back');
  assert.equal(R.unreadAt(s, 'a', 4500), 4500, '...as unread');
  R.markFinished(s, 'a', 4200);
  assert.equal(R.isDismissed(s, 'a', 2000), false, 'a newer finish brings it back too');
});

test('mark unread cancels a dismissal; dismissing cancels a flag', () => {
  const s = R.createState(1000);
  R.dismiss(s, 'a', { now: 2000 });
  assert.deepEqual(R.markUnread(s, 'a', { now: 3000 }), { flagged: { a: 3000 }, dismissed: { a: 0 } });
  assert.equal(R.isDismissed(s, 'a', 0), false);
  assert.equal(R.unreadAt(s, 'a', 0), 3000);
  const delta = R.dismiss(s, 'a', { now: 4000 });
  assert.deepEqual(delta, { read: { a: 4000 }, flagged: { a: 0 }, dismissed: { a: 4000 } });
  assert.equal(R.unreadAt(s, 'a', 0), 0);
  assert.equal(R.isDismissed(s, 'a', 0), true);
});

test('pins keep pin order and report no change when idle', () => {
  const s = R.createState(1000);
  assert.deepEqual(R.setPinned(s, 'a', true, 2000), { pinned: { a: 2000 } });
  assert.equal(R.setPinned(s, 'a', true, 2500), null, 'already pinned');
  R.setPinned(s, 'b', true, 3000);
  assert.deepEqual(R.pinnedKeys(s), ['b', 'a'], 'newest pin first');
  assert.deepEqual(R.setPinned(s, 'a', false), { pinned: { a: 0 } });
  assert.equal(R.setPinned(s, 'a', false), null);
  assert.deepEqual(R.pinnedKeys(s), ['b']);
});

test('applyDelta mirrors the server on a browser copy, 0 removes a mark', () => {
  const local = R.createState(1000);
  const server = R.createState(1000);
  R.applyDelta(local, R.setPinned(server, 'a', true, 2000));
  R.applyDelta(local, R.markUnread(server, 'b', { now: 2100 }));
  R.applyDelta(local, R.markFinished(server, 'c', 2200));
  assert.deepEqual(local, server);
  R.applyDelta(local, R.setPinned(server, 'a', false));
  R.applyDelta(local, R.markRead(server, 'b', { now: 2300 }));
  R.applyDelta(local, R.dismiss(server, 'c', { now: 2400 }));
  assert.deepEqual(local, server);
  assert.deepEqual(local.pinned, {});
  assert.deepEqual(local.flagged, {});
  assert.equal(local.dismissed.c, 2400);
});
