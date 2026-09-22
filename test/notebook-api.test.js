'use strict';
// The notebook endpoints are thin passthroughs to rat (`doctor`, `ensure`,
// `run --doc`, `cancel --doc`). These tests boot the real server with a
// throwaway HOME (so rat's state and kernels are isolated too) and check
// the contract each endpoint keeps with the page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// One pi conversation rooted in `cwd`, so the server knows its project.
function writeFixtureSession(agent, cwd) {
  const dir = path.join(agent, 'sessions', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chat.jsonl'), [
    { type: 'session', version: 3, id: 'chat', cwd },
    { type: 'message', id: 'p', parentId: null, timestamp: '2026-09-18T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'message', id: 'answer1', parentId: 'p', timestamp: '2026-09-18T12:00:01Z', message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'hi' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  return 'pi:fixture/chat.jsonl';
}

async function bootServer(t, extraEnv = {}, { sessionCwd = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-api-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const fixtureKey = sessionCwd ? writeFixtureSession(agent, sessionCwd) : null;
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let log = '';
  // rat keeps state under the XDG dirs when they are set: point every one
  // of them into the throwaway home so no real kernel is touched.
  const isolated = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state') };
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...isolated, PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try {
      const rows = await (await fetch(base + '/api/sessions')).json();
      up = !fixtureKey || rows.some(r => r.key === fixtureKey);
    } catch {}
    if (!up) await new Promise(r => setTimeout(r, 100));
    if (server.exitCode != null) break;
  }
  assert.ok(up, 'server did not start:\n' + log);
  t.after(async () => {
    // Stop any kernel this isolated HOME started, then the server.
    spawnSync('rat', ['stop', '--all'], { env: { ...process.env, ...isolated }, stdio: 'ignore' });
    server.kill('SIGTERM');
    await new Promise(r => server.on('exit', r));
    // A stopping kernel may still flush its log; retry the removal.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  return { home, base, post, log: () => log, fixtureKey };
}

function makeProject() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-proj-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "thing"\nversion = "0"\n');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'requirements.txt'), 'mkdocs\n');
  const nb = path.join(repo, 'docs', 'guide.md');
  fs.writeFileSync(nb, '# Guide\n\n```python\nprint(40 + 2)\n```\n');
  return { repo, nb };
}

const haveRat = !spawnSync('rat', ['version']).error;

test('doctor and run-cell resolve the notebook, not its folder', { skip: !haveRat && 'rat is not installed' }, async t => {
  const { post, base } = await bootServer(t);
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const doctor = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(nb))).json();
  assert.equal(doctor.error, undefined, JSON.stringify(doctor));
  assert.equal(doctor.project, repo, 'docs/requirements.txt must not make docs/ the project');
  assert.equal(doctor.project_package, 'thing');
  assert.equal(doctor.python.kernel, 'py@' + path.basename(repo));
  assert.ok(Array.isArray(doctor.checks) && Array.isArray(doctor.actions), 'arrays, never null');
  assert.equal(doctor.ok, false, 'no venv yet');
  assert.ok(doctor.ratPath);

  const bad = await (await fetch(base + '/api/doc/doctor?doc=/nope.md')).json();
  assert.match(bad.error, /doc/);

  const run = await post('/api/doc/run-cell', { lang: 'python', code: 'print(40 + 2)', doc: nb, runId: 'r1' });
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /42/);
  assert.equal(run.runtime, 'py');
  const noDoc = await post('/api/doc/run-cell', { lang: 'python', code: 'print(1)', cwd: repo });
  assert.match(noDoc.error, /doc/);

  const after = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(nb))).json();
  assert.equal(after.python.kernel_running, true, 'the run started the notebook\u0027s kernel');

  const ensure = await post('/api/doc/ensure', { doc: '/nope.md' });
  assert.match(ensure.error, /doc/);
});

test('cancel-run interrupts the kernel through the same notebook resolution', { skip: !haveRat && 'rat is not installed' }, async t => {
  const { post } = await bootServer(t);
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const warm = await post('/api/doc/run-cell', { lang: 'py', code: 'x = 1', doc: nb, runId: 'w' });
  assert.equal(warm.code, 0, warm.out);
  const running = post('/api/doc/run-cell', { lang: 'py', code: 'import time\nfor i in range(60): time.sleep(1)', doc: nb, runId: 'slow' });
  await new Promise(r => setTimeout(r, 1500));
  const cancel = await post('/api/doc/cancel-run', { runId: 'slow' });
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.match(result.out, /cancelled/);
  const alive = await post('/api/doc/run-cell', { lang: 'py', code: 'print(x)', doc: nb, runId: 'after' });
  assert.match(alive.out, /1/, 'variables survive an interrupt');
  const gone = await post('/api/doc/cancel-run', { runId: 'slow' });
  assert.match(gone.error, /no such run/);
});

test('a missing rat is reported once, plainly, not as a per-cell mystery', async t => {
  const { post, base } = await bootServer(t, { RAT_BIN: '/definitely/not/rat', PATH: '/nonexistent' });
  const nb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), 'a.md');
  fs.writeFileSync(nb, '```python\n1\n```\n');
  const doctor = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(nb))).json();
  assert.equal(doctor.ratMissing, true);
  assert.match(doctor.error, /not installed/);
  const run = await post('/api/doc/run-cell', { lang: 'python', code: '1', doc: nb });
  assert.equal(run.missing, true);
  assert.equal(run.code, -1);
  const ensure = await post('/api/doc/ensure', { doc: nb });
  assert.equal(ensure.ratMissing, true);
});

test('notebooks list reads provenance from disk; prerequisites run through rat play', { skip: !haveRat && 'rat is not installed' }, async t => {
  const { repo } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // rat's own ipython/jedi additions would need the network; the chain
  // itself needs no packages.
  const { post, base, fixtureKey } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' }, { sessionCwd: repo });
  const dir = path.join(repo, 'documents', 'notebooks');
  fs.mkdirSync(dir, { recursive: true });
  const first = path.join(dir, '2026-09-18-base.md');
  const second = path.join(dir, '2026-09-18-use.md');
  fs.writeFileSync(first, '---\ntitle: Base\nrat:\n  project: ../..\nsource:\n  conversation: "' + fixtureKey + '"\n  entry: "answer1"\n---\n# Base\n\n```python\nbase = 40\n```\n');
  fs.writeFileSync(second, '---\ntitle: Use\nrat:\n  project: ../..\n  after:\n    - ./2026-09-18-base.md\nsource:\n  conversation: "' + fixtureKey + '"\n  entry: "answer1"\n---\n# Use\n\n```python\nprint(base + 2)\n```\n');
  fs.writeFileSync(path.join(dir, 'other.md'), '---\ntitle: Other\nsource:\n  conversation: "pi:elsewhere/x.jsonl"\n  entry: "z"\n---\n');

  const list = await (await fetch(base + '/api/doc/notebooks?key=' + encodeURIComponent(fixtureKey))).json();
  assert.equal(list.root, repo);
  assert.deepEqual(list.notebooks.map(n => [n.title, n.entry, n.after]), [['Base', 'answer1', []], ['Use', 'answer1', ['./2026-09-18-base.md']]]);
  const missing = await fetch(base + '/api/doc/notebooks?key=nope');
  assert.equal(missing.status, 404);

  const doctor = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(second))).json();
  assert.deepEqual(doctor.after.map(a => [path.basename(a.path), a.played]), [['2026-09-18-base.md', false]]);

  const played = await post('/api/doc/play-prerequisites', { doc: second });
  assert.equal(played.ok, true, JSON.stringify(played));
  assert.deepEqual(played.runs.map(r => [r.role, r.skipped, r.ok]), [['prerequisite', false, true]]);
  const after = await (await fetch(base + '/api/doc/doctor?doc=' + encodeURIComponent(second))).json();
  assert.equal(after.after[0].played, true, 'the kernel remembers the prerequisite');
  const run = await post('/api/doc/run-cell', { lang: 'python', code: 'print(base + 2)', doc: second, runId: 'r' });
  assert.match(run.out, /42/, 'state from the prerequisite is in the kernel');
  const again = await post('/api/doc/play-prerequisites', { doc: second });
  assert.equal(again.runs[0].skipped, true, 'a second call does not replay');

  const derive = await post('/api/doc/notebook-from-answer', { key: 'nope', entryId: 'x' });
  assert.match(derive.error, /required/);
});

// A streamed run (`rat run --events`): output arrives while the cell runs,
// input prompts are answered from the page, and a page that goes away
// does not leave the kernel waiting on nobody.
const ratBin = process.env.RAT_BIN || 'rat';
const ratStreams = haveRat && /--events\b/.test(String(spawnSync(ratBin, ['run', '--help'], { encoding: 'utf8' }).stdout || ''));

async function streamRun(base, body, onEvent) {
  const res = await fetch(base + '/api/doc/run-cell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal: body.signal });
  assert.match(res.headers.get('content-type'), /ndjson/);
  const reader = res.body.getReader(), dec = new TextDecoder(), events = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      events.push(ev);
      await onEvent?.(ev, events);
    }
  }
  return events;
}

test('a streamed run relays output as it comes and takes answers from the page', { skip: !ratStreams && 'this rat does not stream runs (rat run --events)' }, async t => {
  const { post, base } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const code = 'import getpass, time\nprint("step 1", flush=True)\ntime.sleep(0.5)\nname = input("Your name: ")\npw = getpass.getpass("Password: ")\nprint("hello", name, len(pw))';
  const t0 = Date.now();
  let firstOutputAt = null;
  const events = await streamRun(base, { lang: 'python', code, doc: nb, runId: 's1' }, async ev => {
    if (ev.type === 'output' && firstOutputAt == null) firstOutputAt = Date.now() - t0;
    if (ev.type === 'input_request') {
      const r = await post('/api/doc/run-input', { runId: 's1', text: ev.secret ? 'hunter2' : 'Alice' });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
  });
  const kinds = events.map(e => e.type);
  const asks = events.filter(e => e.type === 'input_request');
  assert.deepEqual(asks.map(a => [a.prompt, a.secret]), [['Your name: ', false], ['Password: ', true]]);
  assert.equal(kinds.at(-1), 'done');
  const done = events.at(-1);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /hello Alice 7/);
  assert.doesNotMatch(JSON.stringify(events), /hunter2/, 'the secret never travels back to the page');
  assert.ok(firstOutputAt < done.ms, 'output arrived before the run ended');

  const none = await post('/api/doc/run-input', { runId: 'nope', text: 'x' });
  assert.match(none.error, /no such run/);
});

test('an answer is refused when nothing waits, and a page that leaves cancels its prompt', { skip: !ratStreams && 'this rat does not stream runs (rat run --events)' }, async t => {
  const { post, base } = await bootServer(t, { RAT_NOTEBOOK_REQUIREMENTS: '' });
  const { repo, nb } = makeProject();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const warm = await post('/api/doc/run-cell', { lang: 'py', code: 'kept = 7', doc: nb, runId: 'w' });
  assert.equal(warm.code, 0, warm.out);

  // Not waiting yet: the answer is refused, not queued for a later prompt.
  await streamRun(base, { lang: 'py', code: 'import time\nprint("busy", flush=True)\ntime.sleep(1)', doc: nb, runId: 'b' }, async ev => {
    if (ev.type === 'output') {
      const early = await post('/api/doc/run-input', { runId: 'b', text: 'too soon' });
      assert.equal(early.error, 'the program is not waiting for input');
    }
  });

  // The page goes away while the program waits: rat's stdin closes, the
  // prompt is cancelled, the kernel lives on with its variables.
  const ctrl = new AbortController();
  await streamRun(base, { lang: 'py', code: 'input("anyone? ")', doc: nb, runId: 'gone', signal: ctrl.signal }, ev => {
    if (ev.type === 'input_request') ctrl.abort();
  }).catch(e => assert.equal(e.name, 'AbortError'));
  let after;
  for (let i = 0; i < 50; i++) {
    after = await post('/api/doc/run-cell', { lang: 'py', code: 'print(kept)', doc: nb, runId: 'a' + i });
    if (after.code === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /^7$/m, 'the kernel kept its variables');
});
