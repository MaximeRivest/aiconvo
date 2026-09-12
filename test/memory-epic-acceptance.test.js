'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMemoryFeature } = require('../memory-feature');
const fixture = require('./fixtures/memory-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a,b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
async function Given(label,f) { console.log('Given ' + label); return f(); }
async function When(label,f) { console.log('When ' + label); return f(); }
async function Then(label,f) { console.log('Then ' + label); return f(); }
const story = '{"title":"Epic","chapters":[{"narrative":"evidence"}]}';
async function setup(t, event, drift = 'source') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-guards-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = require('../settings').normalizeSettings({ provider: 'fake', model: 'vision', memoryImages: true, aiTitles: false });
  const files = {}, data = {}, writes = [], calls = []; let changed = false;
  for (const key of ['a','b']) {
    files[key] = path.join(root, key + '.jsonl'); fs.writeFileSync(files[key], fixture.jsonl(fixture.transcript()));
    data[key] = { key, title: key, firstTs: '2026-01-01' }; fs.writeFileSync(path.join(root, key + '.json'), JSON.stringify(data[key]));
  }
  const mutate = at => {
    if (event !== at || changed) return; changed = true;
    if (drift === 'source') fs.appendFileSync(files.a, '\n'); else settings.model = 'different';
  };
  const feature = createMemoryFeature({ settings: () => settings, context: new AsyncLocalStorage(), stateFile: path.join(root,'state.json'),
    parseFile: fixture.parser(), sourceFile: k => files[k], projectOf: () => 'fixture',
    runInternalModel: async (_input, prompt, options) => {
      options.check(); calls.push(prompt);
      if (calls.length === 2) mutate('evidence-retry');
      return { content: [{ type: 'text', text: event === 'evidence-retry' && calls.length === 2 ? 'not json' :
        '{"note":"note","abstract":"abstract","intent":[],"environment":[],"problems":[]}' }] };
    },
  });
  const epicPath = path.join(root, 'epic.md'), inputsPath = path.join(root, 'inputs.json'), epicsPath = path.join(root,'epics.json');
  const c = vm.createContext({ appSettings: settings, memoryFeature: feature, epics: {}, index: { a: {}, b: {} },
    process, path, atomicWriteSeq: 0, EPICS_FILE: epicsPath,
    fs: { ...fs, renameSync: (a,b) => { writes.push({ p:b, after:changed }); fs.renameSync(a,b); } },
    fsp: { ...fs.promises, open: async (p, flags) => {
      const handle = await fs.promises.open(p, flags);
      return { writeFile: async text => { await handle.writeFile(text); mutate(p.startsWith(epicPath) ? 'epic-temp' : p.startsWith(inputsPath) ? 'manifest-temp' : 'map-temp'); },
        sync: async () => { await handle.sync(); if (p === root) mutate('directory-sync'); }, close: () => handle.close() };
    } },
    cachePathFor: k => path.join(root, k + '.json'),
    // Serial scheduling makes drift between different evidence builds deterministic.
    mapLimit: async (xs, _n, f) => { const out = []; for (let i=0;i<xs.length;i++) out.push(await f(xs[i],i)); return out; },
    oneLine: (s, fallback) => s || fallback, epicPathFor: () => epicPath, epicInputsPathFor: () => inputsPath,
    renderEpicMarkdown: () => 'Source evidence', piTargetTokens: () => event === 'chapter' ? 12100 : 100000,
    estimateInputTokens: text => text.includes('CONVERSATION') ? text.length : 1, EPIC_PROMPT: () => 'epic prompt',
    runPi: async (_input, _prompt, _chunk, options = {}) => { options.guard?.(); calls.push('synthesis'); mutate(event === 'chapter' ? 'chapter' : 'synthesis'); return story; },
  });
  vm.runInContext(section('async function writeFileAtomic(', 'function saveIndexSoon()'), c);
  vm.runInContext(section('function saveEpics(', 'const epicPathFor'), c);
  vm.runInContext(section('async function epicEvidenceFor(', 'async function mapLimit('), c);
  vm.runInContext(section('async function buildEpicStory(', '// Absolute path of the original'), c);
  vm.runInContext(section('async function buildEpic(', 'async function epicResponse('), c);
  return { c, calls, writes, changed: () => changed, epicPath, inputsPath, epicsPath };
}
for (const event of ['evidence-retry', 'synthesis', 'chapter', 'epic-temp', 'manifest-temp', 'directory-sync', 'map-temp']) {
  for (const drift of ['source','model']) test(`Scenario: epic ${drift} drift at ${event} stops later stages and guarded publication`, async t => {
    const s = await Given('actual multimodal builders, atomic writer and epic functions', () => setup(t,event,drift));
    let error;
    await When('evidence changes at the selected awaited boundary', async () => { try { await s.c.buildEpic(['a','b'],null,'Fixture','id'); } catch (e) { error=e; } });
    await Then('no subsequent model call, replacement, or in-memory epic is published', () => {
      assert.ok(s.changed(), 'the selected drift event ran');
      assert.match(error?.message || '', /Source revision/);
      assert.equal(s.c.epics.id, undefined);
      assert.deepEqual(s.writes.filter(w => w.after), []);
      if (event === 'evidence-retry') assert.equal(s.calls.length, 2, 'no correction or synthesis after an earlier input drifts');
      if (event === 'chapter') assert.equal(s.calls.length, 3, 'no later chapter or merge');
      const retained = ['manifest-temp','directory-sync'].includes(event) ? 1 : event === 'map-temp' ? 2 : 0;
      assert.equal(s.writes.length, retained, 'earlier atomic files remain explicitly partial; no multi-file transaction is claimed');
    });
  });
}
test('Scenario: unchanged epic persists plain provenance and publishes successfully', async t => {
  const s = await Given('unchanged real multimodal evidence', () => setup(t,'none'));
  const result = await When('the epic is built', () => s.c.buildEpic(['a','b'],null,'Fixture','id'));
  await Then('all outputs exist with source identities, not serialized guard functions', () => {
    assert.equal(result.id,'id'); assert.ok(s.c.epics.id);
    const manifest = JSON.parse(fs.readFileSync(s.inputsPath,'utf8'));
    assert.equal(manifest.inputs.length,2);
    for (const input of manifest.inputs) { assert.match(input.sourceRevision,/^[a-f0-9]{64}$/); assert.equal('guard' in input,false); }
    assert.equal(s.writes.length,3);
  });
});

for (const modelOnly of [false,true]) test(`Scenario: standard model API propagates source guards (${modelOnly ? 'isolated' : 'legacy'} route)`, async t => {
  const s = await Given('the production runPi routing seam and a source guard', () => setup(t,'none'));
  let changed=false, invoked=0, settled=0;
  const guard = () => { if (changed) { const e = Error('Source revision changed'); e.code='STALE_MEMORY_INPUT'; throw e; } };
  Object.assign(s.c, { appSettings: { aiTitles:true }, os, memoryFeature: {
    routeCall: (_input,_prompt,options) => ({ automatic:false, modelOnly, invoke: async () => { invoked++; changed=true; return 'stale'; } }),
  }, modelCallContext: new AsyncLocalStorage(), memoryModelHealth: { setIdentity() {}, begin() { return {}; }, success() { settled++; }, failure() { assert.fail('source drift is not a provider failure'); } },
    currentModelLabel: () => 'fake', piArgs: () => [], execFile() {}, MODEL_ACTIVITY_TIMEOUT_MS: 1000,
    execFileWithActivityTimeout: async () => { invoked++; changed=true; return { stdout: 'stale' }; },
  });
  vm.runInContext(section('async function runPi(', 'const TIMELINE_TITLE_PROMPT ='), s.c);
  let error;
  await When('the transport returns after source drift', async () => { try { await s.c.runPi('input','prompt',null,{ guard }); } catch(e) { error=e; } });
  await Then('source failure propagates without model-failure retry classification', () => {
    assert.equal(invoked,1); assert.match(error?.message || '',/Source revision/); assert.notEqual(error?.modelCallFailure,true);
    assert.equal(settled, modelOnly ? 0 : 1, 'a successful transport must release its health probe even when source guards reject the result');
  });
});

test('Scenario: isolated routing checks an explicit source guard before provider invocation', async t => {
  const s = await Given('the real memory-feature routing seam', () => setup(t,'none'));
  const route = await When('a stale guarded memory request is routed', () => s.c.memoryFeature.routeCall({ text:'stale',images:[] },'prompt',{
    memory:true, guard: () => { throw Error('Source revision changed'); },
  }));
  await Then('the provider stub is never entered', async () => {
    await assert.rejects(route.invoke(), /Source revision/); assert.equal(s.calls.length,0);
  });
});
