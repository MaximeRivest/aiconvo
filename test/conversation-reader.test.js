'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
function extract(start, end) {
  const a = app.indexOf(start), b = app.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return app.slice(a, b);
}
function fixture() {
  const code = [
    fs.readFileSync(path.join(root, 'conversation-flow.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'conversation-reader.js'), 'utf8'),
    extract('function setRoute(kind, hash)', '\nfunction goHome()'),
    extract('function dispatchHash(h, { restore = false } = {}) {', '\nconst $ = id => document.getElementById'),
    extract('async function open(rel, scroll,', '// ---- distillation ----'),
    extract('async function renderConv(scroll) {', '// ---- trace machinery ----'),
    extract('function computeTrace(d) {', '\nconst compareCache'),
    extract('function msgBlock(m, hl, keepOpen', '// Every bash fence'),
    extract("$('view').addEventListener('click', async e => {", '// ---- transcript editing ----'),
    extract('async function headlessSendFromComposer(', '// One server-side model set'),
  ].join('\n');
  const tokens = fs.readFileSync(path.join(root, 'design/tokens.css'), 'utf8');
  const css = app.match(/<style>([\s\S]*?)<\/style>/)[1] + fs.readFileSync(path.join(root, 'conversation-reader.css'), 'utf8');
  return `<!doctype html><html data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tokens}\n${css}</style><body><div id="view" style="overflow:auto;flex:1"></div><script>
  const $=id=>document.getElementById(id), noop=()=>{};
  let current=null, activeRel=null, viewKind='home', conversationLoadSeq=0, transcriptQuery='', matchIdx=-1, currentHash='', suppressHashEvents=0;
  let progressStream=null,lastNavProject=null,liveOpen=false;
  const lastNavConversation=new Map(), modelTouchAt=new Map(),traceLeaves=new Map(),fanoutFocus=new Map(),toolGroupOpen=new Map(),compareCache=new Map(),runLedgers=new Map(),activeRuns=new Map();
  const sessions=[], writes=[], errors=[], copied=[];
  const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const mdRender=s=>String(s||'').split('\\n\\n').map(s=>'<p>'+esc(s)+'</p>').join('');
  const termRegex=s=>new RegExp(s,'i');
  const relatedFor=async()=>[],convHead=()=>'',agentComposerHtml=()=>'<div class="agent-compose"><textarea id="agentText" aria-label="Message"></textarea><button id="agentRun">Send</button></div>';
  const mountDelegationView=noop,wireRunButtons=noop,hintReadKey=noop,wireHead=noop,wireAgentComposer=noop,wireTranscriptPathCandidates=noop,wireToolGroups=noop,updateMatchHud=noop,foldLongMessages=noop,renderRunCards=noop,render=noop,markSettingsClosed=noop,markAgentRead=noop;
  const projectOf=()=>null,delegationUI={attachCards:noop},isFileWriteTool=m=>m.name==='write',messageMediaHtml=()=>'',toolTextHtml=esc;
  const DelegationUI={eventSummary:(t,s)=>s,taskIdInResult:()=>null};
  const delegateCallOf=m=>({eid:m.eid,call:m.id,taskId:null,title:'Delegated work'});
  const errToast=m=>errors.push(m),toast=noop,openModelPicker=noop,renderLsBlocks=noop;
  const setLiveText=(el,text)=>el.textContent=text;
  const isEink=()=>false;
  const fanModels=()=>[{provider:'test',modelId:'Model A'}],attachedContext=()=>[],autoGrowCompose=noop,renderAgentThumbs=noop,updateComposeMin=noop,echoUserPrompt=noop,clearSendPending=noop,agentRunLabel=()=> 'Send',ledgerAbsorb=noop;
  const readAloudMessage=b=>copied.push(readerMessage(b)?.text), openTranscriptEditor=noop, regenerateMessage=noop,openSnippetForm=noop;
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copied.push(text)}});
  const long='An answer needs a comfortable reading width and complete text. '.repeat(500)+'END OF COMPLETE ANSWER';
  const messages=[
    {eid:'p',role:'user',text:'Which approach should we use?'},
    {eid:'a',role:'assistant',text:'ANSWER A\\n\\n'+long,model:'Model A',off:true},
    {eid:'qa',role:'user',text:'FOLLOWUP A: use the reading column.',off:true},
    {eid:'c',role:'assistant',text:'NESTED ANSWER C',off:true},
    {eid:'d',role:'assistant',text:'NESTED ANSWER D',off:true},
    {eid:'b',role:'assistant',text:'ANSWER B',model:'Model B'},
    {eid:'qb',role:'user',text:'FOLLOWUP B: use a dashboard.'},
    {eid:'bb',role:'assistant',text:'TAIL B'}];
  const original={key:'chat',source:'pi',mtimeMs:1,entryParents:[['p',null],['a','p'],['qa','a'],['c','qa'],['d','qa'],['b','p'],['qb','b'],['bb','qb']],messages,selectedModels:[{provider:'test',modelId:'Model A'}]};
  const answer=(id,model,text,key='chat')=>({id,key,model,text,entryIds:[id]});
  const groups=[{node:'p',answers:[answer('a','Model A',messages[1].text),answer('b','Model B','ANSWER B')]},{node:'qa',answers:[answer('c','Model A','NESTED ANSWER C'),answer('d','Model B','NESTED ANSWER D')]}];
  const store={chat:original}; let flow={groups,branches:[]};
  async function fetch(url,options){
    if(options?.method && options.method!=='GET') throw Error('unexpected fetch write');
    const u=new URL(url,location.origin),key=u.searchParams.get('id');
    const data=u.pathname==='/api/session'?store[key]:u.pathname==='/api/compare'?{...flow,key}:null;
    if(!data) throw Error('unexpected request '+url);
    return {ok:true,json:async()=>structuredClone(data)};
  }
  async function postJson(url,body){
    writes.push({url,body});
    if(url==='/api/branch'){
      const d=store[body.id];d.entryParents.push(['anchor'+writes.length,body.node]);d.mtimeMs++;
      return {ok:true};
    }
    if(url==='/api/node/aggregate')return {ok:true,answers:body.answers.length,job:{}};
    if(url==='/api/node/send')return {ok:true,job:{model:'test'}};
    throw Error('unexpected write '+url);
  }
  function setRouteKind(kind){rememberConversationPosition();stopReaderLanding();viewKind=kind;$('view').scrollTop=0;}
  ${code.replace(/<\/script/gi, '<\\/script')}
  function check(ok,message){if(!ok)throw Error(message);}
  const pause=()=>new Promise(r=>setTimeout(r,30));
  const text=()=>document.getElementById('conversationTranscript').textContent;
  window.runAudit=async()=>{
    await open('chat','top');
    check(text().includes('TAIL B')&&!text().includes('FOLLOWUP A'),'initial path is not B');
    check(document.querySelector('[data-reader-answer="p"]'),'missing visible answer selector');
    await browseConversationPath('chat','a','p');
    check(computeTrace(current).leaf==='qa','must stop at nested choice, not guess newest answer');
    check(computeSendTrace(current).leaf==='bb','browsing changed continuation');
    check(text().includes('FOLLOWUP A')&&!text().includes('FOLLOWUP B'),'selected answer and follow-up disagree');
    check(text().includes('END OF COMPLETE ANSWER'),'long answer was cut');
    const longElement=document.querySelector('[data-eid="a"]');
    $('view').scrollTop += longElement.getBoundingClientRect().top - $('view').getBoundingClientRect().top + 400;
    const beforeTop=longElement.getBoundingClientRect().top;
    await renderConv('preserve');
    check(Math.abs(document.querySelector('[data-eid="a"]').getBoundingClientRect().top-beforeTop)<2,'redraw lost the reading position');
    check(document.querySelector('[data-reader-answer="qa"]'),'nested choices disappeared');
    check(!readerSendAllowed(),'send allowed while browsing');
    const denied=writes.length;await headlessSendFromComposer($('agentRun'),'accidental prompt');check(writes.length===denied,'browsing sent to a hidden path');
    await browseConversationPath('chat','c','qa');
    check(text().includes('NESTED ANSWER C')&&!text().includes('NESTED ANSWER D'),'nested branch not readable');
    const count=writes.length;
    document.querySelector('[data-eid="c"] .md').click();await pause();
    check(writes.length===count&&computeSendTrace(current).leaf==='bb','text click moved continuation');
    await open('chat','entry:d');
    check(text().includes('NESTED ANSWER D'),'exact off-path link not readable');
    check(document.querySelector('[data-eid="d"]').classList.contains('hit-flash'),'exact entry not highlighted');
    readerGroup('chat','p').compare=true;await renderConv('preserve');
    check(document.querySelector('.flow-comparison'),'comparison not available');
    document.querySelector('.flow-comparison [data-eid="a"] .msg-copy').click();await pause();
    check(copied.at(-1).endsWith('END OF COMPLETE ANSWER'),'copy did not use complete answer');
    check(writes.length===count,'comparison caused a write');
    await openConversationMerge('chat','p');
    let dialog=document.querySelector('dialog');
    dialog.querySelector('input').click();dialog.querySelector('textarea').value='Resolve the disagreement';dialog.querySelector('textarea').dispatchEvent(new Event('input'));
    check(dialog.querySelector('[data-merge-start]').disabled,'merge allowed one source');
    dialog.querySelector('[data-merge-cancel]').click();
    await renderConv('preserve');await openConversationMerge('chat','p');dialog=document.querySelector('dialog');
    check(!dialog.querySelector('input').checked&&dialog.querySelector('textarea').value==='Resolve the disagreement','merge draft reset');
    dialog.querySelector('[data-merge-cancel]').click();
    await browseConversationPath('chat','b','p');
    check(text().includes('TAIL B'),'return to B lost its suffix');
    const before=writes.length;
    await browseConversationPath('chat','a','p');
    await continueReadingPath('chat','c',$('readerDestination').querySelector('button'));
    check(writes.length===before+1&&writes.at(-1).body.node==='c','explicit continuation wrote wrong target');
    check(computeSendTrace(current).onPath.has('c')&&text().includes('NESTED ANSWER C'),'continuation and reader disagree after accepting');
    check(readerSendAllowed(),'send blocked after explicit continuation');
    const oldSender=computeSendTrace(current).leaf;
    await browseConversationPath('chat','b','p');
    await new Promise(r=>setTimeout(r,50));history.back();
    for(let i=0;i<100;i++){await pause();if(!readerIsBrowsing(current))break;}
    check(computeSendTrace(current).leaf===oldSender&&!readerIsBrowsing(current),'browser back changed or failed to restore the path');
    return {passed:true,writes:writes.map(w=>w.url),longAnswerChars:messages[1].text.length};
  };
  window.runExtraAudit=async()=>{
    resetConversationReading('chat');await open('chat','top');
    const baseline=writes.length;
    const fork={key:'fork',source:'pi',entryParents:[['p',null],['foreign','p']],messages:[messages[0],{eid:'foreign',role:'assistant',text:'FOREIGN ANSWER: do not copy the other conversation.',model:'Model C'}]};
    store.fork=fork;
    flow={groups:[{...groups[0],answers:[...groups[0].answers,answer('foreign','Model C',fork.messages[1].text,'fork')]}],branches:[]};
    compareCache.delete('chat');readerGroup('chat','p').compare=true;readerGroup('chat','p').pair=['a','foreign'];await renderConv('preserve');
    const foreign=document.querySelector('.flow-comparison [data-msg-key="fork"][data-eid="foreign"]');
    check(foreign,'foreign answer package missing');foreign.querySelector('.msg-copy').click();await pause();
    check(copied.at(-1).startsWith('FOREIGN ANSWER'),'foreign copy used the current conversation index');
    check(writes.length===baseline,'reading foreign answer wrote a session');
    readerGroup('chat','p').compare=false;await renderConv('preserve');
    const stage=$('parallelStage');
    const entries=['A','B'].map((name,i)=>['job'+i,{key:'worker'+i,fanoutId:'fresh-run',fanoutRootKey:'chat',model:name,order:['text'],blocks:new Map([['text',{kind:'assistant',text:'LIVE ANSWER '+name}]]),done:false}]);
    renderReaderParallel(stage,entries);
    check(!stage.hidden&&stage.textContent.includes('LIVE ANSWER A'),'older comparison hid a new parallel run');
    check(stage.querySelectorAll('.flow-answer:not([hidden])').length===1,'live reader squeezed all answers into columns');
    entries[1][1].done=true;entries[1][1].status='error';entries[1][1].error='provider unavailable';renderReaderParallel(stage,entries);
    check(stage.textContent.includes('provider unavailable'),'failed worker lost its status');
    stage.querySelector('[data-live-select]').value='1';stage.querySelector('[data-live-select]').dispatchEvent(new Event('change'));
    // The real stage wrapper normally re-renders this; the fixture calls its renderer directly.
    renderReaderParallel(stage,entries);check(stage.querySelector('[data-live-job="job1"]').hidden===false,'live selection was lost');
    const all={eid:'all',role:'assistant',text:'=== Model A ===\\n'+messages[1].text+'\\n\\n=== Model B ===\\nANSWER B\\n\\n<!-- aiconvo:both -->',operation:{kind:'both',unresolved:true,sources:[{id:'a',key:'chat',model:'Model A',entryIds:['a']},{id:'b',key:'chat',model:'Model B',entryIds:['b']}]}};
    store.chat.entryParents.push(['all','p']);store.chat.messages.push(all);
    flow={groups:[{...groups[0],runId:'fresh-run',both:{id:'all',key:'chat'}}],branches:[]};compareCache.delete('chat');await open('chat','preserve');
    check(computeTrace(current).leaf==='b','settlement failed to retain the answer being read');
    check(readerPendingChoice(current)==='all','parallel context silently accepted all answers');
    renderReaderParallel($('parallelStage'),entries);check($('parallelStage').hidden,'settlement left duplicate live answers');
    store.chat.entryParents.push(['later','p']);store.chat.messages.push({eid:'later',role:'assistant',text:'NOT IN THE EARLIER SNAPSHOT'});
    flow.groups[0].answers.push(answer('later','Model C','NOT IN THE EARLIER SNAPSHOT'));
    compareCache.delete('chat');await open('chat','top');await browseConversationPath('chat','all','p',{exact:true});
    const included=document.querySelector('.flow-included');check(included&&included.textContent.includes('END OF COMPLETE ANSWER')&&!included.textContent.includes('NOT IN THE EARLIER SNAPSHOT'),'include-all changed when a later answer arrived');
    const sources=[{id:'a',key:'chat',model:'Model A'},{id:'b',key:'chat',model:'Model B'}];
    store.chat.entryParents.push(['merge','p'],['merged','merge']);store.chat.messages.push({eid:'merge',role:'user',text:'hidden merge request',operation:{kind:'merge',sources}},{eid:'merged',role:'assistant',text:'THE MERGED ANSWER'});
    flow.groups[0].merges=[{bridgeId:'merge',answer:answer('merged','Merge model','THE MERGED ANSWER'),sources}];
    compareCache.delete('chat');resetConversationReading('chat');await open('chat','top');
    check(text().includes('Merged from Model A + Model B')&&text().includes('THE MERGED ANSWER'),'merge lost visible provenance');
    check(!text().includes('hidden merge request'),'transport leaked into reading');
    check(writes.length===baseline,'live/read transitions wrote sessions');
    return {passed:true};
  };
  window.runLiveReplyAudit=async()=>{
    resetConversationReading('chat');await open('chat','top');
    const L={key:'chat',startedAt:1000,order:['a','tool','b'],blocks:new Map([
      ['a',{kind:'text',text:'First reply',done:true}],
      ['tool',{kind:'tool',name:'bash',phase:'running'}],
      ['b',{kind:'text',text:'Second reply',done:false}]
    ])};
    runLedgers.set('stream',L);renderLiveReplies();
    const host=$('liveReplies'),first=host.querySelector('[data-live-reply="stream:a"]');
    const second=host.querySelector('[data-live-reply="stream:b"]');
    check(host.textContent.indexOf('First reply')<host.textContent.indexOf('bash')&&host.textContent.indexOf('bash')<host.textContent.indexOf('Second reply'),'live reply/tool order wrong');
    L.blocks.get('b').text='Second reply updated';second._paintAt=0;renderLiveReplies();
    check(second===host.querySelector('[data-live-reply="stream:b"]')&&second.textContent.includes('updated'),'stream replaced its message node');
    const range=document.createRange();range.selectNodeContents(second.querySelector('.md'));getSelection().removeAllRanges();getSelection().addRange(range);
    L.blocks.get('b').text='Final second reply';L.blocks.get('b').done=true;renderLiveReplies();
    check(second.textContent.includes('updated'),'stream destroyed selected text');getSelection().removeAllRanges();renderLiveReplies();
    check(second.textContent.includes('Final second reply'),'paused text did not catch up');
    L.done=true;renderLiveReplies();check(host.contains(first),'finished reply vanished before save');
    const oldKey=activeRel;activeRel='other-conversation';
    runLedgers.set('foreign-stream',{key:activeRel,startedAt:1000,order:['x'],blocks:new Map([['x',{kind:'text',text:'FOREIGN LIVE REPLY'}]])});
    renderLiveReplies();
    check(!host.textContent.includes('FOREIGN LIVE REPLY')&&host.dataset.conversationKey===oldKey,'navigation race mixed conversation ledgers');
    activeRel=oldKey;runLedgers.delete('foreign-stream');
    store.chat.messages.push({eid:'stream-a',role:'assistant',text:'First reply',ts:new Date(1100).toISOString()},{eid:'stream-a',role:'tool',id:'call-a',name:'bash',text:'printf done',ts:new Date(1100).toISOString()},{eid:'stream-b',role:'assistant',text:'Final second reply',ts:new Date(1200).toISOString()});
    store.chat.entryParents.push(['stream-a','merged'],['stream-b','stream-a']);
    compareCache.delete('chat');resetConversationReading('chat');await open('chat','preserve');renderLiveReplies();
    check($('conversationTranscript').querySelector('.msg.assistant[data-eid="stream-a"]')===first,'save replaced the live message node');
    check(!first.closest('.toolgroup'),'saved commentary disappeared into the tools');
    check(!$('liveReplies').textContent.includes('First reply'),'save duplicated reply');
    runLedgers.clear();return {passed:true};
  };
  window.runScrollAudit=async()=>{
    const priorFlow=flow, priorKey=current.key;
    flow={groups:[],branches:[]};
    for(const key of ['scroll-a','scroll-b']) store[key]={key,source:'pi',mtimeMs:1,entryParents:[['q',null],['a','q']],messages:[{eid:'q',role:'user',text:'Question'},{eid:'a',role:'assistant',text:long}]};
    const gap=()=>$('view').scrollHeight-$('view').clientHeight-$('view').scrollTop;
    await open('scroll-a');$('view').scrollTop=400;await new Promise(r=>setTimeout(r,220));
    await open('scroll-b');await open('scroll-a');
    check(gap()<3,'ordinary conversation switch restored an old middle position instead of bottom');
    $('view').scrollTop=320;await open('scroll-b');await pause();history.back();
    for(let i=0;i<100;i++){await pause();if(current?.key==='scroll-a'&&$('liveReplies')?.dataset.conversationKey==='scroll-a')break;}
    check(current.key==='scroll-a'&&Math.abs($('view').scrollTop-320)<3,'browser Back lost its saved reading position');
    await open('scroll-a','entry:q');check($('view').scrollTop<300,'explicit entry landing was overridden');
    $('view').scrollTop=500;setRouteKind('file');await open('scroll-a');
    check(Math.abs($('view').scrollTop-500)<3,'returning from file lost the reading position');
    readerState('scroll-a').leaf='q';rememberConversationPosition();
    check(!readerState('scroll-a').positions.q,'departure saved the old screen under the newly selected path');
    readerState('scroll-a').leaf=null;
    readerState('scroll-a').positions.live={id:'deleted-entry',flow:false,offset:0};
    await open('scroll-a','restore');check(gap()<3,'missing saved anchor left conversation at the top');
    await open('scroll-a','bottom');
    const space=document.createElement('div');space.style.height='2000px';$('conversationTranscript').prepend(space);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    check(gap()<3,'late layout growth lost bottom landing');
    $('view').dispatchEvent(new WheelEvent('wheel'));$('view').scrollTop=200;
    const more=document.createElement('div');more.style.height='500px';$('conversationTranscript').append(more);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    check(Math.abs($('view').scrollTop-200)<3,'late layout pulled a reader back after scrolling away');
    flow=priorFlow;await open(priorKey,'top');return {passed:true};
  };
  const renderParallelStage=noop;
  window.prepareScreenshot=async()=>{readerGroup('chat','p').compare=false;await renderConv('top');$('view').scrollTop=0;};
  </script></body></html>`;
}

test('real browser: path fidelity, nested branches, full answers, safe actions, merge drafts, and history', { timeout: 45000 }, async t => {
  const probe = spawnSync('chromium', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return t.skip('chromium is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-reader-'));
  let server, browser, ws;
  t.after(async () => {
    ws?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill('SIGTERM');
      const timeout = setTimeout(() => browser.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const html = fixture();
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-first-run', '--user-data-dir=' + dir, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(Error(stderr)), 10000);
    browser.stderr.on('data', b => { stderr += b; const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}, sessionId) => new Promise(resolve => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
  const sid = attached.result.sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sid);
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!response.result?.exceptionDetails, JSON.stringify(response.result));
    return response.result?.result?.value;
  };
  for (let i = 0; i < 100 && !await evaluate('typeof runAudit === "function"'); i++) await new Promise(r => setTimeout(r,30));
  const result = await evaluate('runAudit()');
  assert.equal(result.passed, true);
  assert.equal((await evaluate('runExtraAudit()')).passed, true);
  assert.equal((await evaluate('runLiveReplyAudit()')).passed, true);
  assert.equal((await evaluate('runScrollAudit()')).passed, true);
  await evaluate('prepareScreenshot()');
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, name + ' overflows horizontally');
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.writeFileSync(path.join(os.tmpdir(), 'conversation-reader-' + name + '.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await send('Browser.close');
  await new Promise(resolve => browser.exitCode != null ? resolve() : browser.once('exit', resolve));
});
