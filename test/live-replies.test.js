const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../conversation-reader.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function savedLiveReplies('), source.indexOf('function renderLiveReplyLedger(')), context);
const savedReplies = context.savedLiveReplies;
const ledger = blocks => ({ startedAt: 1000, order: blocks.map((_, i) => String(i)), blocks: new Map(blocks.map((b, i) => [String(i), b])) });
const message = (text, time, eid) => ({ role: 'assistant', text, ts: new Date(time).toISOString(), eid });
test('handoff matches ordered saved replies, not identical older answers', () => {
  const L = ledger([{ text: 'hello', done: true }, { kind: 'tool' }, { text: 'hello', done: true }]);
  const matches = savedReplies(L, [message('hello', 500, 'old'), message('hello', 1100, 'a'), message('hello', 1200, 'b')]);
  assert.equal(matches.get('0').eid, 'a'); assert.equal(matches.get('2').eid, 'b');
});
test('unfinished or unsaved replies remain visible; stopped partial replies can settle', () => {
  const L = ledger([{ text: 'partial' }, { text: 'not saved', done: true }]);
  const messages = [message('partial', 1200, 'a')];
  assert.equal(savedReplies(L, messages).size, 0);
  L.done = true;
  assert.equal(savedReplies(L, messages).get('0').eid, 'a');
  assert.equal(savedReplies(L, messages).size, 1);
});
test('work is grouped between replies, without merging separate messages', () => {
  const L = ledger([{ think: 'plan' }, { kind: 'tool', name: 'read' }, { text: 'commentary' }, { kind: 'tool', name: 'edit' }, { kind: 'tool', name: 'bash' }, { text: 'answer' }]);
  const units = context.liveReplyUnits(L);
  assert.equal(units.length, 4);
  assert.equal(units[0].order.length, 2);
  assert.equal(units[1].block.text, 'commentary');
  assert.equal(units[2].order.length, 2);
  assert.equal(units[3].block.text, 'answer');
});
test('the actual final-event shape must not erase the run start or replay saved replies', () => {
  const app = fs.readFileSync(require('node:path').join(__dirname, '../app.html'), 'utf8');
  const ctx = vm.createContext({ current: null, activeRel: 'A', activeRuns: new Map(), readerLiveMessages: new Map(), savedLiveReplies: savedReplies });
  vm.runInContext(app.slice(app.indexOf('const runLedgers = new Map();'), app.indexOf('\nfunction setLiveText(', app.indexOf('function ledgerAbsorb('))), ctx);
  vm.runInContext(`ledgerAbsorb({jobId:'job-A',key:'A',startedAt:1000,tail:[{id:1,kind:'text',text:'hello',done:true}]});
    ledgerAbsorb({jobId:'job-A',key:'A',status:'done',final:true,finishedAt:1500});`, ctx);
  const L = vm.runInContext(`runLedgers.get('job-A')`, ctx);
  assert.equal(L.startedAt, 1000);
  assert.equal(savedReplies(L, [message('hello', 1200, 'a')]).size, 1);
});
test('long replies are matched without losing their beginning', () => {
  const text = 'start' + 'x'.repeat(60000);
  const L = ledger([{ text, done: true }]);
  assert.equal(savedReplies(L, [message(text, 1200, 'long')]).get('0').eid, 'long');
});
