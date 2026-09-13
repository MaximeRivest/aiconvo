'use strict';
// Regression test: esc() output is interpolated into double-quoted HTML
// attributes (data-reader-path, option value, title). Production esc escaped
// only & < > for the app's whole life, so any token containing a double quote
// — every JSON.stringify token does — terminated its attribute at the first
// quote. The reader's "Saved continuation · read what followed" buttons then
// carried data-reader-path="{" and their click handlers died on JSON.parse:
// a silent dead button that reads as "stuck".
// The reader test fixture stubs esc WITH quote escaping, which is why the
// suite never caught this. This test runs the REAL production esc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');

// ---- contract of the production esc, straight from app.html ----
test('production esc() escapes quotes (attribute-safe)', () => {
  const line = app.match(/^const esc = .*$/m);
  assert.ok(line, 'esc definition not found in app.html');
  assert.match(line[0], /&quot;/, 'esc() no longer escapes double quotes — attribute embedding breaks');
  const esc = new Function(line[0].replace('const esc =', 'return') + ';')();
  assert.equal(esc('<a & b " c'), '&lt;a &amp; b &quot; c');
  assert.equal(esc('&amp;'), '&amp;amp;'); // & first: never double-decode
});

// ---- the exact production failure, through a real HTML parser ----
// Uses the same embedding pattern as branchPointHtml()/answerGroupHtml()
// (conversation-reader.js) and the continue/fork buttons (app.html).
test('JSON tokens in attributes survive the HTML round-trip', async () => {
  const line = app.match(/^const esc = .*$/m);
  const esc = new Function(line[0].replace('const esc =', 'return') + ';')();
  const token = JSON.stringify({ key: 'pi:--home-tryinget-Documents-Obsidian--/2026-09-09T14-59-18-854Z_x.jsonl', id: '4d63aacb' });
  const html = `<!doctype html><meta charset="utf-8"><body><div id="host"></div><script>
    const esc = ${esc.toString()};
    document.getElementById('host').innerHTML =
      '<details class="flow-paths"><div>' +
      '<button class="flow-path" data-reader-path="' + esc(${JSON.stringify(token)}) + '" data-at="50658cba">Work / interrupted path</button>' +
      '<select><option value="' + esc(${JSON.stringify(token)}) + '">pi conversation</option></select>' +
      '</div></details>';
  <\/script></body>`;
  assert.ok(token.includes('"'), 'token must contain quotes to exercise the bug');

  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconvo-attr-'));
  const browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + dir, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = ''; const timer = setTimeout(() => reject(Error(stderr)), 10000);
      browser.stderr.on('data', b => { stderr += b; const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
      browser.on('error', reject);
    });
    const ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const pending = new Map();
    ws.onmessage = event => { const msg = JSON.parse(event.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
    const send = (method, params = {}, sessionId) => new Promise(resolve => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId })); });
    const target = await send('Target.createTarget', { url: 'http://127.0.0.1:' + server.address().port });
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
    const sid = attached.result.sessionId;
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      assert.ok(!response.result?.exceptionDetails, JSON.stringify(response.result));
      return response.result?.result?.value;
    };
    for (let i = 0; i < 100 && !await evaluate('document.querySelector(".flow-path")'); i++) await new Promise(r => setTimeout(r, 30));
    // The button token must parse back to the exact object.
    const parsed = await evaluate(`(() => {
      const b = document.querySelector('.flow-path');
      const opt = document.querySelector('option');
      return { button: b.dataset.readerPath, option: opt.value, at: b.dataset.at };
    })()`);
    assert.equal(parsed.at, '50658cba', 'plain (quote-free) attribute must keep working');
    assert.deepEqual(JSON.parse(parsed.button), JSON.parse(token), 'button data-reader-path was truncated');
    assert.deepEqual(JSON.parse(parsed.option), JSON.parse(token), 'option value was truncated');
    await send('Browser.close');
    await new Promise(resolve => browser.exitCode != null ? resolve() : browser.once('exit', resolve));
  } finally {
    server.close();
    try { browser.kill('SIGKILL'); } catch {}
  }
});
