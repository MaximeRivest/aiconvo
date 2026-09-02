'use strict';
// Build the PATH agents run with. User tool dirs go first; system dirs go
// last so they never shadow what the service already has. On NixOS this
// matters: /run/wrappers/bin (setuid sudo, ping, mount…) must stay ahead of
// /run/current-system/sw/bin, whose sudo is the unwrapped binary and refuses
// to run. Every dir appears once, so the result is idempotent: feeding the
// output back in as process.env.PATH yields the same string. pisdk.mergeEnv
// depends on that to stop rewriting process.env after the first call.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPERS = '/run/wrappers/bin';
const SW_BIN = '/run/current-system/sw/bin';

const defaultExists = d => { try { return fs.existsSync(d); } catch { return false; } };

// `opts.exists` and `opts.home` are injection points for tests; production
// callers pass nothing.
function agentPath(current, opts = {}) {
  const exists = opts.exists || defaultExists;
  const home = opts.home || os.homedir();
  const userDirs = [
    path.join(home, '.local/bin'),
    path.join(home, '.nvm/versions/node/v22.23.1/bin'),
  ].filter(exists);
  const systemDirs = [
    WRAPPERS, // NixOS setuid wrappers; must precede sw/bin
    SW_BIN,   // NixOS: xdg-open, git… live here
    '/snap/bin',
  ].filter(exists);
  const base = (current || '/usr/bin:/bin').split(':').filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const d of [...userDirs, ...base, ...systemDirs]) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  // Enforce the NixOS invariant even when the inherited PATH had it wrong.
  const w = out.indexOf(WRAPPERS);
  const s = out.indexOf(SW_BIN);
  if (w > s && s >= 0) {
    out.splice(w, 1);
    out.splice(s, 0, WRAPPERS);
  }
  return out.join(':');
}

module.exports = { agentPath, WRAPPERS, SW_BIN };
