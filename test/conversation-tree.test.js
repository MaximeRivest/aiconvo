'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../conversation-tree.js');

// d = { entryParents: [[id, parent]…], messages: [{ eid, role, text, model? }…] }
function convo(spec) {
  const entryParents = [], messages = [];
  for (const [id, parent, role, text, extra] of spec) {
    entryParents.push([id, parent]);
    if (role) messages.push({ eid: id, role, text: text ?? id, ...(extra || {}) });
  }
  return { key: 'k', entryParents, messages };
}
const kinds = L => L.blocks.map(b => b.type === 'nodes' ? 'n:' + b.ids.join(',')
  : b.type === 'answers' ? 'A:' + b.columns.map(c => c.key + (c.selected ? '*' : '') + (c.versions.length > 1 ? '×' + c.versions.length : '')).join(',')
  : b.type === 'versions' ? `V${b.index + 1}/${b.versions.length}` : `P${b.index + 1}/${b.options.length}`);

const parallel = () => convo([
  ['q', null, 'user', 'Which is better?'],
  ['a1', 'q', 'assistant', 'A1', { model: 'claude', provider: 'x' }],
  ['a2', 'q', 'assistant', 'A2', { model: 'gpt', provider: 'y' }],
  ['f1', 'a1', 'user', 'Follow up on 1'], ['g1', 'f1', 'assistant', 'G1', { model: 'claude', provider: 'x' }],
  ['f2', 'a2', 'user', 'Follow up on 2'], ['g2', 'f2', 'assistant', 'G2', { model: 'gpt', provider: 'y' }],
]);

test('the head decides the transcript: newest path by default, one group of side-by-side answers', () => {
  const t = T.build(parallel());
  const L = T.layout(t, {});
  assert.equal(L.head, 'g2');
  assert.deepEqual(kinds(L), ['n:q', 'A:x/claude,y/gpt*', 'n:f2,g2']);
  const group = L.blocks[1];
  assert.deepEqual(group.columns.map(c => c.nodes), [['a1'], ['a2']]);
});

test('clicking another answer moves the head to its own follow-up, and the route back is remembered', () => {
  const t = T.build(parallel());
  let s = T.moveHead(t, {}, 'a1');
  assert.equal(T.effectiveHead(t, s), 'g1');
  assert.deepEqual(kinds(T.layout(t, s)), ['n:q', 'A:x/claude*,y/gpt', 'n:f1,g1']);
  s = T.moveHead(t, s, 'a2');
  assert.equal(s.head, 'g2');
  // Back to the first answer: the route read below it is still there.
  s = T.moveHead(t, s, 'a1');
  assert.equal(s.head, 'g1');
});

test('an exact head stops at a branch point; a plain head follows the conversation as it grows', () => {
  const d = parallel();
  let t = T.build(d);
  const exact = T.moveHead(t, {}, 'a1', { exact: true });
  assert.equal(T.effectiveHead(t, exact), 'a1');
  assert.equal(T.layout(t, exact).atLeaf, false);
  const plain = T.moveHead(t, {}, 'a1');
  d.entryParents.push(['f3', 'g1']); d.messages.push({ eid: 'f3', role: 'user', text: 'more' });
  t = T.build(d);
  assert.equal(T.effectiveHead(t, plain), 'f3');
  assert.equal(T.effectiveHead(t, exact), 'a1');
});

test('regeneration re-asks verbatim: one question, the model column gets versions', () => {
  const t = T.build(convo([
    ['s', null, 'user', 'Start'], ['r', 's', 'assistant', 'R', { model: 'm', provider: 'p' }],
    ['q1', 'r', 'user', 'Same words'], ['a1', 'q1', 'assistant', 'first', { model: 'm', provider: 'p' }],
    ['q2', 'r', 'user', 'Same words'], ['a2', 'q2', 'assistant', 'second', { model: 'm', provider: 'p' }],
  ]));
  const L = T.layout(t, {});
  assert.deepEqual(kinds(L), ['n:s,r,q2', 'A:p/m*×2']);
  assert.equal(L.blocks[1].columns[0].index, 1);
  assert.deepEqual(L.blocks[1].questions, ['q1', 'q2']);
});

test('edited questions are versions of the question, not paths', () => {
  const t = T.build(convo([
    ['s', null, 'user', 'Start'], ['r', 's', 'assistant', 'R'],
    ['q1', 'r', 'user', 'First wording'], ['a1', 'q1', 'assistant', 'A1'],
    ['q2', 'r', 'user', 'Second wording', { operation: { kind: 'edit', sourceEntryId: 'q1' } }], ['a2', 'q2', 'assistant', 'A2'],
  ]));
  const L = T.layout(t, {});
  assert.deepEqual(kinds(L), ['n:s,r,q2', 'V2/2', 'n:a2']);
  const moved = T.moveHead(t, {}, L.blocks[1].versions[0].id);
  assert.equal(moved.head, 'a1');
});

test('settings entries are transparent, and a send keeps them in context', () => {
  const d = convo([
    ['q', null, 'user', 'Q'], ['a', 'q', 'assistant', 'A'],
    ['model-change', 'a', null], ['thinking', 'model-change', null],
  ]);
  const t = T.build(d);
  assert.equal(T.effectiveHead(t, {}), 'a');
  assert.equal(T.sendNode(t, 'a'), 'thinking');
  assert.equal(T.sendNode(t, 'q'), 'q');
  // A new conversation with settings but no message continues at the file's end.
  const empty = T.build(convo([['model', null, null], ['mode', 'model', null], ['info', 'mode', null]]));
  assert.equal(T.effectiveHead(empty, {}), null);
  assert.equal(T.sendNode(empty, null), 'info');
});

test('a label anchor between a branch point and a new question is transparent too', () => {
  const t = T.build(convo([
    ['q', null, 'user', 'Q'], ['a', 'q', 'assistant', 'A'], ['q2', 'a', 'user', 'Next'], ['a2', 'q2', 'assistant', 'A2'],
    ['label', 'a', null], ['q3', 'label', 'user', 'Other next'], ['a3', 'q3', 'assistant', 'A3'],
  ]));
  assert.equal(T.nodeParentOf(t, 'q3'), 'a');
  assert.deepEqual(kinds(T.layout(t, {})), ['n:q,a,q3', 'V2/2', 'n:a3']);
});

test('older transport entries become typed answers: regenerate, merge (with sources) and include-all', () => {
  const t = T.build(convo([
    ['q', null, 'user', 'Q'],
    ['a1', 'q', 'assistant', 'A1', { model: 'claude', provider: 'x' }],
    ['a2', 'q', 'assistant', 'A2', { model: 'gpt', provider: 'y' }],
    ['regen', 'q', 'user', 'Continue.\n<!-- chattering:regenerate -->'], ['a3', 'regen', 'assistant', 'A3', { model: 'claude', provider: 'x' }],
    ['merge', 'q', 'user', '2 models answered my last message in parallel. Their replies:\n…\n<!-- chattering:merge -->', { operation: { kind: 'merge', sources: [{ id: 'a1' }, { id: 'a2' }] } }],
    ['m', 'merge', 'assistant', 'Merged', { model: 'claude', provider: 'x' }],
    ['both', 'q', 'assistant', 'quoted\n<!-- chattering:both -->', { operation: { kind: 'both', sources: [{ id: 'a1' }, { id: 'a2' }] } }],
    ['f', 'm', 'user', 'Thanks'],
  ]));
  const L = T.layout(t, {});
  assert.deepEqual(kinds(L), ['n:q', 'A:x/claude×2,y/gpt,merge*,both', 'n:f']);
  const cols = L.blocks[1].columns;
  assert.equal(cols[0].shown.start, 'a3');
  assert.equal(cols[0].shown.via, 'regen');
  assert.deepEqual(cols[2].shown.sources.map(s => s.id), ['a1', 'a2']);
  // The transport entries are never displayed as messages.
  const shown = L.blocks.flatMap(b => b.type === 'nodes' ? b.ids : b.type === 'answers' ? b.columns.flatMap(c => c.nodes) : []);
  assert.ok(!shown.includes('regen') && !shown.includes('merge'));
  assert.equal(T.answerAt(t, 'm').question, 'q');
  assert.equal(T.answerAt(t, 'm').via, 'merge');
});

test('corrupt cycles terminate and keep the valid chain readable', () => {
  const t = T.build({ entryParents: [['root', null], ['child', 'root'], ['x', 'y'], ['y', 'x']],
    messages: [{ eid: 'root', role: 'user', text: 'r' }, { eid: 'child', role: 'assistant', text: 'c' }, { eid: 'x', role: 'user', text: 'x' }, { eid: 'y', role: 'assistant', text: 'y' }] });
  const L = T.layout(t, { head: 'child' });
  assert.deepEqual(L.path, ['root', 'child']);
  assert.ok(T.layout(t, { head: 'x' }).path.length <= 2);
});

test('real conversation shapes: every head lays out its whole path once, quickly', () => {
  const dir = path.join(__dirname, 'fixtures/trees');
  for (const file of fs.readdirSync(dir)) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const t = T.build(d);
    const started = Date.now();
    let heads = 0;
    for (const head of t.nodes) {
      const L = T.layout(t, { head, exact: true });
      heads++;
      const shown = [];
      for (const b of L.blocks) {
        if (b.type === 'nodes') shown.push(...b.ids);
        if (b.type === 'answers') { const c = b.columns[b.selected]; if (c) shown.push(...c.nodes); }
      }
      // Every path node is shown once, except transport entries (their answer
      // is shown instead) and questions a bridge answered from beside them.
      const counts = new Map();
      for (const id of shown) counts.set(id, (counts.get(id) || 0) + 1);
      for (const [id, n] of counts) assert.equal(n, 1, `${file}: ${id} shown ${n} times with head ${head}`);
      for (const id of L.path) {
        if (counts.has(id)) continue;
        assert.ok(T.transport(T.rowsOf(t, id)[0]), `${file}: ${id} missing with head ${head}`);
      }
      for (const b of L.blocks.filter(b => b.type === 'answers')) {
        assert.ok(b.columns.length >= 1 && b.columns.every(c => c.versions.includes(c.shown)), file);
        assert.ok(b.selected >= -1 && b.selected < b.columns.length, file);
      }
    }
    const ms = (Date.now() - started) / Math.max(heads, 1);
    assert.ok(ms < 25, `${file}: ${ms.toFixed(1)} ms per layout`);
  }
});

test('the default head of a real parallel conversation lands in a group with a selected column', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/trees/parallel-3-small.json'), 'utf8'));
  const t = T.build(d);
  const L = T.layout(t, {});
  const g = L.blocks.find(b => b.type === 'answers');
  assert.equal(g.columns.length, 4);
  assert.equal(g.columns[g.selected].key, 'both');
});
