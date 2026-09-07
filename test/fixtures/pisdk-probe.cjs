'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sdk = require('../../pisdk');
const root = process.env.HOME;
const fixture = path.join(__dirname, 'pisdk-probe.ts');
const modes = path.resolve(__dirname, '../../extensions/modes.ts');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(20); } throw new Error('Callback timeout'); }
(async () => {
  const targets = [];
  for (const name of ['first', 'second']) {
    const cwd = path.join(root, name); await fs.mkdir(cwd, { recursive: true });
    const mode = path.join(cwd, 'mode.json');
    await fs.writeFile(mode, JSON.stringify({ key: name, label: name, opener: 'Run the fixture.', tools: ['bash'] }));
    targets.push({ cwd, env: process.env, extraArgs: ['-e', fixture, '-e', modes, '--prompt-mode-file', mode] });
  }
  const begun = await Promise.all(targets.map(t => sdk.piBeginWarm(t)));
  assert.notEqual(begun[0].pid, begun[1].pid);
  const observed = await Promise.all(begun.map(async (b, i) => {
    const events = [];
    const h = sdk.piHeadlessRun({ ...targets[i], sessionPath: b.file }, { provider: 'fixture', modelId: 'one', message: 'capture environment', onEvent: e => events.push(e) });
    await h.done;
    const tool = events.find(e => e.type === 'tool_execution_end');
    assert.ok(tool, 'real SDK executed the fixture tool');
    const value = JSON.parse(tool.result.content.find(b => b.type === 'text').text.trim());
    assert.equal(value.session, b.sessionId); assert.equal(value.fixture, b.sessionId);
    assert.equal(value.mode, i ? 'second' : 'first');
    return value;
  }));
  const notices = []; let dialog;
  dialog = sdk.piHeadlessRun({ ...targets[0], sessionPath: begun[0].file }, { message: '/probe-dialog', onEvent: e => {
    if (e.method === 'select') dialog.respondUi(e.id, { value: 'yes' });
    if (e.method === 'notify') notices.push(e.message);
  } });
  await dialog.done; assert.ok(notices.includes('choice:yes'));
  const callbacks = [];
  sdk.setAutonomousRunHandler((info, handle) => { const run = { info, handle, events: [] }; callbacks.push(run); return e => run.events.push(e); });
  const later = sdk.piHeadlessRun({ ...targets[0], sessionPath: begun[0].file }, { message: '/probe-later' });
  await later.done; await until(() => callbacks.length === 1); await callbacks[0].handle.done;
  assert.equal(callbacks[0].info.sessionPath, begun[0].file);
  assert.ok(callbacks[0].events.some(e => e.type === 'agent_start'));
  assert.ok(callbacks[0].events.some(e => e.type === 'agent_settled'));
  sdk.stopWarmSession(begun[1].file);
  const customEvents = [];
  const custom = sdk.piHeadlessRun({ ...targets[1], sessionPath: begun[1].file, sessionEnv: { FIXTURE_EXPECT_MODE: 'second' } }, { onEvent: e => customEvents.push(e), customMessage: { customType: 'fixture-direct', content: 'Review fixture results.', details: { deliveryId: 'fixture' } } });
  await custom.done;
  assert.ok(!customEvents.some(e => e.type === 'message_end' && e.message?.stopReason === 'error'), 'cold callback preserves the mode');
  const raw = await fs.readFile(begun[1].file, 'utf8');
  assert.ok(raw.split('\n').some(line => { try { const e = JSON.parse(line); return e.type === 'custom_message' && e.customType === 'fixture-direct' && e.details.deliveryId === 'fixture'; } catch { return false; } }));
  console.log(JSON.stringify({ observed, isolatedPids: begun.map(b => b.pid), dialog: notices, callbacks: callbacks.length, customMessagePersisted: true }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { sdk.stopAllWarmSessions(); });
