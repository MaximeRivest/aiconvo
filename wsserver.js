'use strict';
// A small WebSocket server (RFC 6455) for one purpose: the collaboration
// endpoint. Server side only, no extensions, no compression; clients must
// mask (the standard requires it), fragments are reassembled, control
// frames (ping, pong, close) are answered. Aiconvo has no npm dependencies
// and the speech relay only pipes bytes; this is the first place frames
// are read. Tests drive it with Node's built-in WebSocket client.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

function frame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

class WsConn extends EventEmitter {
  constructor(socket, { maxPayload = 16 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts, size }
    this.closed = false;
    this.closeSent = false;
    socket.on('data', chunk => this._feed(chunk));
    socket.on('close', () => this._finish());
    // A peer that vanishes (ECONNRESET, ETIMEDOUT, EPIPE: a laptop asleep,
    // a port forward re-applied, a phone changing networks) is the normal
    // end of a WebSocket, not a fault in this process. Node throws on an
    // 'error' event nobody listens to, and that took the whole server down
    // with every agent run in it. Emit only for listeners; always close.
    socket.on('error', e => {
      this.error = e;
      if (this.listenerCount('error')) this.emit('error', e);
      this._finish();
    });
    socket.on('end', () => this._finish());
  }
  get readyState() { return this.closed ? 'closed' : 'open'; }
  send(data) {
    if (this.closed || this.closeSent) return false;
    const binary = !(typeof data === 'string');
    const payload = binary ? Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data) : Buffer.from(data, 'utf8');
    return this.socket.write(frame(binary ? OP.BINARY : OP.TEXT, payload));
  }
  ping(payload = Buffer.alloc(0)) { if (!this.closed && !this.closeSent) this.socket.write(frame(OP.PING, payload)); }
  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this.socket.write(frame(OP.CLOSE, p)); } catch {}
    // The peer answers with its own close frame; if it does not, end anyway.
    const t = setTimeout(() => { try { this.socket.destroy(); } catch {} }, 2000);
    if (t.unref) t.unref();
  }
  _fail(code, why) {
    this.close(code, why);
    try { this.socket.destroy(); } catch {}
    this._finish();
  }
  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv) return this._fail(1002, 'reserved bits set');
      if (!masked) return this._fail(1002, 'client frames must be masked');
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this._fail(1009, 'frame too large');
        len = Number(big); off = 10;
      }
      if (len > this.maxPayload) return this._fail(1009, 'frame too large');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (opcode >= 8) {
        if (!fin || len > 125) return this._fail(1002, 'bad control frame');
        if (opcode === OP.CLOSE) {
          const code = len >= 2 ? payload.readUInt16BE(0) : 1005;
          if (!this.closeSent) { this.closeSent = true; try { this.socket.write(frame(OP.CLOSE, payload.subarray(0, Math.min(len, 2)))); } catch {} }
          try { this.socket.end(); } catch {}
          this.emit('closing', code);
          return this._finish();
        }
        if (opcode === OP.PING) { if (!this.closeSent) this.socket.write(frame(OP.PONG, payload)); continue; }
        if (opcode === OP.PONG) { this.emit('pong', payload); continue; }
        return this._fail(1002, 'unknown control opcode');
      }
      if (opcode === OP.CONT) {
        if (!this.fragments) return this._fail(1002, 'continuation without a start');
        this.fragments.parts.push(payload); this.fragments.size += len;
        if (this.fragments.size > this.maxPayload) return this._fail(1009, 'message too large');
        if (fin) { const m = this.fragments; this.fragments = null; this._deliver(m.opcode, Buffer.concat(m.parts)); }
        continue;
      }
      if (opcode !== OP.TEXT && opcode !== OP.BINARY) return this._fail(1002, 'unknown opcode');
      if (this.fragments) return this._fail(1002, 'new message inside a fragmented one');
      if (fin) this._deliver(opcode, payload);
      else this.fragments = { opcode, parts: [payload], size: len };
    }
  }
  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); } catch { return this._fail(1007, 'invalid utf-8'); }
      this.emit('message', text, false);
    } else this.emit('message', payload, true);
  }
}

// Complete the upgrade and hand back the connection. Returns null (and
// answers the socket) when the request is not a proper WebSocket upgrade.
function acceptWebSocket(req, socket, head, opts = {}) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!/websocket/i.test(String(req.headers.upgrade || '')) || !key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + acceptKey(key)];
  const protocol = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
  if (protocol && opts.protocol !== false) lines.push('Sec-WebSocket-Protocol: ' + protocol);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = new WsConn(socket, opts);
  if (head && head.length) conn._feed(head);
  return conn;
}

function refuseUpgrade(socket, status = 401, text = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

module.exports = { acceptWebSocket, refuseUpgrade, acceptKey, frame, WsConn, OP };
