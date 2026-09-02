'use strict';
// Stall detection for one headless pi run (shared by pisdk.js and pirpc.js).
//
// The TUI never times a run out, and neither does aiconvo on wall-clock:
// long runs are legitimate. The only failure sign is SILENCE — pi emitting
// nothing for a long time. But not every silence is a failure:
//
//   - a pending extension dialog: someone has to answer it
//   - a tool that is still executing: a quiet build, a training job, a
//     `sleep 1200` — pi emits nothing until the tool returns, and that is
//     exactly how the TUI behaves too
//
// Silence while WAITING FOR THE MODEL (between message_start and message_end,
// or before the first tool/message of a turn) is different: a provider stream
// that emits nothing for 15 minutes is dead. That is the case this guards.

const DEFAULT_STALL_MS = 15 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 1000;

// Events that mean "no tool can still be running": a new model message or a
// new turn starts only after every tool of the previous step returned. They
// reset the in-flight set so a missed tool_execution_end cannot disable the
// guard for the rest of the run.
const TOOLS_FLUSH_EVENTS = new Set(['turn_start', 'message_start', 'agent_end', 'agent_settled']);

function createStallWatch(opts = {}) {
  const stallMs = opts.stallMs || DEFAULT_STALL_MS;
  const checkEveryMs = opts.checkEveryMs || CHECK_EVERY_MS;
  const now = opts.now || Date.now;
  const hasPendingUi = opts.hasPendingUi || (() => false);
  const tools = new Map(); // toolCallId → { name, since }
  let lastEventAt = now();
  let timer = null;

  function note(event) {
    lastEventAt = now();
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'tool_execution_start' && event.toolCallId) {
      tools.set(event.toolCallId, { name: event.toolName || '?', since: lastEventAt });
    } else if (event.type === 'tool_execution_end' && event.toolCallId) {
      tools.delete(event.toolCallId);
    } else if (TOOLS_FLUSH_EVENTS.has(event.type)) {
      tools.clear();
    }
  }

  // Why the current silence is legitimate, or null when it is not.
  function legitSilence() {
    if (hasPendingUi()) return 'dialog';
    if (tools.size) return 'tool';
    return null;
  }

  function isStalled() {
    return !legitSilence() && now() - lastEventAt > stallMs;
  }

  function stallError() {
    return new Error('stalled — no pi events for ' + Math.round(stallMs / 60000) + ' minutes while waiting for the model.');
  }

  // Rejects when the run stalls. Never resolves; race it against settle.
  function watch() {
    return new Promise((_, rej) => {
      const check = () => {
        if (isStalled()) return rej(stallError());
        timer = setTimeout(check, checkEveryMs);
      };
      timer = setTimeout(check, checkEveryMs);
    });
  }

  function stop() { clearTimeout(timer); timer = null; }

  return {
    note, watch, stop, isStalled, legitSilence,
    get lastEventAt() { return lastEventAt; },
    get runningTools() { return [...tools.entries()].map(([id, t]) => ({ id, ...t })); },
  };
}

module.exports = { createStallWatch, DEFAULT_STALL_MS };
