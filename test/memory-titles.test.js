'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
function context(extra = {}) {
  const c = vm.createContext({ appSettings: { aiTitles: false }, memoryFeature: { automaticAllowed: () => true }, ...extra });
  vm.runInContext(section('function requireAiTitles()', 'const memoryFeature ='), c); return c;
}

test('all standalone title functions and schedulers suppress calls when AI titles are off', async () => {
  const c = context({ setTimeout: () => { throw new Error('Title timer scheduled'); }, clearTimeout() {},
    runPi: () => { throw new Error('Title inference called'); } });
  for (const [start, end] of [
    ['async function retitleProject(', '// Epic titles:'], ['async function retitleEpic(', '// Auto title:'],
    ['function maybeAutoProjectTitle(', 'function rawProjectNames('],
    ['function scheduleTimelineTitles(', 'function mapTimelineLimit('],
    ['async function refreshTimelineTitles(', '// ---- per-conversation title overrides'],
    ['function scheduleAutoRetitle(', 'function maybeAutoRetitle('],
    ['function maybeAutoRetitle(', '// Retitle one conversation on demand'],
    ['async function retitleConversation(', '// Every message, numbered'],
    ['function scheduleDocCommitTitle(', '// Explicit save ='],
  ]) vm.runInContext(section(start, end), c);
  for (const name of ['retitleProject', 'retitleEpic', 'retitleConversation']) await assert.rejects(c[name]('fixture'), /AI titles are disabled/);
  c.maybeAutoProjectTitle('fixture'); c.scheduleTimelineTitles(); await c.refreshTimelineTitles();
  c.scheduleAutoRetitle('fixture'); c.maybeAutoRetitle('fixture', null, {}); c.scheduleDocCommitTitle('fixture', 'hash', 'diff');
});

test('common internal transport fences every standalone title prompt before spawning', async () => {
  const prompts = ['TITLE_PROMPT', 'RETITLE_PROMPT', 'PROJECT_RETITLE_PROMPT', 'TIMELINE_TITLE_PROMPT', 'DOC_COMMIT_TITLE_PROMPT'];
  const c = context(Object.fromEntries(prompts.map(p => [p, p])));
  vm.runInContext(section('async function runPi(', 'const TIMELINE_TITLE_PROMPT ='), c);
  for (const prompt of prompts) await assert.rejects(c.runPi('fixture', prompt), /AI titles are disabled/);
});

test('title-off distillation requests an abstract only and preserves the existing/deterministic title', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'titles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompts = [];
  const c = context({ index: { fixture: { mtimeMs: 7, cwd: '/fixture/project' } }, distillJobs: new Map(),
    currentModelLabel: () => 'fixture/model', jobChanged() {}, broadcast() {}, saveIndexSoon() {},
    distill: async () => ({ note: '# Existing title\n\n## Problem\nUseful detail.' }),
    runPi: async (_input, prompt) => { prompts.push(prompt); return JSON.stringify({ title: 'Must not replace title', abstract: 'Preserved useful abstract.' }); },
    NOTES_DIR: '/fixture/notes', fsp: { mkdir: async () => {} },
    require: name => { assert.equal(name, './note-publication'); return require('../note-publication'); },
    noteFileFor: () => path.join(root, 'note.md'), projectNameOf: () => 'fixture', setTimeout() {},
  });
  vm.runInContext(section('const ABSTRACT_PROMPT =', '// Cross-session evidence is cached'), c);
  vm.runInContext(section('function startDistillJob(', '// ---- memory pyramid jobs'), c);
  await c.startDistillJob('fixture', { key: 'fixture', title: 'Existing title' }).completion;
  assert.equal(prompts.length, 1); assert.match(prompts[0], /Do not generate a title/);
  const saved = fs.readFileSync(path.join(root, 'note.md'), 'utf8');
  assert.match(saved, /^# Existing title\n/); assert.match(saved, /Preserved useful abstract/); assert.ok(!saved.includes('Must not replace title'));
});

test('disabling titles during an outstanding conversation retitle prevents publication', async () => {
  let published = false;
  const c = context({ index: { fixture: {} }, RETITLE_PROMPT: 'title', cachePathFor: () => 'fixture',
    fsp: { readFile: async () => JSON.stringify({ messages: [{ role: 'user', text: 'Synthetic request' }] }) },
    isBootstrapMessage: () => false, timelineTitle: t => t,
    runPi: async () => { c.appSettings.aiTitles = false; return '{"title":"Generated","label":"Generated"}'; },
    applyTitleOverride: () => { published = true; },
  });
  c.appSettings.aiTitles = true;
  vm.runInContext(section('async function retitleConversation(', '// Every message, numbered'), c);
  await assert.rejects(c.retitleConversation('fixture'), /AI titles are disabled/); assert.equal(published, false);
});
