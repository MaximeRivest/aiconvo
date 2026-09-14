'use strict';
// filesmode.js — the file editor's lifecycle: mounting the MRMD document
// editor or the CodeMirror code editor into the live file view, saving,
// reloading, disk-change banners, and "ask for a change" (an agent run
// started from the open file). The frame around the editor is live-file.js;
// browsing is files-browser.js; recorded changes are change-review-ui.js.
//
// Loaded before app.html's main script; every helper it needs (router,
// the MRMD editor mount, toasts) is a global of that script, resolved at
// call time.

async function openConversationAtEvent(key, eventId) {
  let entryId = null;
  try {
    const d = await (await fetch('/api/files/entry?key=' + encodeURIComponent(key) + (eventId ? '&event=' + encodeURIComponent(eventId) : ''))).json();
    entryId = d.entryId || null;
  } catch {}
  return open(key, entryId ? 'entry:' + entryId : undefined);
}

// Old links: a project's files page is the files browser.
async function showFilesProject(name, opts = {}) {
  if (name) return showFilesBrowser(name, opts);
}

// ---- the open file ----
let fileWs = null;
let fileWsSeq = 0;

const MD_EXT = /\.(md|markdown|qmd|rmd|mdx)$/i;
function fileWsKind(p) { return MD_EXT.test(String(p || '')) ? 'md' : 'code'; }
function fileWsHash(ws) {
  const parts = ['file'];
  if (ws.project) parts.push('p=' + encodeURIComponent(ws.project));
  // The app dispatcher decodes the whole hash before parsing file parameters.
  // One extra layer keeps '&' inside context values from becoming separators.
  if (ws.browserContext) parts.push('browser=' + encodeURIComponent(encodeURIComponent(JSON.stringify(ws.browserContext))));
  if (ws.back) parts.push('back=' + encodeURIComponent(encodeURIComponent(ws.back)));
  parts.push('focus');
  if (ws.reviewRef) parts.push('review=' + encodeURIComponent(encodeURIComponent(JSON.stringify(ws.reviewRef))));
  if (ws.mode === 'history' && ws.historySel?.to) parts.push('to=' + encodeURIComponent(ws.historySel.to), 'from=' + encodeURIComponent(ws.historySel.from || ws.historySel.to));
  parts.push('path=' + (ws.path || ''));
  return parts.join('&');
}
// `file&p=…&focus&from=…&to=…&path=/abs` (path last: it may contain &)
// and the short `file=/abs`. `landing` is an old flag, ignored.
function parseFileHash(h) {
  if (h.startsWith('file=')) return { path: h.slice(5) };
  const out = {};
  const at = h.indexOf('&path=');
  if (at >= 0) { out.path = h.slice(at + 6); h = h.slice(0, at); }
  for (const seg of h.split('&').slice(1)) {
    if (seg === 'landing' || seg === 'focus') continue;
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq), v = seg.slice(eq + 1);
    try { out[k === 'p' ? 'project' : k] = decodeURIComponent(v); } catch { out[k === 'p' ? 'project' : k] = v; }
  }
  if (out.line) out.line = Number(out.line);
  return out;
}

// ---- links inside the open document ----
// The MRMD bundle turns `[text](target)` into a span that swallows the click
// and dispatches `file-link-navigate` with the raw target; http(s) links are
// real anchors and never arrive here. A target is document-relative, exactly
// like an image handed to `assetResolver`: it resolves against the open file,
// the server checks it (existence and the usual path policy), and it opens in
// this editor with a way back. `#L12` or `#12` names a line; any other
// fragment is a heading, matched the way GitHub slugs it.
function parseFileLinkTarget(target) {
  let t = String(target || '').trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1); // [x](<a b.md>)
  t = t.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, ''); // [x](a.md "title")
  let fragment = '';
  const hash = t.indexOf('#');
  if (hash >= 0) { fragment = t.slice(hash + 1); t = t.slice(0, hash); }
  t = t.split('?')[0];
  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };
  return { path: decode(t), fragment: decode(fragment) };
}
// `..` never climbs above the root; `~/` is left for the server to expand.
function resolveDocRelative(docPath, target) {
  if (!target || target.startsWith('~/')) return target || '';
  const out = target.startsWith('/') ? [] : String(docPath).split('/').slice(0, -1).filter(Boolean);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}
function headingSlug(value) {
  return value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
}
// The 1-based line of the heading a fragment names, or null. YAML front
// matter and fenced code are skipped; ATX and setext headings count;
// repeated headings get -1, -2…, the way GitHub numbers duplicate anchors.
function findHeadingLine(text, fragment) {
  const seen = new Set(), rows = String(text).split(/\r?\n/);
  let fence = null, frontmatter = rows[0]?.trim() === '---';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (frontmatter) { if (i > 0 && /^(---|\.\.\.)\s*$/.test(row)) frontmatter = false; continue; }
    const fenced = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenced) {
      const token = fenced[1];
      if (!fence) fence = token;
      else if (token[0] === fence[0] && token.length >= fence.length && !fenced[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = row.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const setext = !atx && row.trim() && !/^\s/.test(row) && /^ {0,3}(=+|-+)\s*$/.test(rows[i + 1] || '');
    const heading = atx?.[1] || (setext ? row : null);
    if (heading === null) continue;
    const base = headingSlug(heading);
    let slug = base, n = 0;
    while (seen.has(slug)) slug = `${base}-${++n}`;
    seen.add(slug);
    if (fragment === slug || fragment === heading) return i + 1;
  }
  return null;
}
// undefined when the target could not be read; null when it has no such heading.
async function fileWsHeadingLine(pathValue, fragment) {
  try {
    const d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: pathValue }))).json();
    return d.error ? undefined : findHeadingLine(d.text, fragment);
  } catch { return undefined; }
}
async function fileWsFollowLink(ws, target, { system = false } = {}) {
  if (fileWs !== ws || !ws.path) return;
  const link = parseFileLinkTarget(target);
  if (!link.path) return; // a bare #fragment stays in this document
  const wanted = resolveDocRelative(ws.path, link.path);
  let out;
  try { out = await postJson('/api/path/exists', { paths: [wanted] }); }
  catch { out = { error: 'could not check the link · ' + link.path }; }
  if (fileWs !== ws) return;
  if (out.error) return errToast(out.error);
  const found = out.found && out.found[wanted];
  if (!found) return errToast('link target not found · ' + link.path);
  // Ctrl/Cmd-click means the system application, as it does on every file
  // control in the app.
  if (system) return runNativePathAction({ key: '', path: found.path }, 'open');
  if (found.kind !== 'file') return errToast('folders have no in-app view · ' + link.path);
  let line = null;
  const at = link.fragment.match(/^L?(\d+)(?:-L?\d+)?$/);
  if (at) line = Number(at[1]);
  else if (link.fragment) {
    line = await fileWsHeadingLine(found.path, link.fragment);
    if (fileWs !== ws) return;
    if (line === null) toast('heading not found · opening ' + link.path);
    else if (line === undefined) toast('could not read the target for its heading · opening ' + link.path);
  }
  return liveFileNavigate(ws, { path: found.path, line: line || 1 });
}
function fileWsWireDocLinks(ws) {
  const host = $('docEditor');
  if (!host) return;
  let system = false;
  // The widget stops propagation of its click, so the modifier is read in
  // the capture phase, before the widget turns the click into its own event.
  host.addEventListener('click', e => {
    system = !!(e.ctrlKey || e.metaKey) && !!(e.target && e.target.closest && e.target.closest('.cm-file-link'));
  }, true);
  host.addEventListener('file-link-navigate', e => {
    const opts = { system };
    system = false;
    fileWsFollowLink(ws, e.detail && e.detail.path, opts);
  });
}

function fileWsCloseEditor({ keepDraft = true } = {}) {
  if (!fileWs) return;
  fileWs.live?.dispose?.();
  if (fileWs.editor && fileWs.editor.selection) {
    try { localStorage.setItem('aiconvo.cursor:' + fileWs.path, String(fileWs.editor.selection().line)); } catch {}
  }
  if (fileWs.kind === 'md') { flushAndCloseDocument(); }
  else if (fileWs.editor) {
    if (keepDraft && fileWs.dirty) {
      // Code never autosaves (design §5.3). An unsaved draft survives a
      // navigation in sessionStorage and comes back with a banner.
      try { sessionStorage.setItem('aiconvo.draft:' + fileWs.path, JSON.stringify({ sha: fileWs.sha, text: fileWs.editor.getContent(), at: Date.now() })); } catch {}
    }
    try { fileWs.editor.destroy(); } catch {}
  }
  fileWs.editor = null;
}

function closeFileWorkspace() {
  if (!fileWs) return;
  fileWsCloseEditor();
  clearInterval(fileWs.runTick);
  fileWs = null;
}

async function fileWsMountBody(ws, opts) {
  if (fileWs !== ws) return;
  if (ws.kind === 'md') await fileWsMountMarkdown(ws, opts);
  else await fileWsMountCode(ws, opts);
}

async function fileWsMountMarkdown(ws, opts) {
  const host = $('ffCompare');
  if (!host) return;
  host.innerHTML = `<div class="doc-view">${liveFileHead(ws)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-editor-host"><div id="docEditor"></div></div></div>`;
  $('liveBack').onclick = () => liveFileGoBack(ws);
  await mountDocumentEditor(ws.path, ws.project, { focused: true });
  if (fileWs !== ws) return;
  // Markdown the project cannot edit still opens, read-only, as text.
  if (!docState || docState.path !== ws.path) { ws.kind = 'code'; return fileWsMountCode(ws, opts); }
  ws.editor = docState.editor;
  ws.sha = docState.sha;
  fileWsWireDocLinks(ws);
  fileWsAfterMount(ws, opts);
}

// ---- write mode: code (CodeMirror from the same vendored bundle) ----
// The header stays whatever happens to the file, so Back always works.
function fileWsOpenFailed(ws, label, detail = '') {
  const host = $('view').querySelector('.doc-editor-host');
  if (!host) return;
  host.innerHTML = `<div class="empty">${esc(label)}${detail ? `<div class="hint">${esc(detail)}</div>` : ''}</div>`;
  if ($('liveBack')) $('liveBack').onclick = () => liveFileGoBack(ws);
  if ($('docStatus')) $('docStatus').textContent = '';
  for (const id of ['fwSave', 'docSave', 'liveHistory', 'liveAsk', 'liveHistoryMenu', 'liveAskMenu', 'docRun']) if ($(id)) $(id).hidden = true;
}
// A file the project cannot edit (outside every checkout: a log in /tmp, a
// file under home) still opens, read-only, through the transcript path
// reader. One surface for reading and editing; the state says which.
async function fileWsReadText(ws) {
  const editable = await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path, reviewId: ws.reviewRef?.id || '' })).then(r => r.json());
  if (!editable.error) return editable;
  const conv = typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
  const readOnly = await fetch('/api/path/read?' + new URLSearchParams({ id: conv || '', path: ws.path })).then(r => r.json()).catch(() => null);
  if (readOnly && !readOnly.error) return { ...readOnly, readOnly: true, why: editable.error };
  return editable;
}

async function fileWsMountCode(ws, opts) {
  const host = $('ffCompare');
  if (!host) return;
  host.innerHTML = `<div class="doc-view code-view">${liveFileHead(ws)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-editor-host code-host"><div id="codeEditor"></div></div></div>`;
  $('liveBack').onclick = () => liveFileGoBack(ws);
  let bundle, d;
  try { [bundle, d] = await Promise.all([loadMrmdDocument(), fileWsReadText(ws)]); }
  catch (e) { return fileWsOpenFailed(ws, 'Could not open the file.', e.message); }
  if (fileWs !== ws || !$('codeEditor')) return;
  if (d.error) return fileWsOpenFailed(ws, 'Could not read the file.', d.error);
  if (d.text.includes('\0')) return fileWsOpenFailed(ws, 'This is a binary file.', 'Use the system application; this editor only shows text.');
  if (!bundle.createCodeEditor) return fileWsOpenFailed(ws, 'The editor bundle is too old for code files.', 'Reload the app once; the new bundle is served now.');
  ws.sha = d.sha;
  ws.dirty = false;
  let text = d.text;
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem('aiconvo.draft:' + ws.path) || 'null'); } catch {}
  if (draft && draft.text !== d.text) text = draft.text;
  else draft = null;
  const status = t => { const el = $('docStatus'); if (el) el.textContent = t; };
  const markDirty = () => {
    if (fileWs !== ws) return;
    ws.dirty = ws.editor.getContent() !== ws.baseText;
    $('fwSave').disabled = !ws.dirty;
    status(ws.dirty ? 'Unsaved' : 'Saved');
  };
  ws.baseText = d.text;
  ws.editor = bundle.createCodeEditor($('codeEditor'), {
    doc: text, filename: ws.path, theme: mrmdHostTheme(),
    onChange: markDirty,
    onSave: () => fileWsSaveCode(ws),
    onLineHover: line => liveFileHover(ws, line),
    onNavigateLocation: location => liveFileNavigate(ws, location),
    onLineHoverEnd: () => { if (ws.live) { ws.live.hover++; ws.live.hoverController?.abort(); } },
  });
  $('fwSave').onclick = () => fileWsSaveCode(ws);
  $('docReload').onclick = () => fileWsReloadCode(ws);
  if (d.readOnly) {
    ws.readOnly = true;
    try { ws.editor.setReadonly(true); } catch {}
    $('fwSave').hidden = true;
    for (const id of ['liveAsk', 'liveAskMenu']) if ($(id)) $(id).hidden = true;
    status('Read-only · ' + d.why);
    fileWsAfterMount(ws, opts);
    return;
  }
  if (draft) {
    ws.dirty = true;
    $('fwSave').disabled = false;
    fileWsBanner(ws, `an unsaved draft from ${ago(Date.now() - draft.at)} ago was restored — save it, or reload from disk to drop it`, [['reload from disk', () => fileWsReloadCode(ws, { dropDraft: true })]]);
    if (draft.sha !== d.sha) {
      ws.sha = draft.sha;
      fileWsBanner(ws, 'This draft was made on an older disk version. Your text is preserved; saving will not silently replace the newer disk file.', [['Reload disk', () => liveFileReload(ws)]]);
    }
  } else status('Saved');
  fileWsAfterMount(ws, opts);
}

async function fileWsSaveCode(ws) {
  if (fileWs !== ws || !ws.editor || ws.saving) return;
  const text = ws.editor.getContent();
  if (text === ws.baseText) return;
  ws.saving = true;
  $('fwSave').disabled = true;
  let out;
  try { out = await postJson('/api/file/save', { path: ws.path, baseSha: ws.sha, text, reviewId: ws.reviewRef?.id }); }
  catch { out = { error: 'Network failure; your edits are still in the editor' }; }
  ws.saving = false;
  if (fileWs !== ws) return;
  if (out.error) {
    $('fwSave').disabled = false;
    if (String(out.error).includes('changed on disk')) {
      fileWsBanner(ws, 'The disk file changed. Your edits are kept here and were not overwritten.', [['Copy my edits', () => navigator.clipboard.writeText(ws.editor.getContent())], ['Reload disk', () => liveFileReload(ws)]]);
    }
    return errToast('save failed: ' + out.error);
  }
  ws.sha = out.sha;
  ws.baseText = text;
  // Typing may continue while the save is in flight. Only the submitted
  // revision was saved; retain the newer text as an unsaved draft.
  ws.dirty = ws.editor.getContent() !== text;
  $('fwSave').disabled = !ws.dirty;
  if (!ws.dirty) try { sessionStorage.removeItem('aiconvo.draft:' + ws.path); } catch {}
  const el = $('docStatus'); if (el) el.textContent = ws.dirty ? 'Unsaved' : 'Saved';
  fileWsBanner(ws, out.historyWarning ? 'Saved, but history capture failed: ' + out.historyWarning : null);
  liveFileSaved(ws, text, out.sha);
}

async function fileWsReloadCode(ws, { dropDraft = false } = {}) {
  if (fileWs !== ws || !ws.editor) return;
  const requestedText = ws.editor.getContent();
  let d;
  try { d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path, reviewId: ws.reviewRef?.id || '' }))).json(); } catch { d = { error: 'network failure' }; }
  if (fileWs !== ws || !ws.editor) return;
  if (d.error) return errToast(d.error);
  if (ws.editor.getContent() !== requestedText) return fileWsBanner(ws, 'Kept the edits you typed while reloading. Reload again when ready.', [['Reload disk', () => liveFileReload(ws)]]);
  const sel = ws.editor.selection();
  ws.editor.setContent(d.text);
  ws.baseText = d.text; ws.sha = d.sha; ws.dirty = false;
  if (dropDraft) try { sessionStorage.removeItem('aiconvo.draft:' + ws.path); } catch {}
  $('fwSave').disabled = true;
  $('docReload').hidden = true;
  try { ws.editor.gotoLine(sel.line); } catch {}
  fileWsBanner(ws, null);
  liveFileSaved(ws, d.text, d.sha);
  $('docStatus').textContent = 'Reloaded';
}

// After a reload: mark the lines that changed (code gutter) and say how much.

function fileWsBanner(ws, text, actions = []) {
  const el = $('fwBanner');
  if (!el) return;
  if (!text) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span>${esc(text)}</span>${actions.map((a, i) => `<button type="button" data-fw-act="${i}">${esc(a[0])}</button>`).join('')}<button type="button" class="ghost" data-fw-dismiss title="dismiss">✕</button>`;
  el.querySelectorAll('[data-fw-act]').forEach(b => b.onclick = () => actions[Number(b.dataset.fwAct)][1]());
  el.querySelector('[data-fw-dismiss]').onclick = () => fileWsBanner(ws, null);
}

// Common tail of a mount: cursor memory, the requested line, shortcuts.

function fileWsAfterMount(ws, opts) {
  if (fileWs !== ws || !ws.editor) return;
  let line = opts.line || ws.line || null;
  if (!line) { const saved = Number(localStorage.getItem('aiconvo.cursor:' + ws.path)); if (saved > 1) line = saved; }
  if (line && ws.editor.gotoLine) { try { ws.editor.gotoLine(line); } catch {} }
  ws.line = null;
  liveFileAfterMount(ws);
}

// ---- who touched this file ----

let askTargetCache = null;
async function fileWsToggleAsk(forceOpen = false) {
  const ws = fileWs;
  if (!ws || !ws.path) return;
  const panel = $('fwAsk');
  if (!panel) return;
  if (!panel.hidden && !forceOpen) { panel.hidden = true; panel.innerHTML = ''; return; }
  if (!panel.hidden && forceOpen) { const ta = panel.querySelector('textarea'); if (ta) ta.focus(); return; }
  panel.hidden = false;
  panel.innerHTML = `<div class="fw-ask-head"><b>ask for a change</b><span class="dim" id="fwAskTarget">finding where this goes…</span><button type="button" class="ghost" id="fwAskPreview" title="See exactly what the agent receives with your prompt">what goes along</button><button type="button" class="ghost" id="fwAskClose">✕</button></div>
    <textarea id="fwAskText" rows="3" placeholder="what should change in this file? — Enter sends · Shift+Enter is a newline · your selection or cursor line goes along" spellcheck="true"></textarea>
    <div class="fw-ask-foot"><span class="dim" id="fwAskSel"></span><span class="fw-spacer"></span><button type="button" class="primary" id="fwAskSend">send</button></div>
    <div id="fwAskRun" hidden></div><div id="fwAskPreviewBox" hidden></div>`;
  const ta = $('fwAskText');
  ta.focus();
  ta.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Escape') { panel.hidden = true; panel.innerHTML = ''; if (ws.editor) ws.editor.focus(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fileWsSendAsk(ws); }
  };
  $('fwAskClose').onclick = () => { panel.hidden = true; panel.innerHTML = ''; };
  $('fwAskSend').onclick = () => fileWsSendAsk(ws);
  $('fwAskPreview').onclick = () => fileWsAskPreview(ws);
  fileWsAskSelectionLine(ws);
  if (ws.editor && ws.editor.view && !ws.askSelWired) {
    ws.askSelWired = true;
    ws.editor.view.dom.addEventListener('mouseup', () => fileWsAskSelectionLine(ws));
    ws.editor.view.dom.addEventListener('keyup', () => fileWsAskSelectionLine(ws));
  }
  let t;
  try { t = await (await fetch('/api/files/ask-target?path=' + encodeURIComponent(ws.path) + (ws.project ? '&project=' + encodeURIComponent(ws.project) : ''))).json(); } catch { t = { error: 'network failure' }; }
  if (fileWs !== ws || !$('fwAskTarget')) return;
  askTargetCache = t;
  // The conversation the file was opened from is the natural place for the
  // request when it is among the recent ones that touched this file.
  const origin = typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
  const choice = origin && (t.candidates || []).some(c => c.key === origin) ? origin : t.continue ? t.continue.key : 'new';
  fileWsPaintAskTarget(ws, t, choice);
}

function fileWsAskSelectionLine(ws) {
  const el = $('fwAskSel');
  if (!el || !ws.editor || !ws.editor.selection) return;
  const sel = ws.editor.selection();
  el.textContent = sel.empty ? `cursor: line ${sel.line}` : `selection: lines ${sel.from}–${sel.to}`;
}

function fileWsPaintAskTarget(ws, t, choice) {
  const el = $('fwAskTarget');
  if (!el) return;
  ws.askChoice = choice;
  if (t.error) { el.textContent = '⚠ ' + t.error; return; }
  const options = [];
  for (const c of t.candidates || []) options.push(`<option value="${esc(c.key)}"${choice === c.key ? ' selected' : ''}>↳ continues "${esc(c.title)}" · ${esc(ago(Date.now() - c.lastMs))} ago${c.busy ? ' · busy (queues)' : ''}</option>`);
  options.push(`<option value="new"${choice === 'new' ? ' selected' : ''}>↳ new conversation in ${esc(t.project)}${t.area ? '/' + esc(t.area) : ''}</option>`);
  el.innerHTML = `<select id="fwAskChoice" title="Where the prompt goes: the newest free conversation that touched this file (last 6 h), or a fresh one rooted at the project">${options.join('')}</select>`;
  $('fwAskChoice').onchange = e => { ws.askChoice = e.target.value; };
}

async function fileWsAskPreview(ws) {
  const box = $('fwAskPreviewBox');
  if (!box) return;
  if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<div class="dim">assembling…</div>';
  const sel = ws.editor && ws.editor.selection ? ws.editor.selection() : null;
  const body = { path: ws.path };
  if (sel && !sel.empty) body.range = [sel.from, sel.to]; else if (sel) body.line = sel.line;
  const out = await postJson('/api/files/ask-preview', body);
  if (!$('fwAskPreviewBox')) return;
  if (out.error) { box.innerHTML = `<div class="dim">⚠ ${esc(out.error)}</div>`; return; }
  box.innerHTML = `<div class="dim">${(out.text.length / 1024).toFixed(1)} KB · ~${Math.round(out.text.length / 4).toLocaleString()} tokens · rides in the system prompt as an attached file; the project map is added for a new conversation</div><pre class="fw-preview">${esc(out.text)}</pre>`;
}

async function fileWsSendAsk(ws) {
  const ta = $('fwAskText');
  if (!ta || fileWs !== ws) return;
  const prompt = ta.value.trim();
  if (!prompt) return toast('write what should change first');
  if (ws.run) return toast('an agent is already working on this — wait or stop it');
  const sel = ws.editor && ws.editor.selection ? ws.editor.selection() : null;
  const body = { path: ws.path, project: ws.project, prompt, target: ws.askChoice || 'auto' };
  if (sel && !sel.empty) body.range = [sel.from, sel.to]; else if (sel) body.line = sel.line;
  // Unsaved code goes to disk first: the agent must read what you see.
  if (ws.kind === 'code' && ws.dirty) await fileWsSaveCode(ws);
  if (ws.kind === 'md' && docState && docState.dirty) await autosaveDocument();
  $('fwAskSend').disabled = true;
  const out = await postJson('/api/files/ask', body);
  if (fileWs !== ws) return;
  $('fwAskSend').disabled = false;
  if (out.error) return errToast(out.error);
  ta.value = '';
  ws.run = { jobId: out.job ? out.job.id : null, key: out.key, startedAt: Date.now(), preSha: ws.sha, preText: ws.editor ? ws.editor.getContent() : null, title: out.title || (out.created ? 'new conversation' : 'conversation'), created: out.created, queued: out.queued };
  fileWsLockEditor(ws, true);
  fileWsPaintRun(ws, { statusText: out.queued ? 'queued behind the running turn' : 'starting' });
  clearInterval(ws.runTick);
  ws.runTick = setInterval(() => { if (fileWs === ws && ws.run) fileWsPaintRun(ws, ws.runLast || {}); else clearInterval(ws.runTick); }, 1000);
  toast((out.created ? 'new conversation started · ' : 'sent to ') + (out.title || 'the conversation'));
}

function fileWsLockEditor(ws, lock) {
  if (!ws.editor) return;
  try { ws.editor.setReadonly(lock); } catch {}
  if (lock) fileWsBanner(ws, 'an agent is working on this conversation — the editor is read-only until it settles, so nothing you type races its edits', [['open the conversation', () => open(ws.run.key, 'bottom')], ['stop the run', () => fileWsAbortRun(ws)]]);
  else fileWsBanner(ws, null);
}

function fileWsPaintRun(ws, d) {
  const host = $('fwAskRun');
  if (!host || !ws.run) return;
  host.hidden = false;
  ws.runLast = d;
  const elapsed = Math.round((Date.now() - ws.run.startedAt) / 1000);
  const model = d.model || '';
  host.innerHTML = `<div class="fw-run"><span class="fw-run-dot">●</span><b>${esc(ws.run.title || 'conversation')}</b><span class="dim">${esc(model)}${model ? ' · ' : ''}${elapsed}s</span><span class="fw-run-status">${esc(d.statusText || 'working…')}</span><button type="button" class="ghost" data-run-open>open</button><button type="button" class="ghost" data-run-stop>■ stop</button></div>`;
  host.querySelector('[data-run-open]').onclick = () => open(ws.run.key, 'bottom');
  host.querySelector('[data-run-stop]').onclick = () => fileWsAbortRun(ws);
}

async function fileWsAbortRun(ws) {
  if (!ws.run || !ws.run.jobId) return;
  await postJson('/api/run/abort', { jobId: ws.run.jobId });
}

// SSE run-event for the run this workspace started.

function fileWsRunEvent(d) {
  const ws = fileWs;
  if (!ws || !ws.run) return;
  if (d.jobId !== ws.run.jobId && d.key !== ws.run.key) return;
  if (!ws.run.jobId && d.jobId) ws.run.jobId = d.jobId;
  if (!d.final) { fileWsPaintRun(ws, d); return; }
  clearInterval(ws.runTick);
  const host = $('fwAskRun');
  const status = d.status === 'done' ? '✓ settled' : '✗ ' + (d.statusText || d.status || 'ended');
  const run = ws.run;
  ws.run = null;
  fileWsLockEditor(ws, false);
  // The agent may have rewritten the file: reload, mark what changed.
  fileWsReloadAfterRun(ws, run).then(summary => {
    if (!host || fileWs !== ws) return;
    host.innerHTML = `<div class="fw-run settled"><span>${esc(status)}</span><b>${esc(run.title || '')}</b><span class="fw-run-status">${esc(summary)}</span><button type="button" class="ghost" data-run-open>open conversation</button>${summary.includes('+') || summary.includes('−') ? '<button type="button" class="ghost" data-run-history>history</button>' : ''}</div>`;
    host.querySelector('[data-run-open]').onclick = () => open(run.key, 'bottom');
    const h = host.querySelector('[data-run-history]');
    if (h) h.onclick = () => liveFileHistory(ws);
  });
}

async function fileWsReloadAfterRun(ws, run) {
  let d;
  try { d = await (await fetch('/api/file/read?path=' + encodeURIComponent(ws.path))).json(); } catch { return 'could not re-read the file'; }
  if (fileWs !== ws || d.error) return d && d.error ? d.error : '';
  if (d.sha === run.preSha) return 'the file did not change';
  const before = run.preText || '';
  if (ws.kind === 'md' && docState && docState.path === ws.path) {
    if (docState.dirty) return 'the file changed on disk while you had edits — reload from disk to see them';
    docState.editor.setContent(d.text);
    docState.sha = d.sha;
    docState.dirty = false;
    if ($('docReload')) $('docReload').hidden = true;
  } else if (ws.kind === 'code' && ws.editor) {
    const sel = ws.editor.selection();
    ws.editor.setContent(d.text);
    ws.baseText = d.text; ws.sha = d.sha; ws.dirty = false;
    if ($('fwSave')) $('fwSave').disabled = true;
    try { ws.editor.gotoLine(sel.line); } catch {}
  }
  // The gutter keeps the opening text as its baseline, so the agent's
  // lines show as changes; the disk baseline moves to what was just read.
  liveFileSaved(ws, d.text, d.sha);
  const stats = typeof LineDiff !== 'undefined' ? LineDiff.scriptStats(LineDiff.diffLines(before, d.text)) : null;
  return stats ? `agent changed +${stats.added} −${stats.removed} lines` : 'agent changed the file';
}

let whoStripTimer = null;

function fileWsFileActivity(d) {
  fbActivity(d);
  const ws = fileWs;
  if (!ws || !ws.path || d.path !== ws.path) return;
  if (ws.run) return; // the run's own settle handles the reload
  if (ws.mode === 'write' && ws.editor) liveFileActivity(ws);
}
