'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { acceptWebSocket, acceptKey, frame, OP } = require('../wsserver.js');

async function serve(t, onConn) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => { const c = acceptWebSocket(req, socket, head, { maxPayload: 1 << 20 }); if (c) onConn(c, req); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return 'ws://127.0.0.1:' + server.address().port;
}
const open = ws => new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = e => rej(new Error('ws error')); });
const next = ws => new Promise(res => { ws.onmessage = ev => res(ev.data); });

test('handshake, echo of text and binary, and a clean close from the client', async t => {
  const seen = [];
  const url = await serve(t, c => {
    c.on('message', (data, binary) => { seen.push(binary); c.send(data); });
  });
  const ws = new WebSocket(url + '/x');
  ws.binaryType = 'arraybuffer';
  await open(ws);
  ws.send('héllo');
  assert.equal(await next(ws), 'héllo');
  ws.send(new Uint8Array([1, 2, 3, 250]));
  const bin = new Uint8Array(await next(ws));
  assert.deepEqual([...bin], [1, 2, 3, 250]);
  assert.deepEqual(seen, [false, true]);
  const closed = new Promise(r => { ws.onclose = ev => r(ev.code); });
  ws.close(1000, 'bye');
  assert.equal(await closed, 1000);
});

test('large messages cross the 16-bit and 64-bit length forms both ways', async t => {
  const url = await serve(t, c => c.on('message', d => c.send(d)));
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await open(ws);
  for (const size of [125, 126, 65535, 65536, 300000]) {
    const buf = new Uint8Array(size); for (let i = 0; i < size; i++) buf[i] = i & 255;
    ws.send(buf);
    const back = new Uint8Array(await next(ws));
    assert.equal(back.length, size);
    assert.equal(back[size - 1], (size - 1) & 255);
  }
  ws.close();
});

test('fragmented client messages are reassembled; ping is answered; unmasked frames are refused', async t => {
  let got = null;
  const url = await serve(t, c => c.on('message', d => { got = d; c.send('ok:' + d); }));
  const port = Number(new URL(url).port);
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.on('connect', r));
  const key = Buffer.from('0123456789abcdef').toString('base64');
  sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let inbound = Buffer.alloc(0);
  sock.on('data', d => { inbound = Buffer.concat([inbound, d]); });
  await new Promise(r => setTimeout(r, 100));
  const head = inbound.toString('latin1');
  assert.ok(head.startsWith('HTTP/1.1 101'));
  assert.ok(head.includes('Sec-WebSocket-Accept: ' + acceptKey(key)));
  inbound = inbound.subarray(head.indexOf('\r\n\r\n') + 4);
  const masked = (opcode, text, fin) => {
    const payload = Buffer.from(text, 'utf8'); const mask = Buffer.from([7, 8, 9, 10]);
    const out = Buffer.alloc(2 + 4 + payload.length);
    out[0] = (fin ? 0x80 : 0) | opcode; out[1] = 0x80 | payload.length; mask.copy(out, 2);
    for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i] ^ mask[i & 3];
    return out;
  };
  sock.write(masked(OP.TEXT, 'ab', false));
  sock.write(masked(OP.CONT, 'cd', false));
  sock.write(masked(OP.PING, 'p', true));
  sock.write(masked(OP.CONT, 'ef', true));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(got, 'abcdef');
  // Pong (opcode 10, 'p') arrives before the echo (opcode 1).
  assert.equal(inbound[0] & 0x0f, OP.PONG);
  assert.equal(inbound.subarray(2, 3).toString(), 'p');
  const echo = inbound.subarray(3);
  assert.equal(echo[0] & 0x0f, OP.TEXT);
  assert.equal(echo.subarray(2).toString(), 'ok:abcdef');
  // An unmasked frame is a protocol error: the server closes with 1002.
  inbound = Buffer.alloc(0);
  sock.write(frame(OP.TEXT, Buffer.from('nope')));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(inbound[0] & 0x0f, OP.CLOSE);
  assert.equal(inbound.readUInt16BE(2), 1002);
  sock.destroy();
});

test('a non-websocket upgrade is answered 400 and the connection dropped', async t => {
  const url = await serve(t, () => assert.fail('no connection expected'));
  const port = Number(new URL(url).port);
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.on('connect', r));
  sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n');
  const answer = await new Promise(r => sock.once('data', d => r(d.toString())));
  assert.ok(answer.startsWith('HTTP/1.1 400'));
});

test('server-initiated close ends the socket even if the peer stays silent', async t => {
  let conn;
  const url = await serve(t, c => { conn = c; });
  const ws = new WebSocket(url);
  await open(ws);
  const closed = new Promise(r => { ws.onclose = ev => r(ev.code); });
  conn.close(4001, 'go away');
  assert.equal(await closed, 4001);
  assert.equal(conn.readyState, 'closed');
});

// A peer that vanishes (connection reset) ends the connection; it must not
// surface as an unhandled 'error' event, which would end the whole process.
// Seen on two installs: the process died every time a WebSocket's socket
// reported ECONNRESET or ETIMEDOUT.
test('a socket error closes the connection quietly when nobody listens for it', async t => {
  let conn = null;
  const url = await serve(t, c => { conn = c; });
  const ws = new WebSocket(url);
  await open(ws);
  const closed = new Promise(r => conn.on('close', r));
  const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  conn.socket.destroy(err);
  await closed;
  assert.equal(conn.readyState, 'closed');
  assert.equal(conn.error && conn.error.code, 'ECONNRESET');
  ws.close();
});

test('a socket error still reaches a listener that asked for it', async t => {
  let conn = null;
  const url = await serve(t, c => { conn = c; });
  const ws = new WebSocket(url);
  await open(ws);
  const seen = new Promise(r => conn.on('error', r));
  conn.socket.destroy(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  assert.equal((await seen).code, 'ETIMEDOUT');
  ws.close();
});
