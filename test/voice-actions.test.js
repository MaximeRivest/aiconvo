'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../voice-actions.js');

test('numbers said as digits or words', () => {
  assert.deepEqual(V.numbersIn('go to line forty two'), [42]);
  assert.deepEqual(V.numbersIn('line two hundred and twelve, then 7'), [212, 7]);
  assert.deepEqual(V.numbersIn('one thousand and five'), [1005]);
  assert.deepEqual(V.numbersIn('no numbers here'), []);
});

test('spans are runs of the words said, up to six', () => {
  const spans = V.spansOf("change their going to they're going.");
  assert.ok(spans.includes('their going') && spans.includes("they're going"));
  assert.ok(!spans.some(s => s.split(' ').length > 6));
});

test('big lists keep what shares words with the sentence', () => {
  const items = Array.from({ length: 400 }, (_, i) => ({ id: String(i), label: 'file-' + i + '.txt' })).concat([{ id: 'x', label: 'design/file-view-menu.png' }]);
  const kept = V.rankByOverlap(items, 'open file view menu dot png', 50);
  assert.equal(kept.length, 50);
  assert.equal(kept[0].id, 'x');
});

const LISTS = {
  targets: [{ id: 'conv:a', label: 'conversation · Air bills', keep: true }, { id: 'conv:b', label: 'conversation · R statistics', keep: true }, { id: 'file:/p/x.js', label: 'file · x.js', keep: true }],
  groups: [{ id: 'left panel/conversation', label: 'conversations in the left panel' }, { id: 'right panel/file', label: 'files in the right panel' }],
  defaultGroup: 'left panel/conversation',
};
const answer = (choice, p, rest = {}) => ({ choice, confidence: p, probabilities: { [choice]: p, ...rest } });

test('the request: the actions that apply, their arguments over real candidates; not a proxy', () => {
  const built = V.buildRequest({ said: 'open the third one', actions: ['open', 'reasoning', 'bogus'], lists: LISTS });
  assert.deepEqual(Object.keys(built.request.questions).sort(), ['action', 'open.list', 'open.name', 'open.place', 'reasoning.level']);
  assert.deepEqual(Object.keys(built.request.questions.action.criteria).sort(), ['none', 'open', 'reasoning']);
  assert.deepEqual(built.keys['open.name'], { 'conversation · Air bills': 'conv:a', 'conversation · R statistics': 'conv:b', 'file · x.js': 'file:/p/x.js' });
  assert.ok('conversations in the left panel' in built.request.questions['open.list'].criteria, 'lists are offered in words');
  assert.equal(built.request.questions['open.number'], undefined, 'no number said, no number question');
  assert.ok(V.buildRequest({ said: 'open number one', actions: ['open'], lists: LISTS }).request.questions['open.number'], '"number one" is a number');
  assert.equal(V.buildRequest({ said: 'open the r stats one', actions: ['open'], lists: LISTS }).request.questions['open.number'], undefined, '"the … one" is not');
  assert.throws(() => V.buildRequest({ said: '  ' }), /nothing was said/);
  // A suggestion waiting for an answer adds yes / no.
  assert.ok('confirm' in V.buildRequest({ said: 'yes', actions: ['send'], pending: 'Send the message' }).request.questions.action.criteria);
  assert.ok(!('confirm' in V.buildRequest({ said: 'yes', actions: ['send', 'confirm'] }).request.questions.action.criteria));
  // Old text must be in the document; "this" is the selection.
  const r = V.buildRequest({ said: 'change this to that', actions: ['replace'], doc: { selection: 'x', nearby: 'this and that' } });
  assert.equal(Object.keys(r.request.questions['replace.old'].criteria)[0], '(the selected text)');
  assert.ok(!('this' in r.request.questions['replace.old'].criteria));
  // Big lists keep what is on screen, then what shares words.
  const many = Array.from({ length: 400 }, (_, i) => ({ id: 'conv:' + i, label: 'conversation · topic ' + i })).concat([{ id: 'conv:x', label: 'conversation · garden planning' }]);
  const big = V.buildRequest({ said: 'open garden planning', actions: ['open'], lists: { targets: LISTS.targets.concat(many) } });
  const kept = Object.values(big.keys['open.name']);
  assert.ok(kept.includes('conv:a') && kept.includes('conv:x') && kept.length < 256);
});

test('open: a number; a place, counted in the list the words name; the surer of place and name', () => {
  const read = (said, answers, action = 0.99) => V.readDecision(V.buildRequest({ said, actions: ['open'], lists: LISTS }), { action: answer('open', action), ...answers }, said);
  const d1 = read('open 7', { 'open.number': answer('7', 0.97), 'open.place': answer('none', 0.9) });
  assert.deepEqual([d1.args, d1.confidence], [{ number: 7 }, 0.97]);
  // "the last file": the word names the right panel's list, whatever Jev's list answer.
  const d2 = read('open the last file', { 'open.place': answer('last', 0.98), 'open.list': answer('unclear', 0.6), 'open.name': answer('(not said)', 0.9) });
  assert.deepEqual([d2.args, d2.confidence], [{ place: 'last', list: 'right panel/file' }, 0.98]);
  // No list said: the default one, no doubt from the list question.
  const d3 = read('the third one', { 'open.place': answer('third', 0.99), 'open.list': answer('conversations in the left panel', 0.31) });
  assert.deepEqual([d3.args, d3.confidence], [{ place: 'third', list: 'left panel/conversation' }, 0.99]);
  // A name is judged among the items, not against "(not said)".
  const d4 = read('open air bills', { 'open.place': answer('none', 0.99), 'open.name': answer('conversation · Air bills', 0.8, { '(not said)': 0.17, 'conversation · R statistics': 0.03 }) });
  assert.deepEqual(d4.args, { name: 'conv:a' });
  assert.ok(Math.abs(d4.confidence - 0.8 / 0.83) < 1e-9);
  // "the r stats one": a doubtful "first one" loses to a sure name.
  const d5 = read('open the r stats one', { 'open.place': answer('first', 0.49), 'open.name': answer('conversation · R statistics', 0.7, { '(not said)': 0.25, 'conversation · Air bills': 0.05 }) });
  assert.deepEqual(d5.args, { name: 'conv:b' });
  // Jev leaned to "nothing named": a guess to ask about, never above one half.
  const d6 = read('click the doc', { 'open.place': answer('none', 0.99), 'open.name': answer('(not said)', 0.47, { 'file · x.js': 0.43, 'conversation · Air bills': 0.1 }) });
  assert.deepEqual([d6.args, d6.confidence], [{ name: 'file:/p/x.js' }, 0.5]);
  const d7 = read('open it', { 'open.place': answer('none', 0.99), 'open.name': answer('(not said)', 0.95, { 'file · x.js': 0.05 }) });
  assert.deepEqual([d7.missing, d7.confidence], ['item', 0.3]);
});

test('reading the answers: ids back, the least certain part, an optional argument', () => {
  const built = V.buildRequest({ said: 'use sonnet', actions: ['model'], lists: { models: [{ id: 'a/sonnet', label: 'a/sonnet' }, { id: 'b/gpt', label: 'b/gpt' }] } });
  const d = V.readDecision(built, { action: answer('model', 0.95), 'model.model': answer('a/sonnet', 0.8) });
  assert.deepEqual([d.action, d.args, d.confidence], ['model', { model: 'a/sonnet' }, 0.8]);
  const m = V.readDecision(built, { action: answer('model', 1), 'model.model': answer('(not said)', 0.9) });
  assert.deepEqual([m.missing, m.confidence], ['model', 0.3]);
  const s = V.buildRequest({ said: 'yes please', actions: ['settings'] });
  assert.equal(V.readDecision(s, { action: answer('settings', 0.9), 'settings.pane': answer('(not said)', 0.9) }).missing, null, 'an optional argument');
});

test('dictation: words for the box, or steering it; send words come off the text', () => {
  const built = V.buildRequest({ said: 'fix the flaky test, send it', mode: 'dictation' });
  assert.deepEqual(Object.keys(built.request.questions), ['action']);
  const d = V.readDecision(built, { action: { choice: 'text_send', confidence: 0.9 } }, 'fix the flaky test, send it');
  assert.deepEqual([d.action, d.text], ['text_send', 'fix the flaky test']);
});
