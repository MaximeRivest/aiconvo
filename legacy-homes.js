'use strict';
// The product was called "aiconvo" until 2026-09-22. Its data lived under
// that name in the home directory. On the first start after the rename,
// each place is moved to the new name: once, only when the new place does
// not exist yet, and as a rename (same file system, atomic, nothing
// copied). A place that cannot be moved (another file system, permissions)
// is reported and left where it was, so the server still starts.
//
// The skip that matters is "destination exists": it means something wrote
// under the new name before this ran (on 2026-09-22 on lambda, a second
// server started early and ~/.local/share/chattering grew next to the
// 1.6 GB under the old name, which was then invisible). That case is
// logged loudly, with the merge instruction, never silently.
//
// Pure with respect to its inputs: the caller names the home directory and
// the file system, so the tests run it against a temporary home.
const fs = require('fs');
const path = require('path');

const OLD = 'aiconvo';
const NEW = 'chattering';

// [old relative path, new relative path], under the home directory.
const PLACES = [
  [path.join('.cache', OLD), path.join('.cache', NEW)],
  [path.join('.config', OLD), path.join('.config', NEW)],
  [path.join('.local', 'share', OLD), path.join('.local', 'share', NEW)],
  [path.join('notes', OLD), path.join('notes', NEW)],
];

function migrateHome(home, { fsx = fs, log = () => {} } = {}) {
  const moved = [];
  const skipped = [];
  for (const [oldRel, newRel] of PLACES) {
    const from = path.join(home, oldRel);
    const to = path.join(home, newRel);
    let fromStat;
    try { fromStat = fsx.lstatSync(from); } catch { continue; }
    if (fromStat.isSymbolicLink()) { skipped.push({ from, to, why: 'symlink' }); continue; }
    if (fsx.existsSync(to)) {
      skipped.push({ from, to, why: 'destination exists' });
      log(`[rename] NOT moved: ${from} still holds data but ${to} already exists. Stop the server, merge ${from} into ${to} by hand, then remove ${from}.`);
      continue;
    }
    try {
      fsx.mkdirSync(path.dirname(to), { recursive: true });
      fsx.renameSync(from, to);
      moved.push({ from, to });
      log(`[rename] moved ${from} → ${to}`);
    } catch (e) {
      skipped.push({ from, to, why: e.message });
      log(`[rename] could not move ${from} → ${to}: ${e.message}`);
    }
  }
  return { moved, skipped };
}

module.exports = { migrateHome, PLACES };
