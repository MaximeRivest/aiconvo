'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileWithFileStdout } = require('../modelcatalog');

async function capture(t, file, args, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  const original = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => {
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = await new Promise(resolve => execFileWithFileStdout(file, args,
    { timeout: 5000, maxBuffer: 1024 * 1024, ...options },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.deepEqual(fs.readdirSync(dir), [], 'private output scratch must be removed on success and failure');
  return result;
}
test('immediate CLI exit retains all large stdout rather than a pipe prefix', async t => {
  const result = await capture(t, process.execPath, ['-e', 'process.stdout.write("x".repeat(500000));process.exit(0)']);
  assert.equal(result.error, null);
  assert.equal(result.stdout, 'x'.repeat(500000));
});
test('arguments remain literal rather than shell interpolation', async t => {
  const text = "spaces ' quotes \" $HOME $(printf bad); unicode 界";
  const result = await capture(t, process.execPath, ['-e', 'process.stdout.write(process.argv[1])', text]);
  assert.equal(result.error, null);
  assert.equal(result.stdout, text);
});
test('nonzero exit preserves failure and stderr, not successful partial stdout', async t => {
  const result = await capture(t, process.execPath, ['-e', 'process.stdout.write("partial");process.stderr.write("fixture error");process.exit(7)']);
  assert.equal(result.error.code, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'fixture error');
});
test('oversize output is rejected, not truncated and accepted', async t => {
  const result = await capture(t, process.execPath, ['-e', 'process.stdout.write("x".repeat(10000));process.exit(0)'], { maxBuffer: 100 });
  assert.equal(result.error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.equal(result.stdout, '');
});
test('timeout stops the owned test process and cleans output scratch', async t => {
  const result = await capture(t, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 });
  assert.ok(result.error);
  assert.equal(result.error.killed, true);
});
test('unavailable executable fails without leaking output scratch', async t => {
  const result = await capture(t, '/nonexistent/aiconvo-fixture', []);
  assert.ok(result.error);
  assert.equal(result.stdout, '');
});
