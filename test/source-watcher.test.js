'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchTree } = require('../source-watcher');
test('watcher separates startup discovery, deletion, live creation and ordinary changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-provenance-')), file = path.join(root, 'source.jsonl'), events = [];
  fs.writeFileSync(file, 'initial');
  const watcher = watchTree(root, (rel, event) => events.push({ rel, ...event }), rel => rel.endsWith('.jsonl'));
  t.after(() => { watcher.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function seen(kind) { for (let i = 0; i < 100; i++) { if (events.some(e => e.kind === kind)) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('missing ' + kind); }
  await seen('discovery'); assert.equal(events.some(e => e.kind === 'watch-create'), false);
  fs.unlinkSync(file); await seen('deletion'); fs.writeFileSync(file, 'new'); await seen('watch-create');
  const created = events.find(e => e.kind === 'watch-create'); assert.equal(created.ino, fs.statSync(file).ino);
  const count = events.filter(e => e.kind === 'watch-create').length;
  fs.appendFileSync(file, ' changed'); await new Promise(r => setTimeout(r, 30));
  assert.equal(events.filter(e => e.kind === 'watch-create').length, count);
});
