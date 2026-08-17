#!/usr/bin/env node
// aiconvo — browse, search and export Claude Code conversations.
// No dependencies. Run: node server.js  → http://localhost:7433
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const os = require('os');
const readline = require('readline');
const net = require('net');
const { execFile, spawn } = require('child_process');
const { claudeForkContent } = require('./sessionfork.js');

// Conversation sources. Keys in the index look like "claude:<relPath>".
const SOURCES = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  pi: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  'pi-remote': path.join(os.homedir(), '.pi', 'remote', 'sessions'),
};
const CACHE_DIR = path.join(os.homedir(), '.cache', 'aiconvo');
const SESS_DIR = path.join(CACHE_DIR, 'sessions');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const PORT = process.env.PORT ? Number(process.env.PORT) : 7433;

fs.mkdirSync(SESS_DIR, { recursive: true });

// index: { [relPath]: { mtimeMs, size, sessionId, cwd, gitBranch, title,
//                       firstTs, lastTs, userCount, assistantCount } }
let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { index = {}; }

function saveIndexSoon() {
  clearTimeout(saveIndexSoon.t);
  saveIndexSoon.t = setTimeout(() => {
    fs.writeFile(INDEX_FILE, JSON.stringify(index), () => {});
  }, 500);
}

function cachePathFor(key) {
  return path.join(SESS_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
}

// Bump when the cached message format changes; forces a re-index.
const CACHE_VERSION = 5;

// Make a compact label for the vertical timeline. This never exceeds 10 characters.
function timelineTitle(text) {
  let s = String(text || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+|@[\w./~-]+|`[^`]+`/g, ' ')
    .replace(/[#*_>|{}[\]()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  s = s.replace(/^(please\s+|can (you|we)\s+|could (you|we)\s+|i (need|want|would like) (you )?to\s+|help me\s+)/i, '');
  const stop = s.search(/[.!?;:\n]/);
  if (stop > 4) s = s.slice(0, stop);
  if (s.length <= 10) return s || 'Untitled';
  const words = s.split(' ');
  let out = '';
  for (const word of words) {
    const next = out ? out + ' ' + word : word;
    if (next.length > 10) break;
    out = next;
  }
  return (out || s.slice(0, 10)).slice(0, 10);
}

// Fixed bins keep the session list small while preserving a violin-like message density.
function densityProfile(messages, firstTs, lastTs, includeTools) {
  const bins = Array(24).fill(0);
  const first = Date.parse(firstTs), last = Date.parse(lastTs);
  const span = Math.max(1, last - first);
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && !(includeTools && m.role === 'tool')) continue;
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t)) continue;
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((t - first) / span * bins.length)));
    bins[i]++;
  }
  return bins;
}

// Pull plain text out of a message.content (string or block array).
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

// One-line-ish summary of a tool call's input.
function toolInputText(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;         // Bash
  if (typeof input.file_path === 'string' && !input.content && !input.old_string) return input.file_path; // Read
  if (typeof input.path === 'string' && Object.keys(input).length === 1) return input.path; // pi read
  let s = '';
  try { s = JSON.stringify(input); } catch { return ''; }
  return s.length > 2000 ? s.slice(0, 2000) + ' …' : s;
}

// Tool calls / results out of a content block array. kinds: tool, toolresult.
function toolEventsOf(content, ts) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool_use' || b.type === 'toolCall') {
      const input = b.input || b.arguments || {};
      const p = input.file_path || input.notebook_path || input.path || null;
      out.push({ role: 'tool', name: b.name || '?', text: toolInputText(b.name, input),
                 path: typeof p === 'string' ? p : null, id: b.id || null, ts });
    } else if (b.type === 'tool_result') {
      let t = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
      if (t.length > 4000) t = t.slice(0, 4000) + '\n… (truncated)';
      if (t.trim()) out.push({ role: 'toolresult', text: t, tid: b.tool_use_id || null, ts });
    }
  }
  return out;
}

function isNoise(text) {
  const t = text.trimStart();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<local-command-stderr>') ||
    t.startsWith('Caveat: The messages below')
  );
}

async function parseFile(absPath) {
  const messages = [];
  let meta = { sessionId: null, cwd: null, gitBranch: null, firstTs: null, lastTs: null, rootId: null, parentSession: null };
  // Branch awareness: both formats store a real entry tree (pi: id/parentId,
  // Claude: uuid/parentUuid). The ACTIVE path is the chain from the LAST
  // entry in the file to the root — exactly where a resume continues (that
  // is also why the branch anchor works). Messages off that path belong to
  // other branches (branching is a deliberate strategy, not abandonment);
  // they get off:true so the transcript can fold them.
  const parents = new Map();
  let leafId = null;
  const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    // The first entry id is shared by every fork of this conversation
    // (forks copy the root chain verbatim), so it identifies the family.
    if (!meta.rootId && d.type !== 'session' && !d.isSidechain) {
      const rid = d.id || d.uuid;
      if (typeof rid === 'string') meta.rootId = rid;
    }
    // Every entry (messages, labels, mode switches, …) joins the tree; the
    // last one is the leaf a resume would continue from.
    const eid = d.type === 'session' ? null : (typeof (d.id || d.uuid) === 'string' ? (d.id || d.uuid) : null);
    if (eid && !d.isSidechain) {
      parents.set(eid, d.parentId !== undefined ? d.parentId : (d.parentUuid !== undefined ? d.parentUuid : null));
      leafId = eid;
    }
    let role, content;
    if (d.type === 'user' || d.type === 'assistant') {
      // Claude Code format
      if (d.isMeta || d.isSidechain) continue;
      role = d.type;
      content = d.message && d.message.content;
      if (!meta.sessionId && d.sessionId) meta.sessionId = d.sessionId;
      if (!meta.gitBranch && d.gitBranch) meta.gitBranch = d.gitBranch;
      if (!meta.cwd && d.cwd) meta.cwd = d.cwd;
    } else if (d.type === 'session') {
      // pi header line
      if (!meta.sessionId && d.id) meta.sessionId = d.id;
      if (!meta.cwd && d.cwd) meta.cwd = d.cwd;
      if (d.parentSession) meta.parentSession = d.parentSession; // pi fork origin
      continue;
    } else if (d.type === 'message' && d.message) {
      // pi message line
      role = d.message.role;
      content = d.message.content;
      if (role === 'toolResult') {
        // pi tool result message
        let t = textOf(content);
        if (t.length > 4000) t = t.slice(0, 4000) + '\n… (truncated)';
        if (t.trim()) messages.push({ role: 'toolresult', text: t, tid: d.message.toolCallId || d.message.toolCallID || null, ts: d.timestamp || null, _eid: eid });
        continue;
      }
      if (role !== 'user' && role !== 'assistant') continue;
    } else continue;
    if (d.timestamp) {
      if (!meta.firstTs) meta.firstTs = d.timestamp;
      meta.lastTs = d.timestamp;
    }
    const text = textOf(content);
    if (text.trim() && !(role === 'user' && isNoise(text))) {
      messages.push({ role, text, ts: d.timestamp || null, _eid: eid });
    }
    // Tool calls (assistant) and tool results (claude wraps them in user turns).
    messages.push(...toolEventsOf(content, d.timestamp || null).map(m => ({ ...m, _eid: eid })));
  }
  // Mark messages that are NOT on the active path. The flag is additive:
  // search, copy, and export keep the complete file-order record.
  const active = new Set();
  for (let cur = leafId; cur != null && parents.has(cur) && !active.has(cur);) {
    active.add(cur);
    cur = parents.get(cur);
  }
  for (const m of messages) {
    if (m._eid && !active.has(m._eid)) m.off = true;
    delete m._eid;
  }
  return { meta, messages };
}

// Live update push: browsers subscribe on /api/events.
const sseClients = new Set();
function broadcast(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of sseClients) res.write(line);
}

async function indexFile(source, relPath, stat) {
  const key = source + ':' + relPath;
  const absPath = path.join(SOURCES[source], relPath);
  try {
    const { meta, messages } = await parseFile(absPath);
    const firstUser = messages.find(m => m.role === 'user');
    const fullTitle = firstUser ? firstUser.text.slice(0, 200).replace(/\s+/g, ' ').trim() : '(no user message)';
    const titleHash = crypto.createHash('sha256').update('v2\x00' + fullTitle).digest('hex').slice(0, 16);
    const savedTimelineTitle = timelineTitles[key];
    const entry = {
      v: CACHE_VERSION,
      notePath: (index[key] && index[key].notePath) || null,
      notedAt: (index[key] && index[key].notedAt) || null,
      source,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId: meta.sessionId,
      rootId: meta.rootId,
      parentSession: meta.parentSession,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      title: fullTitle,
      timelineTitle: savedTimelineTitle && savedTimelineTitle.hash === titleHash
        ? savedTimelineTitle.title : timelineTitle(fullTitle),
      timelineTitleHash: titleHash,
      firstTs: meta.firstTs,
      lastTs: meta.lastTs,
      userCount: messages.filter(m => m.role === 'user').length,
      assistantCount: messages.filter(m => m.role === 'assistant').length,
      densityChat: densityProfile(messages, meta.firstTs, meta.lastTs, false),
      densityAll: densityProfile(messages, meta.firstTs, meta.lastTs, true),
    };
    index[key] = entry;
    await fsp.writeFile(cachePathFor(key), JSON.stringify({ key, relPath, ...entry, messages }));
    saveIndexSoon();
    broadcast({ type: 'update', key, ...entry });
    scheduleTimelineTitles();
  } catch (e) {
    console.error('index error', key, e.message);
  }
}

// Skip subagent/sidechain transcript files.
function isMainTranscript(relPath) {
  return relPath.endsWith('.jsonl') && !relPath.includes('subagents');
}

async function* walk(dir, base) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs, base);
    else if (e.isFile()) yield path.relative(base, abs);
  }
}

async function fullScan() {
  const seen = new Set();
  let n = 0;
  for (const [source, baseDir] of Object.entries(SOURCES)) {
    for await (const relPath of walk(baseDir, baseDir)) {
      if (!isMainTranscript(relPath)) continue;
      const key = source + ':' + relPath;
      seen.add(key);
      let stat;
      try { stat = await fsp.stat(path.join(baseDir, relPath)); } catch { continue; }
      const cur = index[key];
      if (!cur || cur.v !== CACHE_VERSION || cur.mtimeMs !== stat.mtimeMs || cur.size !== stat.size) {
        await indexFile(source, relPath, stat);
        n++;
      }
    }
  }
  for (const key of Object.keys(index)) {
    if (!seen.has(key)) {
      delete index[key];
      fsp.unlink(cachePathFor(key)).catch(() => {});
      saveIndexSoon();
    }
  }
  console.log(`scan done: ${Object.keys(index).length} conversations, ${n} (re)indexed`);
  scheduleTimelineTitles();
}

// Watcher: re-index a file shortly after it changes.
const pending = new Map();
function watch() {
  for (const [source, baseDir] of Object.entries(SOURCES)) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      fs.watch(baseDir, { recursive: true }, (event, filename) => {
        if (!filename || !isMainTranscript(filename)) return;
        const key = source + ':' + filename;
        clearTimeout(pending.get(key));
        pending.set(key, setTimeout(async () => {
          pending.delete(key);
          try {
            const stat = await fsp.stat(path.join(baseDir, filename));
            await indexFile(source, filename, stat);
          } catch {
            delete index[key];
            fsp.unlink(cachePathFor(key)).catch(() => {});
            saveIndexSoon();
          }
        }, 1500));
      });
      console.log('watching', baseDir);
    } catch (e) {
      console.error('watch failed:', baseDir, e.message);
    }
  }
}

// ---------- search ----------
async function search(q, limit = 300) {
  const needle = q.toLowerCase();
  const hits = [];
  for (const key of Object.keys(index)) {
    let data;
    try { data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); } catch { continue; }
    const matches = [];
    for (let i = 0; i < data.messages.length; i++) {
      const m = data.messages[i];
      const pos = m.text.toLowerCase().indexOf(needle);
      if (pos >= 0) {
        const start = Math.max(0, pos - 80);
        matches.push({
          i, role: m.role, ts: m.ts,
          snippet: m.text.slice(start, pos + needle.length + 120).replace(/\s+/g, ' '),
        });
        if (matches.length >= 5) break;
      }
    }
    if (matches.length) hits.push({ key, ...index[key], matches });
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  // Distilled notes are part of memory: search them too.
  const noteHits = [];
  let noteFiles = [];
  try { noteFiles = (await fsp.readdir(NOTES_DIR)).filter(f => f.endsWith('.md')); } catch {}
  for (const f of noteFiles) {
    try {
      const text = await fsp.readFile(path.join(NOTES_DIR, f), 'utf8');
      const pos = text.toLowerCase().indexOf(needle);
      if (pos < 0) continue;
      const start = Math.max(0, pos - 80);
      noteHits.push({
        kind: 'note', file: f,
        title: (text.match(/^# (.*)$/m) || [])[1] || f,
        snippet: text.slice(start, pos + needle.length + 120).replace(/\s+/g, ' '),
      });
    } catch {}
  }
  return [...noteHits, ...hits];
}

// ---------- markdown export ----------
// mode: 'chat' (user+assistant), 'commands' (tool calls only), 'all' (everything)
function keepInMode(m, mode) {
  if (mode === 'commands') return m.role === 'tool';
  if (mode === 'all') return true;
  return m.role === 'user' || m.role === 'assistant';
}

// Pair tool calls with their results (by id when present, else in order).
function pairTools(messages) {
  const pairs = [];
  const open = [];
  for (const m of messages) {
    if (m.role === 'tool') { const p = { call: m, result: null }; pairs.push(p); open.push(p); }
    else if (m.role === 'toolresult') {
      let p = m.tid ? open.find(x => x.call.id === m.tid) : null;
      if (!p) p = open[0];
      if (p) { p.result = m; open.splice(open.indexOf(p), 1); }
    }
  }
  return pairs;
}

const READ_TOOLS = /^(read|read_file|view|cat|notebookread)$/i;

// Provenance block for copies and exports. The full paths let a receiving
// agent find the original session file, its distilled note, and its epics.
function provenanceMarkdown(s) {
  const key = s.key || '';
  const notePath = (index[key] && index[key].notePath) || s.notePath || null;
  const lines = [
    `- **Directory:** \`${s.cwd || '?'}\``,
  ];
  if (s.gitBranch) lines.push(`- **Branch:** \`${s.gitBranch}\``);
  lines.push(
    `- **Date:** ${s.firstTs || '?'} → ${s.lastTs || '?'}`,
    `- **Session id (aiconvo):** \`${key || s.relPath || '?'}\``,
    `- **Original transcript (raw JSONL, full record):** \`${(key && absPathForKey(key)) || '?'}\``,
    `- **Extracted conversation (JSON, user/assistant text only):** \`${key ? cachePathFor(key) : '?'}\``,
    `- **Distilled note (markdown):** ${notePath ? `\`${notePath}\`` : '(none yet)'}`,
  );
  for (const e of Object.values(epics)) {
    if ((e.sessionIds || []).includes(key))
      lines.push(`- **Part of epic:** ${e.title} — \`${epicPathFor(e.id)}\``);
  }
  lines.push(`- **Open in aiconvo:** <http://localhost:${PORT}/#${encodeURIComponent(key)}>`);
  return lines.join('\n') + '\n';
}

function derivedMarkdown(s, mode) {
  const parts = [`# ${s.title || s.relPath}\n`, provenanceMarkdown(s)];
  const pairs = pairTools(s.messages);
  if (mode === 'uniqcmd') {
    const tools = new Map(), commands = new Map();
    for (const { call } of pairs) {
      tools.set(call.name, (tools.get(call.name) || 0) + 1);
      if (/bash|shell|exec|command/i.test(call.name) && call.text)
        commands.set(call.text, (commands.get(call.text) || 0) + 1);
    }
    parts.push('## Tools used\n', [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `- ${n} ×${c}`).join('\n') + '\n');
    parts.push('## Unique commands\n', '```\n' + [...commands.keys()].join('\n') + '\n```\n');
  } else {
    const files = new Map();
    for (const { call, result } of pairs) {
      if (call.path && READ_TOOLS.test(call.name) && result) files.set(call.path, result.text);
    }
    for (const [p, text] of files) parts.push(`## ${p}\n`, '```\n' + text + '\n```\n');
  }
  return parts.join('\n');
}

function toMarkdown(sessions, mode = 'chat') {
  const parts = [];
  for (const s of sessions) {
    if (mode === 'uniqcmd' || mode === 'files') {
      parts.push(derivedMarkdown(s, mode), '\n---\n');
      continue;
    }
    parts.push(`# ${s.title || s.relPath}\n`);
    parts.push(provenanceMarkdown(s));
    for (const m of s.messages) {
      if (!keepInMode(m, mode)) continue;
      if (m.role === 'tool') {
        parts.push(`### 🔧 ${m.name || 'tool'}\n`);
        parts.push('```\n' + (m.text || '').trim() + '\n```\n');
      } else if (m.role === 'toolresult') {
        parts.push('### 📄 Result\n');
        parts.push('```\n' + m.text.trim() + '\n```\n');
      } else {
        // Other-branch messages stay in the export (complete record) but
        // carry a marker so a reader knows they are not on the current path.
        const off = m.off ? ' (other branch)' : '';
        parts.push(m.role === 'user' ? `## 🧑 User${off}\n` : `## 🤖 Assistant${off}\n`);
        parts.push(m.text.trim() + '\n');
      }
    }
    parts.push('\n---\n');
  }
  return parts.join('\n');
}

// ---------- conversation tree & fork ----------
// Both formats store a real message tree:
//  - pi: every entry has {id, parentId}; the TUI branches by attaching new
//    entries to an earlier parent (plus branch_summary markers on return).
//  - Claude Code: every entry has {uuid, parentUuid}; edits and rewinds
//    create sibling branches the same way.
// The tree view contracts that entry graph to user/assistant text messages
// and merges linear assistant runs into one "turn" box.

// A short deterministic title for one message: first sentence-ish line.
function nodeTitle(text) {
  let t = String(text || '').replace(/```[\s\S]*?```/g, ' [code] ');
  t = (t.split('\n').map(s => s.trim()).find(s => s) || '');
  t = t.replace(/^#+\s*/, '').replace(/^[-*>•]\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.{15,90}?[.!?](?=\s|$)/);
  if (m) t = m[0];
  if (t.length > 90) t = t.slice(0, 90).replace(/\s\S*$/, '') + ' …';
  return t || '(empty)';
}

function treeFieldsFor(source) {
  return source === 'claude'
    ? { idField: 'uuid', parentField: 'parentUuid' }
    : { idField: 'id', parentField: 'parentId' };
}

function parseTreeEntries(kind, raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    let node = null;
    if (kind === 'pi') {
      if (!d.id || d.type === 'session') continue;
      node = { id: d.id, parent: d.parentId || null, role: null, text: '', ts: d.timestamp || null };
      if (d.type === 'message' && d.message && (d.message.role === 'user' || d.message.role === 'assistant')) {
        node.role = d.message.role;
        node.text = textOf(d.message.content);
      }
    } else {
      if (!d.uuid || d.isSidechain) continue;
      node = { id: d.uuid, parent: d.parentUuid || null, role: null, text: '', ts: d.timestamp || null };
      if ((d.type === 'user' || d.type === 'assistant') && !d.isMeta && d.message) {
        node.role = d.type;
        node.text = textOf(d.message.content);
      }
    }
    node.box = !!(node.role && node.text.trim() && !(node.role === 'user' && isNoise(node.text)));
    out.push(node);
  }
  return out;
}

function keyForSessionPath(p) {
  for (const [source, base] of Object.entries(SOURCES)) {
    const rel = path.relative(base, p);
    if (!rel.startsWith('..') && index[source + ':' + rel]) return source + ':' + rel;
  }
  return null;
}

// A fork family: conversations that share their first entry id (forks copy
// the root chain verbatim) or that point at each other via pi's parentSession.
function forkFamily(key) {
  const fam = new Set([key]);
  const rootId = index[key] && index[key].rootId;
  if (rootId) for (const [k, e] of Object.entries(index)) if (e.rootId === rootId) fam.add(k);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, e] of Object.entries(index)) {
      if (!e.parentSession) continue;
      const pk = keyForSessionPath(e.parentSession);
      if (!pk || fam.has(k) === fam.has(pk)) continue;
      fam.add(k); fam.add(pk); grew = true;
    }
  }
  fam.delete(key);
  return [key, ...[...fam].filter(k => index[k]).sort((a, b) => (index[a].firstTs || '').localeCompare(index[b].firstTs || ''))];
}

async function sessionTreeFor(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  // Union the whole fork family: shared entries dedupe by id, so every
  // fork's new messages attach to the shared chain as real branches.
  const family = forkFamily(key);
  const byId = new Map();
  const all = [];
  const lastBoxOf = new Map();
  for (const k of family) {
    const e = index[k];
    let raw;
    try { raw = await fsp.readFile(absPathForKey(k), 'utf8'); } catch { continue; }
    for (const parsedNode of parseTreeEntries(e.source === 'claude' ? 'claude' : 'pi', raw)) {
      let n = byId.get(parsedNode.id);
      if (!n) {
        n = parsedNode;
        n.keys = new Set();
        byId.set(n.id, n);
        all.push(n);
      }
      n.keys.add(k);
      if (n.box) lastBoxOf.set(k, n);
    }
  }
  // Contract the entry graph to text messages: nearest box ancestor is the parent.
  const boxes = all.filter(n => n.box);
  const childCount = new Map();
  for (const b of boxes) {
    let p = b.parent && byId.get(b.parent);
    while (p && !p.box) p = p.parent && byId.get(p.parent);
    b.bparent = p || null;
    if (p) childCount.set(p.id, (childCount.get(p.id) || 0) + 1);
  }
  // Merge a linear assistant→assistant chain into one turn box.
  // Never merge across a fork boundary (different file membership).
  const groupOf = new Map();
  const groups = [];
  for (const b of boxes) {
    const p = b.bparent;
    const g = p && b.role === 'assistant' && p.role === 'assistant' && childCount.get(p.id) === 1
      && p.keys.size === b.keys.size ? groupOf.get(p.id) : null;
    if (g) { g.members.push(b); groupOf.set(b.id, g); }
    else { const ng = { members: [b] }; groups.push(ng); groupOf.set(b.id, ng); }
  }
  // The active branch: the path from the viewed file's newest message to the root.
  const active = new Set();
  const viewedLeaf = lastBoxOf.get(key);
  for (let g = viewedLeaf ? groupOf.get(viewedLeaf.id) : null; g;) {
    active.add(g);
    const up = g.members[0].bparent;
    g = up ? groupOf.get(up.id) : null;
  }
  const nodes = groups.map(g => {
    const first = g.members[0], last = g.members[g.members.length - 1];
    const up = first.bparent ? groupOf.get(first.bparent.id) : null;
    const owner = last.keys.has(key) ? key : family.find(k => last.keys.has(k)) || key;
    return {
      id: last.id,                       // fork point: the whole turn is kept
      parent: up ? up.members[up.members.length - 1].id : null,
      role: first.role,
      ts: first.ts, lastTs: last.ts,
      jumpTs: first.ts,                  // transcript anchor of the first message
      title: nodeTitle(g.members.length > 1 ? last.text : first.text),
      count: g.members.length,
      chars: g.members.reduce((n, m) => n + m.text.length, 0),
      active: active.has(g),
      key: owner,                        // the conversation to read or fork from
      fork: owner !== key || undefined,  // lives in a forked/linked session
    };
  });
  return {
    key, source: entry.source, title: entry.title, nodes,
    family: family.map(k => ({ key: k, title: (index[k] && index[k].title) || '' })),
  };
}

// ---------- session operations (fork / branch) ----------
// pi session operations run through pi's own runtime (pirpc.js + the
// aiconvo-bridge extension). Claude keeps a hand copier: no native
// arbitrary-node fork exists (verified empirically).
const { piForkAt, piForkBefore } = require('./pirpc.js');

function sessionPathsFor(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const relPath = key.slice(entry.source.length + 1);
  const sessionPath = path.resolve(SOURCES[entry.source], relPath);
  const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir();
  return { entry, relPath, sessionPath, cwd };
}

// Per-session-file operation queue: fork and branch surgery on one file never
// interleaves. Live ownership (an open Herdr agent) is checked separately.
const sessionFileOps = new Map();
function withSessionOp(absPath, fn) {
  const prev = sessionFileOps.get(absPath) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const gate = run.catch(() => {}).then(() => {
    if (sessionFileOps.get(absPath) === gate) sessionFileOps.delete(absPath);
  });
  sessionFileOps.set(absPath, gate);
  return run;
}

// Index a session file that pi just wrote and return its aiconvo key.
// pi decides the location (the session dir for the session's cwd), so map
// the absolute path back onto a known source.
async function indexNewSessionFile(newAbs) {
  for (const [source, base] of Object.entries(SOURCES)) {
    const rel = path.relative(base, newAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    await indexFile(source, rel, await fsp.stat(newAbs));
    return source + ':' + rel;
  }
  throw new Error('pi wrote the fork outside the known session folders: ' + newAbs);
}

// Fork: continue from a node in a NEW session; the original does not change.
//  - pi: pi's own runtime forks through the node (bridge, position "at").
//  - Claude: no native arbitrary-node fork exists (verified empirically), so
//    copy the root→node chain (sessionfork.js) with a temp file + atomic
//    rename, then resume with `claude --resume <uuid>`.
async function forkSession(key, nodeId) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  return withSessionOp(sessionPath, async () => {
    if (entry.source !== 'claude') {
      const forked = await piForkAt({ sessionPath, cwd }, nodeId);
      return { key: await indexNewSessionFile(forked.file), path: forked.file, sessionId: forked.sessionId };
    }
    const raw = await fsp.readFile(sessionPath, 'utf8');
    const newId = crypto.randomUUID();
    const content = claudeForkContent(raw, nodeId, newId);
    const newAbs = path.join(path.dirname(sessionPath), `${newId}.jsonl`);
    const tmp = newAbs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, newAbs);
    const relPath = path.relative(SOURCES[entry.source], newAbs);
    await indexFile(entry.source, relPath, await fsp.stat(newAbs));
    return { key: entry.source + ':' + relPath, path: newAbs, sessionId: newId };
  });
}

// Fork-edit (pi only): fork BEFORE a user message and return its text so the
// UI opens the new session with the prompt ready to edit and resend.
async function forkSessionForEdit(key, nodeId) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (entry.source === 'claude') throw new Error('Editing a past message needs pi. Claude conversations can only fork.');
  return withSessionOp(sessionPath, async () => {
    const forked = await piForkBefore({ sessionPath, cwd }, nodeId);
    return { key: await indexNewSessionFile(forked.file), path: forked.file, sessionId: forked.sessionId, text: forked.text };
  });
}

// In-file branch (pi only). pi's session manager picks its leaf as the LAST
// entry in the file on load, and pi's own branch() writes a no-op label entry
// parented at the branch point. We append exactly that: one label entry with
// parentId = the chosen node. The next resume continues from that point in
// the SAME conversation; nothing is rewritten or copied.
// Claude Code cannot do this: verified empirically, its CLI ignores appended
// anchors and always continues at the last real message. Claude gets forks.
async function branchSession(key, nodeId) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  if (entry.source === 'claude')
    throw new Error('Claude cannot branch in place — its CLI always continues at the file end. Use fork instead.');
  // A running pi keeps its own leaf in memory and would ignore the new anchor.
  // Close the conversation's Herdr agent automatically — but only when it is
  // not working. Killing active work silently would lose more than a warning.
  // pi persists every entry as it happens, so closing an idle pi is safe.
  let closedAgent = false;
  {
    let agents = [];
    try { agents = await herdrAgents(); } catch {} // herdr not running: nothing to close
    const info = herdrConversationInfo(key);
    const agent = agents.find(item => agentMatchesConversation(item, info));
    if (agent) {
      if (agent.agent_status === 'working') {
        throw new Error("This conversation's Herdr agent is working. Wait for it to finish, then branch.");
      }
      await herdrApi('pane.close', { pane_id: agent.pane_id });
      // The anchor only works once the agent is really gone.
      const deadline = Date.now() + 8000;
      for (;;) {
        let still = null;
        try { still = (await herdrAgents()).find(item => agentMatchesConversation(item, info)); } catch {}
        if (!still) break;
        if (Date.now() > deadline) throw new Error('Could not close the Herdr agent. Close it in Herdr, then branch.');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      closedAgent = true;
    }
  }
  const absPath = absPathForKey(key);
  return withSessionOp(absPath, async () => {
    const raw = await fsp.readFile(absPath, 'utf8');
    let found = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).id === nodeId) { found = true; break; } } catch {}
    }
    if (!found) throw new Error('message not found in the session file');
    const anchor = {
      type: 'label',
      id: crypto.randomBytes(4).toString('hex'),
      parentId: nodeId,
      timestamp: new Date().toISOString(),
      targetId: nodeId,
    };
    await fsp.appendFile(absPath, JSON.stringify(anchor) + '\n');
    return { ok: true, key, node: nodeId, closedAgent };
  });
}

// ---------- distillation ----------
// Two steps. Step 1 maps the full conversation into a problem tree.
// Step 2 distills each problem with generous context (too much beats too little).
const crypto = require('crypto');
const NOTES_DIR = path.join(os.homedir(), 'notes', 'aiconvo');
const EPICS_DIR = path.join(NOTES_DIR, 'epics');
const EPICS_FILE = path.join(CACHE_DIR, 'epics.json');
const EPIC_INPUTS_DIR = path.join(CACHE_DIR, 'epic-inputs');
const TIMELINE_TITLES_FILE = path.join(CACHE_DIR, 'timeline-titles.json');
fs.mkdirSync(EPICS_DIR, { recursive: true });
fs.mkdirSync(EPIC_INPUTS_DIR, { recursive: true });

// Epics keep a stable group of conversations and a generated cross-session timeline.
let epics = {};
try { epics = JSON.parse(fs.readFileSync(EPICS_FILE, 'utf8')); } catch {}
function saveEpics() {
  fs.writeFile(EPICS_FILE, JSON.stringify(epics), () => {});
}
const epicPathFor = id => path.join(EPICS_DIR, id + '.md');
const epicInputsPathFor = id => path.join(EPIC_INPUTS_DIR, id + '.json');

let timelineTitles = {};
try { timelineTitles = JSON.parse(fs.readFileSync(TIMELINE_TITLES_FILE, 'utf8')); } catch {}
function saveTimelineTitles() {
  fs.writeFile(TIMELINE_TITLES_FILE, JSON.stringify(timelineTitles), () => {});
}

// Leaf-note cache: distilled work is expensive; reuse it when a segment reappears
// (typically on re-distill of a grown session, where early problems are unchanged).
const LEAF_CACHE_FILE = path.join(CACHE_DIR, 'distill-cache.json');
let leafCache = {};
try { leafCache = JSON.parse(fs.readFileSync(LEAF_CACHE_FILE, 'utf8')); } catch {}
function saveLeafCache() {
  fs.writeFile(LEAF_CACHE_FILE, JSON.stringify(leafCache), () => {});
}
const segHash = (seg, title) => crypto.createHash('sha256').update('v1\x00' + title + '\x00' + seg).digest('hex').slice(0, 32);

// Prior problem trees, fed back to the mapper so boundaries stay sticky across re-distills.
const TREES_DIR = path.join(CACHE_DIR, 'trees');
fs.mkdirSync(TREES_DIR, { recursive: true });
const treePathFor = key => path.join(TREES_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
const PI_ARGS = [
  '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-context-files', '--thinking', 'off',
  '--provider', 'openai-codex', '--model', 'gpt-5.6-sol',
];
const PI_CONTEXT_TOKENS = 272000;
const PI_TARGET_TOKENS = Math.floor(PI_CONTEXT_TOKENS * 0.80);
// Code and JSON can use close to one token per two bytes. This is safer than chars / 4.
const estimateInputTokens = text => Math.max(
  Math.ceil(Buffer.byteLength(String(text), 'utf8') / 2),
  Math.ceil(String(text).split(/\s+/).filter(Boolean).length * 1.35),
);

function splitTextToTokenBudget(text, tokenBudget = PI_TARGET_TOKENS) {
  const input = String(text);
  if (estimateInputTokens(input) <= tokenBudget) return [input];
  const parts = [];
  let rest = input;
  while (rest) {
    let lo = 1, hi = rest.length, best = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (estimateInputTokens(rest.slice(0, mid)) <= tokenBudget) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    let cut = best;
    const line = rest.lastIndexOf('\n', best);
    if (line > best * 0.80) cut = line + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}

function runPi(fileContent, prompt, onChunk) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'aiconvo-distill-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(tmp, fileContent);
    const child = execFile('pi', [...PI_ARGS, '@' + tmp, prompt], { maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
      (err, stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      });
    child.stdin.end(); // pi -p waits for stdin EOF otherwise
    if (onChunk) child.stdout.on('data', d => onChunk(String(d)));
  });
}

const TIMELINE_TITLE_PROMPT =
  'The attached JSON array contains conversation ids and initial user requests. ' +
  'Write a useful task label for each conversation. Each label must name the actual work, use at most 10 characters, and contain no period. ' +
  'Do not use generic labels such as conversation, request, help, or question. ' +
  'Reply with STRICT JSON only, no prose or code fence: [{"id":N,"title":"..."}]. Keep every input id.';

let timelineTitleRunning = false;
let timelineTitleAgain = false;
function scheduleTimelineTitles() {
  clearTimeout(scheduleTimelineTitles.t);
  scheduleTimelineTitles.t = setTimeout(refreshTimelineTitles, 5000);
}

function mapTimelineLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => out);
}

async function refreshTimelineTitles() {
  if (timelineTitleRunning) { timelineTitleAgain = true; return; }
  const pending = Object.entries(index).filter(([key, e]) => {
    const saved = timelineTitles[key];
    return !saved || saved.hash !== e.timelineTitleHash;
  });
  if (!pending.length) return;
  timelineTitleRunning = true;
  try {
    const batches = [];
    for (let i = 0; i < pending.length; i += 60) batches.push(pending.slice(i, i + 60));
    await mapTimelineLimit(batches, 3, async batch => {
      const input = batch.map(([, e], id) => ({ id, request: e.title }));
      try {
        const raw = await runPi(JSON.stringify(input), TIMELINE_TITLE_PROMPT);
        const result = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(result)) return;
        const updates = [];
        for (const item of result) {
          const pair = batch[Number(item.id)];
          if (!pair) continue;
          const [key, oldEntry] = pair;
          if (!index[key] || index[key].timelineTitleHash !== oldEntry.timelineTitleHash) continue;
          const title = timelineTitle(item.title).slice(0, 10);
          timelineTitles[key] = { hash: oldEntry.timelineTitleHash, title };
          index[key].timelineTitle = title;
          try {
            const file = cachePathFor(key);
            const data = JSON.parse(await fsp.readFile(file, 'utf8'));
            data.timelineTitle = title;
            data.timelineTitleHash = oldEntry.timelineTitleHash;
            await fsp.writeFile(file, JSON.stringify(data));
          } catch {}
          updates.push({ key, title });
        }
        if (updates.length) broadcast({ type: 'timeline-titles', titles: updates });
        saveTimelineTitles();
        saveIndexSoon();
      } catch (e) {
        console.error('timeline title batch failed:', e.message);
      }
    });
  } finally {
    timelineTitleRunning = false;
    if (timelineTitleAgain) { timelineTitleAgain = false; scheduleTimelineTitles(); }
  }
}

// Every message, numbered, nothing dropped. Tool results stay (already capped at 4k).
function numberedTranscript(messages, from = 0, to = Infinity) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (i < from || i > to) continue;
    const m = messages[i];
    if (m.role === 'tool') out.push(`[#${i} tool:${m.name}]\n${m.text}`);
    else if (m.role === 'toolresult') out.push(`[#${i} result]\n${m.text}`);
    else out.push(`[#${i} ${m.role}]\n${m.text}`);
  }
  return out.join('\n\n');
}

const TREE_PROMPT =
  'The attached file is a full, numbered transcript of a work session (user, assistant, tool calls, results). ' +
  'Map it into a tree of the distinct problems worked on. A session often contains several unrelated problems; split them. ' +
  'Nest sub-problems under their parent. Reply with STRICT JSON only, no prose, no code fence: ' +
  '{"problems":[{"title":"...","from":N,"to":N,"children":[...]}]} ' +
  'where from/to are the first and last message numbers (the [#N] markers) belonging to that problem, inclusive. ' +
  'Cover every message; ranges of siblings must not overlap.';

const DISTILL_PROMPT = (title, outline) =>
  'You get the full transcript of one problem from a work session, plus the outline of the whole session for orientation.\n' +
  'Session outline:\n' + outline + '\n\n' +
  `Write a note about the problem "${title}" for the person who had this conversation, to be read months from now. ` +
  'State: the problem in one line; what actually worked (quote commands, paths and config exactly); ' +
  'what failed and why, if instructive; one thing to remember. Under 250 words. ' +
  'Use bold labels like **Problem:** for structure — never markdown headings (#), they are reserved for the document. ' +
  'No praise, no narration of the conversation flow, no "the user asked". ' +
  'If this problem contains nothing worth keeping, reply with exactly: NOTHING-TO-KEEP';

const ROLLUP_PROMPT = title =>
  'The attached file holds the finished notes of the sub-problems of "' + title + '". ' +
  'Write the parent note: one line per sub-problem stating what happened there, ' +
  'plus — only if it exists — the decision, ordering, or turning point that connects them and appears in no child note. ' +
  'Hard cap: 6 lines. No headings, no summary phrases like "overall" or "in this session", no restating child details.';

function treeOutline(nodes, depth = 0) {
  return nodes.map(n =>
    '  '.repeat(depth) + `- ${n.title} (#${n.from}–#${n.to})` +
    (n.children && n.children.length ? '\n' + treeOutline(n.children, depth + 1) : '')
  ).join('\n');
}

function leaves(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.children && n.children.length) out.push(...leaves(n.children));
    else out.push(n);
  }
  return out;
}

function parentNodes(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    if (n.children && n.children.length) {
      out.push({ n, depth });
      parentNodes(n.children, depth + 1, out);
    }
  }
  return out;
}

const nodeText = n => (n.children && n.children.length ? n.rollup : n.note) || null;
const hasContent = n => !!nodeText(n) || (n.children || []).some(hasContent);

// Note body that mirrors the tree: heading depth = tree depth.
function renderNode(n, depth, parts) {
  if (!hasContent(n)) return;
  const h = '#'.repeat(Math.min(2 + depth, 6));
  parts.push(`${h} ${n.title}`, '');
  const t = nodeText(n);
  if (t) parts.push(t, '');
  for (const c of n.children || []) renderNode(c, depth + 1, parts);
}

async function distill(data, emit = () => {}) {
  emit({ type: 'status', text: 'Mapping the problem tree…' });
  const full = numberedTranscript(data.messages);
  let prior = null;
  try { prior = JSON.parse(await fsp.readFile(treePathFor(data.key), 'utf8')); } catch {}
  let tree;
  try {
    const prompt = TREE_PROMPT + (prior
      ? ' A prior mapping of an earlier version of this session follows; keep its boundaries and titles unless new messages require changes: ' + JSON.stringify(prior)
      : '');
    const raw = await runPi(full, prompt);
    tree = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, '')).problems;
    if (!Array.isArray(tree) || !tree.length) throw new Error('empty tree');
  } catch {
    tree = [{ title: data.title || 'Session', from: 0, to: data.messages.length - 1, children: [] }];
  }
  fsp.writeFile(treePathFor(data.key), JSON.stringify(tree)).catch(() => {});
  const outline = treeOutline(tree);
  const jobs = leaves(tree);
  const rollupJobs = parentNodes(tree).sort((a, b) => b.depth - a.depth); // deepest first
  const grandTotal = jobs.length + rollupJobs.length;
  emit({ type: 'tree', outline, total: grandTotal });
  // Distill leaves with limited concurrency.
  let idx = 0, done = 0;
  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const n = jobs[i];
      emit({ type: 'leaf-start', i, title: n.title });
      try {
        const seg = numberedTranscript(data.messages, n.from ?? 0, n.to ?? data.messages.length - 1);
        const h = segHash(seg, n.title);
        if (h in leafCache) {
          n.note = leafCache[h]; // may be null (NOTHING-TO-KEEP)
          if (n.note) emit({ type: 'chunk', i, text: n.note });
        } else {
          const text = await runPi(seg, DISTILL_PROMPT(n.title, outline),
            chunk => emit({ type: 'chunk', i, text: chunk }));
          n.note = /^NOTHING-TO-KEEP/m.test(text) ? null : text;
          leafCache[h] = n.note;
          saveLeafCache();
        }
      } catch (e) { n.note = `*(distillation failed: ${e.message})*`; }
      emit({ type: 'leaf-done', i, title: n.title, empty: !n.note, done: ++done, total: grandTotal });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  // Pass 3: bottom-up parent rollups from the children's notes (cheap, small inputs).
  if (rollupJobs.length) emit({ type: 'status', text: 'Rolling up parent notes…' });
  for (let k = 0; k < rollupJobs.length; k++) {
    const { n } = rollupJobs[k];
    const i = jobs.length + k;
    emit({ type: 'leaf-start', i, title: '⤴ ' + n.title });
    const childNotes = n.children
      .map(c => `### ${c.title}\n\n${nodeText(c) || '(nothing kept)'}`)
      .join('\n\n');
    try {
      const text = await runPi(childNotes, ROLLUP_PROMPT(n.title),
        chunk => emit({ type: 'chunk', i, text: chunk }));
      n.rollup = /^NOTHING-TO-KEEP/m.test(text) ? null : text;
    } catch (e) { n.rollup = null; }
    emit({ type: 'leaf-done', i, title: '⤴ ' + n.title, empty: !n.rollup, done: ++done, total: grandTotal });
  }
  const parts = [
    `# ${data.title || 'Session'}`, '',
    `- **Directory:** \`${data.cwd || '?'}\``,
    `- **Date:** ${data.firstTs || '?'}`,
    `- **Session:** ${data.key}`, '',
    '## Problems', '', outline, '',
  ];
  for (const n of tree) renderNode(n, 0, parts);
  if (!tree.some(hasContent)) parts.push('*(Nothing worth keeping was found in this session.)*');
  const note = parts.join('\n');
  emit({ type: 'done', note });
  return { outline, note };
}

function noteFileFor(data, title) {
  const date = (data.firstTs || '').slice(0, 10) || 'undated';
  const slug = (title || data.title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return path.join(NOTES_DIR, `${date}-${slug}.md`);
}

const TITLE_PROMPT =
  'The attached file is a distilled note of a work session. Reply with STRICT JSON only, no prose, no code fence: ' +
  '{"title":"...","abstract":"..."} — title: specific and short (max 60 chars), names the actual work, no generic words like "session" or "conversation"; ' +
  'abstract: 2–4 sentences stating what was done and what the note contains.';

// Cross-session evidence is cached because an undistilled conversation needs one model pass.
const EPIC_EVIDENCE_FILE = path.join(CACHE_DIR, 'epic-evidence-cache.json');
let epicEvidenceCache = {};
try { epicEvidenceCache = JSON.parse(fs.readFileSync(EPIC_EVIDENCE_FILE, 'utf8')); } catch {}
function saveEpicEvidenceCache() {
  fs.writeFile(EPIC_EVIDENCE_FILE, JSON.stringify(epicEvidenceCache), () => {});
}

const EPIC_EVIDENCE_PROMPT =
  'The attached file is one work conversation. Extract evidence for a later cross-session project narrative. ' +
  'State the goal, important actions, decisions, results, failures, and unresolved work. Keep exact commands and paths only when important. ' +
  'Use at most 300 words. Do not describe the conversation itself. Do not use markdown headings.';

const EPIC_SECTION_PROMPT = (part, total) =>
  `The attached file is large section ${part} of ${total} from one work conversation. ` +
  'Extract evidence for a later cross-session project narrative. Preserve chronology and exact important decisions, results, failures, commands, paths, and unresolved work. ' +
  'Use at most 450 words. Do not describe the conversation or use markdown headings.';

const EPIC_SECTION_ROLLUP_PROMPT =
  'The attached file contains chronological evidence extracted from large sections of one conversation. ' +
  'Merge it into one evidence card. Remove repeats but preserve the causal order, reversals, important decisions, results, failures, exact important commands and paths, and unresolved work. ' +
  'Use at most 300 words. Do not describe the summarization process. Do not use markdown headings.';

const EPIC_PROMPT = focus =>
  'The attached file contains chronological evidence from several work conversations that belong to one larger problem or epic. ' +
  (focus ? `Use this preferred epic name or focus: "${focus}". ` : '') +
  'Find the causal narrative across sessions. Combine repeated work. Keep reversals, failed approaches, decisions, and turning points in time order. ' +
  'Reply with STRICT JSON only, no prose, no code fence, in this shape: ' +
  '{"title":"max 70 chars","abstract":"2-4 sentences","chapters":[{"date":"YYYY-MM-DD or range","title":"...","sessionIds":["exact id"],"narrative":"...","outcome":"..."}],"currentState":"...","openQuestions":["..."]}. ' +
  'Use only exact session ids from the evidence. Each chapter must represent a meaningful phase, not merely one conversation. ' +
  'Do not put markdown headings in text fields.';

const isContextLimitError = e => /context window|input exceeds|too many tokens|maximum context/i.test(e.message || '');

async function summarizeEpicSection(section, prompt, emit, depth = 0) {
  try { return await runPi(section, prompt); }
  catch (e) {
    if (!isContextLimitError(e) || depth >= 4 || estimateInputTokens(section) < 32000) throw e;
    // Tokenizers vary by content. If the 80% estimate is rejected, halve only this section.
    const retryBudget = Math.max(16000, Math.floor(estimateInputTokens(section) * 0.48));
    const parts = splitTextToTokenBudget(section, retryBudget);
    if (parts.length < 2) throw e;
    emit({ phase: 'retry-split', sections: parts.length });
    const summaries = await mapLimit(parts, 2, (part, i) =>
      summarizeEpicSection(part, EPIC_SECTION_PROMPT(i + 1, parts.length), emit, depth + 1));
    return runPi(summaries.map((text, i) => `=== RETRY SECTION ${i + 1}/${summaries.length} ===\n${text}`).join('\n\n'), EPIC_SECTION_ROLLUP_PROMPT);
  }
}

async function summarizeLargeEpicEvidence(transcript, emit = () => {}) {
  const promptReserve = 6000;
  const sections = splitTextToTokenBudget(transcript, PI_TARGET_TOKENS - promptReserve);
  if (sections.length === 1) return summarizeEpicSection(transcript, EPIC_EVIDENCE_PROMPT, emit);
  const summaries = await mapLimit(sections, 3, async (section, i) => {
    emit({ phase: 'section', section: i + 1, sections: sections.length });
    const h = crypto.createHash('sha256').update('epic-section-v2\x00' + section).digest('hex').slice(0, 32);
    const cached = epicEvidenceCache[h];
    if (cached && typeof cached.text === 'string') return cached.text;
    const text = await summarizeEpicSection(section, EPIC_SECTION_PROMPT(i + 1, sections.length), emit);
    epicEvidenceCache[h] = { text, kind: 'section', createdAt: Date.now() };
    saveEpicEvidenceCache();
    return text;
  });
  let level = summaries.map((text, i) => `=== SECTION ${i + 1}/${summaries.length} ===\n${text}`);
  let pass = 1;
  while (level.length > 1 || estimateInputTokens(level[0]) > PI_TARGET_TOKENS - promptReserve) {
    const groups = [];
    let group = [], tokens = 0;
    for (const item of level) {
      const n = estimateInputTokens(item);
      if (group.length && tokens + n > PI_TARGET_TOKENS - promptReserve) { groups.push(group); group = []; tokens = 0; }
      group.push(item); tokens += n;
    }
    if (group.length) groups.push(group);
    if (groups.length === 1) return runPi(groups[0].join('\n\n'), EPIC_SECTION_ROLLUP_PROMPT);
    level = await mapLimit(groups, 3, async (items, i) => {
      emit({ phase: 'rollup', pass, group: i + 1, groups: groups.length });
      return runPi(items.join('\n\n'), EPIC_SECTION_ROLLUP_PROMPT);
    });
    level = level.map((text, i) => `=== ROLLUP ${i + 1}/${level.length} ===\n${text}`);
    pass++;
  }
  return level[0];
}

const epicEvidenceHash = data => crypto.createHash('sha256')
  .update('v1\x00' + data.key + '\x00' + numberedTranscript(data.messages))
  .digest('hex').slice(0, 32);

function latestCachedEvidenceForKey(key) {
  let latest = null;
  for (const [hash, cached] of Object.entries(epicEvidenceCache)) {
    if (!cached || typeof cached !== 'object' || cached.key !== key || typeof cached.text !== 'string') continue;
    if (!latest || (cached.createdAt || 0) > (latest.cached.createdAt || 0)) latest = { hash, cached };
  }
  return latest;
}

async function existingEvidenceFor(data, allowStale = false) {
  const entry = index[data.key] || {};
  const notePath = data.notePath || entry.notePath;
  if (notePath) {
    try {
      const text = await fsp.readFile(notePath, 'utf8');
      const st = await fsp.stat(notePath);
      const notedAt = entry.notedAt || st.mtimeMs;
      const outdated = !!(entry.mtimeMs && notedAt && entry.mtimeMs > notedAt);
      return { text, kind: 'note', source: outdated ? 'outdated-note' : 'distilled-note', notePath, outdated, created: false };
    } catch {}
  }
  const h = epicEvidenceHash(data);
  if (h in epicEvidenceCache) {
    const cached = epicEvidenceCache[h];
    const text = typeof cached === 'string' ? cached : cached.text;
    if (typeof text === 'string') return { text, kind: 'card', source: 'cached-evidence-card', hash: h, outdated: false, created: false };
  }
  if (allowStale) {
    const latest = latestCachedEvidenceForKey(data.key);
    if (latest) return {
      text: latest.cached.text, kind: 'card', source: 'outdated-evidence-card',
      hash: latest.hash, outdated: true, created: false, createdAt: latest.cached.createdAt || null,
    };
  }
  return null;
}

async function epicEvidenceFor(data, emit = () => {}, forceCard = false) {
  if (!forceCard) {
    const existing = await existingEvidenceFor(data);
    if (existing) return existing;
  }
  const transcript = numberedTranscript(data.messages);
  const h = epicEvidenceHash(data);
  const text = await summarizeLargeEpicEvidence(transcript, emit);
  epicEvidenceCache[h] = { text, key: data.key, createdAt: Date.now() };
  saveEpicEvidenceCache();
  return { text, kind: 'card', source: 'new-evidence-card', hash: h, outdated: false, created: true };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const oneLine = (s, fallback) => String(s || fallback).replace(/\s+/g, ' ').trim();

async function buildEpicStory(evidenceInputs, focus, emit = () => {}) {
  const blocks = evidenceInputs.map(e => [
    `=== CONVERSATION ${e.key} ===`,
    `Date: ${e.firstTs || '?'} -> ${e.lastTs || '?'}`,
    `Directory: ${e.cwd || '?'}`,
    `Initial title: ${oneLine(e.title, '(untitled)')}`,
    `Evidence source: ${e.source}`,
    '', e.text,
  ].join('\n'));
  const budget = PI_TARGET_TOKENS - 12000;
  if (estimateInputTokens(blocks.join('\n\n')) <= budget) {
    return runPi(blocks.join('\n\n'), EPIC_PROMPT(focus));
  }
  // Very large epics get chronological chapter drafts first, then one final merge.
  const groups = [];
  let group = [], tokens = 0;
  for (const block of blocks) {
    const n = estimateInputTokens(block);
    if (group.length && tokens + n > budget) { groups.push(group); group = []; tokens = 0; }
    group.push(block); tokens += n;
  }
  if (group.length) groups.push(group);
  emit({ text: `Writing ${groups.length} epic timeline sections…` });
  const drafts = await mapLimit(groups, 3, (items, i) => runPi(items.join('\n\n'),
    EPIC_PROMPT(focus) + ` This is chronological evidence group ${i + 1} of ${groups.length}.`));
  const merged = drafts.map((text, i) => `=== TIMELINE DRAFT ${i + 1}/${drafts.length} ===\n${text}`).join('\n\n');
  if (estimateInputTokens(merged) > budget) throw new Error('Epic timeline drafts remain too large. Split this epic into smaller epics.');
  return runPi(merged,
    EPIC_PROMPT(focus) + ' The attached file contains chronological partial timeline drafts. Merge them into one timeline and preserve exact session ids.');
}

// Absolute path of the original transcript behind an index key ("source:relPath").
function absPathForKey(key) {
  const i = key.indexOf(':');
  const base = SOURCES[key.slice(0, i)];
  return base ? path.join(base, key.slice(i + 1)) : null;
}

function renderEpicMarkdown(epic, story, sessions) {
  const first = sessions[0] && sessions[0].firstTs;
  const last = sessions[sessions.length - 1] && sessions[sessions.length - 1].lastTs;
  const parts = [
    `# ${epic.title}`, '',
    `**Abstract.** ${story.abstract || ''}`, '',
    `- **Date:** ${first || '?'} → ${last || '?'}`,
    `- **Conversations:** ${sessions.length}`,
    `- **Epic:** ${epic.id}`,
    `- **This file:** \`${epicPathFor(epic.id)}\``,
    `- **Evidence inputs for the last build:** \`${epicInputsPathFor(epic.id)}\``,
    `- **Open in aiconvo:** <http://localhost:${PORT}/>`, '',
    'Each session id below maps to full file paths in the "Source conversations" section. ' +
    'To learn more about a session, read its distilled note first, then its original transcript.', '',
    '## Timeline', '',
  ];
  for (const chapter of story.chapters || []) {
    parts.push(`### ${oneLine(chapter.date, '?')} — ${oneLine(chapter.title, 'Phase')}`, '');
    if (chapter.narrative) parts.push(String(chapter.narrative).trim(), '');
    if (chapter.outcome) parts.push(`**Outcome:** ${String(chapter.outcome).trim()}`, '');
    const ids = (chapter.sessionIds || []).filter(id => epic.sessionIds.includes(id));
    if (ids.length) parts.push(`**Sessions:** ${ids.map(id => `\`${id}\``).join(', ')}`, '');
  }
  if (story.currentState) parts.push('## Current state', '', String(story.currentState).trim(), '');
  if (story.openQuestions && story.openQuestions.length) {
    parts.push('## Open questions', '', ...story.openQuestions.map(q => `- ${q}`), '');
  }
  parts.push('## Source conversations', '');
  for (const s of sessions) {
    const notePath = (index[s.key] && index[s.key].notePath) || s.notePath || null;
    parts.push(
      `### ${String(s.firstTs || '?').slice(0, 10)} — ${oneLine(s.title, '(untitled)')}`, '',
      `- **Session id:** \`${s.key}\``,
      `- **Project directory:** \`${s.cwd || '?'}\``,
      `- **Original transcript (raw JSONL, full record):** \`${absPathForKey(s.key) || '?'}\``,
      `- **Extracted conversation (JSON, user/assistant text only):** \`${cachePathFor(s.key)}\``,
      `- **Distilled note (markdown):** ${notePath ? `\`${notePath}\`` : '(none yet)'}`,
      `- **Open in aiconvo:** <http://localhost:${PORT}/#${encodeURIComponent(s.key)}>`, ''
    );
  }
  return parts.join('\n');
}

async function buildEpic(ids, epicId = null, focus = '', assignedId = null, emit = () => {}) {
  const old = epicId && epics[epicId];
  if (epicId && !old) throw new Error('epic not found');
  emit({ text: 'Reading selected conversations…', done: 0, total: 0 });
  const sessionIds = [...new Set([...(old ? old.sessionIds : []), ...ids])].filter(id => index[id]);
  if (sessionIds.length < 2) throw new Error('select at least two conversations');
  const sessions = [];
  for (const key of sessionIds) {
    try { sessions.push(JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'))); } catch {}
  }
  sessions.sort((a, b) => (a.firstTs || '').localeCompare(b.firstTs || ''));
  if (sessions.length < 2) throw new Error('could not read enough conversations');
  let evidenceDone = 0;
  emit({ text: 'Preparing conversation evidence…', done: 0, total: sessions.length + 1 });
  const evidenceInputs = await mapLimit(sessions, 3, async s => {
    const evidence = await epicEvidenceFor(s, detail => {
      if (detail.phase === 'section') {
        emit({ text: `Large conversation: section ${detail.section}/${detail.sections} · evidence ${evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
      } else if (detail.phase === 'rollup') {
        emit({ text: `Merging large conversation sections · evidence ${evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
      } else if (detail.phase === 'retry-split') {
        emit({ text: `Model requested smaller input; retrying ${detail.sections} sections · evidence ${evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
      }
    });
    emit({ text: `Preparing evidence ${++evidenceDone}/${sessions.length}…`, done: evidenceDone, total: sessions.length + 1 });
    return {
      key: s.key, title: s.title, cwd: s.cwd, firstTs: s.firstTs, lastTs: s.lastTs,
      source: evidence.source, kind: evidence.kind, outdated: evidence.outdated,
      notePath: evidence.notePath || null, hash: evidence.hash || null, text: evidence.text,
    };
  });
  emit({ text: 'Writing the cross-session timeline…', done: sessions.length, total: sessions.length + 1 });
  const raw = await buildEpicStory(evidenceInputs, focus || (old && old.title) || '', progress =>
    emit({ ...progress, done: sessions.length, total: sessions.length + 1 }));
  const story = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(story.chapters) || !story.chapters.length) throw new Error('the epic narrative had no timeline');
  const id = (old && old.id) || assignedId || crypto.randomUUID();
  const now = Date.now();
  const epic = {
    id,
    title: oneLine(focus || story.title, old ? old.title : 'Untitled epic').slice(0, 70),
    abstract: oneLine(story.abstract, ''),
    sessionIds: sessions.map(s => s.key),
    firstTs: sessions[0].firstTs || null,
    lastTs: sessions[sessions.length - 1].lastTs || null,
    createdAt: old ? old.createdAt : now,
    updatedAt: now,
    notePath: epicPathFor(id),
  };
  const text = renderEpicMarkdown(epic, story, sessions);
  await fsp.writeFile(epic.notePath, text);
  await fsp.writeFile(epicInputsPathFor(id), JSON.stringify({ epicId: id, builtAt: now, inputs: evidenceInputs }));
  epics[id] = epic;
  saveEpics();
  emit({ text: 'Epic saved.', done: sessions.length + 1, total: sessions.length + 1 });
  return { ...epic, text, sessions: sessions.map(s => ({ key: s.key, title: s.title, firstTs: s.firstTs, cwd: s.cwd })) };
}

async function epicResponse(epic) {
  const sessions = epic.sessionIds.filter(id => index[id]).map(id => ({ key: id, ...index[id] }));
  return { ...epic, text: await fsp.readFile(epic.notePath, 'utf8'), sessions };
}

async function epicEvidenceResponse(epic) {
  let saved = null;
  try { saved = JSON.parse(await fsp.readFile(epicInputsPathFor(epic.id), 'utf8')); } catch {}
  const byKey = new Map((saved && saved.inputs || []).map(e => [e.key, e]));
  const inputs = [];
  for (const key of epic.sessionIds) {
    const entry = index[key];
    const old = byKey.get(key);
    if (!entry) {
      if (old) inputs.push({ ...old, status: 'conversation-missing' });
      continue;
    }
    if (old) {
      let outdated = !!old.outdated;
      if (old.kind === 'note') outdated = !!(entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt);
      inputs.push({ ...old, outdated, status: outdated ? 'possibly-outdated-note' : old.source });
      continue;
    }
    const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
    const evidence = await epicEvidenceFor(data);
    inputs.push({
      key, title: data.title, cwd: data.cwd, firstTs: data.firstTs, lastTs: data.lastTs,
      source: evidence.source, kind: evidence.kind, outdated: evidence.outdated,
      notePath: evidence.notePath || null, hash: evidence.hash || null, text: evidence.text,
      status: evidence.outdated ? 'possibly-outdated-note' : evidence.source,
    });
  }
  return {
    epicId: epic.id, title: epic.title, builtAt: saved && saved.builtAt || null,
    reconstructed: !saved, inputs,
  };
}

// Background jobs survive browser navigation. Finished jobs stay visible for one hour.
const distillJobs = new Map(); // key -> job
const evidenceJobs = new Map(); // batch id -> job
const epicJobs = new Map();    // epic id -> job

function jobView(job) {
  return {
    id: job.id, type: job.type, key: job.key || null, epicId: job.epicId || null,
    title: job.title, status: job.status, statusText: job.statusText,
    done: job.done || 0, total: job.total || 0,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null,
    result: job.result || null, error: job.error || null,
  };
}

function jobChanged(job) {
  job.updatedAt = Date.now();
  broadcast({ type: 'job', job: jobView(job) });
}

function allJobs() {
  return [...distillJobs.values(), ...evidenceJobs.values(), ...epicJobs.values()]
    .map(jobView).sort((a, b) => b.startedAt - a.startedAt);
}

function startDistillJob(key, data) {
  const job = {
    id: 'distill:' + key, type: 'distill', key, title: data.title || key,
    events: [], listeners: new Set(), finished: false, status: 'running',
    statusText: 'Starting distillation…', done: 0, total: 0, startedAt: Date.now(),
  };
  distillJobs.set(key, job);
  const emit = ev => {
    job.events.push(ev);
    if (ev.type === 'status') job.statusText = ev.text;
    else if (ev.type === 'tree') { job.total = ev.total || 0; job.statusText = 'Distilling problems…'; }
    else if (ev.type === 'leaf-done') { job.done = ev.done || job.done; job.total = ev.total || job.total; }
    else if (ev.type === 'saved') { job.status = 'done'; job.statusText = 'Note saved.'; job.result = { notePath: ev.notePath }; }
    else if (ev.type === 'error') { job.status = 'error'; job.statusText = ev.error; job.error = ev.error; }
    jobChanged(job);
    for (const fn of job.listeners) fn(ev);
  };
  (async () => {
    try {
      const { note } = await distill(data, emit);
      emit({ type: 'status', text: 'Titling and saving…' });
      let title = null, abstract = null;
      try {
        const raw = await runPi(note, TITLE_PROMPT);
        const j = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
        title = j.title; abstract = j.abstract;
      } catch {}
      const lines = note.split('\n');
      if (title) lines[0] = `# ${title}`;
      if (abstract) {
        const at = lines.findIndex(l => l.startsWith('## '));
        lines.splice(at >= 0 ? at : lines.length, 0, `**Abstract.** ${abstract}`, '');
      }
      const finalNote = lines.join('\n');
      await fsp.mkdir(NOTES_DIR, { recursive: true });
      // Re-distills update the existing file in place — no orphaned notes.
      const file = (index[key] && index[key].notePath) || noteFileFor(data, title);
      await fsp.writeFile(file, finalNote);
      if (index[key]) { index[key].notePath = file; index[key].notedAt = Date.now(); saveIndexSoon(); }
      broadcast({ type: 'update', key, ...index[key] });
      emit({ type: 'saved', notePath: file, title: title || data.title });
    } catch (e) {
      emit({ type: 'error', error: e.message });
    } finally {
      job.finished = true;
      job.finishedAt = Date.now();
      jobChanged(job);
      setTimeout(() => { if (distillJobs.get(key) === job) distillJobs.delete(key); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

function startEvidenceJob(ids, force = false) {
  const sessionIds = [...new Set(ids)].filter(id => index[id]);
  if (!sessionIds.length) throw new Error('select at least one conversation');
  const id = crypto.randomUUID();
  const job = {
    id: 'evidence:' + id, type: 'evidence', key: sessionIds.length === 1 ? sessionIds[0] : null,
    title: `${sessionIds.length} evidence card${sessionIds.length === 1 ? '' : 's'}`,
    status: 'running', statusText: 'Reading conversations…', done: 0, total: sessionIds.length,
    startedAt: Date.now(), finished: false, sessionIds,
  };
  evidenceJobs.set(id, job);
  jobChanged(job);
  (async () => {
    try {
      const sessions = [];
      for (const key of sessionIds) {
        try { sessions.push(JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'))); } catch {}
      }
      let done = 0, created = 0, reused = 0, notes = 0;
      await mapLimit(sessions, 3, async data => {
        const evidence = await epicEvidenceFor(data, detail => {
          if (detail.phase === 'section') job.statusText = `Large conversation: section ${detail.section}/${detail.sections}…`;
          else if (detail.phase === 'rollup') job.statusText = 'Merging large conversation sections…';
          else if (detail.phase === 'retry-split') job.statusText = `Retrying ${detail.sections} smaller sections…`;
          jobChanged(job);
        }, force);
        if (evidence.kind === 'note') notes++;
        else if (evidence.created) created++;
        else reused++;
        job.done = ++done;
        job.statusText = `Preparing evidence ${done}/${sessions.length}…`;
        jobChanged(job);
      });
      job.status = 'done';
      job.statusText = `Evidence ready: ${created} new, ${reused} cached, ${notes} notes.`;
      job.result = { sessionIds, created, reused, notes };
    } catch (e) {
      job.status = 'error'; job.statusText = e.message; job.error = e.message;
    } finally {
      job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
      setTimeout(() => { if (evidenceJobs.get(id) === job) evidenceJobs.delete(id); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

function startEpicJob(ids, epicId, focus) {
  const id = epicId || crypto.randomUUID();
  const running = epicJobs.get(id);
  if (running && !running.finished) return running;
  const job = {
    id: 'epic:' + id, type: 'epic', epicId: id,
    title: focus || (epics[id] && epics[id].title) || 'New epic',
    status: 'running', statusText: 'Starting epic…', done: 0, total: 0,
    startedAt: Date.now(), finished: false,
  };
  epicJobs.set(id, job);
  jobChanged(job);
  (async () => {
    try {
      const result = await buildEpic(ids, epicId, focus, id, progress => {
        job.statusText = progress.text;
        job.done = progress.done;
        job.total = progress.total;
        jobChanged(job);
      });
      job.title = result.title;
      job.status = 'done';
      job.statusText = 'Epic saved.';
      job.result = { epicId: result.id, notePath: result.notePath };
    } catch (e) {
      job.status = 'error';
      job.statusText = e.message;
      job.error = e.message;
    } finally {
      job.finished = true;
      job.finishedAt = Date.now();
      jobChanged(job);
      setTimeout(() => { if (epicJobs.get(id) === job) epicJobs.delete(id); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

// ---------- Herdr agents ----------
const HERDR_BIN = process.env.HERDR_BIN || path.join(os.homedir(), '.local', 'bin', 'herdr');

function runHerdr(args, timeout = 10000, parseJson = true) {
  return new Promise((resolve, reject) => {
    execFile(HERDR_BIN, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout || stderr); } catch {}
      if (err) {
        const detail = parsed && parsed.error && parsed.error.message;
        reject(new Error(detail || String(stderr || stdout || err.message).trim()));
      } else {
        resolve(parseJson ? parsed : String(stdout).trim());
      }
    });
  });
}

// Direct socket API: one JSON-line request per connection, ~100ms server tick.
// Much faster than spawning the CLI, and requests run concurrently.
const HERDR_SOCK = process.env.HERDR_SOCK || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');

function herdrApi(method, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(HERDR_SOCK);
    let buf = '', done = false;
    const timer = setTimeout(() => fail(new Error('herdr socket timeout: ' + method)), timeout);
    const fail = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(error);
    };
    sock.on('connect', () => sock.write(JSON.stringify({ id: 'aiconvo', method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0 || done) return;
      done = true;
      clearTimeout(timer);
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, i));
        if (msg.error) reject(new Error(msg.error.message || msg.error.code));
        else resolve(msg.result);
      } catch (error) { reject(error); }
    });
    sock.on('error', fail);
  });
}

async function herdrAgents() {
  let result;
  try { result = await herdrApi('agent.list'); }
  catch { result = (await runHerdr(['agent', 'list'])).result; }
  return (result && result.agents || []).map(agent => ({
    ...agent,
    target: agent.name || agent.pane_id,
  }));
}

function herdrConversationName(key) {
  return 'aiconvo-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function herdrConversationInfo(key) {
  const entry = index[key];
  if (!entry) throw new Error('Conversation not found.');
  const kind = entry.source === 'claude' ? 'claude'
    : entry.source === 'pi' || entry.source === 'pi-remote' ? 'pi' : null;
  if (!kind) throw new Error('This conversation source cannot open in Herdr.');
  const relPath = key.slice(entry.source.length + 1);
  const sessionPath = path.resolve(SOURCES[entry.source], relPath);
  const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir();
  return {
    key, entry, kind, cwd, sessionPath, relPath, source: entry.source,
    name: herdrConversationName(key),
    sessionId: entry.sessionId || null,
  };
}

// Find the index key for a Herdr agent: by aiconvo name, session id, or session path.
function matchHerdrAgentToKey(agent) {
  for (const [key, e] of Object.entries(index)) {
    const kind = e.source === 'claude' ? 'claude'
      : e.source === 'pi' || e.source === 'pi-remote' ? 'pi' : null;
    if (!kind || agent.agent !== kind) continue;
    if (agent.name && agent.name === herdrConversationName(key)) return key;
    const value = agent.agent_session && agent.agent_session.value;
    if (!value) continue;
    if (e.sessionId && value === e.sessionId) return key;
    if (agent.agent_session.kind === 'path') {
      const relPath = key.slice(e.source.length + 1);
      try { if (path.resolve(SOURCES[e.source], relPath) === path.resolve(value)) return key; } catch {}
    }
  }
  return null;
}

function agentMatchesConversation(agent, info) {
  if (agent.name === info.name) return true;
  if (agent.agent !== info.kind || !agent.agent_session) return false;
  const value = agent.agent_session.value;
  if (info.sessionId && value === info.sessionId) return true;
  return agent.agent_session.kind === 'path' && path.resolve(value) === info.sessionPath;
}

// ---------- agent file diffs ----------
// Extract intended file changes from edit/write tool calls. These are agent
// file touches, not Git diffs: a tool call can fail and files can change later.
const DIFF_CACHE_FILE = path.join(CACHE_DIR, 'diff-cache.json');
let diffCache = {};
try { diffCache = JSON.parse(fs.readFileSync(DIFF_CACHE_FILE, 'utf8')); } catch {}
function saveDiffCacheSoon() {
  clearTimeout(saveDiffCacheSoon.t);
  saveDiffCacheSoon.t = setTimeout(() => fs.writeFile(DIFF_CACHE_FILE, JSON.stringify(diffCache), () => {}), 500);
}

function diffEventHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function lineCount(text) { return text ? String(text).split('\n').length : 0; }
function makeDiffEvent(key, entry, pathValue, kind, oldText, newText, ts, editIndex) {
  if (!pathValue) return null;
  // pi often records relative paths; resolve them against the session cwd so
  // grouping and disk reads work across conversations.
  if (!path.isAbsolute(String(pathValue)) && entry.cwd) pathValue = path.resolve(entry.cwd, String(pathValue));
  const oldLines = lineCount(oldText), newLines = lineCount(newText);
  const relativePath = entry.cwd && String(pathValue).startsWith(entry.cwd + '/')
    ? String(pathValue).slice(entry.cwd.length + 1)
    : path.basename(String(pathValue));
  const id = diffEventHash([key, pathValue, kind, ts, editIndex, oldText, newText]);
  return {
    id, key, source: entry.source || 'claude', project: projectOfEntry(entry),
    path: String(pathValue), relativePath, ts: ts || null, kind,
    conversationTitle: entry.timelineTitle || entry.title || key,
    agent: entry.source === 'claude' ? 'claude' : 'pi',
    oldText: oldText || null, newText: newText || null, editIndex,
    stats: {
      oldChars: oldText ? oldText.length : 0,
      newChars: newText ? newText.length : 0,
      oldLines, newLines,
    },
  };
}

function diffEventsFromContent(key, entry, name, input, ts) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const lower = String(name || '').toLowerCase();
  const pathValue = input.file_path || input.path || input.notebook_path || null;
  if (!pathValue) return out;
  if (lower === 'write') out.push(makeDiffEvent(key, entry, pathValue, 'write', null, input.content || '', ts, 0));
  else if (Array.isArray(input.edits)) {
    input.edits.forEach((edit, i) => out.push(makeDiffEvent(key, entry, pathValue, 'multi-edit', edit.oldText || edit.old_string || '', edit.newText || edit.new_string || '', ts, i)));
  } else if (lower === 'edit' || lower === 'multiedit') {
    out.push(makeDiffEvent(key, entry, pathValue, lower === 'multiedit' ? 'multi-edit' : 'edit', input.oldText || input.old_string || '', input.newText || input.new_string || '', ts, 0));
  }
  return out.filter(Boolean);
}

async function conversationDiffs(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const cacheKey = 'v2:' + String(entry.mtimeMs || 0) + ':' + String(entry.size || 0);
  const cached = diffCache[key];
  if (cached && cached.cacheKey === cacheKey) return cached.events;
  const raw = await fsp.readFile(absPathForKey(key), 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (entry.source === 'claude') {
      if (d.type !== 'assistant' || d.isSidechain || d.isMeta) continue;
      for (const b of (d.message && d.message.content) || []) {
        if (!b || b.type !== 'tool_use') continue;
        events.push(...diffEventsFromContent(key, entry, b.name, b.input, d.timestamp));
      }
    } else {
      if (d.type !== 'message' || !d.message || d.message.role !== 'assistant') continue;
      for (const b of d.message.content || []) {
        if (!b || b.type !== 'toolCall') continue;
        events.push(...diffEventsFromContent(key, entry, b.name, b.arguments, d.timestamp));
      }
    }
  }
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.path.localeCompare(b.path) || a.editIndex - b.editIndex);
  diffCache[key] = { cacheKey, events, createdAt: Date.now() };
  saveDiffCacheSoon();
  return events;
}

async function projectDiffResponse(project, includeFull = false) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const all = [];
  const fileHashes = new Map();
  // Recent conversations cover the useful audit surface without making the
  // initial project timeline expensive. The count is explicit in the response.
  const candidates = [...meta.entries]
    .sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''))
    .slice(0, 40);
  for (const { key } of candidates) {
    try { all.push(...await conversationDiffs(key)); } catch {}
  }
  const files = new Map();
  for (const event of all) {
    fileHashes.set(event.id, event);
    let row = files.get(event.path);
    if (!row) {
      row = { path: event.path, relativePath: event.relativePath, count: 0, latestTs: null, events: [] };
      files.set(event.path, row);
    }
    row.count++;
    if (!row.latestTs || String(event.ts || '') > String(row.latestTs)) row.latestTs = event.ts;
    row.events.push(includeFull ? event : {
      id: event.id, key: event.key, ts: event.ts, kind: event.kind, stats: event.stats,
      conversationTitle: event.conversationTitle, agent: event.agent, project: event.project,
      relativePath: event.relativePath,
    });
  }
  const rows = [...files.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')));
  const projectDiffEvents = projectDiffEventsFor(project);
  projectDiffEvents.set(Date.now(), { at: Date.now(), events: [...fileHashes.values()] });
  return { project, cwd: meta.cwd, scanned: candidates.length, totalConversations: meta.entries.length, files: rows };
}

// Replay recorded edit/write events to attribute each current line to the
// latest agent touch. Exact-string application; divergent edits are skipped.
function applyBlameLines(events) {
  let lines = [];
  let skipped = 0;
  const sorted = [...events].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.editIndex - b.editIndex);
  for (const e of sorted) {
    if (e.kind === 'write') {
      lines = String(e.newText || '').split('\n').map(text => ({ text, event: e }));
      continue;
    }
    const oldText = e.oldText || '';
    if (!oldText) { skipped++; continue; }
    const text = lines.map(l => l.text).join('\n');
    const at = text.indexOf(oldText);
    if (at < 0) { skipped++; continue; }
    const startLine = text.slice(0, at).split('\n').length - 1;
    const oldLineCount = oldText.split('\n').length;
    const newLines = String(e.newText || '').split('\n').map(t => ({ text: t, event: e }));
    lines.splice(startLine, oldLineCount, ...newLines);
  }
  return { lines, skipped };
}

function matchesDiffPath(event, pathValue) {
  return event.path === pathValue || event.path.endsWith('/' + pathValue) || event.relativePath === pathValue;
}

async function fileBlameResponse(pathValue, project = '', key = '') {
  let events = [];
  let scanned = 0;
  if (key && index[key]) {
    scanned = 1;
    events = (await conversationDiffs(key)).filter(e => matchesDiffPath(e, pathValue));
  } else {
    const meta = project ? projectMetaFor(project) : null;
    const candidates = meta
      ? [...meta.entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || '')).slice(0, 60)
      : Object.entries(index).sort((a, b) => String(b[1].lastTs || '').localeCompare(String(a[1].lastTs || ''))).slice(0, 60).map(([k, entry]) => ({ key: k, entry }));
    scanned = candidates.length;
    for (const { key: k } of candidates) {
      try { events.push(...(await conversationDiffs(k)).filter(e => matchesDiffPath(e, pathValue))); } catch {}
    }
  }
  if (!events.length) throw new Error('no recorded edits for this file');
  const { lines, skipped } = applyBlameLines(events);
  const fullPath = events[0].path;
  let matchesDisk = null, diskLines = null;
  try {
    const disk = await fsp.readFile(fullPath, 'utf8');
    diskLines = disk.split('\n').length;
    matchesDisk = disk === lines.map(l => l.text).join('\n');
  } catch {}
  return {
    path: fullPath, project: project || events[0].project || null,
    lines: lines.map((l, i) => ({
      n: i + 1, text: l.text,
      event: l.event ? { id: l.event.id, ts: l.event.ts, agent: l.event.agent, kind: l.event.kind, conversationTitle: l.event.conversationTitle, key: l.event.key } : null,
    })),
    events: events.length, applied: events.length - skipped, skipped, matchesDisk, diskLines, scanned,
  };
}

const projectDiffEventsByName = new Map();
function projectDiffEventsFor(project) {
  if (!projectDiffEventsByName.has(project)) projectDiffEventsByName.set(project, new Map());
  return projectDiffEventsByName.get(project);
}

async function findDiffEvent(id, project = '', key = '') {
  if (project) {
    const versions = [...(projectDiffEventsFor(project).values() || [])].sort((a, b) => b.at - a.at);
    for (const version of versions) {
      const event = version.events.find(item => item.id === id);
      if (event) return event;
    }
  }
  if (key && index[key]) {
    try {
      const event = (await conversationDiffs(key)).find(item => item.id === id);
      if (event) return event;
    } catch {}
    return null;
  }
  for (const cachedKey of Object.keys(diffCache)) {
    const event = (diffCache[cachedKey].events || []).find(item => item.id === id);
    if (event) return event;
  }
  return null;
}

// ---------- project overview ----------
function projectOfEntry(entry) {
  const cwd = String(entry && entry.cwd || '?').replace(/\\/g, '/').replace(/\/$/, '');
  const inProjects = cwd.match(/\/Projects\/([^/]+)/);
  if (inProjects) return inProjects[1];
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || '?';
}

function projectMetaFor(project) {
  const entries = Object.entries(index)
    .filter(([key, entry]) => key && entry && projectOfEntry(entry) === project)
    .map(([key, entry]) => ({ key, entry }));
  if (!entries.length) return null;
  const cwds = [...new Set(entries.map(({ entry }) => entry.cwd).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const cwd = cwds[0] || null;
  const epicsForProject = Object.values(epics)
    .map(epic => ({
      id: epic.id, title: epic.title, abstract: epic.abstract || '',
      updatedAt: epic.updatedAt || 0, notePath: epic.notePath || null,
      sessionIds: (epic.sessionIds || []).filter(id => index[id] && projectOfEntry(index[id]) === project),
    }))
    .filter(epic => epic.sessionIds.length)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const latestMs = entries.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
  return { project, cwd, entries, epics: epicsForProject, latestMs };
}

async function projectResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const { cwd, entries, epics: projectEpics, latestMs } = meta;
  const now = Date.now();
  let notes = 0, freshNotes = 0, evidenceCards = 0, freshEvidence = 0;
  const recent = [];
  const sorted = [...entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''));
  for (const { key, entry } of sorted) {
    let data = null;
    try { data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); } catch {}
    const notedAt = entry.notedAt || 0;
    const noteState = entry.notePath ? (entry.mtimeMs && notedAt && entry.mtimeMs > notedAt ? 'stale' : 'fresh') : 'missing';
    if (entry.notePath) { notes++; if (noteState === 'fresh') freshNotes++; }
    let evidenceState = 'missing';
    if (data) {
      if (data.notePath || entry.notePath) evidenceState = noteState;
      else {
        const h = epicEvidenceHash(data);
        if (h in epicEvidenceCache) evidenceState = 'fresh';
        else if (latestCachedEvidenceForKey(key)) evidenceState = 'stale';
      }
    }
    if (evidenceState !== 'missing') { evidenceCards++; if (evidenceState === 'fresh') freshEvidence++; }
    if (recent.length < 12) {
      recent.push({
        key, title: entry.timelineTitle || entry.title || key, source: entry.source || 'claude',
        cwd: entry.cwd || null, lastTs: entry.lastTs || null, active: !!(entry.mtimeMs && now - entry.mtimeMs < 5 * 60 * 1000),
        notePath: entry.notePath || null, note: noteState, evidence: evidenceState,
      });
    }
  }
  return {
    project, cwd, conversations: entries.length, notes, epics: projectEpics,
    latestTs: latestMs ? new Date(latestMs).toISOString() : null,
    freshness: { freshNotes, staleNotes: notes - freshNotes, freshEvidence, staleEvidence: evidenceCards - freshEvidence },
    recent,
    agents: ['pi', 'claude'],
  };
}

// The "memory to include" selection becomes a briefing FILE, not an inline
// prompt: aiconvo's provenance pattern. The briefing maps the project's work
// memory (notes, epics, evidence) to real file paths; the agent reads what it
// needs instead of receiving one giant paste.
const BRIEFINGS_DIR = path.join(CACHE_DIR, 'briefings');
fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });

async function buildProjectBriefing(project, include, focusName) {
  const info = await projectResponse(project);
  const meta = projectMetaFor(project);
  const lines = [];
  lines.push(`# aiconvo project briefing: ${project}`);
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Project root: ${info.cwd || '(unknown)'}`);
  lines.push(`- On record: ${info.conversations} conversations · ${info.notes} distilled notes (${info.freshness.freshNotes} fresh) · ${info.epics.length} epics`);
  lines.push(`- Latest activity: ${info.latestTs || '(none)'}`);
  if (focusName) lines.push(`- Focus for this new conversation: ${focusName}`);
  lines.push('');
  lines.push("This file maps the project's AI work memory. Every path below is a readable file on this machine. Read what you need; do not guess file content.");

  lines.push('', '## Recent conversations');
  for (const r of info.recent) {
    lines.push(`- ${r.lastTs ? r.lastTs.slice(0, 10) : '?'} · ${r.title}` +
      (r.notePath ? ` · note: ${r.notePath}${r.note === 'stale' ? ' (stale: the conversation grew after distillation)' : ''}` : ''));
  }

  const wantedEpics = Array.isArray(include.epics) ? include.epics.filter(id => epics[id]) : [];
  if (wantedEpics.length) {
    lines.push('', '## Epics to read (cross-session narratives)');
    for (const id of wantedEpics) {
      const epic = epics[id];
      lines.push(`### ${epic.title || id}`);
      lines.push(`- File: ${epicPathFor(id)}`);
      if (epic.abstract) lines.push(`- Abstract: ${epic.abstract}`);
    }
  } else if (info.epics.length) {
    lines.push('', '## Epics (read on demand)');
    for (const epic of info.epics.slice(0, 6)) lines.push(`- ${epic.title} · ${epicPathFor(epic.id)}`);
  }

  if (include.notes) {
    lines.push('', '## Fresh distilled notes');
    let count = 0;
    for (const { entry } of meta.entries) {
      if (!entry.notePath) continue;
      if (entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt) continue; // stale
      lines.push(`- ${entry.notePath}`);
      count++;
    }
    if (!count) lines.push('- (none yet)');
  }

  if (Array.isArray(include.evidenceKeys) && include.evidenceKeys.length) {
    lines.push('', '## Selected conversation evidence');
    for (const key of include.evidenceKeys.slice(0, 20)) {
      const entry = index[key];
      if (!entry) continue;
      lines.push(`### ${entry.timelineTitle || entry.title || key}`);
      if (entry.notePath) lines.push(`- Note: ${entry.notePath}`);
      const latest = latestCachedEvidenceForKey(key);
      if (latest && latest.cached.text) lines.push('', latest.cached.text.trim(), '');
    }
  }

  lines.push('', '## More');
  lines.push(`- Browse, search, and export everything: http://localhost:${PORT}/`);
  const file = path.join(BRIEFINGS_DIR,
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + String(project).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) + '.md');
  await fsp.writeFile(file, lines.join('\n') + '\n');
  return file;
}

async function startProjectConversation(options) {
  const meta = projectMetaFor(options.project);
  if (!meta) throw new Error('project not found');
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : os.homedir();
  const kind = options.agent === 'claude' ? 'claude' : 'pi';
  const label = String(options.name || 'Project: ' + options.project).slice(0, 80);
  const name = 'aiconvo-project-' + crypto.createHash('sha256').update(options.project + ':' + Date.now() + ':' + kind).digest('hex').slice(0, 12);
  const started = await herdrStartAgentInNewWorkspace({ cwd, label, name, kind });
  // Inject the selected memory: write the briefing, then send one kickoff
  // prompt pointing at it. A kickoff failure never kills the started agent.
  let briefing = null, kickoff = false, warning = null;
  try {
    briefing = await buildProjectBriefing(options.project, options.include || {}, options.name || '');
    const focus = options.name ? ` Today's focus: "${options.name}".` : '';
    const text = `Read ${briefing} — it maps this project's work memory (notes, epics, evidence) with full file paths. Read the files you need.${focus}` +
      ' Then reply with at most 3 lines on where the project stands, and wait for instructions.';
    const target = started.agent.target;
    // Keystrokes sent while the TUI still starts up are lost. Wait until the
    // agent settles at its prompt, then submit with a verified wait: herdr
    // must observe the agent go to work, or the submission did not land.
    // Herdr's agent detection flaps during TUI startup: the agent can report
    // idle and a moment later be "no longer the pane foreground process"
    // (agent_not_ready). Require two consecutive settled reads, then retry
    // every transient not-ready error within one time budget.
    const settleDeadline = Date.now() + 30000;
    let settledReads = 0;
    while (Date.now() < settleDeadline && settledReads < 2) {
      const list = await herdrApi('agent.list').catch(() => null);
      const a = (list && list.agents || []).find(x => (x.name || x.pane_id) === target);
      settledReads = a && (a.agent_status === 'idle' || a.agent_status === 'blocked') ? settledReads + 1 : 0;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    const TRANSIENT = /stalled|timeout|not ready|no longer the pane foreground|not an active named agent/i;
    const promptDeadline = Date.now() + 45000;
    for (;;) {
      try {
        await herdrApi('agent.prompt', { target, text, wait: { until: ['working'], timeout_ms: 8000 } }, 20000);
        break;
      } catch (error) {
        if (Date.now() < promptDeadline && TRANSIENT.test(String(error.message))) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          continue;
        }
        throw error;
      }
    }
    kickoff = true;
  } catch (error) {
    warning = 'The agent started, but the memory kickoff failed: ' + error.message;
  }
  return {
    workspaceId: started.workspaceId, paneId: started.paneId, name, kind, cwd,
    project: options.project, include: options.include || {}, briefing, kickoff, warning,
  };
}

// Create a Herdr workspace and start an agent in its root pane. Herdr is a
// tool: aiconvo owns the workspaces it creates — it waits for the shell,
// retries while the pane spins up, and closes the workspace on failure.
// agent.start on a pane whose shell is still launching returns
// agent_pane_busy ("is not an available shell"); both the readiness wait and
// the retry exist because of that race.
async function herdrStartAgentInNewWorkspace({ cwd, label, name, kind, args = [] }) {
  const created = await herdrApi('workspace.create', { cwd, label: String(label || name).slice(0, 80), focus: false });
  const workspaceId = created && created.workspace && created.workspace.workspace_id;
  const paneId = created && created.root_pane && created.root_pane.pane_id;
  if (!workspaceId || !paneId) throw new Error('Herdr did not create the workspace.');
  try {
    // Wait until the pane runs exactly its bare shell.
    const deadline = Date.now() + 15000;
    for (;;) {
      const state = await herdrApi('pane.process_info', { pane_id: paneId }).catch(() => null);
      const proc = state && state.process_info;
      if (proc && proc.foreground_processes && proc.foreground_processes.length === 1 &&
          proc.foreground_processes[0].pid === proc.shell_pid) break;
      if (Date.now() > deadline) throw new Error('The new Herdr shell did not become ready.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // The readiness check and agent.start can still race; retry on busy.
    let started;
    for (let attempt = 0; ; attempt++) {
      try {
        started = await herdrApi('agent.start', { name, kind, pane_id: paneId, args, timeout_ms: 120000 }, 130000);
        break;
      } catch (error) {
        if (attempt < 20 && /not an available shell/.test(String(error.message))) {
          await new Promise(resolve => setTimeout(resolve, 300));
          continue;
        }
        throw error;
      }
    }
    const agent = started && started.agent;
    if (!agent) throw new Error('Herdr did not return the started agent.');
    return { workspaceId, paneId, agent: { ...agent, target: agent.name || agent.pane_id } };
  } catch (error) {
    await herdrApi('workspace.close', { workspace_id: workspaceId }).catch(() => {});
    throw error;
  }
}

async function openHerdrConversation(key) {
  const info = herdrConversationInfo(key);
  let agent = (await herdrAgents()).find(item => agentMatchesConversation(item, info));
  if (agent) return { agent, created: false };

  const resumeArgs = info.kind === 'claude'
    ? ['--resume', info.sessionId]
    : ['--session', info.sessionPath];
  if (!resumeArgs[1]) throw new Error('This conversation has no session identifier.');
  try {
    const started = await herdrStartAgentInNewWorkspace({
      cwd: info.cwd,
      label: info.entry.timelineTitle || info.entry.title || info.kind,
      name: info.name, kind: info.kind, args: resumeArgs,
    });
    return { agent: started.agent, created: true };
  } catch (error) {
    // A concurrent request can win the start race. Use that agent instead.
    agent = (await herdrAgents()).find(item => agentMatchesConversation(item, info));
    if (agent) return { agent, created: false };
    throw error;
  }
}

// Resolve the live Herdr agent behind a terminal id. A conversation key opens
// (or resumes) that conversation's agent. An "agent:<target>" id binds to a
// running agent directly — e.g. a fresh project conversation whose session
// file does not exist yet, so no conversation key can reach it.
async function terminalAgentFor(id) {
  if (String(id || '').startsWith('agent:')) {
    const target = String(id).slice(6);
    const agent = (await herdrAgents()).find(a => a.target === target || a.name === target || a.pane_id === target);
    if (!agent) throw new Error('Herdr agent ' + target + ' is not running.');
    return { agent, created: false };
  }
  return openHerdrConversationOnce(id);
}

const herdrConversationStarts = new Map();
function openHerdrConversationOnce(key) {
  if (!herdrConversationStarts.has(key)) {
    const pending = openHerdrConversation(key)
      .finally(() => herdrConversationStarts.delete(key));
    herdrConversationStarts.set(key, pending);
  }
  return herdrConversationStarts.get(key);
}

async function readHerdrAgent(target, lines = 180) {
  // Socket enum is recent_unwrapped (the CLI flag is recent-unwrapped); the
  // wrong value made this call silently fall back to the CLI on every read.
  const result = await herdrApi('agent.read', {
    target, source: 'recent_unwrapped', lines, format: 'text', strip_ansi: true,
  }).catch(() => null);
  if (result && result.read) return result.read.text;
  return runHerdr([
    'agent', 'read', target, '--source', 'recent-unwrapped',
    '--lines', String(lines), '--format', 'text',
  ], 10000, false);
}

function herdrLiveTail(before, current) {
  if (!before) return current.slice(-24000);
  if (current.startsWith(before)) return current.slice(before.length).trimStart().slice(-24000);
  const beforeLines = before.split('\n');
  const currentLines = current.split('\n');
  // The fixed-size terminal snapshot shifts as new rows arrive. Find the old
  // snapshot suffix at the start of the new snapshot, then keep only new rows.
  let overlap = 0;
  const max = Math.min(beforeLines.length, currentLines.length);
  for (let size = max; size > 0; size--) {
    let same = true;
    for (let i = 0; i < size; i++) {
      if (beforeLines[beforeLines.length - size + i] !== currentLines[i]) { same = false; break; }
    }
    if (same) { overlap = size; break; }
  }
  return currentLines.slice(overlap).join('\n').trimStart().slice(-24000);
}

const herdrRuns = new Map();

async function refreshConversationIndex(key) {
  const info = herdrConversationInfo(key);
  try {
    const stat = await fsp.stat(info.sessionPath);
    await indexFile(info.source, info.relPath, stat);
  } catch (error) {
    console.error('Herdr conversation refresh failed:', key, error.message);
  }
}

// ---------- HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/') {
      // no-store: without it the browser heuristically caches this page and
      // can keep serving a stale app.html after the file changes on disk.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await fsp.readFile(path.join(__dirname, 'app.html')));
    } else if (u.pathname === '/api/sessions') {
      const list = Object.entries(index).map(([key, e]) => ({ key, ...e }));
      list.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
      json(res, 200, list);
    } else if (u.pathname === '/api/session') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(await fsp.readFile(cachePathFor(key)));
    } else if (u.pathname === '/api/here') {
      // "Where was I?" — the most recent session whose cwd is (or contains) dir.
      const dir = u.searchParams.get('dir') || '';
      const hits = Object.entries(index)
        .filter(([, e]) => e.cwd && (e.cwd === dir || e.cwd.startsWith(dir + '/')))
        .sort((a, b) => (b[1].lastTs || '').localeCompare(a[1].lastTs || ''));
      if (!hits.length) return json(res, 404, { error: 'no sessions for this directory' });
      const [key, entry] = hits[0];
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      const chat = data.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const lastUserIdx = chat.map(m => m.role).lastIndexOf('user');
      json(res, 200, {
        key, ...entry,
        sessionCount: hits.length,
        lastExchange: chat.slice(Math.max(0, lastUserIdx)),
      });
    } else if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      if (q.length < 2) return json(res, 200, []);
      json(res, 200, await search(q));
    } else if (u.pathname === '/api/related') {
      const key = u.searchParams.get('id');
      const entry = index[key];
      if (!entry) return json(res, 404, { error: 'not found' });
      const relatedEpics = Object.values(epics)
        .filter(epic => epic.sessionIds.includes(key))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(epic => ({
          id: epic.id, title: epic.title, abstract: epic.abstract,
          updatedAt: epic.updatedAt, hasSavedEvidence: fs.existsSync(epicInputsPathFor(epic.id)),
        }));
      json(res, 200, {
        key, title: entry.title, notePath: entry.notePath || null,
        epics: relatedEpics,
      });
    } else if (u.pathname === '/api/project') {
      const project = u.searchParams.get('name') || '';
      try { json(res, 200, await projectResponse(project)); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/diffs') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, { key, ...(index[key] || {}), events: await conversationDiffs(key) }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/project/diffs') {
      const project = u.searchParams.get('name') || '';
      try { json(res, 200, await projectDiffResponse(project, u.searchParams.get('include') === 'full')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/file/blame') {
      const pathValue = u.searchParams.get('path') || '';
      if (!pathValue) return json(res, 400, { error: 'missing path' });
      try { json(res, 200, await fileBlameResponse(pathValue, u.searchParams.get('project') || '', u.searchParams.get('key') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/diff-event') {
      const id = u.searchParams.get('id') || '';
      const event = await findDiffEvent(id, u.searchParams.get('project') || '', u.searchParams.get('key') || '');
      if (!event) return json(res, 404, { error: 'not found' });
      json(res, 200, event);
    } else if (u.pathname === '/api/project/start' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await startProjectConversation(parsed)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/tree') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      json(res, 200, await sessionTreeFor(key));
    } else if (u.pathname === '/api/branch' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!parsed.id || !index[parsed.id]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await branchSession(parsed.id, parsed.node)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/fork' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!parsed.id || !index[parsed.id]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await forkSession(parsed.id, parsed.node)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/fork-edit' && req.method === 'POST') {
      // pi only: fork BEFORE a user message; the response carries the message
      // text so the UI can prefill the composer for edit-and-resubmit.
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!parsed.id || !index[parsed.id]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await forkSessionForEdit(parsed.id, parsed.node)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/epics') {
      const list = Object.values(epics).sort((a, b) => b.updatedAt - a.updatedAt);
      json(res, 200, list);
    } else if (u.pathname === '/api/epic') {
      const epic = epics[u.searchParams.get('id')];
      if (!epic) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await epicResponse(epic)); }
      catch { json(res, 404, { error: 'epic note missing' }); }
    } else if (u.pathname === '/api/epic/evidence') {
      const epic = epics[u.searchParams.get('id')];
      if (!epic) return json(res, 404, { error: 'not found' });
      json(res, 200, await epicEvidenceResponse(epic));
    } else if (u.pathname === '/api/epic/build' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const job = startEpicJob(parsed.ids || [], parsed.epicId || null, parsed.title || '');
      json(res, 202, jobView(job));
    } else if (u.pathname === '/api/evidence/start' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const job = startEvidenceJob(parsed.ids || [], !!parsed.force);
      json(res, 202, jobView(job));
    } else if (u.pathname === '/api/evidence') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      const evidence = await existingEvidenceFor(data, true);
      if (!evidence) return json(res, 404, { error: 'no evidence yet' });
      json(res, 200, { key, title: data.title, cwd: data.cwd, firstTs: data.firstTs, lastTs: data.lastTs, ...evidence });
    } else if (u.pathname === '/api/jobs') {
      json(res, 200, allJobs());
    } else if (u.pathname === '/api/agents/active') {
      // Active: file changed in the last 5 min. Recent: last hour.
      const nowMs = Date.now();
      const active = [], recent = [];
      for (const [key, e] of Object.entries(index)) {
        if (!e.mtimeMs) continue;
        const ageMs = nowMs - e.mtimeMs;
        const row = { key, source: e.source, title: e.timelineTitle || e.title, cwd: e.cwd, lastTs: e.lastTs, ageMs };
        if (ageMs < 5 * 60 * 1000) active.push(row);
        else if (ageMs < 60 * 60 * 1000) recent.push(row);
      }
      active.sort((a, b) => a.ageMs - b.ageMs);
      recent.sort((a, b) => a.ageMs - b.ageMs);
      // Herdr agents, matched to conversations when possible. Never fails the endpoint.
      let herdr = [];
      try {
        herdr = (await herdrAgents()).map(a => {
          const key = matchHerdrAgentToKey(a);
          return {
            name: a.name || null, agent: a.agent || null, target: a.target || null,
            status: a.agent_status || null, label: a.workspace_label || a.label || null,
            key,
            title: key ? (index[key].timelineTitle || index[key].title) : null,
            cwd: a.foreground_cwd || a.cwd || (key ? index[key].cwd : null),
          };
        });
      } catch {}
      json(res, 200, { active, recent: recent.slice(0, 15), herdr });
    } else if (u.pathname === '/api/herdr/conversation' && req.method === 'GET') {
      const key = u.searchParams.get('id');
      const info = herdrConversationInfo(key);
      const agent = (await herdrAgents()).find(item => agentMatchesConversation(item, info));
      json(res, 200, { open: Boolean(agent), agent: agent || null, kind: info.kind });
    } else if (u.pathname === '/api/herdr/conversation/prompt' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('Prompt is too large.');
      }
      const parsed = JSON.parse(body || '{}');
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
      if (!prompt) return json(res, 400, { error: 'Write a message first.' });
      const opened = await openHerdrConversationOnce(parsed.id);
      const baseline = await readHerdrAgent(opened.agent.target).catch(() => '');
      const runId = crypto.randomUUID();
      const run = {
        id: runId, key: parsed.id, target: opened.agent.target, baseline,
        startedAt: Date.now(), done: false, error: null,
      };
      // Herdr owns completion: agent.prompt submits the text and waits
      // server-side (event-driven, occupant-pinned) until the agent settles.
      // agent_prompt_stalled means Herdr saw no agent activity after submit.
      const WAIT_MS = 30 * 60 * 1000;
      run.wait = herdrApi('agent.prompt', {
        target: opened.agent.target, text: prompt,
        wait: { until: ['idle', 'done', 'blocked'], timeout_ms: WAIT_MS },
      }, WAIT_MS + 15000)
        .catch(error => {
          run.error = /agent_prompt_stalled/.test(String(error.message))
            ? new Error('Herdr saw no agent activity after the prompt. The agent may be stuck; open the terminal view.')
            : error;
        })
        .finally(() => { run.done = true; });
      herdrRuns.set(runId, run);
      setTimeout(() => herdrRuns.delete(runId), WAIT_MS);
      json(res, 202, { ok: true, runId, ...opened });
    } else if (u.pathname === '/api/herdr/conversation/stream' && req.method === 'GET') {
      const run = herdrRuns.get(u.searchParams.get('run'));
      if (!run) return json(res, 404, { error: 'Herdr stream not found.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let closed = false, reading = false;
      const send = event => {
        if (!closed) res.write('data: ' + JSON.stringify(event) + '\n\n');
      };
      const finish = async () => {
        if (closed) return;
        await new Promise(resolve => setTimeout(resolve, 700));
        await refreshConversationIndex(run.key);
        send({ type: 'complete' });
        herdrRuns.delete(run.id);
        closed = true;
        res.end();
      };
      // The poll only feeds the live output tail. Completion comes from the
      // server-side agent.prompt wait (run.done / run.error), not from status
      // heuristics.
      const poll = async () => {
        if (closed || reading) return;
        reading = true;
        try {
          const [agents, output] = await Promise.all([
            herdrAgents(),
            readHerdrAgent(run.target),
          ]);
          const agent = agents.find(item => item.target === run.target);
          const status = agent && agent.agent_status || 'unknown';
          send({ type: 'output', status, output: herdrLiveTail(run.baseline, output) });
          if (run.error) throw run.error;
          if (run.done) {
            clearInterval(timer);
            await finish();
          }
        } catch (error) {
          send({ type: 'error', error: error.message });
          clearInterval(timer);
          closed = true;
          res.end();
        } finally { reading = false; }
      };
      const timer = setInterval(poll, 250);
      send({ type: 'status', status: 'sent' });
      poll();
      req.on('close', () => { closed = true; clearInterval(timer); });
    } else if (u.pathname === '/api/herdr/terminal' && req.method === 'GET') {
      // Live terminal view of a Herdr agent. A conversation id opens or
      // resumes its agent; an "agent:<target>" id attaches to a running agent
      // directly. Streams the visible screen (ANSI) until the client closes.
      const key = u.searchParams.get('id');
      const opened = await terminalAgentFor(key);
      const target = opened.agent.target;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const paneId = opened.agent.pane_id;
      let closed = false, reading = false, lastScreen = null, status = opened.agent.agent_status || 'unknown';
      const send = event => {
        if (!closed) res.write('data: ' + JSON.stringify(event) + '\n\n');
      };
      // Screen polls and status polls run over the socket API (~100ms server
      // tick, and requests run concurrently). The screen comes from 'recent'
      // with history, so the client can scroll back through the session.
      const poll = async () => {
        if (closed || reading) return;
        reading = true;
        try {
          const read = await herdrApi('pane.read', {
            pane_id: paneId, source: 'recent', format: 'ansi', strip_ansi: false, lines: 600,
          });
          const screen = read && read.read && read.read.text || '';
          if (screen !== lastScreen) {
            lastScreen = screen;
            send({ type: 'frame', status, screen });
          }
        } catch (error) {
          send({ type: 'error', error: error.message });
          closed = true;
          clearInterval(timer);
          clearInterval(statusTimer);
          res.end();
        } finally { reading = false; }
      };
      const pollStatus = async () => {
        if (closed) return;
        try {
          const result = await herdrApi('agent.list');
          const agent = (result && result.agents || []).find(item => item.pane_id === paneId);
          const next = agent && agent.agent_status || 'unknown';
          if (next !== status) {
            status = next;
            send({ type: 'status', status });
          }
        } catch {}
      };
      const timer = setInterval(poll, 120);
      const statusTimer = setInterval(pollStatus, 1000);
      send({ type: 'open', created: opened.created, status, agent: {
        name: opened.agent.name, pane_id: paneId, agent: opened.agent.agent,
      } });
      poll();
      req.on('close', () => { closed = true; clearInterval(timer); clearInterval(statusTimer); });
    } else if (u.pathname === '/api/herdr/terminal/input' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 256 * 1024) throw new Error('Input is too large.');
      }
      const parsed = JSON.parse(body || '{}');
      let agent;
      if (String(parsed.id || '').startsWith('agent:')) {
        const target = String(parsed.id).slice(6);
        agent = (await herdrAgents()).find(a => a.target === target || a.name === target || a.pane_id === target);
      } else {
        const info = herdrConversationInfo(parsed.id);
        agent = (await herdrAgents()).find(item => agentMatchesConversation(item, info));
      }
      if (!agent) return json(res, 409, { error: 'The terminal is not open. Toggle the terminal view first.' });
      // Ordered sequence of {text} / {keys} items in one request; each item is
      // one socket call (pane.send_input), so a typing burst costs one call.
      const seq = Array.isArray(parsed.seq) ? parsed.seq
        : [{ text: parsed.text, keys: parsed.keys }];
      for (const item of seq.slice(0, 64)) {
        const payload = { pane_id: agent.pane_id };
        if (typeof item.text === 'string' && item.text.length) payload.text = item.text.slice(0, 16384);
        if (Array.isArray(item.keys) && item.keys.length) {
          const keys = item.keys.filter(k => typeof k === 'string' && /^[a-z0-9+]{1,24}$/i.test(k)).slice(0, 64);
          if (keys.length) payload.keys = keys;
        }
        if (!payload.text && !payload.keys) continue;
        await herdrApi('pane.send_input', payload);
      }
      json(res, 200, { ok: true });
    } else if (u.pathname === '/api/herdr/conversation/attach' && req.method === 'POST') {
      // Open this conversation's Herdr agent in a real terminal on the desktop.
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const opened = await openHerdrConversationOnce(parsed.id);
      const term = process.env.AICONVO_TERMINAL
        || ['/snap/bin/alacritty', '/usr/bin/alacritty', '/usr/local/bin/alacritty']
          .find(p => fs.existsSync(p))
        || 'alacritty';
      const child = require('child_process').spawn(term, [
        '-e', HERDR_BIN, 'agent', 'attach', opened.agent.target,
      ], {
        detached: true, stdio: 'ignore',
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      });
      let failed = false;
      child.on('error', () => { failed = true; });
      child.unref();
      setTimeout(() => {
        if (failed) json(res, 500, { error: 'Could not start ' + term });
        else json(res, 200, { ok: true, agent: opened.agent.target, terminal: term });
      }, 150);
    } else if (u.pathname === '/api/herdr/terminal/refresh' && req.method === 'POST') {
      // Re-index the transcript after a terminal interaction, so the chat view is fresh.
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      if (String(parsed.id || '').startsWith('agent:')) {
        // Direct agent terminal: if its session file appeared by now, the
        // agent matches a conversation — refresh that one.
        const target = String(parsed.id).slice(6);
        const agent = (await herdrAgents()).find(a => a.target === target || a.name === target || a.pane_id === target);
        const key = agent && matchHerdrAgentToKey(agent);
        if (key) await refreshConversationIndex(key);
      } else {
        await refreshConversationIndex(parsed.id);
      }
      json(res, 200, { ok: true });
    } else if (u.pathname === '/api/export' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const ids = parsed.ids || [];
      const mode = parsed.mode || 'chat';
      const sessions = [];
      for (const key of ids) {
        if (!index[key]) continue;
        try { sessions.push(JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'))); } catch {}
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="conversations.md"',
      });
      res.end(toMarkdown(sessions, mode));
    } else if (u.pathname === '/api/distill' && req.method === 'POST') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      const result = await distill(data);
      json(res, 200, result);
    } else if (u.pathname === '/api/distill/start' && req.method === 'POST') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const force = u.searchParams.get('force') === '1';
      let job = distillJobs.get(key);
      if (!job || (job.finished && (force || job.status === 'error'))) {
        const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
        job = startDistillJob(key, data);
      }
      json(res, 202, jobView(job));
    } else if (u.pathname === '/api/distill-stream') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = ev => {
        res.write('data: ' + JSON.stringify(ev) + '\n\n');
        if (ev.type === 'saved' || ev.type === 'error') res.end();
      };
      let job = distillJobs.get(key);
      const force = u.searchParams.get('force') === '1';
      if (!job || (job.finished && (force || job.events.some(e => e.type === 'error')))) {
        job = startDistillJob(key, data);
      }
      for (const ev of job.events) send(ev); // replay for reconnecting tabs
      if (!job.finished) {
        job.listeners.add(send);
        req.on('close', () => job.listeners.delete(send));
      }
    } else if (u.pathname === '/api/distill-running') {
      json(res, 200, [...distillJobs.entries()].filter(([, j]) => !j.finished).map(([k]) => k));
    } else if (u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), 30000);
      req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
    } else if (u.pathname === '/api/notes') {
      let files = [];
      try { files = (await fsp.readdir(NOTES_DIR)).filter(f => f.endsWith('.md')); } catch {}
      const out = [];
      for (const f of files) {
        try {
          const st = await fsp.stat(path.join(NOTES_DIR, f));
          out.push({ file: f, mtimeMs: st.mtimeMs });
        } catch {}
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      json(res, 200, out);
    } else if (u.pathname === '/api/notefile') {
      const f = path.basename(u.searchParams.get('f') || '');
      if (!f.endsWith('.md')) return json(res, 400, { error: 'bad name' });
      try { json(res, 200, { file: f, text: await fsp.readFile(path.join(NOTES_DIR, f), 'utf8') }); }
      catch { json(res, 404, { error: 'not found' }); }
    } else if (u.pathname === '/api/distill/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id, text } = JSON.parse(body);
      if (!id || !index[id]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(id), 'utf8'));
      await fsp.mkdir(NOTES_DIR, { recursive: true });
      const file = noteFileFor(data);
      await fsp.writeFile(file, text);
      index[id].notePath = file;
      saveIndexSoon();
      json(res, 200, { ok: true, notePath: file });
    } else if (u.pathname === '/api/note') {
      const key = u.searchParams.get('id');
      const e = index[key];
      if (!e || !e.notePath) return json(res, 404, { error: 'no note' });
      try {
        json(res, 200, { notePath: e.notePath, text: await fsp.readFile(e.notePath, 'utf8') });
      } catch { json(res, 404, { error: 'note file missing' }); }
    } else if (u.pathname === '/api/rescan' && req.method === 'POST') {
      await fullScan();
      json(res, 200, { ok: true, count: Object.keys(index).length });
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.requestTimeout = 0; // distillation can take minutes
server.headersTimeout = 60000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`aiconvo → http://localhost:${PORT}`);
  fullScan().then(watch);
});
