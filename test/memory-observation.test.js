'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMemoryFeature } = require('../memory-feature');
const { observation } = require('../memory-observation');
const { sourceSnapshot } = require('../memory-images');
const { watchTree } = require('../source-watcher');
const { normalizeSettings } = require('../settings');
const fixture = require('./fixtures/memory-fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } assert.fail('observation did not arrive'); }
test('live creation + origin qualifies one-shot; imports, missing/future origins and restart discovery baseline; old-session changes qualify', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observations-'));
  const sourceFile = key => path.join(root, key + '.jsonl'); let watcher;
  t.after(() => { watcher?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function write(key, timestamp) { const rows = fixture.transcript(); rows[0].timestamp = timestamp; fs.writeFileSync(sourceFile(key), fixture.jsonl(rows)); }
  write('old', '2020-01-01T00:00:00Z');
  let settings = normalizeSettings({ provider: 'fixture', model: 'vision', memoryImages: true, automaticMemory: 'off', contextTokens: 128000 });
  const published = [], events = [], errors = [];
  const hooks = { stateFile: path.join(root, 'consent.json'), settings: () => settings, context: new AsyncLocalStorage(), sourceFile,
    async *sources() { yield { key: 'old', file: sourceFile('old') }; }, parseFile: fixture.parser(), projectOf: () => 'fixture',
    data: async key => ({ key, title: key }), canRun: () => true, reserve() {}, documents: async () => {},
    publish: async (key, _data, built) => { built.guard(); published.push(key); }, error: (_key, e) => errors.push(e),
    runInternalModel: async () => ({ content: [{ type: 'text', text: '{"note":"Synthetic.","abstract":"Synthetic.","intent":[],"environment":[],"problems":[]}' }] }) };
  let feature = createMemoryFeature(hooks);
  await feature.configure({ ...settings, automaticMemory: 'changes-after-enable' }); settings.automaticMemory = 'changes-after-enable';
  function start() { watcher = watchTree(root, (rel, event) => {
    const key = rel.slice(0, -6); events.push(key);
    feature.created(key, event); feature.observe(key, sourceSnapshot(sourceFile(key)).revision);
  }, rel => rel.endsWith('.jsonl')); }
  start(); await until(() => events.includes('old')); await sleep(20);
  write('new', new Date().toISOString()); await until(() => feature.status().pending.some(p => p.key === 'new'));
  assert.equal(feature.status().pending.find(p => p.key === 'new').provenance.kind, 'live-new');
  await feature.sweep(0); assert.deepEqual(published, ['new']);
  write('imported', '2020-01-01T00:00:00Z'); write('missing'); write('future', new Date(Date.now() + 60000).toISOString());
  await until(() => feature.status().baselineCount === 5);
  assert.equal(feature.status().pending.length, 0);
  watcher.close(); write('offline', new Date().toISOString());
  feature = createMemoryFeature(hooks); start(); await until(() => feature.status().baselineCount === 6);
  assert.equal(feature.status().pending.length, 0);
  fs.appendFileSync(sourceFile('old'), '\n'); await until(() => feature.status().pending.some(p => p.key === 'old'));
  await feature.sweep(0); assert.deepEqual(published, ['new', 'old']); assert.deepEqual(errors, []);
  const persisted = JSON.parse(fs.readFileSync(hooks.stateFile));
  assert.equal(persisted.observations.new.kind, 'live-new'); assert.equal(persisted.observations.offline.kind, 'baseline-discovery');
});
test('creation evidence fails closed for clock anomalies, inode replacement and missing source timestamps', () => {
  const snapshot = { text: '{"type":"session","timestamp":"1970-01-01T00:00:00.120Z"}', stat: { birthtimeMs: 110, dev: 1, ino: 2 } };
  const event = { kind: 'watch-create', epoch: 'e', observedAt: 115, birthtimeMs: 110, dev: 1, ino: 2 };
  assert.equal(observation(snapshot, event, 'e', 100, 130).kind, 'live-new');
  for (const changed of [{ ...event, observedAt: 200 }, { ...event, epoch: 'old' }, { ...event, ino: 3 }, undefined]) {
    assert.equal(observation(snapshot, changed, 'e', 100, 130).kind, 'baseline-discovery');
  }
  assert.equal(observation(snapshot, event, 'e', 100, 119).kind, 'baseline-discovery');
  assert.equal(observation({ ...snapshot, text: '{"type":"session"}' }, event, 'e', 100, 130).kind, 'baseline-discovery');
});
