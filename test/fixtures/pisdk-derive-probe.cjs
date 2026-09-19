'use strict';
// Verifies piDeriveAt against the installed SDK with the fixture provider:
// one raw completion whose context is the conversation's own prepared
// context (same system prompt, same tool schemas, history through the
// answer) plus the derivation prompt; the real session file is untouched;
// the snapshot session is gone afterwards.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sdk = require('../../pisdk');
(async () => {
  const cwd = path.join(process.env.HOME, 'project'); await fs.mkdir(cwd, { recursive: true });
  const log = path.join(cwd, 'wire.jsonl');
  const target = { cwd, env: { ...process.env, FIXTURE_WIRE_LOG: log }, extraArgs: ['-e', path.join(__dirname, 'pisdk-probe.ts')] };
  const begun = await sdk.piBeginWarm(target); target.sessionPath = begun.file;
  await sdk.piHeadlessRun(target, { provider: 'fixture', modelId: 'one', message: 'Explain this fully.', simplifyAnswers: false }).done;
  const before = await fs.readFile(begun.file, 'utf8');
  const entries = before.trim().split('\n').map(JSON.parse);
  const answer = entries.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1);
  assert.ok(answer, 'the fixture answered');
  sdk.stopWarmSession(begun.file);

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'derive-probe-'));
  const forked = await sdk.piForkAt({ sessionPath: begun.file, cwd }, answer.id, { dir: stage });
  assert.equal(path.dirname(forked.file), stage, 'the fork lands in the private staging dir, not beside the conversation');
  const result = await sdk.piDeriveAt({ sessionPath: forked.file, cwd, env: target.env, extraArgs: target.extraArgs }, { prompt: 'Turn your last answer into a notebook.' });
  await fs.rm(stage, { recursive: true, force: true });

  assert.equal(result.text, 'Fixture reply.');
  assert.equal(result.model, 'fixture/one');
  assert.equal(await fs.readFile(begun.file, 'utf8'), before, 'the real conversation is untouched');
  assert.ok(!fsSync.existsSync(forked.file), 'the snapshot is gone');
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2, 'exactly one derivation request reached the provider');
  const [turn, derive] = calls;
  assert.equal(derive.context.systemPrompt, turn.context.systemPrompt);
  assert.deepEqual(derive.context.tools, turn.context.tools);
  assert.deepEqual(derive.context.messages.slice(0, turn.context.messages.length), turn.context.messages);
  assert.deepEqual(derive.context.messages.at(-2).content, answer.message.content);
  const last = derive.context.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(typeof last.content === 'string' ? last.content : last.content.map(b => b.text).join(''), 'Turn your last answer into a notebook.');
  assert.equal(derive.reasoning, undefined, 'lowest reasoning: none for a model without thinking');
  assert.equal(sdk.listWarmSessions().length, 0, 'no worker left behind');
  console.log(JSON.stringify({ verified: true, requests: calls.length }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => sdk.stopAllWarmSessions());
