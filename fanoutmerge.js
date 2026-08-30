// Pure fan-out reintegration: fold fork session files back into the parent
// as sibling branches — deterministically and idempotently.
//
// Learned the hard way (2026-08-30, the llmfor_r corruption):
//  - The old merge decided every rewrite from "which ids does the root
//    already have". A crash mid-append left a half-merged root, and the
//    re-run then computed DIFFERENT parents — it wrote a parent CYCLE into
//    the session file, and the tree walk spun the whole server.
//  - This module computes every rewrite from the fork files alone. The same
//    input always yields the same output, so a re-run after a partial merge
//    converges to the same file instead of compounding the damage. It even
//    REPAIRS a root that an older broken merge mangled.
//  - The caller must write the result with tmp-file + atomic rename (never
//    append), and only retire the fork files AFTER the root is durable.
//  - computeFanoutMerge THROWS rather than return content with a parent
//    cycle. A merge must never write a graph the tree cannot walk.
'use strict';

const crypto = require('crypto');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

// Parse a session file into ordered items. Each item keeps its raw line so
// untouched entries survive byte-for-byte. Unparseable (torn) lines parse to
// d = null; the assembler drops them — a killed append must not poison the
// file forever.
function parseLines(raw) {
  const items = [];
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let d = null;
    try { d = JSON.parse(line); } catch {}
    items.push({ line, d });
  }
  return items;
}

function entryId(d) { return d && d.type !== 'session' && typeof d.id === 'string' ? d.id : null; }
function parentOf(d) { return (d && d.parentId) || null; }
function isUserMessage(d) { return !!(d && d.type === 'message' && d.message && d.message.role === 'user'); }
function isAssistantText(d) {
  return !!(d && d.type === 'message' && d.message && d.message.role === 'assistant'
    && textOf(d.message.content).trim());
}
function isBothEntry(d) {
  return !!(d && d.type === 'message' && d.message && d.message.role === 'assistant'
    && /<!--\s*aiconvo:both\s*-->/.test(textOf(d.message.content)));
}

// The copied prefix: the leading run of fork entries that the root holds with
// the SAME parent. Fork files start with a verbatim copy of the root chain,
// so identical (id, parent) pairs are shared history. A rewritten or missing
// copy ends the prefix — everything after it is the fork's own tail.
function splitForkTail(forkItems, rootById) {
  let i = 0;
  for (; i < forkItems.length; i++) {
    const d = forkItems[i];
    const r = rootById.get(d.id);
    if (!r || parentOf(r) !== parentOf(d)) break;
  }
  return forkItems.slice(i);
}

// Restructure ONE fork tail (in place) so it folds into the parent:
//   canonical prompt at the shared branch point, each fork's settings chain
//   (model_change, thinking, …) re-parented BELOW the prompt, the reply chain
//   behind its own settings. Duplicate prompt copies collapse onto the
//   canonical prompt and are dropped.
// Deterministic: reads nothing but the tail itself and the canonical record.
function restructureTail(tail, canonical) {
  const byId = new Map(tail.map(d => [d.id, d]));
  const originalParent = new Map(tail.map(d => [d.id, parentOf(d)]));
  const prompt = tail.find(isUserMessage);
  if (!prompt) return { canonical, dropped: null };
  // The prompt's in-tail ancestors are the fork's start-of-run settings.
  const settings = [];
  const seen = new Set([prompt.id]);
  let cur = parentOf(prompt);
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    settings.push(byId.get(cur));
    cur = parentOf(byId.get(cur));
  }
  settings.reverse(); // topmost first; cur is now the shared branch point
  const nearest = settings.length ? settings[settings.length - 1] : null;
  const text = textOf(prompt.message.content);
  const keepOwnPrompt = !canonical || canonical.text !== text;
  const promptId = keepOwnPrompt ? prompt.id : canonical.id;
  for (const d of tail) {
    if (d.id !== prompt.id && originalParent.get(d.id) === prompt.id) {
      d.parentId = nearest ? nearest.id : promptId;
    }
  }
  if (settings.length) settings[0].parentId = promptId;
  let dropped = null;
  if (keepOwnPrompt) {
    prompt.parentId = cur || null; // attach at the shared branch point
    if (!canonical) canonical = { id: prompt.id, text };
  } else {
    tail.splice(tail.indexOf(prompt), 1);
    dropped = prompt.id;
  }
  return { canonical, dropped };
}

// The fork's quoted answer for the "both" entry: its LAST assistant entry
// with visible text (the final reply after any tool work), plus the model
// that produced it.
function answerOfTail(tail) {
  let answer = null;
  for (const d of tail) if (isAssistantText(d)) answer = d;
  if (!answer) return null;
  let model = (answer.message && answer.message.model) || null;
  if (!model) {
    for (const d of tail) if (d.type === 'model_change' && d.modelId) model = d.modelId;
  }
  return { model: model || 'model', text: textOf(answer.message.content) };
}

function makeBothEntry(parentId, answers, opts) {
  const body = answers.map(a => `=== ${a.model || 'model'} ===\n${String(a.text || '').trim()}`).join('\n\n')
    + '\n\n<!-- aiconvo:both -->';
  return {
    type: 'message',
    id: (opts && opts.newId) || crypto.randomBytes(4).toString('hex'),
    parentId,
    timestamp: (opts && opts.now) || new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: body }] },
  };
}

// Walk every parent chain of the final content. Throws on a cycle: a merge
// must never produce a file the tree cannot walk.
function assertAcyclic(byId) {
  for (const start of byId.keys()) {
    const seen = new Set();
    let n = start;
    while (n && byId.has(n)) {
      if (seen.has(n)) throw new Error('fan-out merge would create a parent cycle at ' + n + ' — aborted');
      seen.add(n);
      n = byId.get(n);
    }
  }
}

// rootRaw: the parent session file. forkRaws: fork session files in fan-out
// index order. Returns { content, changed, canonicalId, bothId, healed }.
function computeFanoutMerge(rootRaw, forkRaws, opts = {}) {
  const rootItems = parseLines(rootRaw);
  const rootById = new Map();
  for (const it of rootItems) {
    const id = entryId(it.d);
    if (id && !rootById.has(id)) rootById.set(id, it.d);
  }

  // Per-fork tails, restructured deterministically.
  let canonical = null;
  const droppedIds = new Set();
  const computed = new Map(); // id -> entry (first fork wins)
  const answers = [];
  for (const raw of forkRaws) {
    const forkEntries = parseLines(raw).map(it => it.d).filter(d => entryId(d));
    const tail = splitForkTail(forkEntries, rootById);
    const seen = new Set();
    const dedup = [];
    for (const d of tail) { if (!seen.has(d.id)) { seen.add(d.id); dedup.push(d); } }
    if (!dedup.length) continue;
    const r = restructureTail(dedup, canonical);
    canonical = r.canonical;
    if (r.dropped) droppedIds.add(r.dropped);
    const a = answerOfTail(dedup);
    if (a) answers.push(a);
    for (const d of dedup) if (!computed.has(d.id)) computed.set(d.id, d);
  }

  // Assemble: root order first, computed entries rewrite their root copies in
  // place; entries the root lacks append at the end; torn lines and dropped
  // duplicate prompts vanish.
  const out = [];
  const emitted = new Set();
  let healed = 0;
  let changed = false;
  let hasBoth = false;
  for (const it of rootItems) {
    if (!it.d) { healed++; changed = true; continue; } // torn line
    const id = entryId(it.d);
    if (!id) { out.push(it.line); continue; } // session header etc.
    if (emitted.has(id)) { changed = true; continue; } // duplicate line
    if (droppedIds.has(id)) { changed = true; continue; }
    emitted.add(id);
    if (canonical && isBothEntry(it.d) && parentOf(it.d) === canonical.id) hasBoth = true;
    const c = computed.get(id);
    if (c && parentOf(c) !== parentOf(it.d)) { out.push(JSON.stringify(c)); changed = true; }
    else out.push(it.line);
  }
  for (const [id, d] of computed) {
    if (emitted.has(id) || droppedIds.has(id)) continue;
    emitted.add(id);
    out.push(JSON.stringify(d));
    changed = true;
  }

  let bothId = null;
  if (canonical && !hasBoth && answers.filter(a => a.text.trim()).length >= 2) {
    const both = makeBothEntry(canonical.id, answers.filter(a => a.text.trim()), opts);
    bothId = both.id;
    out.push(JSON.stringify(both));
    changed = true;
  }

  // Never hand back a graph the tree cannot walk.
  const parents = new Map();
  for (const line of out) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const id = entryId(d);
    if (id && !parents.has(id)) parents.set(id, parentOf(d));
  }
  assertAcyclic(parents);

  return {
    content: out.join('\n') + '\n',
    changed,
    canonicalId: canonical ? canonical.id : null,
    bothId,
    healed,
  };
}

module.exports = { computeFanoutMerge, splitForkTail, restructureTail, assertAcyclic, makeBothEntry, parseLines };
