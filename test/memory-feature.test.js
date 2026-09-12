'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMemoryFeature } = require('../memory-feature');
const { normalizeSettings } = require('../settings');
const { revision } = require('../memory-automation');
const fixture = require('./fixtures/memory-fixture.cjs');
const delay = () => new Promise(resolve => setTimeout(resolve, 1));
async function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'source.jsonl'), stateFile = path.join(root, 'consent.json');
  fs.writeFileSync(file, fixture.jsonl(fixture.transcript()));
  let settings = normalizeSettings({ automaticMemory: 'off', provider: 'fixture', model: 'vision', memoryImages: true, aiTitles: false, contextTokens: 128000 });
  const calls = [], published = [], errors = [], reserved = new Set(); let feature;
  const hooks = {
    stateFile, settings: () => settings, context: new AsyncLocalStorage(), parseFile: fixture.parser(),
    sourceFile: () => file, projectOf: () => 'fixture',
    async *sources() { yield { key: 'session', file }; },
    data: async key => ({ key, title: 'Existing title' }), canRun: key => !reserved.has(key),
    reserve: (key, yes) => yes ? reserved.add(key) : reserved.delete(key),
    publish: async (_key, _data, built) => { built.guard(); feature.check(); published.push(built); },
    documents: async () => {}, error: (_key, e) => errors.push(e),
    runInternalModel: async (input, _prompt, options) => {
      options.check(); calls.push(structuredClone(input)); await delay(); options.check();
      return { content: [{ type: 'text', text: JSON.stringify({ note: 'Fixture note.', abstract: 'Fixture abstract.', intent: [], environment: [], problems: [] }) }] };
    },
    ...overrides,
  };
  feature = createMemoryFeature(hooks);
  const configure = async mode => { const next = { ...settings, automaticMemory: mode }; await feature.configure(next); settings = next; };
  const observeChange = () => { fs.appendFileSync(file, '\n'); feature.observe('session', revision(fs.readFileSync(file))); };
  return { file, stateFile, feature, hooks, calls, published, errors, configure, observeChange, settings: () => settings };
}

test('one eligible revision produces both visible notes and memory without consulting historical health retries', async t => {
  const f = await setup(t);
  await f.configure('changes-after-enable'); assert.equal(f.calls.length, 0);
  await f.feature.sweep(0); assert.equal(f.calls.length, 0);
  f.observeChange(); await f.feature.sweep(0);
  assert.equal(f.published.length, 1); assert.match(f.published[0].note, /^# Existing title/);
  assert.equal(f.published[0].leaf.imageCount, 4); assert.equal(f.calls.flatMap(c => c.images).length, 4);
  assert.deepEqual(f.errors, []);
  await f.feature.sweep(0); assert.equal(f.published.length, 1);
  const disk = JSON.parse(fs.readFileSync(f.stateFile));
  assert.deepEqual(disk.pending.session.completed, ['note-and-leaf', 'documents']);
  assert.equal(disk.pending.session.status, 'done');
});

test('activation races serialize configuration and never infer while baselining', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { async *sources() { await pending; yield { key: 'session', file: f.file }; } });
  const activation = f.configure('changes-after-enable');
  await assert.rejects(f.configure('legacy'), /already in progress/);
  await f.feature.sweep(0); assert.equal(f.calls.length, 0);
  release(); await activation; await f.feature.sweep(0); assert.equal(f.calls.length, 0);
});

test('disable/re-enable while a provider call is outstanding prevents stale publication and leaves the new baseline unacknowledged', async t => {
  let release, began; const started = new Promise(resolve => { began = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { runInternalModel: async () => { began(); await response;
    return { content: [{ type: 'text', text: '{"note":"old","abstract":"old","intent":[],"environment":[],"problems":[]}' }] };
  } });
  await f.configure('changes-after-enable'); f.observeChange();
  const work = f.feature.sweep(0); await started;
  const oldEpoch = f.feature.status().epoch;
  await f.configure('off'); await f.configure('changes-after-enable');
  assert.notEqual(f.feature.status().epoch, oldEpoch);
  release(); await work;
  assert.equal(f.published.length, 0); assert.equal(f.errors.length, 1);
  assert.equal(f.feature.status().pending.length, 0);
});

test('document lane subcalls and concurrent sweeps are serial and guarded', async t => {
  let active = 0, maximum = 0; const observed = [];
  const f = await setup(t, { runInternalModel: async (input, _prompt, options) => {
    options.check(); active++; maximum = Math.max(maximum, active); observed.push(input.text);
    await delay(); active--; options.check();
    return { content: [{ type: 'text', text: '{"note":"note","abstract":"abstract","intent":[],"environment":[],"problems":[]}' }] };
  }, documents: async () => { await Promise.all([1, 2, 3].map(n => f.feature.model({ text: 'document-' + n, images: [] }, 'Synthesize saved leaves.'))); } });
  await f.configure('changes-after-enable'); f.observeChange();
  await Promise.all([f.feature.sweep(0), f.feature.sweep(0)]);
  assert.equal(f.published.length, 1); assert.equal(maximum, 1); assert.equal(observed.length, 4);
  assert.deepEqual(f.errors, []);
});

test('a late pre-activation parse cannot turn a baseline revision into eligible historical work', async t => {
  const f = await setup(t); const old = revision(fs.readFileSync(f.file));
  fs.appendFileSync(f.file, '\n'); await f.configure('changes-after-enable');
  f.feature.observe('session', old);
  await f.feature.sweep(0);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.feature.status().pending, []);
});

test('explicit and inherited automatic model calls cannot return across disable or epoch replacement', async t => {
  for (const inherited of [false, true]) for (const reenable of [false, true]) {
    let entered = 0;
    const f = await setup(t, { runInternalModel: async () => {
      entered++; await f.configure('off'); if (reenable) await f.configure('legacy');
      return { content: [{ type: 'text', text: 'must not publish' }] };
    } });
    await f.configure('legacy'); const epoch = f.feature.epoch();
    const invoke = () => {
      const route = f.feature.routeCall({ text: 'derived memory', images: [] }, 'Synthesize.',
        inherited ? { memory: true } : { automatic: true, epoch, memory: true });
      assert.equal(route.modelOnly, true); assert.equal(route.automatic, true); assert.equal(route.epoch, epoch);
      return route.invoke();
    };
    await assert.rejects(inherited ? f.hooks.context.run({ automatic: true, epoch }, invoke) : invoke(), /consent changed/);
    assert.equal(entered, 1);
    await assert.rejects(f.feature.model({ text: 'no call', images: [] }, 'Synthesize.', undefined, { automatic: true, epoch }), /consent changed/);
    assert.equal(entered, 1);
  }
});

test('image opt-in does not reroute unrelated text helpers; memory context and durable tickets use model-only transport', async t => {
  const f = await setup(t); await f.configure('legacy');
  assert.equal(f.feature.routeCall({ text: 'review or naming', images: [] }, 'text').modelOnly, false);
  await f.hooks.context.run({ memory: true }, async () => {
    assert.equal(f.feature.routeCall({ text: 'memory document', images: [] }, 'text').modelOnly, true);
  });
});

test('legacy defaults remain allowed, but off and new-policy modes never adopt an old automatic context', async t => {
  const f = await setup(t); assert.equal(f.feature.legacyAllowed(), false);
  await f.configure('legacy'); assert.equal(f.feature.legacyAllowed(), true);
  const oldEpoch = f.feature.epoch(); await f.configure('off');
  await f.hooks.context.run({ automatic: true, epoch: oldEpoch }, async () => {
    assert.equal(f.feature.automaticAllowed(), false); assert.throws(f.feature.check, /consent changed/);
  });
  await f.configure('changes-after-enable');
  assert.equal(f.feature.automaticAllowed(), false, 'only a claimed durable ticket may run');
});
