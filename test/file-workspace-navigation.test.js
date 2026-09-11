'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function workspace(extra = {}) {
  const storage = new Map();
  const context = vm.createContext({ window: {}, document: { addEventListener() {} },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    sessionStorage: { setItem() {}, removeItem() {} }, ...extra });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../filesmode.js'), 'utf8'), context);
  return { context, storage };
}
test('file deep links preserve browser context through whole-hash decoding', () => {
  const { context } = workspace();
  const browserContext = { project: 'p', conv: 'a & b%25', dir: 'a & b', root: '/tmp/x' };
  const hash = context.fileWsHash({ project: 'p', path: '/tmp/a & b.md', mode: 'write', browserContext });
  const parsed = context.parseFileHash(decodeURIComponent(hash));
  assert.deepEqual(JSON.parse(parsed.browser), browserContext);
  assert.equal(parsed.path, '/tmp/a & b.md');
});
test('save completion does not discard edits typed while the request was in flight', async () => {
  let resolve, text = 'submitted';
  const elements = { fwSave: {}, docStatus: {} };
  const state = { path: '/tmp/test.js', kind: 'code', baseText: 'original', sha: 'old', editor: { getContent: () => text } };
  const { context } = workspace({ state, $: id => elements[id], postJson: () => new Promise(r => resolve = r), toast() {}, invalidateFileCaches() {} });
  vm.runInContext('fileWs = state; fileWsTrustGutter = () => {}; fileWsBanner = () => {};', context);
  const saving = context.fileWsSaveCode(state);
  text = 'typed later'; resolve({ sha: 'saved' }); await saving;
  assert.equal(state.baseText, 'submitted');
  assert.equal(state.dirty, true);
  assert.equal(elements.fwSave.disabled, false);
});
test('cursor is remembered before destroying the editor', () => {
  let destroyed = false;
  const state = { path: '/tmp/test.js', kind: 'code', editor: {
    selection: () => { if (destroyed) throw Error('destroyed'); return { line: 19 }; }, destroy: () => destroyed = true,
  } };
  const { context, storage } = workspace({ state });
  vm.runInContext('fileWs = state', context);
  context.fileWsCloseEditor();
  assert.equal(storage.get('aiconvo.cursor:/tmp/test.js'), '19');
  assert.equal(destroyed, true);
});
