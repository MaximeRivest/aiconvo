'use strict';
// A chronological view of real saved observations and clearly labelled reconstructions.
async function fileWsHistoryDrawer(ws, selection = {}) {
  if (fileWs !== ws || !ws.row || ws.mode !== 'history') return;
  const ticket = ws.drawerRequest = (ws.drawerRequest || 0) + 1;
  let host = $('fwHistoryDrawer');
  if (!host) {
    host = document.createElement('aside'); host.id = 'fwHistoryDrawer'; host.className = 'fw-history-drawer';
    host.setAttribute('aria-label', 'File history');
    $('ffMain').before(host);
  }
  host.textContent = 'Loading recorded versions…';
  try {
    const doc = await filePointsFor(ws.row, true, selection);
    if (fileWs !== ws || ws.mode !== 'history' || ws.drawerRequest !== ticket) return;
    const points = doc.points;
    const usable = points.filter(p => p.state !== 'unavailable');
    if (!usable.length) { host.textContent = 'No readable versions have been saved yet.'; return; }
    const newest = [...usable].reverse().find(p => p.kind === 'saved') || usable.at(-1);
    const pick = id => id ? usable.find(p => p.id === id || p.eventId === id) : null;
    if ((selection.to && !pick(selection.to)) || (selection.from && !pick(selection.from))) throw new Error('The requested version is unavailable. Return to Live to choose another version.');
    let to = pick(selection.to) || newest;
    let from = pick(selection.from) || to;
    if (from.order > to.order) [from, to] = [to, from];
    ws.historySel = { from: from.id, to: to.id };
    const comparing = from.id !== to.id;
    const label = p => p.kind === 'current' ? 'Live file' : p.kind === 'saved' ? p.label : p.kind === 'ai' ? 'Reconstructed · ' + (p.title || 'agent edit') : p.kind === 'git' ? 'Git · ' + (p.subject || p.shortHash) : p.label || 'Recorded boundary';
    host.innerHTML = `<header><b>History</b><button id="fhLive">Return to Live</button></header>
      <p class="fh-truth">${esc(doc.truth)}</p>
      <label><input id="fhCompare" type="checkbox" ${comparing ? 'checked' : ''}> Compare two versions</label>
      <label id="fhFromLabel" ${comparing ? '' : 'hidden'}>From <select id="fhFrom" aria-label="Earlier version"></select></label>
      <label>To <select id="fhTo" aria-label="Version to read"></select></label>
      <nav class="fh-step"><button id="fhOlder">← Older</button><button id="fhNewer">Newer →</button></nav>
      <p class="fh-readonly" role="status">Read-only · ${to.state === 'deleted' ? 'Deletion observed' : to.kind === 'current' ? 'Current disk contents' : 'Recorded ' + new Date(to.ms).toLocaleString()}</p>
      <div class="fh-versions">${[...points].reverse().map(p => `<button data-fh-point="${esc(p.id)}" ${p.state === 'unavailable' ? 'disabled' : ''} aria-current="${p.id === to.id ? 'true' : 'false'}"><time>${p.kind === 'current' ? 'Now' : esc(new Date(p.ms).toLocaleString())}</time><span>${esc(label(p))}</span></button>`).join('')}</div>`;
    const options = [...usable].reverse().map(p => `<option value="${esc(p.id)}">${p.kind === 'current' ? 'Now' : esc(new Date(p.ms).toLocaleString())} · ${esc(label(p))}</option>`).join('');
    $('fhFrom').innerHTML = $('fhTo').innerHTML = options;
    $('fhFrom').value = from.id; $('fhTo').value = to.id;
    $('fhLive').onclick = () => fileWsEnterWrite();
    const select = (toId, fromId) => fileWsHistoryDrawer(ws, { from: fromId || toId, to: toId });
    $('fhCompare').onchange = () => {
      const i = usable.findIndex(p => p.id === to.id);
      select(to.id, $('fhCompare').checked ? usable[Math.max(0, i - 1)].id : to.id);
    };
    $('fhFrom').onchange = () => select(to.id, $('fhFrom').value);
    $('fhTo').onchange = () => select($('fhTo').value, comparing ? from.id : null);
    const i = usable.findIndex(p => p.id === to.id);
    $('fhOlder').disabled = i <= 0; $('fhNewer').disabled = i >= usable.length - 1;
    $('fhOlder').onclick = () => select(usable[Math.max(0, i - 1)].id, comparing ? from.id : null);
    $('fhNewer').onclick = () => select(usable[Math.min(usable.length - 1, i + 1)].id, comparing ? from.id : null);
    host.querySelectorAll('[data-fh-point]').forEach(b => b.onclick = () => select(b.dataset.fhPoint, comparing ? from.id : null));
    fileReadingMode = !comparing;
    await loadFocusedFile(ws.row, ws.historySel, { keepTree: true, keepTimeline: true });
    if (fileWs !== ws || ws.mode !== 'history' || ws.drawerRequest !== ticket) return;
    // A file route carries the chosen versions, including a one-version read.
    currentHash = fileWsHash(ws);
    history.replaceState(null, '', location.pathname + location.search + '#' + currentHash);
  } catch (e) { if (fileWs === ws && host.isConnected && ws.drawerRequest === ticket) host.textContent = 'History unavailable: ' + e.message; }
}
