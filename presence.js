'use strict';
// Presence: who is on this install right now, and where. One entry per
// live browser connection (the /api/events stream names it); it goes when
// the stream closes. The book is a value the server broadcasts whole: a
// household or a team of thirty is a few dozen rows, and a whole snapshot
// cannot drift the way diffs can.
const KINDS = new Set(['viewing', 'typing', 'editing']);

function cleanRoute(raw) {
  const s = String(raw || '').trim().slice(0, 600);
  return s || 'home';
}

class PresenceBook {
  constructor({ staleMs = 90000 } = {}) {
    this.rows = new Map(); // conn → { conn, user, route, kind, position, at }
    this.staleMs = staleMs;
  }
  // A connection said where it is. `user` is the public user record.
  set(conn, { user, route, kind, position }, now = Date.now()) {
    if (!conn || !user) return null;
    const row = {
      conn, user: { id: user.id, name: user.name, glyph: user.glyph, color: user.color },
      route: cleanRoute(route), kind: KINDS.has(kind) ? kind : 'viewing',
      position: position && typeof position === 'object' ? { line: Number(position.line) || undefined, entry: position.entry ? String(position.entry).slice(0, 80) : undefined, from: Number.isFinite(position.from) ? position.from : undefined, to: Number.isFinite(position.to) ? position.to : undefined } : null,
      at: now,
    };
    const prev = this.rows.get(conn);
    this.rows.set(conn, row);
    return !prev || prev.route !== row.route || prev.kind !== row.kind || JSON.stringify(prev.position) !== JSON.stringify(row.position) || prev.user.id !== row.user.id;
  }
  remove(conn) { return this.rows.delete(conn); }
  // Connections that stopped talking without closing (a sleeping phone).
  expire(now = Date.now()) {
    let dropped = 0;
    for (const [conn, row] of this.rows) if (now - row.at > this.staleMs) { this.rows.delete(conn); dropped++; }
    return dropped;
  }
  snapshot() {
    return [...this.rows.values()].map(r => ({ conn: r.conn, user: r.user, route: r.route, kind: r.kind, position: r.position, at: r.at }));
  }
  // Who is at a route, other than one connection (usually the asker's).
  at(route, exceptConn = null) {
    const r = cleanRoute(route);
    return this.snapshot().filter(x => x.route === r && x.conn !== exceptConn);
  }
}

module.exports = { PresenceBook, KINDS };
