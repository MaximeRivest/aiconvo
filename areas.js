'use strict';
// areas.js — declared inner scopes of a project.
//
// An area is the inverse of a fold. A fold merges many directories into one
// project name; an area splits one project into declared inner places. The
// default rule never changes: a subfolder belongs to its parent project.
// Areas are opt-in exceptions the user declares, one JSON registry under the
// notes tree (user data, survives cache wipes).
//
// Everything here is pure and synchronous. Matching is rel-path based, so it
// is naturally fold-aware: a worktree's cwd yields the same rel path as the
// main checkout, and the registry keys on the canonical project name.

const foldsLib = require('./projectfolds.js');

// Clean a user-typed relative path. Rejects escapes and absolute paths by
// returning '' (the caller treats '' as invalid).
function normalizeAreaRel(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/')
    .map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  for (const p of parts) {
    if (p === '.' || p === '..') return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/.test(p)) return '';
  }
  return parts.join('/');
}

// The project root a cwd sits under: the path up to and including the
// FIRST /Projects/<name> segment (case-insensitive, the same rule as
// rawProjectOf). Outside ~/Projects the cwd names itself, so the cwd IS the
// root and no rel path exists.
function projectRootOfCwd(cwd) {
  if (foldsLib.isLooseCwd(cwd)) return null;
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const m = c.match(/^(.*?\/Projects\/[^/]+)(?:\/|$)/i);
  return m ? m[1] : c;
}

// The path of a cwd relative to its project root ('' at the root itself).
function relOfCwd(cwd) {
  const root = projectRootOfCwd(cwd);
  if (!root) return '';
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return c.length > root.length ? c.slice(root.length + 1) : '';
}

// The deepest declared area that contains this rel path, or null.
// Membership is inclusive: rel 'a/b/c' belongs to a declared area 'a/b'.
function deepestAreaOf(rel, declaredRels) {
  const r = String(rel || '');
  let best = null;
  for (const a of declaredRels || []) {
    if (r !== a && !r.startsWith(a + '/')) continue;
    if (!best || a.length > best.length) best = a;
  }
  return best;
}

// Does this cwd's rel path fall inside the area (inclusive)?
function relInArea(rel, areaRel) {
  return rel === areaRel || String(rel || '').startsWith(areaRel + '/');
}

// Filesystem-safe slug for the area memory directory.
function areaSlug(rel) {
  return String(rel || 'area').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'area';
}

module.exports = { normalizeAreaRel, projectRootOfCwd, relOfCwd, deepestAreaOf, relInArea, areaSlug };
