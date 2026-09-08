'use strict';
// filesmode.js — files mode: the inverted funnel (design/33-files-mode.md).
//
// Loaded before app.html's main script; every helper it needs (router,
// Gantt geometry, the focused-file machinery, the MRMD editor mount) is a
// global of that script and is resolved at call time.
//
// The lens changes three things and nothing else: what home shows (file
// rows), what a project click opens (README + tree), and what "back"
// means inside shared views. The file workspace itself is lens-agnostic.

// ---- lens ----
let lens = localStorage.getItem('aiconvo.lens') === 'files' ? 'files' : 'conv';
const FILE_LANE_H = 20;
const FILES_ROWS_PER_PROJECT = 12;
const FILES_ROWS_FILTERED = 80;
let filesData = null;         // /api/files/timeline response (whole span, capped per project)
let filesDataKey = '';        // kind + project filter the data was fetched for
let filesFetchSeq = 0;
let filesRefreshTimer = null;
let filesKind = localStorage.getItem('aiconvo.filesKind') || 'all';   // all | docs | code
if (!['all', 'docs', 'code'].includes(filesKind)) filesKind = 'all';
let filesOpenProjects = new Set(); // projects whose full row list is unfolded at home

function applyLensChrome() {
  document.body.classList.toggle('lens-files', lens === 'files');
  const btn = $('lensBtn');
  if (btn) {
    btn.querySelectorAll('[data-lens]').forEach(b => b.classList.toggle('on', b.dataset.lens === lens));
    btn.title = lens === 'files' ? 'Files mode: home shows files and their edits · press F for conversations' : 'Conversations mode · press F for files';
  }
  const ft = $('ftabs');
  if (ft) ft.querySelectorAll('[data-ftab]').forEach(b => b.classList.toggle('on', b.dataset.ftab === (tab === 'repos' ? 'repos' : filesKind)));
  const sel = $('selShown');
  if (sel) sel.hidden = lens === 'files' || tab !== 'conv';
}

// Switch the lens. Home and project views re-render in place; every other
// view stays where it is (its breadcrumb root changes on the next paint).
function setLens(next, { navigate = true } = {}) {
  next = next === 'files' ? 'files' : 'conv';
  const changed = next !== lens;
  lens = next;
  try { localStorage.setItem('aiconvo.lens', lens); } catch {}
  applyLensChrome();
  if (!navigate) return;
  if (viewKind === 'home' || viewKind === 'files-home') return goHome();
  if (viewKind === 'project' || viewKind === 'files-project') {
    const name = projectOverviewName;
    if (name) return lens === 'files' ? showFilesProject(name) : showProjectOverview(name);
  }
  if (changed) toast(lens === 'files' ? 'files mode · ⌂ shows files and their edits' : 'conversations mode');
}

function initFilesMode() {
  const brand = $('brand');
  if (brand && !$('lensBtn')) {
    const el = document.createElement('span');
    el.id = 'lensBtn';
    el.setAttribute('role', 'tablist');
    el.innerHTML = `<button type="button" data-lens="conv" title="Conversations mode (F toggles)">conv</button><button type="button" data-lens="files" title="Files mode: home is a Gantt of file edits (F toggles)">files</button>`;
    brand.insertAdjacentElement('afterend', el);
    el.querySelectorAll('[data-lens]').forEach(b => b.onclick = () => setLens(b.dataset.lens));
  }
  const tabs = $('tabs');
  if (tabs && !$('ftabs')) {
    const ft = document.createElement('div');
    ft.id = 'ftabs';
    ft.innerHTML = `<button data-ftab="all">files</button><button data-ftab="docs" title="Markdown, notebooks, text">docs</button><button data-ftab="code" title="Everything that is not prose">code</button><button data-ftab="repos" title="Local Git repositories and worktrees">repos</button>`;
    tabs.insertAdjacentElement('afterend', ft);
    ft.querySelectorAll('[data-ftab]').forEach(b => b.onclick = () => {
      if (b.dataset.ftab === 'repos') return setTab('repos');
      filesKind = b.dataset.ftab;
      try { localStorage.setItem('aiconvo.filesKind', filesKind); } catch {}
      if (tab === 'repos') { tab = 'conv'; delete $('list').dataset.initScroll; }
      applyLensChrome();
      render();
    });
  }
  applyLensChrome();
}
document.addEventListener('DOMContentLoaded', initFilesMode);

// ---- home, files lens ----
function filesHash() { return 'files'; }

let filesInflight = null; // { key, promise } — one fetch per key at a time
async function filesEnsureData(force = false) {
  const project = $('ganttProject') ? $('ganttProject').value : '';
  const key = filesKind + '\0' + project;
  if (filesData && filesDataKey === key && !force) return filesData;
  if (filesInflight && filesInflight.key === key && !force) return filesInflight.promise;
  const seq = ++filesFetchSeq;
  const cap = project ? FILES_ROWS_FILTERED : 60;
  const promise = (async () => {
    let d;
    try { d = await (await fetch('/api/files/timeline?kind=' + encodeURIComponent(filesKind) + (project ? '&project=' + encodeURIComponent(project) : '') + '&cap=' + cap)).json(); }
    catch { d = { error: 'network failure' }; }
    if (filesInflight && filesInflight.key === key) filesInflight = null;
    if (seq !== filesFetchSeq) return filesData;
    if (d.error) { errToast('files: ' + d.error); return filesData; }
    filesData = filesInflate(d);
    filesDataKey = key;
    return filesData;
  })();
  filesInflight = { key, promise };
  return promise;
}

function filesRefreshSoon(ms = 2500) {
  clearTimeout(filesRefreshTimer);
  filesRefreshTimer = setTimeout(async () => {
    if (lens !== 'files' || viewKind !== 'home') { filesData = null; return; }
    await filesEnsureData(true);
    render();
  }, ms);
}

// One lane per file inside each project row; projects sorted like the
// conversation chart (recent / alpha / born / size). Rows are capped per
// project; a "+K more" cell unfolds them for one project.
function filesLayout(data) {
  const projects = (data.projects || []).map(p => ({ project: p.project, latest: p.latest, count: p.files, rows: p.rows, more: p.more, cwd: p.cwd, born: 0 }));
  const filtered = projects.filter(p => !projFilterActive() || projFuzzyMatch(p.project));
  sortProjectRows(filtered);
  let baseLane = 0;
  const lanes = [];
  for (const p of filtered) {
    const cap = filesOpenProjects.has(p.project) || $('ganttProject').value ? FILES_ROWS_FILTERED : FILES_ROWS_PER_PROJECT;
    const shown = p.rows.slice(0, cap);
    p.hidden = p.rows.length - shown.length + (p.more || 0);
    p.shownRows = shown;
    p.baseLane = baseLane;
    // Lane 0 of a project is its head (name and count); files follow.
    p.laneCount = 1 + shown.length + (p.hidden ? 1 : 0);
    shown.forEach((row, i) => { row.lane = baseLane + 1 + i; row.project = p.project; lanes.push(row); });
    baseLane += p.laneCount;
  }
  return { projects: filtered, laneCount: baseLane, lanes };
}

function filesActorGlyph(actor) {
  return actor === 'ai' ? '⚇' : actor === 'human' ? '✎' : actor === 'git' ? '◆' : '◇';
}

function filesConvTitle(key) {
  const s = key && sessions.find(x => x.key === key);
  return s ? (s.timelineTitle || s.title || key) : key;
}

// Sessions reference conversations by index into data.convs; resolve
// once per fetch so the chart code reads plain fields.
function filesInflate(d) {
  const convs = d.convs || [];
  const live = d.live || [];
  for (const p of d.projects || []) for (const row of p.rows) for (const s of row.sessions) {
    if (s.conv !== null && s.conv !== undefined) { s.convKey = convs[s.conv] || null; s.live = !!live[s.conv]; }
  }
  return d;
}

function filesSessionTip(row, s) {
  const who = s.actor === 'ai' ? `agent · ${filesConvTitle(s.convKey) || 'conversation'}${s.twins ? ` (+${s.twins} fork twins)` : ''}`
    : s.actor === 'human' ? 'you · aiconvo editor' : 'external write (unexplained)';
  const span = s.end > s.start ? `${fmtDate(s.start)} → ${fmtDate(s.end)}` : fmtDate(s.start);
  const mag = s.approx ? `≈${s.chars} chars (from lines)` : `${s.chars} chars`;
  return `${row.rel}\n${who}\n${span}\n+${s.added} −${s.removed} lines · ${s.n} edit${s.n === 1 ? '' : 's'} · ${mag}${s.failed ? ` · ${s.failed} failed` : ''}${s.live ? '\n● conversation active' : ''}\nclick: open the file at this change${s.actor === 'ai' ? ' · shift+click: the conversation' : ''}`;
}

function renderFilesTimeline() {
  const list = $('list');
  if (!list) return;
  if (!filesData || filesDataKey !== filesKind + '\0' + $('ganttProject').value) {
    if (!filesData) list.innerHTML = '<div class="empty">reading the file ledger…</div>';
    filesEnsureData().then(() => { if (lens === 'files' && viewKind === 'home') render(); });
    if (!filesData) return;
  }
  const data = filesData;
  // First content paint in this tab scrolls to now; later paints keep the
  // position (an empty placeholder must not pin the chart at its start).
  if (!list.querySelector('.files-timeline')) delete list.dataset.initScroll;
  const st = list.scrollTop, sl = list.scrollLeft;
  const layout = filesLayout(data);
  $('count').textContent = `${layout.lanes.length} files · ${layout.projects.length} projects · last 90 days${data.backfilling ? ' · ledger filling…' : ''}`;
  if (!layout.lanes.length) {
    list.innerHTML = `<div class="empty">no file edits on record${data.backfilling ? ' yet — the ledger is still reading transcripts' : ''}.<div class="hint">edits made by agents, in the aiconvo editor, in Git commits, and on disk appear here as they happen.</div></div>`;
    timelineGeom = null;
    $('projSort').hidden = true;
    return;
  }
  const now = Date.now();
  const starts = [];
  for (const row of layout.lanes) { for (const s of row.sessions) starts.push(s.start); for (const c of row.commits) starts.push(c.ts); }
  const oldest = starts.length ? Math.min(...starts) : now - DAY_MS;
  const scale = pxDay();
  const spanPx = (now - oldest) / DAY_MS * scale;
  const gutter = filesGutterW();
  const chartW = Math.max(list.clientWidth, gutter + spanPx + MARGIN_R);
  const chartH = Math.max(list.clientHeight, LABEL_H + layout.laneCount * FILE_LANE_H + 10);
  const xFor = t => gutter + spanPx - (now - t) / DAY_MS * scale;
  // Ticks only near the viewport (hour zoom over months is a lot of lines).
  let tickOldest = oldest, tickNewest = now;
  if (list.clientWidth && scale) {
    const visibleStart = now - Math.max(0, (list.scrollWidth - list.scrollLeft - list.clientWidth + MARGIN_R) / scale) * DAY_MS;
    const visibleEnd = now - Math.max(0, (list.scrollWidth - list.scrollLeft - MARGIN_R) / scale) * DAY_MS;
    const pad = list.clientWidth / scale * DAY_MS;
    tickOldest = Math.max(oldest, visibleStart - pad);
    tickNewest = Math.min(now, Math.max(oldest, visibleEnd + pad));
  }
  const ticks = timelineTicks(tickOldest, tickNewest).map(({ t, major, label }) => {
    const p = xFor(t);
    if (p < 0 || p > chartW) return '';
    return `<g class="tday${major ? ' major' : ''}"><line x1="${p}" y1="0" x2="${p}" y2="${chartH}"/>${label == null ? '' : `<text x="${p + 4}" y="11">${esc(label)}</text>`}</g>`;
  }).join('');
  const nx = xFor(now);
  const nowLine = `<g class="tnow"><line x1="${nx}" y1="0" x2="${nx}" y2="${chartH}"/><text x="${nx - 4}" y="11" text-anchor="end">now</text></g>`;
  const rowsBg = layout.projects.map(p => `<rect class="project-row-bg" data-project-bg="${esc(p.project)}" x="0" y="${LABEL_H + p.baseLane * FILE_LANE_H}" width="${chartW}" height="${p.laneCount * FILE_LANE_H}"/>
    <g class="tday"><line x1="0" y1="${LABEL_H + (p.baseLane + p.laneCount) * FILE_LANE_H}" x2="${chartW}" y2="${LABEL_H + (p.baseLane + p.laneCount) * FILE_LANE_H}"/></g>`).join('');
  // Marks: only lanes near the viewport get DOM (same culling as home).
  const viewport = Math.max(1, list.clientWidth);
  const left = list.dataset.initScroll ? list.scrollLeft : Math.max(0, chartW - viewport);
  const pad = viewport * 0.75;
  list.dataset.renderWindow = String(Math.floor(left / Math.max(1, viewport / 2)));
  const inWindow = (a, b) => xFor(b) >= left - pad && xFor(a) <= left + viewport + pad;
  const laneScale = FILE_LANE_H / PROJECT_LANE_H;
  const color = projectColor();
  const marks = [];
  for (const row of layout.lanes) {
    const cy = LABEL_H + row.lane * FILE_LANE_H + FILE_LANE_H / 2;
    for (const s of row.sessions) {
      if (!inWindow(s.start, s.end)) continue;
      const x0 = xFor(s.start), x1 = Math.max(x0 + 5, xFor(s.end));
      const bins = s.bins && s.bins.length ? s.bins : [1];
      const failed = s.n > 0 && s.failed === s.n;
      marks.push(`<g class="tmark fmark a-${esc(s.actor)}${failed ? ' failed' : ''}${s.live ? ' active' : ''}" data-fpath="${esc(row.path)}" data-fproject="${esc(row.project)}" data-factor="${esc(s.actor)}" data-fconv="${esc(s.convKey || '')}" data-ffirst="${esc(s.first || '')}" data-flast="${esc(s.last || '')}" tabindex="0">
        <title>${esc(filesSessionTip(row, s))}</title>
        <line class="duration" style="stroke:${color.stroke}" x1="${x0}" y1="${cy}" x2="${x1}" y2="${cy}"/>
        <path class="violin" style="fill:${color.fill};stroke:${color.stroke}" d="${violinPath(x0, x1, cy, bins, false, laneScale)}"/>
        ${s.live ? `<circle class="livedot" cx="${x1}" cy="${cy}" r="2.6"/>` : ''}
      </g>`);
    }
    for (const c of row.commits) {
      if (!inWindow(c.ts, c.ts)) continue;
      const x = xFor(c.ts);
      marks.push(`<g class="tmark fcommit" data-fpath="${esc(row.path)}" data-fproject="${esc(row.project)}" data-fcommit="${esc(c.hash)}" data-frepo="${esc(row.repoRoot || '')}" tabindex="0"><title>${esc(row.rel)}\n◆ commit ${esc(String(c.hash).slice(0, 10))}${c.subject ? ' · ' + esc(c.subject) : ''}\n${fmtDate(c.ts)} · +${c.added} −${c.removed}\nclick: the commit patch</title><path d="M ${x},${cy - 4.5} L ${x + 4.5},${cy} L ${x},${cy + 4.5} L ${x - 4.5},${cy} Z"/></g>`);
    }
  }
  const defs = `<defs><pattern id="aiHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${color.fill}"/><line x1="0" y1="0" x2="0" y2="4" stroke="${color.stroke}" stroke-width="1.2"/></pattern></defs>`;
  list.innerHTML = `<div class="timeline files-timeline" style="width:${chartW}px;height:${chartH}px">${filesLabelsHtml(layout)}${svgTagFor(list, chartW, chartH)}${defs}${rowsBg}${ticks}${nowLine}${marks.join('')}</svg></div>`;
  timelineGeom = null; // rubber-band selection is a conversation tool
  $('projSort').hidden = false;
  renderProjSortBtns();
  ensureProjectStats();
  applyProjectRowHl();
  scrollTimeline(list, st, sl);
}

const FILES_GUTTER = 236;
function filesGutterW() { return phoneDevice() ? 34 : FILES_GUTTER; }

function filesLabelsHtml(layout) {
  const phone = phoneDevice();
  const w = filesGutterW();
  const bornCell = `<div class="project-new-cell" data-new-project tabindex="0" title="Create a project or add an existing folder (P)">${phone ? '+' : '+ new project'}</div>`;
  return `<div class="project-labels files-labels${phone ? ' narrow' : ''}" style="width:${w}px">${bornCell}${layout.projects.map(p => {
    const top = LABEL_H + p.baseLane * FILE_LANE_H;
    const height = p.laneCount * FILE_LANE_H;
    const files = p.shownRows.map((row, i) => {
      const parts = row.rel.split('/');
      const name = parts.pop();
      const dir = parts.length ? (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/') + '/' : '';
      const last = row.sessions[row.sessions.length - 1];
      return `<div class="file-row-label" data-file-open="${esc(row.path)}" data-file-project="${esc(p.project)}" style="top:${(1 + i) * FILE_LANE_H}px" title="${esc(row.rel)} · ${row.sessions.length} session${row.sessions.length === 1 ? '' : 's'} · ${row.commits.length} commit${row.commits.length === 1 ? '' : 's'}${last ? ' · last ' + esc(fmtDate(last.end)) : ''}\nclick to open the file"><span class="frl-kind">${row.kind === 'docs' ? '☰' : '⌗'}</span><span class="frl-dir">${esc(dir)}</span><span class="frl-name">${esc(name)}</span></div>`;
    }).join('') + (p.hidden ? `<div class="file-row-label more" data-files-more="${esc(p.project)}" style="top:${(1 + p.shownRows.length) * FILE_LANE_H}px" title="Show every file of ${esc(p.project)} on the chart">+ ${p.hidden} more file${p.hidden === 1 ? '' : 's'}</div>` : '');
    return `<div class="project-row-label files-project-label item" data-project="${esc(p.project)}" style="top:${top}px;height:${height}px" title="${esc(p.project)} · ${p.count} files with edits · click to select the row · double click for the project">
      <div class="fpl-head"><strong>${esc(p.project)}</strong>${phone ? '' : `<span>${p.count} files</span>`}</div>${phone ? '' : `<div class="fpl-files">${files}</div>`}</div>`;
  }).join('')}</div>`;
}

// Clicks on the files chart (delegated from the #list click handler).
function filesListClick(e) {
  const more = e.target.closest('[data-files-more]');
  if (more) { e.stopPropagation(); filesOpenProjects.add(more.dataset.filesMore); render(); return true; }
  const label = e.target.closest('[data-file-open]');
  if (label) { e.stopPropagation(); openFileWorkspace(label.dataset.fileOpen, { project: label.dataset.fileProject }); return true; }
  const mark = e.target.closest('[data-fpath]');
  if (!mark) return false;
  e.stopPropagation();
  if (mark.dataset.fcommit) { openFileWorkspace(mark.dataset.fpath, { project: mark.dataset.fproject, to: 'git:' + mark.dataset.fcommit }); return true; }
  const actor = mark.dataset.factor;
  if (actor === 'ai' && (e.shiftKey || e.ctrlKey || e.metaKey) && mark.dataset.fconv) {
    openConversationAtEvent(mark.dataset.fconv, mark.dataset.ffirst);
    return true;
  }
  if (actor === 'ai' && mark.dataset.ffirst) {
    openFileWorkspace(mark.dataset.fpath, { project: mark.dataset.fproject, from: 'before:' + mark.dataset.ffirst, to: mark.dataset.flast || mark.dataset.ffirst });
    return true;
  }
  openFileWorkspace(mark.dataset.fpath, { project: mark.dataset.fproject });
  return true;
}

async function openConversationAtEvent(key, eventId) {
  let entryId = null;
  try {
    const d = await (await fetch('/api/files/entry?key=' + encodeURIComponent(key) + (eventId ? '&event=' + encodeURIComponent(eventId) : ''))).json();
    entryId = d.entryId || null;
  } catch {}
  return open(key, entryId ? 'entry:' + entryId : undefined);
}

// ---- project, files lens: README + tree + ridge ----
async function showFilesProject(name, opts = {}) {
  if (!name) return;
  markSettingsClosed();
  projectOverviewName = name;
  let d;
  try { d = await (await fetch('/api/files/project?name=' + encodeURIComponent(name))).json(); }
  catch { d = { error: 'network failure' }; }
  if (d.error) {
    setRoute('files-project', 'files&project=' + encodeURIComponent(name));
    $('view').innerHTML = `<div class="empty">could not open ${esc(name)}.<div class="hint">${esc(d.error)}</div></div>`;
    return;
  }
  if (d.readme) return openFileWorkspace(d.readme.path, { project: name, landing: true, projectInfo: d });
  return openFileWorkspace(null, { project: name, landing: true, projectInfo: d });
}

// ---- the file workspace ----
// Tree left, one time track above, the body below: write (editor at now)
// or history (the two-keyframe compare that already existed). Every id the
// focused-file machinery expects (ffTree*, ffTitle, ffTimeline, ffCompare,
// ffMain, diffCard) exists here, so loadFocusedFile / renderFocusedTimeline
// / renderFocusedComparison run unchanged inside this frame.
let fileWs = null;
let fileWsSeq = 0;
window.fileWsSuppressCompare = () => !!(fileWs && fileWs.mode === 'write');

const MD_EXT = /\.(md|markdown|qmd|rmd|mdx)$/i;
function fileWsKind(p) { return MD_EXT.test(String(p || '')) ? 'md' : 'code'; }
function fileWsHash(ws) {
  const parts = ['file'];
  if (ws.project) parts.push('p=' + encodeURIComponent(ws.project));
  if (ws.landing) parts.push('landing');
  if (ws.mode === 'history' && focusedFileCompare) parts.push('from=' + encodeURIComponent(focusedFileCompare.from), 'to=' + encodeURIComponent(focusedFileCompare.to));
  parts.push('path=' + (ws.path || ''));
  return parts.join('&');
}
// `file&p=…&landing&from=…&to=…&path=/abs` (path last: it may contain &)
// and the short `file=/abs`.
function parseFileHash(h) {
  if (h.startsWith('file=')) return { path: h.slice(5) };
  const out = {};
  const at = h.indexOf('&path=');
  if (at >= 0) { out.path = h.slice(at + 6); h = h.slice(0, at); }
  for (const seg of h.split('&').slice(1)) {
    if (seg === 'landing') { out.landing = true; continue; }
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq), v = seg.slice(eq + 1);
    try { out[k === 'p' ? 'project' : k] = decodeURIComponent(v); } catch { out[k === 'p' ? 'project' : k] = v; }
  }
  if (out.line) out.line = Number(out.line);
  return out;
}

function fileWsCloseEditor({ keepDraft = true } = {}) {
  if (!fileWs) return;
  if (fileWs.kind === 'md') { flushAndCloseDocument(); }
  else if (fileWs.editor) {
    if (keepDraft && fileWs.dirty) {
      // Code never autosaves (design §5.3). An unsaved draft survives a
      // navigation in sessionStorage and comes back with a banner.
      try { sessionStorage.setItem('aiconvo.draft:' + fileWs.path, JSON.stringify({ sha: fileWs.sha, text: fileWs.editor.getContent(), at: Date.now() })); } catch {}
    }
    try { fileWs.editor.destroy(); } catch {}
  }
  if (fileWs.editor && fileWs.editor.selection) {
    try {
      const sel = fileWs.editor.selection();
      localStorage.setItem('aiconvo.cursor:' + fileWs.path, String(sel.line));
    } catch {}
  }
  fileWs.editor = null;
}

function closeFileWorkspace() {
  if (!fileWs) return;
  fileWsCloseEditor();
  clearInterval(fileWs.runTick);
  fileWs = null;
}

async function openFileWorkspace(pathValue, opts = {}) {
  const seq = ++fileWsSeq;
  markSettingsClosed();
  if (window.fileInk && fileInk.teardown) fileInk.teardown();
  if (progressStream) { progressStream.close(); progressStream = null; }
  closeFileWorkspace();
  const ws = {
    path: pathValue ? String(pathValue) : null, project: opts.project || null, landing: !!opts.landing, projectInfo: opts.projectInfo || null,
    mode: opts.from || opts.to ? 'history' : 'write', kind: fileWsKind(pathValue), editor: null, sha: null, dirty: false, saving: false,
    touched: null, row: null, seq, line: opts.line || null, back: opts.back || null,
  };
  fileWs = ws;
  setRouteKind(ws.landing ? 'files-project' : 'file');
  if (ws.landing) projectOverviewName = ws.project;
  // Data, in parallel: who touched it, the disk file, and the project tree.
  const touchedReq = ws.path ? fetch('/api/files/touched?path=' + encodeURIComponent(ws.path)).then(r => r.json()).catch(() => ({ error: 'network failure' })) : Promise.resolve(null);
  const touched = await touchedReq;
  if (fileWs !== ws) return;
  ws.touched = touched && !touched.error ? touched : { sessions: [], commits: [], repoRoot: '', project: '' };
  if (!ws.project) ws.project = ws.touched.project || null;
  setRoute(ws.landing ? 'files-project' : 'file', ws.landing ? 'files&project=' + encodeURIComponent(ws.project || '') : fileWsHash(ws));
  const rel = ws.path ? fileWsRel(ws) : '';
  $('view').innerHTML = `<div class="focused-file-view project-code files-ws${ws.landing ? ' landing' : ''}">
    <div class="fw-head">
      <button id="fwBack" title="${ws.landing ? 'Back to the files chart' : ws.project ? 'Back to ' + esc(ws.project) : 'Back'}">${ws.landing ? '← files' : '← ' + esc(ws.project || 'back')}</button>
      <button id="fwTreeToggle" class="mobile-only" type="button">files</button>
      ${ws.landing ? `<h1 class="fw-project">${esc(ws.projectInfo && ws.projectInfo.title || ws.project)}</h1>` : ''}
      <b id="ffTitle" class="fw-title" title="${esc(ws.path || '')}">${esc(rel)}</b>
      <span class="fw-who" id="fwWho"></span>
      <span class="fw-spacer"></span>
      <nav class="fw-mode" role="tablist"><button data-fw-mode="write" role="tab" class="${ws.mode === 'write' ? 'on' : ''}" title="Edit the current file (n)">write</button><button data-fw-mode="history" role="tab" class="${ws.mode === 'history' ? 'on' : ''}" title="Compare two moments of this file (h)">history</button></nav>
      <button id="fwAskBtn" class="primary" title="Ask an agent for a change to this file — the file, your cursor, its recent edits, and the project map go along (Ctrl+K)">✎ ask for a change</button>
      ${ws.project ? `<button id="fwMemory" class="ghost" title="The project overview: generated memory, epics, areas">memory ▸</button>` : ''}
    </div>
    ${ws.landing ? '<div class="fw-ridge" id="fwRidge"></div>' : ''}
    <div class="ff-layout"><aside class="ff-tree" id="ffTree"><input id="ffTreeSearch" type="search" placeholder="filter all files"><div class="ff-tree-summary" id="ffTreeSummary"></div><div id="ffTreeBody" class="dim">reading the project tree…</div></aside>
      <main class="ff-main" id="ffMain"><div class="ff-timeline" id="ffTimeline"></div><div class="ff-compare" id="ffCompare"><div class="ff-loading">${ws.path ? 'opening…' : ''}</div></div><div class="diff-card" id="diffCard" hidden></div><div class="fw-ask" id="fwAsk" hidden></div></main></div></div>`;
  $('fwBack').onclick = () => fileWsBack(ws);
  $('fwTreeToggle').onclick = () => {
    const root = $('fwTreeToggle').closest('.focused-file-view');
    const openTree = root.classList.toggle('show-tree');
    $('fwTreeToggle').textContent = openTree ? 'file' : 'files';
  };
  $('view').querySelectorAll('[data-fw-mode]').forEach(b => b.onclick = () => b.dataset.fwMode === 'write' ? fileWsEnterWrite() : fileWsEnterHistory());
  $('fwAskBtn').onclick = () => fileWsToggleAsk();
  if ($('fwMemory')) $('fwMemory').onclick = () => showProjectOverview(ws.project);
  renderWhoStrip(ws);
  if (ws.landing) renderProjectRidge(ws);
  // The project tree (light file history: paths + 24 h badges; it also
  // seeds and watches the repositories on the server).
  fileWsLoadTree(ws).catch(e => console.error('file workspace tree', e));
  if (!ws.path) {
    $('ffCompare').innerHTML = `<div class="empty">no README in ${esc(ws.project || 'this project')} yet.<div class="hint">The README is the landing page for people and agents alike.</div><button id="fwCreateReadme" class="primary">create README.md</button></div>`;
    $('fwCreateReadme').onclick = async () => {
      const out = await postJson('/api/files/readme', { project: ws.project });
      if (out.error) return errToast(out.error);
      toast('✓ README.md created');
      showFilesProject(ws.project);
    };
    return;
  }
  await fileWsMountBody(ws, opts);
}

function fileWsRel(ws) {
  const root = ws.touched && ws.touched.repoRoot;
  if (root && ws.path.startsWith(root + '/')) return ws.path.slice(root.length + 1);
  return ws.path.replace(/^\/home\/[^/]+\//, '~/');
}

function fileWsBack(ws) {
  if (ws.back) return dispatchHash(ws.back);
  if (ws.landing) { setLens('files', { navigate: false }); return goHome(); }
  if (ws.project) return lens === 'files' ? showFilesProject(ws.project) : showProjectOverview(ws.project);
  return goHome();
}

async function fileWsLoadTree(ws) {
  if (!ws.project) { $('ffTreeBody').innerHTML = '<div class="dim">not inside a project</div>'; return; }
  let data = fileHistoryData && fileHistoryData.project === ws.project && fileHistoryData.projectCode ? fileHistoryData : null;
  if (!data) {
    data = await (await fetch('/api/project/file-history?name=' + encodeURIComponent(ws.project) + '&light=1')).json();
    if (fileWs !== ws) return;
    if (data.error) { $('ffTreeBody').innerHTML = `<div class="dim">${esc(data.error)}</div>`; return; }
    data.projectCode = true;
    invalidateFileCaches();
    fileHistoryData = data;
  }
  diffScope = { scope: 'project' };
  focusedFileWindow = null;
  ws.row = fileWsRowFor(ws, data);
  focusedFileRow = ws.row;
  $('ffTreeBody').classList.remove('dim');
  fileWsPaintTree(ws);
  $('ffTreeSearch').oninput = e => fileWsPaintTree(ws, e.target.value);
  // The time track needs the row; mount it now that the row exists.
  if (ws.path) fileWsLoadTrack(ws);
}

function fileWsRowFor(ws, data) {
  if (!ws.path) return null;
  const hit = (data.rows || []).find(r => r.path === ws.path);
  if (hit) return hit;
  const root = ws.touched.repoRoot || (data.repositories && data.repositories[0] && data.repositories[0].root) || ws.path.split('/').slice(0, -1).join('/');
  const repo = (data.repositories || []).find(r => r.root === root);
  const relativePath = ws.path.startsWith(root + '/') ? ws.path.slice(root.length + 1) : ws.path.split('/').pop();
  return { id: 'ws:' + ws.path, repoId: repo ? repo.id : 'ws', repoRoot: root, relativePath, path: ws.path, aiEvents: [], commitEvents: [], workingTree: null, current: true, recent24: null, synthetic: true };
}

function fileWsPaintTree(ws, query = '') {
  if (!$('ffTreeBody') || !fileHistoryData) return;
  const rows = fileHistoryData.rows || [];
  $('ffTreeBody').innerHTML = fileTreeHtml(rows, ws.row || { id: '' }, String(query || '').trim().toLowerCase());
  updateFocusedTreeWindow();
  $('ffTreeBody').querySelectorAll('[data-ff-file]').forEach(button => button.onclick = () => {
    const row = rows.find(item => item.id === button.dataset.ffFile);
    if (row) openFileWorkspace(row.path, { project: ws.project, back: ws.back });
  });
  // Keep the open file visible in the tree.
  const on = $('ffTreeBody').querySelector('.ff-file.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

// The time track above the body: the focused-file timeline (points +
// two keyframes) painted by loadFocusedFile. In write mode the compare
// itself is suppressed (fileWsSuppressCompare) and the editor stays.
async function fileWsLoadTrack(ws, selection = null) {
  if (!ws.row || fileWs !== ws) return;
  const sel = selection || (ws.mode === 'history' ? ws.historySel || {} : { to: 'current' });
  await loadFocusedFile(ws.row, sel, { keepTree: true, quiet: ws.mode === 'write' });
  if (fileWs !== ws) return;
  const tl = $('ffTimeline');
  if (tl && !tl.dataset.fwWired) {
    tl.dataset.fwWired = '1';
    // Any keyframe interaction is a request for history.
    const toHistory = () => { if (fileWs === ws && ws.mode === 'write') fileWsEnterHistory({ fromTrack: true }); };
    tl.addEventListener('pointerdown', e => { if (e.target.closest('.ff-key, .ff-point, .ff-track')) toHistory(); }, true);
    tl.addEventListener('input', toHistory, true);
    tl.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && e.target.closest('.ff-key')) toHistory(); }, true);
  }
  if (ws.mode === 'history') fileWsPaintModeChrome(ws);
}

function fileWsPaintModeChrome(ws) {
  $('view').querySelectorAll('[data-fw-mode]').forEach(b => b.classList.toggle('on', b.dataset.fwMode === ws.mode));
  const root = $('view').querySelector('.files-ws');
  if (root) root.classList.toggle('history', ws.mode === 'history');
}

async function fileWsEnterHistory({ fromTrack = false } = {}) {
  const ws = fileWs;
  if (!ws || !ws.row) return;
  if (ws.mode === 'history' && !fromTrack) return;
  fileWsCloseEditor();
  ws.mode = 'history';
  fileWsPaintModeChrome(ws);
  setRoute('file', fileWsHash(ws));
  if (!fromTrack) {
    // Explicit switch: show the newest change — the last point vs the one
    // before it — unless a compare is already on screen.
    const points = (focusedFileCompare && focusedFileCompare.points) || [];
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    await loadFocusedFile(ws.row, last ? { from: prev ? prev.id : last.id, to: last.id } : {}, { keepTree: true });
  }
}

async function fileWsEnterWrite() {
  const ws = fileWs;
  if (!ws || ws.mode === 'write') return;
  ws.mode = 'write';
  fileWsPaintModeChrome(ws);
  setRoute('file', fileWsHash(ws));
  await fileWsMountBody(ws, {});
  // The track returns to "now" without repainting the body.
  if (ws.row) loadFocusedFile(ws.row, { to: 'current' }, { keepTree: true, quiet: true }).catch(() => {});
}

// Resolve an AI-session selection into keyframe ids: "before:<eventId>"
// means the point just before that event.
function fileWsResolveSelection(opts) {
  const sel = {};
  if (opts.to) sel.to = opts.to;
  if (opts.from && !String(opts.from).startsWith('before:')) sel.from = opts.from;
  if (opts.from && String(opts.from).startsWith('before:')) sel.before = opts.from.slice(7);
  return sel;
}

async function fileWsMountBody(ws, opts) {
  if (fileWs !== ws) return;
  if (ws.mode === 'history') {
    const sel = fileWsResolveSelection(opts);
    ws.historySel = sel;
    if (!ws.row) {
      // The tree load mounts the track; make sure history lands once the row exists.
      const wait = setInterval(() => { if (fileWs !== ws) return clearInterval(wait); if (ws.row) { clearInterval(wait); fileWsMountHistory(ws, sel); } }, 60);
      return;
    }
    return fileWsMountHistory(ws, sel);
  }
  fileWsPaintModeChrome(ws);
  if (ws.kind === 'md') await fileWsMountMarkdown(ws, opts);
  else await fileWsMountCode(ws, opts);
}

async function fileWsMountHistory(ws, sel) {
  if (fileWs !== ws || !ws.row) return;
  fileWsPaintModeChrome(ws);
  if (sel.before) {
    // Need the point list to find "the one before".
    try {
      const doc = await filePointsFor(ws.row);
      const at = doc.points.findIndex(p => p.id === sel.before);
      const prev = at > 0 ? doc.points[at - 1] : doc.points[0];
      sel = { from: prev ? prev.id : undefined, to: sel.to || sel.before };
    } catch { sel = { to: sel.to }; }
  }
  ws.historySel = sel;
  await loadFocusedFile(ws.row, sel, { keepTree: true });
}

// ---- write mode: markdown (MRMD) ----
async function fileWsMountMarkdown(ws, opts) {
  const host = $('ffCompare');
  if (!host) return;
  host.innerHTML = `<div class="doc-view">${documentHeadHtml(ws.path, null)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-editor-host"><div id="docEditor"></div></div></div>`;
  await mountDocumentEditor(ws.path, ws.project);
  if (fileWs !== ws || !docState || docState.path !== ws.path) return;
  ws.editor = docState.editor;
  ws.sha = docState.sha;
  fileWsAfterMount(ws, opts);
}

// ---- write mode: code (CodeMirror from the same vendored bundle) ----
function codeHeadHtml(ws) {
  const name = ws.path.split('/').pop();
  return `<div class="doc-head code-head">
    <b class="doc-title" title="${esc(ws.path)}">${esc(name)}</b>
    <span class="dim" id="docStatus">loading…</span>
    <button id="docReload" hidden title="The disk file changed — reload it (your unsaved edits are lost)">reload from disk</button>
    <span class="trust-slot" id="fwTrust"></span>
    <button id="fwSave" class="primary" disabled title="Write the file to disk · Ctrl+S (code never autosaves)">save</button>
  </div>`;
}

async function fileWsMountCode(ws, opts) {
  const host = $('ffCompare');
  if (!host) return;
  host.innerHTML = `<div class="doc-view code-view">${codeHeadHtml(ws)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-editor-host code-host"><div id="codeEditor"></div></div></div>`;
  let bundle, d;
  try {
    [bundle, d] = await Promise.all([loadMrmdDocument(), fetch('/api/file/read?path=' + encodeURIComponent(ws.path)).then(r => r.json())]);
  } catch (e) { host.innerHTML = `<div class="empty">could not open the file.<div class="hint">${esc(e.message)}</div></div>`; return; }
  if (fileWs !== ws || !$('codeEditor')) return;
  if (d.error) {
    host.innerHTML = `<div class="empty">could not read the file.<div class="hint">${esc(d.error)}</div></div>`;
    return;
  }
  if (!bundle.createCodeEditor) { host.innerHTML = '<div class="empty">the editor bundle is too old for code files.<div class="hint">reload the app once; the new bundle is served now.</div></div>'; return; }
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
    status(ws.dirty ? 'unsaved · Ctrl+S writes to disk' : 'saved');
  };
  ws.baseText = d.text;
  ws.editor = bundle.createCodeEditor($('codeEditor'), {
    doc: text, filename: ws.path, theme: mrmdHostTheme(),
    onChange: markDirty,
    onSave: () => fileWsSaveCode(ws),
    onMarkClick: (line, info) => { if (info && info.convKey) openConversationAtEvent(info.convKey, info.eventId); },
  });
  $('fwSave').onclick = () => fileWsSaveCode(ws);
  $('docReload').onclick = () => fileWsReloadCode(ws);
  if (draft) {
    ws.dirty = true;
    $('fwSave').disabled = false;
    fileWsBanner(ws, `an unsaved draft from ${ago(Date.now() - draft.at)} ago was restored — save it, or reload from disk to drop it`, [['reload from disk', () => fileWsReloadCode(ws, { dropDraft: true })]]);
    if (draft.sha !== d.sha) fileWsBanner(ws, 'the draft was made on an older version of this file — the disk changed since. Review before saving.', [['see history', () => fileWsEnterHistory()], ['reload from disk', () => fileWsReloadCode(ws, { dropDraft: true })]]);
  } else status('saved · code never autosaves — Ctrl+S writes to disk');
  fileWsAfterMount(ws, opts);
  fileWsTrustGutter(ws);
}

async function fileWsSaveCode(ws) {
  if (fileWs !== ws || !ws.editor || ws.saving) return;
  const text = ws.editor.getContent();
  if (text === ws.baseText) return;
  ws.saving = true;
  $('fwSave').disabled = true;
  const out = await postJson('/api/file/save', { path: ws.path, baseSha: ws.sha, text });
  ws.saving = false;
  if (fileWs !== ws) return;
  if (out.error) {
    $('fwSave').disabled = false;
    if (String(out.error).includes('changed on disk')) {
      fileWsBanner(ws, 'the file changed on disk after you loaded it — your text is kept here; compare before overwriting', [['see history', () => fileWsEnterHistory()], ['reload from disk (drops your edits)', () => fileWsReloadCode(ws, { dropDraft: true })], ['overwrite anyway', () => fileWsForceSave(ws)]]);
    }
    return errToast('save failed: ' + out.error);
  }
  ws.sha = out.sha;
  ws.baseText = text;
  ws.dirty = false;
  try { sessionStorage.removeItem('aiconvo.draft:' + ws.path); } catch {}
  const el = $('docStatus'); if (el) el.textContent = 'saved · ' + new Date().toLocaleTimeString();
  fileWsBanner(ws, null);
  toast('saved · ' + fileWsRel(ws));
  invalidateFileCaches(ws.row && ws.row.id);
  fileWsTrustGutter(ws);
}

async function fileWsForceSave(ws) {
  if (fileWs !== ws || !ws.editor) return;
  const text = ws.editor.getContent();
  const out = await postJson('/api/file/save', { path: ws.path, text });
  if (out.error) return errToast('save failed: ' + out.error);
  ws.sha = out.sha; ws.baseText = text; ws.dirty = false;
  try { sessionStorage.removeItem('aiconvo.draft:' + ws.path); } catch {}
  fileWsBanner(ws, null);
  toast('overwrote the disk file');
  invalidateFileCaches(ws.row && ws.row.id);
}

async function fileWsReloadCode(ws, { dropDraft = false, quiet = false } = {}) {
  if (fileWs !== ws || !ws.editor) return;
  let d;
  try { d = await (await fetch('/api/file/read?path=' + encodeURIComponent(ws.path))).json(); } catch { d = { error: 'network failure' }; }
  if (fileWs !== ws || !ws.editor) return;
  if (d.error) return errToast(d.error);
  const before = ws.baseText;
  const sel = ws.editor.selection();
  ws.editor.setContent(d.text);
  ws.baseText = d.text; ws.sha = d.sha; ws.dirty = false;
  if (dropDraft) try { sessionStorage.removeItem('aiconvo.draft:' + ws.path); } catch {}
  $('fwSave').disabled = true;
  $('docReload').hidden = true;
  try { ws.editor.gotoLine(sel.line); } catch {}
  fileWsBanner(ws, null);
  fileWsMarkChanged(ws, before, d.text, quiet ? 'reloaded' : 'reloaded from disk');
}

// After a reload: mark the lines that changed (code gutter) and say how much.
function fileWsMarkChanged(ws, before, after, why) {
  const stats = typeof LineDiff !== 'undefined' && LineDiff.diffLines ? LineDiff.scriptStats(LineDiff.diffLines(before, after)) : null;
  const el = $('docStatus');
  const summary = stats ? `+${stats.added} −${stats.removed}` : '';
  if (el) el.textContent = `${why} · ${summary}`.trim();
  if (ws.kind !== 'code' || !ws.editor || !stats || typeof LineDiff === 'undefined') return;
  // The script is one op per line: SAME advances both sides, OLD only the
  // old, NEW only the new. New-side line numbers of NEW ops get a mark.
  const marks = new Map();
  let n = 0;
  for (const op of LineDiff.diffLines(before, after)) {
    if (op === LineDiff.OLD) continue;
    n++;
    if (op === LineDiff.NEW) marks.set(n, { glyph: '+', cls: 'fw-changed', title: why });
  }
  ws.changedMarks = marks;
  fileWsApplyGutter(ws);
}

function fileWsApplyGutter(ws) {
  if (!ws.editor || !ws.editor.setLineMarks) return;
  const all = new Map(ws.trustMarks || []);
  for (const [k, v] of (ws.changedMarks || [])) if (!all.has(k)) all.set(k, v);
  ws.editor.setLineMarks(all);
}

async function fileWsTrustGutter(ws) {
  if (ws.kind !== 'code') return;
  const st = await fetchTrust(ws.path);
  if (fileWs !== ws || !ws.editor || !st || st.error) return;
  const marks = new Map();
  for (const [line, m] of Object.entries(st.lines || {})) marks.set(Number(line), { glyph: m === 'd' ? '✗' : '✓', cls: m === 'd' ? 't-d' : 't-v', title: m === 'd' ? 'disputed' : 'vouched' });
  ws.trustMarks = marks;
  fileWsApplyGutter(ws);
  const slot = $('fwTrust');
  if (slot) {
    slot.innerHTML = `${trustButtonsHtml()}`;
    const sum = slot.querySelector('[data-trust-sum]');
    if (sum) sum.textContent = trustStateText(st);
    slot.querySelectorAll('[data-vouch]').forEach(b => {
      b.onmousedown = e => e.preventDefault();
      b.onclick = async () => {
        const sel = ws.editor.selection();
        const range = sel.empty ? null : [sel.from, sel.to];
        const content = ws.editor.getContent();
        const text = range ? content.split('\n').slice(range[0] - 1, range[1]).join('\n') : content;
        const action = b.dataset.vouch === 'x' ? 'dispute' : 'vouch';
        const note = action === 'dispute' ? (prompt('what is wrong here? (optional note)') || '') : '';
        const out = await postVouch({ action, path: ws.path, range, text, note, source: 'file-workspace' });
        if (out.error) return errToast(out.error);
        toast((action === 'dispute' ? '✗ disputed' : '✓ vouched') + (range ? ` · lines ${range[0]}–${range[1]}` : ' · whole file'));
        fileWsTrustGutter(ws);
      };
    });
  }
}

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
  if (ws.editor.view && ws.editor.view.dom) {
    ws.editor.view.dom.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); fileWsToggleAsk(true); }
    });
  }
}

// ---- who touched this file ----
function renderWhoStrip(ws) {
  const host = $('fwWho');
  if (!host) return;
  const t = ws.touched || { sessions: [], commits: [] };
  const chips = [];
  const ai = t.sessions.filter(s => s.actor === 'ai').slice(0, 5);
  for (const s of ai) {
    chips.push(`<button type="button" class="fw-chip a-ai${s.live ? ' live' : ''}" data-who-conv="${esc(s.convKey)}" data-who-entry="${esc(s.entryId || '')}" data-who-first="${esc(s.firstEventId || '')}" title="${esc(s.title || s.convKey)}\n${esc(fmtDate(s.start))} · +${s.added} −${s.removed} · ${s.n} edit${s.n === 1 ? '' : 's'}\nclick: open the conversation at its first edit of this file · shift+click: compare this session">⚇ ${esc(String(s.title || 'conversation').slice(0, 22))} <span class="dim">${esc(ago(Date.now() - s.end))}</span></button>`);
  }
  const humans = t.sessions.filter(s => s.actor === 'human');
  if (humans.length) chips.push(`<span class="fw-chip a-human" title="${humans.length} editing session${humans.length === 1 ? '' : 's'} in the aiconvo editor · last ${esc(fmtDate(humans[0].end))}">✎ you · ${humans.length}</span>`);
  const ext = t.sessions.filter(s => s.actor === 'external');
  if (ext.length) chips.push(`<span class="fw-chip a-external" title="${ext.length} write${ext.length === 1 ? '' : 's'} seen on disk that no conversation or editor explains">◇ external · ${ext.length}</span>`);
  if (t.commits.length) chips.push(`<span class="fw-chip a-git" title="${t.commits.length} Git commit${t.commits.length === 1 ? '' : 's'} touch this file · newest ${esc(t.commits[0].shortHash || String(t.commits[0].hash).slice(0, 10))} ${esc(t.commits[0].subject || '')}">◆ ${t.commits.length}</span>`);
  if (t.sessions.length > ai.length + humans.length + ext.length) chips.push(`<span class="dim">…</span>`);
  host.innerHTML = chips.join('') || (ws.path ? '<span class="dim">no recorded edits yet</span>' : '');
  host.querySelectorAll('[data-who-conv]').forEach(b => b.onclick = e => {
    if (e.shiftKey && ws.row) { fileWsEnterHistory({ fromTrack: true }); fileWsMountHistory(ws, fileWsResolveSelection({ from: 'before:' + b.dataset.whoFirst, to: b.dataset.whoFirst })); return; }
    if (b.dataset.whoEntry) open(b.dataset.whoConv, 'entry:' + b.dataset.whoEntry);
    else openConversationAtEvent(b.dataset.whoConv, b.dataset.whoFirst);
  });
}

// ---- the project ridge (landing): every file's sessions, one quiet strip ----
async function renderProjectRidge(ws) {
  const host = $('fwRidge');
  if (!host || !ws.project) return;
  let d;
  try { d = await (await fetch('/api/files/ridge?name=' + encodeURIComponent(ws.project))).json(); } catch { d = null; }
  if (fileWs !== ws || !host.isConnected || !d || d.error || !d.items || !d.items.length) { if (host) host.remove(); return; }
  const items = d.items;
  const now = Date.now();
  const W = Math.max(320, host.clientWidth || 900);
  const t0 = items[0].start;
  const t1 = Math.max(now, ...items.map(i => i.end));
  const span = Math.max(t1 - t0, 3600000);
  const xFor = t => 4 + ((t - t0) / span) * (W - 8);
  // Files pack into lanes (a file keeps one lane; files whose activity
  // never overlaps share one), and the strip never exceeds 16 vh: past
  // that, lanes are reused round-robin. A ridge, not a chart.
  const budget = Math.max(40, Math.min(Math.round(window.innerHeight * 0.16), 150));
  const maxLanes = Math.max(4, Math.floor((budget - 8) / 4));
  const byFile = new Map();
  for (const it of items) {
    let f = byFile.get(it.path);
    if (!f) { f = { a: it.start, b: it.end }; byFile.set(it.path, f); }
    f.a = Math.min(f.a, it.start); f.b = Math.max(f.b, it.end);
  }
  const files = [...byFile.entries()].sort((x, y) => x[1].a - y[1].a);
  const laneEnds = [];
  const laneOf = new Map();
  const gapT = span * (6 / W);
  files.forEach(([p, f], i) => {
    let lane = laneEnds.findIndex(end => end + gapT <= f.a);
    if (lane === -1) lane = laneEnds.length < maxLanes ? laneEnds.length : i % maxLanes;
    laneEnds[lane] = Math.max(laneEnds[lane] || 0, f.b);
    laneOf.set(p, lane);
  });
  const laneCount = Math.max(1, laneEnds.length);
  const laneH = Math.max(4, Math.min(14, Math.floor((budget - 8) / laneCount)));
  const chartH = 4 + laneCount * laneH + 4;
  const color = projectColor();
  const marks = items.map(it => {
    const cy = 4 + laneOf.get(it.path) * laneH + laneH / 2;
    const x0 = xFor(it.start), x1 = Math.max(x0 + 3, xFor(it.end));
    if (it.actor === 'git') return `<path class="fcommit" data-ridge-path="${esc(it.path)}" d="M ${x0},${cy - 2} L ${x0 + 2},${cy} L ${x0},${cy + 2} L ${x0 - 2},${cy} Z"><title>${esc(it.rel)} · commit ${esc(String(it.hash).slice(0, 10))} · ${esc(fmtDate(it.start))}</title></path>`;
    const bins = it.bins && it.bins.length ? it.bins : [1];
    return `<g class="tmark fmark a-${esc(it.actor)}" data-ridge-path="${esc(it.path)}"><title>${esc(it.rel)}\n${esc(it.actor === 'ai' ? 'agent · ' + (it.title || '') : it.actor === 'human' ? 'you' : 'external')} · ${esc(fmtDate(it.start))} · +${it.added} −${it.removed}</title><path class="violin" style="fill:${color.fill};stroke:${color.stroke}" d="${violinPath(x0, x1, cy, bins, false, Math.max(0.25, laneH / 22))}"/></g>`;
  }).join('');
  host.innerHTML = `<svg width="${W}" height="${chartH}" viewBox="0 0 ${W} ${chartH}"><line class="mg-now" x1="${xFor(now)}" y1="0" x2="${xFor(now)}" y2="${chartH}"/>${marks}</svg>`;
  host.title = `${files.length} files with recorded edits · ${items.length} sessions and commits · click a mark to open that file`;
  host.querySelectorAll('[data-ridge-path]').forEach(g => g.onclick = e => { e.stopPropagation(); openFileWorkspace(g.dataset.ridgePath, { project: ws.project }); });
}

// ---- ask for a change ----
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
  if (ws.editor && ws.editor.view) ws.editor.view.dom.addEventListener('mouseup', () => fileWsAskSelectionLine(ws));
  let t;
  try { t = await (await fetch('/api/files/ask-target?path=' + encodeURIComponent(ws.path) + (ws.project ? '&project=' + encodeURIComponent(ws.project) : ''))).json(); } catch { t = { error: 'network failure' }; }
  if (fileWs !== ws || !$('fwAskTarget')) return;
  askTargetCache = t;
  fileWsPaintAskTarget(ws, t, t.continue ? t.continue.key : 'new');
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
  ws.run = { jobId: out.job ? out.job.id : null, key: out.key, startedAt: Date.now(), preSha: ws.sha, preText: ws.editor ? ws.editor.getContent() : null, title: out.title, created: out.created, queued: out.queued };
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
    if (h) h.onclick = () => fileWsEnterHistory();
    renderWhoStripLater(ws);
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
    try { ws.editor.gotoLine(sel.line); } catch {}
  }
  invalidateFileCaches(ws.row && ws.row.id);
  if (ws.row) loadFocusedFile(ws.row, { to: 'current' }, { keepTree: true, quiet: true }).catch(() => {});
  const stats = typeof LineDiff !== 'undefined' ? LineDiff.scriptStats(LineDiff.diffLines(before, d.text)) : null;
  fileWsMarkChanged(ws, before, d.text, 'agent changed');
  return stats ? `agent changed +${stats.added} −${stats.removed} lines` : 'agent changed the file';
}

let whoStripTimer = null;
function renderWhoStripLater(ws) {
  clearTimeout(whoStripTimer);
  whoStripTimer = setTimeout(async () => {
    if (fileWs !== ws || !ws.path) return;
    try {
      const t = await (await fetch('/api/files/touched?path=' + encodeURIComponent(ws.path))).json();
      if (fileWs !== ws || t.error) return;
      ws.touched = t;
      renderWhoStrip(ws);
    } catch {}
  }, 1500);
}

// SSE file-activity: the open file changed on disk (by anyone).
function fileWsFileActivity(d) {
  const ws = fileWs;
  if (!ws || !ws.path || d.path !== ws.path) { if (lens === 'files' && viewKind === 'home') filesRefreshSoon(); return; }
  if (ws.run) return; // the run's own settle handles the reload
  if (ws.mode !== 'write' || !ws.editor) { renderWhoStripLater(ws); return; }
  const who = d.actor === 'ai' ? 'an agent' : d.actor === 'human' ? 'the editor' : 'something on disk';
  if (ws.kind === 'code') {
    if (!ws.dirty) fileWsReloadCode(ws, { quiet: true }).then(() => { const el = $('docStatus'); if (el) el.textContent = `changed on disk by ${who} · reloaded`; });
    else { if ($('docReload')) $('docReload').hidden = false; fileWsBanner(ws, `the file changed on disk (${who}) while you have unsaved edits — reload drops them; history compares`, [['see history', () => fileWsEnterHistory()], ['reload from disk', () => fileWsReloadCode(ws, { dropDraft: true })]]); }
  } else if (docState && docState.path === ws.path) {
    if (!docState.dirty) {
      fetch('/api/file/read?path=' + encodeURIComponent(ws.path)).then(r => r.json()).then(dd => {
        if (fileWs !== ws || !docState || docState.path !== ws.path || dd.error || docState.dirty) return;
        if (dd.sha === docState.sha) return;
        const sel = docState.editor.selection ? docState.editor.selection() : null;
        docState.editor.setContent(dd.text);
        docState.sha = dd.sha; docState.dirty = false;
        if (sel && docState.editor.gotoLine) try { docState.editor.gotoLine(sel.line); } catch {}
        docStatusLine(`changed on disk by ${who} · reloaded`);
      }).catch(() => {});
    } else {
      if ($('docReload')) $('docReload').hidden = false;
      docStatusLine(`⚠ changed on disk by ${who} while you have unsaved edits`);
    }
  }
  renderWhoStripLater(ws);
  if (ws.row) { invalidateFileCaches(ws.row.id); loadFocusedFile(ws.row, { to: 'current' }, { keepTree: true, quiet: true }).catch(() => {}); }
}

// ---- keyboard, inside the workspace ----
function fileWsKey(e) {
  const ws = fileWs;
  if (!ws) return false;
  const inField = e.target && (e.target.closest('input, textarea, select, [contenteditable], .cm-editor'));
  if (inField) return false;
  if (e.key === 'h') { fileWsEnterHistory(); return true; }
  if (e.key === 'n' || e.key === 'w') { fileWsEnterWrite(); return true; }
  if (e.key === 'e') { if (ws.editor) ws.editor.focus(); return true; }
  if (e.key === 'c') { const first = (ws.touched && ws.touched.sessions || []).find(s => s.actor === 'ai'); if (first) openConversationAtEvent(first.convKey, first.firstEventId); return true; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { fileWsToggleAsk(true); return true; }
  return false;
}
