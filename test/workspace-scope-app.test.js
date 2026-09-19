'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('one explicit project scope for browsing; a machine-wide Inbox; scope-aware history', { timeout: 60000 }, async t => {
  const { home, base, evaluate: ev, until, command, screenshot, requests, exceptions } = await viewerBrowser(t);
  const root = fs.mkdtempSync(path.join(os.homedir(), '.scope-projects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = {}, paths = {}, raw = {};
  for (const name of ['alpha', 'beta']) {
    const cwd = path.join(root, name); fs.mkdirSync(cwd);
    paths[name] = path.join(cwd, name + '.md'); fs.writeFileSync(paths[name], '# ' + name + '\n');
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    raw[name] = [
      { type: 'session', version: 3, id: name, cwd },
      { type: 'message', id: name+'-p', parentId: null, timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{type:'text',text:name+' question'}] } },
      { type: 'message', id: name+'-a', parentId: name+'-p', timestamp: '2026-09-01T12:00:01Z', message: { role: 'assistant', content: [{type:'text',text:name+' reply'}] } },
    ].map(JSON.stringify).join('\n')+'\n';
    fs.writeFileSync(path.join(home,'.pi/agent/sessions/fixture',name+'.jsonl'),raw[name]);
  }
  await fetch(base+'/api/rescan',{method:'POST'}); await ev(`load();loadSidebarProjectCatalog()`);
  await until(`sessions.some(s=>s.key===${JSON.stringify(keys.beta)}) && !sidebarProjectCatalogRequest`);
  const post = (url, body) => fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  for (const name of ['alpha','beta']) await post('/api/recent-files',{path:paths[name],project:name});
  await ev(`loadRecentFiles()`);
  const pick = async project => {
    await ev(`$('sideProject').click()`);
    await until(`!!document.querySelector('.project-scope-picker')`);
    await ev(`[...document.querySelectorAll('[data-workspace-project]')].find(b=>b.dataset.workspaceProject===${JSON.stringify(project)}).click()`);
    await until(`workspaceScope()===${JSON.stringify(project)}`);
  };
  await ev(`setSidePanel('projects')`);
  await until(`!!document.querySelector('[data-open-project=alpha]')`);
  await ev(`document.querySelector('[data-open-project=alpha]').click()`);
  await until(`viewKind==='project' && projectOverviewName==='alpha' && workspaceScope()==='alpha' && !!document.querySelector('.project-overview')`);
  assert.equal(await ev(`$('sideProject').textContent.includes('alpha')`), true);
  await ev(`setSidePanel('conversations');renderAgentsPop(false)`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('#agentsPop .ag-row[data-key]')].map(r=>r.dataset.key)`), [keys.alpha]);
  assert.equal(await ev(`!!document.querySelector('#agentsPop [data-sec=unread],#agentsPop [data-sec=read],[data-scope-of]')`), false, 'Chats has neither global inbox sections nor a second scope toggle');
  await ev(`setSidePanel('files')`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-file')].map(r=>r.dataset.path)`), [paths.alpha]);
  await pick('beta'); await ev(`setSidePanel('files');renderAgentsPop(false)`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-file')].map(r=>r.dataset.path)`), [paths.beta]);
  assert.equal(await ev(`$('sideNew').querySelector('span').textContent`), 'new here', 'new here follows the chosen project, not a stale chat');
  await pick(''); await ev(`setSidePanel('files');renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelectorAll('.ag-file').length`), 2);
  await ev(`open(${JSON.stringify(keys.alpha)})`);
  assert.equal(await ev(`workspaceScope()`), '', 'All stays broad while browsing ordinary chats');

  // Browsing a project and returning restores the old All scope, not merely
  // whichever project happens to be on screen at the time of Back.
  await pick('beta'); await until(`viewKind==='project' && projectOverviewName==='beta'`);
  await ev(`history.back()`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)} && workspaceScope()===''`);
  await ev(`history.forward()`);
  await until(`viewKind==='project' && projectOverviewName==='beta' && workspaceScope()==='beta'`);

  // Inbox is global, includes pinned unread chats, and names their projects.
  await ev(`pushAgentReads()`); await until(`agentReadPending.size===0 && !agentReadPushing`);
  await post('/api/agent-read',{unread:[keys.alpha,keys.beta],pin:{[keys.beta]:true}});
  await ev(`fetchAgentReadState()`);
  await ev(`setSidePanel('inbox');setInboxTab('unread')`);
  await until(`document.querySelectorAll('.ag-unread-tray .ag-row[data-key]').length>=2`);
  assert.match(await ev(`$('agentsPop').textContent`), /All projects on this machine/);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-unread-tray .ag-row .ag-dir')].map(n=>n.textContent).sort()`), ['alpha','beta']);
  assert.equal(await ev(`document.querySelector('[data-rail=conversations] .rail-badge').hidden`), true, 'global unread indicator belongs to Inbox, not Chats');
  assert.equal(await ev(`document.querySelector('[data-rail=inbox] .rail-badge').hidden`), false);
  await ev(`[...document.querySelectorAll('.ag-unread-tray .ag-row')].find(r=>r.dataset.key===${JSON.stringify(keys.alpha)}).click()`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)} && workspaceScope()==='alpha'`);
  assert.equal(await ev(`sidePanel()`), 'inbox', 'opening a reply does not hide the global Inbox');
  await until(`!!document.querySelector('.ag-unread-tray .ag-row[data-key=${JSON.stringify(keys.beta)}]')`);
  await ev(`document.querySelector('[data-inbox-tab=read]').click()`);
  await until(`!!document.querySelector('[data-sec=read] .ag-row[data-key=${JSON.stringify(keys.alpha)}]')`);
  assert.equal(await ev(`!!document.querySelector('[data-sec=unread]')`), false);
  await ev(`setSidePanel('conversations')`);
  assert.equal(await ev(`!!document.querySelector('[data-sec=unread],[data-sec=read]')`), false);
  assert.deepEqual(await ev(`[...document.querySelectorAll('#agentsPop .ag-row[data-key]')].map(r=>r.dataset.key)`), [keys.alpha], 'read history no longer steals a chat from its project list');

  // Agents and their badges obey the same scope; unknown processes are global.
  await ev(`window.savedScopeProcs=agentsProcs;agentsProcs=[{pid:99101,key:${JSON.stringify(keys.alpha)},kind:'pi',owner:'fixture',busy:false,title:'alpha worker'},{pid:99102,key:${JSON.stringify(keys.beta)},kind:'pi',owner:'fixture',busy:false,title:'beta worker'},{pid:99103,kind:'pi',owner:'fixture',busy:false,title:'unknown worker'}];setSidePanel('traffic');updateActiveBtn()`);
  assert.equal(await ev(`$('agentsPop').textContent.includes('beta worker') || $('agentsPop').textContent.includes('unknown worker')`), false);
  assert.equal(await ev(`railBadgeState.traffic`), 1);
  await pick(''); await ev(`setSidePanel('traffic');renderAgentsPop(false);updateActiveBtn()`);
  assert.equal(await ev(`$('agentsPop').textContent.includes('unknown worker')`), true);
  assert.equal(await ev(`railBadgeState.traffic`), 3);
  await ev(`agentsProcs=savedScopeProcs`);

  // No project is an explicit collection, not another spelling of All.
  await pick('Loose conversations'); await ev(`setSidePanel('conversations');renderAgentsPop(false)`);
  assert.equal(await ev(`$('sideProject').querySelector('span').textContent`), 'No project');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#agentsPop .ag-row[data-key]')].map(r=>r.dataset.key)`), ['pi:fixture/media.jsonl']);
  await pick('alpha'); await ev(`setSidePanel('files')`);
  // A direct file link outside the selected scope adopts its own project.
  // A deliberately delayed project response must not overwrite that file.
  await ev(`window.scopeFetch=fetch;window.scopeProjectReply=null;window.fetch=(url,opts)=>String(url)==='/api/project?name=alpha'?new Promise(resolve=>scopeProjectReply=resolve):scopeFetch(url,opts);window.slowProject=showProjectOverview('alpha');void 0`);
  await until(`!!window.scopeProjectReply`);
  await ev(`openLiveFile(${JSON.stringify(paths.beta)},{project:'beta'})`);
  await until(`fileWs?.path===${JSON.stringify(paths.beta)} && !!fileWs.editor && workspaceScope()==='beta'`);
  await ev(`scopeProjectReply(new Response(JSON.stringify({error:'old project response'})));slowProject`);
  await ev(`window.fetch=scopeFetch`);
  assert.equal(await ev(`viewKind==='file' && !!$('docEditor') && workspaceScope()==='beta'`), true, 'a late project response cannot paint over a newer file');
  await ev(`window.scopeBeforeReload=true`); await command('Page.reload');
  await until(`!window.scopeBeforeReload && typeof workspaceScope==='function' && workspaceScope()==='beta' && fileWs?.path===${JSON.stringify(paths.beta)}`);
  assert.equal(await ev(`$('sideProject').querySelector('span').textContent`), 'beta');
  await ev(`setSidePanel('inbox');setInboxTab('unread')`);
  await screenshot('workspace-inbox.png');
  await ev(`setSidePanel('files')`); await screenshot('workspace-files.png');
  await ev(`$('sideProject').click()`); await screenshot('workspace-project-picker.png');
  assert.equal(requests.some(r=>r.method==='PUT'&&r.url.includes('/api/conversation/project')), false, 'scope selection never reassigns a conversation');
  for (const name of ['alpha','beta']) assert.equal(fs.readFileSync(path.join(home,'.pi/agent/sessions/fixture',name+'.jsonl'),'utf8'),raw[name], 'navigation never rewrites the session');
  assert.deepEqual(exceptions, []);
});
