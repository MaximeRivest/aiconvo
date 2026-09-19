'use strict';
// Users: the people who type, edit, vouch and take control. One roster per
// install (~/.config/aiconvo/users.json), plain JSON like everything else.
// A machine is where agents run and files live; a user is a person, the same
// person on every install. See design/46-users-and-multiplayer.md.
//
// Everything here is pure: the roster is a value, the caller loads and saves
// it. The server owns the file, the cookie and the request.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROSTER_VERSION = 1;
const ROLES = ['owner', 'admin', 'member'];
// Distinct enough on a screen; the e-ink theme uses the glyph, never the color.
const PALETTE = ['#c0392b', '#2471a3', '#1e8449', '#b9770e', '#7d3c98', '#117a65', '#a04000', '#5d6d7e'];
const SESSION_CREDENTIALS_KEPT = 6;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newSecret = () => crypto.randomBytes(18).toString('base64url');
const newId = prefix => prefix + '_' + crypto.randomBytes(8).toString('hex');

function glyphFor(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  const g = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : s.slice(0, 1);
  return g.toUpperCase();
}
function colorFor(id) {
  const h = parseInt(sha256(id).slice(0, 8), 16);
  return PALETTE[h % PALETTE.length];
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function cleanGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw) {
    const s = String(g || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// The public shape: what other browsers, presence and attribution see.
// Never the credentials.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, glyph: u.glyph, color: u.color, role: u.role, groups: [...(u.groups || [])], disabled: !!u.disabled };
}

function makeUser({ name, role = 'member', groups = [], id = null }) {
  const uid = id || newId('u');
  return {
    id: uid, name: cleanName(name) || 'someone', glyph: glyphFor(name), color: colorFor(uid),
    role: ROLES.includes(role) ? role : 'member', groups: cleanGroups(groups),
    createdAt: new Date().toISOString(), credentials: [],
  };
}

// A fresh roster: one owner, the person whose account this install is.
// The owner signs in with the install token (the LAN token file), so the
// devices already signed in keep working after the roster appears.
function createRoster({ ownerName }) {
  const owner = makeUser({ name: ownerName, role: 'owner' });
  owner.credentials.push({ id: newId('c'), kind: 'install', label: 'install token', createdAt: owner.createdAt });
  return { v: ROSTER_VERSION, users: [owner], groups: [], aliases: {} };
}

function normalizeRoster(raw, { ownerName } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const users = Array.isArray(r.users) ? r.users : [];
  const out = { v: ROSTER_VERSION, users: [], groups: [], aliases: {} };
  const seen = new Set();
  for (const u of users) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || seen.has(u.id)) continue;
    seen.add(u.id);
    const name = cleanName(u.name) || 'someone';
    out.users.push({
      id: u.id, name, glyph: cleanName(u.glyph).slice(0, 2) || glyphFor(name), color: /^#[0-9a-f]{6}$/i.test(u.color || '') ? u.color : colorFor(u.id),
      role: ROLES.includes(u.role) ? u.role : 'member', groups: cleanGroups(u.groups),
      createdAt: u.createdAt || new Date().toISOString(), disabled: !!u.disabled,
      credentials: (Array.isArray(u.credentials) ? u.credentials : []).filter(c => c && typeof c === 'object' && (c.kind === 'install' || typeof c.hash === 'string'))
        .map(c => ({ id: c.id || newId('c'), kind: ['install', 'invite', 'session'].includes(c.kind) ? c.kind : 'invite', hash: c.kind === 'install' ? undefined : c.hash, label: cleanName(c.label).slice(0, 40) || undefined, createdAt: c.createdAt || new Date().toISOString(), lastUsedAt: c.lastUsedAt || undefined })),
    });
  }
  for (const g of Array.isArray(r.groups) ? r.groups : []) {
    const id = cleanGroups([g && g.id])[0];
    if (id && !out.groups.some(x => x.id === id)) out.groups.push({ id, name: cleanName(g.name) || id });
  }
  // Exactly one owner. None: promote the first admin, else the first user,
  // else create the account's person. Several: the first stays, the rest
  // become admins.
  const owners = out.users.filter(u => u.role === 'owner');
  if (!owners.length) {
    const pick = out.users.find(u => u.role === 'admin') || out.users[0];
    if (pick) pick.role = 'owner';
    else out.users.push(createRoster({ ownerName }).users[0]);
  } else for (const extra of owners.slice(1)) extra.role = 'admin';
  const owner = out.users.find(u => u.role === 'owner');
  if (!owner.credentials.some(c => c.kind === 'install')) owner.credentials.unshift({ id: newId('c'), kind: 'install', label: 'install token', createdAt: owner.createdAt });
  // Merged ids: an old id still names the person it was folded into, so
  // attribution written before the merge keeps resolving.
  for (const [from, to] of Object.entries(r.aliases && typeof r.aliases === 'object' ? r.aliases : {})) {
    if (typeof from === 'string' && typeof to === 'string' && from !== to && seen.has(to) && !seen.has(from)) out.aliases[from] = to;
  }
  return out;
}

function loadRoster(file, { ownerName }) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!raw) return { roster: createRoster({ ownerName }), created: true };
  return { roster: normalizeRoster(raw, { ownerName }), created: false };
}
function saveRoster(file, roster) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(roster, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const ownerOf = roster => roster.users.find(u => u.role === 'owner');
const findUser = (roster, id) => roster.users.find(u => u.id === id) || (roster.aliases && roster.aliases[id] ? roster.users.find(u => u.id === resolveId(roster, id)) : null) || null;

function addUser(roster, spec) {
  const user = makeUser({ ...spec, role: spec.role === 'owner' ? 'member' : spec.role });
  roster.users.push(user);
  return user;
}

// Rename, regroup, promote or demote. Role changes obey two rules: nobody
// is made owner here (transferOwnership does that), and the owner keeps
// their role. Callers decide who may call this (owner or admin).
function updateUser(roster, id, patch) {
  const u = findUser(roster, id);
  if (!u) throw new Error('no such user');
  if (patch.name !== undefined) { const n = cleanName(patch.name); if (!n) throw new Error('a name is needed'); u.name = n; if (patch.glyph === undefined) u.glyph = glyphFor(n); }
  if (patch.glyph !== undefined) u.glyph = cleanName(patch.glyph).slice(0, 2) || glyphFor(u.name);
  if (patch.color !== undefined && /^#[0-9a-f]{6}$/i.test(patch.color)) u.color = patch.color;
  if (patch.groups !== undefined) u.groups = cleanGroups(patch.groups);
  if (patch.role !== undefined && u.role !== 'owner') {
    if (!['admin', 'member'].includes(patch.role)) throw new Error('role must be admin or member');
    u.role = patch.role;
  }
  if (patch.disabled !== undefined && u.role !== 'owner') u.disabled = !!patch.disabled;
  return u;
}

function transferOwnership(roster, toId) {
  const to = findUser(roster, toId);
  if (!to) throw new Error('no such user');
  const from = ownerOf(roster);
  if (from.id === to.id) return to;
  from.role = 'admin';
  to.role = 'owner';
  // The install token follows the ownership: it is the machine's own key.
  from.credentials = from.credentials.filter(c => c.kind !== 'install');
  if (!to.credentials.some(c => c.kind === 'install')) to.credentials.unshift({ id: newId('c'), kind: 'install', label: 'install token', createdAt: new Date().toISOString() });
  return to;
}

function removeUser(roster, id) {
  const u = findUser(roster, id);
  if (!u) throw new Error('no such user');
  if (u.role === 'owner') throw new Error('the owner cannot be removed — transfer ownership first');
  roster.users = roster.users.filter(x => x.id !== id);
  return u;
}

// Two roster entries that are the same person (installs paired late, each
// made its own "Maxime"). Keep one id; the caller rewrites references
// (attribution, access rules) from the dropped id to the kept one.
function mergeUsers(roster, keepId, dropId) {
  const keep = findUser(roster, keepId), drop = findUser(roster, dropId);
  if (!keep || !drop) throw new Error('no such user');
  if (keep.id === drop.id) return keep;
  if (drop.role === 'owner') throw new Error('merge into the owner, not the other way');
  keep.groups = cleanGroups([...keep.groups, ...drop.groups]);
  keep.credentials.push(...drop.credentials.filter(c => c.kind !== 'install'));
  roster.users = roster.users.filter(x => x.id !== drop.id);
  roster.aliases = roster.aliases || {};
  roster.aliases[drop.id] = keep.id;
  for (const [from, to] of Object.entries(roster.aliases)) if (to === drop.id) roster.aliases[from] = keep.id;
  return keep;
}
// The current id for a possibly merged one.
function resolveId(roster, id) {
  let cur = id;
  for (let i = 0; i < 10 && roster.aliases && roster.aliases[cur]; i++) cur = roster.aliases[cur];
  return cur;
}

// An invite credential: the secret is returned once and stored hashed,
// like an API token. Its link is what a person pastes on a new device.
function issueCredential(roster, userId, { label = '', kind = 'invite' } = {}) {
  const u = findUser(roster, userId);
  if (!u) throw new Error('no such user');
  const secret = newSecret();
  const credential = { id: newId('c'), kind: kind === 'session' ? 'session' : 'invite', hash: sha256(secret), label: cleanName(label).slice(0, 40) || undefined, createdAt: new Date().toISOString() };
  u.credentials.push(credential);
  if (credential.kind === 'session') {
    const sessions = u.credentials.filter(c => c.kind === 'session');
    if (sessions.length > SESSION_CREDENTIALS_KEPT) {
      const drop = new Set(sessions.slice(0, sessions.length - SESSION_CREDENTIALS_KEPT).map(c => c.id));
      u.credentials = u.credentials.filter(c => !drop.has(c.id));
    }
  }
  return { secret, credential };
}
function revokeCredential(roster, userId, credentialId) {
  const u = findUser(roster, userId);
  if (!u) throw new Error('no such user');
  const c = u.credentials.find(x => x.id === credentialId);
  if (!c) throw new Error('no such credential');
  if (c.kind === 'install') throw new Error('the install token is rotated from settings → machines, not here');
  u.credentials = u.credentials.filter(x => x.id !== credentialId);
  return c;
}

// Which person does this secret belong to? The install token is the owner's.
function userForSecret(roster, secret, installToken) {
  if (!secret) return null;
  if (installToken && safeEqual(secret, installToken)) return ownerOf(roster);
  const h = sha256(secret);
  for (const u of roster.users) {
    const c = u.credentials.find(x => x.kind !== 'install' && x.hash && safeEqual(x.hash, h));
    if (c) { c.lastUsedAt = new Date().toISOString(); return u; }
  }
  return null;
}

// What a request proves. tier: console (this machine's own console: the
// account itself), owner, admin, member; null when nothing is proven.
// A disabled user proves nothing.
function identify({ roster, installToken, isLocal, cookie, authorization }) {
  if (isLocal) return { user: ownerOf(roster), tier: 'console', via: 'console' };
  let secret = cookie || '';
  let via = 'cookie';
  const hdr = String(authorization || '');
  if (!secret && hdr.startsWith('Bearer ')) { secret = hdr.slice(7); via = 'bearer'; }
  else if (!secret && hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    secret = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    via = 'basic';
  }
  const user = userForSecret(roster, secret, installToken);
  if (!user || user.disabled) return null;
  return { user, tier: user.role, via };
}

const canManageUsers = identity => !!identity && ['console', 'owner', 'admin'].includes(identity.tier);
const isOwnerTier = identity => !!identity && (identity.tier === 'console' || identity.tier === 'owner');

// ---- handoff between paired installs ----
// Each install has an Ed25519 key. Paired installs exchange public keys.
// A handoff is a short-lived signed claim "this person is on their way",
// so a signed-in person lands on the other install already signed in, as
// themselves, without a paste. The trust is the trust pairing already
// grants: a paired install holds our token and we hold theirs.
function loadInstallKey(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.publicKey && raw.privateKey) {
      return { publicKey: raw.publicKey, privateKey: crypto.createPrivateKey({ key: Buffer.from(raw.privateKey, 'base64'), format: 'der', type: 'pkcs8' }) };
    }
  } catch {}
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey }) + '\n', { mode: 0o600 });
  return { publicKey, privateKey: pair.privateKey };
}

const b64u = buf => Buffer.from(buf).toString('base64url');
function mintHandoff(key, user, { ttlMs = 30000, now = Date.now() } = {}) {
  const payload = { v: 1, iss: key.publicKey, user: publicUser(user), iat: now, exp: now + ttlMs };
  const data = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, data, key.privateKey);
  return 'h1.' + b64u(data) + '.' + b64u(sig);
}
function verifyHandoff(token, { trustedPublicKeys, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'h1') throw new Error('not a handoff');
  const data = Buffer.from(parts[1], 'base64url');
  let payload;
  try { payload = JSON.parse(data.toString('utf8')); } catch { throw new Error('malformed handoff'); }
  if (!payload || payload.v !== 1 || !payload.iss || !payload.user || typeof payload.user.id !== 'string') throw new Error('malformed handoff');
  if (!(trustedPublicKeys || []).includes(payload.iss)) throw new Error('handoff from an install that is not paired here');
  const pub = crypto.createPublicKey({ key: Buffer.from(payload.iss, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, data, pub, Buffer.from(parts[2], 'base64url'))) throw new Error('handoff signature does not check out');
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('this handoff has expired');
  return { user: payload.user, iss: payload.iss };
}

// A person arriving by handoff joins this roster if they are new. An
// existing entry keeps its local name, role and groups: the other install
// does not manage this one.
function upsertHandoffUser(roster, claimed) {
  let u = findUser(roster, claimed.id);
  if (u) return { user: u, created: false };
  if (claimed.role === 'owner' && ownerOf(roster)) claimed = { ...claimed, role: 'member' };
  u = makeUser({ name: claimed.name, role: claimed.role === 'admin' ? 'admin' : 'member', groups: claimed.groups, id: claimed.id });
  if (claimed.glyph) u.glyph = cleanName(claimed.glyph).slice(0, 2) || u.glyph;
  if (/^#[0-9a-f]{6}$/i.test(claimed.color || '')) u.color = claimed.color;
  roster.users.push(u);
  return { user: u, created: true };
}

module.exports = {
  ROLES, PALETTE, glyphFor, colorFor, publicUser,
  createRoster, normalizeRoster, loadRoster, saveRoster, ownerOf, findUser,
  addUser, updateUser, transferOwnership, removeUser, mergeUsers, resolveId,
  issueCredential, revokeCredential, userForSecret, identify, canManageUsers, isOwnerTier,
  loadInstallKey, mintHandoff, verifyHandoff, upsertHandoffUser,
};
