'use strict';
// What became of AI proposals in files: every AI command in a document
// (Ctrl+J) and every ask from a file's ask box (Ctrl+K) — what was asked,
// what the model answered, and what the person kept: accepted, rejected,
// edited before accepting, discarded. One JSON line per outcome, kept for
// improving the prompts and the choice of models later (evaluation sets,
// preference pairs, prompt optimization).
//
// The page reports what it saw (the editor's outcome); the server adds
// what only it knows (who, the agent's own answer, the prompt's version)
// and writes the line. This module is the record's shape: it validates and
// bounds what a page may send, so a record is always well-formed and never
// huge. Pure, except FeedbackLog, which appends to one file.

const fs = require('node:fs');
const path = require('node:path');

const TEXT_MAX = 64 * 1024;   // one text in a record (a target, an answer, a region)
const SHORT_MAX = 4000;       // a prompt, an instruction, a label
const ANSWERS_MAX = 12;
const HUNKS_MAX = 200;

const KINDS = new Set(['command', 'ask']);
const MODES = new Set(['suggest', 'review', 'apply']);
const DECISIONS = new Set(['accepted', 'rejected', 'edited', 'mixed', 'left', 'discarded', 'stopped', 'stale', 'replaced', 'closed', 'applied', 'unchanged', 'failed']);
const HUNK_DECISIONS = new Set(['accepted', 'rejected', 'edited', 'left']);
const ANSWER_STATUS = new Set(['ready', 'error', 'loading']);

// A text, cut at max with a marker saying how much was cut.
function text(value, max = TEXT_MAX) {
  if (value == null) return null;
  const s = String(value);
  return s.length <= max ? s : s.slice(0, max) + `\n… [${s.length - max} more characters not kept]`;
}
const oneOf = (set, value, fallback = null) => (set.has(value) ? value : fallback);
const count = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : null);

function hunksOf(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, HUNKS_MAX).map(h => ({
    before: text(h && h.before) ?? '',
    proposed: text(h && h.proposed) ?? '',
    final: text(h && h.final) ?? '',
    decision: oneOf(HUNK_DECISIONS, h && h.decision, 'left'),
  }));
}

/**
 * The page's report, validated and bounded. Throws on a report that is not
 * one (wrong kind, no decision). Fields the page may not set (user, time,
 * the agent's answer) are not read here.
 * @returns {object} the record without the server's fields
 */
function normalizeReport(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const kind = oneOf(KINDS, r.kind);
  if (!kind) throw new Error('kind must be command or ask');
  const decision = oneOf(DECISIONS, r.decision);
  if (!decision) throw new Error('unknown decision: ' + String(r.decision));
  const out = {
    kind,
    mode: oneOf(MODES, r.mode, 'suggest'),
    decision,
    ms: count(r.ms),
    model: text(r.model, 200),
  };
  if (r.review && typeof r.review === 'object') {
    out.review = {
      decision: oneOf(DECISIONS, r.review.decision, 'left'),
      how: r.review.how === 'closed' ? 'closed' : 'reviewed',
      hunks: hunksOf(r.review.hunks) || [],
      ms: count(r.review.ms),
    };
  }
  if (kind === 'command') {
    Object.assign(out, {
      command: text(r.command, 100),
      label: text(r.label, 200),
      instruction: text(r.instruction, SHORT_MAX),
      scope: text(r.scope, 20),
      commandKind: text(r.commandKind, 20),
      language: text(r.language, 40),
      target: text(r.target),
      before: text(r.before, 4000),
      after: text(r.after, 2000),
      answers: Array.isArray(r.answers) ? r.answers.slice(0, ANSWERS_MAX).map(a => ({
        text: text(a && a.text) ?? '', model: text(a && a.model, 200), status: oneOf(ANSWER_STATUS, a && a.status, 'error'), error: text(a && a.error, 1000),
      })) : [],
      shown: count(r.shown),
      final: text(r.final),
    });
  } else {
    Object.assign(out, {
      prompt: text(r.prompt, SHORT_MAX * 4),
      jobId: text(r.jobId, 100),
      conversation: text(r.conversation, 500),
      created: r.created === true,
      thinking: text(r.thinking, 20),
      include: r.include && typeof r.include === 'object'
        ? { edits: r.include.edits !== false, asks: r.include.asks !== false, memory: r.include.memory === true } : null,
      selection: r.selection && typeof r.selection === 'object'
        ? { line: count(r.selection.line), range: Array.isArray(r.selection.range) ? r.selection.range.slice(0, 2).map(count) : null } : null,
      diff: text(r.diff),
      status: text(r.status, 200),
    });
  }
  return out;
}

/** The records, one JSON line each, appended to one file (created 0600). */
class FeedbackLog {
  constructor(file) { this.file = file; }
  append(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  /** The newest `limit` records (a whole-file read: the log is for occasional export). */
  recent(limit = 50) {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const lines = raw.split('\n').filter(Boolean).slice(-limit);
    const out = [];
    for (const line of lines) { try { out.push(JSON.parse(line)); } catch {} }
    return out;
  }
}

module.exports = { normalizeReport, FeedbackLog, TEXT_MAX };
