'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function load(name, context) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n}', start) + 2;
  return vm.runInNewContext('(' + source.slice(start, end) + ')', context);
}

test('image-bearing leaf freshness binds raw source, image mode and selected-model identity', () => {
  const context = { LEAF_VERSION: 2, appSettings: { memoryImages: true }, memoryFeature: { fingerprint: () => 'current' } };
  const state = load('leafStateFor', context), entry = { memoryHash: 'current', sourceRevision: 'bytes-a' };
  const leaf = { v: 2, memoryHash: 'current', sourceRevision: 'bytes-a', memoryImages: true };
  assert.equal(state(entry, leaf), 'fresh');
  assert.equal(state(entry, { ...leaf, sourceRevision: 'bytes-b' }), 'stale');
  assert.equal(state(entry, { ...leaf, memoryImages: false }), 'stale');
  context.memoryFeature.fingerprint = () => 'different-model'; assert.equal(state(entry, leaf), 'stale');
  context.appSettings.memoryImages = false; assert.equal(state(entry, leaf), 'stale');
});

test('a mode/cache re-index is not a legacy historical-inference trigger; image-byte changes still invalidate', () => {
  const dirty = new Map(), context = { leafDirty: dirty, memoryFeature: { legacyAllowed: () => true }, Date };
  const mark = load('markLeafDirty', context);
  const previous = { memoryHash: 'text-hash', memoryImages: false, mtimeMs: 10, size: 100, realUserCount: 1 };
  const images = { ...previous, memoryHash: 'image-hash', memoryImages: true, sourceRevision: 'a' };
  mark('session', previous, images, 10); assert.equal(dirty.size, 0);
  mark('session', images, { ...images, memoryHash: 'model-mode-hash' }, 10); assert.equal(dirty.size, 0);
  mark('session', images, { ...images, sourceRevision: 'b', memoryHash: 'new-image-hash' }, 10); assert.equal(dirty.size, 1);
  dirty.clear(); context.memoryFeature.legacyAllowed = () => false;
  mark('session', images, { ...images, sourceRevision: 'c', memoryHash: 'third' }, 10); assert.equal(dirty.size, 0);
});

test('deterministic title-off note paths distinguish same-date, same-title sessions', () => {
  const noteFile = load('noteFileFor', { path, crypto, NOTES_DIR: '/fixture/notes', appSettings: { aiTitles: false }, memoryFeature: { enabled: () => false } });
  const a = { key: 'pi:a.jsonl', firstTs: '2026-09-01T00:00:00Z', title: 'Same title' };
  const b = { ...a, key: 'pi:b.jsonl' };
  assert.notEqual(noteFile(a, a.title), noteFile(b, b.title));
  assert.equal(noteFile(a, a.title), noteFile(a, a.title));
});
