'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
async function Given(label, f) { console.log('Given ' + label); return f(); }
async function When(label, f) { console.log('When ' + label); return f(); }
async function Then(label, f) { console.log('Then ' + label); return f(); }
for (const event of ['read', 'cache-temp', 'titles-temp']) for (const change of ['title permission', 'manual title', 'source title']) {
  test(`Scenario: timeline ${change} during ${event} fences all subsequent publication`, async t => {
    const state = await Given('real atomic writes and one pending title with an in-place source/title mutation hook', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const cache = path.join(root, 'a.json'), titles = path.join(root, 'titles.json'), idx = path.join(root, 'index.json');
      fs.writeFileSync(cache, '{}'); fs.writeFileSync(titles, '{}'); fs.writeFileSync(idx, '{}');
      let fired = false; const replacements = [], broadcasts = [], errors = [];
      const mutate = at => {
        if (at !== event || fired) return; fired = true;
        if (change === 'title permission') c.appSettings.aiTitles = false;
        if (change === 'epoch rotation') c.epoch = 'new'; // Still allowed, but no longer the captured epoch.
        if (change === 'manual title') c.timelineTitles.a = { manual: true, title: 'Mine' };
        if (change === 'source title') { c.index.a.title = 'New source'; c.index.a.timelineTitleHash = 'new'; }
      };
      const c = vm.createContext({ appSettings: { aiTitles: true }, epoch: 'old',
        memoryFeature: { automaticAllowed: () => true, epoch: () => c.epoch },
        TIMELINE_TITLES_FILE: titles, INDEX_FILE: idx, atomicWriteSeq: 0, process, path,
        fs: { ...fs, renameSync: (a,b) => { replacements.push({ file: b, after: fired }); fs.renameSync(a,b); } },
        fsp: { ...fs.promises,
          readFile: async (...args) => { const value = await fs.promises.readFile(...args); mutate('read'); return value; },
          writeFile: async (p, text, ...args) => { await fs.promises.writeFile(p,text,...args);
            mutate(p.startsWith(cache) ? 'cache-temp' : p.startsWith(titles) ? 'titles-temp' : 'index-temp'); },
        },
        timelineTitleRunning: false, timelineTitleAgain: false, timelineTitles: {},
        index: { a: { title: 'Old', timelineTitleHash: 'old' } },
        mapTimelineLimit: async (xs, _n, f) => Promise.all(xs.map(f)),
        runPi: async () => '[{"id":0,"title":"AI title"}]', TIMELINE_TITLE_PROMPT: 'fixture',
        timelineTitle: x => x, cachePathFor: () => cache,
        requireAiTitles: () => { if (!c.appSettings.aiTitles) throw Error('AI titles disabled'); },
        broadcast: x => broadcasts.push(x), saveTimelineTitles() {}, saveIndexSoon() {}, scheduleTimelineTitles() {},
        console: { error: (...args) => errors.push(args.join(' ')) },
      });
      vm.runInContext(section('async function writeFileAtomic(', 'function saveIndexSoon()'), c);
      vm.runInContext(section('async function refreshTimelineTitles()', '// ---- per-conversation title overrides'), c);
      return { c, replacements, broadcasts, errors, fired: () => fired };
    });
    await When('the batch awaits the selected I/O boundary', () => state.c.refreshTimelineTitles());
    await Then('the event occurred and neither replacement nor in-memory AI publication follows it', () => {
      assert.ok(state.fired(), 'the selected awaited publication boundary must actually run');
      assert.deepEqual(state.replacements.filter(r => r.after), [], 'no rename after invalidation');
      assert.notEqual(state.c.timelineTitles.a?.title, 'AI title');
      assert.notEqual(state.c.index.a.timelineTitle, 'AI title');
      if (change === 'manual title') assert.equal(state.c.timelineTitles.a.title, 'Mine');
      assert.equal(state.broadcasts.length, 0);
      assert.ok(state.errors.length, 'guard failures must not be swallowed as cache errors');
    });
  });
}
