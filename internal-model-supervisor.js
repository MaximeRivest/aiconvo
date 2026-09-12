'use strict';
// Keep the owned process-group ID anchored until the parent kills the whole
// group. The model worker may exit or close all stdio before its descendants.
process.on('SIGTERM', () => {});
const { fork } = require('node:child_process');
const worker = fork(process.argv[2], [], { detached: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
let terminal = false;
function send(packet) { if (process.connected) process.send(packet, () => {}); }
worker.on('message', packet => {
  if (packet.type === 'result' || packet.type === 'error') terminal = true;
  send(packet);
});
worker.on('error', error => { terminal = true; send({ type: 'error', error: error.message }); });
worker.on('exit', () => {
  if (!terminal) send({ type: 'error', error: 'Internal model worker exited before completion' });
});
process.on('message', packet => { if (worker.connected) worker.send(packet, () => {}); });
// Parent disappearance: anchor is still alive here, so the PGID cannot have
// been reused. Never target a group other than this detached supervisor's.
process.on('disconnect', () => { process.kill(-process.pid, 'SIGKILL'); });
setInterval(() => {}, 60000);
