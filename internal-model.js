'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildPiArgs, normalizeSettings } = require('./settings');
const { decodeImage, LIMITS } = require('./memory-images');

async function runInternalModel(input, prompt, options) {
  if (process.platform !== 'linux') throw new Error('Model-only memory requires Linux process-group exit verification');
  const settings = normalizeSettings(options.settings);
  if (!input || typeof input.text !== 'string' || (input.images !== undefined && !Array.isArray(input.images))) throw new Error('Invalid internal model input');
  if ((input.images || []).length > LIMITS.callImages) throw new Error('Internal model image count exceeds budget');
  for (const image of input.images || []) decodeImage(image);
  if (settings.usePiDefault || !settings.provider || !settings.model) throw new Error('Multimodal memory requires an explicit configured provider and model');
  // Reuse only the existing pure package locator, never the warm engine.
  const packageDir = options.packageDir || process.env.PI_CODING_AGENT_PACKAGE || require('./pisdk-runtime').piPackageDir();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiconvo-model-'));
  await fs.chmod(root, 0o700);
  const agent = path.join(root, 'agent');
  let retain = false;
  try {
    await fs.mkdir(agent, { mode: 0o700 });
    const sourceAgent = options.agentDir || process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
    // Copy only the selected provider's definitions/auth into a private
    // temporary directory. No ambient settings/resources or credential writes
    // reach the configured agent directory; OAuth refreshes are ephemeral.
    for (const name of ['models.json', 'auth.json']) {
      let raw = {};
      try { raw = JSON.parse(await fs.readFile(path.join(sourceAgent, name), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const entries = name === 'models.json' ? raw.providers || {} : raw;
      const selected = Object.hasOwn(entries, settings.provider) ? { [settings.provider]: entries[settings.provider] } : {};
      await fs.writeFile(path.join(agent, name), JSON.stringify(name === 'models.json' ? { providers: selected } : selected), { mode: 0o600 });
    }
    const env = { ...process.env, ...(options.env || {}) };
    for (const key of Object.keys(env)) if (key.startsWith('PI_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
    Object.assign(env, { PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, PI_OFFLINE: '1', JITI_FS_CACHE: 'false' });
    const args = buildPiArgs(settings, options), extensions = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '-e') {
      const entry = await fs.realpath(args[++i]);
      if (!(await fs.stat(entry)).isFile()) throw new Error('Trusted extension must be a readable regular entrypoint');
      await fs.access(entry, require('node:fs').constants.R_OK);
      if (!extensions.includes(entry)) extensions.push(entry);
    }
    return await workerOnce({ ...options, input: { text: input.text, images: input.images || [] }, prompt,
      settings, extensions, packageDir, agentDir: agent, env, cwd: root });
  } catch (e) { retain = !!e.retainTemporaryState; if (retain) e.temporaryDirectory = root; throw e; }
  finally { if (!retain) await fs.rm(root, { recursive: true, force: true }); }
}

function workerOnce({ input, prompt, settings, extensions, packageDir, agentDir, env, cwd,
  check = () => {}, onChunk, signal, timeoutMs = 1800000, terminationGraceMs = 250,
  workerFile = path.join(__dirname, 'internal-model-worker.js'), spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    let child, stderr = '', result = null, failure = null, stopped = false, invoked = false, size = 0, killTimer, killed = false;
    const abort = () => stop(new Error('Internal model cancelled; no automatic replay'));
    const stop = (error, message) => {
      if (stopped) return;
      stopped = true; failure = error; result = message;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') failure = e; }
      killTimer = setTimeout(() => {
        // A live direct child is our group anchor. Never signal a retired PGID.
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { process.kill(-child.pid, 'SIGKILL'); killed = true; }
        catch (e) { if (e.code !== 'ESRCH') failure = e; }
      }, terminationGraceMs);
    };
    const timer = setTimeout(() => stop(new Error('Internal model timed out; no automatic replay')), timeoutMs);
    try {
      child = spawnProcess(process.execPath, [path.join(__dirname, 'internal-model-supervisor.js'), workerFile], {
        cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (e) { clearTimeout(timer); reject(e); return; }
    const send = packet => child.send(packet, e => { if (e && !stopped) stop(e); });
    for (const output of [child.stdout, child.stderr]) {
      output.setEncoding('utf8'); output.on('data', data => { stderr = (stderr + data).slice(-4000); });
    }
    child.on('message', packet => {
      if (stopped) return;
      size += Buffer.byteLength(JSON.stringify(packet));
      if (size > 64 * 1024 * 1024) return stop(new Error('Internal model output exceeds budget'));
      try {
        if (packet.type === 'ready' && !invoked) {
          check(); invoked = true; send({ type: 'invoke' });
        } else if (packet.type === 'chunk') {
          if (onChunk) onChunk(packet.text);
        } else if (packet.type === 'result' && invoked) {
          check(); stop(null, packet.message);
        } else if (packet.type === 'error') stop(new Error(packet.error));
        else stop(new Error('Invalid internal model protocol'));
      } catch (e) { stop(e); }
    });
    child.once('error', e => { failure = e; });
    child.once('close', async () => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (child.pid) {
        try { await require('./model-process-group').waitGroupExit(child.pid); }
        catch (e) { failure = e; failure.retainTemporaryState = true; }
      }
      if (invoked && !killed) {
        failure = new Error('Supervisor exited unexpectedly; whole-group cleanup not established');
        failure.retainTemporaryState = true;
      }
      if (failure) reject(failure);
      else if (!stopped || !result) reject(new Error('Internal model exited before completion' + (stderr ? ': ' + stderr : '')));
      else resolve(result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) { abort(); return; }
      check();
      send({ type: 'prepare', input, prompt, settings, extensions, packageDir, agentDir, timeoutMs });
    } catch (e) { stop(e); }
  });
}
module.exports = { runInternalModel, workerOnce };
