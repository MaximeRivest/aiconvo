// Run: node --test test/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sha256Hex, activeRecords, matchVouchLines, statusFor, trustLabelFrom } = require('../trust.js');

const P = '/tmp/f.txt';
const rec = (over = {}) => ({
  id: over.id || 'r1', ts: over.ts || '2026-08-20T10:00:00.000Z', action: over.action || 'vouch',
  path: P, range: over.range, contentSha: over.contentSha ?? sha256Hex(over.text || ''), text: over.text || '',
  note: over.note, ...over,
});

test('activeRecords drops retracted records', () => {
  const ledger = [rec({ id: 'a' }), rec({ id: 'b' }), { id: 'c', action: 'retract', ref: 'a' }];
  assert.deepStrictEqual(activeRecords(ledger).map(r => r.id), ['b']);
});

test('matchVouchLines: moved lines survive, changed lines are missing', () => {
  const m = matchVouchLines(['two', 'three'], ['one', 'TWO changed', 'intro', 'three', 'four']);
  assert.deepStrictEqual(m.matched, [4]);
  assert.strictEqual(m.missing, 1);
});

test('matchVouchLines respects order: a line moved before the previous match does not count', () => {
  const m = matchVouchLines(['b', 'a'], ['a', 'b']);
  assert.deepStrictEqual(m.matched, [2]); // 'b' matches line 2; 'a' cannot match behind it
  assert.strictEqual(m.missing, 1);
});

test('statusFor: identical content is a fresh full vouch on every line', () => {
  const text = 'one\ntwo\nthree';
  const st = statusFor([rec({ text, contentSha: sha256Hex(text) })], P, text);
  assert.strictEqual(st.records[0].state, 'fresh');
  assert.deepStrictEqual(st.lines, { 1: 'v', 2: 'v', 3: 'v' });
  assert.strictEqual(st.summary.vouched, 3);
});

test('statusFor: a changed line loses its vouch, a moved line keeps it', () => {
  const st = statusFor([rec({ range: [2, 3], text: 'two\nthree' })], P, 'one\nTWO changed\nintro\nthree\nfour');
  assert.strictEqual(st.records[0].state, 'partial');
  assert.deepStrictEqual(st.lines, { 4: 'v' });
});

test('statusFor: disputes win over vouches on the same line', () => {
  const text = 'one\ntwo';
  const st = statusFor([
    rec({ id: 'v1', text, contentSha: sha256Hex(text) }),
    rec({ id: 'd1', action: 'dispute', range: [2, 2], text: 'two' }),
  ], P, text);
  assert.deepStrictEqual(st.lines, { 1: 'v', 2: 'd' });
  assert.strictEqual(st.summary.disputed, 1);
});

test('statusFor only reads records for the asked path', () => {
  const st = statusFor([rec({ path: '/tmp/other.txt', text: 'one' })], P, 'one');
  assert.strictEqual(st.records.length, 0);
});

test('trustLabelFrom: the four label families', () => {
  const text = 'one\ntwo';
  const fresh = statusFor([rec({ text, contentSha: sha256Hex(text) })], P, text);
  assert.strictEqual(trustLabelFrom(fresh), '[vouched 2026-08-20]');

  const partial = statusFor([rec({ range: [1, 2], text: 'one\nX' })], P, text);
  assert.strictEqual(trustLabelFrom(partial), '[partly vouched 2026-08-20, changed since review]');

  const stale = statusFor([rec({ text: 'gone\nall gone' })], P, text);
  assert.strictEqual(trustLabelFrom(stale), '[vouched 2026-08-20, changed since review]');

  const disputed = statusFor([rec({ action: 'dispute', text, contentSha: sha256Hex(text) })], P, text);
  assert.strictEqual(trustLabelFrom(disputed), '[disputed 2026-08-20]');

  assert.strictEqual(trustLabelFrom(statusFor([], P, text)), '[unverified]');
});
