'use strict';
// design/59: the side list holds the conversations a person opened — newest
// conversation on top — with the assistant's typing dots while it works, a
// dot and bold title once it replied and nobody read it, and a ✕ to close.
// No Unread / Read / Working sections, no "Return to work". Against the real
// server and a headless Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

test('the side list: opened conversations, typing dots, unread dot, close', { timeout: 60000 }, async t => {
  if (spawnSync(process.env.CHROMIUM_BIN || 'chromium', ['--version']).error) return t.skip('chromium is not installed');
  const { home, base, work, auth, evaluate: ev, until, screenshot, exceptions } = await viewerBrowser(t);
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  const keys = {};
  // Three conversations born a day apart: gamma is the newest.
  const born = { alpha: '2026-09-01T12:00:00Z', beta: '2026-09-02T12:00:00Z', gamma: '2026-09-03T12:00:00Z' };
  for (const [name, ts] of Object.entries(born)) {
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    fs.writeFileSync(path.join(fixture, name + '.jsonl'), [
      { type: 'session', version: 3, id: name, cwd: work },
      { type: 'message', id: name + '-p', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: name + ' question' }] } },
      { type: 'message', id: name + '-a', parentId: name + '-p', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: name + ' reply.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  await until(`sessions.some(s=>s.key===${JSON.stringify(keys.gamma)})`);
  const rows = `[...document.querySelectorAll('#agentsUnread [data-sec=open] .ag-row[data-key]')].map(r=>r.dataset.key)`;

  // The column is the list, and it starts empty.
  assert.equal(await ev(`document.body.classList.contains('side-layout') && !$('agentsPop').hidden`), true, 'the side column is open');
  assert.equal(await ev(`!!document.querySelector('#agentsUnread [data-sec=open] .ag-empty')`), true, 'the list starts empty');
  assert.equal(await ev(`!document.querySelector('[data-sec=unread],[data-sec=read],[data-sec=traffic],.read-scope,#returnToWork')`), true, 'no Unread / Read / Working sections, no Return to work');

  // Opening lists, in first-message order, newest on top — not in opening order.
  await ev(`open(${JSON.stringify(keys.alpha)})`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)}`);
  await until(`${rows}.length===1`, 'the opened conversation is listed');
  await ev(`open(${JSON.stringify(keys.gamma)})`);
  await until(`current?.key===${JSON.stringify(keys.gamma)} && ${rows}.length===2`);
  await ev(`open(${JSON.stringify(keys.beta)})`);
  await until(`current?.key===${JSON.stringify(keys.beta)} && ${rows}.length===3`);
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'newest first message on top');
  assert.equal(await ev(`document.querySelector('#agentsUnread .ag-row.current')?.dataset.key`), keys.beta, 'the open conversation is marked');
  for (let i = 0; i < 100 && Object.keys((await (await fetch(base + '/api/agent-read', { headers: auth })).json()).opened).length < 3; i++) await new Promise(r => setTimeout(r, 30));
  const shared = await (await fetch(base + '/api/agent-read', { headers: auth })).json();
  assert.deepEqual(Object.keys(shared.opened).sort(), Object.values(keys).sort(), 'the list is shared through the server');

  // Working: three typing dots, no unread dot; the human typing bubble is a different element.
  await ev(`jobs.set('run-1',{id:'run-1',type:'agent-run',status:'running',key:${JSON.stringify(keys.alpha)}});activeRuns.set('run-1',{jobId:'run-1',key:${JSON.stringify(keys.alpha)},status:'running',statusText:'tool · bash'});updateActiveBtn();renderAgentsPop(false)`);
  await until(`document.querySelector('#agentsUnread .ag-row.working[data-key=${JSON.stringify(keys.alpha)}] .ag-typing')`, 'the working row shows typing dots');
  assert.equal(await ev(`(()=>{const r=document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.alpha)}]');return r.classList.contains('unread')||!!r.querySelector('.user-bubble.typing')})()`), false, 'not unread, and not the human typing bubble');
  assert.match(await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.alpha)}] .ag-age').textContent`), /tool · bash/, 'the row says what the assistant is doing');
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'work does not reorder the list');

  // Finished, unread: a dot and a bold title; the rail counts it. A reply
  // is a transcript write newer than the last read.
  await ev(`activeRuns.clear();jobs.delete('run-1')`);
  await until(`agentReadPending.size===0`, 'reads reached the server');
  const reply = async (name, text) => {
    await new Promise(r => setTimeout(r, 1100));
    fs.appendFileSync(path.join(fixture, name + '.jsonl'), JSON.stringify({ type: 'message', id: name + '-' + Date.now(), parentId: name + '-a', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
    await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  };
  await reply('alpha', 'Alpha again.');
  await until(`document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'the finished reply is unread');
  assert.equal(await ev(`(()=>{const r=document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]');const t=r.querySelector('.ag-title');return !r.querySelector('.ag-typing') && getComputedStyle(t).fontWeight>=700 && getComputedStyle(t,'::after').display==='block'})()`), true, 'bold title and a dot, no typing dots');
  assert.equal(await ev(`$('side').dataset.unread`), '1', 'the column counts one unread');
  await ev(`jobs.set('run-2',{id:'run-2',type:'agent-run',status:'running',key:${JSON.stringify(keys.beta)}});activeRuns.set('run-2',{jobId:'run-2',key:${JSON.stringify(keys.beta)},status:'running',statusText:'thinking'});renderAgentsPop(false)`);
  await until(`document.querySelector('#agentsUnread .ag-row.working[data-key=${JSON.stringify(keys.beta)}]')`);
  await screenshot('open-list.png');
  await ev(`activeRuns.delete('run-2');jobs.delete('run-2');renderAgentsPop(false)`);

  // Reading it clears the dot. Closing takes it off the list; the rest stays.
  await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.alpha)}]').click()`);
  await until(`current?.key===${JSON.stringify(keys.alpha)} && !document.querySelector('#agentsUnread .ag-row.unread')`, 'reading clears the dot');
  assert.equal(await ev(`$('side').dataset.unread`), '', 'nothing unread');
  await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.gamma)}] .ag-close').click()`);
  await until(`${rows}.length===2`, 'closed: off the list');
  assert.deepEqual(await ev(rows), [keys.beta, keys.alpha]);
  for (let i = 0; i < 100 && !(keys.gamma in (await (await fetch(base + '/api/agent-read', { headers: auth })).json()).dismissed); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(keys.gamma in (await (await fetch(base + '/api/agent-read', { headers: auth })).json()).dismissed, 'the close reached the server');

  // A closed conversation that replies again comes back, unread.
  await reply('gamma', 'Gamma again.');
  await until(`document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.gamma)}]')`, 'a later reply lists it again, unread');
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'back in its place');

  // Opening a closed conversation lists it again, too.
  await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.beta)}] .ag-close').click()`);
  await until(`${rows}.length===2`);
  await ev(`open(${JSON.stringify(keys.beta)})`);
  await until(`current?.key===${JSON.stringify(keys.beta)} && ${rows}.length===3`, 'opening lists a closed conversation again');

  // The ⋯ menu: pin, mark unread, close, open — no "remove from replies".
  await ev(`openAgentRowMenu(${JSON.stringify(keys.alpha)}, 0, 0)`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-menu [data-ag-action]')].map(b=>b.textContent)`), ['Pin to the top', 'Mark as unread', 'Close', 'Open']);
  await ev(`closeFileActionMenu()`);
  assert.deepEqual(exceptions, []);
});
