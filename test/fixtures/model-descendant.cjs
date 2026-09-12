'use strict';
if (process.argv[2] === 'descendant') {
  process.on('SIGTERM', () => {});
  process.send({ ready: process.pid }, () => process.disconnect());
  setInterval(() => {}, 1000);
} else {
  const fs = require('node:fs');
  const { fork } = require('node:child_process');
  process.on('message', packet => {
    if (packet.type === 'prepare') process.send({ type: 'ready' });
    if (packet.type !== 'invoke') return;
    const child = fork(__filename, ['descendant'], { detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', data => {
      fs.writeFileSync(process.env.DESCENDANT_CAPTURE, JSON.stringify({ pid: data.ready, cwd: process.cwd() }));
      if (process.env.DESCENDANT_MODE === 'success') {
        process.send({ type: 'result', message: { content: [{ type: 'text', text: 'complete' }] } }, () => process.exit(0));
      }
    });
  });
}
