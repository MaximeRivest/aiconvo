'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFanoutGroups, answersUnder } = require('../fanout.js');

const n = (id, parent, role, extra = {}) => ({ id, parent, role, ts: id, title: id, ...extra });

test('classifies model, both, and merge branches at one prompt', () => {
  const tree = { nodes: [
    n('prompt', null, 'user'),
    n('a', 'prompt', 'assistant', { model: 'model-a' }),
    n('b', 'prompt', 'assistant', { model: 'model-b' }),
    n('both', 'prompt', 'assistant', { bridge: 'both' }),
    n('merge-user', 'prompt', 'user', { bridge: 'merge' }),
    n('merged', 'merge-user', 'assistant', { model: 'merge-model' }),
  ] };
  const groups = classifyFanoutGroups(tree);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].answers.map(x => x.id), ['a', 'b']);
  assert.equal(groups[0].both.id, 'both');
  assert.equal(groups[0].merge.answer.id, 'merged');
  assert.deepEqual(answersUnder(tree, 'prompt').map(x => x.id), ['a', 'b']);
});

test('keeps a nested fan-out below an older merge branch', () => {
  const tree = { nodes: [
    n('prompt-1', null, 'user'),
    n('a-1', 'prompt-1', 'assistant'),
    n('b-1', 'prompt-1', 'assistant'),
    n('merge-user', 'prompt-1', 'user', { bridge: 'merge' }),
    n('merged', 'merge-user', 'assistant'),
    n('prompt-2', 'merged', 'user'),
    n('work-a', 'prompt-2', 'work'),
    n('a-2', 'work-a', 'assistant', { model: 'model-a' }),
    n('work-b', 'prompt-2', 'work'),
    n('b-2', 'work-b', 'assistant', { model: 'model-b' }),
    n('both-2', 'prompt-2', 'assistant', { bridge: 'both' }),
  ] };
  const groups = classifyFanoutGroups(tree);
  assert.deepEqual(groups.map(g => g.node), ['prompt-1', 'prompt-2']);
  assert.deepEqual(groups[1].answers.map(x => x.id), ['a-2', 'b-2']);
  assert.equal(groups[1].both.id, 'both-2');
});

test('uses the newest merge as the merge choice', () => {
  const tree = { nodes: [
    n('prompt', null, 'user'), n('a', 'prompt', 'assistant'), n('b', 'prompt', 'assistant'),
    n('m1-user', 'prompt', 'user', { bridge: 'merge' }), n('m1', 'm1-user', 'assistant'),
    n('m2-user', 'prompt', 'user', { bridge: 'merge' }), n('m2', 'm2-user', 'assistant'),
  ] };
  const group = classifyFanoutGroups(tree)[0];
  assert.equal(group.merges.length, 2);
  assert.equal(group.merge.answer.id, 'm2');
});
