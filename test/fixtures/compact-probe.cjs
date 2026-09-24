'use strict';
// Compacts a real Pi session through both engines (in-process SDK and the
// RPC child), with the fixture provider. Prints one JSON line.
const fs = require('node:fs/promises');
const path = require('node:path');
const root = process.env.HOME;
const fixture = path.join(__dirname, 'pisdk-probe.ts');
async function conversation(engine, name) {
  const cwd = path.join(root, name); await fs.mkdir(cwd, { recursive: true });
  const target = { cwd, env: process.env, extraArgs: ['-e', fixture] };
  const begun = await engine.piBeginWarm(target);
  const at = { ...target, sessionPath: begun.file };
  for (const message of ['first question', 'second question', 'third question']) {
    const h = engine.piHeadlessRun(at, { provider: 'fixture', modelId: 'one', message });
    await h.done;
  }
  const out = await engine.piCompact(at, 'keep the questions');
  const entries = (await fs.readFile(begun.file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const compaction = entries.find(e => e.type === 'compaction');
  // The conversation goes on from the summary.
  const after = engine.piHeadlessRun(at, { provider: 'fixture', modelId: 'one', message: 'after compaction' });
  await after.done;
  const replies = (await fs.readFile(begun.file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(e => e.type === 'message' && e.message.role === 'assistant').length;
  return { out, compaction: compaction ? { summary: compaction.summary, tokensBefore: compaction.tokensBefore } : null, replies, file: begun.file };
}
(async () => {
  const sdk = require('../../pisdk');
  const rpc = require('../../pirpc');
  const result = { sdk: await conversation(sdk, 'sdk'), rpc: await conversation(rpc, 'rpc') };
  sdk.stopAllWarmSessions(); rpc.stopAllWarmSessions();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
})().catch(error => { process.stdout.write(JSON.stringify({ error: String(error && error.stack || error) }) + '\n'); process.exit(1); });
