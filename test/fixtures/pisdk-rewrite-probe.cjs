'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sdk = require('../../pisdk');
const { PROMPT, CUSTOM_TYPE } = require('../../pisdk-rewrite');
(async () => {
  const cwd = path.join(process.env.HOME, 'project'); await fs.mkdir(cwd, { recursive: true });
  const log = path.join(cwd, 'wire.jsonl');
  const target = { cwd, env: { ...process.env, FIXTURE_WIRE_LOG: log }, extraArgs: ['-e', path.join(__dirname, 'pisdk-probe.ts')] };
  const begun = await sdk.piBeginWarm(target); target.sessionPath = begun.file;
  const events = [];
  await sdk.piHeadlessRun(target, { provider: 'fixture', modelId: 'one', message: 'Explain this fully.', simplifyAnswers: true, onEvent: e => events.push(e) }).done;
  assert.deepEqual(events.filter(e => e.type === 'answer_rewrite').map(e => e.state), ['running', 'ready']);
  // The rewrite is not a second live answer that can replace words mid-read.
  assert.equal(events.filter(e => e.type === 'message_start' && e.message.role === 'assistant').length, 1);
  const entries = (await fs.readFile(begun.file, 'utf8')).trim().split('\n').map(JSON.parse);
  const assistants = entries.filter(e => e.type === 'message' && e.message.role === 'assistant');
  assert.equal(assistants.length, 2);
  assert.equal(assistants[1].message.aiconvoRewrite.sourceEntryId, assistants[0].id);
  const hidden = entries.find(e => e.customType === CUSTOM_TYPE);
  assert.equal(hidden.type, 'custom_message'); assert.equal(hidden.display, false); assert.equal(hidden.content, PROMPT);
  assert.equal(assistants[1].message.content[0].text, 'The full explanation in everyday words.');
  await sdk.piHeadlessRun(target, { message: 'Thanks. Continue.', simplifyAnswers: false }).done;
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].model, calls[1].model);
  assert.equal(calls[0].provider, calls[1].provider);
  assert.equal(calls[0].sessionId, calls[1].sessionId);
  assert.equal(calls[0].context.systemPrompt, calls[1].context.systemPrompt);
  assert.deepEqual(calls[0].context.tools, calls[1].context.tools);
  assert.deepEqual(calls[1].context.messages.slice(0, -2), calls[0].context.messages);
  assert.deepEqual(calls[1].context.messages.at(-2), assistants[0].message);
  assert.equal(calls[1].reasoning, undefined);
  // Following turns see the very same hidden request, not a deleted exchange.
  assert.deepEqual(calls[2].context.messages.slice(0, calls[1].context.messages.length), calls[1].context.messages);
  assert.equal(calls[2].context.messages.at(-2).content[0].text, 'The full explanation in everyday words.');
  console.log(JSON.stringify({ verified: true, requests: calls.length }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => sdk.stopAllWarmSessions());
