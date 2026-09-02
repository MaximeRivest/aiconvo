'use strict';
// Spawn-free git metadata.
//
// Starting a `git` child from a large Node process costs ~10 ms of blocked
// event loop per spawn (fork copies the page tables). The repo index touches
// ~150 repositories, so every card refresh used to freeze the server for
// seconds. Everything here reads the plain files git keeps on disk instead:
// HEAD, refs/heads/*, packed-refs, config, and worktrees/*/gitdir. These
// formats are stable and documented (gitrepository-layout(5), git-config(1)).
//
// What this module does NOT do: read commit objects. Commit dates and
// subjects still need `git log`, but the caller only spawns that when HEAD
// moved, which is rare compared to a page load.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function readText(file) {
  try { return await fsp.readFile(file, 'utf8'); } catch { return null; }
}

// Walk up from `dir` to the nearest directory that holds `.git` (a directory
// for a main checkout, a file for worktrees and submodules). Mirrors
// `git rev-parse --show-toplevel` for the common case; it does not honor
// GIT_DIR / GIT_CEILING_DIRECTORIES, which the server never sets.
async function findGitRoot(dir) {
  let cur = path.resolve(String(dir || ''));
  // A folder that is gone answers '' (git -C fails there too); walking up
  // from it would wrongly adopt a parent's repository.
  try { if (!(await fsp.stat(cur)).isDirectory()) return ''; } catch { return ''; }
  // git answers the physical path: a symlinked checkout must not become a
  // second repository under its link name.
  try { cur = await fsp.realpath(cur); } catch { return ''; }
  for (let i = 0; i < 64; i++) {
    try {
      const st = await fsp.stat(path.join(cur, '.git'));
      if (st.isDirectory() || st.isFile()) return cur;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return '';
    cur = parent;
  }
  return '';
}

// The directory that holds this checkout's HEAD. For a worktree the `.git`
// entry is a file: `gitdir: <path to .git/worktrees/<name>>`.
async function gitDirOf(root) {
  const marker = path.join(root, '.git');
  try {
    const st = await fsp.stat(marker);
    if (st.isDirectory()) return marker;
    const text = await fsp.readFile(marker, 'utf8');
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (m) return path.resolve(root, m[1].trim());
  } catch {}
  return marker;
}

// Refs, packed-refs, and config live in the "common" dir. A worktree's git
// dir names it in a `commondir` file (usually `../..`).
async function commonDirOf(gitDir) {
  const text = await readText(path.join(gitDir, 'commondir'));
  if (!text) return gitDir;
  return path.resolve(gitDir, text.trim());
}

function parsePackedRefs(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line || line[0] === '#' || line[0] === '^') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    out.set(line.slice(sp + 1).trim(), line.slice(0, sp).trim());
  }
  return out;
}

async function resolveRef(commonDir, ref) {
  const loose = await readText(path.join(commonDir, ref));
  if (loose && /^[0-9a-f]{40,64}\s*$/i.test(loose)) return loose.trim();
  const packed = parsePackedRefs(await readText(path.join(commonDir, 'packed-refs')));
  return packed.get(ref) || '';
}

// { branch, head } for one checkout. branch is null on a detached HEAD.
// head is '' when the repository has no commits yet or is unreadable.
async function readHead(root) {
  const gitDir = await gitDirOf(root);
  const text = await readText(path.join(gitDir, 'HEAD'));
  if (!text) return { branch: null, head: '' };
  const line = text.trim();
  const sym = line.match(/^ref:\s*(.+)$/);
  if (!sym) return { branch: null, head: /^[0-9a-f]{40,64}$/i.test(line) ? line : '' };
  const ref = sym[1].trim();
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  const head = await resolveRef(await commonDirOf(gitDir), ref);
  return { branch, head };
}

// Minimal INI reader for `[remote "origin"] url = …`. Handles quoted section
// names, comments, and `include` directives are ignored (rare for remotes).
function parseRemoteUrl(configText, remote = 'origin') {
  let inSection = false;
  for (const raw of String(configText || '').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[') {
      const m = line.match(/^\[remote\s+"((?:[^"\\]|\\.)*)"\]/i);
      inSection = !!m && m[1].replace(/\\(.)/g, '$1') === remote;
      continue;
    }
    if (!inSection) continue;
    const kv = line.match(/^url\s*=\s*(.+)$/i);
    if (kv) return kv[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return '';
}

async function readRemoteUrl(root, remote = 'origin') {
  const gitDir = await gitDirOf(root);
  const common = await commonDirOf(gitDir);
  return parseRemoteUrl(await readText(path.join(common, 'config')), remote);
}

// Every checkout that shares this repository's object store: the main
// worktree plus each entry under <common>/worktrees/<name>/gitdir (a file
// whose content is the path of that worktree's `.git` file). Pruned or
// missing worktrees are skipped.
async function listWorktrees(root) {
  const gitDir = await gitDirOf(root);
  const common = await commonDirOf(gitDir);
  const roots = new Set();
  // The main worktree is the parent of the common dir when it is a plain
  // `.git` directory; a bare repo has none, so fall back to `root`.
  const mainMarker = path.join(path.dirname(common), '.git');
  try { if ((await fsp.stat(mainMarker)).isDirectory()) roots.add(path.dirname(common)); } catch {}
  roots.add(path.resolve(root));
  let names = [];
  try { names = await fsp.readdir(path.join(common, 'worktrees')); } catch {}
  for (const name of names) {
    const text = await readText(path.join(common, 'worktrees', name, 'gitdir'));
    if (!text) continue;
    const wtRoot = path.dirname(text.trim());
    try { if ((await fsp.stat(wtRoot)).isDirectory()) roots.add(path.resolve(wtRoot)); } catch {}
  }
  return [...roots];
}

// A cheap change signal for the worktree list: the worktrees dir mtime.
async function worktreesStamp(root) {
  const gitDir = await gitDirOf(root);
  const common = await commonDirOf(gitDir);
  const stamp = async file => { try { const st = await fsp.stat(file); return `${st.mtimeMs}:${st.size}`; } catch { return '0'; } };
  return (await stamp(path.join(common, 'worktrees'))) + '|' + (await stamp(path.join(gitDir, 'HEAD')));
}

module.exports = {
  findGitRoot, gitDirOf, commonDirOf, readHead, readRemoteUrl, listWorktrees, worktreesStamp,
  parsePackedRefs, parseRemoteUrl,
};
