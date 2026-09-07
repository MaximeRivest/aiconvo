'use strict';

const INSTALLED = Symbol('aiconvo.customPromptPreparation');

// Pi's sendCustomMessage(triggerTurn) starts the agent below prompt preparation.
// Reuse its public extension runner and command context to prepare an honest
// custom turn, without manufacturing a user message. One compatibility slot
// preserves the prepared prompt across SDK retries/compaction. Fail closed if
// that slot disappears; test this adapter against the installed SDK.
function installCustomPromptPreparation(session, { begin = () => () => false, end = () => {} } = {}) {
  if (session[INSTALLED]) return;
  const pending = new Set();
  session[INSTALLED] = { pending };
  const send = session.sendCustomMessage.bind(session);
  let preparation = Promise.resolve();
  session.sendCustomMessage = (message, options = {}) => {
    if (!options.triggerTurn || options.deliverAs === 'nextTurn' || !session.isIdle) return send(message, options);
    const cancelled = begin();
    let running;
    const ready = preparation.then(async () => {
      if (cancelled()) throw new Error('Custom turn cancelled before start');
      if (session.isIdle && session.extensionRunner) {
        const runner = session.extensionRunner;
        if (typeof runner.createCommandContext !== 'function' || typeof runner.emitBeforeAgentStart !== 'function' ||
          typeof session.setActiveToolsByName !== 'function' || !('_systemPromptOverride' in session)) {
          throw new Error('This Pi SDK cannot prepare custom turns safely. Revalidate the custom-prompt adapter.');
        }
        // An idle run has cleared the previous per-turn override. Rebuild the
        // base using the current tool set, rather than append a mode twice.
        session.setActiveToolsByName(session.getActiveToolNames());
        const base = session.systemPrompt;
        const baseOptions = runner.createCommandContext().getSystemPromptOptions();
        const text = typeof message.content === 'string' ? message.content : (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        const result = await runner.emitBeforeAgentStart(text, undefined, base, baseOptions);
        if (cancelled()) throw new Error('Custom turn cancelled during preparation');
        for (const extra of result?.messages || []) await send(extra, { triggerTurn: false });
        session._systemPromptOverride = result?.systemPrompt;
        session.agent.state.systemPrompt = result?.systemPrompt ?? base;
      }
      if (cancelled()) throw new Error('Custom turn cancelled before provider work');
      // Capture, but do not await, the run while holding the preparation lock.
      // Another event can then enter the normal SDK follow-up queue.
      running = send(message, options);
      running.catch(() => {});
    });
    preparation = ready.catch(() => {});
    const completed = ready.then(() => running).finally(() => { pending.delete(completed); end(); });
    pending.add(completed);
    return completed;
  };
}
async function waitForCustomTurns(session) {
  const pending = session[INSTALLED]?.pending;
  while (pending?.size) await Promise.allSettled([...pending]);
}
module.exports = { installCustomPromptPreparation, waitForCustomTurns };
