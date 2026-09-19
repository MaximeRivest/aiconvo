'use strict';
/* People on this install (design/46): who I am, who else is here and
   where, how a conversation or project is shared, and the settings pane
   that manages the roster. Globals from app.html: $, esc, toast, errToast,
   postJson, settingsOf, settingsState, viewKind, activeRel, fileWs,
   currentHash, sessions, renderSettings, saveSettings. */

const peopleState = { me: null, tier: null, users: [], groups: [], conn: null, people: [], docs: new Map(), lastReport: '' };
window.aiconvoMe = null;

const peopleUserById = id => peopleState.users.find(u => u.id === id) || null;
const peopleIsOwner = () => peopleState.tier === 'console' || peopleState.tier === 'owner';
const peopleManages = () => peopleIsOwner() || peopleState.tier === 'admin';
const peopleSeesAll = peopleManages;
function peopleName(id) { const u = peopleUserById(id); return u ? u.name : 'someone'; }
function userBubble(u, extraClass = '') {
  if (!u) return '';
  return `<span class="user-bubble ${extraClass}" style="--who:${esc(u.color || '#888')}" title="${esc(u.name || '')}">${esc(u.glyph || '?')}</span>`;
}

/* ---- live stream events ---- */
function peopleLiveEvent(d) {
  if (d.type === 'hello') {
    peopleState.me = d.me; peopleState.tier = d.tier; peopleState.conn = d.conn;
    peopleState.users = d.users || []; peopleState.people = d.people || [];
    window.aiconvoMe = d.me;
    peopleState.lastReport = '';
    renderPeopleHeader();
    peopleReportRoute();
    refreshShareControl();
    composeShareCheck();
    return true;
  }
  if (d.type === 'presence') { peopleState.people = d.people || []; renderPeopleHeader(); renderPresenceMarks(); return true; }
  if (d.type === 'users') { peopleState.users = d.users || []; peopleState.groups = d.groups || []; if (typeof settingsOpen !== 'undefined' && settingsOpen) renderSettings(); renderPeopleHeader(); return true; }
  if (d.type === 'collab-people') { peopleState.docs.set(d.name, d.people || []); return true; }
  if (d.type === 'access') { if (typeof refreshShareControl === 'function') refreshShareControl(); if (typeof load === 'function') load(); return true; }
  return false;
}

/* ---- presence: where I am ---- */
function peopleCurrentRoute() {
  const kind = typeof viewKind !== 'undefined' ? viewKind : 'home';
  if (kind === 'conversation' && typeof activeRel !== 'undefined' && activeRel) return 'conversation:' + activeRel;
  if (kind === 'draft' && typeof draftState !== 'undefined' && draftState) return 'draft:' + draftState.d.id;
  if ((kind === 'file' || kind === 'files-project') && typeof fileWs !== 'undefined' && fileWs && fileWs.path) return 'file:' + fileWs.path;
  if (kind === 'project') { const m = /project=([^&]+)/.exec(typeof currentHash !== 'undefined' ? currentHash : ''); if (m) return 'project:' + decodeURIComponent(m[1]); }
  if (kind === 'settings') return 'settings';
  return 'home';
}
let peopleReportTimer = 0, peopleKind = 'viewing', peopleTypingUntil = 0;
function peopleReportRoute({ kind, position } = {}) {
  if (!peopleState.conn) return;
  if (kind) peopleKind = kind;
  if (peopleKind === 'typing' && Date.now() > peopleTypingUntil) peopleKind = 'viewing';
  const body = { conn: peopleState.conn, route: peopleCurrentRoute(), kind: peopleKind, position: position || null };
  const sig = JSON.stringify(body);
  if (sig === peopleState.lastReport) return;
  clearTimeout(peopleReportTimer);
  peopleReportTimer = setTimeout(async () => {
    peopleState.lastReport = sig;
    try {
      const r = await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sig });
      if (r.status === 410) peopleState.lastReport = '';
    } catch {}
  }, 150);
}
// The composer says "typing" for a few seconds after each keystroke.
function peopleTyping() {
  peopleTypingUntil = Date.now() + 6000;
  peopleReportRoute({ kind: 'typing' });
  clearTimeout(peopleTyping.t);
  peopleTyping.t = setTimeout(() => peopleReportRoute({ kind: 'viewing' }), 6500);
}
window.addEventListener('aiconvo:route', () => { peopleKind = 'viewing'; peopleReportRoute(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { peopleState.lastReport = ''; peopleReportRoute(); } });

/* ---- the shared compose box ---- */
// One shared text per conversation (compose:<key>) or draft (draft:<id>).
// The composer keeps its textarea; the binding keeps it equal to the
// shared text, and the carets of others are drawn over it. Without a
// live stream identity or a reachable shared document the box stays a
// plain textarea: nothing is lost, only the sharing.
let composeShare = null; // { name, s, binding, ta, draw, unsub, poll, strip }
function composeShareDetach() {
  if (!composeShare) return;
  const c = composeShare;
  composeShare = null;
  clearInterval(c.poll);
  try { c.binding.unbind(); } catch {}
  try { c.unsub(); } catch {}
  if (c.strip && c.strip.isConnected) c.strip.remove();
  const layer = c.host && c.host.querySelector('.collab-carets');
  if (layer) layer.remove();
  collabLeave(c.s);
}
async function composeShareAttach(name, ta) {
  if (!ta || !name || !window.aiconvoMe || typeof collabJoin !== 'function') return;
  if (composeShare && composeShare.name === name && composeShare.ta === ta && ta.isConnected) return;
  if (composeShare && composeShare.name !== name) composeShareDetach();
  const host = ta.closest('.agent-compose') || ta.parentElement;
  const grow = () => {
    if (typeof autoGrowCompose === 'function') autoGrowCompose();
    if (typeof updateComposeMin === 'function') updateComposeMin();
    if (composeShare && composeShare.draw) composeShare.draw();
    // A draft keeps its text in this browser too: what others typed must
    // survive a reload here as well.
    if (typeof draftState !== 'undefined' && draftState && typeof viewKind !== 'undefined' && viewKind === 'draft' && ta.isConnected) { draftState.d.text = ta.value; if (typeof draftScheduleSave === 'function') draftScheduleSave(); }
  };
  if (composeShare) {
    // The composer re-rendered: same document, new textarea.
    const c = composeShare;
    try { c.binding.unbind(); } catch {}
    c.ta = ta; c.host = host;
    c.binding = collabBindTextarea(ta, c.s, { onRemoteChange: grow });
    c.draw = collabTextareaCursors(ta, host, c.s);
    composeShareStrip(c);
    c.draw();
    return;
  }
  let s;
  try { s = await collabJoin(name); } catch (e) { return; }
  if (!ta.isConnected || (composeShare && composeShare.name !== name)) { collabLeave(s); return; }
  const c = { name, s, ta, host, binding: null, draw: null, unsub: null, poll: 0, strip: null };
  c.binding = collabBindTextarea(ta, s, { onRemoteChange: grow });
  c.draw = collabTextareaCursors(ta, host, s);
  c.unsub = collabOnPeople(s, () => { composeShareStrip(c); c.draw(); });
  c.poll = setInterval(() => { if (!ta.isConnected) return; c.binding.sync(); c.draw(); }, 700);
  ta.addEventListener('scroll', () => c.draw());
  composeShare = c;
  composeShareStrip(c);
  c.draw();
}
function composeShareStrip(c) {
  if (!c.ta.isConnected) return;
  let strip = c.host.querySelector('#composePeople');
  if (!strip) { strip = document.createElement('div'); strip.id = 'composePeople'; c.ta.insertAdjacentElement('beforebegin', strip); }
  c.strip = strip;
  strip.innerHTML = collabPeopleHtml(c.s.people);
}
// Called by the conversation and draft renderers once the composer is on the page.
function composeShareCheck() {
  const ta = $('agentText');
  const kind = typeof viewKind !== 'undefined' ? viewKind : '';
  if (!ta) { composeShareDetach(); return; }
  if (kind === 'conversation' && typeof activeRel !== 'undefined' && activeRel) return composeShareAttach('compose:' + activeRel, ta);
  if (kind === 'draft' && typeof draftState !== 'undefined' && draftState) return composeShareAttach('draft:' + draftState.d.id, ta);
  composeShareDetach();
}
window.addEventListener('aiconvo:route', () => { const k = typeof viewKind !== 'undefined' ? viewKind : ''; if (k !== 'conversation' && k !== 'draft') composeShareDetach(); });
document.addEventListener('input', e => { if (e.target && e.target.id === 'agentText') peopleTyping(); });

/* ---- header: me, and the others on this install ---- */
function peopleOthersHere() {
  const me = peopleState.me && peopleState.me.id;
  const seen = new Map();
  for (const p of peopleState.people) { if (p.user.id === me) continue; const prev = seen.get(p.user.id); if (!prev || p.kind === 'typing') seen.set(p.user.id, p); }
  return [...seen.values()];
}
function peopleRouteLabel(route) {
  if (route.startsWith('conversation:')) { const key = route.slice(13); const s = (typeof sessions !== 'undefined' ? sessions : []).find(x => x.key === key); return s ? 'in “' + (s.timelineTitle?.title || s.title || 'a conversation').slice(0, 60) + '”' : 'in a conversation'; }
  if (route.startsWith('file:')) return 'editing ' + route.slice(5).split('/').pop();
  if (route.startsWith('project:')) return 'in project ' + route.slice(8);
  if (route.startsWith('draft:')) return 'writing a new conversation';
  if (route === 'settings') return 'in settings';
  return 'on the home page';
}
function renderPeopleHeader() {
  const btn = $('peopleBtn');
  if (!btn) return;
  const me = peopleState.me;
  const others = peopleOthersHere();
  btn.hidden = !me;
  if (!me) return;
  btn.innerHTML = userBubble(me, 'me') + others.slice(0, 4).map(p => userBubble(p.user, p.kind === 'typing' ? 'typing' : '')).join('') + (others.length > 4 ? `<span class="user-more">+${others.length - 4}</span>` : '');
  btn.title = 'You are ' + me.name + (others.length ? ' · also here: ' + others.map(p => p.user.name + ' (' + peopleRouteLabel(p.route) + (p.kind === 'typing' ? ', typing' : '') + ')').join(', ') : '') + ' — open people';
  btn.classList.toggle('has-others', others.length > 0);
  renderConversationPresence();
}
// "Lilly is typing…" under the conversation title; bubbles on list rows.
function renderConversationPresence() {
  const host = $('convPresence');
  if (!host) return;
  const route = peopleCurrentRoute();
  const me = peopleState.me && peopleState.me.id;
  const here = peopleState.people.filter(p => p.route === route && p.user.id !== me);
  if (!here.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const typing = here.filter(p => p.kind === 'typing').map(p => p.user.name);
  const label = typing.length ? typing.join(', ') + (typing.length === 1 ? ' is' : ' are') + ' typing…' : here.length === 1 ? here[0].user.name + ' is here too' : here.length + ' others are here';
  host.innerHTML = here.map(p => userBubble(p.user, p.kind === 'typing' ? 'typing' : '')).join('') + `<span class="presence-label">${esc(label)}</span>`;
}
function renderPresenceMarks() {
  const me = peopleState.me && peopleState.me.id;
  const byKey = new Map();
  for (const p of peopleState.people) {
    if (p.user.id === me || !p.route.startsWith('conversation:')) continue;
    const key = p.route.slice(13);
    if (!byKey.has(key)) byKey.set(key, []);
    if (!byKey.get(key).some(x => x.id === p.user.id)) byKey.get(key).push(p.user);
  }
  for (const el of document.querySelectorAll('[data-presence-key]')) {
    const list = byKey.get(el.dataset.presenceKey) || [];
    el.innerHTML = list.map(u => userBubble(u)).join('');
    el.hidden = !list.length;
  }
}
// Rows in lists call this: a slot the presence marks fill in.
function presenceSlotHtml(key) { return `<span class="presence-slot" data-presence-key="${esc(key)}" hidden></span>`; }

/* ---- "who" filter on the home list ---- */
// Mine: I wrote into it, or nobody is recorded and I am this machine's owner.
function sessionParticipantsOf(s) { return Array.isArray(s.participants) ? s.participants : []; }
function sessionInvolves(s, userId) {
  const parts = sessionParticipantsOf(s);
  if (parts.some(p => p.id === userId)) return true;
  if (!parts.length) { const u = peopleUserById(userId); return !!u && u.role === 'owner'; }
  return false;
}
function whoFilterOptions() {
  const me = peopleState.me;
  const opts = ['<option value="">everyone</option>'];
  if (me) opts.push(`<option value="${esc(me.id)}">mine</option>`);
  for (const u of peopleState.users) if (!me || u.id !== me.id) opts.push(`<option value="${esc(u.id)}">${esc(u.name)}</option>`);
  return opts.join('');
}
function participantsHtml(s) {
  const parts = sessionParticipantsOf(s).map(p => peopleUserById(p.id) || { id: p.id, name: p.name, glyph: (p.name || '?')[0].toUpperCase(), color: '#888' });
  if (!parts.length) return '';
  return `<span class="participants">${parts.map(u => userBubble(u)).join('')}</span>`;
}

/* ---- sharing: how a conversation or a project is shared ---- */
let shareState = null;
function shareLabel(summary) { return summary === 'everyone on this machine' ? 'shared with everyone here' : 'hidden: ' + summary.replace(/^only /, 'only '); }
async function refreshShareControl() {
  const btn = $('shareBtn');
  if (!btn) return;
  // Nothing to ask before the live stream said who we are.
  if (!peopleState.me) { btn.hidden = true; return; }
  const key = typeof activeRel !== 'undefined' && viewKind === 'conversation' ? activeRel : null;
  const m = viewKind === 'project' ? /project=([^&]+)/.exec(currentHash || '') : null;
  const project = m ? decodeURIComponent(m[1]) : null;
  if (!key && !project) { btn.hidden = true; return; }
  try {
    const d = await (await fetch('/api/access?' + (key ? 'id=' + encodeURIComponent(key) : 'project=' + encodeURIComponent(project)))).json();
    if (d.error) { btn.hidden = true; return; }
    shareState = { ...d, key, project };
    btn.hidden = false;
    btn.textContent = d.object ? '⊘' : '◎';
    btn.title = (d.object ? 'Hidden — ' + d.summary : 'Shared with everyone on this machine') + (d.own ? ' · change' : '');
    btn.classList.toggle('restricted', !!d.object);
  } catch { btn.hidden = true; }
}
function openShareDialog() {
  if (!shareState) return;
  const d = shareState;
  const me = peopleState.me;
  const what = d.key ? 'this conversation' : 'project ' + d.project;
  const rule = (d.key ? d.conversationRule : d.projectRule) || { mode: 'everyone', listed: {}, owners: [] };
  const inherited = d.key && !d.conversationRule && d.projectRule;
  const listedPeople = peopleState.users.filter(u => !me || u.id !== me.id);
  const groups = peopleState.groups;
  const row = (subject, label) => { const r = rule.listed[subject] || ''; return `<label class="share-row"><span>${esc(label)}</span><select data-subject="${esc(subject)}"><option value=""${!r ? ' selected' : ''}>no</option><option value="see"${r === 'see' ? ' selected' : ''}>can read</option><option value="act"${r === 'act' ? ' selected' : ''}>can read and act</option></select></label>`; };
  const dlg = document.createElement('div');
  dlg.className = 'share-dialog surface-dialog';
  dlg.innerHTML = `<div class="share-body">
    <h3>Who can see ${esc(what)}</h3>
    <p class="hint">${inherited ? 'Right now this follows its project: ' + esc(d.summary) + '.' : 'Right now: ' + esc(d.summary) + '.'} ${d.seesAll ? '' : ''}The owner of this machine always sees everything on it: these are polite walls, not vaults.</p>
    <label class="set-check"><input type="radio" name="shareMode" value="everyone"${rule.mode === 'everyone' ? ' checked' : ''}> everyone on this machine</label>
    <label class="set-check"><input type="radio" name="shareMode" value="listed"${rule.mode === 'listed' ? ' checked' : ''}> only me and the people below</label>
    <div class="share-list"${rule.mode === 'listed' ? '' : ' hidden'}>
      ${listedPeople.map(u => row('user:' + u.id, u.name)).join('') || '<span class="hint">no other people on this machine yet — add them in settings → people</span>'}
      ${groups.map(g => row('group:' + g.id, 'group ' + g.name)).join('')}
    </div>
    <div class="share-actions">${d.own ? `<button type="button" class="primary" id="shareSave">Save</button>${inherited || !d.object ? '' : ''}` : '<span class="hint">Only its owner can change this.</span>'}<button type="button" id="shareClose">Close</button></div>
  </div>`;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('#shareClose').onclick = close;
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.querySelectorAll('input[name=shareMode]').forEach(r => r.onchange = () => { dlg.querySelector('.share-list').hidden = dlg.querySelector('input[name=shareMode]:checked').value !== 'listed'; });
  const save = dlg.querySelector('#shareSave');
  if (save) save.onclick = async () => {
    const mode = dlg.querySelector('input[name=shareMode]:checked').value;
    const listed = {};
    dlg.querySelectorAll('select[data-subject]').forEach(s => { if (s.value) listed[s.dataset.subject] = s.value; });
    const out = await postJson('/api/access', { id: d.key || undefined, project: d.key ? undefined : d.project, mode, listed, owners: rule.owners.length ? rule.owners : undefined });
    if (out.error) return errToast(out.error);
    toast(mode === 'everyone' ? 'shared with everyone on this machine' : 'hidden — ' + out.summary);
    close();
    refreshShareControl();
  };
}

/* ---- settings → people ---- */
function panePeople() {
  const me = peopleState.me;
  const manages = peopleManages();
  const owner = peopleIsOwner();
  const roleWord = u => u.role === 'owner' ? 'owner of this machine' : u.role === 'admin' ? 'admin' : 'member';
  const row = u => `<div class="person-row${u.disabled ? ' disabled' : ''}" data-id="${esc(u.id)}">
      ${userBubble(u)}
      <div class="person-main"><b>${esc(u.name)}</b>${me && u.id === me.id ? ' <span class="hint">(you)</span>' : ''}<div class="hint">${esc(roleWord(u))}${u.groups.length ? ' · ' + esc(u.groups.join(', ')) : ''}${u.disabled ? ' · disabled' : ''}</div></div>
      <div class="person-actions">
        ${(manages || (me && u.id === me.id)) && !(u.role === 'owner' && !owner) ? `<button type="button" class="ghost" data-act="invite">new device link</button>` : ''}
        ${manages && !(u.role === 'owner' && !owner) ? `<button type="button" class="ghost" data-act="rename">rename</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="groups">groups</button>` : ''}
        ${owner && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="role">${u.role === 'admin' ? 'make member' : 'make admin'}</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="disable">${u.disabled ? 'enable' : 'disable'}</button>` : ''}
        ${owner && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="transfer">make owner</button>` : ''}
        ${manages && u.role !== 'owner' ? `<button type="button" class="ghost" data-act="merge">merge into…</button><button type="button" class="ghost" data-act="remove" title="Remove">✕</button>` : ''}
      </div>
    </div>`;
  return `<h2>people</h2>
    <p class="lead">${me ? 'You are <b>' + esc(me.name) + '</b>, ' + esc(roleWord(me)) + '.' : ''} People are the same person on every machine: when you switch machines from the header, you arrive there as yourself. Each machine keeps its own list of who is admitted.</p>
    <div class="set-group">
      <div class="set-group-head"><h3>on this machine</h3>${manages ? '<button type="button" id="setPersonAdd">add a person</button>' : ''}</div>
      <div id="setPeopleList">${peopleState.users.map(row).join('')}</div>
      <div class="set-status" id="setPeopleStatus"></div>
    </div>
    ${manages ? `<div class="set-group">
      <div class="set-group-head"><h3>groups</h3><button type="button" class="ghost" id="setGroupAdd">new group</button></div>
      <div id="setGroupList">${peopleState.groups.length ? peopleState.groups.map(g => `<div class="person-row" data-gid="${esc(g.id)}"><span class="user-bubble group">#</span><div class="person-main"><b>${esc(g.name)}</b><div class="hint">${esc(g.id)} · ${peopleState.users.filter(u => u.groups.includes(g.id)).map(u => u.name).join(', ') || 'nobody yet'}</div></div><div class="person-actions"><button type="button" class="ghost" data-gact="remove">✕</button></div></div>`).join('') : '<span class="hint">none — a group lets you share a project with several people at once (say, a department).</span>'}</div>
    </div>` : ''}
    <details class="set-more"><summary>how sharing works</summary><p>Everything on a machine is shared with everyone admitted to it, unless its owner hides it (the ⊘ button on a conversation or a project). Hidden things leave the lists, search and memory of the people they are hidden from. The owner of the machine — the account the agents run as — always sees everything on it; these are polite walls between people who share a computer, not vaults. Who typed each message, saved each file and vouched each note is recorded by name.</p></details>`;
}
function bindPanePeople(root) {
  const status = t => { const el = $('setPeopleStatus'); if (el) el.innerHTML = t; };
  const showLink = (link, who) => {
    status(`<div class="invite-box"><b>${esc(who)}'s link</b> — open it on their device, once. It is shown only now.<div class="row"><code class="mach-link">${esc(link)}</code><button type="button" class="ghost" data-copy="${esc(link)}">copy</button></div></div>`);
    const b = root.querySelector('#setPeopleStatus [data-copy]');
    if (b) b.onclick = async () => { try { await copyText(link); toast('link copied'); } catch (e) { errToast(e.message); } };
  };
  const call = async (op, body) => { const out = await postJson('/api/users/' + op, body); if (out.error) { errToast(out.error); return null; } peopleState.users = out.users || peopleState.users; peopleState.groups = out.groups || peopleState.groups; return out; };
  const add = $('setPersonAdd');
  if (add) add.onclick = async () => {
    const name = prompt('Name of the person:');
    if (!name || !name.trim()) return;
    const out = await call('add', { name: name.trim() });
    if (!out) return;
    renderSettings();
    showLink(out.inviteLink, out.user.name);
  };
  root.querySelectorAll('.person-row[data-id] [data-act]').forEach(b => b.onclick = async () => {
    const id = b.closest('.person-row').dataset.id, u = peopleUserById(id);
    const act = b.dataset.act;
    let out = null;
    if (act === 'invite') { const label = prompt('Which device is this link for? (optional)', '') ?? null; if (label === null) return; out = await call('invite', { id, label }); if (out) { renderSettings(); showLink(out.inviteLink, u.name); } return; }
    if (act === 'rename') { const name = prompt('New name:', u.name); if (!name || !name.trim()) return; out = await call('update', { id, name: name.trim() }); }
    if (act === 'groups') { const g = prompt('Groups, comma separated (short names, e.g. kids, eng):', u.groups.join(', ')); if (g === null) return; out = await call('update', { id, groups: g.split(',').map(x => x.trim()).filter(Boolean) }); }
    if (act === 'role') out = await call('update', { id, role: u.role === 'admin' ? 'member' : 'admin' });
    if (act === 'disable') out = await call('update', { id, disabled: !u.disabled });
    if (act === 'transfer') { if (!confirm('Make ' + u.name + ' the owner of this machine? You become an admin. The install token follows them.')) return; out = await call('transfer', { id }); }
    if (act === 'remove') { if (!confirm('Remove ' + u.name + ' from this machine? Their links stop working. What they wrote stays attributed to them.')) return; out = await call('remove', { id }); }
    if (act === 'merge') {
      const others = peopleState.users.filter(x => x.id !== id);
      const pick = prompt('Merge ' + u.name + ' into which person? (name)\n' + others.map(x => '· ' + x.name).join('\n'));
      const keep = others.find(x => pick && x.name.toLowerCase() === pick.trim().toLowerCase());
      if (!keep) return;
      if (!confirm('Merge ' + u.name + ' into ' + keep.name + '? Everything ' + u.name + ' wrote will count as ' + keep.name + '.')) return;
      out = await call('merge', { keep: keep.id, drop: id });
    }
    if (out) { toast('people updated'); renderSettings(); renderPeopleHeader(); }
  });
  const gadd = $('setGroupAdd');
  if (gadd) gadd.onclick = async () => { const name = prompt('Group name (short, e.g. kids or eng):'); if (!name || !name.trim()) return; const out = await call('group', { id: name.trim().toLowerCase(), name: name.trim() }); if (out) renderSettings(); };
  root.querySelectorAll('.person-row[data-gid] [data-gact=remove]').forEach(b => b.onclick = async () => { const gid = b.closest('.person-row').dataset.gid; if (!confirm('Remove group ' + gid + '?')) return; const out = await call('group', { id: gid, remove: true }); if (out) renderSettings(); });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { sessionInvolves, whoFilterOptions, shareLabel };
