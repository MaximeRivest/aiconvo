'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const html = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
function extract(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}

test('real browser routes reveal raw off-branch entries, grouped tools, and history without session writes', { timeout: 30000 }, async t => {
  const probe = spawnSync('chromium', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return t.skip('chromium is not installed');
  assert.equal(probe.status, 0, probe.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-navigation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = [
    extract('function setRoute(kind, hash, crumbs)', '\nfunction goHome()'),
    extract('function dispatchHash(h) {', '// ---- route segments ----'),
    extract('async function open(rel, scroll) {', '// ---- distillation ----'),
    extract('async function renderConv(scroll) {', '// ---- trace machinery ----'),
    extract('function computeTrace(d) {', '\nfunction deepestUnder('),
    extract('function isMergeBridgeText(text) {', '\nconst compareCache ='),
    extract('function msgBlock(m, hl, keepOpen', '// Every bash fence'),
  ].join('\n');
  const fixture = `<!doctype html><meta charset="utf-8"><div id="view"></div><pre id="result">PENDING</pre><script>
  const $ = id => document.getElementById(id);
  let current = null, activeRel = null, viewKind = 'home', conversationLoadSeq = 0;
  let progressStream = null, currentHash = '', suppressHashEvents = 0, lastNavProject = null, matchIdx = -1;
  const lastNavConversation = new Map(), modelTouchAt = new Map(), traceLeaves = new Map(), fanoutFocus = new Map(), toolGroupOpen = new Map();
  const sessions = [], searchMode = false, calls = [], errors = [];
  const parent = {key:'parent', source:'pi', entryParents:[['root',null],['launch','root'],['result','launch'],['abort','result'],['other','root']], messages:[
    {eid:'root',role:'user',text:'start'},
    {eid:'launch',role:'thinking',text:'launch reasoning',off:true},
    {eid:'launch',role:'tool',id:'call',name:'delegate',text:'launch child',off:true},
    {eid:'result',role:'toolresult',tid:'call',text:'child created',off:true},
    {eid:'abort',role:'abort',text:'stopped',off:true},
    {eid:'other',role:'tool',id:'new-call',name:'read',text:'new path'},
    {eid:'new-result',role:'toolresult',tid:'new-call',text:'new result'},
    {eid:'last',role:'assistant',text:'latest'}]};
  const saved = JSON.stringify(parent);
  async function fetch(url, opts) {
    calls.push([url, opts]);
    if (opts?.method && opts.method !== 'GET') throw Error('Mutation: '+url);
    if (!url.startsWith('/api/session?id=')) throw Error('Unexpected API: '+url);
    const key = decodeURIComponent(url.split('=')[1]);
    return {json:async()=> key === 'parent' ? JSON.parse(saved) : {key,source:'pi',messages:[{eid:'child',role:'user',text:key}]}};
  }
  function setRouteKind(kind) { viewKind = kind; }
  const noop = () => {};
  const fileInk = null;
  const markSettingsClosed=noop, markAgentRead=noop, render=noop, projectOf=()=>null, convCrumbs=()=>[];
  const relatedFor=async()=>[], convHead=()=>'', agentComposerHtml=()=>'';
  const loadCompare=async()=>[];
  // A compare row would normally suppress its answer. The raw link must still show it.
  const compareAnchors=()=>({rows:new Map(),skip:new Set(['launch'])});
  const mountDelegationView=noop, wireCompareRow=noop, renderRunCards=noop, foldLongMessages=noop;
  const delegationUI = { attachCards: noop, index: () => ({ tasks: [] }) };
  const DelegationUI = { taskIdInResult: () => null, eventSummary: type => '↩ ' + type };
  const delegateCallOf = m => ({ eid: m.eid || '', call: m.id || '', title: '', taskId: null });
  const wireRunButtons=noop, hintReadKey=noop, wireHead=noop, wireAgentComposer=noop, wireTranscriptPathCandidates=noop, wireToolGroups=noop, updateMatchHud=noop;
  const errToast=m=>errors.push(m), isFileWriteTool=()=>false;
  const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const mdRender=esc, toolTextHtml=esc, messageMediaHtml=()=>'';
  ${code}
  function check(ok, why) { if (!ok) throw Error(why); }
  function landed(index) {
    const node = document.querySelector('#conversationTranscript [data-i="'+index+'"]');
    check(node?.classList.contains('hit-flash'), 'missing landing '+index);
    for(let n=node;n;n=n.parentElement) if(n.tagName==='DETAILS') check(n.open,'closed ancestor');
    return node;
  }
  async function run() {
    check(!computeTrace(parent).onPath.has('launch'), 'fixture must use abandoned branch');
    await open('different-child');
    await dispatchHash('read='+JSON.stringify({key:'parent',entryId:'launch'}));
    landed(1);
    check(document.querySelector('[data-i="2"]')?.textContent.includes('launch child'), 'shared raw-entry tool was hidden');
    check(document.querySelector('.branchblock').open, 'off-branch block stays closed');
    await open('parent','entry:launch'); landed(1);
    await open('parent','entry:result');
    check(landed(3).textContent.includes('child created'), 'merged result not revealed');
    await open('parent','entry:abort'); landed(4);
    await open('parent','entry:other'); landed(5);
    check(document.querySelector('.toolgroup').open, 'tool package stays closed');
    await open('parent','entry:new-result'); landed(6);
    // Browser history drives the real hashchange dispatcher. Wait for rendering.
    await new Promise(resolve=>setTimeout(resolve,50));
    history.back();
    for(let i=0;i<100;i++) {
      if(location.hash.includes('other') && document.querySelector('[data-i="5"].hit-flash')) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    landed(5);
    check(location.hash.includes('other'), 'history did not restore entry route');
    check(traceLeaves.size===0, 'read changed trace selection');
    check(JSON.stringify(parent)===saved, 'read changed fixture continuation');
    check(errors.length===0, errors.join('; '));
    check(calls.length>=8 && calls.every(([url,opts])=>url.startsWith('/api/session?id=')&&!opts), 'read made a write or branch call');
    $('result').textContent='PASS: cross-child, same-parent, abandoned branch, merged result, abort, tool package, browser back, GET-only';
  }
  setTimeout(() => run().catch(e=>{$('result').textContent='FAIL: '+e.stack+'; hash='+location.hash+'; calls='+calls.length;}), 100);
  </script>`;
  const file = path.join(dir, 'fixture.html'); fs.writeFileSync(file, fixture);
  const browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'profile'),
    '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => browser.kill());
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(Error('Browser startup timeout: ' + stderr)), 10000);
    browser.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.on('error', reject);
  });
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  t.after(() => ws.close());
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(resolve => {
    pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  const tree = await send('Page.getFrameTree', {}, sessionId);
  await send('Page.setDocumentContent', { frameId: tree.result.frameTree.frame.id, html: fixture }, sessionId);
  let result = '';
  for (let i = 0; i < 150; i++) {
    const reply = await send('Runtime.evaluate', { expression: 'document.getElementById("result")?.textContent', returnByValue: true }, sessionId);
    result = reply.result?.result?.value || '';
    if (/^(PASS|FAIL):/.test(result)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const page = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
  if (!result) result = JSON.stringify(page);
  await send('Browser.close');
  await new Promise(resolve => browser.exitCode != null ? resolve() : browser.once('exit', resolve));
  assert.match(result, /^PASS:/, result);

});
