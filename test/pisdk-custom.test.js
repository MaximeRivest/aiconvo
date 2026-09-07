'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installCustomPromptPreparation, waitForCustomTurns } = require('../pisdk-custom');

function fake(prepare) {
  const sent = [];
  const session = { isIdle: true, _systemPromptOverride: undefined, agent: { state: { systemPrompt: 'base' } },
    get systemPrompt() { return this.agent.state.systemPrompt; },
    getActiveToolNames: () => ['read'],
    setActiveToolsByName() { this.agent.state.systemPrompt = 'base'; },
    extensionRunner: { createCommandContext: () => ({ getSystemPromptOptions: () => ({ cwd: '/fixture' }) }), emitBeforeAgentStart: prepare },
    async sendCustomMessage(message, options) { sent.push({ message, options }); },
  };
  return { session, sent };
}
test('prepares mode and extension context without adding a user message', async () => {
  const { session, sent } = fake(async (_text, _images, base) => ({ systemPrompt: base + ' mode', messages: [{ customType: 'context', content: 'fixture' }] }));
  installCustomPromptPreparation(session);
  await session.sendCustomMessage({ customType: 'callback', content: 'returned' }, { triggerTurn: true });
  assert.equal(session.agent.state.systemPrompt, 'base mode');
  assert.equal(session._systemPromptOverride, 'base mode', 'SDK retry/compaction uses this per-turn override');
  assert.deepEqual(sent.map(s => s.message.customType), ['context', 'callback']);
  assert.equal(sent[0].options.triggerTurn, false);
});
test('cancellation during preparation cannot start a model turn afterward', async () => {
  let resolve, cancelled = false, ended = 0;
  const { session, sent } = fake(() => new Promise(r => { resolve = r; }));
  installCustomPromptPreparation(session, { begin: () => () => cancelled, end: () => ended++ });
  const running = session.sendCustomMessage({ customType: 'callback', content: 'returned' }, { triggerTurn: true });
  await new Promise(r => setImmediate(r)); cancelled = true; resolve({ systemPrompt: 'mode' });
  await assert.rejects(running, /cancelled/); await waitForCustomTurns(session);
  assert.equal(sent.length, 0); assert.equal(ended, 1);
});
test('fails closed when SDK prompt compatibility changes', async () => {
  const { session, sent } = fake(async () => ({ systemPrompt: 'mode' })); delete session._systemPromptOverride;
  installCustomPromptPreparation(session);
  await assert.rejects(session.sendCustomMessage({ content: 'result' }, { triggerTurn: true }), /Revalidate/);
  assert.equal(sent.length, 0);
});
test('next-turn messages and midstream follow-ups retain SDK queue semantics', async () => {
  const { session, sent } = fake(() => assert.fail('Unexpected re-preparation'));
  installCustomPromptPreparation(session);
  await session.sendCustomMessage({ content: 'next' }, { triggerTurn: true, deliverAs: 'nextTurn' });
  session.isIdle = false;
  await session.sendCustomMessage({ content: 'follow-up' }, { triggerTurn: true, deliverAs: 'followUp' });
  assert.deepEqual(sent.map(s => s.options.deliverAs), ['nextTurn', 'followUp']);
});
