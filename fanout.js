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
    if (n.role === 'assistant') return n;
    for (const child of children.get(n.id) || []) queue.push(child);
  }
  return null;
}

function classifyAt(nodeId, index) {
  const answers = [];
  let both = null;
  const merges = [];
  const seenAnswers = new Set();
  for (const child of index.children.get(nodeId) || []) {
    if (child.bridge === 'both') {
      if (!both || String(child.ts || '') >= String(both.ts || '')) both = child;
      continue;
    }
    if (child.bridge === 'merge') {
      const answer = firstAssistant(child, index.children);
      if (answer) merges.push({ bridge: child, answer });
      continue;
    }
    const answer = firstAssistant(child, index.children);
    if (!answer || answer.bridge === 'both' || answer.bridge === 'merge' || seenAnswers.has(answer.id)) continue;
    seenAnswers.add(answer.id);
    answers.push(answer);
  }
  merges.sort((a, b) => String(a.answer.lastTs || a.answer.ts || '').localeCompare(String(b.answer.lastTs || b.answer.ts || '')));
  return { node: nodeId, answers, both, merge: merges[merges.length - 1] || null, merges };
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
