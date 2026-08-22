// Trust: the vouch ledger's pure logic. Run tests: node --test test/
//
// A vouch is one human assertion: "I checked this exact content at this
// time." Trust never excludes content anywhere; it only LABELS it
// (vouched / partly vouched / changed since review / disputed / unverified).
//
// Anchoring is content-based: a record stores the exact vouched lines, and a
// line keeps its vouch while its exact text still exists in order. A changed
// line silently loses its vouch, so staleness falls out for free — no diff
// tracking, no Git dependency, and moved lines survive.
'use strict';
const crypto = require('crypto');

const sha256Hex = text => crypto.createHash('sha256').update(text).digest('hex');

// The ledger is append-only; a retract record cancels an earlier one by id.
function activeRecords(records) {
  const retracted = new Set(records.filter(r => r.action === 'retract').map(r => r.ref));
  return records.filter(r => r.action !== 'retract' && !retracted.has(r.id));
}

// Match the vouched block's lines against the current content, in order.
// Exact text match; a moved line keeps its vouch, a changed line loses it.
function matchVouchLines(blockLines, contentLines) {
  const matched = [];
  let from = 0, missing = 0;
  for (const line of blockLines) {
    let found = -1;
    for (let j = from; j < contentLines.length; j++) if (contentLines[j] === line) { found = j; break; }
    if (found === -1) { missing++; continue; }
    matched.push(found + 1);
    from = found + 1;
  }
  return { matched, missing };
}

// Full trust status of one path against one content snapshot.
// lines: 1-based line number -> 'v' (vouched) | 'd' (disputed; wins).
function statusFor(records, absPath, content) {
  const text = String(content);
  const contentLines = text.split('\n');
  const sha = sha256Hex(text);
  const lines = {};
  const mark = (n, m) => { if (m === 'd' || !lines[n]) lines[n] = m; };
  const out = activeRecords(records).filter(r => r.path === absPath).map(r => {
    const m = r.contentSha === sha
      ? { matched: contentLines.map((_, i) => i + 1), missing: 0 } // fast path: identical content
      : matchVouchLines(String(r.text || '').split('\n'), contentLines);
    const state = m.missing === 0 ? 'fresh' : m.matched.length ? 'partial' : 'stale';
    for (const n of m.matched) mark(n, r.action === 'dispute' ? 'd' : 'v');
    return { id: r.id, ts: r.ts, action: r.action, range: r.range || null, note: r.note || '', state, matchedCount: m.matched.length };
  });
  let vouched = 0, disputed = 0;
  for (const m of Object.values(lines)) m === 'd' ? disputed++ : vouched++;
  return {
    path: absPath, records: out, lines,
    summary: {
      total: contentLines.length, vouched, disputed,
      staleRecords: out.filter(r => r.state !== 'fresh').length,
      lastVouchTs: out.filter(r => r.action === 'vouch').map(r => r.ts).sort().pop() || null,
      lastDisputeTs: out.filter(r => r.action === 'dispute').map(r => r.ts).sort().pop() || null,
    },
  };
}

// Trust label for generated-content listings (briefings). Everything stays
// included; the label only states how much a human verified, and when.
function trustLabelFrom(status) {
  const day = ts => String(ts || '').slice(0, 10);
  const v = status.records.filter(r => r.action === 'vouch');
  const d = status.records.filter(r => r.action === 'dispute');
  let label = '';
  if (v.length) {
    const when = day(status.summary.lastVouchTs);
    const whole = status.summary.vouched + status.summary.disputed >= status.summary.total && v.every(r => r.state === 'fresh');
    label = whole ? `[vouched ${when}]`
      : status.summary.vouched ? `[partly vouched ${when}${v.some(r => r.state !== 'fresh') ? ', changed since review' : ''}]`
      : `[vouched ${when}, changed since review]`;
  }
  if (d.length) label += `${label ? ' ' : ''}[disputed ${day(status.summary.lastDisputeTs)}]`;
  return label || '[unverified]';
}

module.exports = { sha256Hex, activeRecords, matchVouchLines, statusFor, trustLabelFrom };
