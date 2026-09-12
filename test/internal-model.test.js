'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInternalModel } = require('../internal-model');
const { sourceSnapshot, hydrate, packRows } = require('../memory-images');
const { normalizeSettings } = require('../settings');
const fixture = require('./fixtures/memory-fixture.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent'); fs.mkdirSync(agent);
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'must-not-be-used', extensions: ['/must-not-be-loaded'] }));
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}'); fs.writeFileSync(path.join(agent, 'models.json'), '{"providers":{}}');
  fs.mkdirSync(path.join(agent, 'extensions'));
  fs.writeFileSync(path.join(agent, 'extensions', 'ambient.ts'), 'throw new Error("AMBIENT_LOADED");');
  fs.writeFileSync(path.join(agent, 'AGENTS.md'), 'PRIVATE_CONTEXT_MUST_NOT_LOAD');
  const capture = path.join(root, 'capture.jsonl');
  const settings = normalizeSettings({ provider: 'memory-fixture', model: 'vision', memoryImages: true,
    providerExtensions: { 'memory-fixture': [path.join(__dirname, 'fixtures/memory-provider.ts')], unrelated: ['/must-not-be-loaded'] } });
  const options = { settings, agentDir: agent, env: { MEMORY_FIXTURE_CAPTURE: capture, MEMORY_FIXTURE_FAIL: '0', MEMORY_FIXTURE_HOOK: '0', MEMORY_FIXTURE_TOOL: '0' }, timeoutMs: 15000 };
  return { root, agent, capture, options };
}

test('cold model-only worker: actual fake provider receives every source-backed image, ordered manifest, selected model and zero tools', { timeout: 60000 }, async t => {
  const { root, agent, capture, options } = setup(t);
  const original = fs.readFileSync(path.join(agent, 'settings.json'), 'utf8');
  const link = path.join(root, 'trusted-provider.ts'); fs.symlinkSync(path.join(__dirname, 'fixtures/memory-provider.ts'), link);
  options.settings.providerExtensions = { ...options.settings.providerExtensions, 'memory-fixture': [link] };
  const file = path.join(root, 'source.jsonl'); fs.writeFileSync(file, fixture.jsonl(fixture.transcript()));
  const snapshot = sourceSnapshot(file), parsed = await fixture.parser()(file, snapshot.text), bundle = hydrate(snapshot, parsed);
  const groups = packRows(bundle.rows, 100000);
  for (const group of groups) {
    const result = await runInternalModel(group, 'Summarize and extract memory.', options);
    assert.equal(result.model, 'vision'); assert.equal(result.stopReason, 'stop');
  }
  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, groups.length);
  for (let i = 0; i < calls.length; i++) {
    assert.equal(calls[i].provider, 'memory-fixture'); assert.equal(calls[i].model, 'vision');
    assert.deepEqual(calls[i].tools, []); assert.equal(calls[i].maxRetries, 0);
    assert.deepEqual(calls[i].content.filter(b => b.type === 'image'), groups[i].images);
    assert.ok(calls[i].content[0].text.includes(groups[i].text));
    assert.ok(!calls[i].systemPrompt.includes('PRIVATE_CONTEXT_MUST_NOT_LOAD'));
    assert.equal(fs.existsSync(calls[i].cwd), false, 'owned temporary process directory cleaned');
  }
  assert.equal(calls.flatMap(c => c.content).filter(b => b.type === 'image').length, 4);
  assert.equal(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'), original, 'no host settings mutation');
  assert.deepEqual(fs.readdirSync(agent).sort(), ['AGENTS.md', 'auth.json', 'extensions', 'models.json', 'settings.json']);
});

test('no text/cloud/fuzzy-model fallback, no provider retries or compaction, and no inference after revoked preflight', { timeout: 60000 }, async t => {
  const { agent, capture, options } = setup(t); const input = { text: 'Synthetic input', images: [fixture.image()] };
  options.settings.model = 'text';
  await assert.rejects(runInternalModel(input, 'Inspect images.', options), /does not declare image/);
  assert.equal(fs.existsSync(capture), false);
  options.settings.model = 'vis';
  await assert.rejects(runInternalModel(input, 'Inspect images.', options), /not resolved exactly/);
  assert.equal(fs.existsSync(capture), false);
  options.settings.model = 'vision'; options.check = () => { throw new Error('consent revoked'); };
  await assert.rejects(runInternalModel(input, 'Inspect images.', options), /consent revoked/);
  assert.equal(fs.existsSync(capture), false);
  delete options.check; options.env.MEMORY_FIXTURE_FAIL = '1';
  await assert.rejects(runInternalModel(input, 'Inspect images.', options), /synthetic failure/);
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 1, 'no hidden retry or overflow inference');
  options.env.MEMORY_FIXTURE_FAIL = '0'; options.env.MEMORY_FIXTURE_TOOL = '1';
  await assert.rejects(runInternalModel(input, 'Inspect images.', options), /no continuation/);
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 2, 'unexpected tool requests cannot enter an agent loop');
  await assert.rejects(runInternalModel({ text: 'fixture', images: [{ type: 'image', data: 'invalid', mimeType: 'image/png' }] }, 'Inspect.', options), /base64/);
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 2, 'invalid images are rejected before any provider request');
  const extension = options.settings.providerExtensions['memory-fixture'];
  options.settings.providerExtensions = { ...options.settings.providerExtensions, 'memory-fixture': [agent] };
  await assert.rejects(runInternalModel(input, 'Inspect.', options), /regular entrypoint/);
  options.settings.providerExtensions = { ...options.settings.providerExtensions, 'memory-fixture': [path.join(agent, 'missing.ts')] };
  await assert.rejects(runInternalModel(input, 'Inspect.', options), /ENOENT/);
  options.settings.providerExtensions = { ...options.settings.providerExtensions, 'memory-fixture': extension };
  options.env.MEMORY_FIXTURE_TOOL = '0'; options.env.MEMORY_FIXTURE_HOOK = '1';
  await assert.rejects(runInternalModel(input, 'Inspect.', options), /does not support extension/);
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 2, 'lifecycle-dependent providers fail explicitly');
  options.env.MEMORY_FIXTURE_HOOK = '0'; options.settings.provider = 'openai'; options.settings.model = 'gpt-4.1';
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { openai: { models: [{ id: 123 }] } } }));
  await assert.rejects(runInternalModel(input, 'Inspect.', options), /configuration is invalid/);
  assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 2);
});
