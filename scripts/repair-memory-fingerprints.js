#!/usr/bin/env node
'use strict';

// Default is read-only. --apply backs up original leaves before atomic replacement.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { upgradeLeaf } = require('../memory-fingerprint.js');
const cache = path.resolve(process.env.AICONVO_CACHE_DIR || path.join(os.homedir(), '.cache/aiconvo'));
const apply = process.argv.includes('--apply');
const sources = {
  pi: path.join(os.homedir(), '.pi/agent/sessions'),
  'pi-remote': path.join(os.homedir(), '.pi/remote/sessions'),
  claude: path.join(os.homedir(), '.claude/projects'),
};
const index = JSON.parse(fs.readFileSync(path.join(cache, 'index.json'), 'utf8'));
const backup = path.join(cache, 'memory-fingerprint-backups', new Date().toISOString().replace(/:/g, '-'));
const counts = { repaired: 0, eligible: 0, unchanged: 0, skipped: 0 };
for (const name of fs.readdirSync(path.join(cache, 'memory-leaves'))) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(cache, 'memory-leaves', name);
  let temp;
  try {
    const original = fs.readFileSync(file, 'utf8');
    const leaf = JSON.parse(original), entry = index[leaf.key];
    if (!entry || leaf.partial || leaf.memoryHash === entry.memoryHash) { counts.unchanged++; continue; }
    const cachedPath = path.join(cache, 'sessions', leaf.key.replace(/[:/\\]/g, '__') + '.json');
    const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
    const next = upgradeLeaf(leaf, entry, cached);
    if (next === leaf) { counts.unchanged++; continue; }
    const colon = leaf.key.indexOf(':'), root = sources[leaf.key.slice(0, colon)];
    if (!root) { counts.skipped++; continue; }
    const source = path.resolve(root, leaf.key.slice(colon + 1));
    if (!source.startsWith(root + path.sep)) { counts.skipped++; continue; }
    const stat = fs.statSync(source);
    // Do not repair from an out-of-date index or a cache from another scan.
    if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size ||
        cached.mtimeMs !== entry.mtimeMs || cached.size !== entry.size ||
        cached.memoryHash !== entry.memoryHash) { counts.skipped++; continue; }
    counts.eligible++;
    if (!apply) continue;
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(backup, name), original, { flag: 'wx', mode: 0o600 });
    temp = file + '.repair-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
    const latest = fs.statSync(source);
    // A running extraction must win over this repair. Avoid recently written
    // leaves too, since their writer could still be completing a job.
    if (fs.readFileSync(file, 'utf8') !== original || latest.mtimeMs !== stat.mtimeMs ||
        latest.size !== stat.size || Date.now() - fs.statSync(file).mtimeMs < 60000) {
      counts.skipped++; continue;
    }
    fs.renameSync(temp, file);
    counts.repaired++;
  } catch (error) {
    counts.skipped++;
    console.error(name + ': ' + error.message);
  } finally {
    if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
console.log(JSON.stringify({ apply, ...counts, backup: counts.repaired ? backup : null }, null, 2));
