'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function publishNote({ note, title, abstract, sourceTitle, aiTitles, target, guard = () => {},
  mkdir = dir => fsp.mkdir(dir, { recursive: true }), write = (file, text) => fsp.writeFile(file, text) }) {
  function rendered(allowed) {
    const heading = allowed && title ? title : sourceTitle || 'Session';
    const lines = note.split('\n'); lines[0] = '# ' + heading;
    if (abstract) {
      const pos = lines.findIndex(line => line.startsWith('## '));
      lines.splice(pos >= 0 ? pos : lines.length, 0, '**Abstract.** ' + abstract, '');
    }
    return { title: heading, text: lines.join('\n') };
  }
  const initial = target(aiTitles() ? title : null);
  await mkdir(path.dirname(initial));
  const tmp = initial + '.tmp-' + crypto.randomUUID();
  try {
    await write(tmp, rendered(aiTitles()).text);
    guard();
    // No await between final permission/read, replacement content and rename.
    const allowed = aiTitles(), final = rendered(allowed), file = target(allowed ? title : null);
    fs.writeFileSync(tmp, final.text); fs.renameSync(tmp, file);
    return { file, title: final.title };
  } finally { await fsp.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
module.exports = { publishNote };
