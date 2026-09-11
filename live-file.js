'use strict';
// A small editing surface. File lifecycle stays with fileWs/docState; history,
// repository trees and agent composers are deliberately not mounted here.
const liveLanguageFactories = new Map();
function liveLanguage(path) {
  const name = String(path).split('/').pop().toLowerCase(), ext = name.split('.').pop();
  return ({ __proto__: null, js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', pyi: 'python', rs: 'rust', go: 'go', md: 'markdown', markdown: 'markdown', mdx: 'markdown', qmd: 'markdown', rmd: 'markdown',
    html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', css: 'css', scss: 'scss', less: 'less', json: 'json', jsonc: 'json', webmanifest: 'json',
    sql: 'sql', r: 'r', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', bashrc: 'shell', zshrc: 'shell', profile: 'shell', yaml: 'yaml', yml: 'yaml',
    c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', java: 'java', xml: 'xml', svg: 'xml', toml: 'toml', lua: 'lua', rb: 'ruby',
    dockerfile: 'dockerfile', containerfile: 'dockerfile', diff: 'diff', patch: 'diff' })[ext] || 'text';
}
// A future LSP bridge registers a factory returning {name, complete, hover,
// definition, dispose}. Offsets are CodeMirror/JavaScript UTF-16 positions.
// The adapter owns server lifecycle and diagnostics; no server starts implicitly.
function registerLiveFileLanguageService(language, factory) {
  liveLanguageFactories.set(language, factory);
  return () => { if (liveLanguageFactories.get(language) === factory) liveLanguageFactories.delete(language); };
}
function liveFileLabel(ws) {
  const root = ws.touched?.repoRoot;
  return root && ws.path.startsWith(root + '/') ? ws.path.slice(root.length + 1) : ws.path.replace(/^\/home\/[^/]+\//, '~/');
}
function liveFileHead(ws) {
  const md = ws.kind === 'md';
  return `<header class="live-file-head">
    <button id="liveBack" title="Return to the previous view">${ws.back?.startsWith('review=') ? '← Review' : '← Back'}</button>
    <b id="ffTitle" title="${fgAttr(ws.path)}">${esc(liveFileLabel(ws))}</b>
    <span id="docStatus" role="status">Opening…</span>
    <span id="liveServiceStatus" title="Built-in language support; no language server connected">${esc(liveLanguage(ws.path))}</span>
    <button id="docReload" hidden title="Reload the current disk file">Reload</button>
    ${md ? '<button id="docRun" title="Run the cell at the cursor · Ctrl+Enter">▶ Run</button>' : ''}
    <button id="${md ? 'docSave' : 'fwSave'}" ${md ? '' : 'disabled'} title="Save to disk · Ctrl+S">Save</button>
    <details class="live-more"><summary aria-label="Editor options">⋯</summary><div>
      ${md ? '<button id="docRunAll">Run all cells</button><button id="docSource">Markdown source</button><button id="docUnwrap" hidden>Unwrap prose</button>' : ''}
      <span id="liveAnnotationStatus">Gutter: changes and line attribution</span>
      <span>Ctrl+Space: completion · Ctrl+F: find</span>
    </div></details>
  </header>`;
}
async function openLiveFile(pathValue, opts = {}) {
  const seq = ++fileWsSeq;
  markSettingsClosed();
  if (window.fileInk?.teardown) fileInk.teardown();
  if (progressStream) { progressStream.close(); progressStream = null; }
  closeFileWorkspace();
  const ws = { path: String(pathValue), project: opts.project || null, focused: true, mode: 'write', kind: fileWsKind(pathValue),
    editor: null, sha: null, dirty: false, saving: false, row: null, seq, line: opts.line || null, back: opts.back || null,
    touched: { repoRoot: opts.root || '', sessions: [], commits: [] }, browserContext: opts.browserContext || null,
    reviewRef: opts.reviewRef || null, reviewData: opts.reviewData || null };
  fileWs = ws;
  setRoute('file', fileWsHash(ws));
  $('view').innerHTML = '<section class="files-ws live-file-view"><div id="ffCompare" class="live-file-body"></div></section>';
  await fileWsMountBody(ws, opts);
}
function liveFileAfterMount(ws) {
  if (fileWs !== ws || !ws.editor) return;
  $('liveBack').onclick = () => ws.back ? dispatchHash(ws.back) : ws.browserContext ? showFilesBrowser(ws.project, ws.browserContext) : ws.project ? showFilesBrowser(ws.project) : goHome();
  const editor = ws.editor;
  const savedText = ws.kind === 'md' ? docState.baseText : ws.baseText;
  $('docReload').onclick = () => liveFileReload(ws);
  const state = ws.live = { version: 0, original: savedText, sha: ws.kind === 'md' ? docState.sha : ws.sha,
    baseline: savedText, label: 'since opening', absent: false, origins: null, mappedVersion: -1, marks: new Map(),
    busy: false, timer: null, pending: false, controller: new AbortController(), blame: new Map(), hover: 0, disposed: false };
  const status = text => { if (fileWs === ws && $('liveAnnotationStatus')) $('liveAnnotationStatus').textContent = text; };
  try {
    state.worker = new Worker('/live-file-marks-worker.js');
    state.worker.onmessage = e => {
      if (fileWs !== ws || state.disposed) return;
      state.busy = false;
      if (e.data.id === state.version) {
        state.origins = e.data.origins || null; state.mappedVersion = e.data.id;
        state.marks = new Map((e.data.marks || []).map(m => [m.line, m]));
        editor.setLineMarks?.(state.marks, editor.getContent());
        status(e.data.unavailable || `Markers: ${state.label}. Hover the gutter for Git attribution.`);
      }
      if (state.pending) send();
    };
    state.worker.onerror = () => { state.worker.terminate(); state.worker = null; state.busy = false; status('Inline annotations unavailable; editing still works'); };
  } catch { status('Inline annotations unavailable; editing still works'); }
  const send = () => {
    if (fileWs !== ws || state.disposed || !state.worker) return;
    if (state.busy) { state.pending = true; return; }
    state.pending = false; state.busy = true;
    state.worker.postMessage({ id: state.version, text: editor.getContent(), baseline: state.baseline, original: state.original, absent: state.absent, label: state.label });
  };
  state.refresh = () => {
    state.version++; state.hover++; state.hoverController?.abort(); clearTimeout(state.timer); state.timer = setTimeout(send, 120);
    clearTimeout(state.draftTimer); state.draftTimer = setTimeout(() => liveFileStash(ws), 300);
  };
  state.unsubscribe = editor.onChange(state.refresh);
  state.refresh();
  const setReview = data => {
    if (fileWs !== ws || state.disposed || !data) return;
    if (!data.old?.unavailable && typeof data.old?.text === 'string') { state.baseline = data.old.text; state.absent = !!data.old.absent; state.label = 'since the review baseline'; state.refresh(); }
    else status('Review baseline unavailable; markers show edits since opening');
  };
  if (ws.reviewData) setReview(ws.reviewData);
  else if (ws.reviewRef) {
    const r = ws.reviewRef;
    fetch('/api/reviews/file?' + new URLSearchParams({ id: r.id, path: r.path, step: r.step || '', scope: r.scope || 'task' }), { signal: state.controller.signal })
      .then(r => r.json()).then(setReview).catch(() => {});
  }
  const language = liveLanguage(ws.path), factory = liveLanguageFactories.get(language);
  if (factory && editor.setLanguageServices) {
    Promise.resolve().then(() => factory({ path: ws.path, project: ws.project, editor, signal: state.controller.signal }))
      .then(service => {
        if (fileWs !== ws || state.disposed) return service?.dispose?.();
        state.service = service; editor.setLanguageServices(service);
        const el = $('liveServiceStatus'); if (el) { el.textContent = service?.name || language; el.title = service ? 'Language-service adapter enabled' : 'Built-in language support'; }
      }).catch(() => { if (fileWs === ws && $('liveServiceStatus')) $('liveServiceStatus').title = 'Language service unavailable; built-in completion remains enabled'; });
  }
  const beforeUnload = event => {
    liveFileStash(ws);
    if (editor.getContent() !== state.original) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  state.dispose = () => {
    liveFileStash(ws); window.removeEventListener('beforeunload', beforeUnload);
    state.disposed = true; clearTimeout(state.timer); clearTimeout(state.diskTimer); clearTimeout(state.draftTimer); state.controller.abort(); state.hoverController?.abort();
    state.worker?.terminate(); state.unsubscribe?.();
    try { Promise.resolve(state.service?.dispose?.()).catch(() => {}); } catch {}
  };
  editor.focus();
}
async function liveFileHover(ws, line) {
  const s = ws?.live;
  if (!s || fileWs !== ws || s.disposed) return '';
  const version = s.version, ticket = ++s.hover;
  s.hoverController?.abort();
  const marker = s.marks.get(line)?.title;
  if (s.mappedVersion !== version || !s.origins) return s.worker ? 'Line information is updating…' : 'Inline annotations unavailable';
  const origin = s.origins[line];
  if (!origin) return [marker, 'Edited in this view · not saved'].filter(Boolean).join('\n');
  const key = s.sha + ':' + origin;
  if (!s.blame.has(key)) {
    const controller = s.hoverController = new AbortController();
    await new Promise(resolve => setTimeout(resolve, 120));
    if (ticket !== s.hover || controller.signal.aborted) return '';
    try {
      const response = await fetch('/api/file/line-info?' + new URLSearchParams({ path: ws.path, line: origin, sha: s.sha, reviewId: ws.reviewRef?.id || '' }), { signal: controller.signal });
      const data = await response.json();
      if (fileWs !== ws || s.version !== version || ticket !== s.hover) return '';
      const label = data.kind === 'git' ? `${data.author} · ${new Date(data.time).toLocaleDateString()}\n${data.commit.slice(0, 10)} · ${data.summary}\nGit attribution` : data.reason || data.error || 'Attribution unavailable';
      s.blame.set(key, label); if (s.blame.size > 200) s.blame.delete(s.blame.keys().next().value);
    } catch { return controller.signal.aborted ? '' : 'Attribution unavailable'; }
  }
  return [marker, s.blame.get(key)].filter(Boolean).join('\n');
}
function liveFileNavigate(ws, location) {
  if (fileWs !== ws || !location || typeof location.path !== 'string' || !location.path.startsWith('/')) return;
  return openLiveFile(location.path, { project: ws.project, root: ws.touched.repoRoot, line: Number(location.line) || 1, back: fileWsHash(ws) });
}
function liveFileStash(ws) {
  if (!ws?.live || !ws.editor) return;
  const text = ws.editor.getContent();
  try {
    const key = 'aiconvo.draft:' + ws.path;
    if (text === ws.live.original) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({ sha: ws.live.sha, text, at: Date.now() }));
    ws.live.draftWarning = false;
  } catch {
    if (!ws.live.draftWarning) { ws.live.draftWarning = true; errToast('Could not store a recovery draft. Save or copy your edits before leaving.'); }
  }
}
function liveFileSaved(ws, text, sha) {
  const s = ws.live; if (!s) return;
  s.original = text; s.sha = sha; s.blame.clear(); s.refresh();
}
function liveFileActivity(ws) {
  const s = ws.live; if (!s || s.disposed) return;
  clearTimeout(s.diskTimer);
  s.diskTimer = setTimeout(async () => {
    try {
      const d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path, reviewId: ws.reviewRef?.id || '' }), { signal: s.controller.signal })).json();
      if (fileWs !== ws || s.disposed || d.error) return;
      const sha = ws.kind === 'md' ? docState?.sha : ws.sha;
      if (d.sha === sha || d.text === ws.editor.getContent()) return;
      fileWsBanner(ws, 'The file changed on disk. Your editor has not been replaced.', [['Reload from disk', () => liveFileReload(ws)]]);
    } catch {}
  }, 250);
}
function liveFileReload(ws) {
  const dirty = ws.kind === 'md' ? docState?.dirty : ws.dirty;
  if (dirty && !confirm('Discard your unsaved edits and reload the disk file?')) return;
  return ws.kind === 'md' ? reloadDocumentFromDisk() : fileWsReloadCode(ws, { dropDraft: true });
}
