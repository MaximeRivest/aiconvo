/* Artifacts (design/67): widgets in the conversation, previews of code, and
   the artifact panel beside it. What is shown always comes from the
   conversation at the reader's head: a widget's HTML from its tool call, a
   code preview from the answer's text, and files at the version captured on
   the head's path (or the disk, at the conversation's end).

   Everything an artifact renders runs on the preview address, never on this
   page's origin. The host side speaks MCP Apps (spec 2026-01-26): widgets go
   through the sandbox proxy; panel pages load by URL and talk directly. */
(function () {
  'use strict';
  const PROTOCOL = '2026-01-26';
  let config = null, configLoad = null;
  function loadConfig() {
    if (config) return Promise.resolve(config);
    if (!configLoad) configLoad = fetch('/api/artifacts/config').then(r => r.json()).then(c => (config = c)).catch(e => { configLoad = null; throw e; });
    return configLoad;
  }
  // The preview address for an artifact, from where this page was opened:
  // its own site on this computer, the tailnet's preview port, the LAN's.
  function previewOrigin(site) {
    const c = config || { port: 7435, tlsPort: 7445, tailnetPort: 8443, base: '' };
    if (c.base) return c.base.replace('{id}', site);
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return `http://${site}.localhost:${c.port}`;
    if (location.protocol === 'https:' && /\.ts\.net$/i.test(h)) return `https://${h}:${c.tailnetPort}`;
    if (location.protocol === 'https:') return `https://${h}:${c.tlsPort}`;
    return `http://${h}:${c.port}`;
  }
  const siteOf = text => { let h = 0x811c9dc5; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return 'w' + h.toString(16).padStart(8, '0'); };
  const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- the host's theme, as the standard MCP Apps variables --------------
  function hostContext(extra = {}) {
    const cs = getComputedStyle(document.documentElement);
    const v = name => cs.getPropertyValue(name).trim();
    const bg = v('--bg') || '#ffffff';
    const rgb = (() => { const d = document.createElement('div'); d.style.color = bg; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return (c.match(/\d+/g) || [255, 255, 255]).map(Number); })();
    const dark = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5;
    const r = v('--r') || '8px';
    const vars = {
      '--color-background-primary': bg, '--color-background-secondary': v('--surface-1') || bg, '--color-background-tertiary': v('--surface-2') || bg,
      '--color-background-inverse': v('--text'), '--color-background-ghost': 'transparent',
      '--color-text-primary': v('--text'), '--color-text-secondary': v('--text-dim'), '--color-text-tertiary': v('--text-faint') || v('--text-dim'),
      '--color-text-inverse': bg, '--color-text-info': v('--accent'), '--color-text-danger': v('--danger') || v('--red'),
      '--color-text-success': v('--success') || v('--green'), '--color-text-warning': v('--warn') || v('--yellow'), '--color-text-ghost': v('--text-faint') || v('--text-dim'),
      '--color-border-primary': v('--border'), '--color-border-secondary': v('--border-strong') || v('--border'),
      '--color-ring-primary': v('--accent'),
      '--font-sans': v('--font') || 'system-ui, sans-serif', '--font-mono': v('--font-mono') || 'ui-monospace, monospace',
      '--border-radius-sm': v('--r-sm') || r, '--border-radius-md': r, '--border-radius-lg': v('--r-menu') || r, '--border-radius-full': '999px',
      '--border-width-regular': '1px',
    };
    for (const k of Object.keys(vars)) if (!vars[k]) delete vars[k];
    const phone = window.matchMedia('(max-width: 700px)').matches;
    return {
      theme: dark ? 'dark' : 'light',
      styles: { variables: vars },
      platform: phone ? 'mobile' : 'web',
      deviceCapabilities: { touch: window.matchMedia('(pointer: coarse)').matches, hover: window.matchMedia('(hover: hover)').matches },
      locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      availableDisplayModes: ['inline', 'fullscreen'],
      userAgent: 'chattering',
      ...extra,
    };
  }

  // ---- one host bridge per view ------------------------------------------
  // frame: the <iframe>; origin: its preview origin; html: for the sandbox
  // proxy (widgets, code); displayMode, dims; onSize(height); onFullscreen().
  const bridges = new Set();
  function bridge(frame, opts) {
    const b = { frame, opts, initialized: false };
    const post = m => { try { frame.contentWindow.postMessage({ jsonrpc: '2.0', ...m }, opts.origin); } catch {} };
    const reply = (id, result) => post({ id, result });
    const refuse = (id, code, message) => post({ id, error: { code, message } });
    b.context = () => hostContext({ displayMode: opts.displayMode, containerDimensions: opts.dims ? opts.dims() : undefined,
      toolInfo: opts.toolName ? { tool: { name: opts.toolName } } : undefined });
    b.onMessage = e => {
      if (e.source !== frame.contentWindow || e.origin !== opts.origin) return;
      const m = e.data;
      if (!m || m.jsonrpc !== '2.0') return;
      switch (m.method) {
        case 'ui/notifications/sandbox-proxy-ready':
          if (opts.html != null) post({ method: 'ui/notifications/sandbox-resource-ready', params: { html: opts.html } });
          return;
        case 'ui/initialize':
          return reply(m.id, { protocolVersion: PROTOCOL, hostInfo: { name: 'chattering', version: '1' },
            hostCapabilities: { openLinks: {}, logging: {}, sandbox: { permissions: { clipboardWrite: {} } } }, hostContext: b.context() });
        case 'ui/notifications/initialized':
          b.initialized = true;
          if (opts.toolInput) post({ method: 'ui/notifications/tool-input', params: { arguments: opts.toolInput } });
          if (opts.toolResult) post({ method: 'ui/notifications/tool-result', params: opts.toolResult });
          return;
        case 'ui/notifications/size-changed':
          if (opts.onSize && m.params && Number.isFinite(m.params.height)) opts.onSize(m.params.height, m.params.width);
          return;
        case 'ui/open-link': {
          const url = String(m.params && m.params.url || '');
          if (!/^https?:\/\//i.test(url)) return refuse(m.id, -32602, 'Only web links can be opened');
          window.open(url, '_blank', 'noopener,noreferrer');
          return reply(m.id, {});
        }
        case 'ui/message': {
          // Into the reader's message box, not sent: the person decides.
          const text = m.params && m.params.content && m.params.content.text;
          const box = document.getElementById('agentText');
          if (!text || !box) return refuse(m.id, -32000, 'There is no message box here');
          box.value = box.value ? box.value.replace(/\s*$/, '') + '\n\n' + text : String(text);
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.focus();
          return reply(m.id, {});
        }
        case 'ui/request-display-mode': {
          const want = m.params && m.params.mode;
          if (want === 'fullscreen' && opts.onFullscreen) { opts.onFullscreen(); return reply(m.id, { mode: 'fullscreen' }); }
          return reply(m.id, { mode: opts.displayMode });
        }
        case 'ping': return reply(m.id, {});
        case 'notifications/message': console.info('[artifact]', m.params); return;
        default:
          if (m.id != null) refuse(m.id, -32601, (m.method || 'This request') + ' is not supported by Chattering yet');
      }
    };
    window.addEventListener('message', b.onMessage);
    b.changed = () => { if (b.initialized) post({ method: 'ui/notifications/host-context-changed', params: b.context() }); };
    b.dispose = () => {
      window.removeEventListener('message', b.onMessage); bridges.delete(b);
    };
    bridges.add(b);
    return b;
  }
  // Theme changes reach every open view.
  new MutationObserver(() => { for (const b of bridges) b.changed(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-mode', 'style', 'class'] });
  // Views that left the page stop listening.
  setInterval(() => { for (const b of bridges) if (!b.frame.isConnected) b.dispose(); }, 5000);

  // A sandboxed view of some HTML through the MCP Apps proxy.
  function proxyFrame({ html, site, title, displayMode, onSize, onFullscreen, dims, toolInput, toolName }) {
    const origin = previewOrigin(site);
    const frame = document.createElement('iframe');
    frame.className = 'art-frame';
    frame.title = title || 'artifact';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock');
    frame.setAttribute('allow', 'fullscreen; clipboard-write');
    frame.referrerPolicy = 'no-referrer';
    frame.src = `${origin}/_c/proxy.html?host=${encodeURIComponent(location.origin)}`;
    bridge(frame, { origin, html, displayMode, onSize, onFullscreen, dims, toolInput, toolName });
    return frame;
  }

  // ---- widgets in the conversation ----------------------------------------
  const INLINE_MAX = () => Math.round(window.innerHeight * 0.8);
  function widgetHtml(key, m) {
    const a = m.artifact || {};
    return `<figure class="art-widget" data-art-key="${escHtml(key)}" data-art-entry="${escHtml(m.eid || '')}" data-art-call="${escHtml(m.id || '')}" data-art-title="${escHtml(a.title || '')}">` +
      `<figcaption><span>${escHtml(a.title || 'Widget')}</span><button type="button" class="art-to-panel" title="Open in the artifact panel">open ⤢</button></figcaption>` +
      `<div class="art-widget-host"><p class="art-note">Loading…</p></div></figure>`;
  }
  function cardHtml(key, m) {
    const a = m.artifact || {};
    const kind = a.type && a.type !== 'auto' ? a.type : '';
    return `<div class="art-card" role="group" aria-label="Artifact" data-art-key="${escHtml(key)}" data-art-path="${escHtml(a.path || '')}" data-art-title="${escHtml(a.title || '')}" data-art-type="${escHtml(a.type || 'auto')}" data-art-node="${escHtml(m.eid || '')}">` +
      `<span class="art-card-icon" aria-hidden="true">◧</span><span class="art-card-text"><b>${escHtml(a.title || (a.path || '').split('/').filter(Boolean).pop() || 'Artifact')}</b><small>${escHtml(a.path || '')}${kind ? ' · ' + escHtml(kind) : ''}</small></span>` +
      `<button type="button" class="art-open">Open</button></div>`;
  }
  // What the transcript renderer puts after a group of steps.
  window.artifactCardsHtml = (key, tools) => tools.filter(m => m.artifact).map(m => m.artifact.kind === 'widget' ? widgetHtml(key, m) : cardHtml(key, m)).join('');

  async function mountWidget(fig) {
    fig.dataset.mounted = '1';
    const host = fig.querySelector('.art-widget-host');
    try {
      await loadConfig();
      const q = new URLSearchParams({ id: fig.dataset.artKey, entry: fig.dataset.artEntry, call: fig.dataset.artCall });
      const r = await fetch('/api/artifacts/widget?' + q);
      const data = await r.json();
      if (!r.ok || data.error) throw Error(data.error || 'The widget could not be read.');
      let height = 0;
      const frame = proxyFrame({
        html: data.html, site: siteOf(fig.dataset.artKey + '|' + fig.dataset.artCall), title: data.title || 'widget', displayMode: 'inline',
        dims: () => ({ width: host.clientWidth, maxHeight: INLINE_MAX() }),
        onSize: h => { const want = Math.max(40, Math.min(INLINE_MAX(), Math.ceil(h))); if (want !== height) { height = want; frame.style.height = want + 'px'; } },
        onFullscreen: () => openWidgetInPanel(fig, data),
        toolName: 'show', toolInput: { title: data.title || '' },
      });
      frame.style.height = '160px';
      host.replaceChildren(frame);
      fig.querySelector('.art-to-panel').onclick = () => openWidgetInPanel(fig, data);
    } catch (e) {
      host.innerHTML = `<p class="art-note">${escHtml(e.message)}</p>`;
    }
  }
  function openWidgetInPanel(fig, data) {
    openPanel({ kind: 'html', key: fig.dataset.artKey, title: data.title || 'Widget', html: data.html, site: siteOf(fig.dataset.artKey + '|' + fig.dataset.artCall), source: 'widget' });
  }

  // ---- previews of code in answers ---------------------------------------
  // Open WebUI's rule: an html block starts a page; css and js blocks after it
  // in the same answer join it. An svg block is its own picture.
  function codePage(pre) {
    const msg = pre.closest('.msg');
    const blocks = [...(msg || pre.parentElement).querySelectorAll('pre.md-code[data-lang]')];
    const code = p => (p.querySelector('code') || p).textContent;
    const lang = p => String(p.dataset.lang || '').toLowerCase();
    if (lang(pre) === 'svg' || (lang(pre) === 'xml' && /<svg[\s>]/i.test(code(pre)))) {
      return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;display:grid;place-items:center;background:var(--color-background-primary,#fff)}svg{max-width:100%;height:auto}</style></head><body>${code(pre)}</body></html>`;
    }
    const at = blocks.indexOf(pre);
    let css = '', js = '';
    for (let i = at + 1; i < blocks.length && lang(blocks[i]) !== 'html'; i++) {
      if (lang(blocks[i]) === 'css') css += code(blocks[i]) + '\n';
      else if (['js', 'javascript'].includes(lang(blocks[i]))) js += code(blocks[i]) + '\n';
    }
    let html = code(pre);
    if (css) html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `<style>${css}</style></head>`) : `<style>${css}</style>` + html;
    if (js) html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `<script>${js}<\/script></body>`) : html + `<script>${js}<\/script>`;
    return html;
  }
  function wireCodePreviews(root) {
    for (const pre of root.querySelectorAll('pre.md-code[data-lang]')) {
      const lang = String(pre.dataset.lang || '').toLowerCase();
      const code = (pre.querySelector('code') || pre).textContent;
      if (!(lang === 'html' || lang === 'svg' || (lang === 'xml' && /<svg[\s>]/i.test(code))) || pre.querySelector('.md-preview')) continue;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'md-preview'; btn.textContent = '▶ preview';
      btn.title = 'Show this code running, in the artifact panel (with the css and js blocks that follow it in this answer)';
      btn.onclick = () => {
        const key = pre.closest('[data-msg-key]')?.dataset.msgKey || (typeof current !== 'undefined' && current?.key) || '';
        const eid = pre.closest('[data-eid]')?.dataset.eid || '';
        openPanel({ kind: 'html', key, title: 'Preview of code in this answer', html: codePage(pre), site: siteOf(key + '|code|' + eid), source: 'code' });
      };
      pre.appendChild(btn);
    }
  }

  // ---- the panel ------------------------------------------------------------
  let pane = null, state = null, paneBridge = null, resolveSeq = 0;
  const stateKey = key => 'chattering.artifact.v1:' + key;
  function ensurePane() {
    if (pane) return pane;
    pane = document.createElement('aside');
    pane.id = 'artifactPane';
    pane.setAttribute('aria-label', 'Artifact');
    pane.innerHTML = `<div class="art-resize" role="separator" aria-orientation="vertical" aria-label="Resize the artifact panel" tabindex="0"></div>
      <header class="art-head">
        <button type="button" class="art-close" data-art-act="close" title="Close the artifact panel" aria-label="Close">✕</button>
        <div class="art-titles"><b class="art-title"></b><small class="art-sub"></small></div>
        <span class="art-versions" role="group" aria-label="Versions">
          <button type="button" data-art-act="older" aria-label="Older version">‹</button>
          <select class="art-version" aria-label="Version shown"></select>
          <button type="button" data-art-act="newer" aria-label="Newer version">›</button>
        </span>
        <span class="art-tools">
          <button type="button" data-art-act="ask" title="Ask about this artifact in the message box">Ask</button>
          <button type="button" data-art-act="reload" title="Reload" aria-label="Reload">↻</button>
          <a class="art-newtab" target="_blank" rel="noopener noreferrer" title="Open in its own browser tab" aria-label="Open in a new tab">↗</a>
          <button type="button" data-art-act="full" title="Full screen" aria-label="Full screen">⤢</button>
        </span>
      </header>
      <p class="art-banner" hidden></p>
      <div class="art-body"></div>`;
    document.body.appendChild(pane);
    pane.addEventListener('click', e => {
      const act = e.target.closest('[data-art-act]')?.dataset.artAct;
      if (act === 'close') closePanel();
      else if (act === 'reload') render(true);
      else if (act === 'full') { const b = pane.querySelector('.art-body'); (b.requestFullscreen ? b.requestFullscreen() : Promise.reject()).catch(() => pane.classList.toggle('art-max')); }
      else if (act === 'older' || act === 'newer') stepVersion(act === 'older' ? -1 : 1);
      else if (act === 'ask') askAbout();
    });
    pane.querySelector('.art-version').onchange = e => { if (state) { state.version = e.target.value || null; render(false); } };
    // Resize: drag the left edge; the width is this device's choice.
    const grip = pane.querySelector('.art-resize');
    const setW = px => { const w = Math.max(320, Math.min(window.innerWidth - 360, px)); document.body.style.setProperty('--art-w', w + 'px'); localStorage.setItem('chattering.artifact.width', String(Math.round(w))); };
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId); pane.classList.add('art-dragging');
      const move = ev => setW(window.innerWidth - ev.clientX);
      const up = () => { grip.removeEventListener('pointermove', move); pane.classList.remove('art-dragging'); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true });
    });
    grip.addEventListener('keydown', e => {
      const w = pane.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') setW(w + 40); else if (e.key === 'ArrowRight') setW(w - 40);
    });
    const saved = Number(localStorage.getItem('chattering.artifact.width'));
    if (saved) document.body.style.setProperty('--art-w', saved + 'px');
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pane.classList.contains('art-max')) pane.classList.remove('art-max'); });
    return pane;
  }
  function closePanel() {
    if (paneBridge) { paneBridge.dispose(); paneBridge = null; }
    if (state && state.key) localStorage.removeItem(stateKey(state.key));
    state = null;
    document.body.classList.remove('artifact-open');
    if (pane) { pane.querySelector('.art-body').replaceChildren(); pane.classList.remove('art-max'); }
  }
  // spec: { kind: 'files', key, path, title, type } or { kind: 'html', key, title, html, site }
  async function openPanel(spec) {
    ensurePane();
    await loadConfig().catch(() => {});
    state = { ...spec, version: null, resolved: null };
    if (spec.kind === 'files' && spec.key) localStorage.setItem(stateKey(spec.key), JSON.stringify({ path: spec.path, title: spec.title, type: spec.type }));
    document.body.classList.remove('file-side-open');
    document.body.classList.add('artifact-open');
    await render(true);
  }
  function stepVersion(dir) {
    const r = state && state.resolved;
    if (!r) return;
    const list = versionList(r), i = list.findIndex(v => v.id === (state.version || r.show));
    const next = list[i + dir];
    if (next) { state.version = next.id; render(false); }
  }
  function versionList(r) {
    const list = r.versions.map((v, i) => ({ id: v.id, label: `Version ${i + 1} of ${r.versions.length}`, missing: v.missing }));
    if (r.live.exists && (!r.live.same || !list.length)) list.push({ id: 'live', label: list.length ? 'On disk now (changed since)' : 'On disk now' });
    return list;
  }
  function currentHead() {
    return typeof current !== 'undefined' && current && state && current.key === state.key && typeof headOf === 'function' ? headOf(current) : '';
  }
  async function render(reload) {
    if (!state || !pane) return;
    const seq = ++resolveSeq;
    const body = pane.querySelector('.art-body'), banner = pane.querySelector('.art-banner');
    pane.querySelector('.art-title').textContent = state.title || 'Artifact';
    const vs = pane.querySelector('.art-versions'), newtab = pane.querySelector('.art-newtab');
    banner.hidden = true;
    if (state.kind === 'html') {
      vs.hidden = true; newtab.hidden = true;
      pane.querySelector('.art-sub').textContent = state.source === 'code' ? 'code in this answer' : 'widget';
      if (!reload && body.firstChild) return;
      if (paneBridge) { paneBridge.dispose(); paneBridge = null; }
      const frame = proxyFrame({ html: state.html, site: state.site, title: state.title, displayMode: 'fullscreen',
        dims: () => ({ width: body.clientWidth, height: body.clientHeight }) });
      paneBridge = [...bridges].find(b => b.frame === frame) || null;
      body.replaceChildren(frame);
      return;
    }
    let r;
    try {
      const q = new URLSearchParams({ id: state.key, path: state.path, head: currentHead() || '', type: state.type || 'auto', title: state.title || '' });
      const res = await fetch('/api/artifacts/resolve?' + q);
      r = await res.json();
      if (!res.ok || r.error) throw Error(r.error || 'The artifact could not be found.');
    } catch (e) {
      if (seq !== resolveSeq) return;
      body.innerHTML = `<p class="art-note">${escHtml(e.message)}</p>`;
      return;
    }
    if (seq !== resolveSeq || !state) return;
    const before = state.resolved;
    state.resolved = r;
    const list = versionList(r);
    if (state.version && !list.some(v => v.id === state.version)) state.version = null;
    const shown = state.version || r.show;
    const sel = pane.querySelector('.art-version');
    sel.innerHTML = list.map(v => `<option value="${escHtml(v.id)}"${v.id === shown ? ' selected' : ''}>${escHtml(v.label)}${v.id === r.show && !state.version ? ' · this point' : ''}</option>`).join('');
    vs.hidden = list.length < 2;
    const at = list.findIndex(v => v.id === shown);
    vs.querySelector('[data-art-act="older"]').disabled = at <= 0;
    vs.querySelector('[data-art-act="newer"]').disabled = at < 0 || at >= list.length - 1;
    pane.querySelector('.art-sub').textContent = r.relPath + (r.kind ? ' · ' + r.kind : '');
    const version = list.find(v => v.id === shown);
    if (!r.exists && shown === 'live') { banner.hidden = false; banner.textContent = 'These files are no longer on disk.'; }
    else if (version && version.missing) { banner.hidden = false; banner.textContent = `${version.missing} file${version.missing === 1 ? ' was' : 's were'} not captured in this version (before the folder was an artifact); the disk's copy is shown for ${version.missing === 1 ? 'it' : 'them'}.`; }
    else if (shown === 'live' && r.versions.length && !r.live.same) { banner.hidden = false; banner.textContent = 'Shown as it is on disk now; it changed after the last version in this conversation.'; }
    else if (shown !== 'live' && r.live.exists && !r.live.same && shown === r.show) { banner.hidden = false; banner.textContent = 'Shown as it was at this point of the conversation. The files on disk are different now.'; }
    const same = before && before.cap === r.cap && body.dataset.version === shown && body.firstChild;
    if (same && !reload) return;
    body.dataset.version = shown;
    const origin = previewOrigin(r.site);
    const fileUrl = `${origin}/a/${r.cap}/${shown}/${r.entry ? encodeURIComponent(r.entry) : ''}`;
    newtab.hidden = false; newtab.href = fileUrl;
    if (paneBridge) { paneBridge.dispose(); paneBridge = null; }
    const blob = (file = '') => '/api/artifacts/blob?' + new URLSearchParams({ id: state.key, path: state.path, version: shown, head: r.head || '', ...(file ? { file } : {}) });
    if (['web', 'svg', 'slides', 'folder'].includes(r.kind)) {
      const frame = document.createElement('iframe');
      frame.className = 'art-frame';
      frame.title = state.title || 'artifact';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock');
      frame.setAttribute('allow', 'fullscreen; clipboard-write; autoplay');
      frame.referrerPolicy = 'no-referrer';
      frame.src = fileUrl;
      paneBridge = bridge(frame, { origin, displayMode: 'fullscreen', dims: () => ({ width: body.clientWidth, height: body.clientHeight }) });
      body.replaceChildren(frame);
    } else if (r.kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'art-frame';
      frame.title = 'PDF: ' + (state.title || '');
      const eink = document.documentElement.dataset.themeMode === 'binary' ? '1' : '0';
      frame.src = '/vendor/pdfjs/6.3.289/web/viewer.html?' + new URLSearchParams({ file: blob(), eink });
      body.replaceChildren(frame);
    } else if (r.kind === 'image') {
      body.innerHTML = `<div class="art-media"><img alt="${escHtml(state.title || '')}" src="${escHtml(blob())}"></div>`;
    } else if (r.kind === 'video' || r.kind === 'audio') {
      body.innerHTML = `<div class="art-media"><${r.kind} controls preload="metadata" src="${escHtml(blob())}"></${r.kind}></div>`;
    } else {
      const res = await fetch(blob());
      const text = res.ok ? await res.text() : 'Could not read this file.';
      if (seq !== resolveSeq) return;
      const div = document.createElement('div');
      div.className = 'art-read';
      if (r.kind === 'markdown' && typeof mdRender === 'function') div.innerHTML = `<div class="md">${mdRender(text, '')}</div>`;
      else div.innerHTML = `<pre>${escHtml(text)}</pre>`;
      body.replaceChildren(div);
    }
  }
  function askAbout() {
    const box = document.getElementById('agentText');
    if (!box || !state) return;
    const r = state.resolved;
    const where = !r ? '' : (state.version || r.show) === 'live' ? ' (as it is on disk now)' : ` (version ${r.versions.findIndex(v => v.id === (state.version || r.show)) + 1} of ${r.versions.length})`;
    const ref = state.kind === 'files' ? `About the artifact ${r ? r.relPath : state.path}${where}: ` : `About the ${state.source === 'code' ? 'code preview' : 'widget'} "${state.title}": `;
    box.value = box.value ? box.value.replace(/\s*$/, '') + '\n\n' + ref : ref;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
  }

  // ---- following the conversation -----------------------------------------
  const seenArtifacts = new Map(); // key → ids of artifact calls already known
  function artifactCallsOf(d) { return (d.messages || []).filter(m => m.role === 'tool' && m.artifact && m.artifact.kind === 'files' && m.id); }
  // Called after the transcript renders or the head moves.
  function wire(root) {
    root = root || document.getElementById('conversationTranscript');
    if (!root) return;
    loadConfig().catch(() => {});
    for (const fig of root.querySelectorAll('.art-widget:not([data-mounted])')) mountWidget(fig);
    for (const card of root.querySelectorAll('.art-card')) {
      card.querySelector('.art-open').onclick = () => openPanel({ kind: 'files', key: card.dataset.artKey, path: card.dataset.artPath, title: card.dataset.artTitle, type: card.dataset.artType });
      card.classList.toggle('art-card-open', !!(state && state.kind === 'files' && state.key === card.dataset.artKey && state.path === card.dataset.artPath));
    }
    wireCodePreviews(root);
  }
  function onConversation(d) {
    if (!d || !d.key) return;
    const calls = artifactCallsOf(d);
    const known = seenArtifacts.get(d.key);
    seenArtifacts.set(d.key, new Set(calls.map(m => m.id)));
    if (known) {
      // A new artifact landed while this conversation is open: show it.
      const fresh = calls.filter(m => !known.has(m.id));
      const last = fresh[fresh.length - 1];
      if (last) return openPanel({ kind: 'files', key: d.key, path: last.artifact.path, title: last.artifact.title, type: last.artifact.type });
    } else if (!state || state.key !== d.key) {
      // Reopen what was open in this conversation last time.
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(stateKey(d.key)) || 'null'); } catch {}
      if (saved && saved.path) return openPanel({ kind: 'files', key: d.key, ...saved });
      if (state && state.key !== d.key) hidePanel();
      return;
    }
    if (state && state.key === d.key && state.kind === 'files') render(false);
  }
  // The head moved (a card, an arrow, the tree): the version follows.
  function onHeadChange() {
    if (state && state.kind === 'files' && typeof current !== 'undefined' && current && current.key === state.key) { state.version = null; render(false); }
  }
  // Leaving the conversation hides the panel but keeps it for the return.
  function hidePanel() {
    if (paneBridge) { paneBridge.dispose(); paneBridge = null; }
    state = null;
    document.body.classList.remove('artifact-open');
    if (pane) { pane.querySelector('.art-body').replaceChildren(); pane.classList.remove('art-max'); }
  }
  function onLeaveConversation() { if (state) { const keep = state.key; hidePanel(); if (keep) seenArtifacts.delete(keep); } }

  window.Artifacts = { wire, openPanel, closePanel, onConversation, onHeadChange, onLeaveConversation, previewOrigin, hostContext, codePage, state: () => state };
})();
