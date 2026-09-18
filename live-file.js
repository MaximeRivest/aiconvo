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
  if (root && ws.path.startsWith(root + '/')) return ws.path.slice(root.length + 1);
  // No checkout known yet: the path from the project folder is enough.
  const at = ws.project ? ws.path.indexOf('/' + ws.project + '/') : -1;
  if (at >= 0) return ws.path.slice(at + ws.project.length + 2);
  return ws.path.replace(/^\/home\/[^/]+\//, '~/');
}
function liveBackLabel(ws) {
  if (!ws.back) return ws.browserContext || ws.project ? '← Files' : '← Back';
  if (ws.back.startsWith('review=')) return '← Review';
  if (typeof fbConversationHash === 'function' && fbConversationHash(ws.back)) return '← Conversation';
  if (ws.back.startsWith('browse=')) return '← Files';
  if (ws.back.startsWith('filecall=')) return '← Change';
  return '← Back';
}
// One row: where you came from, the file, its state, and the few actions a
// file needs. History and Ask live in the row on a wide screen and under
// ⋯ on a phone, so the row never wraps over the text.
function liveFileHead(ws) {
  const md = ws.kind === 'md';
  return `<header class="live-file-head">
    <button id="liveBack" title="${fgAttr(liveBackLabel(ws).slice(2))}: return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${esc(liveBackLabel(ws).slice(2))}</span></button>
    <b id="ffTitle" title="${fgAttr(ws.path)}">${esc(liveFileLabel(ws))}</b>
    <span id="docStatus" role="status">Opening…</span>
    <span id="liveServiceStatus" title="Built-in language support; no language server connected">${esc(liveLanguage(ws.path))}</span>
    <button id="docReload" hidden title="Reload the current disk file">Reload</button>
    <button id="liveHistory" class="lf-wide" title="Recorded versions of this file: read one, or compare two">History</button>
    <button id="liveAsk" class="lf-wide" title="Ask an agent for a change to this file · Ctrl+K">Ask</button>
    ${md ? '<button id="docRun" class="lf-wide" title="Run the cell at the cursor · Ctrl+Enter">▶ Run</button>' : ''}
    <button id="${md ? 'docSave' : 'fwSave'}" ${md ? '' : 'disabled'} title="Save to disk · Ctrl+S">Save</button>
    <details class="live-more"><summary aria-label="Editor options">⋯</summary><div>
      <button id="liveHistoryMenu" class="lf-narrow">History</button>
      <button id="liveAskMenu" class="lf-narrow">Ask for a change</button>
      ${md ? '<button id="docRunMenu" class="lf-narrow">▶ Run this cell</button>' : ''}
      ${ws.project ? '<button id="liveBrowse">Browse this folder</button>' : ''}
      ${md ? '<button id="docRunAll">Run all cells</button><button id="docDiagrams" title="Reading view: the rendered document, with mermaid diagrams · double-click a diagram for its code · Ctrl+Shift+M">Reading view</button><button id="docSource">Markdown source</button><button id="docUnwrap" hidden>Unwrap prose</button>' : ''}
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
  $('view').innerHTML = '<section class="files-ws live-file-view"><div id="ffCompare" class="live-file-body"></div><div id="fwAsk" class="fw-ask" hidden></div></section>';
  // A link may name recorded versions (to=, from=): open straight into history.
  if (opts.to || opts.from) return liveFileHistory(ws, { to: opts.to || null, from: opts.from || null });
  await fileWsMountBody(ws, opts);
}
function liveFileGoBack(ws) {
  if (ws.back) return typeof fbReturnTo === 'function' ? fbReturnTo(ws.back) : dispatchHash(ws.back);
  if (ws.browserContext) return showFilesBrowser(ws.project, ws.browserContext);
  return ws.project ? showFilesBrowser(ws.project) : goHome();
}
function liveFileBrowseFolder(ws) {
  const context = ws.browserContext || { conv: (typeof fbConversationHash === 'function' && fbConversationHash(ws.back)) || '' };
  const root = ws.touched?.repoRoot || '';
  const dir = root && ws.path.startsWith(root + '/') ? ws.path.slice(root.length + 1).split('/').slice(0, -1).join('/') : '';
  return showFilesBrowser(ws.project, { ...context, mode: 'browse', root, dir });
}
function liveFileAfterMount(ws) {
  if (fileWs !== ws || !ws.editor) return;
  $('liveBack').onclick = () => liveFileGoBack(ws);
  for (const id of ['liveHistory', 'liveHistoryMenu']) $(id).onclick = () => liveFileHistory(ws);
  for (const id of ['liveAsk', 'liveAskMenu']) $(id).onclick = () => fileWsToggleAsk(true);
  if ($('liveBrowse')) $('liveBrowse').onclick = () => liveFileBrowseFolder(ws);
  const editor = ws.editor;
  if (editor.view?.dom) editor.view.dom.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); fileWsToggleAsk(true); }
  });
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

// ---- History: recorded versions of this file, read-only ----
// The editor makes way for a version list and one version (or the diff of
// two). Nothing is fetched until History is asked for; the route carries
// the chosen versions so a refresh or a shared link lands on the same view.
async function liveHistoryScope(ws) {
  if (ws.historyScope) return ws.historyScope;
  const out = await (await fetch('/api/file/history-scope?' + new URLSearchParams({ path: ws.path, project: ws.project || '' }))).json();
  if (out.error) throw new Error(out.error);
  ws.historyScope = out;
  if (!ws.touched.repoRoot && out.root) ws.touched.repoRoot = out.root;
  if (!ws.project && out.project) ws.project = out.project;
  return out;
}
function liveHistoryParams(scope) {
  return new URLSearchParams({ scope: 'project', name: scope.project, repo: scope.root, path: scope.relativePath });
}
function liveHistoryHead(ws) {
  return `<header class="live-file-head">
    <button id="liveBack" title="${fgAttr(liveBackLabel(ws).slice(2))}: return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${esc(liveBackLabel(ws).slice(2))}</span></button>
    <b id="ffTitle" title="${fgAttr(ws.path)}">${esc(liveFileLabel(ws))}</b>
    <span id="docStatus" role="status">History · read-only</span>
    <button id="liveLive" class="primary" title="Back to the editable file">Return to Live</button>
  </header>`;
}
async function liveFileHistory(ws, selection = {}) {
  if (fileWs !== ws) return;
  const ticket = ws.historyRequest = (ws.historyRequest || 0) + 1;
  if (ws.editor) fileWsCloseEditor();
  ws.mode = 'history';
  ws.historySel = selection;
  const view = $('view').querySelector('.live-file-view');
  if (!view) return;
  view.classList.add('history');
  view.innerHTML = liveHistoryHead(ws) + '<div class="live-history"><aside id="fwHistoryDrawer" class="fw-history-drawer" aria-label="File history">Loading recorded versions…</aside><main id="lfHistoryMain" class="lf-history-main"></main></div>';
  $('liveBack').onclick = () => liveFileGoBack(ws);
  $('liveLive').onclick = () => openLiveFile(ws.path, { project: ws.project, root: ws.touched?.repoRoot, back: ws.back, browserContext: ws.browserContext, reviewRef: ws.reviewRef });
  const host = $('fwHistoryDrawer');
  try {
    const scope = await liveHistoryScope(ws);
    const params = liveHistoryParams(scope);
    for (const key of ['from', 'to']) if (/^saved:\d+$/.test(selection[key] || '')) params.set(key, selection[key]);
    const doc = await (await fetch('/api/file-history/points?' + params)).json();
    if (doc.error) throw new Error(doc.error);
    if (fileWs !== ws || ws.historyRequest !== ticket) return;
    const points = doc.points, usable = points.filter(p => p.state !== 'unavailable');
    if (!usable.length) { host.textContent = 'No readable versions have been saved yet.'; return; }
    const newest = [...usable].reverse().find(p => p.kind === 'saved') || usable.at(-1);
    const pick = id => id ? usable.find(p => p.id === id || p.eventId === id) : null;
    if ((selection.to && !pick(selection.to)) || (selection.from && !pick(selection.from))) throw new Error('The requested version is unavailable. Pick another version.');
    let to = pick(selection.to) || newest;
    let from = pick(selection.from) || to;
    if (from.order > to.order) [from, to] = [to, from];
    ws.historySel = { from: from.id, to: to.id };
    const comparing = from.id !== to.id;
    const label = p => p.kind === 'current' ? 'Live file' : p.kind === 'saved' ? p.label : p.kind === 'ai' ? 'Reconstructed · ' + (p.title || 'agent edit') : p.kind === 'git' ? 'Git · ' + (p.subject || p.shortHash) : p.label || 'Recorded boundary';
    const when = p => p.kind === 'current' ? 'Now' : esc(new Date(p.ms).toLocaleString());
    host.innerHTML = `<header><b>History</b></header>
      <p class="fh-truth">${esc(doc.truth)}</p>
      <label><input id="fhCompare" type="checkbox" ${comparing ? 'checked' : ''}> Compare two versions</label>
      <label id="fhFromLabel" ${comparing ? '' : 'hidden'}>From <select id="fhFrom" aria-label="Earlier version"></select></label>
      <label>To <select id="fhTo" aria-label="Version to read"></select></label>
      <nav class="fh-step"><button id="fhOlder">← Older</button><button id="fhNewer">Newer →</button></nav>
      <p class="fh-readonly" role="status">Read-only · ${to.state === 'deleted' ? 'Deletion observed' : to.kind === 'current' ? 'Current disk contents' : 'Recorded ' + new Date(to.ms).toLocaleString()}</p>
      <div class="fh-versions">${[...points].reverse().map(p => `<button data-fh-point="${esc(p.id)}" ${p.state === 'unavailable' ? 'disabled' : ''} aria-current="${p.id === to.id ? 'true' : 'false'}"><time>${when(p)}</time><span>${esc(label(p))}</span></button>`).join('')}</div>`;
    const options = [...usable].reverse().map(p => `<option value="${esc(p.id)}">${when(p)} · ${esc(label(p))}</option>`).join('');
    $('fhFrom').innerHTML = $('fhTo').innerHTML = options;
    $('fhFrom').value = from.id; $('fhTo').value = to.id;
    const select = (toId, fromId) => liveFileHistory(ws, { from: fromId || toId, to: toId });
    const i = usable.findIndex(p => p.id === to.id);
    $('fhCompare').onchange = () => select(to.id, $('fhCompare').checked ? usable[Math.max(0, i - 1)].id : to.id);
    $('fhFrom').onchange = () => select(to.id, $('fhFrom').value);
    $('fhTo').onchange = () => select($('fhTo').value, comparing ? from.id : null);
    $('fhOlder').disabled = i <= 0; $('fhNewer').disabled = i >= usable.length - 1;
    $('fhOlder').onclick = () => select(usable[Math.max(0, i - 1)].id, comparing ? from.id : null);
    $('fhNewer').onclick = () => select(usable[Math.min(usable.length - 1, i + 1)].id, comparing ? from.id : null);
    host.querySelectorAll('[data-fh-point]').forEach(b => b.onclick = () => select(b.dataset.fhPoint, comparing ? from.id : null));
    currentHash = fileWsHash(ws);
    history.replaceState(null, '', location.pathname + location.search + '#' + currentHash);
    await liveHistoryPaint(ws, scope, doc, from, to, ticket);
  } catch (e) { if (fileWs === ws && host.isConnected && ws.historyRequest === ticket) host.textContent = 'History unavailable: ' + e.message; }
}
async function liveHistorySnapshot(scope, doc, point) {
  const params = liveHistoryParams(scope);
  params.set('point', point.id);
  const snap = await (await fetch('/api/file-history/snapshot?' + params)).json();
  if (snap.error) throw new Error(snap.error);
  return snap;
}
function liveVersionHtml(snap) {
  if (snap.state === 'deleted') return '<p class="cr-diff-notice">The file was absent at this point.</p>';
  const lines = String(snap.content || '').split('\n');
  return `<pre class="lf-version"><code>${lines.map((line, i) => `<span class="lf-ln">${i + 1}</span>${esc(line)}\n`).join('')}</code></pre>`;
}
async function liveHistoryPaint(ws, scope, doc, from, to, ticket) {
  const main = $('lfHistoryMain');
  if (!main) return;
  main.innerHTML = '<p class="cr-diff-notice">Loading the recorded version…</p>';
  const comparing = from.id !== to.id;
  const [older, newer] = await Promise.all([comparing ? liveHistorySnapshot(scope, doc, from) : null, liveHistorySnapshot(scope, doc, to)]);
  if (fileWs !== ws || ws.historyRequest !== ticket || !main.isConnected) return;
  const note = s => s && !s.exact && s.state !== 'deleted' ? `<p class="cr-diff-notice">${esc(s.method === 'replay' ? 'Reconstructed from recorded edits; divergent edits may have been skipped.' : 'Approximate version.')}</p>` : '';
  if (!comparing) { main.innerHTML = note(newer) + liveVersionHtml(newer); return; }
  const side = s => ({ text: String(s.content || ''), absent: s.state === 'deleted' });
  ws.historyExpanded = ws.historyExpanded || [];
  const paint = () => {
    main.innerHTML = note(older) + note(newer) + `<div class="cr-diff">${crDiff(side(older), side(newer), { comments: false, expanded: ws.historyExpanded })}</div>`;
    main.querySelectorAll('[data-cr-expand]').forEach(b => b.onclick = () => { ws.historyExpanded.push(b.dataset.crExpand.split(':').map(Number)); paint(); });
  };
  paint();
}
