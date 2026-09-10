'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a delayed file return cannot reposition a newer visit to the same conversation', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
  let finish, frame;
  const ctx = vm.createContext({
    conversationFileReturn: null, conversationLoadSeq: 0,
    current: { key: 'A' }, activeRel: 'A', viewKind: 'conversation',
    $: () => ({ querySelectorAll: () => { throw Error('stale return touched the new screen'); } }),
    requestAnimationFrame: fn => { frame = fn; },
  });
  ctx.open = () => { ctx.conversationLoadSeq++; return new Promise(resolve => { finish = resolve; }); };
  const start = app.indexOf('async function returnToConversationFile(');
  vm.runInContext(app.slice(start, app.indexOf('\nfunction filePickButtons()', start)), ctx);
  const pending = ctx.returnToConversationFile('A', '/file', '', '');
  // The person navigated again before the first fetch/render finished.
  ctx.conversationLoadSeq++;
  finish(); await pending;
  assert.equal(typeof frame, 'function');
  assert.doesNotThrow(frame);
});
