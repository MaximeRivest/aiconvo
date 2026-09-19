'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../sidebar-projects');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('project directory includes empty registered projects, folds, titles and current activity', () => {
  const rows = P.build([
    { project: 'work', cwd: '/work/sub', mtimeMs: 200 },
    { project: 'work-tree', cwd: '/work-tree', mtimeMs: 300 },
    { project: 'work', hiddenFanout: true, mtimeMs: 900 },
    { project: 'Loose conversations', mtimeMs: 999 },
  ], [{ name: 'empty', cwd: '/empty', createdAt: 100 }], [{ name: 'work', cwd: '/work', title: 'Workspace' }], s => s.project === 'work-tree' ? 'work' : s.project);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(r => r.name === 'work'), { name: 'work', title: 'Workspace', cwd: '/work', count: 2, latest: 300, createdAt: 0 });
  assert.equal(rows.find(r => r.name === 'empty').count, 0);
  assert.deepEqual(P.select(rows, { query: 'work space' }).map(r => r.name), ['work']);
});

test('file work contributes recency without changing conversation counts or inventing projects', () => {
  const rows = P.build([{ project: 'work', cwd: '/work', mtimeMs: 10 }], [], [], s => s.project,
    'Loose conversations', [{ project: 'work', at: 90 }, { project: 'orphan', at: 100 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latest, 90);
  assert.equal(rows[0].count, 1);
});

test('sort modes are stable and unknown measurements are never treated as zero', () => {
  const rows = [
    { name: 'a', title: 'Zebra', count: 2, latest: 40, cwd: '/a' },
    { name: 'b', title: 'Alpha', count: 5, latest: 20, cwd: '/b' },
    { name: 'c', count: 1, latest: 10, cwd: '/c' },
  ];
  const names = options => P.select(rows, options).map(r => r.name);
  assert.deepEqual(names({ sort: 'recent' }), ['a', 'b', 'c']);
  assert.deepEqual(names({ sort: 'name' }), ['b', 'c', 'a']);
  assert.deepEqual(names({ sort: 'count' }), ['b', 'a', 'c']);
  assert.deepEqual(names({ sort: 'size', stats: { a: { size: 0 }, c: { size: 90 } } }), ['c', 'a', 'b']);
  assert.deepEqual(names({ sort: 'born', stats: { a: { born: 0 }, b: { born: 20 }, c: { born: 10 } } }), ['b', 'c', 'a']);
});

test('projects, quiet badges, expanded chart bounds and scroll-loaded lists in the real app', { timeout: 60000 }, async t => {
  const { home, base, evaluate: ev, until, size, command, screenshot, exceptions } = await viewerBrowser(t);
  // Temporary cwd paths are intentionally classified as loose conversations.
  // Give this fixture a real project-shaped cwd outside /tmp.
  const projectHome = fs.mkdtempSync(path.join(os.homedir(), '.sidebar-projects-test-'));
  t.after(() => fs.rmSync(projectHome, { recursive: true, force: true }));
  const cwd = path.join(projectHome, 'work'); fs.mkdirSync(cwd);
  const sessionFile = path.join(home, '.pi/agent/sessions/fixture/media.jsonl');
  const entries = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  entries[0].cwd = cwd; fs.writeFileSync(sessionFile, entries.map(JSON.stringify).join('\n') + '\n');
  await fetch(base + '/api/rescan', { method: 'POST' });
  await ev(`load()`);
  await until(`sessions.some(s=>projectOf(s)==='work') && sideLayoutOn()`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('#sideRail [data-rail]')].map(b=>b.dataset.rail)`), ['projects','conversations','files','traffic','inbox']);
  await ev(`document.querySelector('[data-rail=projects]').click()`);
  await until(`!!document.querySelector('[data-open-project=work]') && !sidebarProjectCatalogRequest`);
  assert.equal(await ev(`sidebarProjectSort()`), 'recent');
  assert.equal(await ev(`viewKind`), 'home', 'choosing a rail panel does not replace the open page');
  await ev(`$('sidebarProjectQuery').focus();$('sidebarProjectQuery').value='not-a-project';$('sidebarProjectQuery').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await ev(`document.querySelectorAll('[data-open-project]').length`), 0);
  assert.equal(await ev(`document.activeElement.id`), 'sidebarProjectQuery', 'search keeps keyboard focus across repaint');
  await ev(`$('sidebarProjectQuery').value='work';$('sidebarProjectQuery').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-open-project=work]').click()`);
  await until(`viewKind==='project' && !!document.querySelector('.mgantt')`);
  // Opening the timeline must never cover the rail or panel.
  await ev(`document.querySelector('.mgantt').click()`);
  await until(`!!document.querySelector('.mgantt[data-mg-open]')`);
  const bounds = () => ev(`(()=>{const g=document.querySelector('.mgantt[data-mg-open]').getBoundingClientRect(),s=$('side').getBoundingClientRect();return {left:g.left,right:g.right,top:g.top,edge:s.right}})()`);
  let b = await bounds(); assert.ok(Math.abs(b.left-b.edge)<2 && b.right<=1440 && b.top===0, JSON.stringify(b));
  assert.equal(await ev(`document.elementFromPoint(100,100)?.closest('#side') !== null`), true, 'chart never paints over sidebar controls');
  await screenshot('projects-gantt-layout.png');
  await ev(`setSideFold(true)`);
  b = await bounds(); assert.ok(Math.abs(b.left-56)<2, 'folded chart starts after the rail');
  await ev(`setSideFold(false)`);
  await size(390, 844); await until(`!sideLayoutOn()`);
  b = await bounds(); assert.equal(b.left, 0); assert.ok(b.right<=390);
  await size(1440, 1000); await until(`sideLayoutOn()`);
  await ev(`mgCollapseOpen()`);

  // Snapshot synthetic badge values in the same turn: a real process poll
  // may otherwise replace them between separate browser requests.
  const badgeExpression = `['traffic','inbox'].map(id=>{const b=document.querySelector('[data-rail="'+id+'"] .rail-badge');return {text:b.textContent,dot:b.classList.contains('dot')}})`;
  assert.deepEqual(await ev(`paintRailBadges({traffic:12,notifications:7,working:true,unread:3});${badgeExpression}`), [{text:'',dot:true},{text:'',dot:true}]);
  assert.equal(await ev(`document.querySelector('[data-rail=conversations] .rail-badge').hidden`), true);
  await ev(`showSettings('appearance')`);
  await until(`!!$('setRailCounts')`);
  assert.equal(await ev(`$('setRailCounts').checked`), false);
  assert.deepEqual(await ev(`$('setRailCounts').checked=true;$('setRailCounts').dispatchEvent(new Event('change'));paintRailBadges({traffic:12,notifications:7,unread:3});${badgeExpression}`), [{text:'12',dot:false},{text:'3',dot:false}]);
  assert.equal(await ev(`JSON.parse(localStorage.getItem(AGENT_SEC_KEY)).railCounts`), true);
  await ev(`window.beforeBadgeReload=true`); await command('Page.reload');
  await until(`!window.beforeBadgeReload && !!document.querySelector('#setRailCounts')`);
  assert.equal(await ev(`$('setRailCounts').checked`), true, 'badge preference survives reload');
  await ev(`$('setRailCounts').checked=false;$('setRailCounts').dispatchEvent(new Event('change'));goHome();loadSidebarProjectCatalog()`);
  await until(`!sidebarProjectCatalogRequest`);

  // UI fixtures: thousands of real records are unnecessary to test paging.
  // All production selection, rendering and scroll handlers remain in use.
  await ev(`window.panelFixtureKeep={sessions,projectFolds,recentFilesList,agentReadState,agentSecState:{...agentSecState},catalog:sidebarProjectCatalog};
    const old=Date.now()-7*86400000;
    sessions=Array.from({length:205},(_,i)=>({key:'pi:page/'+i,source:'pi',project:'page-project-'+String(i).padStart(3,'0'),cwd:'/fixture/page-'+i,title:'Older conversation '+i,lastUserTs:new Date(old-i*1000).toISOString(),mtimeMs:old-i*1000}));
    projectFolds={map:{},created:[{name:'empty-project',cwd:'/fixture/empty',createdAt:old}],suggestions:[]};sidebarProjectCatalog=[];
    agentSecState.projectScope='';agentSecState.projectSort='recent';agentSecState.panel='projects';sidebarProjectQuery='';panelListLimits.clear();paintSideRail();renderAgentsPop(false);`);
  assert.equal(await ev(`document.querySelectorAll('[data-open-project]').length`), 100, 'first page, not eight projects');
  await ev(`$('agentsPop').scrollTop=$('agentsPop').scrollHeight;$('agentsPop').dispatchEvent(new Event('scroll'))`);
  await until(`document.querySelectorAll('[data-open-project]').length===200`);
  await ev(`document.querySelector('[data-panel-more=projects]').click()`);
  assert.equal(await ev(`document.querySelectorAll('[data-open-project]').length`), 206, 'all projects including registered empty projects are reachable');
  await ev(`$('sidebarProjectQuery').value='empty-project';$('sidebarProjectQuery').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await ev(`document.querySelectorAll('[data-open-project]').length`), 1);
  assert.match(await ev(`document.querySelector('[data-open-project]').textContent`), /0 conversations/);
  await ev(`$('sidebarProjectQuery').value='';$('sidebarProjectQuery').dispatchEvent(new Event('input',{bubbles:true}));window.statsFetch=fetch;window.projectStatCalls=[];window.fetch=(url,opts)=>String(url)==='/api/projects/stats'?(projectStatCalls.push(JSON.parse(opts.body)),Promise.resolve(new Response(JSON.stringify({stats:Object.fromEntries(JSON.parse(opts.body).paths.map((p,i)=>[p,{size:i*100,born:i+1}]))})))):statsFetch(url,opts)`);
  assert.equal(await ev(`projectStatCalls.length`), 0, 'no disk measurements for recent sort');
  await ev(`$('sidebarProjectSort').value='size';$('sidebarProjectSort').dispatchEvent(new Event('change'))`);
  await until(`!sidebarProjectStatsRequest.busy && projectStatCalls.length===1`);
  assert.equal(await ev(`projectStatCalls[0].size`), true);
  await ev(`renderSidebarProjects()`);
  assert.equal(await ev(`projectStatCalls.length`), 1, 'repaints reuse folder measurements');
  assert.equal(await ev(`JSON.parse(localStorage.getItem(AGENT_SEC_KEY)).projectSort`), 'size');
  await screenshot('projects-directory.png');
  await ev(`window.fetch=statsFetch;setSidePanel('conversations');panelListLimits.clear();renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelectorAll('[data-sec=recent] .ag-row[data-key]').length`), 100, 'recent chats are no longer capped at eight');
  await ev(`document.querySelector('[data-panel-more=recent]').click();document.querySelector('[data-panel-more=recent]').click()`);
  assert.equal(await ev(`document.querySelectorAll('[data-sec=recent] .ag-row[data-key]').length`), 205);
  await ev(`agentReadState={...agentReadState,read:{...agentReadState.read}};for(const s of sessions)agentReadState.read[s.key]=Date.now();panelListLimits.clear();setSidePanel('inbox');setInboxTab('read');renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelectorAll('[data-sec=read] .ag-row[data-key]').length`), 100, 'read replies are no longer capped at fifteen');
  await ev(`document.querySelector('[data-panel-more=read]').click();document.querySelector('[data-panel-more=read]').click()`);
  assert.equal(await ev(`document.querySelectorAll('[data-sec=read] .ag-row[data-key]').length`), 205);
  await ev(`recentFilesList=Array.from({length:205},(_,i)=>({path:'/fixture/file-'+i+'.md',project:'fixture',actor:'human',kind:'opened',at:Date.now()-i}));agentSecState['files:actor']='human';panelListLimits.clear();setSidePanel('files')`);
  assert.equal(await ev(`document.querySelectorAll('.ag-file').length`), 100, 'files are no longer capped at eight');
  await ev(`$('agentsPop').scrollTop=$('agentsPop').scrollHeight;$('agentsPop').dispatchEvent(new Event('scroll'))`);
  await until(`document.querySelectorAll('.ag-file').length===200`);
  await ev(`document.querySelector('[data-panel-more=files]').click()`);
  assert.equal(await ev(`document.querySelectorAll('.ag-file').length`), 205);
  assert.equal(await ev(`!!document.querySelector('[data-panel-more=files]')`), false, 'no dead end before the last record');
  await ev(`({sessions,projectFolds,recentFilesList,agentReadState,agentSecState}=panelFixtureKeep);sidebarProjectCatalog=panelFixtureKeep.catalog;panelListLimits.clear();saveAgentSecState();setSidePanel('projects')`);
  assert.deepEqual(exceptions, []);
});
