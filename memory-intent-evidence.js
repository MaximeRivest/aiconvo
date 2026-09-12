'use strict';
const { revision } = require('./memory-automation');
function intentEvidence(key, leaf, quote) {
  const evidence = { key, messageIndex: quote.messageIndex, entry: quote.entry || null,
    offBranch: !!quote.offBranch, assistantBeforeEntry: quote.assistantBeforeEntry || null,
    ts: quote.ts || leaf.span?.lastTs || null, title: leaf.title,
    kind: quote.kind || 'outcome', force: quote.force || null, situation: quote.situation || null,
    confidence: quote.confidence || 0, reason: quote.reason || '', user: quote.user || '',
    assistantBefore: quote.assistantBefore || '', images: quote.images || [] };
  // A stable message number alone is not an evidence identity. Both the lane
  // cache and incremental weighing must invalidate on quote/ancestry changes.
  return { id: key + ':' + quote.messageIndex + ':' + revision(JSON.stringify(evidence)), ...evidence };
}
module.exports = { intentEvidence };
