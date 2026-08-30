'use strict';
// projectfolds.js — one project identity across worktrees and renamed dirs.
//
// A "project" everywhere in aiconvo is a name computed from a cwd. Two git
// worktrees of one repo therefore split into two projects. This module folds
// raw names into one canonical name through two layers:
//
//   1. aliases — the user's manual folds, a small JSON file under the notes
//      tree (user data, survives cache wipes). A self-alias ("foo": "foo")
//      PINS a name: it blocks automatic folding for that name.
//   2. auto — automatic worktree folds, a derived cache: the raw name of a
//      linked worktree maps to the raw name of its main worktree.
//
// Aliases win over auto folds. Resolution follows chains a few hops and
// never loops. Everything here is pure and synchronous; the server owns
// file I/O timing and the git probing that fills the auto map.

const LOOSE_PROJECT = 'Loose conversations';

// A conversation can have a working directory without belonging to a
// project. Keep common launch and temporary directories in one collection
// instead of inventing projects named "maxime", "Projects", or "tmp".
function isLooseCwd(cwd) {
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!c) return true;
  if (/^\/(?:home|Users)\/[^/]+(?:\/Projects)?$/i.test(c)) return true;
  if (/^[A-Z]:\/Users\/[^/]+(?:\/Projects)?$/i.test(c)) return true;
  if (/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(c)) return true;
  if (/^[A-Z]:\/Users\/[^/]+\/AppData\/Local\/Temp(?:\/|$)/i.test(c)) return true;
  return false;
}

// The one place the raw name comes from. The segment after /Projects/ wins;
// other real folders use their last segment. General folders stay loose.
// Case-insensitive, the same rule as isLooseCwd: ~/projects and ~/Projects
// are one convention, not two.
function rawProjectOf(cwd) {
  if (isLooseCwd(cwd)) return LOOSE_PROJECT;
  const c = String(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  const m = c.match(/\/Projects\/([^/]+)/i);
  if (m) return m[1];
  const parts = c.split('/').filter(Boolean);
  return parts[parts.length - 1] || LOOSE_PROJECT;
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

// Follow aliases (then auto folds) to the canonical name. A self-alias
// stops resolution: that is the pin that keeps a worktree its own project.
function canonicalize(name, aliases = {}, auto = {}) {
  let cur = String(name || '');
  for (let i = 0; i < 6; i++) {
    const next = own(aliases, cur) ? aliases[cur] : own(auto, cur) ? auto[cur] : cur;
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

// The flattened raw → canonical map the client applies inside projectOf().
// Only changed names appear: the map stays tiny.
function flattenMap(names, aliases = {}, auto = {}) {
  const all = new Set([...names, ...Object.keys(aliases), ...Object.keys(auto)]);
  const map = {};
  for (const name of all) {
    const canon = canonicalize(name, aliases, auto);
    if (canon !== name) map[name] = canon;
  }
  return map;
}

// The user folds `from` into `into`. Existing aliases that land on `from`
// re-point to `into`; `into` loses any own redirect so it stays visible.
function foldAlias(store, from, into) {
  from = String(from || '').trim();
  into = String(into || '').trim();
  if (!from || !into || from === into) throw new Error('fold needs two different project names');
  store.aliases = store.aliases || {};
  for (const [k, v] of Object.entries(store.aliases)) {
    if (v === from && k !== into) store.aliases[k] = into;
  }
  delete store.aliases[into];
  store.aliases[from] = into;
  const pair = dismissKey(from, into);
  store.dismissed = (store.dismissed || []).filter(d => d !== pair);
  return store;
}

// Undo a fold. When an automatic worktree fold still applies, a self-alias
// pins the name so it stays its own project.
function unfold(store, name, auto = {}) {
  store.aliases = store.aliases || {};
  delete store.aliases[name];
  if (canonicalize(name, {}, auto) !== name) store.aliases[name] = name;
  return store;
}

// One order-free key per suggested pair, for the dismissed list.
function dismissKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

// git@github.com:u/r.git and https://github.com/u/r.git become one key.
function normalizeRemote(url) {
  let u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^[a-z+.-]+:\/\//, '');
  u = u.replace(/^[^@/]+@/, '');
  u = u.replace(/:(?=[^/])/, '/');
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  return u;
}

const SEP = /^[-_. ]/;

// Fold suggestions over CANONICAL names (already-folded pairs cannot appear).
//   counts:  { name: conversationCount }
//   remotes: { name: [normalized remote, …] }  (git evidence)
//   dismissed: ['a|b', …] order-free pairs the user rejected
// Direction: the smaller project folds into the bigger one; on a tie the
// longer name folds into the shorter. Precision over recall: a remote group
// suggests one star around its biggest member (not every pair), and a name
// twin is dropped when git shows two different repositories.
function suggestPairs(counts = {}, remotes = {}, dismissed = []) {
  const names = [...new Set([...Object.keys(counts), ...Object.keys(remotes)])]
    .filter(n => n && n !== '?');
  const seen = new Set(dismissed);
  const out = [];
  const push = (a, b, reason) => {
    if (a === b) return;
    const key = dismissKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    const ca = counts[a] || 0, cb = counts[b] || 0;
    let from = a, into = b;
    if (ca > cb || (ca === cb && a.length < b.length)) { from = b; into = a; }
    out.push({ from, into, reason });
  };
  // Both sides have git remotes and none is shared: two different repos.
  const disjointKnownRemotes = (a, b) => {
    const ra = remotes[a] || [], rb = new Set(remotes[b] || []);
    if (!ra.length || !rb.size) return false;
    return !ra.some(r => rb.has(r));
  };
  // Same git remote: the strongest evidence two projects are one. Each
  // group suggests folding every member into the biggest one.
  const byRemote = new Map();
  for (const [name, list] of Object.entries(remotes)) {
    for (const r of list || []) {
      if (!r) continue;
      if (!byRemote.has(r)) byRemote.set(r, new Set());
      byRemote.get(r).add(name);
    }
  }
  for (const group of byRemote.values()) {
    const list = [...group];
    if (list.length < 2) continue;
    const hub = list.reduce((best, n) => {
      const cb = counts[best] || 0, cn = counts[n] || 0;
      return cn > cb || (cn === cb && n.length < best.length) ? n : best;
    });
    for (const n of list) if (n !== hub) push(n, hub, 'same git remote');
  }
  // Name shape: foo-v2 / foo.bak / foo_old next to foo, or a case twin.
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      const a = names[i], b = names[j];
      if (b.length < 3 || a.length <= b.length) continue;
      const al = a.toLowerCase(), bl = b.toLowerCase();
      if (al.startsWith(bl) && SEP.test(a.slice(b.length)) && !disjointKnownRemotes(a, b)) {
        push(a, b, 'name prefix');
      }
    }
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (a !== b && a.toLowerCase() === b.toLowerCase() && !disjointKnownRemotes(a, b)) {
        push(a, b, 'same name, different case');
      }
    }
  }
  return out;
}

module.exports = { LOOSE_PROJECT, isLooseCwd, rawProjectOf, canonicalize, flattenMap, foldAlias, unfold, dismissKey, normalizeRemote, suggestPairs };
