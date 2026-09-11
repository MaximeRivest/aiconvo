'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

test('complete app and server: conversation reading, Files browsing, MRMD, diffs, and mobile layout', { timeout: 60000 }, async t => {
  if (spawnSync('chromium', ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.conversation-app-test-'));
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
  const work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'docs'));
  fs.writeFileSync(path.join(work, 'README.md'), '# Browser fixture\n\nReadable documentation.\n');
  fs.writeFileSync(path.join(work, 'docs', 'example.js'), 'const before = 1;\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial files']]) {
    const result = spawnSync('git', args, { cwd: work }); assert.equal(result.status, 0, String(result.stderr));
  }
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const raw = [
    { type: 'session', version: 3, id: 'fixture', cwd: path.join(home, 'work') },
    msg('p', null, 'user', 'How can we make a branched conversation easier to follow?'),
    msg('a', 'p', 'assistant', '# One readable conversation\n\nKeep a complete answer at normal reading width.\n\n' + 'Alternatives should stay accessible without interrupting the chosen conversation. '.repeat(200) + '\n\nEND OF ANSWER A'),
    msg('qa', 'a', 'user', 'Use the readable path.'),
    { type: 'message', id: 'review-tool', parentId: 'qa', timestamp: '2026-09-01T12:00:01Z', message: { role: 'assistant', model: 'fixture', content: [{ type: 'toolCall', id: 'fixture-review-call', name: 'edit', arguments: { path: path.join(work, 'docs/example.js'), edits: [{ oldText: 'const before = 1;', newText: 'const after = 2;' }] } }] } },
    { type: 'message', id: 'review-result', parentId: 'review-tool', timestamp: '2026-09-01T12:00:02Z', message: { role: 'toolResult', toolCallId: 'fixture-review-call', toolName: 'edit', content: [{ type: 'text', text: 'Updated' }], isError: false } },
    msg('aa', 'review-result', 'assistant', 'FOLLOWUP A: a coherent reading path.'),
    msg('b', 'p', 'assistant', '# Compare deliberately\n\nKeep comparison available as a separate reading choice.'),
    msg('qb', 'b', 'user', 'How would comparison work on my phone?'), msg('bb', 'qb', 'assistant', 'FOLLOWUP B: one full-width answer at a time, with clear controls.'),
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(path.join(sessionDir, 'chat.jsonl'), raw);
  fs.mkdirSync(path.join(work, 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(work, 'scratch', 'plot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0V8AAAAASUVORK5CYII=', 'base64'));
  const artifactCommand = `ssh max@fixture 'cd /tmp/job; python - <<"PY"\nfig.savefig("plot.png")\nPY'\nrsync max@fixture:/tmp/job/plot.png scratch/plot.png`;
  const auxiliary = (name, call) => fs.writeFileSync(path.join(sessionDir, name + '.jsonl'), [
    { type: 'session', version: 3, id: name, cwd: work }, msg('p', null, 'user', name),
    { type: 'message', id: 'a', parentId: 'p', timestamp: '2026-09-01T12:00:00Z', message: { role: 'assistant', model: 'fixture', content: [call] } },
    { type: 'message', id: 'r', parentId: 'a', timestamp: '2026-09-01T12:00:01Z', message: { role: 'toolResult', toolName: call.name, toolCallId: call.id, content: [{ type: 'text', text: 'done' }], isError: false } },
  ].map(JSON.stringify).join('\n') + '\n');
  auxiliary('artifacts', { type: 'toolCall', id: 'artifact-call', name: 'bash', arguments: { command: artifactCommand } });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let serverLog = '';
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), AICONVO_TLS_PORT: '0', AICONVO_HOST: '127.0.0.1', AICONVO_NO_WATCH: '0', AICONVO_NO_LEDGER: '0', AICONVO_CACHE_DIR: path.join(home, 'cache'), AICONVO_CHECKPOINT_DIR: path.join(home, 'checkpoints'), AICONVO_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // The same Files browser is reachable from a conversation and project summary.
  assert.equal((await fetch(base + '/api/files/browse?name=work&dir=..')).status, 400);
  assert.equal((await fetch(base + '/api/files/browse?name=work&root=' + encodeURIComponent(home))).status, 400);
  assert.equal(await evaluate(`!!document.querySelector('#lensBtn')`), false);
  await evaluate(`fbConversationFiles()`);
  assert.equal(await evaluate(`viewKind`), 'files-browser');
  assert.equal(await evaluate(`document.querySelector('#fbList').textContent.includes('docs')`), true);
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.querySelector('#fbReadme').textContent.includes('Browser fixture')`)) break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(await evaluate(`document.querySelector('#fbReadme').textContent.includes('Browser fixture')`), true);
  // Compact finder: scoped shortcut, live dropdown, keyboard navigation and no list replacement.
  const keypress = key => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
  const find = async text => {
    await evaluate(`document.querySelector('#fbSearch').value=${JSON.stringify(text)};document.querySelector('#fbSearch').dispatchEvent(new Event('input',{bubbles:true}))`);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`filesBrowser.finder.items.length>0`)) return;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.fail(await evaluate(`document.querySelector('#fbFinderStatus').textContent`));
  };
  await evaluate(`window.finderListBefore=document.querySelector('#fbList');document.activeElement.blur()`);
  await keypress('t');
  assert.equal(await evaluate(`document.activeElement.id`), 'fbSearch');
  assert.equal(await evaluate(`document.querySelector('#fbSearch').getBoundingClientRect().width < 300`), true);
  assert.equal(await evaluate(`helpNow().some(s=>s.label==='go to file')`), true);
  await find('docs');
  assert.equal(await evaluate(`filesBrowser.finder.items.length`), 2);
  await keypress('ArrowDown');
  assert.equal(await evaluate(`document.querySelector('#fbSearch').getAttribute('aria-activedescendant')`), 'fbFindOption1');
  await keypress('ArrowUp');
  assert.equal(await evaluate(`document.querySelector('#fbSearch').getAttribute('aria-activedescendant')`), 'fbFindOption0');
  assert.equal(await evaluate(`finderListBefore===document.querySelector('#fbList')`), true, 'search replaced the folder list');
  const finderScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-finder-desktop.png'), Buffer.from(finderScreenshot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('#fbFinderPopup').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`), true, 'finder dropdown overflows phone');
  const finderPhone = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-finder-phone.png'), Buffer.from(finderPhone.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await keypress('Escape');
  assert.equal(await evaluate(`document.querySelector('#fbFinderPopup').hidden && document.activeElement.id!=='fbSearch'`), true);
  assert.equal(await evaluate(`filesBrowser.dir`), '');
  await keypress('t'); await find('docs');
  await evaluate(`document.querySelector('#fbSearchForm').requestSubmit()`);
  for (let i = 0; i < 100 && await evaluate(`filesBrowser.tree.dir !== 'docs'`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`filesBrowser.tree.dir`), 'docs', 'Enter did not open the folder');
  await keypress('t'); await find('README');
  assert.equal(await evaluate(`filesBrowser.finder.items[0].rel`), 'README.md', 'finder must search from repository root even in a subfolder');
  await keypress('Escape');
  await evaluate(`showFilesBrowser(projectOf(current),{conv:current.key})`);
  await keypress('t');
  await evaluate(`document.querySelector('#fbFindMode').value='contents';document.querySelector('#fbFindMode').dispatchEvent(new Event('change'));document.querySelector('#fbSearch').value='const before';document.querySelector('#fbSearch').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`filesBrowser.finder.items.length`), 0);
  assert.match(await evaluate(`document.querySelector('#fbFinderStatus').textContent`), /Press Enter/);
  await evaluate(`document.querySelector('#fbSearchForm').requestSubmit()`);
  for (let i = 0; i < 100 && !await evaluate(`filesBrowser.finder.items.length`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`filesBrowser.finder.items[0]?.line`), 1);
  assert.match(await evaluate(`document.querySelector('#fbFinderList').textContent`), /const before/);
  await keypress('Escape');
  // A response arriving after a newer query must not replace that query's results.
  await evaluate(`window.finderFetch=window.fetch;window.finderRequests=[];window.fetch=(url,opts)=>String(url).includes('/api/files/browse?')?new Promise(resolve=>finderRequests.push({url,resolve})):finderFetch(url,opts);document.querySelector('#fbFindMode').value='files';document.querySelector('#fbSearch').focus();document.querySelector('#fbSearch').value='old';fbFinderQueue(filesBrowser,true)`);
  for (let i = 0; i < 100 && await evaluate(`finderRequests.length<1`); i++) await new Promise(r => setTimeout(r, 10));
  await evaluate(`document.querySelector('#fbSearch').value='new';fbFinderQueue(filesBrowser,true)`);
  for (let i = 0; i < 100 && await evaluate(`finderRequests.length<2`); i++) await new Promise(r => setTimeout(r, 10));
  await evaluate(`finderRequests[1].resolve({ok:true,json:async()=>({entries:[{name:'new.js',rel:'new.js',path:'/new.js'}]})})`);
  await evaluate(`finderRequests[0].resolve({ok:true,json:async()=>({entries:[{name:'old.js',rel:'old.js',path:'/old.js'}]})})`);
  assert.equal(await evaluate(`filesBrowser.finder.items[0]?.name`), 'new.js');
  await keypress('Escape');
  await evaluate(`window.fetch=window.finderFetch;document.querySelector('#fbSearch').value=''`);
  const browseScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-browser-desktop.png'), Buffer.from(browseScreenshot.result.data, 'base64'));
  await keypress('t'); await find('README');
  await evaluate(`document.querySelector('[data-fb-result="0"]').click()`);
  for (let i = 0; i < 150 && !await evaluate(`!!docState?.editor`); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await evaluate(`docState?.path`), path.join(work, 'README.md'));
  assert.equal(await evaluate(`!!document.querySelector('#docRun') && !!docState.editor`), true, 'MRMD editor did not mount');
  await evaluate(`showFilesBrowser(projectOf(current),{conv:current.key})`);
  await evaluate(`filesBrowser.query='const before';filesBrowser.contents=true;fbLoad(filesBrowser)`);
  assert.equal(await evaluate(`document.querySelector('#fbList').textContent.includes('1: const before')`), true);
  await evaluate(`fbOpenFile(filesBrowser, ${JSON.stringify(path.join(work, 'docs', 'example.js'))}, 1)`);
  assert.equal(await evaluate(`fileWs.path`), path.join(work, 'docs', 'example.js'));
  assert.equal(await evaluate(`!!document.querySelector('[data-fb-conv]')`), true);
  await evaluate(`open(${JSON.stringify(key)},'restore')`);
  assert.equal(await evaluate(`document.querySelector('#agentText').value`), 'Unsent draft', 'Files toggle lost conversation draft');
  await evaluate(`fbConversationFiles()`);
  assert.equal(await evaluate(`viewKind`), 'file', 'Files toggle did not restore the open file');
  const save = await fetch(base + '/api/file/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.join(work, 'docs', 'example.js'), text: 'const after = 2;\n' }) });
  assert.equal(save.status, 200, await save.text());
  await evaluate(`showFilesBrowser(projectOf(current),{conv:current.key,mode:'changes',range:'day',actor:'human'})`);
  assert.equal(await evaluate(`document.querySelectorAll('.fb-change').length`), 1);
  await evaluate(`document.querySelector('.fb-change').open=true`);
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!!document.querySelector('.fb-diff-row')`)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(await evaluate(`!!document.querySelector('.fb-diff-row')`), true, JSON.stringify(await evaluate(`(async()=>({text:document.querySelector('.fb-diff-host').textContent,events:filesBrowser.events,points:await fbJSON('/api/file-history/points?'+new URLSearchParams({scope:'project',name:filesBrowser.project,repo:filesBrowser.root,path:'docs/example.js'}))}))()`)));
  await evaluate(`document.querySelector('[data-review]').click();document.querySelector('[data-flag]').click()`);
  assert.equal(await evaluate(`document.querySelector('.fb-review-status').textContent`), 'Reviewed · Flagged');
  await evaluate(`showFilesBrowser(projectOf(current),{mode:'changes',range:'day',actor:'human'})`);
  assert.equal(await evaluate(`document.querySelector('.fb-review-status').textContent`), 'Reviewed · Flagged');
  // Exact saved versions, the linear history drawer, and external deletions.
  const pointURL = base + '/api/file-history/points?' + new URLSearchParams({ name: 'work', repo: work, path: 'docs/example.js' });
  const points = await (await fetch(pointURL)).json();
  const saved = points.points.filter(p => p.kind === 'saved');
  assert.ok(saved.length >= 2);
  const savedAfter = saved.at(-1).id;
  const snapshotURL = base + '/api/file-history/snapshot?' + new URLSearchParams({ name: 'work', repo: work, path: 'docs/example.js', point: savedAfter });
  assert.equal((await (await fetch(snapshotURL)).json()).content, 'const after = 2;\n');
  await evaluate(`fbOpenFile(filesBrowser, ${JSON.stringify(path.join(work, 'docs', 'example.js'))})`);
  await evaluate(`fileWsEnterHistory()`);
  assert.equal(await evaluate(`!!document.querySelector('#fwHistoryDrawer') && !document.querySelector('#codeEditor')`), true);
  assert.equal(await evaluate(`focusedFileCompare.to`), savedAfter, 'History should read the newest saved observation by default');
  assert.equal(await evaluate(`focusedFileCompare.from === focusedFileCompare.to`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#ffTimeline')).display`), 'none');
  await evaluate(`fileWsHistoryDrawer(fileWs, {from:${JSON.stringify(saved[0].id)},to:${JSON.stringify(savedAfter)}})`);
  assert.equal(await evaluate(`document.querySelector('#fhCompare').checked`), true);
  const historyScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'files-history-desktop.png'), Buffer.from(historyScreenshot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'History drawer overflows phone');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#fwHistoryDrawer')).display`), 'flex');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`fileWsEnterWrite()`);
  assert.equal(await evaluate(`!!document.querySelector('#codeEditor')`), true);
  const waitSaved = async predicate => {
    let latest;
    for (let i = 0; i < 100; i++) {
      const doc = await (await fetch(pointURL)).json();
      latest = doc.points?.filter(p => p.kind === 'saved').at(-1);
      if (latest && await predicate(latest)) return latest;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.fail('Watcher did not capture the expected version: ' + JSON.stringify(latest));
  };
  fs.writeFileSync(path.join(work, 'docs', 'example.js'), 'external write\n');
  await waitSaved(async p => p.id !== savedAfter && (await (await fetch(snapshotURL.replace(encodeURIComponent(savedAfter), encodeURIComponent(p.id)))).json()).content === 'external write\n');
  fs.unlinkSync(path.join(work, 'docs', 'example.js'));
  await waitSaved(p => p.state === 'deleted');
  fs.writeFileSync(path.join(work, 'docs', 'example.js'), 'recreated\n');
  await waitSaved(p => p.state === 'present');
  assert.equal((await (await fetch(snapshotURL)).json()).content, 'const after = 2;\n', 'An old saved version changed after external writes');
  await evaluate(`showFilesBrowser('work',{mode:'changes',range:'day',actor:'human'})`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Files view overflows phone');
  // A real transcript step-group opens a pinned, commentable review.
  const { CheckpointStore } = require('../checkpoint-store');
  const checkpoints = new CheckpointStore(path.join(home, 'checkpoints'));
  const boundary = { session: path.join(sessionDir, 'chat.jsonl'), run: 'browser-review', call: 'fixture-review-call', tool: 'edit' };
  try {
    assert.equal((await checkpoints.capture(work, { ...boundary, phase: 'before' })).error, '');
    fs.writeFileSync(path.join(work, 'docs/example.js'), 'review fixed\n');
    fs.writeFileSync(path.join(work, 'concurrent.txt'), 'A different task changed this');
    assert.equal((await checkpoints.capture(work, { ...boundary, phase: 'after' })).error, '');
  } finally { checkpoints.close(); }
  await evaluate(`open(${JSON.stringify(key)},'restore')`);
  await evaluate(`browseConversationPath(${JSON.stringify(key)},'a','p')`);
  assert.equal(await evaluate(`!!document.querySelector('[data-step-review]')`), true);
  assert.deepEqual(await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-step-review]'));return {border:s.borderTopWidth,background:s.backgroundColor,font:s.fontSize,minHeight:s.minHeight}})()`), { border: '0px', background: 'rgba(0, 0, 0, 0)', font: '11px', minHeight: '24px' }, 'Review action should look like compact metadata, not a boxed button');
  await evaluate(`openStepReview(JSON.parse(document.querySelector('[data-step-review]').dataset.stepReview))`);
  assert.equal(await evaluate(`viewKind`), 'change-review');
  assert.equal(await evaluate(`document.querySelectorAll('.cr-file').length`), 1);
  assert.equal(await evaluate(`changeReview.otherFiles.some(f=>f.path==='concurrent.txt')`), true);
  await evaluate(`showChangeReview(changeReview.id,'','other')`);
  assert.equal(await evaluate(`document.querySelector('.cr-file-name').textContent`), 'concurrent.txt');
  await evaluate(`showChangeReview(changeReview.id)`);
  await evaluate(`document.querySelector('.cr-file').open=true; document.querySelector('.cr-file').loadDiff()`);
  assert.equal(await evaluate(`document.querySelector('.cr-diff').textContent.includes('review fixed')`), true);
  await evaluate(`document.querySelector('[data-cr-line][data-cr-side="next"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form').closest('.cr-inline-slot').dataset.crAnchor`), 'next:1', 'Comment editor must sit beneath the clicked line');
  await evaluate(`const form=document.querySelector('.cr-comment-form form');form.elements.text.value='Please simplify this';form.elements.suggestion.value='simpler';form.requestSubmit()`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelectorAll('.cr-comment').length===1`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`document.querySelector('.cr-comment').textContent.includes('Please simplify this')`), true);
  const reviewId = await evaluate(`changeReview.id`);
  await evaluate(`showChangeReview(${JSON.stringify(reviewId)})`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment').textContent.includes('simpler')`), true, 'Saved review comment did not survive reopening');
  assert.equal(await evaluate(`document.querySelector('.cr-comment').closest('.cr-inline-slot').dataset.crAnchor`), 'next:1', 'Saved comment lost its line anchor');
  assert.equal(await evaluate(`document.querySelector('.cr-comment').closest('.cr-inline-slot').previousElementSibling.tagName`), 'PRE');
  assert.equal(await evaluate(`document.querySelector('#crComments .cr-comment') === null`), true, 'Line comments must not be duplicated in a bottom collection');
  await evaluate(`document.querySelector('[data-cr-line][data-cr-side="next"]').click();const f=document.querySelector('.cr-comment-form form');f.elements.text.value='Draft near this line';f.elements.text.dispatchEvent(new Event('input',{bubbles:true}));f.elements.end.value='2';f.elements.end.dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form').closest('.cr-inline-slot').dataset.crAnchor`), 'next:2', 'Range editor must follow the last selected line');
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form textarea').value`), 'Draft near this line', 'Moving the range lost the draft');
  await evaluate(`document.querySelector('#crLayout').value='unified';document.querySelector('#crLayout').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.querySelector('.cr-inline-slot .cr-comment').getBoundingClientRect().height > 0`), true, 'Unified view hid an inline comment');
  await evaluate(`document.querySelector('.cr-comment-form [data-cancel]').click();document.querySelector('[data-cr-comment]').click()`);
  assert.equal(await evaluate(`document.querySelector('.cr-comment-form').parentElement.className`), 'cr-file-discussion', 'File comment editor should stay with the file header');
  await evaluate(`{const f=document.querySelector('.cr-comment-form form');f.elements.text.value='File-level note';f.requestSubmit()}`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelector('.cr-file-comments').textContent.includes('File-level note')`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`document.querySelector('.cr-file-comments').textContent.includes('File-level note')`), true);
  await evaluate(`showChangeReview(${JSON.stringify(reviewId)},'fixture-review-call')`);
  assert.equal(await evaluate(`document.querySelector('.cr-inline-slot .cr-comment').textContent.includes('Please simplify this')`), true, 'A step showing the same version lost its inline comment');
  await evaluate(`showChangeReview(${JSON.stringify(reviewId)})`);
  await evaluate(`crPreview(changeReview)`);
  assert.equal(await evaluate(`document.querySelector('.cr-dialog pre').textContent.includes('review fixed')`), true, 'Review package lost its pinned line context');
  await evaluate(`document.querySelector('.cr-dialog [data-cancel]').click()`);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Review overflows phone');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.cr-line')).minHeight`), '20px', 'Line numbers should not inherit full-size button height');
  const reviewScreenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'change-review-desktop.png'), Buffer.from(reviewScreenshot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'conversation-app-phone.png'), Buffer.from(screenshot.result.data, 'base64'));
  // Edit live is a focused path: no tree, replay, attribution scan, or agent panels.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`window.liveFetches=[];window.liveOriginalFetch=window.fetch;window.fetch=(url,opts)=>{liveFetches.push(String(url));return liveOriginalFetch(url,opts)};document.querySelector('[data-cr-live]').onclick({preventDefault(){}})`);
  assert.equal(await evaluate(`fileWs.focused && !!document.querySelector('.live-file-view')`), true);
  assert.equal(await evaluate(`!!document.querySelector('#ffTree, #ffTimeline, #fwHistoryDrawer, #fwAskBtn, .fb-file-nav')`), false);
  assert.equal(await evaluate(`liveFetches.some(u=>/project\\/file-history|files\\/touched|file-history\\/(points|snapshot)/.test(u))`), false, 'Focused editor fetched workspace history');
  for (let i = 0; i < 100; i++) { if (await evaluate(`fileWs.live?.mappedVersion === fileWs.live?.version`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`fileWs.live.marks.size > 0`), true, 'Review changes were not marked in the gutter');
  assert.equal(await evaluate(`fileWs.editor.view.dom.getBoundingClientRect().width > innerWidth * 0.8`), true, 'Code editor should fill the page, not shrink around its text');
  await evaluate(`fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`);
  assert.equal(await evaluate(`!!document.querySelector('.cm-search') && !searchModalOpenNow()`), true, 'Ctrl+F must search this file, not open conversation search');
  await evaluate(`document.querySelector('.cm-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.match(await evaluate(`liveFileHover(fileWs,1)`), /unknown|attribution/i);
  const staleLine = await (await fetch(base + '/api/file/line-info?' + new URLSearchParams({ path: path.join(work, 'docs/example.js'), line: '1', sha: '0'.repeat(64) }))).json();
  assert.equal(staleLine.kind, 'stale', 'Attribution must reject mismatched file versions');
  await evaluate(`fileWs.editor.setContent('const focusedCompletion = 1;\\nfocu');fileWs.editor.view.dispatch({selection:{anchor:fileWs.editor.view.state.doc.length}});fileWs.editor.focus();fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32,ctrlKey:true,bubbles:true}))`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('.cm-tooltip-autocomplete')`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(await evaluate(`document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('focusedCompletion')`), true, 'Ctrl+Space should offer a local completion');
  await evaluate(`fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`fileWs.live.mappedVersion === fileWs.live.version`)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.match(await evaluate(`liveFileHover(fileWs,1)`), /not saved/);
  assert.equal(await evaluate(`fileWs.editor.setDiagnostics([{from:0,to:1,severity:'warning',message:'fixture'}],'stale content')`), false);
  assert.equal(await evaluate(`fileWs.editor.setDiagnostics([],fileWs.editor.getContent())`), true);
  // A late completion response must not be applied to changed code.
  await evaluate(`window.completionRequest=null;fileWs.editor.setLanguageServices({complete:ctx=>{window.completionRequest=ctx;return new Promise(resolve=>window.completeLater=resolve)}});fileWs.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32,ctrlKey:true,bubbles:true}))`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!window.completionRequest`)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(await evaluate(`!!window.completionRequest`), true, 'Language-service completion hook was not called');
  await evaluate(`fileWs.editor.view.dispatch({changes:{from:fileWs.editor.view.state.doc.length,insert:'x'}});completeLater({from:completionRequest.pos-4,options:[{label:'staleChoice'}]})`);
  assert.equal(await evaluate(`completionRequest.signal.aborted`), true);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await evaluate(`document.querySelector('.cm-tooltip-autocomplete')?.textContent.includes('staleChoice') || false`), false);
  await evaluate(`fileWs.editor.setLanguageServices(null);fileWsSaveCode(fileWs)`);
  assert.equal(fs.readFileSync(path.join(work, 'docs/example.js'), 'utf8'), 'const focusedCompletion = 1;\nfocux');
  const focusedShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'focused-live-code.png'), Buffer.from(focusedShot.result.data, 'base64'));
  const liveHash = await evaluate(`fileWsHash(fileWs)`);
  await evaluate(`dispatchHash(decodeURIComponent(${JSON.stringify(liveHash)}))`);
  assert.equal(await evaluate(`fileWs.focused && !!document.querySelector('#liveBack')`), true, 'Focused editing did not survive its route');
  await evaluate(`document.querySelector('#liveBack').onclick()`);
  assert.equal(await evaluate(`viewKind`), 'change-review');
  // Markdown retains the real MRMD editor and run/output mechanics. Save is not a commit.
  const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout;
  fs.writeFileSync(path.join(work, 'README.md'), '# Notebook\n\n```python\n40 + 2\n```\n');
  await evaluate(`openLiveFile(${JSON.stringify(path.join(work, 'README.md'))},{project:'work',root:${JSON.stringify(work)},back:'review='+${JSON.stringify(reviewId)}})`);
  assert.equal(await evaluate(`docState.focused && !!document.querySelector('#docRun') && !document.querySelector('.doc-run-strip')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#docEditor .cm-gutters')).display`), 'flex');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#docEditor .cm-lineNumbers')).display`), 'none');
  await evaluate(`docState.editor.view.dispatch({changes:{from:docState.editor.view.state.doc.length,insert:'\\nA note.\\n'}});document.querySelector('#docSave').onclick()`);
  assert.ok(fs.readFileSync(path.join(work, 'README.md'), 'utf8').includes('A note.'));
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout, headBefore, 'Focused Markdown Save unexpectedly created a commit');
  await evaluate(`window.fetch=(url,opts)=>String(url).includes('/api/doc/run-cell')?Promise.resolve(new Response(JSON.stringify({code:0,out:'42',runtime:'fixture',ms:1}))):String(url).includes('/api/doc/runtime-info')?Promise.resolve(new Response(JSON.stringify({name:'fixture'}))):liveOriginalFetch(url,opts);runDocCell(docState.editor.listCells()[0])`);
  assert.equal(await evaluate(`docState.editor.getContent().includes('42') && docState.editor.getContent().includes('\\x60\\x60\\x60output')`), true, 'MRMD run output did not land in the document');
  await evaluate(`autosaveDocument()`);
  await evaluate(`window.fetch=liveOriginalFetch`);
  const markdownShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'focused-live-markdown.png'), Buffer.from(markdownShot.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Focused Markdown overflows phone');
  const artifactReview = await (await fetch(base + '/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'pi:fixture/artifacts.jsonl', calls: ['artifact-call'] }) })).json();
  assert.ok(!artifactReview.error, artifactReview.error);
  const remotePlot = artifactReview.artifacts.find(f => f.location.host === 'max@fixture');
  assert.equal(remotePlot.livePath, path.join(work, 'scratch/plot.png'));
  const asset = await fetch(base + '/api/reviews/asset?' + new URLSearchParams({ id: artifactReview.id, path: remotePlot.path }));
  assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/api/reviews/asset?' + new URLSearchParams({ id: artifactReview.id, path: '/etc/passwd' }))).status, 400);
  await evaluate(`showChangeReview(${JSON.stringify(artifactReview.id)})`);
  assert.equal(await evaluate(`document.querySelector('#crArtifactList').textContent.includes('Open local copy')`), true);
  const scoped = await (await fetch(base + '/api/reviews/capture-scope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: artifactReview.id, path: path.join(work, 'scratch') }) })).json();
  assert.deepEqual(scoped.scopes, [path.join(work, 'scratch')]);
  const repaired = await (await fetch(base + '/api/reviews/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: artifactReview.id }) })).json();
  assert.equal(repaired.repairOf, artifactReview.id);
  assert.notEqual(repaired.id, artifactReview.id);
  assert.deepEqual(exceptions, []);
  assert.equal(fs.readFileSync(path.join(sessionDir, 'chat.jsonl'), 'utf8'), raw, 'read/compare/merge draft changed the session');
  await send('Browser.close'); await new Promise(r => browser.exitCode != null ? r() : browser.once('exit', r));
});
