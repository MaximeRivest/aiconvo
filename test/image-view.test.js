'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function viewer(fetcher) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, attrs: {}, classes: new Set(),
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this[k]; },
      classList: { toggle(k, on) { on ? element(id).classes.add(k) : element(id).classes.delete(k); } },
    });
    return elements.get(id);
  };
  const created = [], revoked = [], remembered = [];
  class BlobURL extends URL {
    static createObjectURL(blob) { const url = 'blob:' + created.length; created.push({ url, blob }); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const state = { path: '/tmp/a & b.PNG', kind: 'image', back: 'conversation', touched: {} };
  const context = vm.createContext({ window: {}, document: { addEventListener() {} }, URL: BlobURL, URLSearchParams, AbortController,
    fetch: fetcher || (async () => ({ ok: true, blob: async () => 'picture' })),
    $: element, esc: s => String(s), fgAttr: s => String(s), state,
    fbConversationHash: s => s, recordRecentFile: p => remembered.push(p), clearInterval,
  });
  for (const file of ['filesmode.js', 'live-file.js', 'file-viewers.js']) vm.runInContext(fs.readFileSync(require.resolve('../' + file), 'utf8'), context);
  vm.runInContext('fileWs = state', context);
  return { context, state, element, created, revoked, remembered };
}

test('image routing is case-insensitive and leaves text, SVG and other binary files unchanged', () => {
  const { context } = viewer();
  for (const ext of ['PNG', 'jpg', 'jpeg', 'GIF', 'webp', 'avif', 'bmp', 'ico']) assert.equal(context.fileWsKind('/a.' + ext), 'image');
  assert.equal(context.fileWsKind('/a.md'), 'md');
  for (const ext of ['svg', 'html', 'js']) assert.equal(context.fileWsKind('/a.' + ext), 'code');
  for (const ext of ['mp4', 'm4v', 'webm', 'ogv', 'mov']) assert.equal(context.fileWsKind('/a.' + ext), 'video');
  assert.equal(context.fileWsKind('/a.PDF'), 'pdf');
});

test('images mount without a text editor, preserve the path, and offer fit/actual sizing', async () => {
  let request;
  const v = viewer(async (url, options) => { request = { url, options }; return { ok: true, blob: async () => 'picture' }; });
  await v.context.fileWsMountBody(v.state, {});
  assert.equal(new URL(request.url, 'http://local').searchParams.get('path'), v.state.path);
  assert.equal(request.options.cache, 'no-store');
  assert.equal(v.state.readOnly, true);
  assert.equal(v.state.editor, undefined);
  assert.doesNotMatch(v.element('ffCompare').innerHTML, /id="(?:fwSave|docSave|liveAsk|liveHistory)"/);
  const image = v.element('fileImage'); image.naturalWidth = 2400; image.naturalHeight = 1200;
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(v.element('imageMessage').hidden, true);
  assert.match(v.element('docStatus').textContent, /2400 × 1200/);
  assert.deepEqual(v.remembered, [v.state.path]);
  v.element('imageActual').onclick();
  assert.equal(image.style.width, '2400px');
  assert.equal(v.element('imageActual').attrs['aria-pressed'], 'true');
  assert.equal(v.element('imageStage').classes.has('lf-image-actual'), true);
  v.element('imageFit').onclick();
  assert.equal(image.style.width, '');
  assert.equal(v.element('imageFit').attrs['aria-pressed'], 'true');
  v.context.closeFileWorkspace();
  assert.equal(request.options.signal.aborted, true);
  assert.deepEqual(v.revoked, ['blob:0']);
  assert.equal(image.src, undefined);
});

test('reload releases the old image and a failed decode leaves a readable error', async () => {
  const v = viewer();
  await v.context.liveFileMountImage(v.state);
  await v.element('imageReload').onclick();
  assert.deepEqual(v.revoked, ['blob:0']);
  assert.equal(v.created.length, 2);
  v.element('fileImage').onerror();
  assert.match(v.element('imageMessage').textContent, /could not display/);
  assert.equal(v.element('imageFit').disabled, true);
  assert.deepEqual(v.remembered, []);
});

test('access, size and network failures remain visible; reload can recover', async () => {
  let tries = 0;
  const v = viewer(async () => {
    tries++;
    if (tries === 1) return { ok: false, status: 404, json: async () => ({ error: 'file is too large to open here' }) };
    if (tries === 2) throw Error('Network unavailable');
    return { ok: true, blob: async () => 'picture' };
  });
  await v.context.liveFileMountImage(v.state);
  assert.equal(v.element('imageMessage').textContent, 'file is too large to open here');
  await v.element('imageReload').onclick();
  assert.equal(v.element('imageMessage').textContent, 'Network unavailable');
  await v.element('imageReload').onclick();
  assert.equal(v.created.length, 1);
});

test('navigation while downloading cannot create a stale image or leak its URL', async () => {
  let resolve;
  const v = viewer(() => new Promise(r => resolve = r));
  const mounting = v.context.liveFileMountImage(v.state);
  v.context.closeFileWorkspace();
  resolve({ ok: true, blob: async () => 'late image' });
  await mounting;
  assert.equal(v.created.length, 0);
  assert.deepEqual(v.remembered, []);
});
