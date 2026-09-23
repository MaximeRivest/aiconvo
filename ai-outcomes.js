/* What became of AI proposals in a file, reported to the server
   (/api/ai-feedback; the record's shape is ai-feedback.js).

   Two sources, one record each:
   - an AI command in a document (Ctrl+J): the editor reports every
     command's end (ai.onOutcome). One placed in the text for review
     ('review') is recorded when its review ends, with what was kept;
   - an ask from the file's ask box (Ctrl+K): recorded when its run
     settles (applied directly) or when its review ends.
   Reviews end through the editor's review.onResolved; the proposal's
   `meta` says which source it came from.

   Globals: LineDiff (linediff.js). */
'use strict';

const AI_KEEPALIVE_MAX = 60000;       // fetch keepalive allows ~64 KB: a page that closes still reports
const aiCommandsInReview = new Map(); // op id → {path, outcome}: a command waiting for its review's end
const AI_MODE_KEY = 'chattering.aiCommands.mode';

function aiFeedbackPost(record) {
  let body;
  try { body = JSON.stringify(record); } catch { return; }
  fetch('/api/ai-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < AI_KEEPALIVE_MAX })
    .then(r => (r.ok ? null : r.json().then(j => console.warn('AI feedback not kept:', j.error))))
    .catch(e => console.warn('AI feedback not kept:', e.message));
}

// The review part of a record, from the editor's review outcome.
function aiReviewPart(outcome) {
  return { decision: outcome.decision, how: outcome.how, hunks: outcome.hunks, ms: outcome.resolvedAt - outcome.startedAt };
}

// How AI command answers arrive in documents: 'suggest' (beside the text)
// or 'review' (in the text, to accept or reject). Per device; the command
// box switches it.
const aiCommandMode = {
  get() { try { return localStorage.getItem(AI_MODE_KEY) === 'review' ? 'review' : 'suggest'; } catch { return 'suggest'; } },
  set(mode) { try { localStorage.setItem(AI_MODE_KEY, mode === 'review' ? 'review' : 'suggest'); } catch {} },
};

// An AI command ended (the editor's ai.onOutcome).
function aiCommandOutcome(path, o) {
  if (o.decision === 'review') { aiCommandsInReview.set(o.op, { path, outcome: o }); return; }
  aiFeedbackPost(aiCommandRecord(path, o, o.decision, null));
}

function aiCommandRecord(path, o, decision, review) {
  const shown = o.answers[o.shown] || null;
  return {
    kind: 'command', path, mode: o.mode, decision, ms: o.ms, model: shown && shown.model,
    command: o.command, label: o.label, instruction: o.instruction, scope: o.scope, commandKind: o.kind, language: o.language,
    target: o.target, before: o.before, after: o.after, answers: o.answers, shown: o.shown, final: o.final,
    review,
  };
}

// The editor's review option for a file: each decided proposal becomes a record.
function aiReviewHost(path) {
  return {
    onResolved(outcome) {
      const meta = outcome.meta || {};
      if (meta.source === 'ai-command') {
        const waiting = aiCommandsInReview.get(meta.op);
        aiCommandsInReview.delete(meta.op);
        // The command's own outcome comes first (the same update that placed
        // the answer); without it, the proposal's meta is what is known.
        const o = waiting ? waiting.outcome : { op: meta.op, command: meta.command, label: meta.label, instruction: meta.instruction, answers: [{ text: outcome.hunks.map(h => h.proposed).join(''), model: meta.model, status: 'ready' }], shown: 0, mode: 'review' };
        aiFeedbackPost(aiCommandRecord(waiting ? waiting.path : path, o, outcome.decision, aiReviewPart(outcome)));
      } else if (meta.source === 'ask') {
        aiFeedbackPost(aiAskRecord(path, meta, { mode: 'review', decision: outcome.decision, review: aiReviewPart(outcome) }));
      }
    },
  };
}

// An ask's record. `ask`: what the ask box sent and got back (run.info
// plus the run's ids).
function aiAskRecord(path, ask, fields) {
  return {
    kind: 'ask', path, prompt: ask.prompt, jobId: ask.jobId, conversation: ask.key, created: !!ask.created,
    model: ask.model || null, thinking: ask.thinking || null, include: ask.include || null, selection: ask.selection || null,
    ...fields,
  };
}

// An ask's run settled with its changes applied (no review), or with no
// change at all: the record now, with the change as a diff.
function aiAskSettled(path, ask, { changed, failed, before, after, status }) {
  const diff = changed && typeof LineDiff !== 'undefined' && before != null && after != null ? LineDiff.unifiedDiff(before, after, { context: 2 }).text : null;
  aiFeedbackPost(aiAskRecord(path, ask, {
    mode: ask.mode === 'review' ? 'review' : 'apply',
    decision: failed && !changed ? 'failed' : changed ? 'applied' : 'unchanged',
    diff, status,
  }));
}
