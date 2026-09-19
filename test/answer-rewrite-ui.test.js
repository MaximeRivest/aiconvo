'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ConversationFlow = require('../conversation-flow');
const { normalizeSettings } = require('../settings');
const messages = [
  { eid: 'u', role: 'user', text: 'Explain it.' },
  { eid: 'a', role: 'assistant', text: 'Domain vocabulary.', model: 'one', provider: 'test' },
  { eid: 's', role: 'assistant', text: 'Everyday words.', model: 'one', provider: 'test', rewriteOf: 'a' },
];
function renderer() {
  const context = { ConversationFlow, toolGroupOpen: new Map(), esc: s => String(s ?? ''),
    msgBlock: (m, _e, _o, _q, i) => `<div data-eid="${m.eid}" data-i="${i}">${m.text}</div>` };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../conversation-reader'), 'utf8'), context);
  return vm.runInContext('transcriptFragmentHtml', context);
}
test('new visits show the complete simpler answer with both originals and actions preserved', () => {
  const html = renderer()({ key: 'chat', messages }, messages);
  assert.match(html, /data-answer-pane="simple"><div data-eid="s" data-i="2">Everyday words/);
  assert.match(html, /data-answer-pane="original" hidden><div data-eid="a" data-i="1">Domain vocabulary/);
  assert.equal((html.match(/Everyday words/g) || []).length, 1);
  assert.equal((html.match(/Domain vocabulary/g) || []).length, 1);
});
test('an answer already shown stays original when the simpler version arrives', () => {
  const render = renderer();
  render({ key: 'chat', messages }, messages.slice(0, 2));
  const html = render({ key: 'chat', messages }, messages);
  assert.match(html, /data-answer-pane="simple" hidden/);
  assert.match(html, /data-answer-pane="original">/);
});
test('exact search links expose the requested version rather than hiding it', () => {
  for (const exact of ['a', 's']) {
    const html = renderer()({ key: 'chat', messages }, messages, { exact });
    assert.doesNotMatch(html, /data-answer-pane/);
    assert.match(html, /Domain vocabulary/);
    assert.match(html, /Everyday words/);
  }
});
test('pairing cannot hide answers from another path, question or model', () => {
  assert.equal(ConversationFlow.rewritePairs(messages).size, 1);
  assert.equal(ConversationFlow.rewritePairs([messages[2]]).size, 0);
  assert.equal(ConversationFlow.rewritePairs([messages[1], messages[0], messages[2]]).size, 0);
  assert.equal(ConversationFlow.rewritePairs([messages[1], { ...messages[2], model: 'other' }]).size, 0);
});
test('the setting is on by default, can be disabled, and survives Pi-default settings', () => {
  assert.equal(normalizeSettings({}).simplifyAnswers, true);
  assert.equal(normalizeSettings({ simplifyAnswers: false }).simplifyAnswers, false);
  assert.equal(normalizeSettings({ usePiDefault: true, simplifyAnswers: false }).simplifyAnswers, false);
});
