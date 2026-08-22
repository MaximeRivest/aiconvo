// Pure session-fork logic for Claude Code JSONL files.
// Claude has no native arbitrary-node fork API (verified empirically: its CLI
// always continues at the file end), so aiconvo copies the root→node entry
// chain into a new session file. This module holds the pure part so tests can
// cover it without starting the server. pi forks do NOT go through here: they
// run through pi's own runtime via the aiconvo-bridge extension.
'use strict';

// Walk parent pointers from nodeId to the root. Returns the Set of entry ids
// to keep. Throws when the node is not in the file.
function chainIds(parsed, nodeId, idField, parentField) {
  const at = new Map();
  parsed.forEach((d, i) => { if (d && d[idField] && !at.has(d[idField])) at.set(d[idField], i); });
  if (!at.has(nodeId)) throw new Error('message not found in the session file');
  const keep = new Set();
  for (let cur = nodeId; cur != null && at.has(cur) && !keep.has(cur);) {
    keep.add(cur);
    cur = parsed[at.get(cur)][parentField];
  }
  return keep;
}

// Build the content of a forked Claude session file: the root→node chain in
// file order, with every entry's sessionId rewritten to newSessionId.
function claudeForkContent(rawText, nodeId, newSessionId) {
  const rawLines = String(rawText).split('\n').filter(l => l.trim());
  const parsed = rawLines.map(l => { try { return JSON.parse(l); } catch { return null; } });
  const keep = chainIds(parsed, nodeId, 'uuid', 'parentUuid');
  const lines = [];
  parsed.forEach(d => {
    if (d && d.uuid && keep.has(d.uuid)) lines.push(JSON.stringify({ ...d, sessionId: newSessionId }));
  });
  return lines.join('\n') + '\n';
}

// Group sessions into fork families with a union-find: members share a
// rootId (forks copy the root chain verbatim) or point at a parent through
// pi's parentSession. entries: [key, { rootId, parentSession, firstTs }].
// resolveParentKey(path) → key or null. Returns Map(key → { primary, size });
// primary is the family's origin — the member with the earliest firstTs.
function groupFamilies(entries, resolveParentKey) {
  const keys = entries.map(([k]) => k);
  const up = new Map(keys.map(k => [k, k]));
  const find = k => {
    let r = k;
    while (up.get(r) !== r) r = up.get(r);
    while (up.get(k) !== r) { const n = up.get(k); up.set(k, r); k = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) up.set(ra, rb); };
  const byRoot = new Map();
  const meta = new Map(entries);
  for (const [k, e] of entries) {
    if (e.rootId) {
      if (byRoot.has(e.rootId)) union(k, byRoot.get(e.rootId));
      else byRoot.set(e.rootId, k);
    }
    if (e.parentSession) {
      const pk = resolveParentKey(e.parentSession);
      if (pk && up.has(pk)) union(k, pk);
    }
  }
  const members = new Map();
  for (const k of keys) {
    const r = find(k);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(k);
  }
  const out = new Map();
  for (const group of members.values()) {
    group.sort((a, b) => (((meta.get(a) || {}).firstTs || '') + a).localeCompare(((meta.get(b) || {}).firstTs || '') + b));
    for (const k of group) out.set(k, { primary: group[0], size: group.length });
  }
  return out;
}

module.exports = { chainIds, claudeForkContent, groupFamilies };
