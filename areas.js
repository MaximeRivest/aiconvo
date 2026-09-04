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

// Candidate-folder rows for the area picker. Pure join of three inputs:
//   found:    Map rel -> { exists, git }   (the on-disk walk)
//   own:      Map rel -> { n, lastMs }     (conversations by the folder they ran in)
//   declared: { rel: { title? } }          (the registry)
// Folders that only conversations or declarations know about are added,
// with their ancestors, so the tree stays connected. Counts are inclusive
// (a folder counts the conversations of its descendants), because that is
// what joins the area when it is declared.
function folderRows({ found, own, declared, exists = () => false }) {
  const rows = new Map(found);
  const declaredRels = Object.keys(declared || {});
  for (const rel of [...own.keys(), ...declaredRels]) {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const r = parts.slice(0, i).join('/');
      if (!rows.has(r)) rows.set(r, { exists: !!exists(r), git: false });
    }
  }
  const out = [];
  for (const [rel, info] of rows) {
    let n = 0, lastMs = 0;
    for (const [r, rec] of own) {
      if (!relInArea(r, rel)) continue;
      n += rec.n; lastMs = Math.max(lastMs, rec.lastMs || 0);
    }
    const here = own.get(rel);
    out.push({
      rel, depth: rel.split('/').length, exists: !!info.exists, git: !!info.git,
      conversations: n, own: here ? here.n : 0, lastTs: lastMs ? new Date(lastMs).toISOString() : null,
      declared: rel in (declared || {}), title: (declared && declared[rel] && declared[rel].title) || null,
      inside: deepestAreaOf(rel, declaredRels.filter(a => a !== rel)),
    });
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

module.exports = { normalizeAreaRel, projectRootOfCwd, relOfCwd, deepestAreaOf, relInArea, areaSlug, folderRows };
