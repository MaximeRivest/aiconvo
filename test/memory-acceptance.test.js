'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
// Executable Gherkin-style acceptance scenarios using the existing Node runner.
const repo = path.resolve(__dirname, '..');
const requireRepo = createRequire(path.join(repo, 'server.js'));
const source = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'production function boundaries must exist');
  return source.slice(a, b);
}
async function Given(label, fn) { console.log('Given ' + label); return await fn(); }
async function When(label, fn) { console.log('When ' + label); return await fn(); }
async function Then(label, fn) { console.log('Then ' + label); return await fn(); }

test('Scenario: timeline batch must stop publishing after revocation of AI-title permission', async () => {
  const c = await Given('two pending timeline titles and an authorized synthetic response', () => {
    const c = vm.createContext({ appSettings: { aiTitles: true }, allowed: false,
      memoryFeature: { automaticAllowed: () => c.allowed, epoch: () => 'fixture-epoch' },
      TIMELINE_TITLES_FILE: 'titles.json', INDEX_FILE: 'index.json',
      writeFileAtomic: async (p, text, { guard }) => { guard(); await c.fsp.writeFile(p, text); },
      timelineTitleRunning: false, timelineTitleAgain: false, timelineTitles: {},
      index: { a: { title: 'A', timelineTitleHash: 'a' }, b: { title: 'B', timelineTitleHash: 'b' } },
      mapTimelineLimit: async (xs, _n, f) => Promise.all(xs.map(f)),
      runPi: async () => JSON.stringify([{ id: 0, title: 'AI A' }, { id: 1, title: 'AI B' }]),
      TIMELINE_TITLE_PROMPT: 'fake', timelineTitle: x => x, cachePathFor: k => k,
      requireAiTitles: () => { if (!c.appSettings.aiTitles) throw Error('AI titles disabled'); },
      fsp: { readFile: async () => { c.appSettings.aiTitles = false; return '{}'; }, writeFile: async () => {} },
      broadcast() {}, saveTimelineTitles() {}, saveIndexSoon() {}, scheduleTimelineTitles() {}, console,
    });
    vm.runInContext(section('async function refreshTimelineTitles()', '// ---- per-conversation title overrides'), c);
    return c;
  });
  await When('AI titles are revoked while the first cache read awaits', () => c.refreshTimelineTitles());
  await Then('the second item is not newly published after revocation', () => {
    assert.equal(c.timelineTitles.b, undefined, 'second AI title was published after revocation: ' + JSON.stringify(c.timelineTitles.b));
  });
});

test('Scenario: memory-policy off must not stop independent AI titles', async () => {
  const c = await Given('two pending timeline titles while automatic memory is disallowed', () => {
    const c = vm.createContext({ appSettings: { aiTitles: true },
      memoryFeature: { automaticAllowed: () => false, epoch: () => 'fixture-epoch' },
      TIMELINE_TITLES_FILE: 'titles.json', INDEX_FILE: 'index.json',
      writeFileAtomic: async (p, text, { guard }) => { guard(); await c.fsp.writeFile(p, text); },
      timelineTitleRunning: false, timelineTitleAgain: false, timelineTitles: {},
      index: { a: { title: 'A', timelineTitleHash: 'a' }, b: { title: 'B', timelineTitleHash: 'b' } },
      mapTimelineLimit: async (xs, _n, f) => Promise.all(xs.map(f)),
      runPi: async () => JSON.stringify([{ id: 0, title: 'AI A' }, { id: 1, title: 'AI B' }]),
      TIMELINE_TITLE_PROMPT: 'fake', timelineTitle: x => x, cachePathFor: k => k,
      requireAiTitles: () => { if (!c.appSettings.aiTitles) throw Error('AI titles disabled'); },
      fsp: { readFile: async () => '{}', writeFile: async () => {} },
      broadcast() {}, saveTimelineTitles() {}, saveIndexSoon() {}, scheduleTimelineTitles() {}, console,
    });
    vm.runInContext(section('async function refreshTimelineTitles()', '// ---- per-conversation title overrides'), c);
    return c;
  });
  await When('the title batch runs', () => c.refreshTimelineTitles());
  await Then('both AI titles still publish because naming is not memory consent', () => {
    assert.equal(c.timelineTitles.a.title, 'AI A');
    assert.equal(c.timelineTitles.b.title, 'AI B');
  });
});

test('Scenario: malformed JPEG scan/table structures must fail admission', async () => {
  const bytes = await Given('a JPEG with empty DQT/DHT segments and a zero-component scan', () => {
    const segment = (tag, payload) => {
      const out = Buffer.alloc(4 + payload.length); out[0] = 255; out[1] = tag;
      out.writeUInt16BE(payload.length + 2, 2); Buffer.from(payload).copy(out, 4); return out;
    };
    return Buffer.concat([Buffer.from([255,216]), segment(0xdb, []), segment(0xc4, []),
      segment(0xc0, [8,0,1,0,1,1,1,0x11,0]), segment(0xda, [0,0,63,0]),
      Buffer.from([0,255,217])]);
  });
  const call = await When('the exact source bytes are submitted for image admission', () => {
    return () => requireRepo('./memory-images').decodeImage({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') });
  });
  await Then('structurally invalid input is rejected before any provider call', () => {
    assert.throws(call, /Incomplete visual input/, 'empty tables and zero scan components were admitted');
  });
});

test('Scenario: image-grounded epic must not publish after its source changes during synthesis', async t => {
  const state = await Given('two synthetic transcripts and actual guarded multimodal evidence builders', () => {
    const fixture = requireRepo('./test/fixtures/memory-fixture.cjs');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'epic-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const settings = requireRepo('./settings').normalizeSettings({ provider: 'fake', model: 'vision', memoryImages: true, aiTitles: false });
    const files = {}, data = {};
    for (const k of ['a', 'b']) {
      files[k] = path.join(root, k + '.jsonl'); fs.writeFileSync(files[k], fixture.jsonl(fixture.transcript()));
      data[k] = { key: k, title: k, firstTs: '2026-01-01', cwd: '/synthetic' };
    }
    const builder = requireRepo('./multimodal-memory').createMultimodalMemory({
      parseFile: fixture.parser(), settings: () => settings, projectOf: () => 'synthetic',
      run: async () => JSON.stringify({ note: 'Source-backed fixture', abstract: 'fixture', intent: [], environment: [], problems: [] }),
    });
    const written = [], guards = [];
    const c = vm.createContext({ appSettings: settings, epics: {}, index: { a: {}, b: {} },
      // Fixture-only forwarding of the aggregate guard; source mutation stays in synthesis.
      memoryFeature: { build: async (d, guard) => { const built = await builder.build(d, files[d.key], guard); guards.push(built.guard); return built; } },
      writeFileAtomic: async (p, text, { guard }) => { guard(); written.push({ p, text }); },
      fsp: { readFile: async k => JSON.stringify(data[k]), writeFile: async (p, text) => written.push({ p, text }) },
      cachePathFor: k => k, mapLimit: async (xs, _n, f) => Promise.all(xs.map(f)),
      buildEpicStory: async () => { fs.appendFileSync(files.a, '\n'); return '{"title":"story","chapters":[{"narrative":"old evidence"}]}'; },
      oneLine: (x, fallback) => x || fallback, epicPathFor: id => id + '.md', epicInputsPathFor: id => id + '.json',
      renderEpicMarkdown: () => 'Old source-backed evidence', saveEpics() {},
    });
    vm.runInContext(section('async function epicEvidenceFor(', 'async function mapLimit('), c);
    vm.runInContext(section('async function buildEpic(', 'async function epicResponse('), c);
    return { c, written, guards };
  });
  let error;
  await When('the raw source changes after evidence extraction but before final epic publication', async () => {
    try { await state.c.buildEpic(['a','b'], null, 'Synthetic epic', 'fixture-epic'); } catch (e) { error = e; }
  });
  await Then('source guards reject publication and no epic files are replaced', () => {
    assert.equal(state.guards.length, 2, 'both real builders ran');
    assert.throws(state.guards[0], /Source revision/, 'source drift is real and detectable');
    assert.equal(state.written.length, 0, 'published stale epic files: ' + JSON.stringify(state.written));
    assert.match(error?.message || '', /Source revision/);
  });
});
