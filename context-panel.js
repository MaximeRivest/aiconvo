/* Source inspection is separate from attaching it to a conversation. */
window.openContextPanel = async function(api) {
  document.getElementById('contextPanel')?.close();
  const dialog = document.createElement('dialog'); dialog.id = 'contextPanel';
  dialog.innerHTML = `<header><h2>Conversation context</h2><button data-close aria-label="Close context">Close</button></header>
    <p>Choose background knowledge for future messages. Preview first, then add. Saved with this conversation.</p>
    <div class="context-controls"><select aria-label="Source type"><option value="memory">Project memory</option><option value="chat">Conversations</option></select><input type="search" placeholder="Search sources" aria-label="Search sources"><select data-project aria-label="Project filter"><option value="">All projects</option></select><label>Since <input type="date" aria-label="Conversations since date"></label></div>
    <div class="context-columns"><section aria-label="Sources"><div data-results></div></section><section aria-label="Preview"><h3 data-title>Select a source to inspect</h3><div data-scopes></div><p data-meta></p><pre data-preview>No context is added until you choose Add context.</pre><button data-add disabled>Add context</button></section></div>
    <footer><h3>Attached to this conversation</h3><div data-attached></div><p data-total aria-live="polite"></p></footer>`;
  document.body.append(dialog);
  const $ = s => dialog.querySelector(s);
  let selected = null, ctl, timer, revision = 0, totalRevision = 0, projects = [];
  const opener = document.activeElement;
  const showText = (selector, text) => { $(selector).textContent = text; };
  const preview = async items => {
    const r = await fetch('/api/conversation/context-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: api.key, context: items }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Preview unavailable'); return d;
  };
  const titleOf = item => item.type === 'chat' ? (item.title || 'Conversation') : item.type === 'file' ? item.path : item.project + ' · ' + item.kind;
  const refreshAttached = async () => {
    const n = ++totalRevision, host = $('[data-attached]'); host.replaceChildren();
    const items = api.items();
    for (const item of items) {
      const row = document.createElement('div'), inspect = document.createElement('button'), remove = document.createElement('button');
      inspect.textContent = titleOf(item); inspect.onclick = () => inspectItem(item);
      remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove ' + titleOf(item));
      remove.onclick = () => { api.remove(item); refreshAttached(); if (selected) inspectItem(selected); };
      row.append(inspect, remove); host.append(row);
    }
    showText('[data-total]', items.length ? 'Estimating attached context…' : 'Nothing attached.');
    if (!items.length) return;
    try { const d = await preview(items); if (n === totalRevision && dialog.open) showText('[data-total]', `${items.length} sources · approximately ${d.tokens.toLocaleString()} tokens. Overlapping memory sections are included only once; recent history replaces individual exchanges from the same conversation.`); }
    catch (e) { if (n === totalRevision) showText('[data-total]', e.message); }
  };
  async function inspectItem(item) {
    selected = item; const n = ++revision;
    showText('[data-title]', titleOf(item)); showText('[data-meta]', 'Loading exact context preview…'); showText('[data-preview]', '');
    $('[data-add]').disabled = true; $('[data-scopes]').replaceChildren();
    if (!item.type || item.type === 'map') {
      for (const kind of ['map', 'overview', 'intent', 'environment', 'status']) {
        const b = document.createElement('button'); b.textContent = kind === 'map' ? 'All four sections' : kind;
        b.setAttribute('aria-pressed', String(item.kind === kind)); b.onclick = () => inspectItem({ project: item.project, kind }); $('[data-scopes]').append(b);
      }
    } else if (item.type === 'chat' && item.i != null) {
      const b = document.createElement('button'); b.textContent = 'Preview recent history instead';
      b.onclick = () => inspectItem({ type: 'chat', key: item.key, title: item.title }); $('[data-scopes]').append(b);
    }
    try {
      const d = await preview([item]); if (n !== revision || !dialog.open) return;
      showText('[data-preview]', d.text);
      showText('[data-meta]', `Approximately ${d.tokens.toLocaleString()} tokens · full assembled text below, including source paths and review labels. Preview reads current content; it refreshes when you send.`);
      const added = api.has(item); $('[data-add]').textContent = added ? 'Already attached' : 'Add context'; $('[data-add]').disabled = added;
    } catch (e) { if (n === revision) showText('[data-meta]', e.message); }
  }
  $('[data-add]').onclick = () => { if (selected && !api.has(selected)) { api.add(selected); refreshAttached(); inspectItem(selected); } };
  const resultRow = (item, title, detail) => {
    const b = document.createElement('button'); b.className = 'context-source';
    const strong = document.createElement('strong'), small = document.createElement('small');
    strong.textContent = title; small.textContent = detail; b.append(strong, small); b.onclick = () => {
      for (const row of $('[data-results]').children) row.removeAttribute('aria-current');
      b.setAttribute('aria-current', 'true'); inspectItem(item);
      if (matchMedia('(max-width: 650px)').matches) $('[data-title]').scrollIntoView({ block: 'start', behavior: 'instant' });
    }; $('[data-results]').append(b);
  };
  async function search() {
    ctl?.abort(); const c = ctl = new AbortController();
    const q = $('input[type=search]').value.trim(), project = $('[data-project]').value, type = $('select').value, since = $('input[type=date]').value;
    $('input[type=date]').disabled = type === 'memory';
    const host = $('[data-results]'); host.textContent = 'Searching…';
    try {
      if (type === 'memory') {
        host.replaceChildren();
        for (const p of projects) {
          if (project && p.name !== project || q && !(p.name + ' ' + (p.title || '')).toLowerCase().includes(q.toLowerCase())) continue;
          const available = Object.entries(p.docs || {}).filter(([, yes]) => yes).map(([kind]) => kind);
          if (!available.length) continue;
          resultRow({ project: p.name, kind: 'map' }, p.title || p.name, `${p.name}\n${available.map(kind => { const doc = p.documents?.[kind]; return kind + ' · ' + (doc?.updatedAt || '').slice(0, 10) + ' ' + (doc?.trust || '[unverified]'); }).join('\n')}`);
        }
      } else {
        const query = [q, 'type:conversation', project ? 'project:' + JSON.stringify(project) : '', since ? 'after:' + since : ''].filter(Boolean).join(' ');
        const r = await fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=30', { signal: c.signal });
        if (!r.ok) throw new Error('Search unavailable'); const d = await r.json();
        if (c.signal.aborted || !dialog.open) return; host.replaceChildren();
        for (const g of d.groups || []) {
          if (g.kind !== 'conversation' || g.key === api.key) continue;
          const title = g.title || g.key, meta = `${g.project || ''} · ${(g.firstTs || '').slice(0, 10)} → ${(g.lastTs || '').slice(0, 10)}`;
          const hits = (g.matches || []).filter(m => m.i != null && ['user', 'assistant'].includes(m.role));
          for (const hit of hits) resultRow({ type: 'chat', key: g.key, i: hit.i, title }, title, `${meta} · exchange #${hit.i}\n${(hit.snippet || '').replace(/[\u0001\u0002]/g, '')}`);
          resultRow({ type: 'chat', key: g.key, title }, title, meta + ' · Recent history (up to approximately 12k tokens)');
        }
      }
      if (!host.children.length) host.textContent = 'No matching sources.';
    } catch (e) { if (e.name !== 'AbortError') host.textContent = e.message; }
  }
  $('.context-controls').oninput = () => { clearTimeout(timer); ctl?.abort(); timer = setTimeout(search, 180); };
  $('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { ctl?.abort(); clearTimeout(timer); revision++; totalRevision++; dialog.remove(); opener?.focus(); }, { once: true });
  dialog.showModal();
  try {
    projects = await api.projects();
    if (!dialog.open) return;
    for (const p of projects) { const o = document.createElement('option'); o.value = p.name; o.textContent = p.name; $('[data-project]').append(o); }
    $('[data-project]').value = api.project || '';
    search(); refreshAttached();
  } catch (e) { showText('[data-results]', e.message); }
};
