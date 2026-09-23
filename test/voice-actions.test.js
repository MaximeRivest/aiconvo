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

test('the request: the actions that apply, their arguments over real candidates; not a proxy', () => {
  const built = V.buildRequest({ said: 'open the third conversation', actions: ['open_conversation', 'reasoning', 'bogus'], lists: { conversations: [{ id: 'a', label: '1. First' }, { id: 'b', label: '2. Second' }] } });
  assert.deepEqual(Object.keys(built.request.questions).sort(), ['action', 'open_conversation.conversation', 'reasoning.level']);
  assert.deepEqual(Object.keys(built.request.questions.action.criteria).sort(), ['none', 'open_conversation', 'reasoning']);
  assert.deepEqual(built.keys['open_conversation.conversation'], { '1. First': 'a', '2. Second': 'b' });
  assert.throws(() => V.buildRequest({ said: '  ' }), /nothing was said/);
  // A suggestion waiting for an answer adds yes / no.
  assert.ok('confirm' in V.buildRequest({ said: 'yes', actions: ['send'], pending: 'Send the message' }).request.questions.action.criteria);
  assert.ok(!('confirm' in V.buildRequest({ said: 'yes', actions: ['send', 'confirm'] }).request.questions.action.criteria));
  // Old text must be in the document; "this" is the selection.
  const r = V.buildRequest({ said: 'change this to that', actions: ['replace'], doc: { selection: 'x', nearby: 'this and that' } });
  assert.equal(Object.keys(r.request.questions['replace.old'].criteria)[0], '(the selected text)');
  assert.ok(!('this' in r.request.questions['replace.old'].criteria));
});

test('reading the answers: ids back, the least certain part, a missing argument asks', () => {
  const built = V.buildRequest({ said: 'open the second', actions: ['open_conversation'], lists: { conversations: [{ id: 'a', label: '1. First' }, { id: 'b', label: '2. Second' }] } });
  const d = V.readDecision(built, { action: { choice: 'open_conversation', confidence: 0.95, probabilities: { open_conversation: 0.95, none: 0.05 } }, 'open_conversation.conversation': { choice: '2. Second', confidence: 0.8 } });
  assert.deepEqual([d.action, d.args, d.confidence], ['open_conversation', { conversation: 'b' }, 0.8]);
  const m = V.readDecision(built, { action: { choice: 'open_conversation', confidence: 1 }, 'open_conversation.conversation': { choice: '(not said)', confidence: 0.9 } });
  assert.deepEqual([m.missing, m.confidence], ['conversation', 0.3]);
  const s = V.buildRequest({ said: 'yes please', actions: ['settings'] });
  assert.equal(V.readDecision(s, { action: { choice: 'settings', confidence: 0.9 }, 'settings.pane': { choice: '(not said)', confidence: 0.9 } }).missing, null, 'an optional argument');
});

test('dictation: words for the box, or steering it; send words come off the text', () => {
  const built = V.buildRequest({ said: 'fix the flaky test, send it', mode: 'dictation' });
  assert.deepEqual(Object.keys(built.request.questions), ['action']);
  const d = V.readDecision(built, { action: { choice: 'text_send', confidence: 0.9 } }, 'fix the flaky test, send it');
  assert.deepEqual([d.action, d.text], ['text_send', 'fix the flaky test']);
});
