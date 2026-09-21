'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// design/58: on a phone one bottom bar carries Agents, Gantt, New, Files and
// You; Agents and Files open as full-screen sheets above it and are the same
// elements the desktop column fills. Reading and typing hide the bar with the
// top bar; a sheet keeps it. The Android back button asks the page first.
test('phone shell: bottom bar, sheets, one-row head, back hook, desktop untouched', { timeout: 90000 }, async t => {
  const { home, base, work, auth, evaluate: ev, until, size, screenshot, exceptions } = await viewerBrowser(t);
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  const keys = {};
  for (const name of ['alpha', 'beta']) {
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    const lines = [{ type: 'session', version: 3, id: name, cwd: work },
      { type: 'message', id: name + '-p', parentId: null, timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: name + ' question' }] } }];
    for (let i = 0; i < 30; i++) lines.push({ type: 'message', id: name + '-a' + i, parentId: i ? name + '-a' + (i - 1) : name + '-p', timestamp: '2026-09-01T12:00:0' + (i % 10) + 'Z', message: { role: 'assistant', content: [{ type: 'text', text: name + ' reply ' + i + '. ' + 'Words that fill a phone screen. '.repeat(20) }] } });
    fs.writeFileSync(path.join(fixture, name + '.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
  }
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  await until(`sessions.some(s=>s.key===${JSON.stringify(keys.beta)})`);
  const doc = path.join(work, 'notes.md'); fs.writeFileSync(doc, '# Notes\n\nA file to open from the sheet.\n');
  await fetch(base + '/api/recent-files', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: doc, project: 'work' }) });

  // Desktop first: the column, no bar, the sheet head and ⋯ absent.
  assert.equal(await ev(`document.body.classList.contains('side-layout') && !document.body.classList.contains('phone-shell')`), true);
  assert.equal(await ev(`['phoneBar','agentsSheetHead','phoneMore'].every(id=>getComputedStyle($(id)).display==='none')`), true, 'desktop shows nothing of the shell');

  await size(390, 844, true);
  await until(`document.body.classList.contains('phone-shell') && !document.body.classList.contains('side-layout')`, 'the shell replaces the column on a phone');
  assert.equal(await ev(`$('agentsPop').hidden && $('agentsPop').parentElement.tagName==='BODY'`), true, 'the sheet starts closed');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#phoneBar [data-phone-tab]')].map(b=>b.dataset.phoneTab)`), ['agents', 'gantt', 'new', 'files']);
  assert.equal(await ev(`$('settingsBtn').closest('#phoneBar')!==null && $('settingsBtn').checkVisibility()`), true, 'You is the fifth tab');
  const fits = `(()=>{const r=$('phoneBar').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && Math.abs(r.bottom-innerHeight)<1 && r.height>=50})()`;
  assert.equal(await ev(fits), true, 'the bar sits on the bottom edge');
  assert.equal(await ev(`[...document.querySelectorAll('#phoneBar > button, #phoneBar > .pb-slot')].every(b=>b.getBoundingClientRect().height>=44)`), true, 'every tab is a finger target');
  assert.equal(await ev(`document.querySelector('[data-phone-tab=gantt]').getAttribute('aria-pressed')`), 'true', 'home lights Gantt');
  assert.equal(await ev(`$('gRecenter').getBoundingClientRect().bottom <= $('phoneBar').getBoundingClientRect().top`), true, 'the recenter control moved above the bar');
  await screenshot('phone-shell-home.png');

  // Agents: the desktop inbox in a sheet — Unread, Read, Working docked.
  await ev(`agentReadState.read=Object.fromEntries(sessions.map(s=>[s.key,1]));agentReadState.finished={};agentReadState.flagged={};jobs.set('run-1',{id:'run-1',type:'agent-run',status:'running',key:${JSON.stringify(keys.beta)}});activeRuns.set('run-1',{jobId:'run-1',key:${JSON.stringify(keys.beta)},status:'running',statusText:'tool · bash'});updateActiveBtn()`);
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`!$('agentsPop').hidden && $('agentsPop').dataset.panel==='inbox' && document.querySelector('#agentsLegacy [data-sec=traffic]')?.textContent.includes('beta')`, 'Agents opens as the inbox, with the running conversation in Working');
  assert.equal(await ev(`document.body.classList.contains('phone-sheet') && document.querySelector('[data-phone-tab=agents]').getAttribute('aria-pressed')==='true'`), true);
  assert.equal(await ev(`$('agentsSheetHead').checkVisibility() && $('agentsSheetClose').getBoundingClientRect().height>=44`), true, 'the sheet has a head with a close button');
  assert.equal(await ev(`(()=>{const p=$('agentsPop').getBoundingClientRect(),b=$('phoneBar').getBoundingClientRect();return p.top<=0.5 && Math.abs(p.bottom-b.top)<1 && p.width===innerWidth})()`), true, 'the sheet fills the screen above the bar');
  assert.equal(await ev(`!!document.querySelector('#agentsUnread [data-sec=unread]') && !!document.querySelector('#agentsUnread [data-sec=read]') && !!document.querySelector('#agentsLegacy [data-sec=traffic]')`), true, 'Unread and Read scroll; Working is docked');
  assert.equal(await ev(`(()=>{const w=document.querySelector('#agentsLegacy [data-sec=traffic]').getBoundingClientRect(),b=$('phoneBar').getBoundingClientRect();return w.bottom<=b.top+1 && w.top>=0})()`), true, 'Working is on screen without scrolling');
  assert.match(await ev(`document.querySelector('#agentsLegacy [data-sec=traffic]').textContent`), /beta/, 'the running conversation is in Working');
  assert.equal(await ev(`$('phoneBar').checkVisibility()`), true, 'the bar stays while a sheet is open');
  await screenshot('phone-shell-agents.png');
  // A row opens its conversation and closes the sheet; the one-row head shows a full title and ⋯.
  await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.alpha)}]').click()`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)} && $('agentsPop').hidden`, 'a row opens and the sheet closes');
  assert.equal(await ev(`document.body.classList.contains('phone-sheet')`), false);
  assert.equal(await ev(`(()=>{const t=$('chTitle').getBoundingClientRect();return t.width>innerWidth*0.5})()`), true, 'the title has the row');
  assert.equal(await ev(`$('phoneMore').checkVisibility() && ['newLoose','brand','activeBtn','chNew','chMove','barFold'].every(id=>!$(id).checkVisibility())`), true, 'one ⋯ instead of nine controls');
  assert.equal(await ev(`(()=>{const c=$('composerDock').getBoundingClientRect(),b=$('phoneBar').getBoundingClientRect();return Math.abs(c.bottom-b.top)<1})()`), true, 'the composer sits on the bar');
  await ev(`$('phoneMore').click()`);
  await until(`!!document.querySelector('.phone-more-menu')`);
  // The fixture's folder is not a project: no "new here", no project page, no file browser.
  assert.deepEqual(await ev(`[...document.querySelectorAll('.phone-more-menu button')].map(b=>b.textContent)`), ['Rename', 'Who can see this', 'Move to another project', 'Conversation tree']);
  assert.equal(await ev(`[...document.querySelectorAll('.phone-more-menu button')].every(b=>b.getBoundingClientRect().height>=44)`), true);
  assert.equal(await ev(`window.aiconvoBack()`), true, 'back closes the menu');
  assert.equal(await ev(`!document.querySelector('.phone-more-menu') && $('phoneMore').getAttribute('aria-expanded')==='false'`), true);
  await screenshot('phone-shell-conversation.png');

  // Reading hides the chrome, bar included; scrolling back up returns it.
  await ev(`$('view').scrollTop=600`);
  await new Promise(r => setTimeout(r, 100));
  await ev(`$('view').scrollTop=760`);
  await until(`document.body.classList.contains('chrome-min')`, 'scrolling down hides the chrome');
  assert.equal(await ev(`!$('phoneBar').checkVisibility() && getComputedStyle($('composerDock')).bottom==='0px'`), true, 'the bar leaves with the top bar; the composer drops to the edge');
  await ev(`$('view').scrollTop=600`);
  await until(`!document.body.classList.contains('chrome-min')`, 'scrolling up brings it back');
  assert.equal(await ev(`$('phoneBar').checkVisibility()`), true);
  // The keyboard: focus hides the bar too; blur alone does not bring it back (the page decides).
  await ev(`$('agentText').focus()`);
  await until(`document.body.classList.contains('chrome-min')`, 'typing hides the chrome');
  assert.equal(await ev(`$('phoneBar').checkVisibility()`), false);
  await ev(`$('agentText').blur();$('view').scrollTop=560`);
  await until(`!document.body.classList.contains('chrome-min')`, 'a small scroll up brings the chrome back after typing');

  // Files: the same file list as the desktop's right column, as a sheet.
  await ev(`document.querySelector('[data-phone-tab=files]').click()`);
  await until(`rightFilesOpen && document.body.classList.contains('phone-files') && !$('rightFilePanel').hidden`, 'Files opens as a sheet');
  assert.equal(await ev(`document.querySelector('.ag-files-block').checkVisibility() && [...document.querySelectorAll('.ag-file')].some(r=>r.dataset.path===${JSON.stringify(doc)})`), true, 'the recent file is listed');
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`!$('agentsPop').hidden && !rightFilesOpen`, 'one sheet at a time');
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`$('agentsPop').hidden`, 'the tab toggles its sheet closed');
  await ev(`document.querySelector('[data-phone-tab=files]').click()`);
  await until(`rightFilesOpen`);
  await screenshot('phone-shell-files.png');
  assert.equal(await ev(`window.aiconvoBack()`), true, 'back closes the sheet');
  await until(`!rightFilesOpen && !document.body.classList.contains('phone-sheet')`);
  assert.equal(await ev(`window.aiconvoBack()`), false, 'with nothing open, back is the page history');
  await ev(`document.querySelector('[data-phone-tab=files]').click()`);
  await until(`rightFilesOpen`);
  await ev(`document.querySelector('.ag-file[data-path=${JSON.stringify(doc)}] .ag-file-open').click()`);
  await until(`viewKind==='file' && fileWs?.path===${JSON.stringify(doc)} && !rightFilesOpen`, 'a file opens and the sheet closes');

  // Gantt and New from the bar; a project link inside the sheet closes it.
  await ev(`document.querySelector('[data-phone-tab=gantt]').click()`);
  await until(`viewKind==='home' && document.querySelector('[data-phone-tab=gantt]').getAttribute('aria-pressed')==='true'`);
  await ev(`document.querySelector('[data-phone-tab=new]').click()`);
  await until(`viewKind==='draft' && document.querySelector('[data-phone-tab=new]').getAttribute('aria-pressed')==='true'`, 'New starts a draft');
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`!$('agentsPop').hidden`);
  await ev(`document.querySelector('#agentsUnread .ag-row .ag-project').click()`);
  await until(`viewKind==='project' && $('agentsPop').hidden`, 'leaving for a page closes the sheet');
  assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`), true);

  // Back to a desk: the column returns, the bar goes, You is back in the column.
  await size(1440, 1000);
  await until(`document.body.classList.contains('side-layout') && !document.body.classList.contains('phone-shell')`);
  assert.equal(await ev(`getComputedStyle($('phoneBar')).display==='none' && $('settingsBtn').closest('#side')!==null && !$('agentsPop').hidden && $('agentsPop').parentElement.id==='sideAgents'`), true);
  assert.deepEqual(exceptions, []);
});
