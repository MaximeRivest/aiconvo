'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

test('complete app and server: assets, path switching, merge dialog, and mobile reading', { timeout: 60000 }, async t => {
  if (spawnSync('chromium', ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-app-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(async () => {
    ws?.close();
    await stop(browser); await stop(server);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const agent = path.join(home, '.pi/agent'), sessionDir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const raw = [
    { type: 'session', version: 3, id: 'fixture', cwd: path.join(home, 'work') },
    msg('p', null, 'user', 'How can we make a branched conversation easier to follow?'),
    msg('a', 'p', 'assistant', '# One readable conversation\n\nKeep a complete answer at normal reading width.\n\n' + 'Alternatives should stay accessible without interrupting the chosen conversation. '.repeat(200) + '\n\nEND OF ANSWER A'),
    msg('qa', 'a', 'user', 'Use the readable path.'), msg('aa', 'qa', 'assistant', 'FOLLOWUP A: a coherent reading path.'),
    msg('b', 'p', 'assistant', '# Compare deliberately\n\nKeep comparison available as a separate reading choice.'),
    msg('qb', 'b', 'user', 'How would comparison work on my phone?'), msg('bb', 'qb', 'assistant', 'FOLLOWUP B: one full-width answer at a time, with clear controls.'),
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(path.join(sessionDir, 'chat.jsonl'), raw);
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let serverLog = '';
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), AICONVO_HOST: '127.0.0.1', AICONVO_NO_WATCH: '1', AICONVO_NO_LEDGER: '1', AICONVO_CACHE_DIR: path.join(home, 'cache'), AICONVO_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port, key = 'pi:fixture/chat.jsonl';
  let indexed = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (rows.some(s => s.key === key)) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  for (const asset of ['conversation-flow.js', 'conversation-reader.js', 'conversation-reader.css']) assert.equal((await fetch(base + '/' + asset)).status, 200, asset);
  browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.navigate', { url: base + '/#' + encodeURIComponent(key) }, sid);
  for (let i = 0; i < 200; i++) {
    if (await evaluate('!!document.querySelector("[data-reader-answer]")')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(await evaluate('document.querySelector("#conversationTranscript")?.textContent.includes("FOLLOWUP B")'), true, exceptions.join('\n'));
  await evaluate(`document.querySelector('#agentText').value='Unsent draft'; browseConversationPath(${JSON.stringify(key)},'a','p')`);
  assert.equal(await evaluate(`document.querySelector('#agentText').value`), 'Unsent draft', 'path reading lost the draft');
  assert.deepEqual(await evaluate(`({reading:computeTrace(current).leaf,sending:computeSendTrace(current).leaf,full:document.querySelector('#conversationTranscript').textContent.includes('END OF ANSWER A'),matching:document.querySelector('#conversationTranscript').textContent.includes('FOLLOWUP A')})`), { reading: 'aa', sending: 'bb', full: true, matching: true });
  assert.equal(await evaluate(`!!document.querySelector('#composerDock #readerDestination')`), true, 'continuation notice must stay with the composer');
  await evaluate(`openConversationMerge(${JSON.stringify(key)},'p')`);
  assert.equal(await evaluate(`!!document.querySelector('dialog[open] [data-merge-start]')`), true);
  await evaluate(`document.querySelector('[data-merge-model]').click()`);
  assert.equal(await evaluate(`!!document.querySelector('dialog[open] .mpick')`), true, 'model picker escaped the dialog top layer');
  await evaluate(`document.querySelector('[data-merge-cancel]').click(); readerGroup(current.key,'p').compare=true; renderConv('top')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-compare-side]')].filter(e=>getComputedStyle(e).display!=='none').length`), 1, 'phone comparison must show one full-width answer');
  await evaluate(`document.querySelector('[data-reader-side][data-side="1"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-compare-side="1"]')).display!=='none'`), true);
  await evaluate(`resetConversationReading(current.key); readerGroup(current.key,'p').compare=false; renderConv('top')`);
  await evaluate(`
    window.testLiveRun={jobId:'stream-fixture',key:current.key,startedAt:Date.now(),status:'running',statusText:'working',tail:[
      {id:1,kind:'text',text:'Checking the details.',done:true},
      {id:2,kind:'tool',name:'bash',phase:'done',args:'printf done',out:'done'},
      {id:3,kind:'text',text:'# Result\\n\\n| Item | State |\\n| --- | --- |\\n| Tests | Passed |\\n\\n'+ 'Readable streaming text. '.repeat(300)}
    ]};
    activeRuns.set(testLiveRun.jobId,testLiveRun);ledgerAbsorb(testLiveRun);renderRunCards();
  `);
  assert.equal(await evaluate(`!!document.querySelector('#liveReplies .md table')`), true, 'streaming Markdown table was not rendered');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'streamed answer overflows phone');
  await evaluate(`liveOpen=true;renderRunCards()`);
  assert.equal(await evaluate(`!!document.querySelector('#lsBlocks .md table')`), true, 'open tool stream lost rendered Markdown');
  assert.equal(await evaluate(`document.querySelector('#liveReplies [data-reply-run]').hidden`), true, 'live reply appeared in both surfaces');
  assert.equal(await evaluate(`(()=>{const host=document.querySelector('#lsBlocks'),text=host.textContent;return text.indexOf('Checking the details.')<text.indexOf('bash')&&text.indexOf('bash')<text.indexOf('Readable streaming text')})()`), true, 'open stream changed message/tool order');
  await evaluate(`liveOpen=false;renderRunCards()`);
  assert.equal(await evaluate(`!document.querySelector('#liveReplies [data-reply-run]').hidden&&!!document.querySelector('#liveReplies .md table')`), true, 'closing stream did not restore transcript replies');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`document.querySelector('#view').scrollTop=40;window.liveScrollTop=document.querySelector('#view').scrollTop;testLiveRun.tail[2].text+=' More content.'.repeat(200);testLiveRun.tail[2].done=true;ledgerAbsorb(testLiveRun);renderRunCards()`);
  assert.equal(await evaluate(`document.querySelector('#view').scrollTop===liveScrollTop`), true, 'stream pulled reader to bottom');
  assert.equal(await evaluate(`document.querySelector('#agentText').value`), 'Unsent draft', 'stream lost composer draft');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'conversation-app-phone.png'), Buffer.from(screenshot.result.data, 'base64'));
  assert.deepEqual(exceptions, []);
  assert.equal(fs.readFileSync(path.join(sessionDir, 'chat.jsonl'), 'utf8'), raw, 'read/compare/merge draft changed the session');
  await send('Browser.close'); await new Promise(r => browser.exitCode != null ? r() : browser.once('exit', r));
});
