'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const loader = app.slice(app.indexOf('const MRMD_DOC_SRC ='), app.indexOf('// Measure the app theme'));
function harness() {
  const scripts = [];
  const context = vm.createContext({ window: {}, document: {
    createElement: () => ({ remove() { this.removed = true; } }),
    head: { appendChild(script) { scripts.push(script); } },
  } });
  vm.runInContext(loader, context);
  return { scripts, context, load: () => context.loadMrmdDocument() };
}

test('editor bundle URLs have matching server routes and versioned artifacts', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const [, url] of loader.matchAll(/const MRMD_DOC_(?:FALLBACK_)?SRC = '([^']+)'/g)) {
    assert.ok(server.includes(`'${url}':`), `missing route for ${url}`);
    assert.ok(fs.statSync(path.join(root, url)).size > 100000, `missing bundle ${url}`);
  }
});

test('simultaneous opens share one bundle load, then reuse the loaded editor', async () => {
  const { load, scripts, context } = harness();
  const first = load();
  assert.equal(load(), first);
  assert.equal(scripts.length, 1);
  context.window.mrmdDocument = { version: 'test' };
  scripts[0].onload();
  assert.equal(await first, context.window.mrmdDocument);
  assert.equal(await load(), context.window.mrmdDocument);
  assert.equal(scripts.length, 1);
});

test('old running servers fall back without blocking document opening', async () => {
  const { load, scripts, context } = harness();
  const promise = load();
  scripts[0].onerror();
  assert.equal(scripts[0].removed, true);
  assert.equal(scripts.length, 2);
  assert.notEqual(scripts[0].src, scripts[1].src);
  context.window.mrmdDocument = { version: 'previous' };
  scripts[1].onload();
  assert.equal(await promise, context.window.mrmdDocument);
});

test('failed primary and fallback loads report an error and allow retry', async () => {
  const { load, scripts } = harness();
  const promise = load();
  scripts[0].onerror();
  scripts[1].onerror();
  await assert.rejects(promise, /bundle failed to load/);
  const retry = load();
  assert.notEqual(retry, promise);
  assert.equal(scripts.length, 3);
  scripts[2].onload();
  await retry;
});
