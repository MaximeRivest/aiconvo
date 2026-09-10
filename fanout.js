'use strict';

function treeIndex(tree) {
  const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    if (!n.parent || !byId.has(n.parent)) continue;
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n);
  }
  for (const list of children.values()) list.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return { nodes, byId, children };
}

function firstAssistant(start, children) {
  const queue = [start];
  const seen = new Set();
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    // A different question is not another answer to the same prompt.
    if (n.role === 'user' && n.bridge !== 'regenerate') continue;
    if (n.bridge === 'both' || n.bridge === 'merge') continue;
    if (n.role === 'assistant') return n;
    for (const child of children.get(n.id) || []) queue.push(child);
  }
  return null;
}

// The entire linear answer, including work between text messages. Never
// consume the next question or guess between later branches.
function answerPackage(start, index) {
  const first = firstAssistant(start, index.children);
  if (!first) return null;
  let last = first, cur = start;
  const members = [], seen = new Set();
  while (cur && !seen.has(cur.id)) {
    if (cur.role === 'user' && cur.bridge !== 'regenerate') break;
    if (cur.bridge === 'both' || cur.bridge === 'merge') break;
    seen.add(cur.id); members.push(cur);
    if (cur.role === 'assistant') last = cur;
    const kids = index.children.get(cur.id) || [];
    if (kids.length !== 1) break;
    cur = kids[0];
  }
  if (!members.includes(first)) return null;
  return { ...last, id: last.messageId || last.id, tipId: members.at(-1).id, branchRoot: start.id,
    entryIds: [...new Set(members.flatMap(n => n.entryIds || [n.id]))],
    fullText: members.filter(n => n.role === 'assistant').map(n => n.fullText || '').join('\n\n'),
  };
}

function classifyAt(nodeId, index) {
  const answers = [];
  let both = null;
  const merges = [];
  const seenAnswers = new Set();
  const prompt = index.byId.get(nodeId);
  if (!prompt || prompt.role !== 'user' || prompt.bridge) return { node: nodeId, answers, both, merge: null, merges };
  for (const child of index.children.get(nodeId) || []) {
    if (child.bridge === 'both') {
      if (!both || String(child.ts || '') >= String(both.ts || '')) both = child;
      continue;
    }
    if (child.bridge === 'merge') {
      const kids = index.children.get(child.id) || [];
      const answer = kids.length === 1 ? answerPackage(kids[0], index) : null;
      if (answer) merges.push({ bridge: child, answer });
      continue;
    }
    const answer = answerPackage(child, index);
    if (!answer || answer.bridge === 'both' || answer.bridge === 'merge' || seenAnswers.has(answer.id)) continue;
    seenAnswers.add(answer.id);
    answers.push(answer);
  }
  merges.sort((a, b) => String(a.answer.lastTs || a.answer.ts || '').localeCompare(String(b.answer.lastTs || b.answer.ts || '')));
  return { node: nodeId, kind: prompt.operation?.kind === 'parallel' ? 'parallel' : 'answers', runId: prompt.operation?.runId,
    answers, both, merge: merges[merges.length - 1] || null, merges };
}

function classifyFanoutGroups(tree) {
  const index = treeIndex(tree);
  const groups = [];
  for (const node of index.nodes) {
    const group = classifyAt(node.id, index);
    if (group.answers.length >= 2) groups.push(group);
  }
  return groups;
}

function answersUnder(tree, nodeId) {
  return classifyAt(nodeId, treeIndex(tree)).answers;
}

module.exports = { treeIndex, firstAssistant, classifyFanoutGroups, answersUnder };
