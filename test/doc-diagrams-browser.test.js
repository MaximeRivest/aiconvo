'use strict';
// End-to-end proof for the document reading view in a real browser: open a
// markdown file that contains a mermaid fence, switch to the reading view,
// and require an actual rendered <svg> (the vendored /vendor/mermaid.min.js,
// not a stub). Then switch back to the editor.
//
// This is the acceptance test for "see diagrams and return to the code
// without leaving aiconvo". It needs chromium; it skips cleanly without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const DOC = [
  '# Flow views',
  '',
  'Prose around the diagram.',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Source] --> B[Reading] --> C[Wiki]',
  '```',
  '',
  'Text after the diagram.',
  '',
  // The vault's own architecture docs use nested statecharts; cover that
  // syntax too, so a diagram style the operator actually reads is proven.
  '```mermaid',
  'stateDiagram-v2',
  '  [*] --> Reading',
  '  state Reading {',
  '    [*] --> L1',
  '    L1 --> L5',
  '    L5 --> [*]',
  '  }',
  '  Reading --> RoutingReview',
  '```',
  '',
].join('\n');

test('the document reading view renders a real mermaid diagram and returns to the editor', { timeout: 120000 }, async t => {
  if (spawnSync('chromium', ['--version']).error) return t.skip('chromium is not installed');
  const home = fs.mkdtempSync(path.join(os.homedir(), '.doc-diagrams-test-'));
  const work = path.join(home, 'work');
  const agent = path.join(home, '.pi/agent');
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  const docPath = path.join(work, 'docs', 'diagrams.md');
  fs.writeFileSync(docPath, DOC);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: work });
    assert.equal(result.status, 0, String(result.stderr));
  }

  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  let server, browser, ws, serverLog = '';
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    ws?.close();
    await stop(browser); await stop(server);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOME: home, PORT: String(port), AICONVO_TLS_PORT: '0', AICONVO_HOST: '127.0.0.1',
      AICONVO_NO_WATCH: '0', AICONVO_NO_LEDGER: '0', AICONVO_CACHE_DIR: path.join(home, 'cache'),
      AICONVO_CHECKPOINT_DIR: path.join(home, 'checkpoints'), AICONVO_DELEGATION_ROOT: path.join(home, 'delegations'),
      PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', b => serverLog += b);
  server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 200; i++) {
    try { const res = await fetch(base + '/'); if (res.ok) { up = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(up, 'server did not start: ' + serverLog);

  browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 15000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
  const sid = attached.result.sessionId;
  await send('Runtime.enable', {}, sid);
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result?.exceptionDetails || out.result));
    return out.result?.result?.value;
  };
  const waitFor = async (expression, label, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expression)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.fail('timed out waiting for ' + label + (exceptions.length ? ': ' + exceptions.join('\n') : ''));
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.navigate', { url: base + '/' }, sid);
  await waitFor(`typeof openLiveFile === 'function' && !!document.querySelector('#view')`, 'the app to boot');
  await evaluate(`openLiveFile(${JSON.stringify(docPath)})`);
  await waitFor(`!!document.querySelector('#docEditor .cm-content') && !!document.querySelector('#docDiagrams')`, 'the document editor');

  // The editor is a source surface: the fence is code, and there is no diagram.
  assert.equal(await evaluate(`!!document.querySelector('#docEditor .mmd-fig')`), false, 'the bundle has no mermaid widget');
  assert.equal(await evaluate(`document.querySelector('#docPreview').hidden`), true);

  await evaluate(`document.querySelector('#docDiagrams').click()`);
  await waitFor(`!!document.querySelector('#docPreview .mmd-fig svg')`, 'a rendered mermaid svg');

  const diagram = await evaluate(`(() => {
    const figs = [...document.querySelectorAll('#docPreview .mmd-fig')];
    const first = figs[0];
    return {
      svgTags: figs.length,
      nodes: [...first.querySelectorAll('svg text, svg .nodeLabel, svg foreignObject')].map(e => e.textContent.trim()),
      statechart: figs[1] ? figs[1].textContent : '',
      source: document.querySelector('#docPreview .mmd-src').textContent,
      editorHidden: document.querySelector('#docEditor').hidden,
      button: document.querySelector('#docDiagrams').textContent,
      prose: document.querySelector('#docPreview').textContent.includes('Prose around the diagram.'),
      errors: [...document.querySelectorAll('#docPreview .mmd-err')].map(e => e.textContent),
    };
  })()`);
  assert.equal(diagram.svgTags, 2, 'both fences rendered: ' + JSON.stringify(diagram.errors));
  assert.ok(diagram.nodes.some(n => n.includes('Source')), 'the diagram shows its labels: ' + JSON.stringify(diagram.nodes));
  assert.ok(diagram.nodes.some(n => n.includes('Wiki')), 'the diagram shows its labels');
  assert.ok(diagram.statechart.includes('L1') && diagram.statechart.includes('RoutingReview'),
    'the nested statechart renders too: ' + JSON.stringify(diagram.statechart));
  assert.ok(diagram.source.includes('flowchart LR'), 'the fence source stays in the reading view');
  assert.equal(diagram.editorHidden, true, 'the reading view replaced the editor');
  assert.equal(diagram.button, 'Reading view ✓');
  assert.equal(diagram.prose, true, 'the prose around the diagram renders too');

  // Obsidian's move: double-click the diagram to see its code, without
  // leaving the reading view.
  await evaluate(`(() => { const fig = document.querySelector('#docPreview .mmd-fig'); fig.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  assert.equal(await evaluate(`document.querySelector('#docPreview .mmd').classList.contains('show-src')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#docPreview .mmd-src')).display !== 'none'`), true, 'the source becomes visible');

  // Ctrl+Shift+M returns to the editor, and the editor still works.
  await evaluate(`document.querySelector('#docPreview').dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true, bubbles: true }))`);
  assert.equal(await evaluate(`document.querySelector('#docPreview').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#docEditor').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('#docDiagrams').textContent`), 'Reading view');
  assert.equal(await evaluate(`!!document.querySelector('#docEditor .cm-content')`), true, 'the editor came back');
  assert.deepEqual(exceptions, [], 'no uncaught page errors');
});
