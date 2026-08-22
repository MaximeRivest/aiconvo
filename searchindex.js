'use strict';
// searchindex.js — FTS5-backed work-memory search (a derived cache).
//
// One row per searchable unit: a conversation title, one message, or one
// markdown section (note / epic / project memory). The database lives under
// ~/.cache/aiconvo and can be deleted at any time; the next boot rebuilds it
// from the session caches and the notes tree. Queries never scan the caches.
//
// Node 22 ships SQLite with FTS5 (node:sqlite). No new dependency.

const path = require('path');

// Bump when the unit layout or the ranking inputs change: the whole
// database drops and rebuilds on the next boot.
const SCHEMA_VERSION = 1;

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

// Snippet marker bytes. The client escapes the snippet, then turns these
// into <mark> … </mark>. They can never appear in real transcript text.
const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';

// Relevance: what a human wrote outranks what a tool printed.
const ROLE_WEIGHT = { user: 2.0, assistant: 1.5, thinking: 1.0, tool: 0.9, toolresult: 0.6 };
const KIND_WEIGHT = { title: 5.0, note: 3.0, epic: 3.0, memory: 3.0 };

// Cap one unit's indexed text. Pasted briefings can reach hundreds of KB;
// the head carries the meaning and the cap keeps the index bounded.
const UNIT_TEXT_CAP = 16000;

const FILTER_FIELDS = new Set(['project', 'role', 'source', 'type', 'kind', 'after', 'before', 'path']);

// Split a raw query into { terms, phrases, filters }.
// Grammar: bare words AND together; "quoted phrases" match exactly;
// field:value (project:, role:, source:, type:, after:, before:, path:) filter.
function parseQuery(raw) {
  const filters = {};
  const phrases = [];
  const terms = [];
  const trailing = !/\s$/.test(raw); // no trailing space → last term is still being typed
  let rest = String(raw);
  rest = rest.replace(/(\w+):("[^"]*"|\S+)/g, (m, field, value) => {
    field = field.toLowerCase();
    if (!FILTER_FIELDS.has(field)) return m; // not an operator: keep as text
    filters[field === 'kind' ? 'type' : field] = value.replace(/^"|"$/g, '');
    return ' ';
  });
  rest = rest.replace(/"([^"]*)"/g, (m, p) => {
    if (p.trim()) phrases.push(p.trim());
    return ' ';
  });
  for (const t of rest.split(/\s+/)) if (t) terms.push(t);
  return { terms, phrases, filters, prefixLast: trailing };
}

// Build the FTS5 MATCH expression. Every term and phrase must match (AND).
function matchExpr({ terms, phrases, prefixLast }) {
  const q = s => '"' + s.replace(/"/g, '""') + '"';
  const parts = phrases.map(q);
  terms.forEach((t, i) => {
    const last = i === terms.length - 1;
    parts.push(q(t) + (last && prefixLast && t.length >= 2 ? '*' : ''));
  });
  return parts.join(' ');
}

function tsFromMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

// Markdown kind from its path inside the notes tree.
function mdKind(relFile) {
  if (relFile.startsWith('epics' + path.sep) || relFile.startsWith('epics/')) return 'epic';
  if (relFile.startsWith('projects' + path.sep) || relFile.startsWith('projects/')) return 'memory';
  return 'note';
}

// Split a markdown document into heading-bounded sections.
// Returns [{ heading, text }]; the first section may have no heading.
function mdSections(text) {
  const lines = String(text).split('\n');
  const out = [];
  let cur = { heading: null, body: [] };
  for (const line of lines) {
    const m = line.match(/^#{1,4}\s+(.*)/);
    if (m) {
      if (cur.body.join('').trim() || cur.heading) out.push(cur);
      cur = { heading: m[1].trim(), body: [line] };
    } else cur.body.push(line);
  }
  if (cur.body.join('').trim() || cur.heading) out.push(cur);
  return out.map(s => ({ heading: s.heading, text: s.body.join('\n').trim() })).filter(s => s.text);
}

class SearchIndex {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS units_fts; DROP TABLE IF EXISTS units; DROP TABLE IF EXISTS srcs;');
      this.db.exec(`
        CREATE TABLE srcs (src TEXT PRIMARY KEY, sig TEXT NOT NULL);
        CREATE TABLE units (
          id INTEGER PRIMARY KEY,
          src TEXT NOT NULL,
          kind TEXT NOT NULL,      -- title | message | note | epic | memory
          key TEXT,                -- conversation key (conversation units)
          file TEXT,               -- notes-relative path (markdown units)
          idx INTEGER,             -- message index in the cached messages array
          role TEXT,
          ts TEXT,
          off INTEGER NOT NULL DEFAULT 0,
          project TEXT,
          source TEXT,
          path TEXT,               -- file path a tool call touched
          title TEXT,              -- document › section heading (markdown)
          text TEXT NOT NULL
        );
        CREATE INDEX units_src ON units(src);
        CREATE VIRTUAL TABLE units_fts USING fts5(text, content='units', content_rowid='id', tokenize='unicode61');
      `);
      this.db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    }
    // Semantic push ledger: which source signature the GPU stage has seen.
    // Separate from srcs so lexical and semantic sync advance independently.
    this.db.exec('CREATE TABLE IF NOT EXISTS semsync (src TEXT PRIMARY KEY, sig TEXT NOT NULL)');
    this._insUnit = this.db.prepare(
      `INSERT INTO units (src, kind, key, file, idx, role, ts, off, project, source, path, title, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this._insFts = this.db.prepare('INSERT INTO units_fts(rowid, text) VALUES (?, ?)');
    this._delFts = this.db.prepare("INSERT INTO units_fts(units_fts, rowid, text) VALUES ('delete', ?, ?)");
    this._sigOf = this.db.prepare('SELECT sig FROM srcs WHERE src = ?');
    this._putSig = this.db.prepare('INSERT INTO srcs (src, sig) VALUES (?, ?) ON CONFLICT(src) DO UPDATE SET sig = excluded.sig');
  }

  close() { try { this.db.close(); } catch {} }

  hasCurrent(src, sig) {
    const row = this._sigOf.get(src);
    return !!row && row.sig === sig;
  }

  _removeSrc(src) {
    const rows = this.db.prepare('SELECT id, text FROM units WHERE src = ?').all(src);
    for (const r of rows) this._delFts.run(r.id, r.text);
    this.db.prepare('DELETE FROM units WHERE src = ?').run(src);
  }

  _add(unit) {
    const text = String(unit.text || '').slice(0, UNIT_TEXT_CAP);
    if (!text.trim()) return;
    const info = this._insUnit.run(
      unit.src, unit.kind, unit.key || null, unit.file || null,
      unit.idx == null ? null : unit.idx, unit.role || null, unit.ts || null,
      unit.off ? 1 : 0, unit.project || null, unit.source || null,
      unit.path || null, unit.title || null, text);
    this._insFts.run(info.lastInsertRowid, text);
  }

  static conversationSig(entry) { return `${SCHEMA_VERSION}:${entry.mtimeMs}:${entry.size}`; }

  // Replace every unit of one conversation. entry needs: mtimeMs, size,
  // title, source, lastTs and a computed .project. Returns false when the
  // stored signature already matches (nothing to do).
  putConversation(key, entry, messages) {
    const src = 'conv:' + key;
    const sig = SearchIndex.conversationSig(entry);
    if (this.hasCurrent(src, sig)) return false;
    this.db.exec('BEGIN');
    try {
      this._removeSrc(src);
      const base = { src, key, project: entry.project || null, source: entry.source || null };
      this._add({ ...base, kind: 'title', ts: entry.lastTs || null, text: entry.title || '' });
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || !m.text) continue;
        this._add({ ...base, kind: 'message', idx: i, role: m.role, ts: m.ts || null, off: !!m.off, path: m.path || null, text: m.text });
      }
      this._putSig.run(src, sig);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return true;
  }

  removeConversation(key) { this.removeSrc('conv:' + key); }

  // Re-attribute one source's units after a project fold or unfold. The
  // project column is baked in at put time; this fixes it without a reindex.
  setProject(src, project) {
    return this.db.prepare(
      'UPDATE units SET project = ? WHERE src = ? AND project IS NOT ?')
      .run(project || null, src, project || null).changes;
  }

  removeSrc(src) {
    this.db.exec('BEGIN');
    try {
      this._removeSrc(src);
      this.db.prepare('DELETE FROM srcs WHERE src = ?').run(src);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // Replace every unit of one markdown document (note / epic / memory).
  putMarkdown(relFile, text, stat) {
    const src = 'md:' + relFile;
    const sig = `${SCHEMA_VERSION}:${stat.mtimeMs}:${stat.size}`;
    if (this.hasCurrent(src, sig)) return false;
    const kind = mdKind(relFile);
    const docTitle = (String(text).match(/^#\s+(.*)$/m) || [])[1] || path.basename(relFile, '.md');
    this.db.exec('BEGIN');
    try {
      this._removeSrc(src);
      const ts = tsFromMs(stat.mtimeMs);
      for (const sec of mdSections(text)) {
        const title = sec.heading && sec.heading !== docTitle ? docTitle + ' › ' + sec.heading : docTitle;
        this._add({ src, kind, file: relFile, ts, title, text: sec.text });
      }
      this._putSig.run(src, sig);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return true;
  }

  // All stored source signatures with a prefix ('conv:' or 'md:').
  listSrcs(prefix) {
    const out = new Map();
    for (const r of this.db.prepare("SELECT src, sig FROM srcs WHERE src LIKE ? || '%'").all(prefix)) {
      out.set(r.src.slice(prefix.length), r.sig);
    }
    return out;
  }

  stats() {
    return {
      units: this.db.prepare('SELECT count(*) AS n FROM units').get().n,
      sources: this.db.prepare('SELECT count(*) AS n FROM srcs').get().n,
    };
  }

  // ---- semantic stage support ----
  // Semantic unit ids: '<src>|t' (title), '<src>|m<idx>' (message),
  // '<src>|s<ordinal>' (markdown section). '<src>|' removes a whole source.

  // Units of one source, shaped for the GPU stage. Human text only by
  // default: tool output brings noise per embedding dollar.
  listUnits(src, opts = {}) {
    const roles = opts.roles || ['user', 'assistant'];
    const out = [];
    let ord = 0;
    for (const r of this.db.prepare('SELECT * FROM units WHERE src = ? ORDER BY id').all(src)) {
      const sid = r.kind === 'title' ? src + '|t'
        : r.kind === 'message' ? src + '|m' + r.idx
        : src + '|s' + (ord++);
      if (r.kind === 'message' && !roles.includes(r.role)) continue;
      out.push({
        id: sid,
        text: r.text,
        meta: {
          kind: r.kind, key: r.key || undefined, file: r.file || undefined,
          idx: r.idx == null ? undefined : r.idx, role: r.role || undefined,
          ts: r.ts || undefined, off: r.off ? true : undefined,
          project: r.project || undefined, source: r.source || undefined,
          title: r.title || undefined, snip: r.text.slice(0, 240),
        },
      });
    }
    return out;
  }

  // What the GPU stage still needs: sources to push and sources to drop.
  semanticPending(limit = 200) {
    const push = this.db.prepare(
      `SELECT s.src, s.sig FROM srcs s LEFT JOIN semsync m ON m.src = s.src
       WHERE m.sig IS NULL OR m.sig != s.sig LIMIT ?`).all(limit);
    const drop = this.db.prepare(
      `SELECT m.src FROM semsync m LEFT JOIN srcs s ON s.src = m.src
       WHERE s.src IS NULL LIMIT ?`).all(limit).map(r => r.src);
    return { push, drop };
  }

  semanticMark(src, sig) {
    this.db.prepare('INSERT INTO semsync (src, sig) VALUES (?, ?) ON CONFLICT(src) DO UPDATE SET sig = excluded.sig').run(src, sig);
  }

  semanticDrop(src) { this.db.prepare('DELETE FROM semsync WHERE src = ?').run(src); }

  semanticStats() {
    return {
      synced: this.db.prepare('SELECT count(*) AS n FROM semsync').get().n,
      total: this.db.prepare('SELECT count(*) AS n FROM srcs').get().n,
    };
  }

  // Ranked, grouped search.
  // opts: { limit (groups), offset (groups), boostProject }
  // Returns { total, groups: [{ kind, key|file, title, project, source,
  //   score, matchCount, matches: [{ i, role, ts, off, snippet, title }] }] }
  search(rawQ, opts = {}) {
    const parsed = parseQuery(rawQ);
    const expr = matchExpr(parsed);
    if (!expr) return { total: 0, groups: [] };
    const f = parsed.filters;
    const where = ['units_fts MATCH ?'];
    const args = [expr];
    if (f.project) { where.push('u.project = ?'); args.push(f.project); }
    if (f.role) { where.push('u.role = ?'); args.push(f.role); }
    if (f.source) { where.push('u.source = ?'); args.push(f.source); }
    if (f.type) {
      if (f.type === 'conversation') where.push("u.kind IN ('title','message')");
      else { where.push('u.kind = ?'); args.push(f.type); }
    }
    if (f.after) { where.push('u.ts >= ?'); args.push(f.after); }
    if (f.before) { where.push('u.ts <= ?'); args.push(f.before); }
    if (f.path) { where.push("u.path LIKE '%' || ? || '%'"); args.push(f.path); }
    const cond = where.join(' AND ');
    let rows, total;
    try {
      total = this.db.prepare(
        `SELECT count(*) AS n FROM units_fts JOIN units u ON u.id = units_fts.rowid WHERE ${cond}`).get(...args).n;
      rows = this.db.prepare(
        `SELECT u.id, u.kind, u.key, u.file, u.idx, u.role, u.ts, u.off, u.project, u.source, u.title,
                bm25(units_fts) AS b,
                snippet(units_fts, 0, char(1), char(2), ' … ', 18) AS snip
         FROM units_fts JOIN units u ON u.id = units_fts.rowid
         WHERE ${cond} ORDER BY rank LIMIT 2000`).all(...args);
    } catch (e) {
      // An unfinished quote or operator misuse must not 500 the API.
      if (/fts5|syntax/i.test(e.message)) return { total: 0, groups: [], error: 'bad query' };
      throw e;
    }
    const now = Date.now();
    const groups = new Map();
    for (const r of rows) {
      const weight = r.kind === 'message' ? (ROLE_WEIGHT[r.role] || 1) : (KIND_WEIGHT[r.kind] || 1);
      let score = -r.b * weight;
      const age = r.ts ? Math.max(0, (now - Date.parse(r.ts)) / 86400000) : 365;
      score *= 1 + 0.25 * Math.exp(-age / 14);              // fresh work matters a bit more
      if (opts.boostProject && r.project === opts.boostProject) score *= 1.2;
      if (r.off) score *= 0.9;                               // off the active branch path
      const gid = r.key ? 'c:' + r.key : 'f:' + r.file;
      let g = groups.get(gid);
      if (!g) {
        g = {
          kind: r.key ? 'conversation' : r.kind,
          key: r.key || undefined, file: r.file || undefined,
          title: r.title || null, project: r.project || null, source: r.source || null,
          score: 0, matchCount: 0, matches: [],
        };
        groups.set(gid, g);
      }
      g.matchCount++;
      g.score = Math.max(g.score, score);
      if (g.matches.length < 3) {
        g.matches.push({
          i: r.idx == null ? undefined : r.idx,
          role: r.kind === 'title' ? 'title' : (r.role || r.kind),
          ts: r.ts || null, off: !!r.off, title: r.title || undefined,
          snippet: r.snip,
        });
      }
      if (!g.title && r.title) g.title = r.title;
    }
    const list = [...groups.values()];
    for (const g of list) g.score += 0.05 * Math.log(1 + g.matchCount); // breadth helps a little
    list.sort((a, b) => b.score - a.score);
    const kindCounts = {};
    for (const g of list) kindCounts[g.kind] = (kindCounts[g.kind] || 0) + 1;
    const offset = Math.max(0, opts.offset || 0);
    const limit = Math.max(1, Math.min(100, opts.limit || 40));
    return { total, groupCount: list.length, kindCounts, groups: list.slice(offset, offset + limit) };
  }
}

function openSearchIndex(dbPath) {
  if (!DatabaseSync) return null;
  try {
    return new SearchIndex(dbPath);
  } catch (e) {
    console.error('search index unavailable:', e.message);
    return null;
  }
}

module.exports = { openSearchIndex, SearchIndex, parseQuery, matchExpr, mdSections, mdKind, MARK_OPEN, MARK_CLOSE };
