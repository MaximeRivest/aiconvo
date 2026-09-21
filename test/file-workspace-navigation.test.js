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
test('the line a link asked for survives in the route until the file is mounted', () => {
  const { context } = workspace();
  const route = ws => context.parseFileHash(decodeURIComponent(context.fileWsHash({ mode: 'write', path: '/tmp/a & b.md', ...ws })));
  assert.equal(route({ line: 12 }).line, 12);
  assert.equal(route({ line: '7' }).line, 7, 'a line parsed from a hash is a string');
  assert.equal(route({ line: 12 }).path, '/tmp/a & b.md', 'path still comes last');
  for (const line of [null, undefined, 0, -3, 2.5, 'abc', NaN]) assert.equal(route({ line }).line, undefined, `no line for ${line}`);
  assert.equal(route({ line: 12, mode: 'history', historySel: { to: 'saved:3' } }).line, 12, 'history keeps a pending line too');
});
test('save completion does not discard edits typed while the request was in flight', async () => {
  let resolve, text = 'submitted';
  const elements = { fwSave: {}, docStatus: {} };
  const state = { path: '/tmp/test.js', kind: 'code', baseText: 'original', sha: 'old', editor: { getContent: () => text } };
  const { context } = workspace({ state, $: id => elements[id], postJson: () => new Promise(r => resolve = r), toast() {}, liveFileSaved() {} });
  vm.runInContext('fileWs = state; fileWsBanner = () => {};', context);
  const saving = context.fileWsSaveCode(state);
  text = 'typed later'; resolve({ sha: 'saved' }); await saving;
  assert.equal(state.baseText, 'submitted');
  assert.equal(state.dirty, true);
  assert.equal(elements.fwSave.disabled, false);
});
test('a link or reload lands on the route line; a return lands on the cursor left behind', () => {
  const { context, storage } = workspace();
  const ws = { path: '/tmp/doc.md', line: null };
  // Nothing remembered: the route's line is the only guidance, either way.
  assert.equal(context.fileWsMountLine(ws, { line: 12 }), 12);
  assert.equal(context.fileWsMountLine(ws, { line: 12, restore: true }), 12);
  assert.equal(context.fileWsMountLine({ ...ws, line: '7' }, {}), '7', 'a line parsed from the hash is a string');
  assert.equal(context.fileWsMountLine(ws, {}), null, 'no line at all: the editor stays at the top');
  // The reader left the file at line 200 (fileWsCloseEditor remembers it).
  storage.set('aiconvo.cursor:/tmp/doc.md', '200');
  assert.equal(context.fileWsMountLine(ws, { line: 12 }), 12, 'a fresh open from a link still honors the link');
  assert.equal(context.fileWsMountLine(ws, { line: 12, restore: true }), 200, 'back/forward returns to where the reader was');
  assert.equal(context.fileWsMountLine(ws, {}), 200, 'no line asked: the memory applies as before');
  storage.set('aiconvo.cursor:/tmp/doc.md', '1');
  assert.equal(context.fileWsMountLine(ws, { line: 12, restore: true }), 12, 'line 1 is not a memory worth returning to');
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
