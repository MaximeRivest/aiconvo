'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LIMITS, decodeImage, sourceSnapshot, hydrate, packRows } = require('../memory-images');
const { revision } = require('../memory-automation');
const { createMultimodalMemory } = require('../multimodal-memory');
const { normalizeSettings } = require('../settings');
const fixture = require('./fixtures/memory-fixture.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.jsonl'); fs.writeFileSync(file, fixture.jsonl(fixture.transcript()));
  return { root, file };
}
async function load(file) {
  const snapshot = sourceSnapshot(file), parse = fixture.parser();
  const data = await parse(file, snapshot.text);
  return { snapshot, data, bundle: hydrate(snapshot, data) };
}

test('PNG structural admission validates canonical bytes, dimensions and decompressed scanline layout', () => {
  const block = fixture.image();
  const out = decodeImage(block);
  assert.equal(out.width, 1); assert.equal(out.height, 1); assert.equal(out.data, block.data);
  for (const options of [{ width: 2049 }, { height: 2049 }, { width: 0 }, { depth: 16 }, { color: 3 }, { filter: 5 }, { width: 2 }]) {
    assert.throws(() => decodeImage(fixture.image(options)), /Incomplete visual input/);
  }
  for (const options of [{ color: 0, raw: [0, 42] }, { color: 4, raw: [0, 42, 255] },
    { color: 0, depth: 1, raw: [0, 128] }, { depth: 16, raw: [0, 0, 42, 0, 100, 0, 150, 255, 255] },
    { interlace: 1 }, { color: 3, raw: [0, 0], extra: [fixture.chunk('PLTE', Buffer.from([42, 100, 150]))] }]) {
    const image = fixture.image(options); assert.equal(decodeImage(image).data, image.data);
  }
  const broken = fixture.png(); broken[broken.length - 1] ^= 1;
  assert.throws(() => decodeImage({ ...block, data: broken.toString('base64') }), /CRC/);
  assert.throws(() => decodeImage({ ...block, data: fixture.png().subarray(0, -12).toString('base64') }), /end missing/);
  assert.throws(() => decodeImage(fixture.image({ extra: [fixture.chunk('acTL', Buffer.alloc(8))] })), /animated/);
  assert.throws(() => decodeImage(block, { ...LIMITS, imageBytes: 1 }), /encoded image exceeds/);
});

test('malformed, ambiguous, unsupported and URL images fail instead of dropping or fetching', () => {
  const image = fixture.image();
  for (const data of ['', '%%%%', image.data + '\n', image.data.slice(0, -1)]) assert.throws(() => decodeImage({ ...image, data }));
  assert.throws(() => decodeImage({ ...image, mimeType: 'image/jpeg' }), /JPEG signature/);
  assert.throws(() => decodeImage({ ...image, url: 'https://invalid.example/image.png' }), /URL/);
  assert.throws(() => decodeImage({ type: 'image', source: { type: 'url', url: 'https://invalid.example/image.png' } }), /URL/);
  assert.throws(() => decodeImage({ ...image, source: { type: 'base64', media_type: 'image/png', data: image.data } }), /ambiguous/);
});

test('one source snapshot hydrates direct/nested images, image-only users and both branches with correct ancestors', async t => {
  const { file } = setup(t), { bundle } = await load(file);
  assert.equal(bundle.imageCount, 4);
  const imageOnly = bundle.rows.find(r => r.eid === 'u1');
  assert.equal(imageOnly.role, 'user'); assert.equal(imageOnly.text, ''); assert.equal(imageOnly.images.length, 1);
  assert.equal(imageOnly.assistantBefore.entry, 'a0');
  assert.equal(bundle.rows.find(r => r.eid === 'off-u').assistantBefore.entry, 'off-a');
  assert.equal(bundle.rows.find(r => r.eid === 'off-u').off, true);
  assert.equal(bundle.rows.find(r => r.eid === 'tool-u').images[0].path, '0.0');
  assert.equal(bundle.rows.find(r => r.eid === 'tool-u').role, 'toolresult');
  const groups = packRows(bundle.rows, 25000);
  assert.equal(groups.flatMap(g => g.images).length, 4);
  const ids = groups.flatMap(g => g.ids);
  assert.equal(new Set(ids).size, bundle.rows.length);
  assert.match(groups.map(g => g.text).join('\n'), /"reference":"tool-u:0.0"/);
  assert.throws(() => packRows(bundle.rows, 100), /one attributed message/);
});

test('missing and ambiguous references, skipped URL blocks, aggregate budgets and malformed JSONL fail closed', async t => {
  const { file } = setup(t), { snapshot, data } = await load(file);
  assert.throws(() => hydrate({ ...snapshot, text: snapshot.text + snapshot.text.split('\n')[1] }, data), /ambiguous entry/);
  const cycle = structuredClone(data); cycle.entryParents[0][1] = cycle.entryParents[0][0];
  assert.throws(() => hydrate(snapshot, cycle), /cyclic/);
  const changed = structuredClone(data); changed.messages[0].images[0].path = '99';
  assert.throws(() => hydrate(snapshot, changed), /image block missing/);
  assert.throws(() => hydrate(snapshot, data, { ...LIMITS, count: 1 }), /session image budget/);
  assert.throws(() => hydrate(snapshot, data, { ...LIMITS, totalBytes: 1 }), /session image budget/);
  assert.throws(() => hydrate({ ...snapshot, text: snapshot.text + '{broken' }, data), /malformed source/);
  const entries = fixture.transcript(); entries[5].message.content = [{ type: 'image', source: { type: 'url', url: 'https://invalid.example/x' } }];
  const text = fixture.jsonl(entries), parsed = await fixture.parser()(file, text);
  assert.throws(() => hydrate({ text, revision: revision(text) }, parsed), /no attributed message/);
});

test('source drift is rejected during snapshot read and before model publication', async t => {
  const { file } = setup(t);
  const original = fs.readSync;
  try {
    fs.readSync = function (...args) { const n = original(...args); fs.appendFileSync(file, '\n'); return n; };
    assert.throws(() => sourceSnapshot(file), /source changed/);
  } finally { fs.readSync = original; }
  const builder = createMultimodalMemory({ parseFile: fixture.parser(), settings: () => normalizeSettings({ memoryImages: true, provider: 'fixture', model: 'vision' }),
    projectOf: () => 'fixture', run: async () => { fs.appendFileSync(file, '\n'); return '{}'; } });
  await assert.rejects(builder.build({ key: 'pi:sample', title: 'Keep title' }, file), /Source revision/);
  fs.writeFileSync(file, Buffer.from([0xff])); assert.throws(() => sourceSnapshot(file), /UTF-8/);
});

test('JSON correction retries preserve attachment/message mapping; summary and leaf share the same grounded result', async t => {
  const { file } = setup(t); const calls = [];
  const settings = normalizeSettings({ memoryImages: true, aiTitles: false, provider: 'fixture', model: 'vision', contextTokens: 50000 });
  const builder = createMultimodalMemory({ parseFile: fixture.parser(), settings: () => settings, projectOf: () => 'fixture',
    run: async (input, prompt) => {
      calls.push(structuredClone(input)); assert.match(prompt, /Do not generate a document/);
      if (calls.length === 1) return '{bad';
      return JSON.stringify({ note: 'Grounded note.', abstract: 'Useful abstract.', intent: input.ids.map(id => ({ id })), environment: [], problems: [] });
    } });
  const built = await builder.build({ key: 'pi:sample', title: 'Existing title' }, file);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(built.note, /^# Existing title/); assert.match(built.note, /Useful abstract/);
  assert.equal(built.leaf.intent.find(i => i.entry === 'u1').assistantBeforeEntry, 'a0');
  assert.equal(built.leaf.intent.find(i => i.entry === 'u1').images.length, 1);
  const firstHash = built.memoryHash;
  const entries = fixture.transcript(); entries[5].message.content[0] = fixture.image({ pixel: 81 }); fs.writeFileSync(file, fixture.jsonl(entries));
  const second = await builder.build({ key: 'pi:sample', title: 'Existing title' }, file);
  assert.notEqual(second.memoryHash, firstHash);
  settings.memoryImages = false;
  const third = await builder.build({ key: 'pi:sample', title: 'Existing title' }, file);
  assert.notEqual(third.memoryHash, second.memoryHash); assert.equal(third.leaf.imageCount, 0);
  assert.match(calls.at(-1).text, /intentionally not inspected/);
  assert.equal(third.leaf.intent.some(i => i.user.includes('intentionally not inspected')), false, 'coverage markers never become verbatim user quotes');
  let malformedCalls = 0;
  const malformed = createMultimodalMemory({ parseFile: fixture.parser(), settings: () => settings, projectOf: () => 'fixture',
    run: async () => { malformedCalls++; return JSON.stringify({ note: 'Note.', abstract: 'Abstract.', intent: [], environment: [{ fact: 'missing type' }], problems: [] }); } });
  await assert.rejects(malformed.build({ key: 'pi:sample', title: 'Existing title' }, file), /extraction schema/);
  assert.equal(malformedCalls, 2, 'malformed fields fail explicitly after one schema correction');
});
