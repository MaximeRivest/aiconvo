'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const componentFiles = fs.readdirSync(root).filter(file => file.endsWith('.css')).sort();

test('component shapes use tokens, not fixed decorative radii', () => {
  const sources = [['app.html', [...app.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')],
    ...componentFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]),
    ['surfaces.css', fs.readFileSync(path.join(root, 'design/surfaces.css'), 'utf8')]];
  for (const [file, css] of sources) {
    for (const match of css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)) {
      // Flush joined edges and semantic circles (radio buttons, status dots)
      // are structural, not decorative corners. Everything else uses a token.
      const value = match[1].trim();
      assert.ok(value.includes('var(--') || /^(0(?:px)?|50%|inherit)$/.test(value), `${file}: untokenized radius ${value}`);
    }
  }
  assert.match(app, /href="\/surfaces\.css"/);
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /'\/surfaces\.css':/);
});

test('floating bordered surfaces have an explicit shape contract', () => {
  const registry = fs.readFileSync(path.join(root, 'design/surfaces.css'), 'utf8');
  const css = [...app.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') +
    componentFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const exceptions = new Map([
    ['.project-row-label', 'flush timeline labels'], ['.project-labels::after', 'timeline label background'], ['#selRect', 'selection rectangle'],
    ['.fg-mark', 'timeline marker'], ['.tnode', 'tree graph node'],
    ['#tabs', 'joined mobile tab strip'],
    ['.ls-livechip', 'inherits the button shape'], ['.md-run', 'inherits the button shape'],
    ['#gRecenter', 'inherits the button shape'], ['body.zen:not(.home) #zenExit', 'inherits the button shape'],
    ['.project-new-cell', 'flush timeline header cell'], ['.msg .unfold', 'inherits the button shape'],
  ]);
  const missing = [];
  for (const [, selectors, declarations] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/position\s*:\s*(absolute|fixed)/.test(declarations) || !/background\s*:/.test(declarations) || !/border(?:-\w+)?\s*:/.test(declarations)) continue;
    if (/border-radius\s*:/.test(declarations)) continue; // checked above
    for (const selector of selectors.split(',').map(s => s.trim())) {
      if (!registry.includes(selector) && !exceptions.has(selector)) missing.push(selector);
    }
  }
  assert.deepEqual(missing, [], 'Floating surfaces missing from design/surfaces.css');
});

// The existing selectors deliberately exercise the compatibility adapters,
// not just the new utility classes. Component CSS is loaded from the real app.
const specimens = [
  ['mark preview', 'menu', '<div id="markPop"><h4>A conversation</h4><div class="mp-meta">Project and messages</div></div>'],
  ['machine picker', 'menu', '<div id="machinePop"><button>lambda</button></div>'],
  ['filters', 'menu', '<div id="filtersPop"><label>Source</label><select><option>All</option></select></div>'],
  ['model picker', 'menu', '<div class="mpick"><div class="mp-top">Model</div><div class="mp-list"><button class="mp-row">One model</button></div><div class="mp-foot"><button>Use model</button></div></div>'],
  ['commands', 'menu', '<div class="slash-pop"><div class="slash-inp-row">Commands</div><div class="slash-row sel">Selected command</div></div>'],
  ['file completion', 'menu', '<div class="file-completion"><div role="option" aria-selected="true">README.md</div></div>'],
  ['file actions', 'menu', '<div class="file-action-menu"><button>Open file</button></div>'],
  ['speech speed', 'menu', '<div class="tts-rate-menu"><button>1×</button></div>'],
  ['compose options', 'menu', '<div class="compose-tools-menu"><button>Context</button></div>'],
  ['message actions', 'menu', '<details class="msg-more-actions" open><summary>More</summary><div data-pick><button>Fork</button></div></details>'],
  ['editor options', 'menu', '<details class="live-more" open><summary>More</summary><div data-pick><button>History</button></div></details>'],
  ['file finder', 'menu', '<div class="fb-finder-popup"><div class="fb-finder-tools">Find</div><div id="fbFinderList"><div role="option">File</div></div></div>'],
  ['review options', 'menu', '<div class="cr-view"><div class="cr-menu-panel" data-pick><button>Review</button></div></div>'],
  ['editor tooltip', 'menu', '<div class="cm-tooltip">Completion</div>'],
  ['language hover', 'menu', '<div class="mrmd-language-hover">Definition</div>'],
  ['generic popup', 'menu', '<div class="ui-menu"><button>Action</button></div>'],
  ['semantic menu', 'menu', '<div role="menu"><button>Action</button></div>'],
  ['generic dialog', 'dialog', '<div class="dialog"><h3>Confirm</h3><button>OK</button></div>'],
  ['native dialog', 'dialog', '<dialog open>Native dialog <button>OK</button></dialog>'],
  ['context inspection', 'dialog', '<dialog open id="contextPanel"><header><h2>Context</h2></header></dialog>'],
  ['merge answers', 'dialog', '<dialog open class="flow-merge-dialog"><h2>Merge answers</h2></dialog>'],
  ['review dialog', 'dialog', '<dialog open class="cr-dialog"><header>Review</header><textarea>Note</textarea></dialog>'],
  ['mode form', 'dialog', '<div class="mf-card"><b>Mode</b><textarea>Instructions</textarea></div>'],
  ['project setup', 'dialog', '<form class="cc-card ps-card" role="dialog"><h2>Project</h2></form>'],
  ['extension view shell', 'dialog', '<div class="rc-cv-card"><div class="rc-cv-head">View</div><pre class="rc-cv-screen">Text</pre></div>'],
  ['extension prompt', 'dialog', '<div class="rc-dialog"><b>Question</b><input></div>'],
  ['generic modal', 'dialog', '<div class="ui-dialog">Modal</div>'],
  ['search result', 'card', '<div class="sr-group"><div class="sr-head">Result</div><p>Match</p></div>'],
  ['review card', 'card', '<details class="cr-file"><summary>README.md</summary><div>Diff</div></details>'],
  ['file list', 'card', '<div class="fb-list"><button>README.md</button></div>'],
  ['file changes', 'card', '<details class="fb-change"><summary>Change</summary><div>Diff</div></details>'],
  ['review comment', 'card', '<div class="cr-comment"><header>Comment</header><p>Text</p></div>'],
  ['help hint', 'card', '<div id="helpMini">Keyboard help</div>'],
  ['toast', 'card', '<div class="toast">Saved</div>'],
  ['generic card', 'card', '<div class="ui-card">Card</div>'],
  ['button', 'control', '<button>Choose</button>'],
  ['textarea', 'control', '<textarea>Instructions</textarea>'],
  ['editor button', 'small', '<div class="live-file-head"><button data-pick>Save</button></div>'],
  ['review button', 'small', '<div class="cr-view"><button data-pick>Review</button></div>'],
  ['finder field', 'control', '<form id="fbSearchForm"><input type="search"></form>'],
  ['file badge', 'pill', '<span class="fb-badge">New</span>'],
  ['scope switch', 'pill', '<div class="ag-scope"><button>All</button></div>'],
  ['provider chip', 'pill', '<div class="mpick"><button class="mp-prov" data-pick>Provider</button></div>'],
  ['generic pill', 'pill', '<button class="ui-pill">Pill</button>'],
  ['agent tray', 'menu', '<div id="agentsPop"><div class="ag-row">Conversation</div></div>'],
  ['composer', 'composer', '<div class="agent-compose"><textarea>Write a message</textarea></div>'],
];

test('real app surfaces follow the theme together, including nested painted edges', { timeout: 60000 }, async t => {
  const chromium = process.env.CHROMIUM || 'chromium';
  if (spawnSync(chromium, ['--version']).error) return t.skip('chromium unavailable');
  const home = fs.mkdtempSync(path.join(os.homedir(), '.surface-test-'));
  const agent = path.join(home, '.pi/agent'), dir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date().toISOString(), key = 'pi:fixture/shape.jsonl';
  fs.writeFileSync(path.join(dir, 'shape.jsonl'), [
    { type: 'session', version: 3, id: 'shape', cwd: path.join(home, 'work') },
    { type: 'message', id: 'p', parentId: null, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: 'Theme shapes across the app' }] } },
    { type: 'message', id: 'a', parentId: 'p', timestamp: when, message: { role: 'assistant', content: [{ type: 'text', text: 'A readable answer.' }] } },
    { type: 'message', id: 'b', parentId: 'p', timestamp: when, message: { role: 'assistant', content: [{ type: 'text', text: 'An alternative answer.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode != null || child.signalCode) return;
    const done = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await done; } finally { clearTimeout(timer); }
  };
  t.after(async () => { ws?.close(); await stop(browser); await stop(server); fs.rmSync(home, { recursive: true, force: true }); });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = 'http://127.0.0.1:' + port;
  let log = '';
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), AICONVO_TLS_PORT: '0', AICONVO_HOST: '127.0.0.1', AICONVO_NO_WATCH: '1', AICONVO_NO_LEDGER: '1', AICONVO_CACHE_DIR: path.join(home, 'cache'), AICONVO_CHECKPOINT_DIR: path.join(home, 'checkpoints'), AICONVO_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await (await fetch(base + '/api/sessions')).json()).some(s => s.key === key)) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, log);
  const sheet = await fetch(base + '/surfaces.css');
  assert.equal(sheet.status, 200); assert.match(await sheet.text(), /\.ui-menu/);
  browser = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result)); return out.result?.result?.value;
  };
  const until = async expr => {
    for (let i = 0; i < 200; i++) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 30)); }
    assert.fail('Timed out: ' + expr + '\n' + errors.join('\n'));
  };
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
  const shot = async name => { const p = await send('Page.captureScreenshot', { format: 'png' }, sid); fs.writeFileSync(path.join(os.tmpdir(), name + '.png'), Buffer.from(p.result.data, 'base64')); };
  await send('Runtime.enable', {}, sid); await size(1200, 900);
  await send('Page.navigate', { url: base }, sid);
  await until(`typeof timelineGeom !== 'undefined' && timelineGeom?.rows?.length && document.querySelector('.tmark')`);
  // The actual conversation preview: the original missed surface.
  await evaluate(`selectTheme('light');showMarkPop(document.querySelector('.tmark'), ${JSON.stringify(key)})`);
  await until(`!$('markPop').hidden`);
  assert.equal(await evaluate(`getComputedStyle($('markPop')).borderTopLeftRadius`), '10px');
  await shot('theme-conversation-preview');
  await evaluate(`hideMarkPop();searchModalOpen()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#searchOverlay .dialog')).borderTopLeftRadius`), '14px');
  await evaluate(`searchModalClose();open(${JSON.stringify(key)})`);
  await until(`!!$('agentText')`);
  await evaluate(`openConversationMerge(current.key,'p')`);
  await until(`!!document.querySelector('dialog[open]')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('dialog[open]')).borderTopLeftRadius`), '14px');
  // A picker inside a native dialog must stay in the top layer, and scroll.
  await evaluate(`document.querySelector('[data-merge-model]').click()`);
  await until(`!!document.querySelector('dialog[open] .mpick')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('dialog[open] .mpick')).borderTopLeftRadius`), '10px');
  await evaluate(`document.querySelector('[data-merge-cancel]').click()`);

  // A gallery of every surface family, with the *real* loaded app CSS.
  // Only positioning/size are normalized; shape, overflow, and child paints
  // remain the production rules. No route or provider is invoked by specimens.
  await evaluate(`window.surfaceSpecs=${JSON.stringify(specimens)};
    window.gallery=document.createElement('div');gallery.id='shapeGallery';
    const style=document.createElement('style');style.textContent='#shapeGallery{position:fixed;inset:0;overflow:auto;z-index:150;background:var(--bg);padding:16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-content:start}#shapeGallery article{min-width:0;padding:8px}#shapeGallery h3{font-size:12px}#shapeGallery [data-shape]{position:relative;inset:auto;transform:none;display:block;width:100%;min-width:0;max-width:100%;height:auto;max-height:220px;margin:0}#shapeGallery [data-shape] .mp-list{max-height:120px}';document.head.append(style);
    for(const [name,kind,html] of surfaceSpecs){const a=document.createElement('article');a.innerHTML='<h3></h3>'+html;a.querySelector('h3').textContent=name;const el=a.querySelector('[data-pick]')||a.children[1];el.dataset.shape=kind;el.dataset.name=name;el.style.position='relative';el.style.inset='auto';gallery.append(a)}
    document.body.append(gallery);`);
  const radii = () => evaluate(`Array.from(gallery.querySelectorAll('[data-shape]'),el=>{const s=getComputedStyle(el);return {name:el.dataset.name,kind:el.dataset.shape,r:[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius]}})`);
  const defaults = { menu: 10, dialog: 14, card: 6, control: 6, small: 4, pill: 999, composer: 18 };
  for (const theme of ['light', 'dark', 'eink']) {
    await evaluate(`selectTheme(${JSON.stringify(theme)})`);
    for (const item of await radii()) {
      const expected = theme === 'eink' ? 0 : defaults[item.kind];
      assert.deepEqual(item.r, Array(4).fill(expected + 'px'), theme + ': ' + item.name);
    }
    await evaluate(`gallery.scrollTop=0`);
    await shot('theme-shapes-' + theme);
    await evaluate(`gallery.scrollTop=900`);
    await shot('theme-dialogs-' + theme);
  }
  // One scale changes everything; no per-surface patch or theme reload.
  await evaluate(`selectTheme('light');document.documentElement.style.setProperty('--roundness','0')`);
  for (const item of await radii()) assert.deepEqual(item.r, Array(4).fill('0px'), 'square: ' + item.name);
  await evaluate(`document.documentElement.style.setProperty('--roundness','0.5')`);
  for (const item of await radii()) assert.deepEqual(item.r, Array(4).fill(defaults[item.kind] / 2 + 'px'), 'half: ' + item.name);
  await evaluate(`document.documentElement.style.removeProperty('--roundness');document.documentElement.style.setProperty('--r-menu','21px');document.documentElement.style.setProperty('--r-dialog','25px')`);
  for (const item of await radii()) {
    const expected = item.kind === 'menu' ? 21 : item.kind === 'dialog' ? 25 : defaults[item.kind];
    assert.deepEqual(item.r, Array(4).fill(expected + 'px'), 'independent override: ' + item.name);
  }
  await evaluate(`document.documentElement.style.removeProperty('--r-menu');document.documentElement.style.removeProperty('--r-dialog')`);
  // Painted footer/header edges are clipped, while the model list still scrolls.
  assert.deepEqual(await evaluate(`(()=>{const el=gallery.querySelector('.mpick');el.querySelector('.mp-list').innerHTML='<button class="mp-row">Model</button>'.repeat(80);const list=el.querySelector('.mp-list');list.scrollTop=100;return [getComputedStyle(el).overflow,list.scrollTop>0]})()`), ['hidden', true]);
  assert.equal(await evaluate(`(()=>{const m=gallery.querySelector('.file-action-menu');m.scrollIntoView({block:'center'});const r=m.getBoundingClientRect();const hit=document.elementFromPoint(r.left+1,r.top+1);return hit!==m&&!m.contains(hit)})()`), true, 'rounded menu clips child paint/hit area at the corner');
  assert.equal(await evaluate(`getComputedStyle(gallery.querySelector('.cr-file')).overflow`), 'visible', 'cards do not clip escaping menus');
  assert.equal(await evaluate(`getComputedStyle(gallery.querySelector('.cr-file > summary')).borderTopLeftRadius`), '5px', 'summary follows card corners');
  await size(390, 844);
  for (const theme of ['light', 'eink']) {
    await evaluate(`selectTheme(${JSON.stringify(theme)})`);
    for (const item of await radii()) assert.deepEqual(item.r, Array(4).fill((theme === 'eink' ? 0 : defaults[item.kind]) + 'px'), 'phone ' + theme + ': ' + item.name);
  }
  assert.deepEqual(errors, []);
});
