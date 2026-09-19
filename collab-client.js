'use strict';
/* Shared documents in the browser (design/46): the compose box of a
   conversation, a draft, a file in the live editor. One WebSocket per open
   document to /api/collab/<name>; the CRDT and the provider come from the
   vendored editor bundle (mrmdDocument.collab). Who you are comes from the
   server (the live stream's hello); it rides in awareness so other people
   see your name at your cursor.

   Two bindings: a CodeMirror extension for editors, and a textarea binding
   for the composer (the composer keeps its textarea: dictation, snippets,
   slash commands and the keyboard shortcuts all talk to it). */

const collabSessions = new Map(); // name → session (shared by every binding on the page)

function collabWsUrl(name) {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/collab' + (name ? '/' + encodeURIComponent(name) : '');
}
function collabMe() {
  const me = window.aiconvoMe || null;
  return me ? { id: me.id, name: me.name, glyph: me.glyph, color: me.color, colorLight: me.color + '55' } : { id: 'anon', name: 'someone', glyph: '?', color: '#888888', colorLight: '#88888855' };
}

/* Open (or reuse) a shared document. Resolves once the first sync landed,
   rejects if the server does not answer in time (an old server, a proxy
   without WebSockets): callers then fall back to the single-player path. */
async function collabJoin(name, { timeoutMs = 5000 } = {}) {
  let s = collabSessions.get(name);
  if (s) { s.refs++; await s.ready; return s; }
  const bundle = await loadMrmdDocument();
  const collab = bundle.collab;
  if (!collab) throw new Error('this editor bundle has no collaboration support');
  const ydoc = new collab.Y.Doc();
  // The provider joins <server>/<room>: the server is the collab route,
  // the room is the document name. No cross-tab channel: to the server two
  // tabs are two presences, and the server is always the authority.
  const provider = new collab.WebsocketProvider(collabWsUrl('').replace(/\/$/, ''), encodeURIComponent(name), ydoc, { connect: false, disableBc: true, maxBackoffTime: 5000 });
  s = { name, ydoc, ytext: ydoc.getText('content'), provider, awareness: provider.awareness, refs: 1, people: [], listeners: new Set(), synced: false };
  s.awareness.setLocalStateField('user', collabMe());
  s.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => { if (!s.synced) { reject(new Error('the shared document did not answer')); collabLeave(s, true); } }, timeoutMs);
    provider.on('sync', ok => { if (ok && !s.synced) { s.synced = true; clearTimeout(t); resolve(s); } });
    provider.on('connection-error', () => { if (!s.synced) { clearTimeout(t); reject(new Error('could not reach the shared document')); collabLeave(s, true); } });
  });
  s.awareness.on('change', () => {
    const rows = [];
    const mine = s.awareness.clientID;
    for (const [id, st] of s.awareness.getStates()) if (id !== mine && st && st.user) rows.push({ clientId: id, ...st.user, cursor: st.cursor || null });
    s.people = rows;
    for (const fn of s.listeners) { try { fn(rows); } catch {} }
  });
  collabSessions.set(name, s);
  provider.connect();
  await s.ready;
  return s;
}
function collabLeave(s, force = false) {
  if (!s) return;
  s.refs--;
  if (s.refs > 0 && !force) return;
  collabSessions.delete(s.name);
  try { s.provider.destroy(); } catch {}
  try { s.ydoc.destroy(); } catch {}
}
function collabOnPeople(s, fn) { s.listeners.add(fn); fn(s.people); return () => s.listeners.delete(fn); }

/* The CodeMirror side: one extension, cursors and selections included. */
function collabEditorExtension(s) {
  const collab = window.mrmdDocument && window.mrmdDocument.collab;
  return collab ? [collab.yCollab(s.ytext, s.awareness)] : [];
}

/* The textarea side. Local input becomes one minimal replace on the shared
   text; remote changes land in the textarea with the caret kept where the
   person was (shifted by edits before it). Cursors of others are drawn by
   the caller from awareness (see collabTextareaCursors). */
function collabTextDiff(from, to) {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length, endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) { endFrom--; endTo--; }
  return { index: start, remove: endFrom - start, insert: to.slice(start, endTo) };
}
function collabBindTextarea(ta, s, { onRemoteChange } = {}) {
  let applying = false;
  // Local: whatever the box holds now versus the shared text. Comparing
  // against the shared text (not a remembered copy) means programmatic
  // changes to the box (dictation, snippets, the clear after a send) are
  // also picked up, by the next input event or the poll.
  const local = () => {
    if (applying) return;
    const now = ta.value;
    const d = collabTextDiff(s.ytext.toString(), now);
    if (!d) return;
    s.ydoc.transact(() => { if (d.remove) s.ytext.delete(d.index, d.remove); if (d.insert) s.ytext.insert(d.index, d.insert); }, 'local');
    cursor();
  };
  const remote = (event, tx) => {
    if (tx.origin === 'local') return;
    const next = s.ytext.toString();
    if (next === ta.value) return;
    // Keep the caret: shift it by every change that lands before it.
    let selStart = ta.selectionStart, selEnd = ta.selectionEnd, pos = 0;
    for (const op of event.changes.delta) {
      if (op.retain) pos += op.retain;
      else if (op.insert) { const n = op.insert.length; if (pos <= selStart) selStart += n; if (pos <= selEnd) selEnd += n; pos += n; }
      else if (op.delete) { const n = op.delete; if (pos < selStart) selStart = Math.max(pos, selStart - n); if (pos < selEnd) selEnd = Math.max(pos, selEnd - n); }
    }
    applying = true;
    const focused = document.activeElement === ta;
    ta.value = next;
    if (focused) { try { ta.setSelectionRange(selStart, selEnd); } catch {} }
    applying = false;
    if (onRemoteChange) onRemoteChange(next);
  };
  const cursor = () => s.awareness.setLocalStateField('cursor', document.activeElement === ta ? { anchor: ta.selectionStart, head: ta.selectionEnd } : null);
  // First contact: the shared text wins over what this box held, unless
  // the shared text is empty and this box is not (a draft typed offline).
  const shared = s.ytext.toString();
  if (shared) { if (ta.value !== shared) { ta.value = shared; if (onRemoteChange) onRemoteChange(shared); } }
  else if (ta.value) local();
  s.ytext.observe(remote);
  ta.addEventListener('input', local);
  for (const ev of ['keyup', 'click', 'select', 'focus']) ta.addEventListener(ev, cursor);
  ta.addEventListener('blur', cursor);
  return {
    // Programmatic edits (dictation, snippets) do not fire input: call this.
    sync: local,
    unbind() { s.ytext.unobserve(remote); ta.removeEventListener('input', local); for (const ev of ['keyup', 'click', 'select', 'focus', 'blur']) ta.removeEventListener(ev, cursor); s.awareness.setLocalStateField('cursor', null); },
  };
}

/* Where a character offset sits inside a textarea, in pixels relative to
   the textarea: a hidden mirror with the same text metrics. */
let collabMirror = null;
function collabCaretCoords(ta, offset) {
  if (!collabMirror) { collabMirror = document.createElement('div'); collabMirror.className = 'collab-mirror'; document.body.appendChild(collabMirror); }
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'tabSize']) collabMirror.style[p] = cs[p];
  collabMirror.style.width = ta.clientWidth + 'px';
  const text = ta.value;
  collabMirror.textContent = text.slice(0, offset);
  const mark = document.createElement('span');
  mark.textContent = text.slice(offset, offset + 1) || '\u200b';
  collabMirror.appendChild(mark);
  return { left: mark.offsetLeft - ta.scrollLeft, top: mark.offsetTop - ta.scrollTop, height: mark.offsetHeight || parseFloat(cs.lineHeight) || 18 };
}
/* Draw the other people's carets over a textarea. `host` is a positioned
   element wrapping the textarea. Returns a redraw function. */
function collabTextareaCursors(ta, host, s) {
  let layer = host.querySelector('.collab-carets');
  if (!layer) { layer = document.createElement('div'); layer.className = 'collab-carets'; host.appendChild(layer); }
  const draw = () => {
    if (!ta.isConnected) return;
    layer.innerHTML = '';
    const w = ta.clientWidth, h = ta.clientHeight;
    for (const p of s.people) {
      if (!p.cursor || typeof p.cursor.head !== 'number') continue;
      const head = Math.max(0, Math.min(ta.value.length, p.cursor.head));
      const c = collabCaretCoords(ta, head);
      if (c.top < -c.height || c.top > h + 4 || c.left < 0 || c.left > w) continue;
      const el = document.createElement('div');
      el.className = 'collab-caret';
      el.style.left = (ta.offsetLeft + c.left) + 'px';
      el.style.top = (ta.offsetTop + c.top) + 'px';
      el.style.height = c.height + 'px';
      el.style.setProperty('--who', p.color || '#888');
      el.innerHTML = `<span class="collab-caret-name">${esc(p.name || '?')}</span>`;
      layer.appendChild(el);
    }
  };
  return draw;
}

/* The small "who else is here" strip: glyph bubbles with names. */
function collabPeopleHtml(people, { verb = 'is also writing here' } = {}) {
  if (!people || !people.length) return '';
  const names = people.map(p => p.name).filter(Boolean);
  const label = names.length === 1 ? `${names[0]} ${verb}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} ${verb.replace(/^is /, 'are ')}`;
  return `<span class="collab-people">${people.map(p => `<span class="user-bubble" style="--who:${esc(p.color || '#888')}" title="${esc(p.name || '')}">${esc(p.glyph || '?')}</span>`).join('')}<span class="collab-people-label">${esc(label)}</span></span>`;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { collabTextDiff, collabPeopleHtml };
