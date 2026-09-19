'use strict';
// design/42: the side-panel layout, pinned / marked-unread / removed
// conversations, and the shared recent-files list — against the real server
// and a headless Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

test('side panel layout, inbox marks, and recent files', { timeout: 60000 }, async t => {
  if (spawnSync('chromium', ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.side-panel-test-'));
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
  fs.mkdirSync(sessionDir, { recursive: true });
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), '# Side panel fixture\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial']]) {
    const result = spawnSync('git', args, { cwd: work }); assert.equal(result.status, 0, String(result.stderr));
  }
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const session = (name, title) => fs.writeFileSync(path.join(sessionDir, name + '.jsonl'), [
    { type: 'session', version: 3, id: name, cwd: work },
    msg('p', null, 'user', title), msg('a', 'p', 'assistant', 'Reply for ' + title + '.'),
  ].map(JSON.stringify).join('\n') + '\n');
  session('alpha', 'Alpha question'); session('beta', 'Beta question'); session('gamma', 'Gamma question');
  const keys = { alpha: 'pi:fixture/alpha.jsonl', beta: 'pi:fixture/beta.jsonl', gamma: 'pi:fixture/gamma.jsonl' };
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let serverLog = '';
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), AICONVO_TLS_PORT: '0', AICONVO_HOST: '127.0.0.1', AICONVO_NO_WATCH: '1', AICONVO_CACHE_DIR: path.join(home, 'cache'), AICONVO_CHECKPOINT_DIR: path.join(home, 'checkpoints'), AICONVO_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port;
  let indexed = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (Object.values(keys).every(k => rows.some(s => s.key === k))) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  const api = (body) => fetch(base + '/api/agent-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  // ---- server: the marks and their rules ----
  let state = await api({ unread: [keys.alpha] });
  assert.ok(state.flagged[keys.alpha] > 0, 'mark unread is stored');
  state = await api({ pin: { [keys.beta]: true, 'pi:fixture/missing.jsonl': true } });
  assert.deepEqual(Object.keys(state.pinned), [keys.beta], 'only indexed conversations can be pinned');
  state = await api({ dismiss: [keys.gamma] });
  assert.ok(state.dismissed[keys.gamma] > 0 && state.read[keys.gamma] === state.dismissed[keys.gamma], 'dismiss reads and hides');
  state = await api({ read: { [keys.alpha]: 1 } });
  assert.equal(keys.alpha in state.flagged, false, 'a read lifts the manual flag');
  state = await api({ unread: [keys.alpha] });
  const recentBefore = await (await fetch(base + '/api/recent-files')).json();
  assert.deepEqual(recentBefore.files, []);

  // ---- browser ----
  browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail('timed out: ' + (label || expression) + '\n' + exceptions.join('\n'));
  };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Runtime.enable', {}, sid);
  await size(1440, 1000);
  await send('Page.navigate', { url: base + '/' }, sid);
  await until(`typeof applyLayout === 'function'`);
  assert.equal(await evaluate(`localStorage.getItem('aiconvo.layout')`), null, 'fresh browser has no layout override');
  assert.equal(await evaluate(`document.documentElement.dataset.appFont`), 'sans', 'system sans is the default');
  assert.match(await evaluate(`getComputedStyle(document.body).fontFamily`), /system-ui/);
  await until(`document.body.classList.contains('side-layout') && sessions.length >= 3`, 'side layout on');
  assert.equal(await evaluate(`document.documentElement.dataset.layout`), 'side', 'the class is set before paint');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display`), 'none', 'no top bar on home');
  await until(`document.querySelector('#projSort').closest('#ganttBar') && getComputedStyle(document.querySelector('#projSort')).display === 'flex'`, 'home keeps its project ordering buttons, in the timeline toolbar');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').parentElement.id`), 'sideAgents', 'the tray lives in the column');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('#settingsBtn').closest('#side') !== null`), true, 'settings moved to the column');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#side')).width`), '288px');

  // Marks made on the server before the page loaded show up as sections.
  await until(`!!document.querySelector('.ag-pinned .ag-row[data-key=${JSON.stringify(keys.beta)}]')`, 'pinned section');
  await until(`!!document.querySelector('.ag-unread-tray .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'marked unread shows as unread');
  assert.match(await evaluate(`document.querySelector('.ag-unread-tray .ag-row.unread .ag-age').textContent`), /^marked · \d+[smhd]$/);
  assert.equal(await evaluate(`!!document.querySelector('.ag-unread-tray .ag-row[data-key=${JSON.stringify(keys.gamma)}], [data-sec=read] .ag-row[data-key=${JSON.stringify(keys.gamma)}]')`), false, 'a removed conversation is out of the inbox');
  assert.equal(await evaluate(`document.querySelector('#agentUnreadCount').textContent`), '1');

  // Opening a conversation reads it; the page strip stays, the global bar controls do not.
  await evaluate(`open(${JSON.stringify(keys.alpha)})`);
  await until(`viewKind === 'conversation' && document.body.classList.contains('conv')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display`), 'none', 'no bar in a conversation either');
  assert.equal(await evaluate(`document.querySelector('#chTitle').closest('#floatHead') !== null && getComputedStyle(document.querySelector('#floatHead')).position`), 'relative', 'the title has its own quiet line');
  assert.equal(await evaluate(`$('view').getBoundingClientRect().top >= $('floatHead').getBoundingClientRect().bottom`), true, 'title never overlaps the scrolled prose');
  assert.equal(await evaluate(`document.querySelector('#chTitle').textContent`), 'Alpha question');
  assert.equal(await evaluate(`document.querySelector('#sideProject').hidden + '|' + document.querySelector('#sideProject span').textContent`), 'false|work', 'the project area sits next to home');
  assert.equal(await evaluate(`document.querySelector('#conversationFilesSwitch').checkVisibility()`), false, 'no Conversation/Files switch');
  // The composer is pinned to the bottom of the page and the transcript keeps room for it.
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('#composerDock').getBoundingClientRect();return getComputedStyle(document.querySelector('#composerDock')).position==='fixed' && Math.abs(r.bottom-(innerHeight-10))<2 && r.left>=288})()`), true, 'composer fixed at the bottom, right of the column');
  await until(`parseInt(getComputedStyle(document.querySelector('#view')).paddingBottom) > 100`, 'transcript padding follows the composer height');
  // A one-line user message is one line tall: no reserved action row, no stacked margins.
  assert.equal(await evaluate(`document.querySelector('.msg.user').getBoundingClientRect().height < 64`), true, 'user box height ' + await evaluate(`document.querySelector('.msg.user').getBoundingClientRect().height`));
  // Quiet title, balanced action placement, and theme-controlled shapes.
  assert.deepEqual(await evaluate(`(()=>{const s=getComputedStyle($('floatHead'));return [s.backgroundColor,s.boxShadow,s.borderTopWidth]})()`), ['rgba(0, 0, 0, 0)', 'none', '0px']);
  assert.equal(await evaluate(`(()=>{const m=document.querySelector('.msg.user'),a=m.querySelector('.msg-actions');return a.getBoundingClientRect().top-m.getBoundingClientRect().bottom >= 6})()`), true, 'actions sit outside the bubble, not against its bottom edge');
  // Actions are quiet at rest, but accessible by mouse, keyboard and tap.
  await evaluate(`document.activeElement.blur();document.querySelectorAll('.msg.actions-open').forEach(m=>m.classList.remove('actions-open'))`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 }, sid);
  const actionVisibility = `getComputedStyle(document.querySelector('.msg.user > .msg-actions')).visibility`;
  assert.equal(await evaluate(actionVisibility), 'hidden');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.msg.assistant > .msg-actions')).visibility`), 'hidden', 'assistant actions are hidden too');
  const bubble = await evaluate(`(()=>{const r=document.querySelector('.msg.user').getBoundingClientRect();return {x:r.left+20,y:r.top+10,height:r.height}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bubble.x, y: bubble.y }, sid);
  assert.equal(await evaluate(actionVisibility), 'visible', 'hover reveals actions');
  const gap = await evaluate(`(()=>{const r=document.querySelector('.msg.user > .msg-actions').getBoundingClientRect();return {x:r.left+10,y:r.top-3}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...gap }, sid);
  assert.equal(await evaluate(actionVisibility), 'visible', 'crossing the gap does not hide actions');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 }, sid);
  assert.equal(await evaluate(actionVisibility), 'hidden');
  assert.equal(await evaluate(`document.querySelector('.msg.user').getBoundingClientRect().height`), bubble.height, 'hover causes no layout shift');
  await evaluate(`document.querySelector('.msg.user').focus()`);
  assert.equal(await evaluate(actionVisibility), 'visible', 'keyboard focus reveals actions');
  await evaluate(`document.activeElement.blur();document.querySelector('.msg.user').classList.add('actions-open')`);
  assert.equal(await evaluate(actionVisibility), 'visible', 'touch reveal remains supported');
  await evaluate(`document.querySelector('.msg.user').classList.remove('actions-open')`);
  assert.equal(await evaluate(`getComputedStyle($('agentCompose')).borderTopLeftRadius`), '18px');
  assert.equal(await evaluate(`$('agentAt').checkVisibility()`), false, 'secondary controls are hidden until requested');
  await evaluate(`$('composeTools').querySelector('summary').click()`);
  assert.equal(await evaluate(`['agentAt','agentSnip','agentTree','agentAttach','agentSlash'].every(id=>$(id).checkVisibility())`), true, 'every utility is reachable in the menu');
  await evaluate(`$('composeTools').querySelector('summary').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`$('composeTools').open`), false);
  await evaluate(`$('composeTools').querySelector('summary').click();$('agentText').click()`);
  assert.equal(await evaluate(`$('composeTools').open`), false, 'click outside closes options');
  // A deliberately long model name must yield space to send and microphone.
  await evaluate(`$('modelPick').querySelector('.mname').textContent='provider / very-long-model-name-with-a-million-token-context'`);
  for (const width of [760, 1000, 390]) {
    await size(width, 900);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(await evaluate(`(()=>{const d=$('composerDock').getBoundingClientRect(), row=document.querySelector('.agent-compose-row');return d.left>=0 && d.right<=innerWidth && row.scrollWidth<=row.clientWidth+1 && ['agentRun','modelPick','agentMic'].filter(id=>$(id)?.checkVisibility()).every(id=>{const r=$(id).getBoundingClientRect();return r.left>=d.left && r.right<=d.right})})()`), true, 'composer controls fit at ' + width);
    await evaluate(`$('composeTools').querySelector('summary').click()`);
    assert.equal(await evaluate(`(()=>{const r=document.querySelector('.compose-tools-menu').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && $('agentAttach').checkVisibility()})()`), true, 'menu fits at ' + width);
    if (width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(os.tmpdir(), 'composer-phone-options.png'), Buffer.from(shot.result.data, 'base64'));
    }
    await evaluate(`$('composeTools').open=false`);
  }
  await size(1440, 1000);
  await evaluate(`renderModelStrip();selectTheme('eink')`);
  assert.equal(await evaluate(`getComputedStyle($('agentCompose')).borderTopLeftRadius`), '0px', 'e-ink stays square');
  await evaluate(`$('composeTools').open=true`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.compose-tools-menu')).borderTopLeftRadius`), '0px');
  const inkShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'composer-eink-options.png'), Buffer.from(inkShot.result.data, 'base64'));
  await evaluate(`$('composeTools').open=false;selectTheme('light');setAppFont('sans');renderModelStrip()`);
  const lightShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'composer-light-sans.png'), Buffer.from(lightShot.result.data, 'base64'));
  await evaluate(`selectTheme('dark');setAppFont('theme')`);
  assert.equal(await evaluate(`getComputedStyle($('agentCompose')).borderTopLeftRadius`), '18px', 'theme switching restores rounded shapes');
  // Scrolling down hides the quiet title line; scrolling up brings it back.
  await evaluate(`document.querySelector('#conversationTranscript').insertAdjacentHTML('beforeend','<div style="height:3000px"></div>')`);
  await new Promise(r => setTimeout(r, 300)); // the tail pin settles
  const scrollTo = top => evaluate(`(()=>{const v=document.querySelector('#view');v.scrollTop=${top};v.dispatchEvent(new Event('scroll'));return v.scrollTop})()`);
  await scrollTo(1000); await scrollTo(1100);
  await new Promise(r => setTimeout(r, 250));
  assert.equal(await evaluate(`document.body.classList.contains('chrome-min') && getComputedStyle(document.querySelector('#floatHead')).opacity==='0' && getComputedStyle(document.querySelector('#floatHead')).pointerEvents==='none'`), true, 'title hides on scroll down');
  const hiddenShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-scrolled.png'), Buffer.from(hiddenShot.result.data, 'base64'));
  await scrollTo(await evaluate(`$('view').scrollTop - 64`));
  assert.equal(await evaluate(`document.body.classList.contains('chrome-min')`), false, 'title returns on scroll up');
  await evaluate(`document.querySelector('#view').scrollTop=0`);
  assert.equal(await evaluate(`document.querySelector('#sideNew span').textContent + '|' + document.querySelector('#sideNewMore').hidden`), 'new here|false', '+ new starts here, ▾ offers the rest');
  await evaluate(`document.querySelector('#sideNewMore').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.ag-menu [data-ag-action]')].map(b=>b.textContent).join('|')`), 'New here · work|New, no project');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  // The person wrote in every fixture conversation: "recent" lists the ones not shown above, project-scoped on request.
  await until(`document.querySelectorAll('[data-sec=recent] .ag-row[data-key]').length >= 1`, 'recent conversations');
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-sec=recent] .ag-row[data-key]')].map(r=>r.dataset.key).includes(${JSON.stringify(keys.gamma)})`), true, 'a conversation removed from the inbox still counts as one you wrote in');
  // Inbox rows name the project on a second line; a project-scoped recent list is one line per row.
  assert.equal(await evaluate(`document.querySelector('.ag-pinned .ag-row .ag-dir').textContent`), 'work');
  await evaluate(`document.querySelector('[data-scope-of=recent] [data-scope=project]').click()`);
  assert.equal(await evaluate(`!!document.querySelector('[data-sec=recent] .ag-row[data-key] .ag-sub') + '|' + !!document.querySelector('[data-sec=recent] .ag-row[data-key] .ag-title .ag-age')`), 'false|true', 'project scope: no folder line, time on the title line');
  await evaluate(`document.querySelector('[data-scope-of=recent] [data-scope=all]').click()`);
  const convShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-conversation.png'), Buffer.from(convShot.result.data, 'base64'));
  await until(`!document.querySelector('.ag-unread-tray .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'opening reads it');
  await until(`!!document.querySelector('#agentsPop .ag-row.current[data-key=${JSON.stringify(keys.alpha)}]')`, 'the open conversation is marked in the column');
  for (let i = 0; i < 100; i++) { if (!(keys.alpha in (await (await fetch(base + '/api/agent-read')).json()).flagged)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(keys.alpha in (await (await fetch(base + '/api/agent-read')).json()).flagged, false, 'the read reached the server');

  // Row menu: mark unread, pin, remove. Each reaches the server.
  const menuClick = async (key, label) => {
    await evaluate(`document.querySelector('#agentsPop .ag-row[data-key=${JSON.stringify(key)}] .ag-more').click()`);
    await until(`!!document.querySelector('.ag-menu')`, 'row menu');
    const found = await evaluate(`(()=>{const b=[...document.querySelectorAll('.ag-menu [data-ag-action]')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`);
    assert.equal(found, true, 'menu item ' + label);
  };
  await evaluate(`document.querySelector('#agentsPop .ag-row[data-key=${JSON.stringify(keys.alpha)}] .ag-more').click()`);
  await until(`!!document.querySelector('.ag-menu')`, 'row menu');
  const menuShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-menu.png'), Buffer.from(menuShot.result.data, 'base64'));
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`!!document.querySelector('.ag-menu')`), false, 'Escape closes the row menu');
  assert.equal(await evaluate(`viewKind`), 'conversation', 'Escape on the menu did not navigate');
  await menuClick(keys.alpha, 'Mark as unread');
  await until(`!!document.querySelector('.ag-unread-tray .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'marked unread from the menu');
  // Rows: the title across the row, folder and a short time under it, no icon columns.
  assert.equal(await evaluate(`!!document.querySelector('#agentsPop .ag-row .src, #agentsPop .ag-unread-dot, #agentsPop .ag-read-dot')`), false, 'the icon columns are gone');
  assert.match(await evaluate(`document.querySelector('.ag-unread-tray .ag-row.unread .ag-age').textContent`), /^marked · \d+[smhd]$/);
  assert.equal(await evaluate(`(()=>{const r=document.querySelector('.ag-unread-tray .ag-row.unread');const t=r.querySelector('.ag-title').getBoundingClientRect(),s=r.querySelector('.ag-sub').getBoundingClientRect();return s.top>=t.bottom-1 && t.width>200})()`), true, 'title on its own full-width line');
  for (let i = 0; i < 100 && !(keys.alpha in (await (await fetch(base + '/api/agent-read')).json()).flagged); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(keys.alpha in (await (await fetch(base + '/api/agent-read')).json()).flagged, 'the flag reached the server');
  await menuClick(keys.alpha, 'Pin to the top');
  await until(`!!document.querySelector('.ag-pinned .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]') && !document.querySelector('.ag-unread-tray .ag-row[data-key=${JSON.stringify(keys.alpha)}]')`, 'a pinned unread row lives in the pinned section only');
  assert.equal(await evaluate(`document.querySelector('#agentUnreadCount').textContent`), '1', 'pinned unread still counts');
  assert.equal(await evaluate(`[...document.querySelectorAll('.ag-pinned .ag-row')].map(r=>r.dataset.key).join(',')`), keys.alpha + ',' + keys.beta, 'newest pin first');
  await menuClick(keys.beta, 'Remove from the inbox');
  await until(`!document.querySelector('.ag-unread-tray .ag-row[data-key=${JSON.stringify(keys.beta)}], [data-sec=read] .ag-row[data-key=${JSON.stringify(keys.beta)}]')`);
  assert.equal(await evaluate(`!!document.querySelector('.ag-pinned .ag-row[data-key=${JSON.stringify(keys.beta)}]')`), true, 'removing from the inbox does not unpin');
  await menuClick(keys.beta, 'Unpin');
  await until(`!document.querySelector('.ag-pinned .ag-row[data-key=${JSON.stringify(keys.beta)}]')`, 'unpinned and dismissed: out of the inbox');
  for (let i = 0; i < 100 && keys.beta in (await (await fetch(base + '/api/agent-read')).json()).pinned; i++) await new Promise(r => setTimeout(r, 30));
  assert.equal(keys.beta in (await (await fetch(base + '/api/agent-read')).json()).pinned, false);

  // A later reply on a removed conversation brings it back as unread.
  fs.appendFileSync(path.join(sessionDir, 'gamma.jsonl'), JSON.stringify(msg('q2', 'a', 'user', 'again')) + '\n' + JSON.stringify(msg('a2', 'q2', 'assistant', 'New reply.')) + '\n');
  await fetch(base + '/api/rescan', { method: 'POST' });
  await until(`!!document.querySelector('.ag-unread-tray .ag-row.unread[data-key=${JSON.stringify(keys.gamma)}]')`, 'a removed conversation returns with a newer reply');

  // Keyboard: `a` moves the cursor into the column; Escape leaves; `u` toggles unread.
  await evaluate(`document.activeElement.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#agentsPop').classList.contains('kbd') && !!document.querySelector('.ag-row.kbd-selected')`), true, 'a focuses the column');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden`), false, 'the column never hides');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#agentsPop').classList.contains('kbd') || !!document.querySelector('.ag-row.kbd-selected')`), false, 'Escape hands the keys back');
  assert.equal(await evaluate(`viewKind`), 'conversation', 'Escape in the column did not navigate');

  // Recent files: opening a file in the editor records it; the column lists it.
  await evaluate(`openLiveFile(${JSON.stringify(path.join(work, 'README.md'))},{project:'work'})`);
  await until(`viewKind === 'file'`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display`), 'none', 'no bar at all over a file');
  await until(`recentFilesList.some(f=>f.path===${JSON.stringify(path.join(work, 'README.md'))})`, 'recent file recorded');
  await until(`document.querySelector('.ag-files-block .ag-row .ag-title span')?.textContent === 'README.md'`, 'recent file listed');
  assert.equal(await evaluate(`document.querySelector('#sideNew span').textContent + '|' + document.querySelector('#sideNewMore').hidden`), 'new|true', 'outside a conversation + new is the plain one');
  // A folded section docks at the bottom and remembers; the one scope toggle covers conversations and files.
  await evaluate(`document.querySelector('[data-sec-head=recent]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-sec=recent] .ag-sec-body').hidden && JSON.parse(localStorage.getItem('aiconvo.agentSections.v1'))['fold:recent'] && document.querySelector('[data-sec=recent]').parentElement.id === 'agentsLegacy'`), true, 'folded, remembered, docked at the bottom');
  await evaluate(`document.querySelector('[data-sec-head=recent]').click()`);
  assert.equal(await evaluate(`!document.querySelector('[data-sec=recent] .ag-sec-body').hidden && document.querySelector('[data-sec=recent]').parentElement.id === 'agentsUnread'`), true, 'open again: back in the flow');
  await evaluate(`document.querySelector('[data-scope-of=recent] [data-scope=project]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.ag-files-block .ag-row').length + '|' + JSON.parse(localStorage.getItem('aiconvo.agentSections.v1'))['scope:recent']`), '1|project');
  await evaluate(`recentFilesList.push({path:'/tmp/elsewhere/notes.md',project:'other',at:Date.now(),kind:'opened'});renderAgentsPop(false)`);
  assert.equal(await evaluate(`document.querySelectorAll('.ag-files-block .ag-row').length`), 1, 'project scope hides other projects');
  await evaluate(`document.querySelector('[data-scope-of=recent] [data-scope=all]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.ag-files-block .ag-row').length`), 2);
  // Traffic and notifications sit at the bottom of the column.
  assert.equal(await evaluate(`(()=>{const a=document.querySelector('#agentsUnread').getBoundingClientRect(),b=document.querySelector('#agentsLegacy').getBoundingClientRect(),p=document.querySelector('#agentsPop').getBoundingClientRect();return b.top>a.bottom && Math.abs(b.bottom-p.bottom)<12})()`), true, 'traffic pinned to the bottom');
  assert.equal((await (await fetch(base + '/api/recent-files')).json()).files[0].kind, 'opened');
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-desktop.png'), Buffer.from(shot.result.data, 'base64'));

  // A phone keeps the top bar whatever the choice says; a desk gets the column back.
  await size(390, 844);
  await until(`!document.body.classList.contains('side-layout')`, 'phone falls back to the top bar');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').parentElement.tagName`), 'BODY', 'the tray returned to the page');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden && document.querySelector('#settingsBtn').closest('header') !== null`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('body > header')).display !== 'none'`), true);
  await size(1440, 1000);
  await until(`document.body.classList.contains('side-layout') && document.querySelector('#agentsPop').parentElement.id === 'sideAgents'`, 'column back on a wide screen');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate(`goHome()`);
  await until(`viewKind === 'home' && !!document.querySelector('#list .timeline, #list .item, #list .empty')`);
  await new Promise(r => setTimeout(r, 300));
  const homeShot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-home.png'), Buffer.from(homeShot.result.data, 'base64'));
  // The fold: a rail with the inbox count; a click on it brings the column back.
  await evaluate(`setSideFold(true)`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#side')).width`), '14px');
  assert.equal(await evaluate(`document.querySelector('#side').dataset.unread`), '2');
  await evaluate(`document.querySelector('#side').click()`);
  assert.equal(await evaluate(`document.body.classList.contains('side-fold')`), false);

  // Settings offer the choice; picking the top bar restores everything at once.
  await evaluate(`showSettings('appearance')`);
  await until(`!!document.querySelector('input[name=setLayout][value=top]')`);
  await evaluate(`$('setAppFont').value='sans';$('setAppFont').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`localStorage.getItem('aiconvo.font')`), 'sans');
  assert.match(await evaluate(`getComputedStyle(document.body).fontFamily`), /system-ui/);
  await send('Page.reload', {}, sid);
  await until(`typeof settingsOpen !== 'undefined' && settingsOpen && !!document.querySelector('#setAppFont')`);
  assert.equal(await evaluate(`$('setAppFont').value`), 'sans', 'font preference survives reload');
  await evaluate(`document.querySelector('.settings-pane').insertAdjacentHTML('beforeend','<div class="md" id="fontProbe"><code>const aligned = 1;</code></div>')`);
  assert.match(await evaluate(`getComputedStyle(document.querySelector('#fontProbe code')).fontFamily`), /monospace/);
  await evaluate(`$('setAppFont').value='theme';$('setAppFont').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.documentElement.style.getPropertyValue('--font')`), '', 'theme default removes the override');
  await evaluate(`const r=document.querySelector('input[name=setLayout][value=top]'); r.checked=true; r.onchange()`);
  assert.equal(await evaluate(`document.body.classList.contains('side-layout')`), false);
  assert.equal(await evaluate(`localStorage.getItem('aiconvo.layout')`), 'top', 'top bar is now an explicit saved preference');
  await send('Page.reload', {}, sid);
  await until(`typeof settingsOpen !== 'undefined' && settingsOpen && !!document.querySelector('#setAppFont')`);
  assert.equal(await evaluate(`sideLayoutOn()`), false, 'explicit top preference survives reload');
  assert.equal(await evaluate(`document.querySelector('#agentsPop').hidden && document.querySelector('#agentsPop').parentElement.tagName === 'BODY'`), true);
  assert.equal(await evaluate(`document.querySelector('#chTitle').closest('header') !== null && document.querySelector('#projSort').closest('header') !== null && document.querySelector('#chMove').nextElementSibling.id === 'chNew'`), true, 'the bar gets its pieces back');
  await evaluate(`goHome()`);
  await new Promise(r => setTimeout(r, 300));
  await evaluate(`toggleAgents(true)`);
  await until(`!document.querySelector('#agentsPop').hidden && !!document.querySelector('#agentsPop .ag-row')`);
  assert.equal(await evaluate(`!!(document.querySelector('[data-sec=files], .ag-files-block')?.checkVisibility())`), false, 'the tray has no recent-files list');
  const topHome = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(os.tmpdir(), 'side-panel-top-home.png'), Buffer.from(topHome.result.data, 'base64'));
  assert.deepEqual(exceptions, []);
  await send('Browser.close'); await new Promise(r => browser.exitCode != null ? r() : browser.once('exit', r));
});
