'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInternalModel } = require('../internal-model');
for (const mode of ['success', 'cancel', 'timeout']) test('owned group cleanup after ' + mode + ': worker exits, descendant ignores TERM and closes stdio', { timeout: 12000, skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-test-'));
  const agent = path.join(root, 'agent'); fs.mkdirSync(agent);
  const capture = path.join(root, 'descendant.json'), controller = new AbortController();
  const work = runInternalModel({ text: 'synthetic', images: [] }, 'synthetic', { agentDir: agent,
    settings: { provider: 'fixture', model: 'fixture' }, workerFile: path.join(__dirname, 'fixtures/model-descendant.cjs'),
    signal: controller.signal, timeoutMs: mode === 'timeout' ? 3000 : 10000,
    env: { DESCENDANT_CAPTURE: capture, DESCENDANT_MODE: mode } });
  // Attach rejection handling immediately; cancellation is triggered only after
  // the exact stubborn descendant has installed its TERM handler and closed IPC.
  const outcome = work.then(value => ({ value }), error => ({ error }));
  t.after(async () => { controller.abort(); await outcome; fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; !fs.existsSync(capture) && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(capture));
  const descendant = JSON.parse(fs.readFileSync(capture));
  if (mode === 'cancel') controller.abort();
  const result = await outcome;
  if (mode === 'success') assert.equal(result.value.content[0].text, 'complete');
  else assert.match(result.error.message, mode === 'cancel' ? /cancelled/ : /timed out/);
  try {
    const stat = fs.readFileSync('/proc/' + descendant.pid + '/stat', 'utf8');
    assert.ok(['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]), 'descendant must not remain alive');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.equal(fs.existsSync(descendant.cwd), false, 'temporary state removed only after the whole group stops');
});
