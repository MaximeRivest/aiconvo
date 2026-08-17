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

module.exports = { chainIds, claudeForkContent };
