'use strict';
const fs = require('node:fs');
const path = require('node:path');
function watchTree(baseDir, onFile, accept) {
  const watchers = new Map();
  function remove(dir) {
    for (const [d, w] of watchers) if (d === dir || d.startsWith(dir + path.sep)) { w.close(); watchers.delete(d); }
  }
  function add(dir, liveDirectory = false) {
    if (watchers.has(dir)) return;
    let ready = false; const known = new Set();
    function report(abs, created) {
      const rel = path.relative(baseDir, abs);
      if (!accept(rel)) return;
      let observation = { kind: 'discovery', observedAt: Date.now() };
      if (created) try {
        const st = fs.statSync(abs);
        if (st.isFile()) observation = { kind: 'watch-create', observedAt: Date.now(), birthtimeMs: st.birthtimeMs, dev: st.dev, ino: st.ino };
      } catch {}
      onFile(rel, observation);
    }
    let watcher;
    try {
      watcher = fs.watch(dir, (event, name) => {
        if (!name) return;
        const abs = path.join(dir, String(name));
        let st;
        try { st = fs.statSync(abs); } catch {
          known.delete(String(name)); if (watchers.has(abs)) remove(abs);
          const rel = path.relative(baseDir, abs); if (accept(rel)) onFile(rel, { kind: 'deletion', observedAt: Date.now() });
          return;
        }
        const created = ready && event === 'rename' && !known.has(String(name));
        known.add(String(name));
        if (st.isDirectory()) add(abs, created);
        else if (st.isFile()) report(abs, created);
      });
    } catch (e) { console.error('watch failed:', dir, e.message); return; }
    watcher.on('error', () => remove(dir)); watchers.set(dir, watcher);
    fs.readdir(dir, { withFileTypes: true }, (error, entries) => {
      if (error || !watchers.has(dir)) return;
      for (const entry of entries) {
        known.add(entry.name); const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) add(abs, liveDirectory);
        else if (entry.isFile()) report(abs, liveDirectory);
      }
      ready = true;
    });
  }
  add(baseDir);
  return { close: () => remove(baseDir), count: () => watchers.size };
}
module.exports = { watchTree };
