'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureRewriteRequest, PROMPT, CUSTOM_TYPE } = require('../pisdk-rewrite');
const reply = (text = 'Complete original explanation.', extra = {}) => ({
  role: 'assistant', provider: 'fixture', model: 'one', api: 'fixture', timestamp: 1,
  content: [{ type: 'text', text }], usage: { input: 4, output: 5, cacheRead: 100 }, stopReason: 'stop', ...extra,
});
function stream(result) {
  return { result: () => Promise.resolve(result), async *[Symbol.asyncIterator]() { yield { type: 'done', message: result }; } };
}
function fixture({ answer = reply(), rewrite = reply('Plain full explanation.'), onRewrite, prompt } = {}) {
  const entries = [], events = [], calls = [];
  const append = e => { e.id = String(entries.length + 1); entries.push(e); return e.id; };
  const model = { provider: 'fixture', id: 'one' };
  const session = {
    model, isIdle: true, getAvailableThinkingLevels: () => ['high', 'minimal', 'low'],
    agent: { state: { messages: [], thinkingLevel: 'high' }, streamFunction: async (m, c, o) => {
      calls.push({ model: m, context: c, options: o });
      if (calls.length > 1) { await onRewrite?.(session, o); return stream(rewrite); }
      return stream(answer);
    } },
    sessionManager: { getBranch: () => entries.slice(), getLeafId: () => entries.at(-1)?.id,
      appendMessage: message => append({ type: 'message', message }),
      appendCustomEntry: (customType, data) => append({ type: 'custom', customType, data }),
    },
    async sendCustomMessage(message, opts) {
      assert.equal(opts.triggerTurn, false);
      append({ type: 'custom_message', ...message });
      session.agent.state.messages.push({ role: 'custom', ...message });
    },
  };
  const capture = captureRewriteRequest(session, prompt);
  const context = { systemPrompt: 'Exact existing system prompt', messages: [{ role: 'user', content: 'Explain everything' }], tools: [{ name: 'bash', parameters: { type: 'object' } }] };
  const options = { reasoning: 'high', sessionId: 'same-cache-key', transport: 'sse', onPayload: () => {}, signal: new AbortController().signal };
  const prepare = async () => {
    await (await session.agent.streamFunction(model, context, options)).result();
    session.sessionManager.appendMessage(answer);
    session.agent.state.messages.push(answer);
    capture.restore();
  };
  return { session, capture, entries, calls, events, context, options, prepare, run: signal => capture.run({ signal, emit: e => events.push(e) }) };
}

test('same model, exact prefix, schemas and session key; reasoning override never changes user settings', async () => {
  const f = fixture(); await f.prepare(); await f.run();
  assert.equal(f.calls.length, 2);
  const [first, second] = f.calls;
  assert.equal(second.model, first.model);
  assert.equal(second.context.systemPrompt, first.context.systemPrompt);
  assert.equal(second.context.tools, first.context.tools);
  assert.deepEqual(second.context.messages.slice(0, -2), first.context.messages);
  assert.deepEqual(second.context.messages.at(-2), f.entries[0].message);
  assert.equal(second.context.messages.at(-1).content[0].text, PROMPT);
  assert.equal(second.options.reasoning, 'minimal');
  assert.equal(second.options.sessionId, first.options.sessionId);
  assert.equal(second.options.onPayload, first.options.onPayload);
  assert.equal(f.session.agent.state.thinkingLevel, 'high');
  assert.equal(f.options.reasoning, 'high');
  assert.equal(f.entries[1].type, 'custom_message');
  assert.equal(f.entries[1].display, false);
  assert.equal(f.entries[1].customType, CUSTOM_TYPE);
  assert.equal(f.entries[1].content, PROMPT);
  assert.equal(f.entries[2].message.aiconvoRewrite.sourceEntryId, f.entries[0].id);
  assert.equal(f.session.agent.state.messages.at(-1), f.entries[2].message);
  assert.deepEqual(f.events.map(e => e.state), ['running', 'ready']);
});

test('custom prompt is sent exactly and preserved with the rewrite request', async () => {
  const prompt = 'Explain in French.\nKeep every example. <details>';
  const f = fixture({ prompt }); await f.prepare(); await f.run();
  assert.equal(f.calls[1].context.messages.at(-1).content[0].text, prompt);
  assert.equal(f.entries[1].content, prompt);
});

test('blank rewrite prompt falls back to the default', async () => {
  const f = fixture({ prompt: '   ' }); await f.prepare(); await f.run();
  assert.equal(f.calls[1].context.messages.at(-1).content[0].text, PROMPT);
});

test('rewrite prompt settings survive both model selection modes', () => {
  const { normalizeSettings } = require('../settings');
  for (const usePiDefault of [true, false]) {
    const custom = normalizeSettings({ usePiDefault, simplifyPrompt: 'Write in French.\nKeep examples.' });
    assert.equal(normalizeSettings(custom).simplifyPrompt, custom.simplifyPrompt);
    assert.equal(custom.simplifyPrompt, 'Write in French.\nKeep examples.');
    for (const simplifyPrompt of [undefined, '', '  ', null, 123]) {
      assert.equal(normalizeSettings({ usePiDefault, simplifyPrompt }).simplifyPrompt, PROMPT);
    }
  }
});

test('no reasoning models use off; no recursive pass; unsupported adapters fail closed', async () => {
  const f = fixture(); f.session.getAvailableThinkingLevels = () => ['off'];
  await f.prepare(); await f.run(); await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.reasoning, undefined);
  assert.equal(captureRewriteRequest({}), null);
});

test('tool calls cannot execute and their raw result is preserved outside the next model context', async () => {
  const bad = reply('', { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash', id: 'danger', arguments: { command: 'do not execute' } }] });
  const f = fixture({ rewrite: bad }); await f.prepare(); await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.events.at(-1).state, 'failed');
  assert.equal(f.entries.at(-1).data.response, bad);
  assert.equal(f.session.agent.state.messages.at(-1).role, 'custom');
  assert.equal(f.entries.filter(e => e.type === 'message').length, 1);
});

for (const stopReason of ['error', 'aborted', 'length']) test('does not rewrite an original ending with ' + stopReason, async () => {
  const f = fixture({ answer: reply('Partial.', { stopReason }) }); await f.prepare(); await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.entries.length, 1);
});

test('a truncated or empty rewrite never replaces the complete original', async () => {
  for (const rewrite of [reply('Partial.', { stopReason: 'length' }), reply('')]) {
    const f = fixture({ rewrite }); await f.prepare(); await f.run();
    assert.equal(f.events.at(-1).state, 'failed');
    assert.equal(f.entries.filter(e => e.type === 'message').length, 1);
  }
});

test('cancel is forwarded to the provider; no late reply is published', async () => {
  const controller = new AbortController();
  const f = fixture({ onRewrite: (_s, options) => { assert.equal(options.signal, controller.signal); controller.abort(); } });
  await f.prepare(); await f.run(controller.signal);
  assert.equal(f.events.at(-1).state, 'failed');
  assert.equal(f.entries.filter(e => e.type === 'message').length, 1);
});

test('changes to the model, branch or conversation supersede the optional rewrite', async () => {
  const f = fixture(); await f.prepare(); f.session.model = { provider: 'fixture', id: 'two' }; await f.run();
  assert.equal(f.calls.length, 1);
  const g = fixture({ onRewrite: session => session.sessionManager.appendMessage({ role: 'user', content: 'New question' }) });
  await g.prepare(); await g.run();
  assert.equal(g.events.at(-1).state, 'failed');
  assert.equal(g.entries.filter(e => e.message?.aiconvoRewrite).length, 0);
});
