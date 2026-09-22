'use strict';

const CUSTOM_TYPE = 'chattering-answer-rewrite';
const PROMPT = 'Wait, I don’t get it. Re-explain your entire last answer simply, for a smart 16-year-old with no background in this subject. This is a full explanation, not a summary: don’t leave things out to make it simpler. Use everyday words. If a technical term is necessary, explain it when you first use it. Change how you explain things, not what you’re saying. Just rewrite the answer; don’t do any additional work or use tools.';
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const textOf = message => (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Capture the already-prepared provider context, not a newly assembled system
// prompt. The one-shot stream has no tool runner and cannot start another turn.
// Keeping the schemas does not grant it permission to execute anything.
function captureRewriteRequest(session, prompt = PROMPT) {
  prompt = typeof prompt === 'string' && prompt.trim() ? prompt : PROMPT;
  const agent = session.agent;
  if (typeof agent?.streamFunction !== 'function') return null;
  const original = agent.streamFunction;
  let latest;
  const wrapped = async (model, context, options) => {
    const request = { model, context: { ...context, messages: context.messages.slice() }, options: { ...options } };
    latest = request;
    const stream = await original(model, context, options);
    // result() and iteration are independent readers of Pi's event stream.
    stream.result().then(message => { request.answer = message; }, () => {});
    return stream;
  };
  agent.streamFunction = wrapped;
  return {
    restore() { if (agent.streamFunction === wrapped) agent.streamFunction = original; },
    async run({ signal, emit = () => {} } = {}) {
      const r = latest, sm = session.sessionManager;
      if (!r?.answer || signal?.aborted || !session.isIdle) return;
      const answer = r.answer;
      if (answer.stopReason !== 'stop' || !textOf(answer).trim() || answer.content.some(b => b.type === 'toolCall')) return;
      const last = [...sm.getBranch()].reverse().find(e => e.type === 'message');
      // Commands, later callbacks, or a branch move must not rewrite an old answer.
      if (last?.message?.role !== 'assistant' || JSON.stringify(last.message) !== JSON.stringify(answer)) return;
      if (session.model?.provider !== r.model.provider || session.model?.id !== r.model.id) return;
      const sourceEntryId = last.id;
      const levels = session.getAvailableThinkingLevels();
      const level = LEVELS.find(l => levels.includes(l)) || 'off';
      const details = { sourceEntryId, model: r.model.provider + '/' + r.model.id, reasoning: level };
      await session.sendCustomMessage({ customType: CUSTOM_TYPE, content: prompt, display: false, details }, { triggerTurn: false });
      const requestId = sm.getLeafId();
      const timestamp = session.agent.state.messages.at(-1)?.timestamp ?? Date.now();
      emit({ type: 'answer_rewrite', state: 'running', ...details });
      let response;
      try {
        const stream = await original(r.model, {
          ...r.context,
          messages: [...r.context.messages, answer, { role: 'user', content: [{ type: 'text', text: prompt }], timestamp }],
        }, { ...r.options, signal, reasoning: level === 'off' ? undefined : level });
        // Drain deltas so an unobserved stream cannot accumulate snapshots in
        // memory. The reader sees only the validated, complete replacement.
        for await (const _event of stream) { /* no live replacement */ }
        response = await stream.result();
        if (signal?.aborted) throw new Error('Simpler version cancelled');
        if (sm.getLeafId() !== requestId || !session.isIdle) throw new Error('Conversation advanced during the rewrite');
        if (response.stopReason !== 'stop' || !textOf(response).trim() || response.content.some(b => b.type === 'toolCall')) {
          throw new Error(response.errorMessage || (response.stopReason === 'toolUse' ? 'Rewrite tried to use tools; none were executed' : 'Rewrite did not finish'));
        }
        // A native assistant message preserves provider usage and reasoning blocks.
        const saved = { ...response, chatteringRewrite: { ...details, requestId } };
        const answerId = sm.appendMessage(saved);
        session.agent.state.messages = [...session.agent.state.messages, saved];
        emit({ type: 'answer_rewrite', state: 'ready', answerId, text: textOf(response), ...details });
      } catch (error) {
        // Preserve failed provider output for diagnosis without adding unpaired
        // tool calls (or a partial replacement) to the next model's context.
        sm.appendCustomEntry(CUSTOM_TYPE, { ...details, requestId, state: 'failed', error: String(error.message || error), response });
        emit({ type: 'answer_rewrite', state: 'failed', ...details });
      }
    },
  };
}

module.exports = { captureRewriteRequest, CUSTOM_TYPE, PROMPT };
