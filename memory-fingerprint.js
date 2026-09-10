'use strict';

const crypto = require('node:crypto');

function dialogue(messages) {
  return messages.filter(m => m.role === 'user' || m.role === 'assistant');
}

function fingerprint(messages, legacy = false) {
  const rows = dialogue(messages).map(m => {
    const row = [m.role, m.text || '', m.ts || null, !!m.off];
    if (!legacy) row.push(m.origin || null);
    return row;
  });
  return crypto.createHash('sha256').update('v1\x00' + JSON.stringify(rows)).digest('hex').slice(0, 24);
}

// The pre-delegation format omitted origin entirely. A missing origin and null
// are equivalent, but a real origin changes meaning and must not be migrated.
function upgradeLeaf(leaf, entry, cached) {
  if (!leaf || leaf.partial || (leaf.v || 1) < 2 || !entry?.memoryHash ||
      leaf.memoryHash === entry.memoryHash || !Array.isArray(cached?.messages) ||
      cached.key !== leaf.key || entry.delegationId || cached.delegationId) return leaf;
  if (dialogue(cached.messages).some(m => m.origin)) return leaf;
  const current = fingerprint(cached.messages);
  if (current !== entry.memoryHash || fingerprint(cached.messages, true) !== leaf.memoryHash) return leaf;
  return { ...leaf, memoryHash: current, fingerprintMigration: {
    from: leaf.memoryHash, to: current, kind: 'null-origin-compatibility',
  } };
}

module.exports = { fingerprint, upgradeLeaf };
