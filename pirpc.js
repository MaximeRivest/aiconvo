// pi RPC bridge worker.
// Session operations for pi run through pi's OWN runtime, not through hand
// surgery on JSONL: a short-lived `pi --mode rpc` process bound to the target
// file. `--no-extensions` keeps global extensions (modes.ts) from appending
// entries to the session; `-e` loads only the aiconvo bridge.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PI_BRIDGE_PATH = path.join(__dirname, 'aiconvo-bridge.ts');

// One JSONL RPC conversation with a transient pi process. `run` gets a
// `request` helper (send one command, await its matched response). The
// process is killed when `run` settles, so pi's ownership of the session
// file starts and ends inside the caller's lock window.
// target: { sessionPath, cwd, extraArgs? }
function piRpcOperation(target, run, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('pi', [
      '--mode', 'rpc', '--no-extensions', '-e', PI_BRIDGE_PATH,
      '--session', target.sessionPath, ...(target.extraArgs || []),
    ], { cwd: target.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', buffer = '', done = false;
    const waiters = [];
    const tail = () => stderr ? ' pi said: ' + stderr.trim().slice(-400) : '';
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The pi session operation timed out.' + tail())), timeoutMs);
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => finish(new Error('Could not start pi: ' + err.message)));
    child.on('exit', code => { if (!done) finish(new Error('pi exited early (code ' + code + ').' + tail())); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      // Strict JSONL framing: split on \n only. pi RPC forbids line readers
      // that also split on U+2028/U+2029 (Node readline does).
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'extension_error') {
          return finish(new Error('pi bridge error: ' + (event.error || 'unknown')));
        }
        const i = waiters.findIndex(w => w.test(event));
        if (i >= 0) waiters.splice(i, 1)[0].resolve(event);
      }
    });
    const request = cmd => {
      const id = crypto.randomUUID();
      const matched = new Promise(res => waiters.push({ test: e => e.type === 'response' && e.id === id, resolve: res }));
      child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
      return matched.then(response => {
        if (!response.success) throw new Error(response.error || cmd.type + ' failed' + tail());
        return response;
      });
    };
    Promise.resolve().then(() => run(request)).then(v => finish(null, v), finish);
  });
}

// Verify the bridge command is registered BEFORE sending it as a prompt.
// An unregistered command would go to the model as a real prompt: it would
// cost money and pollute the session we are operating on.
async function piBridgeHandshake(request) {
  const commands = await request({ type: 'get_commands' });
  const names = ((commands.data || {}).commands || []).map(c => String(c.name || '').replace(/^\//, ''));
  if (!names.includes('aiconvo-fork-at')) {
    throw new Error('The aiconvo bridge extension did not load; refusing to send bridge commands.');
  }
}

async function piSessionFileOf(request) {
  const state = await request({ type: 'get_state' });
  return {
    file: state.data && state.data.sessionFile || null,
    sessionId: state.data && state.data.sessionId || null,
  };
}

// Fork THROUGH a node (the fork keeps the node), via the bridge extension:
// ctx.fork(entryId, { position: "at" }) → SessionManager.createBranchedSession.
async function piForkAt(target, nodeId) {
  return piRpcOperation(target, async request => {
    await piBridgeHandshake(request);
    const before = await piSessionFileOf(request);
    await request({ type: 'prompt', message: '/aiconvo-fork-at ' + nodeId });
    // The prompt response only means "accepted". Completion is observed as
    // pi's runtime replacing the active session with the new fork file.
    const deadline = Date.now() + 30000;
    for (;;) {
      const now = await piSessionFileOf(request);
      if (now.file && now.file !== before.file) return now;
      if (Date.now() > deadline) throw new Error('The fork did not complete.');
      await new Promise(r => setTimeout(r, 150));
    }
  });
}

// Fork BEFORE a user message (pi's native RPC fork). The new session stops
// before that message; pi returns its text so the UI can prefill the composer
// for an edit-and-resubmit flow.
async function piForkBefore(target, nodeId) {
  return piRpcOperation(target, async request => {
    const before = await piSessionFileOf(request);
    const forked = await request({ type: 'fork', entryId: nodeId });
    if (forked.data && forked.data.cancelled) throw new Error('The fork was cancelled.');
    const now = await piSessionFileOf(request);
    if (!now.file || now.file === before.file) throw new Error('The fork did not complete.');
    return { ...now, text: (forked.data && forked.data.text) || '' };
  });
}

module.exports = { piRpcOperation, piForkAt, piForkBefore };
