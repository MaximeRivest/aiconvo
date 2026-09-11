'use strict';
// Durable observations, separate from the rebuildable activity index.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
class FileArchive {
  constructor(filename, { budget = 512 * 1024 * 1024 } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filename), 0o700);
    this.db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    this.budget = budget;
    this.error = null;
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS archive_blobs (sha TEXT PRIMARY KEY, content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_versions (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL, ts INTEGER NOT NULL,
        sha TEXT, state TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS archive_events (event TEXT PRIMARY KEY, path TEXT NOT NULL, before_id INTEGER, after_id INTEGER);
      CREATE INDEX IF NOT EXISTS archive_path ON archive_versions(path, id);
      CREATE INDEX IF NOT EXISTS archive_time ON archive_versions(path, ts, id);`);
  }
  observe(file, { text = null, state = 'present', actor = 'unknown', source = 'watch', ts = Date.now(), reason = '' } = {}) {
    file = path.resolve(file);
    if (!['present', 'deleted', 'unavailable'].includes(state)) throw new Error('Invalid archive state');
    if (state === 'present' && (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES || text.includes('\0'))) {
      state = 'unavailable'; reason = 'Binary, unreadable, or larger than 2 MiB'; text = null;
    }
    const sha = state === 'present' ? crypto.createHash('sha256').update(text).digest('hex') : null;
    const last = this.db.prepare('SELECT * FROM archive_versions WHERE path = ? ORDER BY id DESC LIMIT 1').get(file);
    if (last && last.sha === sha && last.state === state && last.reason === reason) return last;
    const packed = sha && !this.db.prepare('SELECT 1 FROM archive_blobs WHERE sha = ?').get(sha) ? gzipSync(text) : null;
    const bytes = this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size;
    if (bytes + (packed?.length || 0) + 8192 > this.budget) {
      this.error = 'File history storage limit reached. Existing versions are kept; new versions are not captured.';
      throw new Error(this.error);
    }
    // A backwards wall-clock adjustment must not put a new observation before
    // an older observation of the same file. IDs order equal timestamps.
    ts = Math.max(Math.trunc(ts), last?.ts || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (packed) this.db.prepare('INSERT OR IGNORE INTO archive_blobs VALUES (?, ?)').run(sha, packed);
      const out = this.db.prepare('INSERT INTO archive_versions(path, ts, sha, state, actor, source, reason) VALUES (?, ?, ?, ?, ?, ?, ?)').run(file, ts, sha, state, actor, source, reason);
      this.db.exec('COMMIT'); this.error = null;
      return { id: Number(out.lastInsertRowid), path: file, ts, sha, state, actor, source, reason };
    } catch (e) { this.db.exec('ROLLBACK'); this.error = e.message; throw e; }
  }
  versions(file, limit = 2000) {
    return this.db.prepare('SELECT * FROM archive_versions WHERE path = ? ORDER BY id DESC LIMIT ?').all(path.resolve(file), limit).reverse();
  }
  around(file, from, to) {
    file = path.resolve(file);
    const before = this.db.prepare("SELECT * FROM archive_versions WHERE path=? AND ts<? ORDER BY ts DESC,id DESC LIMIT 1").get(file, from);
    const during = this.db.prepare("SELECT * FROM archive_versions WHERE path=? AND ts>=? AND ts<=? ORDER BY ts DESC,id DESC LIMIT 2000").all(file, from, to).reverse();
    return before ? [before, ...during] : during;
  }
  version(file, id) {
    return this.db.prepare('SELECT * FROM archive_versions WHERE path = ? AND id = ?').get(path.resolve(file), id);
  }
  snapshot(file, id) {
    const row = this.db.prepare('SELECT v.*, b.content FROM archive_versions v LEFT JOIN archive_blobs b ON b.sha = v.sha WHERE v.path = ? AND v.id = ?').get(path.resolve(file), id);
    if (!row) throw new Error('Saved version not found for this file');
    if (row.state === 'unavailable') throw new Error(row.reason || 'Contents were not captured');
    return { content: row.state === 'deleted' ? '' : gunzipSync(row.content, { maxOutputLength: MAX_FILE_BYTES }).toString('utf8'), exact: true, method: row.state === 'deleted' ? 'observed deletion' : 'saved observation', state: row.state, sha: row.sha };
  }
  latestId(file) {
    return this.db.prepare('SELECT id FROM archive_versions WHERE path = ? ORDER BY id DESC LIMIT 1').get(path.resolve(file))?.id || null;
  }
  link(event, file, before, after) {
    this.db.prepare('INSERT OR REPLACE INTO archive_events VALUES (?, ?, ?, ?)').run(event, path.resolve(file), before || null, after || null);
  }
  reference(event, file) {
    const row = this.db.prepare('SELECT before_id, after_id FROM archive_events WHERE event = ? AND path = ?').get(event, path.resolve(file));
    return row ? { fromVersion: row.before_id ? 'saved:' + row.before_id : null, toVersion: row.after_id ? 'saved:' + row.after_id : null } : {};
  }
  close() { this.db.close(); }
}
module.exports = { FileArchive, MAX_FILE_BYTES };
