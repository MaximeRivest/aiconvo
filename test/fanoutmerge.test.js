'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeFanoutMerge, assertAcyclic } = require('../fanoutmerge.js');

// jsonl builders
const line = d => JSON.stringify(d);
const msg = (id, parentId, role, text, extra = {}) =>
  ({ type: 'message', id, parentId, timestamp: id, message: { role, content: [{ type: 'text', text }], ...extra } });
const mc = (id, parentId, modelId) =>
  ({ type: 'model_change', id, parentId, timestamp: id, modelId });
const file = (...entries) => entries.map(line).join('\n') + '\n';

// Shared history: prompt p0 -> answer a0 (the branch point).
const header = { type: 'session', version: 1 };
const chain = [msg('p0', null, 'user', 'start'), msg('a0', 'p0', 'assistant', 'root answer')];
const root = file(header, ...chain);
const fork = (k, model, promptText) => file(
  { ...header, parentSession: '/root.jsonl' },
  ...chain,
  mc('mc' + k, 'a0', model),
  msg('pr' + k, 'mc' + k, 'user', promptText),
  msg('an' + k, 'pr' + k, 'assistant', 'answer ' + k, { model }),
);

function parentsOf(content) {
  const m = new Map();
  for (const l of content.split('\n')) {
    if (!l.trim()) continue;
    const d = JSON.parse(l);
    if (d.type !== 'session' && d.id) m.set(d.id, d.parentId || null);
  }
  return m;
}
function bothOf(content) {
  for (const l of content.split('\n')) {
    if (!l.trim()) continue;
    const d = JSON.parse(l);
    if (d.type === 'message' && d.message && /aiconvo:both/.test(d.message.content[0].text)) return d;
  }
  return null;
}

test('folds forks into sibling branches under one canonical prompt', () => {
  const r = computeFanoutMerge(root, [fork(1, 'model-a', 'compare'), fork(2, 'model-b', 'compare')], { newId: 'both1', now: 't' });
  const p = parentsOf(r.content);
  assert.equal(r.canonicalId, 'pr1');
  assert.equal(p.get('pr1'), 'a0');   // canonical prompt at the branch point
  assert.equal(p.get('mc1'), 'pr1');  // each settings chain below the prompt
  assert.equal(p.get('an1'), 'mc1');  // reply behind its own model switch
  assert.equal(p.get('mc2'), 'pr1');
  assert.equal(p.get('an2'), 'mc2');
  assert.equal(p.has('pr2'), false);  // duplicate prompt collapsed
  const both = bothOf(r.content);
  assert.equal(both.parentId, 'pr1');
  assert.match(both.message.content[0].text, /model-a/);
  assert.match(both.message.content[0].text, /answer 2/);
  assert.equal(r.bothId, 'both1');
  assertAcyclic(p);
});

test('re-run on the merged result is a byte-for-byte no-op', () => {
  const forks = [fork(1, 'model-a', 'compare'), fork(2, 'model-b', 'compare')];
  const first = computeFanoutMerge(root, forks, { newId: 'both1', now: 't' });
  const again = computeFanoutMerge(first.content, forks, { newId: 'both2', now: 't2' });
  assert.equal(again.changed, false);
  assert.equal(again.content, first.content);
  assert.equal(again.bothId, null); // the both entry already exists
});

test('repairs the crashed-merge disaster: torn line, cycle, stray prompts', () => {
  // Replay of the real 2026-08-30 corruption: a killed append left a torn
  // line, the re-run wrote prompt<->model_change as each other's parent (a
  // cycle), and later passes appended stray duplicate prompts.
  const broken = file(header, ...chain,
    mc('mc1', 'pr1', 'model-a'),           // rewritten copy (correct)
  ) + '{"type":"message","id":"pr1","par'  // torn line
    + '\n' + file(
    msg('pr1', 'mc1', 'user', 'compare'),  // wrong parent -> cycle with mc1
    msg('an1', 'pr1', 'assistant', 'answer 1', { model: 'model-a' }),
    mc('mc2', 'pr1', 'model-b'),
    msg('an2', 'mc2', 'assistant', 'answer 2', { model: 'model-b' }),
    msg('pr2', 'mc2', 'user', 'compare'),  // stray duplicate prompt
  );
  const forks = [fork(1, 'model-a', 'compare'), fork(2, 'model-b', 'compare')];
  const r = computeFanoutMerge(broken, forks, { newId: 'both1', now: 't' });
  const p = parentsOf(r.content);
  assert.equal(r.healed, 1);              // torn line dropped
  assert.equal(p.get('pr1'), 'a0');       // cycle broken: prompt back on the branch point
  assert.equal(p.get('mc1'), 'pr1');
  assert.equal(p.get('an1'), 'mc1');
  assert.equal(p.has('pr2'), false);      // stray duplicate removed
  assertAcyclic(p);
  // and the repair converges too
  const again = computeFanoutMerge(r.content, forks, { newId: 'both2', now: 't2' });
  assert.equal(again.changed, false);
});

test('a different prompt text keeps its own sibling branch', () => {
  const r = computeFanoutMerge(root, [fork(1, 'model-a', 'compare'), fork(2, 'model-b', 'other question')], { newId: 'b', now: 't' });
  const p = parentsOf(r.content);
  assert.equal(p.get('pr1'), 'a0');
  assert.equal(p.get('pr2'), 'a0');       // genuine second branch, not collapsed
  assert.equal(p.get('mc2'), 'pr2');
});

test('never writes a parent cycle: throws instead', () => {
  // Forks that somehow encode mutually-referencing parents must abort the
  // merge, not poison the root file.
  const evil = file({ ...header }, ...chain,
    { type: 'model_change', id: 'x', parentId: 'y', timestamp: 'x', modelId: 'm' },
    { type: 'model_change', id: 'y', parentId: 'x', timestamp: 'y', modelId: 'm' },
  );
  assert.throws(() => computeFanoutMerge(root, [evil]), /cycle/);
});

test('tolerates unreadable or tail-less forks', () => {
  const r = computeFanoutMerge(root, ['', file(header, ...chain), fork(1, 'model-a', 'compare')], { newId: 'b', now: 't' });
  const p = parentsOf(r.content);
  assert.equal(p.get('pr1'), 'a0');
  assert.equal(r.bothId, null); // one answer only -> no both entry
});
