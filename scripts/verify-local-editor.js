#!/usr/bin/env node
'use strict';
// Read-only smoke test of the installed localhost service. Never saves or runs cells.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const file = path.resolve(process.argv[2] || 'README.md');
  const before = fs.readFileSync(file, 'utf8');
  const base = 'http://127.0.0.1:7433';
  const response = await fetch(base + '/api/file/read?' + new URLSearchParams({ path: file }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, before);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconvo-editor-check-'));
  const browser = spawn('chromium', ['--headless', '--disable-gpu', '--disable-background-networking',
    '--disable-sync', '--no-first-run', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise(resolve => browser.once('exit', resolve));
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Browser startup timed out')), 15000);
      browser.once('error', error => { clearTimeout(timer); reject(error); });
      browser.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const call = ++id;
      const timer = setTimeout(() => { pending.delete(call); reject(Error(method + ' timed out')); }, 15000);
      pending.set(call, message => { clearTimeout(timer); message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result); });
      ws.send(JSON.stringify({ id: call, method, params, sessionId }));
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Page.navigate', { url: base + '/#file&focus&path=' + encodeURIComponent(file) }, sessionId);
    let mounted = false;
    for (let i = 0; i < 100; i++) {
      const result = await send('Runtime.evaluate', { expression: 'typeof docState !== "undefined" && !!docState?.editor && !!docState?.focused', returnByValue: true }, sessionId);
      if (result.result?.value === true) { mounted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(mounted, 'MRMD focused editor did not mount');
    const content = await send('Runtime.evaluate', { expression: 'docState.editor.getContent()', returnByValue: true }, sessionId);
    assert.equal(content.result.value, before);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'Opening changed the source file');
    console.log('PASS: live HTTP read, focused MRMD mounted, exact report content, source unchanged');
  } finally {
    ws?.close();
    browser.kill('SIGTERM');
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
