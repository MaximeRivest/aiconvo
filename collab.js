'use strict';
// Shared documents: the compose box of a conversation, a draft, a file
// under edit. Each is one Yjs document held here, the authoritative copy;
// browsers join over a WebSocket speaking the y-websocket wire protocol
// (sync + awareness), which the stock client provider understands.
//
// What is and is not shared:
//   compose:<conversation key>  the text people type before it is sent
//   draft:<draft id>            a new conversation's compose box
//   file:<absolute path>        a file open in the live editor
// Never the transcript: that is Pi's append-only log with one writer.
//
// Persistence: compose and draft documents are saved as Yjs updates under
// the cache dir so a restart keeps what was typed. Files are not: the
// disk is their truth; the host writes the text to disk through its own
// save path (history, ledger) and pushes disk changes back as minimal
// edits so remote cursors survive an agent's write.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_AUTH = 2, MSG_QUERY_AWARENESS = 3;
const TEXT_KEY = 'content';

// The smallest edit that turns `from` into `to`: common prefix, common
// suffix, one replace. Enough for an agent's write or a disk reload; Yjs
// merges it with what people are typing at the same time.
function textDiff(from, to) {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length, endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) { endFrom--; endTo--; }
  return { index: start, remove: endFrom - start, insert: to.slice(start, endTo) };
}

function createCollab({ Y, syncProtocol, awarenessProtocol, encoding, decoding, persistDir = null, log = () => {} }) {
  const docs = new Map(); // name → Doc
  const events = new EventEmitter();
  const kindOf = name => String(name).split(':')[0];
  const persistable = name => ['compose', 'draft'].includes(kindOf(name));
  const persistFile = name => persistDir ? path.join(persistDir, crypto.createHash('sha256').update(name).digest('hex').slice(0, 24) + '.yjs') : null;

  function load(name) {
    const file = persistFile(name);
    if (!file || !persistable(name)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }
  function scheduleSave(d) {
    if (!persistable(d.name) || !persistDir) return;
    clearTimeout(d.saveTimer);
    d.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(persistDir, { recursive: true });
        const text = d.ydoc.getText(TEXT_KEY).toString();
        const file = persistFile(d.name);
        if (!text) { try { fs.unlinkSync(file); } catch {} return; }
        fs.writeFileSync(file, Buffer.from(Y.encodeStateAsUpdate(d.ydoc)));
      } catch (e) { log('[collab] save ' + d.name + ': ' + e.message); }
    }, 500);
    if (d.saveTimer.unref) d.saveTimer.unref();
  }

  function send(conn, bytes) {
    try { if (conn.readyState === 'open') conn.send(bytes); } catch {}
  }
  function broadcast(d, bytes, except = null) {
    for (const c of d.conns.keys()) if (c !== except) send(c, bytes);
  }

  function open(name, { initialText = '' } = {}) {
    let d = docs.get(name);
    if (d) return d;
    const ydoc = new Y.Doc({ gc: true });
    const awareness = new awarenessProtocol.Awareness(ydoc);
    awareness.setLocalState(null);
    d = { name, ydoc, awareness, conns: new Map(), contributors: new Map(), saveTimer: null, quietTimer: null, version: 0, applyingHost: false };
    docs.set(name, d);
    const stored = load(name);
    if (stored) { try { Y.applyUpdate(ydoc, new Uint8Array(stored)); } catch (e) { log('[collab] stored update for ' + name + ' unreadable: ' + e.message); } }
    else if (initialText) ydoc.getText(TEXT_KEY).insert(0, initialText);
    ydoc.on('update', (update, origin) => {
      d.version++;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      broadcast(d, encoding.toUint8Array(enc));
      scheduleSave(d);
      if (origin !== 'host') {
        clearTimeout(d.quietTimer);
        d.quietTimer = setTimeout(() => events.emit('change', { name, text: ydoc.getText(TEXT_KEY).toString(), version: d.version, contributors: contributorsOf(d) }), 400);
      }
    });
    // Who typed what: counted from the text deltas, per transaction origin
    // (the connection that sent the update, which knows its person).
    ydoc.getText(TEXT_KEY).observe((event, tx) => {
      const who = d.conns.get(tx.origin);
      if (!who) return;
      let chars = 0;
      for (const op of event.changes.delta) if (typeof op.insert === 'string') chars += op.insert.length;
      if (chars) d.contributors.set(who.user.id, { user: who.user, chars: (d.contributors.get(who.user.id)?.chars || 0) + chars, at: Date.now() });
    });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      // Which client ids a connection speaks for, to clear them when it closes.
      const member = d.conns.get(origin);
      if (member) { for (const id of added) member.controlled.add(id); for (const id of removed) member.controlled.delete(id); }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      broadcast(d, encoding.toUint8Array(enc));
      events.emit('awareness', { name, people: peopleOf(d) });
    });
    return d;
  }

  const contributorsOf = d => [...d.contributors.values()].map(c => ({ id: c.user.id, name: c.user.name, glyph: c.user.glyph, color: c.user.color, chars: c.chars, at: c.at }));
  const peopleOf = d => {
    const out = [];
    for (const [, st] of d.awareness.getStates()) if (st && st.user) out.push({ id: st.user.id, name: st.user.name, glyph: st.user.glyph, color: st.user.color, cursor: st.cursor ? true : false });
    return out;
  };

  // One browser joins a document. `user` is its public user record;
  // `canWrite` false makes it a spectator: its updates are dropped, its
  // cursor still shows.
  function join(conn, name, { user, canWrite = true, initialText = '' }) {
    const d = open(name, { initialText });
    const member = { user, canWrite, controlled: new Set() };
    d.conns.set(conn, member);
    conn.on('message', (data, binary) => {
      if (!binary) return;
      try { handle(d, conn, member, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); }
      catch (e) { log('[collab] bad message on ' + name + ': ' + e.message); }
    });
    conn.on('close', () => leave(conn, d));
    // Step 1 of sync, then everyone's awareness so cursors show at once.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, d.ydoc);
    send(conn, encoding.toUint8Array(enc));
    const states = d.awareness.getStates();
    if (states.size) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(d.awareness, [...states.keys()]));
      send(conn, encoding.toUint8Array(aw));
    }
    events.emit('join', { name, user, people: peopleOf(d) });
    return d;
  }

  function handle(d, conn, member, bytes) {
    const dec = decoding.createDecoder(bytes);
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      encoding.writeVarUint(enc, MSG_SYNC);
      const sub = decoding.peekVarUint(dec);
      if (!member.canWrite && sub !== syncProtocol.messageYjsSyncStep1) return; // a spectator only asks
      syncProtocol.readSyncMessage(dec, enc, d.ydoc, conn);
      if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(d.awareness, decoding.readVarUint8Array(dec), conn);
    } else if (type === MSG_QUERY_AWARENESS) {
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(d.awareness, [...d.awareness.getStates().keys()]));
      send(conn, encoding.toUint8Array(enc));
    } else if (type === MSG_AUTH) {
      // Not used: the HTTP upgrade already identified the person.
    }
  }

  function leave(conn, d) {
    const member = d.conns.get(conn);
    if (!member) return;
    d.conns.delete(conn);
    if (member.controlled.size) awarenessProtocol.removeAwarenessStates(d.awareness, [...member.controlled], null);
    events.emit('leave', { name: d.name, user: member.user, people: peopleOf(d) });
    // Files are dropped when nobody looks at them: the disk is their truth.
    if (!d.conns.size && !persistable(d.name)) close(d.name);
  }

  function text(name) { const d = docs.get(name); return d ? d.ydoc.getText(TEXT_KEY).toString() : null; }
  // The host changes the text (send clears a compose box; an agent wrote the
  // file): one minimal edit, so other people's cursors stay where they were.
  function setText(name, next, { initialText = '' } = {}) {
    const d = open(name, { initialText });
    const yt = d.ydoc.getText(TEXT_KEY);
    const diff = textDiff(yt.toString(), String(next ?? ''));
    if (!diff) return false;
    d.ydoc.transact(() => { if (diff.remove) yt.delete(diff.index, diff.remove); if (diff.insert) yt.insert(diff.index, diff.insert); }, 'host');
    return true;
  }
  function clear(name) {
    const d = docs.get(name);
    if (!d) return { text: '', contributors: [] };
    const out = { text: d.ydoc.getText(TEXT_KEY).toString(), contributors: contributorsOf(d) };
    setText(name, '');
    d.contributors.clear();
    return out;
  }
  function close(name) {
    const d = docs.get(name);
    if (!d) return;
    clearTimeout(d.saveTimer); clearTimeout(d.quietTimer);
    for (const c of d.conns.keys()) { try { c.close(1001, 'document closed'); } catch {} }
    d.awareness.destroy();
    d.ydoc.destroy();
    docs.delete(name);
  }
  function people(name) { const d = docs.get(name); return d ? peopleOf(d) : []; }
  function contributors(name) { const d = docs.get(name); return d ? contributorsOf(d) : []; }
  function stats() { return { docs: [...docs.values()].map(d => ({ name: d.name, people: d.conns.size, chars: d.ydoc.getText(TEXT_KEY).length })) }; }
  function has(name) { return docs.has(name); }
  function closeAll() { for (const name of [...docs.keys()]) close(name); }

  return { open, join, text, setText, clear, close, closeAll, people, contributors, stats, has, on: events.on.bind(events), off: events.off.bind(events), textDiff, TEXT_KEY };
}

module.exports = { createCollab, textDiff };
