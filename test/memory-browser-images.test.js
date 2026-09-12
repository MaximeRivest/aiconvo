'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const imagesFromBrowser = require('./fixtures/browser-images.cjs');
const fixture = require('./fixtures/memory-fixture.cjs');
const { sourceSnapshot, hydrate, packRows, decodeImage, LIMITS } = require('../memory-images');
const { revision } = require('../memory-automation');
const { runInternalModel } = require('../internal-model');
const { spawnSync } = require('node:child_process');
test('real browser JPEG and PNG retain source-byte identity through hydration and actual provider delivery', { timeout: 30000 }, async t => {
  if (spawnSync('chromium', ['--version']).error) return t.skip('chromium is not installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-image-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const images = imagesFromBrowser(root), entries = fixture.transcript();
  entries[1].message.content[1] = images[0]; entries[5].message.content[0] = images[1];
  const file = path.join(root, 'source.jsonl'), original = fixture.jsonl(entries); fs.writeFileSync(file, original);
  const snapshot = sourceSnapshot(file), parsed = await fixture.parser()(file, snapshot.text), bundle = hydrate(snapshot, parsed);
  assert.equal(bundle.rows[0].images[0].identity, revision(Buffer.from(images[0].data, 'base64')));
  const capture = path.join(root, 'capture.jsonl'), agent = path.join(root, 'agent'); fs.mkdirSync(agent);
  const groups = packRows(bundle.rows, 100000);
  for (const group of groups) await runInternalModel(group, 'Inspect supplied images.', {
    agentDir: agent, env: { MEMORY_FIXTURE_CAPTURE: capture }, settings: { provider: 'memory-fixture', model: 'vision', memoryImages: true,
      providerExtensions: { 'memory-fixture': [path.join(__dirname, 'fixtures/memory-provider.ts')] } } });
  const delivered = fs.readFileSync(capture, 'utf8').trim().split('\n').flatMap(line => JSON.parse(line).content.filter(c => c.type === 'image'));
  assert.deepEqual(delivered, groups.flatMap(g => g.images)); assert.ok(delivered.some(i => i.mimeType === 'image/jpeg'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const jpeg = images[0], bytes = Buffer.from(jpeg.data, 'base64');
  assert.deepEqual([decodeImage(jpeg).width, decodeImage(jpeg).height], [16, 12]);
  assert.throws(() => decodeImage({ ...jpeg, data: bytes.subarray(0, -2).toString('base64') }), /JPEG end/);
  assert.throws(() => decodeImage(jpeg, { ...LIMITS, width: 8 }), /dimensions/);
  assert.throws(() => decodeImage(jpeg, { ...LIMITS, imageBytes: 10 }), /budget/);
});
