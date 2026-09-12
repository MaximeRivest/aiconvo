'use strict';
const fs = require('node:fs/promises');
// Verification only: never signal a PGID after its anchor has been reaped.
async function waitGroupExit(pgid, timeoutMs = 2000) {
  if (process.platform !== 'linux') throw new Error('Whole-group exit verification requires Linux /proc');
  const deadline = performance.now() + timeoutMs;
  do {
    let live = false;
    for (const pid of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pgid && !['Z', 'X'].includes(fields[0])) live = true;
      } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
    }
    if (!live) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error('Owned process group did not terminate within cleanup bound');
}
module.exports = { waitGroupExit };
