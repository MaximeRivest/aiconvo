// Pi SDK engine, hosted by pisdk-worker.js. Never create sessions in the host.
// Utility loading and native file forks remain available without a session.
// Each process owns its SDK globals, extensions, environment, and TUI views.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { installCustomPromptPreparation, waitForCustomTurns } = require('./pisdk-custom.js');

const PI_TESTED_VERSION = '0.84.1';
const WARM_IDLE_MS = 5 * 60 * 1000;
const DIALOG_MAX_MS = 30 * 60 * 1000;

// ---- SDK loading ---------------------------------------------------------

// pi's bin link target has moved between releases (dist/cli.js, later
// dist/bundle/cli.js). Walk up from the resolved path until the package
// root — the directory whose dist/index.js exists — appears.
function packageRootFrom(start) {
  let dir = path.dirname(fs.realpathSync(start));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'dist', 'index.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function piPackageDir() {
  const home = require('os').homedir();
  const candidates = [];
  try { candidates.push(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()); } catch {}
  // Every nvm node, newest first: the service node and the interactive node
  // may differ, and a node upgrade moves the global install directory.
  try {
    const base = path.join(home, '.nvm', 'versions', 'node');
    const vnum = v => v.replace(/^v/, '').split('.').map(n => Number(n) || 0);
    for (const v of fs.readdirSync(base).sort((a, b) => {
      const x = vnum(a), y = vnum(b);
      return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
    })) {
      candidates.push(path.join(base, v, 'bin', 'pi'));
      candidates.push(path.join(base, v, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'));
    }
  } catch {}
  candidates.push('/usr/local/bin/pi', '/usr/bin/pi');
  for (const c of candidates) {
    // A Windows npm shim through WSL interop is never the Linux package.
    if (!c || c.startsWith('/mnt/')) continue;
    try {
      const root = packageRootFrom(c);
      if (root) return root;
    } catch {}
  }
  throw new Error('cannot locate the pi package (is pi installed?)');
}

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const dir = piPackageDir();
      const SDK = await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href);
      let theme;
      try {
        const themeMod = await import(pathToFileURL(path.join(dir, 'dist', 'modes', 'interactive', 'theme', 'theme.js')).href);
        // Extensions read ctx.ui.theme and some (prompt modes) fail hard
        // without an initialized theme. Custom views render into the light
        // aiconvo page, so default to pi's light theme — dark-terminal
        // colors painted navy stripes on paper. settings.json piTheme
        // overrides. No watcher: this is a server.
        let themeName = 'light';
        try {
          const s = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config', 'aiconvo', 'settings.json'), 'utf8'));
          if (s && typeof s.piTheme === 'string' && s.piTheme) themeName = s.piTheme;
        } catch {}
        try { themeMod.initTheme(themeName, false); }
        catch { try { themeMod.initTheme(undefined, false); } catch {} }
        theme = themeMod.theme;
      } catch {}
      if (SDK.VERSION && SDK.VERSION !== PI_TESTED_VERSION) {
        console.error('[pisdk] pi v' + SDK.VERSION + ' differs from the tested v' + PI_TESTED_VERSION + '. Re-verify the embed after pi upgrades.');
      }
      return { SDK, dir, theme, version: SDK.VERSION };
    })();
    sdkPromise.catch(() => { sdkPromise = null; });
  }
  return sdkPromise;
}

function sdkInfo() {
  return sdkPromise ? sdkPromise.then(l => ({ version: l.version, dir: l.dir, tested: PI_TESTED_VERSION })) : null;
}

// Injection keeps lifecycle tests independent of installed providers and user files.
function createRuntimeEngine(hooks = {}) {
const getSdk = hooks.loadSdk || loadSdk;

// Parse the CLI-style extraArgs the server hands both engines, exactly the
// way pi's own arg parser would: -e paths, --name, --append-system-prompt,
// and every unrecognized --flag becomes an extension flag (this carries
// --prompt-mode into the modes extension, matching pi's unknownFlags map).
function parseExtraArgs(extraArgs) {
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const out = { extensionPaths: [], name: null, appendSystemPrompt: undefined, flags: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' && args[i + 1]) { out.extensionPaths.push(args[++i]); continue; }
    if (a === '--name' && args[i + 1]) { out.name = args[++i]; continue; }
    if (a === '--append-system-prompt' && args[i + 1]) { out.appendSystemPrompt = args[++i]; continue; }
    if (a === '--no-session') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { out.flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-') && !next.startsWith('@')) { out.flags.set(a.slice(2), next); i++; }
      else out.flags.set(a.slice(2), true);
    }
  }
  return out;
}

// ---- session pool --------------------------------------------------------

const sdkSessions = new Map(); // resolved session file → S
const sdkQueues = new Map();   // resolved session file → promise chain
const creating = new Map();
const stopping = new Map();
let disposed = false;

function sessionBusy(S) {
  return !!(S.busy || S.preparing || S.session.isStreaming || S.session.isIdle === false);
}
function stateOf(S) {
  const model = S.session.model;
  return { sessionPath: S.file, cwd: S.session.sessionManager.getCwd(),
    model: model ? model.provider + '/' + model.id : S.model,
    busy: sessionBusy(S) || S.pendingUi.size > 0 || S.customViews.size > 0,
    uiAutoCancelled: S.uiAutoCancelled, pid: process.pid, alive: !S.stopped, engine: 'sdk' };
}
function publishState(S) {
  if (hooks.onState) hooks.onState(stateOf(S));
}


function queueOn(key, work) {
  const prev = sdkQueues.get(key) || Promise.resolve();
  const run = prev.then(work, work);
  const tail = run.catch(() => {});
  sdkQueues.set(key, tail);
  tail.then(() => { if (sdkQueues.get(key) === tail) sdkQueues.delete(key); });
  return run;
}

function fileSigOf(file) {
  if (hooks.fileSig) return hooks.fileSig(file);
  try {
    const s = fs.statSync(file);
    return s.ino + ':' + s.size + ':' + s.mtimeMs;
  } catch { return null; }
}

function armIdle(S) {
  clearTimeout(S.idleTimer);
  if (S.stopped) return;
  publishState(S);
  S.idleTimer = setTimeout(() => {
    // Retry delays, quiet tools, and extension-started turns are not idle.
    if (sessionBusy(S) || S.pendingUi.size || S.customViews.size) { armIdle(S); return; }
    stopWarmSession(S.file);
    if (hooks.onIdleStop) hooks.onIdleStop();
  }, hooks.idleMs ?? WARM_IDLE_MS);
  S.idleTimer.unref?.();
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  return '';
}

// The extension UI context: aiconvo's web face. Dialogs park in S.pendingUi
// until /api/run/ui-response answers them; everything else is forwarded as
// RPC-shaped extension_ui_request events, which server.js already renders.
function makeUiContext(S, loaded) {
  let panelBgSgr; // lazily resolved theme customMessageBg SGR params (undefined = not probed yet)
  const emit = req => S.emit({ type: 'extension_ui_request', id: crypto.randomUUID(), ...req });
  const dialog = (opts, defaultValue, request, parse) => {
    if (opts && opts.signal && opts.signal.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      let timer = null;
      let onAbort = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && opts && opts.signal) opts.signal.removeEventListener('abort', onAbort);
        S.pendingUi.delete(id);
        if (hooks.onUiClosed) hooks.onUiClosed(id);
        publishState(S);
      };
      const finish = resp => { cleanup(); resolve(parse(resp)); };
      onAbort = () => { cleanup(); resolve(defaultValue); };
      if (opts && opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        S.uiAutoCancelled++;
        cleanup(); resolve(defaultValue);
      }, opts && opts.timeout || DIALOG_MAX_MS);
      S.pendingUi.set(id, {
        resolve: finish,
        cancel: () => finish({ cancelled: true }),
      });
      S.emit({ type: 'extension_ui_request', id, ...request });
    });
  };
  return {
    select: (title, options, opts) => dialog(opts, undefined,
      { method: 'select', title, options, timeout: opts && opts.timeout },
      r => r.cancelled ? undefined : r.value),
    confirm: (title, message, opts) => dialog(opts, false,
      { method: 'confirm', title, message, timeout: opts && opts.timeout },
      r => r.cancelled ? false : !!r.confirmed),
    input: (title, placeholder, opts) => dialog(opts, undefined,
      { method: 'input', title, placeholder, timeout: opts && opts.timeout },
      r => r.cancelled ? undefined : r.value),
    editor: (title, prefill) => dialog(undefined, undefined,
      { method: 'editor', title, prefill },
      r => r.cancelled ? undefined : r.value),
    notify(message, type) { emit({ method: 'notify', message, notifyType: type }); },
    setStatus(key, text) { emit({ method: 'setStatus', statusKey: key, statusText: text }); },
    setWidget(key, content, options) {
      if (content === undefined || Array.isArray(content)) {
        emit({ method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options && options.placement });
      }
    },
    setTitle(title) { emit({ method: 'setTitle', title }); },
    setEditorText(text) { emit({ method: 'set_editor_text', text }); },
    pasteToEditor(text) { this.setEditorText(text); },
    getEditorText() { return S.editorText || ''; },
    onTerminalInput() { return () => {}; },
    setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setHiddenThinkingLabel() {}, setFooter() {}, setHeader() {},
    // TUI custom views, hosted headlessly. A pi-tui Component is only
    // render(width) → styled lines plus handleInput(rawKeyData): run it
    // against a virtual screen, stream the lines to the browser, and feed
    // browser keys back. tui.requestRender is the one TUI method real
    // extensions call (verified across modes/cell/ensemble).
    custom(factory, _options) {
      const id = crypto.randomUUID();
      // The browser panel is sized to exactly 100ch (font autoscales on
      // narrow screens), so no horizontal scrollbar appears.
      const VIEW_WIDTH = 100;
      // The extension's panel fill (theme customMessageBg, a dark navy) looks
      // harsh inside the web modal. Send its raw SGR params along so the
      // browser can render that exact background as transparent.
      if (panelBgSgr === undefined) {
        panelBgSgr = null;
        try {
          const probe = loaded && loaded.theme && loaded.theme.bg ? loaded.theme.bg('customMessageBg', 'X') : '';
          const m = /\x1b\[([0-9;]*)m/.exec(probe);
          if (m && /^(48|10[0-7]|4[0-7])(;|$)/.test(m[1])) panelBgSgr = m[1];
        } catch {}
      }
      return new Promise(resolve => {
        let component = null;
        let closed = false;
        let renderTimer = null;
        const finish = result => {
          if (closed) return;
          closed = true;
          clearTimeout(renderTimer);
          try { if (component && component.dispose) component.dispose(); } catch {}
          S.customViews.delete(id);
          S.emit({ type: 'extension_ui_request', id, method: 'custom_end' });
          resolve(result);
        };
        const pushRender = () => {
          if (closed) return;
          clearTimeout(renderTimer);
          renderTimer = setTimeout(() => {
            if (closed || !component) return;
            let lines;
            try { lines = component.render(VIEW_WIDTH) || []; }
            catch (e) { lines = ['render error: ' + (e && e.message)]; }
            S.emit({ type: 'extension_ui_request', id, method: 'custom_render', lines: lines.slice(0, 200), bgSgr: panelBgSgr });
          }, 16);
        };
        const fakeTui = {
          requestRender: pushRender,
          terminal: { columns: VIEW_WIDTH, rows: 45 },
          width: VIEW_WIDTH,
        };
        const keybindingsStub = new Proxy({}, { get: () => () => undefined });
        // Register before awaiting the factory so abort/dispose can cancel it.
        S.customViews.set(id, { cancel: () => finish(undefined), input: () => {} });
        Promise.resolve()
          .then(() => factory(fakeTui, loaded.theme, keybindingsStub, finish))
          .then(c => {
            if (closed) { try { if (c && c.dispose) c.dispose(); } catch {} return; }
            component = c;
            S.customViews.set(id, {
              input: data => {
                if (closed || !component) return;
                try { if (component.handleInput) component.handleInput(data); } catch {}
                pushRender();
              },
              cancel: () => finish(undefined),
            });
            pushRender();
          })
          .catch(e => {
            S.emit({ type: 'extension_error', extensionPath: '(custom view)', event: 'custom', error: String(e && e.message || e) });
            finish(undefined);
          });
      });
    },
    addAutocompleteProvider() {}, setEditorComponent() {},
    getEditorComponent() { return undefined; },
    get theme() { return loaded.theme; },
    getAllThemes() { return []; },
    getTheme() { return undefined; },
    setTheme() { return { success: false, error: 'Theme switching is not supported in the web face yet' }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
  };
}

async function bindS(S, loaded) {
  const session = S.runtime.session;
  S.session = session;
  const previousFile = S.file;
  S.file = path.resolve(session.sessionFile || S.file);
  if (previousFile !== S.file && sdkSessions.get(previousFile) === S) sdkSessions.delete(previousFile);
  sdkSessions.set(S.file, S);
  if (S.unsub) S.unsub();
  // Subscribe before bindExtensions: session_start hooks can start turns or dialogs.
  S.unsub = session.subscribe(ev => {
    S.lastEventAt = Date.now();
    S.emit(ev);
    if (ev.type === 'agent_settled') {
      // An extension can start a fresh turn inside agent_settled.
      queueMicrotask(() => {
        if (!sessionBusy(S)) S.fileSig = fileSigOf(S.file);
        armIdle(S);
      });
    }
  });
  installCustomPromptPreparation(session, {
    begin() {
      const epoch = S.abortEpoch || 0;
      S.preparing = (S.preparing || 0) + 1;
      S.emit({ type: 'custom_turn_preflight' });
      publishState(S);
      return () => S.stopped || (S.abortEpoch || 0) !== epoch;
    },
    end() {
      S.preparing = Math.max(0, (S.preparing || 0) - 1);
      publishState(S);
      if (!S.stopped) armIdle(S);
    },
  });
  publishState(S);
  await session.bindExtensions({
    uiContext: makeUiContext(S, loaded),
    mode: 'rpc', // extensions see the documented headless surface
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async options => S.runtime.newSession(options),
      fork: async (entryId, forkOptions) => {
        const r = await S.runtime.fork(entryId, forkOptions);
        return { cancelled: r.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const r = await session.navigateTree(targetId, options || {});
        return { cancelled: r.cancelled };
      },
      switchSession: async (p, options) => S.runtime.switchSession(p, options),
      reload: async () => { await session.reload(); },
    },
    shutdownHandler: () => { if (hooks.onShutdown) hooks.onShutdown(); },
    onError: err => S.emit({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error }),
  });
  S.fileSig = fileSigOf(S.file);
  publishState(S);
}

async function createS(target) {
  const loaded = await getSdk();
  if (disposed) throw new Error('Pi runtime is stopped');
  const { SDK } = loaded;
  const agentDir = SDK.getAgentDir();
  const sm = target.sessionPath
    ? SDK.SessionManager.open(path.resolve(target.sessionPath))
    : SDK.SessionManager.create(target.cwd);
  const cwd = sm.getCwd() || target.cwd;
  const trustStore = new SDK.ProjectTrustStore(agentDir);
  const parsed = parseExtraArgs(target.extraArgs);
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const projectTrusted = !SDK.hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
    const settingsManager = SDK.SettingsManager.create(cwd, agentDir, { projectTrusted });
    const services = await SDK.createAgentSessionServices({
      cwd, agentDir, settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15000),
      extensionFlagValues: parsed.flags.size ? parsed.flags : undefined,
      resourceLoaderOptions: (parsed.extensionPaths.length || parsed.appendSystemPrompt) ? {
        additionalExtensionPaths: parsed.extensionPaths.length ? parsed.extensionPaths : undefined,
        // pi's resource loader treats appendSystemPromptSource as an array of
        // paths/texts (each resolved through resolvePromptInput).
        appendSystemPrompt: parsed.appendSystemPrompt ? [parsed.appendSystemPrompt] : undefined,
      } : undefined,
    });
    return {
      ...(await SDK.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await SDK.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: sm });
  if (disposed) { await runtime.dispose(); throw new Error('Pi runtime is stopped'); }
  const file = runtime.session.sessionFile || sm.getSessionFile();
  const S = {
    file: path.resolve(file),
    runtime, session: runtime.session,
    busy: false, idleTimer: null, model: null,
    fileSig: fileSigOf(file),
    pendingUi: new Map(),
    customViews: new Map(),
    lastEventAt: Date.now(),
    uiAutoCancelled: 0, stopped: false,
    onEvent: null,
    editorText: '',
    unsub: null,
    emit(ev) {
      if (hooks.onEvent) hooks.onEvent(ev, stateOf(S));
      if (S.onEvent) S.onEvent(ev);
    },
  };
  runtime.setRebindSession(async () => { await bindS(S, loaded); });
  try { await bindS(S, loaded); }
  catch (error) { stopWarmSession(S.file); throw error; }
  if (disposed || S.stopped) throw new Error('Pi runtime is stopped');
  if (parsed.name && typeof S.session.setSessionName === 'function') {
    try { S.session.setSessionName(parsed.name); } catch {}
  }
  sdkSessions.set(S.file, S);
  return S;
}

async function ensureS(target) {
  if (disposed) throw new Error('Pi runtime is stopped');
  const key = path.resolve(target.sessionPath);
  if (creating.has(key)) return creating.get(key);
  const work = (async () => {
    const S = sdkSessions.get(key);
    if (S) {
      if (sessionBusy(S) || S.fileSig === fileSigOf(key)) return S;
      stopWarmSession(key);
    }
    if (stopping.has(key)) await stopping.get(key);
    return createS(target);
  })();
  creating.set(key, work);
  try { return await work; }
  finally { if (creating.get(key) === work) creating.delete(key); }
}

// ---- exported surface (mirrors pirpc.js) ---------------------------------

function piHeadlessRun(target, opts = {}) {
  let aborted = false;
  let current = null;
  const key = path.resolve(target.sessionPath);
  const handle = { done: null, uiAutoCancelled: 0, pid: process.pid, engine: 'sdk',
    abort: async () => {
      aborted = true;
      if (current) { current.abortEpoch = (current.abortEpoch || 0) + 1; cancelUi(current); await current.session.abort(); }
    },
    respondUi: (id, response) => respondUi(id, response),
    uiInput: (id, data) => uiInput(id, data),
  };
  const work = async () => {
    if (aborted) throw new Error('Pi run aborted before start');
    const S = current = await ensureS(target);
    if (aborted) { cancelUi(S); throw new Error('Pi run aborted before start'); }
    clearTimeout(S.idleTimer);
    S.busy = true;
    S.onEvent = opts.onEvent || null;
    const beforeCancelled = S.uiAutoCancelled;
    publishState(S);
    try {
      const want = opts.provider && opts.modelId ? opts.provider + '/' + opts.modelId : null;
      if (want && stateOf(S).model !== want) {
        const models = S.session.modelRuntime.getAvailableSnapshot();
        const model = models.find(m => m.provider === opts.provider && m.id === opts.modelId);
        if (!model) throw new Error('Model not found: ' + opts.provider + '/' + opts.modelId);
        await S.session.setModel(model);
        S.model = want;
      }
      if (aborted) throw new Error('Pi run aborted before prompt');
      if (opts.customMessage) {
        const { customType, content, details } = opts.customMessage;
        if (typeof customType !== 'string' || !customType) throw new Error('customMessage.customType is required');
        await S.session.sendCustomMessage({ customType, content, display: true, details },
          { triggerTurn: true, deliverAs: 'followUp' });
      } else {
        await S.session.prompt(opts.message, {
          images: Array.isArray(opts.images) && opts.images.length ? opts.images : undefined,
          source: 'rpc', streamingBehavior: 'followUp',
        });
      }
      // Commands and queued custom messages can return before their turn.
      // Use SDK idle state, not agent_end (which precedes retries/followups).
      await waitForCustomTurns(S.session);
      await S.session.waitForIdle();
      return { uiAutoCancelled: S.uiAutoCancelled - beforeCancelled, pid: process.pid, warm: true, engine: 'sdk' };
    } finally {
      S.busy = false;
      S.onEvent = null;
      if (!sessionBusy(S)) { cancelUi(S); S.fileSig = fileSigOf(S.file); }
      handle.uiAutoCancelled = S.uiAutoCancelled - beforeCancelled;
      current = null;
      if (sdkSessions.get(S.file) === S) armIdle(S);
    }
  };
  handle.done = queueOn(key, work);
  return handle;
}

// Queue into a run that is ALREADY STREAMING (same semantics as typing in
// the TUI while the model works). Resolves at prompt acceptance, not end.
async function piQueuePrompt(target, message, behavior, images) {
  const key = path.resolve(target.sessionPath);
  const S = sdkSessions.get(key);
  if (!S || !S.session.isStreaming) return false;
  return await new Promise((resolve, reject) => {
    S.session.prompt(message, {
      streamingBehavior: behavior || 'followUp',
      images: Array.isArray(images) && images.length ? images : undefined,
      source: 'rpc',
      preflightResult: ok => resolve(!!ok),
    }).catch(e => reject(e));
  });
}

// pi defers writing a branched session that has no assistant message yet;
// aiconvo indexes fork files immediately, so materialize it now. After
// createBranchedSession the manager IS the fork (its header and entries).
function materializeFork(sm, file) {
  if (fs.existsSync(file)) return;
  const lines = [JSON.stringify(sm.getHeader()), ...sm.getEntries().map(e => JSON.stringify(e))];
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// Fork THROUGH a node (the fork keeps the node): pi's own
// SessionManager.createBranchedSession — a file operation, no process.
async function piForkAt(target, nodeId) {
  const { SDK } = await loadSdk();
  const sm = SDK.SessionManager.open(path.resolve(target.sessionPath));
  if (!sm.getEntry(nodeId)) throw new Error('branch point not found in the session file');
  const file = sm.createBranchedSession(nodeId);
  if (!file) throw new Error('The fork did not complete.');
  materializeFork(sm, file);
  return { file, sessionId: SDK.SessionManager.open(file).getSessionId() };
}

// Fork BEFORE a user message: the new session stops before that message;
// its text comes back so the composer can prefill for edit-and-resubmit.
async function piForkBefore(target, nodeId) {
  const { SDK } = await loadSdk();
  const sm = SDK.SessionManager.open(path.resolve(target.sessionPath));
  const entry = sm.getEntry(nodeId);
  if (!entry) throw new Error('branch point not found in the session file');
  const text = entry.message ? textOfContent(entry.message.content) : '';
  if (!entry.parentId) throw new Error('cannot fork before the first message — start a new conversation instead');
  const file = sm.createBranchedSession(entry.parentId);
  if (!file) throw new Error('The fork did not complete.');
  materializeFork(sm, file);
  return { file, sessionId: SDK.SessionManager.open(file).getSessionId(), text };
}

// Set the session model through pi's own runtime (persists a native
// model_change entry, so resumes and branches inherit it).
async function piSetModel(target, provider, modelId) {
  const S = await ensureS(target);
  clearTimeout(S.idleTimer);
  try {
    const models = S.session.modelRuntime.getAvailableSnapshot();
    const model = models.find(m => m.provider === provider && m.id === modelId);
    if (!model) throw new Error('Model not found: ' + provider + '/' + modelId);
    await S.session.setModel(model);
    S.model = provider + '/' + modelId;
  } finally {
    S.fileSig = fileSigOf(S.file);
    armIdle(S);
  }
}

// Set the session's reasoning (thinking) level through pi's own runtime
// (persists a native thinking_level_change entry, so resumes and branches
// inherit it). level 'cycle' steps to the next available level.
async function piSetThinking(target, level) {
  const S = await ensureS(target);
  clearTimeout(S.idleTimer);
  try {
    if (!S.session.supportsThinking()) throw new Error('This model has no reasoning control.');
    if (level === 'cycle') S.session.cycleThinkingLevel();
    else S.session.setThinkingLevel(level);
    return { level: S.session.thinkingLevel, levels: S.session.getAvailableThinkingLevels() };
  } finally {
    S.fileSig = fileSigOf(S.file);
    armIdle(S);
  }
}

// Start a new pi session in cwd and keep it in the pool.
async function piBeginWarm(target) {
  const S = target.sessionPath ? await ensureS(target) : await createS(target);
  // pi buffers a new session in memory until the FIRST assistant reply
  // (SessionManager._persist checks hasAssistant), so a silent start never
  // creates the file and the server aborts with "pi did not write the
  // session file". Force the initial flush: _rewriteFile opens with "w"
  // and later appends key off flushed=true, so this is safe and durable.
  const sm = S.session.sessionManager;
  if (sm && sm.flushed === false && typeof sm._rewriteFile === 'function') {
    sm._rewriteFile();
    sm.flushed = true;
  }
  S.fileSig = fileSigOf(S.file);
  armIdle(S);
  return { file: S.file, sessionId: S.session.sessionId, pid: process.pid, engine: 'sdk' };
}

function cancelUi(S) {
  for (const p of [...S.pendingUi.values()]) { S.uiAutoCancelled++; p.cancel(); }
  for (const v of [...S.customViews.values()]) v.cancel();
}
function respondUi(id, response) {
  for (const S of sdkSessions.values()) {
    const p = S.pendingUi.get(id);
    if (!p) continue;
    if (response && response.cancelled) p.cancel(); else p.resolve(response || {});
    return true;
  }
  return false;
}
function uiInput(id, data) {
  for (const S of sdkSessions.values()) {
    const view = S.customViews.get(id);
    if (!view) continue;
    if (data === null) view.cancel(); else view.input(String(data));
    return true;
  }
  return false;
}
async function abort() {
  await Promise.all([...sdkSessions.values()].map(async S => {
    S.abortEpoch = (S.abortEpoch || 0) + 1;
    cancelUi(S);
    await S.session.abort();
  }));
}
async function waitForIdle() {
  await Promise.all([...sdkSessions.values()].map(async S => { await waitForCustomTurns(S.session); await S.session.waitForIdle(); }));
}
function stopWarmSession(sessionPath) {
  const key = path.resolve(sessionPath);
  const S = sdkSessions.get(key);
  if (!S) return false;
  S.stopped = true;
  clearTimeout(S.idleTimer);
  sdkSessions.delete(key);
  cancelUi(S);
  const done = (async () => {
    // Start abort and extension teardown together: shutdown hooks can release
    // resources that the active turn is waiting for.
    // dispose disconnects SDK event listeners. An abort waiter can then remain
    // unresolved, so teardown completion (not that waiter) owns process exit.
    Promise.resolve().then(() => S.session.abort()).catch(error => {
      if (hooks.onError) hooks.onError(error);
    });
    try { await S.runtime.dispose(); }
    finally { if (S.unsub) S.unsub(); }
  })();
  stopping.set(key, done);
  done.catch(error => { if (hooks.onError) hooks.onError(error); });
  done.finally(() => { if (stopping.get(key) === done) stopping.delete(key); }).catch(() => {});
  return true;
}
async function dispose() {
  disposed = true;
  stopAllWarmSessions();
  await Promise.allSettled([...creating.values()]);
  stopAllWarmSessions();
  await Promise.all([...stopping.values()]);
}

function stopAllWarmSessions() {
  let n = 0;
  for (const key of [...sdkSessions.keys()]) { if (stopWarmSession(key)) n++; }
  return n;
}

function listWarmSessions() {
  const out = [];
  for (const [key, S] of sdkSessions) {
    out.push(stateOf(S));
  }
  return out;
}

// The web composer's current text, for extensions that call getEditorText().
function setEditorTextFor(sessionPath, text) {
  const S = sdkSessions.get(path.resolve(sessionPath));
  if (S) S.editorText = String(text || '');
}

return {
  piForkAt, piForkBefore, piSetModel, piSetThinking, piHeadlessRun, piQueuePrompt, piBeginWarm,
  stopWarmSession, stopAllWarmSessions, listWarmSessions,
  setEditorTextFor, abort, respondUi, uiInput, waitForIdle, dispose,
};
}

// These utilities do not instantiate sessions or load extensions in the host.
const utilities = createRuntimeEngine();
module.exports = { createRuntimeEngine, loadSdk, sdkInfo,
  piForkAt: utilities.piForkAt, piForkBefore: utilities.piForkBefore };

