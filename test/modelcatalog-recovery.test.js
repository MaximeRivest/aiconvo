'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileWithFileStdout } = require('../modelcatalog');

function missingScratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-recovery-'));
  const original = process.env.TMPDIR;
  process.env.TMPDIR = path.join(root, 'missing');
  t.after(() => {
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
test('scratch allocation failure calls back asynchronously', async t => {
  missingScratch(t);
  let called = false;
  const result = new Promise(resolve => execFileWithFileStdout(process.execPath, [], {}, error => {
    called = true; resolve(error);
  }));
  assert.equal(called, false);
  assert.equal((await result).code, 'ENOENT');
});
test('catalog refresh can retry after scratch allocation failure', async t => {
  missingScratch(t);
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function listPiModels(');
  const end = source.indexOf('\nfunction piArgs()', start);
  assert.ok(start >= 0 && end > start);
  let attempts = 0;
  const list = vm.runInNewContext(source.slice(start, end) + '\nlistPiModels', {
    AUTO_MODELS_DISABLED: true, modelsCache: { models: [], text: '' }, modelsPending: null,
    execFileWithFileStdout: (...args) => { attempts++; execFileWithFileStdout(...args); },
  });
  assert.match((await list(true)).error, /ENOENT/);
  assert.match((await list(true)).error, /ENOENT/);
  assert.equal(attempts, 2, 'failed refresh must not poison the pending promise');
});
