'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { normalizeSettings } = require('../settings');
const fixture = require('./fixtures/memory-fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('isolated server API: title fences, image-grounded visible notes, activation baseline and no-backfill restart state', { timeout: 90000 }, async t => {
  // The child server inherits a PATH with a stub `pi` first (catalog control
  // below). SDK resolution via `which pi` would find the stub and fail, so
  // pin the real package from this unpoisoned process. No installed pi means
  // no live distill path to exercise: skip, do not fail.
  let piPackage = null;
  try { piPackage = require('../pisdk-runtime').piPackageDir(); } catch {}
  if (!piPackage) return t.skip('pi package is not installed');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-api-')), repo = path.resolve(__dirname, '..');
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions'), config = path.join(home, '.config/aiconvo'), bin = path.join(home, 'bin');
  for (const dir of [sessions, config, bin, path.join(home, 'work')]) fs.mkdirSync(dir, { recursive: true });
  // Catalog only: accidental legacy CLI inference fails instead of reaching a provider.
  const catalog = path.join(bin, 'catalog.txt');
  fs.writeFileSync(catalog, [['provider', 'model', 'context', 'max-out', 'thinking', 'images'], ['memory-fixture', 'vision', '128K', '2K', 'no', 'yes']]
    .map(row => row.map((value, i) => value.padEnd([20, 20, 12, 12, 12, 12][i])).join('')).join('\n'));
  fs.writeFileSync(path.join(bin, 'pi'), '#!/usr/bin/env node\nif(!process.argv.includes("--list-models"))process.exit(90);console.log(require("node:fs").readFileSync(require("node:path").join(__dirname,"catalog.txt"),"utf8"));\n', { mode: 0o700 });
  const settings = normalizeSettings({ provider: 'memory-fixture', model: 'vision', contextTokens: 128000, memoryImages: true,
    aiTitles: false, automaticMemory: 'off', doneSound: 'off', providerExtensions: { 'memory-fixture': [path.join(__dirname, 'fixtures/memory-provider.ts')] } });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(settings));
  const entries = fixture.transcript(); entries[0].cwd = path.join(home, 'work');
  const original = fixture.jsonl(entries); fs.writeFileSync(path.join(sessions, 'sample.jsonl'), original);
  const capture = path.join(home, 'received.jsonl'), key = 'pi:sample.jsonl';
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port; let server, log = '';
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 1000); try { await exited; } finally { clearTimeout(timer); }
  }
  t.after(async () => { await stop(); fs.rmSync(home, { recursive: true, force: true }); });
  async function request(route, body, method = 'POST') {
    return (await fetch(base + route, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  }
  async function until(fn) {
    for (let i = 0; i < 600; i++) { const value = await fn().catch(() => null); if (value) return value; await sleep(50); }
    throw new Error('Synthetic server did not reach expected state: ' + log);
  }
  async function start() {
    server = spawn(process.execPath, ['server.js'], { cwd: repo, env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH,
      PI_CODING_AGENT_PACKAGE: piPackage,
      PORT: String(port), AICONVO_HOST: '127.0.0.1', AICONVO_TLS_PORT: '0', AICONVO_NO_WATCH: '0', AICONVO_NO_LEDGER: '1',
      AICONVO_CACHE_DIR: path.join(home, 'cache'), AICONVO_CHECKPOINT_DIR: path.join(home, 'checkpoints'), AICONVO_DELEGATION_ROOT: path.join(home, 'delegations'),
      PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, MEMORY_FIXTURE_CAPTURE: capture, MEMORY_FIXTURE_FAIL: '0', MEMORY_FIXTURE_TOOL: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
    await until(async () => (await request('/api/sessions')).some(s => s.key === key));
  }
  await start();
  assert.ok((await request('/api/models?refresh=1')).models.some(m => m.provider === 'memory-fixture' && m.model === 'vision'), 'real nonempty stale catalog fixture');
  assert.equal((await fetch(base + '/memory-settings.js')).status, 200);
  for (const [route, body] of [['conversation', { id: key }], ['project', { name: 'synthetic' }], ['epic', { id: 'synthetic' }]]) {
    assert.match((await request('/api/' + route + '/retitle', body)).error, /AI titles are disabled/);
  }
  assert.equal(fs.existsSync(capture), false);
  await request('/api/distill/start?id=' + encodeURIComponent(key), {});
  const noted = await until(async () => (await request('/api/sessions')).find(s => s.key === key && s.notePath));
  const note = fs.readFileSync(noted.notePath, 'utf8'); assert.match(note, /Synthetic grounded note/); assert.match(note, /Images supplied:\*\* 4/);
  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls[0].content.filter(c => c.type === 'image').length, 4);
  assert.equal(calls.length, 1, 'grounded abstract is reused without an extra title or abstract call');
  assert.match(calls[0].content[0].text, /Do not generate a document or conversation title/);
  assert.equal(fs.readFileSync(path.join(sessions, 'sample.jsonl'), 'utf8'), original);
  // Exercise the actual rollup through HTTP, including its persisted lane and
  // weighing caches. Do not substitute a source-sliced copy of regenerateDocsCore.
  const leafDir = path.join(home, 'cache/memory-leaves'); fs.mkdirSync(leafDir, { recursive: true });
  const leaf = { v: 2, key, title: 'Fixture', abstract: 'Unchanged abstract.', span: { firstTs: '2026-01-01', lastTs: '2026-01-02' },
    intent: [{ messageIndex: 0, entry: 'u0', user: 'Never deploy', assistantBefore: 'Wait for review', assistantBeforeEntry: 'a0',
      offBranch: false, kind: 'constraint', force: 'considered-direction', situation: 'Safety review', confidence: 0.9 }], environment: [], problems: [] };
  const leafFile = path.join(leafDir, key.replace(/[:\/\\]/g, '__') + '.json');
  fs.writeFileSync(leafFile, JSON.stringify(leaf));
  const project = noted.project;
  async function regenerate() {
    const job = await request('/api/project/memory/regenerate', { project }); assert.ok(job.id, JSON.stringify(job));
    const done = await until(async () => (await request('/api/jobs')).find(j => j.id === job.id && j.finishedAt));
    assert.notEqual(done.status, 'error', JSON.stringify(done));
  }
  const captured = () => fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  await regenerate(); const firstCount = captured().length;
  await regenerate(); assert.equal(captured().length, firstCount, 'unchanged evidence reuses lanes');
  leaf.intent[0].user = 'Deploy now'; leaf.intent[0].offBranch = true; leaf.intent[0].assistantBeforeEntry = 'different-ancestor';
  fs.writeFileSync(leafFile, JSON.stringify(leaf)); await regenerate();
  const newCalls = captured().slice(firstCount); assert.ok(newCalls.length >= 2, 'changed quote and branch must trigger weighing and synthesis');
  const inputs = newCalls.flatMap(c => c.content).filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(inputs, /Deploy now/); assert.match(inputs, /offBranch.*true/); assert.match(inputs, /considered-direction/); assert.match(inputs, /Safety review/);
  const document = await request('/api/project/memory/file?name=' + encodeURIComponent(project) + '&kind=intent');
  assert.match(document.text, /Deploy now/); assert.match(document.text, /off-branch alternative/); assert.match(document.text, /different-ancestor/);
  // A stale catalog must not force a dummy extension onto a static provider.
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'static-fixture': { api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/not-used', models: [{ id: 'uncatalogued', input: ['text', 'image'] }] } } }));
  const staticSaved = await request('/api/settings', { provider: 'static-fixture', model: 'uncatalogued', usePiDefault: false, providerExtensions: {} }, 'PUT');
  assert.equal(staticSaved.settings.provider, 'static-fixture'); assert.equal(staticSaved.settings.model, 'uncatalogued');
  fs.writeFileSync(catalog, ''); assert.equal((await request('/api/models?refresh=1')).models.length, 0);
  const missingCatalogSaved = await request('/api/settings', { provider: 'static-fixture', model: 'uncatalogued', providerExtensions: {} }, 'PUT');
  assert.equal(missingCatalogSaved.settings.model, 'uncatalogued');
  const restored = await request('/api/settings', settings, 'PUT'); assert.deepEqual(restored.settings.providerExtensions, settings.providerExtensions);
  const beforeActivationCount = captured().length;
  const activated = await request('/api/settings', { automaticMemory: 'changes-after-enable' }, 'PUT');
  assert.equal(activated.settings.aiTitles, false, 'partial old-client updates preserve title policy');
  assert.equal(activated.memoryAutomation.active, true); assert.equal(activated.memoryAutomation.baselineCount, 1);
  assert.deepEqual(activated.memoryAutomation.pending, []);
  fs.writeFileSync(path.join(sessions, 'import.jsonl'), original);
  await until(async () => (await request('/api/settings')).memoryAutomation.baselineCount === 2);
  const state = await request('/api/settings'); assert.deepEqual(state.memoryAutomation.pending, []);
  await stop(); fs.rmSync(path.join(home, 'cache'), { recursive: true, force: true });
  fs.writeFileSync(path.join(sessions, 'offline-import.jsonl'), original);
  await start();
  const restarted = await until(async () => { const s = await request('/api/settings'); return s.memoryAutomation.baselineCount === 3 && s; });
  assert.equal(restarted.memoryAutomation.epoch, activated.memoryAutomation.epoch);
  assert.deepEqual(restarted.memoryAutomation.pending, []);
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, beforeActivationCount, 'cache rebuild/import did not run inference');
});
