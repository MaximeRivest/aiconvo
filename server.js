#!/usr/bin/env node
// aiconvo — browse, search and export Claude Code conversations.
// No dependencies. Run: node server.js  → http://localhost:7433
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const net = require('net');
const { pathToFileURL } = require('url');
const { execFile, execFileSync, spawn } = require('child_process');
const { claudeForkContent, groupFamilies } = require('./sessionfork.js');
const settingsLib = require('./settings.js');
const { openSearchIndex, SearchIndex } = require('./searchindex.js');
const foldsLib = require('./projectfolds.js');
const areasLib = require('./areas.js');
const themesLib = require('./themes.js');
const fanoutLib = require('./fanout.js');
const fanoutMerge = require('./fanoutmerge.js');
const usageLib = require('./usageanalytics.js');

// Conversation sources. Keys in the index look like "claude:<relPath>".
const SOURCES = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  pi: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  'pi-remote': path.join(os.homedir(), '.pi', 'remote', 'sessions'),
};
const CACHE_DIR = path.join(os.homedir(), '.cache', 'aiconvo');
const NOTES_DIR = path.join(os.homedir(), 'notes', 'aiconvo');
const SESS_DIR = path.join(CACHE_DIR, 'sessions');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const USAGE_DB_FILE = path.join(CACHE_DIR, 'usage.db');
const INTERNAL_USAGE_FILE = path.join(CACHE_DIR, 'internal-usage.jsonl');
const PORT = process.env.PORT ? Number(process.env.PORT) : 7433;
const HOST = process.env.AICONVO_HOST || (process.env.AICONVO_LAN === '1' ? '0.0.0.0' : '127.0.0.1');
const TLS_PORT = process.env.AICONVO_TLS_PORT ? Number(process.env.AICONVO_TLS_PORT) : 7443;
const LAN_TOKEN_FILE = path.join(CACHE_DIR, 'lan-token');
function loadLanToken() {
  if (process.env.AICONVO_TOKEN) return String(process.env.AICONVO_TOKEN);
  if (HOST === '127.0.0.1' || HOST === '::1') return '';
  try {
    const existing = fs.readFileSync(LAN_TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const created = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(LAN_TOKEN_FILE, created + '\n', { mode: 0o600 });
  return created;
}
const LAN_TOKEN = loadLanToken();
function requestIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
function isLocalRequest(req) {
  const ip = requestIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}
function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}
function hasLanToken(req) {
  if (!LAN_TOKEN) return false;
  if (cookieValue(req, 'aiconvo') === LAN_TOKEN) return true;
  const hdr = String(req.headers.authorization || '');
  if (hdr.startsWith('Bearer ') && hdr.slice(7) === LAN_TOKEN) return true;
  if (hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    return pass === LAN_TOKEN;
  }
  return false;
}
function lanLoginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>aiconvo</title>
<style>html,body{margin:0;background:#fff;color:#000;font:18px/1.4 monospace}main{max-width:28rem;margin:12vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.6rem;margin:.4rem 0;border:2px solid #000;background:#fff;color:#000}button{font-weight:700}p{margin:0 0 1rem}.err{font-weight:700}</style></head>
<body><main><p>Enter the LAN token from the laptop. After this, the tablet stays signed in.</p>
${error ? `<p class="err">${error.replace(/</g, '&lt;')}</p>` : ''}
<form method="post" action="/login"><label for="token">token</label><input id="token" name="token" autocomplete="off" autofocus><button type="submit">open aiconvo</button></form></main></body></html>`;
}
function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.internal || net.family !== 'IPv4') continue;
      if (net.address.startsWith('172.') || net.address.startsWith('10.0.3.') || net.address.startsWith('192.168.122.') || net.address.startsWith('192.168.250.')) continue;
      out.push(net.address);
    }
  }
  return out;
}

fs.mkdirSync(SESS_DIR, { recursive: true });

// FTS5 work-memory search (searchindex.js). A derived cache: delete the
// database and the next boot rebuilds it. Null when node:sqlite is missing;
// /api/search then falls back to the old scan.
const searchIdx = openSearchIndex(path.join(CACHE_DIR, 'search.db'));
const usageIdx = usageLib.openUsageIndex(USAGE_DB_FILE);
let usagePricingCatalog = null;
function pricingCatalog() {
  if (!usagePricingCatalog) usagePricingCatalog = usageLib.loadPricingCatalog();
  return usagePricingCatalog;
}
function usageAuthTypes() {
  const out = {};
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), 'utf8'));
    for (const [provider, value] of Object.entries(auth || {})) {
      if (value && typeof value === 'object' && typeof value.type === 'string') out[provider] = value.type;
    }
  } catch {}
  return out;
}

// Explicit conversation assignments are durable user data. They let a loose
// conversation join a real project without changing its true tool cwd.
const LOOSE_PROJECT = foldsLib.LOOSE_PROJECT;
const CONVERSATION_PROJECTS_FILE = path.join(NOTES_DIR, 'projects', 'conversation-projects.json');
let conversationProjects = {};
try { conversationProjects = JSON.parse(fs.readFileSync(CONVERSATION_PROJECTS_FILE, 'utf8')); } catch {}
if (!conversationProjects || typeof conversationProjects !== 'object' || Array.isArray(conversationProjects)) conversationProjects = {};

// A stable project name from a cwd, after an explicit assignment and fold
// resolution. Worktrees and manual merges collapse into one name.
function projectNameOf(cwd, key = '') {
  const assigned = key && conversationProjects[key];
  return canonicalProjectName(assigned || foldsLib.rawProjectOf(cwd));
}

// index: { [relPath]: { mtimeMs, size, sessionId, cwd, gitBranch, title,
//                       firstTs, lastTs, userCount, assistantCount } }
let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { index = {}; }

// Atomic write: temp file + rename. The temp name must be unique per call:
// document regen writes several files in one folder at the same time, and a
// shared Date.now() name made the second rename lose its temp file.
let atomicWriteSeq = 0;
async function writeFileAtomic(p, data) {
  const tmp = p + '.tmp-' + process.pid + '-' + (++atomicWriteSeq) + '-' + Math.random().toString(36).slice(2, 8);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

function saveIndexSoon() {
  clearTimeout(saveIndexSoon.t);
  saveIndexSoon.t = setTimeout(() => {
    writeFileAtomic(INDEX_FILE, JSON.stringify(index)).catch(() => {});
  }, 500);
}

function cachePathFor(key) {
  return path.join(SESS_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
}

// Bump when the cached message format changes; forces a re-index.
const CACHE_VERSION = 13; // v13: bash tool calls carry their mined file writes

// A memory-briefing bootstrap prompt is the same for every launched session; it says
// nothing about the actual work. Titles must come from the first real request instead.
function isBootstrapMessage(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/\/briefings\/\S+\.md/.test(t) && /work memory|project memory/i.test(t)) return true;
  if (/^read\b[^\n]*\.cache\/aiconvo\//i.test(t)) return true;
  return false;
}

// First user message that is not memory-injection boilerplate; falls back to the very first.
function titleSourceMessage(messages) {
  let first = null;
  for (const m of messages) {
    if (m.role !== 'user' || !String(m.text || '').trim()) continue;
    if (!first) first = m;
    if (!isBootstrapMessage(m.text)) return m;
  }
  return first;
}

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

// An image descriptor never contains the large base64 body. The browser gets
// that body from a lazy media endpoint only when the thumbnail nears view.
function imageDescriptor(block, entry, blockPath) {
  if (!block || block.type !== 'image') return null;
  const mime = String(block.mimeType || (block.source && block.source.media_type) || 'image/png').toLowerCase();
  const data = block.data || (block.source && block.source.data);
  if (typeof data !== 'string' || !/^image\/(png|jpeg|jpg|gif|webp)$/.test(mime)) return null;
  return { entry, path: blockPath.join('.'), mime: mime === 'image/jpg' ? 'image/jpeg' : mime };
}

function directImagesOf(content, entry, prefix = []) {
  if (!Array.isArray(content)) return [];
  const out = [];
  content.forEach((block, i) => {
    const image = imageDescriptor(block, entry, prefix.concat(i));
    if (image) out.push(image);
  });
  return out;
}

// Conservative candidates from unstructured tool output. Structured tool
// fields stay the first choice. A click verifies each candidate on disk.
function pathCandidates(text) {
  const out = [], seen = new Set();
  const rx = /(?:^|[\s"'`(])((?:~\/|\/|\.\.?\/)[^\s"'`<>|)\]}]+)/gm;
  for (const match of String(text || '').matchAll(rx)) {
    let value = match[1].replace(/[.,;!?]+$/, '');
    if (value.length < 2 || value.length > 1000 || seen.has(value)) continue;
    seen.add(value); out.push(value);
    if (out.length >= 24) break;
  }
  return out;
}

// Tool calls / results out of a content block array. kinds: tool, toolresult.
function toolEventsOf(content, ts, entry, cwd = null) {
  const out = [];
  if (!Array.isArray(content)) return out;
  // Bash creates files too (redirects, tee, heredocs, inline scripts). The
  // same miner that feeds the diff timeline annotates the transcript message,
  // so the chat view can link those files exactly like write/edit calls.
  const resolveWrite = value => {
    value = String(value);
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    if (!path.isAbsolute(value) && cwd) return path.resolve(cwd, value);
    return value;
  };
  for (let bi = 0; bi < content.length; bi++) {
    const b = content[bi];
    if (!b) continue;
    if (b.type === 'tool_use' || b.type === 'toolCall') {
      const input = b.input || b.arguments || {};
      const p = input.file_path || input.notebook_path || input.path || null;
      const text = toolInputText(b.name, input);
      const msg = { role: 'tool', name: b.name || '?', text,
                    path: typeof p === 'string' ? p : null, paths: pathCandidates(text), id: b.id || null, ts };
      if (/^(bash|shell)$/i.test(b.name || '') && typeof (input.command || input.cmd) === 'string') {
        const writes = shellMutationPaths(input.command || input.cmd).map(resolveWrite).slice(0, 6);
        if (writes.length) msg.writes = writes;
      }
      out.push(msg);
    } else if (b.type === 'tool_result') {
      let t = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
      if (t.length > 4000) t = t.slice(0, 4000) + '\n… (truncated)';
      const images = directImagesOf(b.content, entry, [bi]);
      if (t.trim() || images.length) out.push({ role: 'toolresult', text: t, images, paths: pathCandidates(t), tid: b.tool_use_id || null, ts, err: !!b.is_error });
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
        const images = directImagesOf(content, eid);
        if (t.trim() || images.length) messages.push({ role: 'toolresult', text: t, images, paths: pathCandidates(t), tid: d.message.toolCallId || d.message.toolCallID || null, ts: d.timestamp || null, err: !!(d.message.isError || d.message.is_error), _eid: eid });
        continue;
      }
      if (role !== 'user' && role !== 'assistant') continue;
    } else continue;
    if (d.timestamp) {
      if (!meta.firstTs) meta.firstTs = d.timestamp;
      meta.lastTs = d.timestamp;
    }
    // Reasoning: assistant entries may carry thinking blocks (pi and Claude
    // use the same block shape). They become their own row so the everything
    // view can show the reasoning; chat mode filters them out by role.
    if (role === 'assistant' && Array.isArray(content)) {
      let think = content.filter(b => b && b.type === 'thinking' && typeof b.thinking === 'string').map(b => b.thinking).join('\n');
      if (think.trim()) {
        if (think.length > 8000) think = think.slice(0, 8000) + '\n… (truncated)';
        messages.push({ role: 'thinking', text: think, ts: d.timestamp || null, _eid: eid });
      }
    }
    const text = textOf(content);
    const turnImages = directImagesOf(content, eid);
    // Interruptions become their own marker row, not a chat bubble.
    // Claude Code records the user's interrupt as a user message; pi
    // records the aborted assistant turn with stopReason 'aborted'.
    if (role === 'user' && /^\[Request interrupted by user/.test(text.trim())) {
      messages.push(...toolEventsOf(content, d.timestamp || null, eid, meta.cwd || null).map(m => ({ ...m, _eid: eid })));
      messages.push({ role: 'abort', text: 'interrupted by you', ts: d.timestamp || null, _eid: eid });
      continue;
    }
    if ((text.trim() || turnImages.length) && !(role === 'user' && isNoise(text))) {
      const msg = { role, text, images: turnImages, ts: d.timestamp || null, _eid: eid };
      // Both formats store the generating model on the assistant entry
      // (pi also stores the provider). Kept per message: models can change
      // mid-conversation and per branch.
      if (role === 'assistant' && d.message) {
        if (d.message.model) msg.model = d.message.model;
        if (d.message.provider) msg.provider = d.message.provider;
      }
      messages.push(msg);
    }
    // Tool calls (assistant) and tool results (claude wraps them in user turns).
    messages.push(...toolEventsOf(content, d.timestamp || null, eid, meta.cwd || null).map(m => ({ ...m, _eid: eid })));
    if (role === 'assistant' && d.message && d.message.stopReason === 'aborted') {
      messages.push({ role: 'abort', text: 'aborted', ts: d.timestamp || null, _eid: eid });
    }
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
    m.eid = m._eid || null;
    delete m._eid;
  }
  // entryParents: the FULL entry tree (labels, model changes, … included),
  // so a client can retrace any path from any leaf without the raw file.
  // Ordered pairs, not an object: JS objects reorder all-digit keys.
  const entryParents = [...parents.entries()];
  return { meta, messages, entryParents };
}

async function transcriptImage(key, entry, blockPath) {
  if (!index[key] || !entry || !/^\d+(?:\.\d+)*$/.test(blockPath || '')) throw new Error('bad image reference');
  const wanted = blockPath.split('.').map(Number);
  const stream = fs.createReadStream(absPathForKey(key), { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d.id || d.uuid) !== entry) continue;
    let block = d.message && d.message.content;
    for (let i = 0; i < wanted.length; i++) {
      block = Array.isArray(block) ? block[wanted[i]] : null;
      if (i < wanted.length - 1) block = block && block.content;
    }
    const image = imageDescriptor(block, entry, wanted);
    const data = block && (block.data || (block.source && block.source.data));
    if (!image || typeof data !== 'string') throw new Error('image block not found');
    const body = Buffer.from(data, 'base64');
    if (!body.length || body.length > 32 * 1024 * 1024) throw new Error('image is empty or too large');
    return { body, mime: image.mime };
  }
  throw new Error('image entry not found');
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
  const prev = index[key];
  try {
    const { meta, messages, entryParents } = await parseFile(absPath);
    const firstUser = titleSourceMessage(messages);
    const fullTitle = firstUser ? firstUser.text.slice(0, 200).replace(/\s+/g, ' ').trim() : '(no user message)';
    const titleHash = crypto.createHash('sha256').update('v2\x00' + fullTitle).digest('hex').slice(0, 16);
    const memoryHash = crypto.createHash('sha256').update('v1\x00' + JSON.stringify(
      messages.filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => [m.role, m.text || '', m.ts || null, !!m.off])
    )).digest('hex').slice(0, 24);
    const savedTimelineTitle = timelineTitles[key];
    // A manual (or user-requested AI) title override wins over anything re-derived here.
    const manualTitle = savedTimelineTitle && savedTimelineTitle.manual ? savedTimelineTitle : null;
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
      // Parallel generation forks are implementation storage, not standalone
      // conversations. Preserve their hidden group identity across re-indexes.
      hiddenFanout: prev && prev.hiddenFanout || undefined,
      fanoutId: prev && prev.fanoutId || undefined,
      fanoutRootKey: prev && prev.fanoutRootKey || undefined,
      fanoutNode: prev && prev.fanoutNode || undefined,
      fanoutIndex: prev && prev.fanoutIndex != null ? prev.fanoutIndex : undefined,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      title: manualTitle && manualTitle.fullTitle ? manualTitle.fullTitle : fullTitle,
      timelineTitle: manualTitle ? manualTitle.title
        : savedTimelineTitle && savedTimelineTitle.hash === titleHash
          ? savedTimelineTitle.title : timelineTitle(fullTitle),
      timelineTitleHash: titleHash,
      memoryHash,
      firstTs: meta.firstTs,
      lastTs: meta.lastTs,
      userCount: messages.filter(m => m.role === 'user').length,
      realUserCount: messages.filter(m => m.role === 'user' && String(m.text || '').trim() && !isBootstrapMessage(m.text)).length,
      assistantCount: messages.filter(m => m.role === 'assistant').length,
      densityChat: densityProfile(messages, meta.firstTs, meta.lastTs, false),
      densityAll: densityProfile(messages, meta.firstTs, meta.lastTs, true),
    };
    index[key] = entry;
    scheduleProjectFoldRefresh(meta.cwd);
    await writeFileAtomic(cachePathFor(key), JSON.stringify({ key, relPath, ...entry, messages, entryParents }));
    saveIndexSoon();
    broadcast({ type: 'update', key, ...entry });
    markLeafDirty(key, prev, entry, stat.mtimeMs);
    if (searchIdx) {
      try {
        searchIdx.putConversation(key, { ...entry, project: projectNameOf(entry.cwd, key) }, messages);
        scheduleSemanticSync(10000); // batch live edits before pushing
      } catch (e) { console.error('search index', key, e.message); }
    }
    pruneLiveRunTail(key);
    maybeAutoRetitle(key, prev, entry);
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
      if (searchIdx) try { searchIdx.removeConversation(key); } catch {}
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
            if (searchIdx) try { searchIdx.removeConversation(key); } catch {}
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
// The FTS index answers queries (searchindex.js). This slow scan remains
// only as the fallback when node:sqlite is unavailable. It reshapes its
// output to the same grouped format the client renders.
async function legacySearch(q, limit = 100) {
  const needle = q.toLowerCase();
  const mark = t => {
    const pos = t.toLowerCase().indexOf(needle);
    if (pos < 0) return t.replace(/\s+/g, ' ');
    const start = Math.max(0, pos - 80);
    return (t.slice(start, pos) + '\u0001' + t.slice(pos, pos + needle.length) + '\u0002' +
            t.slice(pos + needle.length, pos + needle.length + 120)).replace(/\s+/g, ' ');
  };
  const groups = [];
  for (const key of Object.keys(index)) {
    let data;
    try { data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); } catch { continue; }
    const matches = [];
    let matchCount = 0;
    for (let i = 0; i < data.messages.length; i++) {
      const m = data.messages[i];
      if (m.text.toLowerCase().indexOf(needle) < 0) continue;
      matchCount++;
      if (matches.length < 3) matches.push({ i, role: m.role, ts: m.ts, off: !!m.off, snippet: mark(m.text) });
    }
    if (matches.length) {
      const e = index[key];
      groups.push({ kind: 'conversation', key, title: e.title, project: projectNameOf(e.cwd, key),
                    source: e.source, score: 0, matchCount, matches });
    }
    if (groups.length >= limit) break;
  }
  groups.sort((a, b) => ((index[b.key] || {}).lastTs || '').localeCompare((index[a.key] || {}).lastTs || ''));
  for await (const rel of walk(NOTES_DIR, NOTES_DIR)) {
    if (!rel.endsWith('.md')) continue;
    try {
      const text = await fsp.readFile(path.join(NOTES_DIR, rel), 'utf8');
      if (text.toLowerCase().indexOf(needle) < 0) continue;
      groups.unshift({
        kind: rel.startsWith('epics/') ? 'epic' : rel.startsWith('projects/') ? 'memory' : 'note',
        file: rel, title: (text.match(/^# (.*)$/m) || [])[1] || rel, score: 0, matchCount: 1,
        matches: [{ role: 'note', snippet: mark(text) }],
      });
    } catch {}
  }
  return { total: groups.length, groupCount: groups.length, groups: groups.slice(0, limit) };
}

// Feed changed conversations and markdown memory into the FTS index.
// Runs after boot and after every notes-tree change; each step yields the
// event loop so indexing never blocks a request.
let searchSyncRunning = false;
let searchSyncAgain = false;
async function syncSearchIndex() {
  if (!searchIdx) return;
  if (searchSyncRunning) { searchSyncAgain = true; return; }
  searchSyncRunning = true;
  const t0 = Date.now();
  let convs = 0, docs = 0;
  try {
    // Conversations: the index entry's mtime+size is the signature.
    for (const [key, entry] of Object.entries(index)) {
      if (searchIdx.hasCurrent('conv:' + key, SearchIndex.conversationSig(entry))) continue;
      let data;
      try { data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8')); } catch { continue; }
      try {
        if (searchIdx.putConversation(key, { ...entry, project: projectNameOf(entry.cwd, key) }, data.messages)) convs++;
      } catch (e) { console.error('search index', key, e.message); }
      await new Promise(r => setImmediate(r));
    }
    // Markdown memory: every .md under the notes tree (notes, epics, projects).
    const seenMd = new Set();
    for await (const rel of walk(NOTES_DIR, NOTES_DIR)) {
      if (!rel.endsWith('.md')) continue;
      seenMd.add(rel);
      try {
        const stat = await fsp.stat(path.join(NOTES_DIR, rel));
        if (searchIdx.putMarkdown(rel, await fsp.readFile(path.join(NOTES_DIR, rel), 'utf8'), stat)) docs++;
      } catch {}
      await new Promise(r => setImmediate(r));
    }
    // Prune sources that vanished from disk.
    for (const key of searchIdx.listSrcs('conv:').keys()) {
      if (!index[key]) try { searchIdx.removeConversation(key); } catch {}
    }
    for (const rel of searchIdx.listSrcs('md:').keys()) {
      if (!seenMd.has(rel)) try { searchIdx.removeSrc('md:' + rel); } catch {}
    }
  } finally {
    searchSyncRunning = false;
  }
  if (convs || docs) console.log(`search index: ${convs} conversations, ${docs} documents in ${Date.now() - t0} ms`);
  if (convs || docs) scheduleSemanticSync(3000);
  if (searchSyncAgain) { searchSyncAgain = false; syncSearchIndex(); }
}

// The notes tree changes outside the session watcher (distills, edits,
// project memory jobs): watch it so markdown search stays fresh.
function watchNotes() {
  if (!searchIdx || !fs.existsSync(NOTES_DIR)) return;
  let t;
  try {
    fs.watch(NOTES_DIR, { recursive: true }, (event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      clearTimeout(t);
      t = setTimeout(syncSearchIndex, 2000);
    });
  } catch (e) { console.error('notes watch failed:', e.message); }
}

// ---------- semantic stage (optional late-interaction search on the GPU server) ----------
// The laptop stays authoritative: the GPU index is a derived cache fed from
// the FTS unit store. When the server is unreachable, search silently stays
// lexical-only. Off by default (settings → semantic search).

function semanticEnabled() {
  return !!(searchIdx && appSettings.semanticSearch && appSettings.semanticUrl);
}

// One namespace per install on the shared GPU stage (settings → semanticNs).
function semNs() {
  return String(appSettings.semanticNs || 'default');
}

async function semFetch(route, body, ms = 20000) {
  const r = await fetch(appSettings.semanticUrl + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error('semantic server HTTP ' + r.status);
  return r.json();
}

// Push changed sources to the GPU stage. The semsync ledger makes this
// resumable: a dead server tonight is caught up tomorrow.
let semSyncRunning = false;
async function syncSemantic() {
  if (!semanticEnabled() || semSyncRunning) return;
  semSyncRunning = true;
  const t0 = Date.now();
  let pushed = 0, dropped = 0;
  try {
    for (;;) {
      const { push, drop } = searchIdx.semanticPending(50);
      if (!push.length && !drop.length) break;
      for (const src of drop) {
        await semFetch('/remove', { ns: semNs(), prefix: src + '|' });
        searchIdx.semanticDrop(src);
        dropped++;
      }
      for (const { src, sig } of push) {
        const units = searchIdx.listUnits(src);
        await semFetch('/remove', { ns: semNs(), prefix: src + '|' });
        for (let i = 0; i < units.length; i += 48) {
          await semFetch('/upsert', { ns: semNs(), units: units.slice(i, i + 48) }, 120000);
        }
        searchIdx.semanticMark(src, sig);
        pushed++;
        await new Promise(r => setImmediate(r));
      }
    }
    if (pushed || dropped) console.log(`semantic push: ${pushed} sources (+${dropped} removed) in ${Date.now() - t0} ms`);
  } catch (e) {
    console.error('semantic push paused:', e.message); // the ledger resumes later
  } finally {
    semSyncRunning = false;
  }
}

let semTimer;
function scheduleSemanticSync(delay = 5000) {
  if (!semanticEnabled()) return;
  clearTimeout(semTimer);
  semTimer = setTimeout(syncSemantic, delay);
}
setInterval(() => scheduleSemanticSync(1000), 5 * 60 * 1000);

// Reshape GPU hits into the grouped format the client renders.
function semanticGroups(hits) {
  const groups = new Map();
  for (const h of hits) {
    const m = h.meta || {};
    const gid = m.key ? 'c:' + m.key : 'f:' + (m.file || '?');
    let g = groups.get(gid);
    if (!g) {
      g = {
        kind: m.key ? 'conversation' : (m.kind || 'note'),
        key: m.key || undefined, file: m.file || undefined,
        title: m.title || null, project: m.project || null, source: m.source || null,
        score: 0, matchCount: 0, matches: [], semantic: true,
      };
      groups.set(gid, g);
    }
    g.matchCount++;
    g.score = Math.max(g.score, h.score || 0);
    if (g.matches.length < 3) {
      g.matches.push({
        i: m.idx == null ? undefined : m.idx,
        role: m.kind === 'title' ? 'title' : (m.role || m.kind),
        ts: m.ts || null, off: !!m.off, title: m.title || undefined,
        snippet: m.snip || '', semantic: true, score: h.score,
      });
    }
  }
  const list = [...groups.values()].sort((a, b) => b.score - a.score);
  for (const g of list) {
    if (g.key && index[g.key]) {
      const e = index[g.key];
      g.title = e.title; g.cwd = e.cwd; g.source = e.source;
      g.firstTs = e.firstTs; g.lastTs = e.lastTs; g.notePath = e.notePath || null;
    }
  }
  return list;
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
        node.bridge = bridgeKindOf(node.text);
        if (Array.isArray(d.message.content)) {
          node.names = d.message.content.filter(b => b && (b.type === 'toolCall' || b.type === 'toolUse' || b.type === 'tool_use')).map(b => b.name || '?');
          node.calls = node.names.length || undefined;
        }
        if (d.message.role === 'assistant' && d.message.model) {
          node.model = d.message.model;
          if (d.message.provider) node.provider = d.message.provider;
        }
        const u = d.message.role === 'assistant' && d.message.usage;
        if (u) {
          node.tok = u.totalTokens || ((u.input || 0) + (u.output || 0)) || 0;
          node.cost = (u.cost && u.cost.total) || 0;
          node.ctx = settingsLib.usageContextTokens(u, 'pi');
        }
      } else if (d.type === 'message' && d.message && d.message.role === 'toolResult') {
        node.tres = d.message.toolName || true;
      } else if (d.type === 'model_change' && d.modelId) {
        // The model that serves the turns below this entry, until the next switch.
        node.modelChange = { provider: d.provider || null, model: d.modelId };
      } else if (d.type === 'thinking_level_change' && d.thinkingLevel) {
        // The reasoning level that serves the turns below this entry.
        node.thinkingChange = d.thinkingLevel;
      } else if (d.type === 'custom' && d.customType === 'mode-switch' && d.data) {
        // The modes extension persists the active prompt mode as a custom
        // entry. The nearest one above a node serves that node's turns.
        const def = d.data.definition && typeof d.data.definition === 'object' ? d.data.definition : null;
        const key = String(d.data.mode || (def && def.key) || '').trim();
        if (key) node.modeChange = { key, label: (def && def.label) || key };
      }
    } else {
      if (!d.uuid || d.isSidechain) continue;
      node = { id: d.uuid, parent: d.parentUuid || null, role: null, text: '', ts: d.timestamp || null };
      if ((d.type === 'user' || d.type === 'assistant') && !d.isMeta && d.message) {
        node.role = d.type;
        node.text = textOf(d.message.content);
        if (Array.isArray(d.message.content)) {
          node.names = d.message.content.filter(b => b && b.type === 'tool_use').map(b => b.name || '?');
          node.calls = node.names.length || undefined;
          // A user-typed entry that carries tool_result blocks is machinery,
          // not words: classify it as work, never as a user message.
          if (d.message.content.some(b => b && b.type === 'tool_result')) { node.tres = true; node.role = null; }
        }
        if (d.type === 'assistant' && d.message.model) node.model = d.message.model;
        const u = d.type === 'assistant' && d.message.usage;
        if (u) {
          // Cache reads and cache writes sit in the window too; without them
          // a claude meter reads far too low.
          node.tok = settingsLib.usageContextTokens(u, 'claude');
          node.ctx = node.tok;
        }
      }
    }
    // Three kinds of entry:
    //  - box: a PURE message — user words, or assistant words with no tool call.
    //  - work: the machinery between pure messages — tool calls and results,
    //    thinking-only or mixed text+tool messages. Runs of work agglomerate
    //    into one ⚙ work box in the tree.
    //  - neither: settings, labels, noise — invisible glue.
    node.box = !!(node.role === 'user' ? node.text.trim() && !isNoise(node.text) && !node.tres
      : node.role === 'assistant' ? node.text.trim() && !node.calls : false);
    node.work = !node.box && !!(node.tres || node.calls || node.role === 'assistant');
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

// Group every indexed session into its fork family in one pass. The pure
// union-find lives in sessionfork.js (groupFamilies) with its own tests.
function familyGroups() {
  return groupFamilies(Object.entries(index), keyForSessionPath);
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

// Union the whole fork family's raw entries: shared entries dedupe by id, so
// every fork's new messages attach to the shared chain as real branches.
async function familyEntryGraph(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const family = forkFamily(key);
  const byId = new Map();
  const all = [];
  const lastBoxOf = new Map();
  const lastEntryOf = new Map();
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
      if (n.box || n.work) lastBoxOf.set(k, n);
      lastEntryOf.set(k, n);
    }
  }
  return { entry, family, byId, all, lastBoxOf, lastEntryOf };
}

// The leaf a resume continues from: the file's TRUE last entry (a branch
// anchor counts — that is the whole point of the anchor), walked up to the
// nearest visible box. File order alone would ignore an in-file branch.
function leafBoxFor(graph, k) {
  let n = graph.lastEntryOf.get(k) || null;
  const seen = new Set();
  while (n && !(n.box || n.work)) {
    if (seen.has(n.id)) { n = null; break; } // cyclic parent chain in bad data
    seen.add(n.id);
    n = n.parent ? graph.byId.get(n.parent) : null;
  }
  return n || graph.lastBoxOf.get(k) || null;
}

async function sessionTreeFor(key, opts = {}) {
  const graph = await familyEntryGraph(key);
  const { entry, family, byId, all } = graph;
  // Contract the entry graph to visible boxes (pure messages + work entries):
  // the nearest visible ancestor is the parent.
  const boxes = all.filter(n => n.box || n.work);
  const childCount = new Map();
  for (const b of boxes) {
    let p = b.parent && byId.get(b.parent);
    const seen = new Set([b.id]);
    while (p && !(p.box || p.work)) {
      if (seen.has(p.id)) { p = null; break; } // cyclic parent chain in bad data
      seen.add(p.id);
      p = p.parent && byId.get(p.parent);
    }
    b.bparent = p || null;
    if (p) childCount.set(p.id, (childCount.get(p.id) || 0) + 1);
  }
  // Merge linear chains of the SAME kind into one box: a work run becomes one
  // ⚙ work box, a multi-message reply one assistant box. Never merge across
  // kinds or across a fork boundary (different file membership).
  const groupOf = new Map();
  const groups = [];
  for (const b of boxes) {
    const p = b.bparent;
    const linear = p && childCount.get(p.id) === 1 && p.keys.size === b.keys.size;
    const g = linear && (b.work ? p.work
      : !p.work && b.role === 'assistant' && p.role === 'assistant') ? groupOf.get(p.id) : null;
    if (g) { g.members.push(b); groupOf.set(b.id, g); }
    else { const ng = { members: [b] }; groups.push(ng); groupOf.set(b.id, ng); }
  }
  // The active branch: the path from the viewed file's resume leaf to the root.
  const active = new Set();
  const viewedLeaf = leafBoxFor(graph, key);
  for (let g = viewedLeaf ? groupOf.get(viewedLeaf.id) : null; g && !active.has(g);) {
    active.add(g);
    const up = g.members[0].bparent;
    g = up ? groupOf.get(up.id) : null;
  }
  // Raw-entry children: a box-leaf may carry a TAIL of non-box entries below
  // its last text message — tool calls, tool results, thinking of an aborted
  // or tool-only run, setting switches. The anchor must reach the true end,
  // or branch/fork silently drops that work.
  const kidsOf = new Map();
  for (const n of all) {
    if (!n.parent || !byId.has(n.parent)) continue;
    if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []);
    kidsOf.get(n.parent).push(n);
  }
  const tailOf = last => {
    let tail = last, calls = 0;
    if (!childCount.get(last.id)) { // no box below: every descendant is loose tail
      const seen = new Set([tail.id]);
      for (;;) {
        const kids = kidsOf.get(tail.id) || [];
        if (!kids.length) break;
        const next = [...kids].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))[kids.length - 1];
        if (seen.has(next.id)) break; // cyclic child chain in bad data
        seen.add(next.id);
        tail = next;
        calls += tail.calls || 0;
      }
    }
    return { tail, calls };
  };
  const nodes = groups.map(g => {
    const first = g.members[0], last = g.members[g.members.length - 1];
    const up = first.bparent ? groupOf.get(first.bparent.id) : null;
    const owner = last.keys.has(key) ? key : family.find(k => last.keys.has(k)) || key;
    const { tail, calls: tailCalls } = tailOf(last);
    const isWork = !!first.work;
    // A work box is titled by its tool tally: "bash ×5 · read ×3 · edit".
    const tally = new Map();
    if (isWork) for (const m of g.members) for (const nm of m.names || []) tally.set(nm, (tally.get(nm) || 0) + 1);
    const workTitle = [...tally.entries()].sort((a, b) => b[1] - a[1])
      .map(([nm, c]) => c > 1 ? `${nm} ×${c}` : nm).join(' · ');
    const tools = (isWork ? g.members.reduce((s, m) => s + (m.calls || 0), 0) : 0) + tailCalls;
    return {
      id: tail.id,                       // fork point: the whole turn package is kept
      parent: up ? up.members[up.members.length - 1].id : null,
      role: isWork ? 'work' : first.role,
      ts: first.ts, lastTs: tail.ts || last.ts,
      jumpTs: first.ts,                  // transcript anchor of the first message
      title: isWork ? (workTitle || 'thinking') : nodeTitle(g.members.length > 1 ? last.text : first.text),
      model: [...g.members].reverse().map(m => m.model).find(Boolean) || undefined,
      fullText: opts.withTexts ? g.members.map(m => m.text).join('\n\n') : undefined,
      count: g.members.length,
      chars: g.members.reduce((n, m) => n + m.text.length, 0),
      tok: g.members.reduce((n, m) => n + (m.tok || 0), 0) || undefined,
      cost: g.members.reduce((n, m) => n + (m.cost || 0), 0) || undefined,
      tools: tools || undefined,         // tool calls the package carries
      tail: tail !== last || undefined,  // loose entries extend past the last text
      active: active.has(g),
      key: owner,                        // the conversation to read or fork from
      fork: owner !== key || undefined,  // lives in a forked/linked session
      bridge: first.bridge || last.bridge || undefined,
    };
  });
  return {
    key, source: entry.source, title: entry.title, nodes,
    family: family.map(k => ({ key: k, title: (index[k] && index[k].title) || '' })),
  };
}

// Context meter: how full is the serving model's window on the visible trace,
// and what the conversation cost so far. Ground truth only: the provider's own
// usage counters from the newest assistant reply on the trace, and the context
// sizes pi reports for its models. Context is trace-scoped (siblings do not
// share a window); Pi cost is a catalog estimate, including subscription routes.
async function conversationContextResponse(key, leafId) {
  const graph = await familyEntryGraph(key);
  const { entry, byId, all } = graph;
  const leaf = (leafId && byId.get(leafId)) || leafBoxFor(graph, key);
  const chain = [];
  const seen = new Set();
  for (let n = leaf; n && !seen.has(n.id); n = n.parent ? byId.get(n.parent) : null) {
    seen.add(n.id);
    chain.push(n);
  }
  // Setting entries (model/thinking changes) hang BELOW the last message box
  // until the next reply arrives. Without this tail the meter reports the old
  // value right after a switch, and the UI rolls the control back.
  if (leaf) {
    const settingKids = new Map(); // parent id → newest setting-only child
    for (const n of all) if ((n.modelChange || n.thinkingChange || n.modeChange) && n.parent) settingKids.set(n.parent, n);
    for (let tip = settingKids.get(leaf.id); tip && !seen.has(tip.id); tip = settingKids.get(tip.id)) {
      seen.add(tip.id);
      chain.unshift(tip); // nearest links come first
    }
  }
  // The newest assistant usage on the trace = the tokens the next turn carries.
  const lastUsed = chain.find(n => n.role === 'assistant' && n.ctx) || null;
  // The model that serves the next turn: the nearest model_change entry wins,
  // else the model of the newest assistant reply on the trace.
  let provider = null, model = null;
  for (const n of chain) {
    if (n.modelChange) { provider = n.modelChange.provider; model = n.modelChange.model; break; }
    if (n.role === 'assistant' && n.model) { provider = n.provider || null; model = n.model; break; }
  }
  // The reasoning level that serves the next turn: nearest thinking entry wins.
  const thinking = (chain.find(n => n.thinkingChange) || {}).thinkingChange || null;
  // The prompt mode that serves the next turn (modes extension), if any.
  const mode = (chain.find(n => n.modeChange) || {}).modeChange || null;
  const models = (modelsCache.models.length ? modelsCache : await listPiModels()).models || [];
  let hit = model ? settingsLib.findModel(models, provider, model) : null;
  if (!hit && model) hit = models.find(m => m.model === model) || null;
  const ctxTokens = (hit && hit.context) || piContextTokens();
  const usedTokens = lastUsed ? lastUsed.ctx : 0;
  const money = list => Math.round(list.reduce((n, m) => n + (m.cost || 0), 0) * 1e6) / 1e6;
  const usedModel = lastUsed ? lastUsed.model || null : null;
  return {
    key,
    source: entry.source,
    leaf: leaf ? leaf.id : null,
    provider, model, thinking, mode,
    ctxTokens, usedTokens,
    leftTokens: Math.max(0, ctxTokens - usedTokens),
    pctLeft: ctxTokens ? Math.max(0, Math.min(100, Math.round(100 * (1 - usedTokens / ctxTokens)))) : null,
    traceCost: money(chain),
    familyCost: money(all),
    usedModel,
    usedTs: lastUsed ? lastUsed.ts : null,
    // An estimate when no usage exists yet, when the model is not in the
    // catalog, or when the model changed after the last counted reply
    // (another tokenizer, another window).
    estimate: !lastUsed || !(hit && hit.context) || !!(usedModel && model && usedModel !== model),
  };
}

// ---------- session operations (fork / branch) ----------
// pi session operations run through pi's own runtime (pirpc.js + the
// aiconvo-bridge extension). Claude keeps a hand copier: no native
// arbitrary-node fork exists (verified empirically).
// Two interchangeable pi engines behind one surface. 'sdk' (default) runs
// sessions in-process — aiconvo as a pi face: ms forks, MB sessions, full
// extension dialogs. 'rpc' spawns pi child processes — the isolation
// fallback (settings.json: "piEngine": "rpc"). Events and handles have
// identical shapes, so everything downstream works on either engine.
const pirpc = require('./pirpc.js');
const pisdk = require('./pisdk.js');
const { piListCommands } = pirpc; // command palette probe stays process-isolated
function piEng() { return appSettings.piEngine === 'rpc' ? pirpc : pisdk; }
// Last @ context actually loaded into a warm session. Saved chips are not
// enough: the user can clear a chip, and the warm process still holds the
// old --append-system-prompt until we drop it.
const appliedContextBySession = new Map();
function contextSig(items) {
  return normalizeContextItems(items).map(i => i.type === 'chat'
    ? 'chat/' + i.key + (i.i == null ? '' : '/' + i.i)
    : i.project + '/' + i.kind).sort().join('|');
}
function stopAnyWarmSession(sessionPath) {
  let stopped = false;
  try { stopped = pirpc.stopWarmSession(sessionPath) || stopped; } catch {}
  try { stopped = pisdk.stopWarmSession(sessionPath) || stopped; } catch {}
  try { appliedContextBySession.delete(path.resolve(sessionPath)); } catch { appliedContextBySession.delete(sessionPath); }
  return stopped;
}
function stopAllEngineSessions() {
  let n = 0;
  try { n += pirpc.stopAllWarmSessions(); } catch {}
  try { n += pisdk.stopAllWarmSessions(); } catch {}
  return n;
}

function sessionPathsFor(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const relPath = key.slice(entry.source.length + 1);
  const sessionPath = path.resolve(SOURCES[entry.source], relPath);
  const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.homedir();
  return { entry, relPath, sessionPath, cwd };
}

// Per-session-file operation queue: fork and branch surgery on one file never
// interleaves. Live ownership (a running pi/claude process) is checked separately.
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
// A fork is a copy: its title gets a ⤔ mark so the two are easy to tell
// apart in every list. The mark is a manual override, so the background
// labeler never overwrites it back to the source's title.
async function markForkTitle(newKey, srcEntry) {
  try {
    const base = String(srcEntry.title || '').replace(/^⤔\s*/, '').trim();
    if (base) await setConversationTitle(newKey, '⤔ ' + base);
  } catch (e) { console.error('fork title failed:', newKey, e.message); }
}

async function forkSession(key, nodeId) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  return withSessionOp(sessionPath, async () => {
    stopAnyWarmSession(sessionPath);
    if (entry.source !== 'claude') {
      const forked = await piEng().piForkAt({ sessionPath, cwd, env: agentEnv() }, nodeId);
      const newKey = await indexNewSessionFile(forked.file);
      await markForkTitle(newKey, entry);
      return { key: newKey, path: forked.file, sessionId: forked.sessionId };
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
    const newKey = entry.source + ':' + relPath;
    await markForkTitle(newKey, entry);
    return { key: newKey, path: newAbs, sessionId: newId };
  });
}

// Fork-edit (pi only): fork BEFORE a user message and return its text so the
// UI opens the new session with the prompt ready to edit and resend.
async function forkSessionForEdit(key, nodeId) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (entry.source === 'claude') throw new Error('Editing a past message needs pi. Claude conversations can only fork.');
  return withSessionOp(sessionPath, async () => {
    const forked = await piEng().piForkBefore({ sessionPath, cwd, env: agentEnv() }, nodeId);
    const newKey = await indexNewSessionFile(forked.file);
    await markForkTitle(newKey, entry);
    return { key: newKey, path: forked.file, sessionId: forked.sessionId, text: forked.text };
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
  // Refuse if a process still holds this session. Do not kill a native TUI.
  const running = findRunningConversation(key);
  if (running) {
    throw new Error('This conversation is open in a terminal (pid ' + running.pid + '). Quit that window, then branch.');
  }
  const absPath = absPathForKey(key);
  return withSessionOp(absPath, async () => {
    stopAnyWarmSession(absPath);
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
    // Refresh the index and the parse cache NOW: the next fetch must already
    // fold the old continuation as an other branch. Waiting for the file
    // watcher leaves a stale transcript for a debounce beat.
    try { await indexFile(entry.source, key.slice(entry.source.length + 1), await fsp.stat(absPath)); }
    catch (e) { console.error('post-branch reindex failed:', e.message); }
    return { ok: true, key, node: nodeId };
  });
}

// ---------- headless agent runs (the blessed path) ----------
// A run is a prompt on a WARM `pi --mode rpc` process bound to the session
// file (follow-ups reuse it; idle 5 min kills it). Ownership rules:
//  - The terminal is sovereign. Opening a terminal aborts any headless run.
//  - A headless run refuses to start while a terminal owns the file
//    (the client may force: stop the terminal first).
//  - The whole run holds the per-file operation lock, so forks, branches,
//    and edits queue behind it instead of interleaving writers.
const headlessRuns = new Map();   // absolute session path → run record
const agentRunJobs = new Map();   // jobId → job (shares the jobs tray)

// Durable record of agent runs. A service restart kills every warm pi child
// (systemd stops the whole cgroup), which used to erase the run silently:
// the assistant just "stopped" with no visible reason. The snapshot on disk
// survives the restart, so the jobs tray can say what happened and why.
const AGENT_RUNS_FILE = path.join(CACHE_DIR, 'agent-runs.json');
const restoredRunJobs = new Map(); // jobId → view-shaped record from a previous process
const JOB_KEEP_MS = 60 * 60 * 1000;
try {
  for (const j of JSON.parse(fs.readFileSync(AGENT_RUNS_FILE, 'utf8'))) {
    if (!j || !j.id) continue;
    if (j.status === 'running') {
      // The previous process ended without a clean shutdown (SIGKILL, crash).
      j.status = 'error';
      j.statusText = 'stopped — aiconvo restarted during this run';
      j.error = 'server restart';
      j.finishedAt = j.finishedAt || Date.now();
    }
    if ((j.finishedAt || 0) > Date.now() - JOB_KEEP_MS) restoredRunJobs.set(j.id, j);
  }
} catch {}

function agentRunsSnapshot() {
  const cutoff = Date.now() - JOB_KEEP_MS;
  return [
    ...[...restoredRunJobs.values()].filter(j => (j.finishedAt || 0) > cutoff),
    ...[...agentRunJobs.values()].map(jobView),
  ];
}

let agentRunsSaveTimer = null;
function saveAgentRuns() {
  if (agentRunsSaveTimer) return;
  agentRunsSaveTimer = setTimeout(() => {
    agentRunsSaveTimer = null;
    fs.writeFile(AGENT_RUNS_FILE, JSON.stringify(agentRunsSnapshot()), () => {});
  }, 250);
}
function saveAgentRunsNow() {
  clearTimeout(agentRunsSaveTimer);
  agentRunsSaveTimer = null;
  try { fs.writeFileSync(AGENT_RUNS_FILE, JSON.stringify(agentRunsSnapshot())); } catch {}
}

function headlessOwner(absPath) { return headlessRuns.get(absPath) || null; }

const slashCommandsCache = new Map(); // cwd → { at, list } for the composer palette

// Every pi/claude/bridge process on this machine, from /proc. The agents
// view shows them all — including untracked strays — and can kill them.
// Caution: pi and claude rewrite their argv to a bare "pi"/"claude", which
// hides --session and --mode. The PTY bridge parent still shows the full
// launch command, so terminal sessions are recovered from there.
function scanAgentProcs() {
  const procs = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch { return procs; }
  let uptime = 0;
  try { uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) || 0; } catch {}
  const bridgeArgs = new Map(); // bridge pid → argv (holds the real pi command)
  const superPids = new Set();  // remote-pi supervisord pids
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (pid === process.pid) continue;
    let raw;
    try { raw = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch { continue; }
    const argv = raw.split('\0').filter(Boolean).map(a => a.trim()).filter(Boolean);
    if (!argv.length) continue;
    const base0 = path.basename(argv[0]);
    const base1 = argv[1] ? path.basename(argv[1]) : '';
    if ((base0 === 'node' || base0 === 'bun') && argv[1] && argv[1].includes('remote-pi')) { superPids.add(pid); continue; }
    let kind = null;
    if (base0 === 'pi' || ((base0 === 'node' || base0 === 'bun') && base1 === 'pi')) kind = 'pi';
    else if (base0 === 'claude' || ((base0 === 'node' || base0 === 'bun') && base1 === 'claude')) kind = 'claude';
    else if (base1 === 'aiconvo-bridge.py') kind = 'bridge';
    if (!kind) continue;
    if (kind === 'bridge') bridgeArgs.set(pid, argv);
    let sessionPath = null;
    const si = argv.indexOf('--session');
    if (si >= 0 && argv[si + 1]) sessionPath = argv[si + 1];
    const rpc = argv.includes('rpc') && argv.includes('--mode');
    let ageMs = null, ppid = null;
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ppid = Number(fields[1]) || null;
      const startTicks = Number(fields[19]);
      if (uptime && Number.isFinite(startTicks)) ageMs = Math.max(0, Math.round((uptime - startTicks / 100) * 1000));
    } catch {}
    procs.push({ pid, ppid, kind, rpc, sessionPath, ageMs });
  }
  // Second pass: a pi/claude under a PTY bridge inherits the bridge's
  // launch arguments — pi uses --session <path>, claude uses --resume <id>.
  for (const pr of procs) {
    if (pr.sessionPath || !pr.ppid) continue;
    const parent = bridgeArgs.get(pr.ppid);
    if (!parent) continue;
    const si = parent.indexOf('--session');
    if (si >= 0 && parent[si + 1]) { pr.sessionPath = parent[si + 1]; pr.viaBridge = true; }
    const ri = parent.indexOf('--resume');
    if (ri >= 0 && parent[ri + 1]) { pr.resumeId = parent[ri + 1]; pr.viaBridge = true; }
  }
  for (const pr of procs) if (pr.ppid && superPids.has(pr.ppid)) pr.remotePi = true;
  return procs;
}

// Join the raw process list with what the server knows: warm RPC sessions,
// tracked terminal windows, and the conversation index.
function agentProcsView(running) {
  const warmByPid = new Map(pirpc.listWarmSessions().map(w => [w.pid, w]));
  const keyByBase = new Map(Object.keys(index).map(k => [path.basename(k), k]));
  const keyBySessionId = new Map();
  for (const [k, e] of Object.entries(index)) if (e.sessionId) keyBySessionId.set(e.sessionId, k);
  const runningByPid = new Map((running || []).filter(a => a.pid).map(a => [a.pid, a]));
  const runningKeys = new Set((running || []).map(a => a.key).filter(Boolean));
  const out = [];
  for (const pr of scanAgentProcs()) {
    if (pr.kind === 'bridge') continue; // its pi child row carries the meaning
    const warm = warmByPid.get(pr.pid);
    const tracked = runningByPid.get(pr.pid);
    const key = (pr.sessionPath && keyByBase.get(path.basename(pr.sessionPath)))
      || (pr.resumeId && keyBySessionId.get(pr.resumeId))
      || (warm && keyByBase.get(path.basename(warm.sessionPath)))
      || (tracked && tracked.key)
      || null;
    const entry = key ? index[key] : null;
    const run = warm ? headlessOwner(path.resolve(warm.sessionPath)) : null;
    const owner = warm ? 'web'
      : (tracked || (key && runningKeys.has(key))) ? 'terminal'
      : pr.remotePi ? 'remote-pi'
      : pr.ppid === process.pid ? 'server'
      : 'untracked';
    out.push({
      pid: pr.pid, kind: pr.kind, rpc: pr.rpc, key,
      title: entry ? (entry.timelineTitle || entry.title) : null,
      cwd: entry ? entry.cwd : null, ageMs: pr.ageMs, owner,
      busy: warm ? warm.busy : undefined, model: warm && warm.model || undefined,
      jobId: run ? run.jobId : undefined,
    });
  }
  const weight = { web: 0, terminal: 1, server: 2, 'remote-pi': 3, untracked: 4 };
  // In-process (sdk) sessions are not separate OS processes: add them as
  // virtual rows so the agents view shows and can kill every live session.
  for (const w of pisdk.listWarmSessions()) {
    const key = keyByBase.get(path.basename(w.sessionPath)) || null;
    const entry = key ? index[key] : null;
    const run = headlessOwner(path.resolve(w.sessionPath));
    out.push({
      pid: process.pid, kind: 'pi', rpc: true, engine: 'sdk', key,
      title: entry ? (entry.timelineTitle || entry.title) : null,
      cwd: entry ? entry.cwd : null, ageMs: null, owner: 'web',
      busy: w.busy, model: w.model || undefined, jobId: run ? run.jobId : undefined,
    });
  }
  out.sort((a, b) => (weight[a.owner] - weight[b.owner]) || ((a.ageMs || 0) - (b.ageMs || 0)));
  return out;
}

// Extension-backed providers (claude-code) exist only when their extension
// loads inside the RPC process; `--no-extensions` would hide them.
function piProviderExtraArgs() {
  return fs.existsSync(CLAUDE_CODE_EXT) ? ['-e', CLAUDE_CODE_EXT] : [];
}

// Abort the headless run on a file and wait for it to let go.
async function releaseHeadless(absPath, reason) {
  const run = headlessRuns.get(absPath);
  if (run) {
    run.yielded = reason || 'released';
    try { if (run.handle && run.handle.abort) await run.handle.abort(); } catch {}
    try { await Promise.race([run.handle.done, sleep(4000)]); } catch {}
  }
  stopAnyWarmSession(absPath);
  return !!(run);
}

async function lastEntryIdOf(absPath) {
  const raw = await fsp.readFile(absPath, 'utf8');
  let last = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type !== 'session' && typeof (d.id || d.uuid) === 'string') last = d.id || d.uuid;
    } catch {}
  }
  return last;
}

// Live streaming tail of a headless run, for the browser. The tail mirrors
// the in-flight work as ordered blocks: the assistant message streaming in
// (text + thinking) and tool calls with their args and streaming output.
// Completed blocks are pruned when the session file re-indexes: from then on
// the transcript owns that content, so card and transcript never duplicate
// it for long. Throttle: at most one push per ~150 ms, with a trailing timer
// so the final delta always lands.
const liveRunTails = new Map(); // jobId → { keyOf, blocks, timer, push }

function pruneLiveRunTail(key) {
  for (const t of liveRunTails.values()) {
    if (t.keyOf() !== key) continue;
    const before = t.blocks.length;
    for (let i = t.blocks.length - 1; i >= 0; i--) if (t.blocks[i].done) t.blocks.splice(i, 1);
    if (t.blocks.length !== before) t.push(true);
  }
}

function endLiveRunTail(jobId) {
  const t = liveRunTails.get(jobId);
  if (t) clearTimeout(t.timer);
  liveRunTails.delete(jobId);
}

function toolResultTail(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(-4000);
  if (Array.isArray(result.content)) return textOf(result.content).slice(-4000);
  if (typeof result.output === 'string') return result.output.slice(-4000);
  try { return JSON.stringify(result).slice(0, 4000); } catch { return ''; }
}

// Bounded list of extension notices on a run card (errors, notify, ...).
function addRunNotice(job, text) {
  job.notices = job.notices || [];
  job.notices.push(String(text).slice(0, 400));
  if (job.notices.length > 20) job.notices.splice(0, job.notices.length - 20);
}

function runEventForwarder(job) {
  let lastPush = 0, blockSeq = 0;
  const blocks = [];
  const state = { keyOf: () => job.key, blocks, timer: null, push: null };
  liveRunTails.set(job.id, state);
  const slim = b => b.kind === 'tool'
    ? { id: b.id, kind: 'tool', name: b.name, args: (b.args || '').slice(0, 2000),
        out: (b.out || '').slice(-4000), phase: b.phase, error: b.error || undefined, t0: b.t0 || undefined }
    : { id: b.id, kind: 'text', text: (b.text || '').slice(-48000),
        think: (b.think || '').slice(-8000), done: b.done || undefined };
  const push = force => {
    if (!liveRunTails.has(job.id)) return;
    const now = Date.now();
    if (!force && now - lastPush < 150) {
      if (!state.timer) state.timer = setTimeout(() => { state.timer = null; push(true); }, 160);
      return;
    }
    lastPush = now;
    broadcast({ type: 'run-event', jobId: job.id, key: job.key, status: job.status,
      statusText: job.statusText, model: job.model, startedAt: job.startedAt,
      fanoutId: job.fanoutId, fanoutRootKey: job.fanoutRootKey, fanoutNode: job.fanoutNode,
      fanoutIndex: job.fanoutIndex, fanoutCount: job.fanoutCount, tail: blocks.map(slim),
      uiRequests: job.uiRequests || [], notices: job.notices || [],
      extStatus: job.extStatus ? Object.values(job.extStatus).join(' · ') : '',
      widgets: job.widgets || null, customViews: job.customViews || null });
  };
  state.push = push;
  const liveText = () => { for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'text' && !blocks[i].done) return blocks[i]; return null; };
  const toolBlock = callId => blocks.find(b => b.kind === 'tool' && b.callId === callId);
  return event => {
    try {
      if (event.type === 'message_start' && event.message && event.message.role === 'assistant') {
        blocks.push({ id: ++blockSeq, kind: 'text', text: '', think: '', parts: new Map(), tools: new Map() });
        job.statusText = 'streaming';
        push(true);
      } else if (event.type === 'message_update' && event.assistantMessageEvent) {
        // The RPC wire strips the cumulative message snapshot: only deltas
        // arrive. Rebuild the streaming message per content index here.
        const ev = event.assistantMessageEvent;
        let cur = liveText();
        if (!cur) { cur = { id: ++blockSeq, kind: 'text', text: '', think: '', parts: new Map(), tools: new Map() }; blocks.push(cur); }
        const part = i => {
          let p = cur.parts.get(i);
          if (!p) { p = { type: '', text: '' }; cur.parts.set(i, p); }
          return p;
        };
        if (ev.type === 'text_delta') { const p = part(ev.contentIndex); p.type = 'text'; p.text += ev.delta || ''; }
        else if (ev.type === 'text_end') { const p = part(ev.contentIndex); p.type = 'text'; if (typeof ev.content === 'string') p.text = ev.content; }
        else if (ev.type === 'thinking_delta') { const p = part(ev.contentIndex); p.type = 'thinking'; p.text += ev.delta || ''; }
        else if (ev.type === 'thinking_end') { const p = part(ev.contentIndex); p.type = 'thinking'; if (typeof ev.content === 'string') p.text = ev.content; }
        else if (ev.type === 'toolcall_start') {
          const t = { id: ++blockSeq, kind: 'tool', callId: null, name: '?', args: '', out: '', phase: 'args' };
          blocks.push(t);
          cur.tools.set(ev.contentIndex, t);
        } else if (ev.type === 'toolcall_delta') {
          const t = cur.tools.get(ev.contentIndex);
          if (t && t.phase === 'args') t.args = (t.args + (ev.delta || '')).slice(0, 4000);
        } else if (ev.type === 'toolcall_end' && ev.toolCall) {
          const t = cur.tools.get(ev.contentIndex);
          if (t) {
            t.callId = ev.toolCall.id;
            t.name = ev.toolCall.name || t.name;
            try { t.args = toolInputText(t.name, ev.toolCall.arguments) || t.args; } catch {}
            t.phase = 'ready';
          }
        }
        cur.text = [...cur.parts.values()].filter(p => p.type === 'text').map(p => p.text).join('\n');
        cur.think = [...cur.parts.values()].filter(p => p.type === 'thinking').map(p => p.text).join('\n');
        job.statusText = cur.text.length ? 'streaming · ' + cur.text.length + ' chars'
          : cur.think.length ? 'thinking · ' + cur.think.length + ' chars' : 'streaming';
        push(/_start$|_end$/.test(ev.type));
      } else if (event.type === 'tool_execution_start') {
        let t = toolBlock(event.toolCallId);
        if (!t) { t = { id: ++blockSeq, kind: 'tool', callId: event.toolCallId, name: event.toolName || '?', args: '', out: '' }; blocks.push(t); }
        t.name = event.toolName || t.name;
        try { if (event.args) t.args = toolInputText(t.name, event.args) || t.args; } catch {}
        t.phase = 'running';
        t.t0 = Date.now(); // true execution start — the browser ticks elapsed from this
        job.statusText = 'tool · ' + (event.toolName || '?');
        push(true);
      } else if (event.type === 'tool_execution_update') {
        const t = toolBlock(event.toolCallId);
        if (t) { t.out = toolResultTail(event.partialResult); push(false); }
      } else if (event.type === 'tool_execution_end') {
        const t = toolBlock(event.toolCallId);
        if (t) { t.out = toolResultTail(event.result); t.phase = 'done'; t.error = !!event.isError; t.done = true; }
        push(true);
      } else if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
        const cur = liveText();
        if (cur) {
          // The end event carries the authoritative message: trust it.
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          cur.text = textOf(event.message.content) || cur.text;
          // Capture for the spoken completion summary: the live tail gets
          // pruned by indexFile before finish() reads it.
          if (cur.text.trim()) job.lastAssistantText = cur.text;
          const think = content.filter(c => c && c.type === 'thinking' && typeof c.thinking === 'string').map(c => c.thinking).join('\n');
          if (think) cur.think = think;
          cur.done = true;
        }
        if (event.message.stopReason === 'error') {
          job.errorMessage = String(event.message.errorMessage || 'model error').split('\n')[0].slice(0, 300);
          job.statusText = 'model error';
        }
        push(true);
      } else if (event.type === 'auto_retry_start') {
        job.statusText = 'retrying · ' + (event.reason || '');
        push(true);
      } else if (event.type === 'agent_end') {
        job.statusText = 'finishing';
        push(true);
      } else if (event.type === 'extension_error') {
        // Informational, exactly like the TUI: show it, never kill the run.
        const name = path.basename(String(event.extensionPath || 'extension'));
        addRunNotice(job, '⚠ ' + name + (event.event ? ' on ' + event.event : '') + ' — ' + String(event.error || 'error').split('\n')[0].slice(0, 200));
        push(true);
      } else if (event.type === 'extension_ui_request') {
        // Dialogs land on the run card and wait for a browser answer through
        // /api/run/ui-response. pi auto-resolves the ones with a timeout.
        if (event.id && ['confirm', 'select', 'input', 'editor'].includes(event.method)) {
          job.uiRequests = (job.uiRequests || []).filter(q => q.id !== event.id);
          job.uiRequests.push({
            id: event.id, method: event.method,
            title: String(event.title || event.method).slice(0, 200),
            message: event.message ? String(event.message).slice(0, 2000) : '',
            options: Array.isArray(event.options) ? event.options.map(String).slice(0, 20) : undefined,
            placeholder: event.placeholder ? String(event.placeholder).slice(0, 200) : '',
            prefill: typeof event.prefill === 'string' ? event.prefill.slice(0, 20000) : '',
            timeout: event.timeout || null, at: Date.now(),
          });
          job.statusText = 'waiting for you · ' + String(event.title || event.method).slice(0, 60);
        } else if (event.method === 'notify') {
          const mark = event.notifyType === 'error' ? '✗ ' : event.notifyType === 'warning' ? '⚠ ' : 'ℹ ';
          addRunNotice(job, mark + String(event.message || '').slice(0, 300));
        } else if (event.method === 'setStatus') {
          job.extStatus = job.extStatus || {};
          if (event.statusText) job.extStatus[event.statusKey || ''] = String(event.statusText).slice(0, 120);
          else delete job.extStatus[event.statusKey || ''];
        } else if (event.method === 'setWidget') {
          job.widgets = job.widgets || {};
          if (Array.isArray(event.widgetLines) && event.widgetLines.length) job.widgets[event.widgetKey || ''] = event.widgetLines.map(String).slice(0, 12);
          else delete job.widgets[event.widgetKey || ''];
        } else if (event.method === 'custom_render' && event.id) {
          // A hosted TUI view (ctx.ui.custom): ANSI lines for the browser.
          job.customViews = job.customViews || {};
          job.customViews[event.id] = {
            lines: Array.isArray(event.lines) ? event.lines.map(String).slice(0, 200) : [],
            bgSgr: typeof event.bgSgr === 'string' ? event.bgSgr.slice(0, 40) : null,
          };
        } else if (event.method === 'custom_end' && event.id) {
          if (job.customViews) delete job.customViews[event.id];
        } else if (event.method === 'set_editor_text') {
          broadcast({ type: 'editor-text', key: job.key, text: String(event.text || '').slice(0, 20000) });
        }
        push(true);
      }
      // pi resolved a timed dialog on its own: drop it from the card.
      if (job.uiRequests && job.uiRequests.length) {
        const now = Date.now();
        const kept = job.uiRequests.filter(q => !q.timeout || q.at + q.timeout + 2000 > now);
        if (kept.length !== job.uiRequests.length) { job.uiRequests = kept; push(true); }
      }
    } catch {}
  };
}

// Start one headless run on a conversation. node (optional): continue from
// that entry — an in-file pi branch anchor moves the leaf there first.
async function startAgentRun(key, { node, provider, modelId, message, images, force, allowQueue, fanout, context }) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Headless runs need pi. Claude conversations use the terminal.');
  if (!String(message || '').trim()) throw new Error('empty prompt');
  const contextItems = context !== undefined ? normalizeContextItems(context) : conversationContextOf(key);
  if (context !== undefined) saveConversationContext(key, contextItems);
  const nextCtxSig = contextSig(contextItems);
  const prevCtxSig = appliedContextBySession.get(path.resolve(sessionPath)) || '';
  const ctxChanged = prevCtxSig !== nextCtxSig;
  const running = findRunningConversation(key);
  if (running) {
    if (!force) {
      const err = new Error('A terminal owns this conversation (pid ' + running.pid + ').');
      err.needsForce = true;
      throw err;
    }
    await stopRunningAgent(running);
    await waitFileQuiet(sessionPath);
  }
  if (headlessRuns.has(sessionPath)) {
    // Composer sends queue into the running turn through pi's own runtime
    // (followUp) instead of failing — the same behavior as typing in the TUI
    // while the model streams. Branch-targeted sends still refuse.
    if (allowQueue && !node) {
      const record = headlessRuns.get(sessionPath);
      const requested = provider && modelId ? provider + '/' + modelId : null;
      if (requested && record.model && requested !== record.model) {
        throw new Error('A run is active on ' + record.model + '. Wait before switching to ' + requested + '.');
      }
      const queuedOk = await pisdk.piQueuePrompt({ sessionPath }, message, null, images).catch(() => false)
        || await pirpc.piQueuePrompt({ sessionPath }, message, null, images).catch(() => false);
      if (queuedOk) {
        const job = agentRunJobs.get(record.jobId);
        if (job) { job.statusText = 'follow-up queued'; jobChanged(job); }
        return { queued: true, job };
      }
    }
    throw new Error('A web run is already active on this conversation. Wait or abort it.');
  }
  const ctxBundle = contextItems.length ? await writeAttachedContextFile(contextItems) : null;
  const job = {
    id: 'run:' + crypto.randomUUID().slice(0, 8),
    type: 'agent-run', key,
    title: (provider && modelId ? modelId + ' · ' : '') + (images && images.length ? '[' + images.length + ' img] ' : '') + String(message).replace(/\s+/g, ' ').slice(0, 60),
    status: 'running', statusText: 'starting', startedAt: Date.now(),
    model: provider && modelId ? provider + '/' + modelId : null,
    ...(fanout ? {
      fanoutId: fanout.id, fanoutRootKey: fanout.rootKey, fanoutNode: fanout.node,
      fanoutIndex: fanout.index, fanoutCount: fanout.count,
    } : {}),
  };
  agentRunJobs.set(job.id, job);
  jobChanged(job);
  const record = { jobId: job.id, key, startedAt: job.startedAt, model: job.model, handle: null, yielded: null };
  headlessRuns.set(sessionPath, record);
  const finish = async (status, statusText, error) => {
    headlessRuns.delete(sessionPath);
    job.status = status;
    job.statusText = statusText;
    job.uiRequests = [];
    if (error) job.error = error;
    job.finishedAt = Date.now();
    try { await indexFile(entry.source, key.slice(entry.source.length + 1), await fsp.stat(sessionPath)); } catch {}
    if (status === 'done' && !record.yielded) job.doneSpeechSource = job.lastAssistantText || '';
    endLiveRunTail(job.id);
    jobChanged(job);
    broadcast({ type: 'run-event', jobId: job.id, key, status: job.status, statusText: job.statusText, model: job.model,
      fanoutId: job.fanoutId, fanoutRootKey: job.fanoutRootKey, fanoutNode: job.fanoutNode,
      fanoutIndex: job.fanoutIndex, fanoutCount: job.fanoutCount, final: true });
    maybeSettleFanout(job);
    speakRunDone(job);
  };
  // The full run holds the file lock. Fire and forget: the caller gets the job.
  withSessionOp(sessionPath, async () => {
    try {
      if (node) {
        const leaf = await lastEntryIdOf(sessionPath);
        if (leaf !== node) {
          // A warm session still has the old leaf in memory: kill it so the
          // next one loads the file after the branch anchor.
          stopAnyWarmSession(sessionPath);
          // pi's own in-file branch anchor: one label entry, nothing rewritten.
          const raw = await fsp.readFile(sessionPath, 'utf8');
          let found = false;
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try { if (JSON.parse(line).id === node) { found = true; break; } } catch {}
          }
          if (!found) throw new Error('branch point not found in the session file');
          const anchor = { type: 'label', id: crypto.randomBytes(4).toString('hex'), parentId: node, timestamp: new Date().toISOString(), targetId: node };
          await fsp.appendFile(sessionPath, JSON.stringify(anchor) + '\n');
        }
      }
      job.statusText = 'running';
      jobChanged(job);
      // Attached @ context lives in --append-system-prompt on the warm
      // session. Reload when the chip set changed, including a clear.
      if (ctxBundle || ctxChanged) stopAnyWarmSession(sessionPath);
      const extraArgs = [...piProviderExtraArgs(), ...(ctxBundle ? ['--append-system-prompt', ctxBundle.file] : [])];
      const handle = piEng().piHeadlessRun({ sessionPath, cwd, env: agentEnv(), extraArgs }, { provider, modelId, message, images, onEvent: runEventForwarder(job) });
      appliedContextBySession.set(path.resolve(sessionPath), nextCtxSig);
      record.handle = handle;
      await handle.done;
      if (record.yielded) await finish('done', 'stopped — ' + record.yielded);
      else if (job.errorMessage) await finish('error', job.errorMessage, job.errorMessage);
      else if (handle.uiAutoCancelled) await finish('done', 'settled · ' + handle.uiAutoCancelled + ' unanswered dialog(s) cancelled');
      else await finish('done', 'settled');
    } catch (e) {
      await finish(record.yielded ? 'done' : 'error', record.yielded ? 'stopped — ' + record.yielded : e.message, record.yielded ? null : e.message);
    }
  });
  return job;
}

// Fan out one prompt to several models: one pi-native fork per model, then
// parallel runs on the separate files. The family tree shows them as
// sibling branches of the same node.
function markFanoutFork(key, fanout) {
  const e = index[key];
  if (!e) return;
  Object.assign(e, { hiddenFanout: true, fanoutId: fanout.id, fanoutRootKey: fanout.rootKey,
    fanoutNode: fanout.node, fanoutIndex: fanout.index });
  saveIndexSoon();
  // Correct the eager indexNewSessionFile update: clients remove this
  // temporary backing conversation as soon as its group identity is known.
  broadcast({ type: 'update', key, ...e });
}

async function startFanOut(key, { node, models, message, images, force, context }) {
  if (!Array.isArray(models) || models.length < 2) throw new Error('fan-out needs two or more models');
  const runs = [];
  const fanoutId = 'fan:' + crypto.randomUUID().slice(0, 8);
  const contextItems = context !== undefined ? normalizeContextItems(context) : conversationContextOf(key);
  for (let index = 0; index < models.length; index++) {
    const m = models[index];
    const forked = await forkSession(key, node); // sequential: each fork locks the source briefly
    saveConversationModels(forked.key, [m]);
    if (contextItems.length) saveConversationContext(forked.key, contextItems);
    const fanout = { id: fanoutId, rootKey: key, node: node || null, index, count: models.length };
    markFanoutFork(forked.key, fanout);
    const job = await startAgentRun(forked.key, { provider: m.provider, modelId: m.modelId, message, images, force, fanout, context: contextItems });
    runs.push({ key: forked.key, jobId: job.id, model: m.provider + '/' + m.modelId,
      fanoutId, fanoutRootKey: key, fanoutNode: node || null, fanoutIndex: index, fanoutCount: models.length });
  }
  return runs;
}

// Reintegration: after every model of a fan-out settles, the fork files fold
// back into the parent as real in-file sibling branches — pi entries carry
// id/parentId, and the forks share the parent's chain verbatim, so their new
// entries (prompt, work, reply) attach cleanly. The duplicate prompt copies
// collapse onto one canonical prompt entry; each reply chain reparents onto
// it and becomes one branch. The fork files retire as .merged (bytes kept,
// never indexed). Result: ONE conversation that holds every opinion as a
// branch — no session-list, agent-menu, or tree pollution survives.
//
// Crash discipline (fanoutmerge.js owns the pure logic and its rationale):
//  1. compute the WHOLE new root in memory — deterministic, cycle-checked;
//  2. write it with tmp + atomic rename — a kill never tears a line;
//  3. only then retire the forks. A crash between 2 and 3 re-runs the same
//     computation and converges to the same file.
async function reintegrateFanout(rootKey, fanoutId) {
  const entry = index[rootKey];
  if (!entry) return false;
  const rootPath = absPathForKey(rootKey);
  // Never interleave with a live writer on the parent. The sweep retries later.
  if (findRunningConversation(rootKey) || headlessRuns.has(rootPath)) return false;
  const forks = Object.entries(index)
    .filter(([, e]) => e.hiddenFanout && e.fanoutId === fanoutId)
    .sort((a, b) => (a[1].fanoutIndex || 0) - (b[1].fanoutIndex || 0));
  if (!forks.length) return false;
  return withSessionOp(rootPath, async () => {
    stopAnyWarmSession(rootPath);
    const rootRaw = await fsp.readFile(rootPath, 'utf8');
    const forkRaws = [];
    for (const [k] of forks) {
      const absF = absPathForKey(k);
      stopAnyWarmSession(absF);
      try { forkRaws.push(await fsp.readFile(absF, 'utf8')); } catch {}
    }
    // Pure and deterministic; throws before anything is written when the
    // result would carry a parent cycle.
    const merged = fanoutMerge.computeFanoutMerge(rootRaw, forkRaws);
    if (merged.healed) console.error('fan-out merge healed', merged.healed, 'torn line(s) in', rootKey);
    if (merged.changed) {
      const tmp = rootPath + '.tmp-' + process.pid;
      await fsp.writeFile(tmp, merged.content);
      await fsp.rename(tmp, rootPath);
    }
    const bothId = merged.bothId;
    // Root is durable — NOW retire the scaffolding. Bytes stay on disk as
    // .merged for recovery; the scanner and watcher only see .jsonl files.
    for (const [k] of forks) {
      const absF = absPathForKey(k);
      try { await fsp.rename(absF, absF + '.merged'); } catch {}
      delete index[k];
      fsp.unlink(cachePathFor(k)).catch(() => {});
      if (searchIdx) try { searchIdx.removeConversation(k); } catch {}
    }
    saveIndexSoon();
    try { await indexFile(entry.source, rootKey.slice(entry.source.length + 1), await fsp.stat(rootPath)); }
    catch (e) { console.error('post-reintegration reindex failed:', e.message); }
    return { bothId };
  });
}

// Called after every fan-out child's final event: when the whole group is
// settled, fold the branches home and tell every client where to look.
async function maybeSettleFanout(job) {
  if (!job.fanoutId) return;
  const group = [...agentRunJobs.values()].filter(j => j.fanoutId === job.fanoutId);
  if (group.length < (job.fanoutCount || 2)) return;
  if (group.some(j => j.status === 'running')) return;
  try {
    const ok = await reintegrateFanout(job.fanoutRootKey, job.fanoutId);
    if (ok) broadcast({ type: 'fanout-settled', key: job.fanoutRootKey, fanoutId: job.fanoutId, bothId: ok.bothId || null });
  } catch (e) { console.error('fan-out reintegration failed:', job.fanoutId, e.message); }
}

// Server restart safety net: hidden fork groups whose runs died with the
// old process would linger invisible forever. Fold them home at boot.
async function sweepOrphanFanouts() {
  const groups = new Map();
  for (const e of Object.values(index)) {
    if (e.hiddenFanout && e.fanoutId && e.fanoutRootKey) groups.set(e.fanoutId, e.fanoutRootKey);
  }
  for (const [fanoutId, rootKey] of groups) {
    if ([...agentRunJobs.values()].some(j => j.fanoutId === fanoutId && j.status === 'running')) continue;
    if (!index[rootKey]) continue;
    try {
      const ok = await reintegrateFanout(rootKey, fanoutId);
      if (ok) broadcast({ type: 'fanout-settled', key: rootKey, fanoutId, bothId: ok.bothId || null });
    } catch (e) { console.error('fan-out sweep failed:', fanoutId, e.message); }
  }
}

function isMergeBridgeText(text) {
  const t = String(text || '');
  if (/<!--\s*aiconvo:merge\s*-->/.test(t)) return true;
  return /^\d+ models answered my last message in parallel\./i.test(t.trim());
}
function isBothBridgeText(text) {
  return /<!--\s*aiconvo:both\s*-->/.test(String(text || ''));
}
function bridgeKindOf(text) {
  if (isMergeBridgeText(text)) return 'merge';
  if (isBothBridgeText(text)) return 'both';
  return undefined;
}
function isFanoutBridgeText(text) {
  return !!(isMergeBridgeText(text) || isBothBridgeText(text));
}
// The "both" entry writer lives in fanoutmerge.js with the rest of the
// reintegration logic.

// One assistant answer per direct branch. The pure fan-out classifier owns
// bridge scope, so a merge above this node cannot hide a later fan-out.
function answerBranchesUnder(tree, nodeId) {
  return fanoutLib.answersUnder(tree, nodeId);
}

async function compareGroupsResponse(key) {
  const tree = await sessionTreeFor(key, { withTexts: true });
  const byNodeId = new Map(tree.nodes.map(n => [n.id, n]));
  // Reply latency: from the user prompt above the answer to the answer's last message.
  const secsFor = a => {
    let p = a.parent != null ? byNodeId.get(a.parent) : null;
    while (p && p.role !== 'user') p = p.parent != null ? byNodeId.get(p.parent) : null;
    const start = Date.parse((p && (p.lastTs || p.ts)) || a.ts || '');
    const end = Date.parse(a.lastTs || a.ts || '');
    return start && end && end > start ? Math.round((end - start) / 1000) : null;
  };
  const answerView = a => ({
    id: a.id, key: a.key, model: a.model || null,
    text: String(a.fullText || '').slice(0, 16000),
    jumpTs: a.jumpTs, fork: !!a.fork,
    tok: a.tok || null, cost: a.cost || null, secs: secsFor(a),
  });
  const groups = fanoutLib.classifyFanoutGroups(tree).map(g => ({
    node: g.node,
    answers: g.answers.map(answerView),
    both: g.both ? { id: g.both.id, key: g.both.key, jumpTs: g.both.jumpTs } : null,
    merge: g.merge ? {
      bridgeId: g.merge.bridge.id,
      answer: answerView(g.merge.answer),
    } : null,
  }));
  return { key, groups };
}

// Aggregate: collect the answers that branch off a node, quote each with
// its model name, and continue on the original conversation from that node.
async function startAggregate(key, { node, provider, modelId, instruction, answers, force }) {
  const tree = await sessionTreeFor(key, { withTexts: true });
  let children = answerBranchesUnder(tree, node);
  // The user may deselect replies; merge only the picked ones (all by default).
  if (Array.isArray(answers) && answers.length) {
    const want = new Set(answers.map(String));
    children = children.filter(c => want.has(String(c.id)));
  }
  if (children.length < 2) throw new Error('pick at least two answer branches to merge');
  // Branch ids stay in the labels: the merge keeps its provenance in the transcript.
  const parts = children.map((c, i) =>
    `=== reply ${i + 1} of ${children.length} · ${c.model || 'unknown model'} · branch ${c.id} ===\n${c.fullText.trim()}`);
  const message = `${children.length} models answered my last message in parallel. Their replies:\n\n${parts.join('\n\n')}\n\n${String(instruction || '').trim() || 'You have the full conversation context. Write the single best reply to my last message. Take the strongest parts of these replies, fix their mistakes, and resolve their disagreements. Your reply replaces them: answer me directly, and do not describe the replies or this merge.'}\n\n<!-- aiconvo:merge -->`;
  const job = await startAgentRun(key, { node, provider, modelId, message, force });
  return { job, answers: children.length };
}

// A "both" node quotes every parallel reply as one assistant turn. Continue
// from it to keep every opinion in context without synthesizing a merge.
async function ensureBothBridge(key, node) {
  const { sessionPath } = sessionPathsFor(key);
  return withSessionOp(sessionPath, async () => {
    // Recheck inside the file lock. Two fast clicks must not add two bridges.
    const tree = await sessionTreeFor(key, { withTexts: true });
    const existing = tree.nodes.find(n => n.bridge === 'both' && n.parent === node);
    if (existing) return { id: existing.id, existed: true };
    const answers = answerBranchesUnder(tree, node);
    if (answers.length < 2) throw new Error('need two replies to keep both in context');
    const both = fanoutMerge.makeBothEntry(node, answers.map(a => ({ model: a.model, text: a.fullText })));
    stopAnyWarmSession(sessionPath);
    const raw = await fsp.readFile(sessionPath, 'utf8');
    const nl = !raw || raw.endsWith('\n') ? '' : '\n';
    await fsp.appendFile(sessionPath, nl + JSON.stringify(both) + '\n');
    const entry = index[key];
    try { await indexFile(entry.source, key.slice(entry.source.length + 1), await fsp.stat(sessionPath)); }
    catch (e) { console.error('both-bridge reindex failed:', e.message); }
    return { id: both.id, existed: false };
  });
}

// Set the conversation's model durably through pi's own runtime.
async function setConversationModel(key, provider, modelId, force) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Model switching needs pi.');
  if (!provider || !modelId) throw new Error('missing provider or model');
  const running = findRunningConversation(key);
  let reopen = false;
  if (running) {
    if (!force) {
      const err = new Error('A terminal owns this conversation (pid ' + running.pid + ').');
      err.needsForce = true;
      throw err;
    }
    await stopRunningAgent(running);
    await waitFileQuiet(sessionPath);
    reopen = true;
  }
  if (headlessRuns.has(sessionPath)) throw new Error('A web run is active on this conversation. Wait or abort it.');
  await withSessionOp(sessionPath, () => piEng().piSetModel({ sessionPath, cwd, env: agentEnv(), extraArgs: piProviderExtraArgs() }, provider, modelId));
  try { await indexFile(entry.source, key.slice(entry.source.length + 1), await fsp.stat(sessionPath)); } catch {}
  if (reopen) { try { await openConversationInTerminal(key, { focus: false }); } catch {} }
  return { ok: true, model: provider + '/' + modelId, reopened: reopen };
}

// Set the conversation's reasoning level durably through pi's own runtime.
async function setConversationThinking(key, level, force) {
  const { entry, sessionPath, cwd } = sessionPathsFor(key);
  if (conversationKind(entry) === 'claude') throw new Error('Reasoning control needs pi.');
  if (level !== 'cycle' && !settingsLib.THINKING_LEVELS.includes(level)) throw new Error('bad level: ' + level);
  const running = findRunningConversation(key);
  let reopen = false;
  if (running) {
    if (!force) {
      const err = new Error('A terminal owns this conversation (pid ' + running.pid + ').');
      err.needsForce = true;
      throw err;
    }
    await stopRunningAgent(running);
    await waitFileQuiet(sessionPath);
    reopen = true;
  }
  if (headlessRuns.has(sessionPath)) throw new Error('A web run is active on this conversation. Wait or abort it.');
  const out = await withSessionOp(sessionPath, () => piEng().piSetThinking({ sessionPath, cwd, env: agentEnv(), extraArgs: piProviderExtraArgs() }, level));
  try { await indexFile(entry.source, key.slice(entry.source.length + 1), await fsp.stat(sessionPath)); } catch {}
  if (reopen) { try { await openConversationInTerminal(key, { focus: false }); } catch {} }
  return { ok: true, level: out.level, levels: out.levels, reopened: reopen };
}

// ---------- distillation ----------
// Two steps. Step 1 maps the full conversation into a problem tree.
// Step 2 distills each problem with generous context (too much beats too little).
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

// ---------- project folds ----------
// One project can live under several directories: git worktrees, renamed
// checkouts, second clones. Folds collapse those raw names into one canonical
// project, so memory, epics, briefings, search, and the Gantt agree.
// Manual folds (aliases) are user data under the notes tree; automatic
// worktree folds are a derived cache rebuilt from git. Logic: projectfolds.js.
const PROJECT_ALIASES_FILE = path.join(NOTES_DIR, 'projects', 'aliases.json');
const PROJECT_FOLDS_CACHE = path.join(CACHE_DIR, 'project-folds.json');
let foldStore = { aliases: {}, dismissed: [] };
try { foldStore = { aliases: {}, dismissed: [], ...JSON.parse(fs.readFileSync(PROJECT_ALIASES_FILE, 'utf8')) }; } catch {}
let autoFolds = {};
try { autoFolds = JSON.parse(fs.readFileSync(PROJECT_FOLDS_CACHE, 'utf8')).auto || {}; } catch {}

function saveFoldStore() {
  fs.mkdirSync(path.dirname(PROJECT_ALIASES_FILE), { recursive: true });
  fs.writeFileSync(PROJECT_ALIASES_FILE, JSON.stringify(foldStore, null, 2) + '\n');
}

function canonicalProjectName(raw) {
  return foldsLib.canonicalize(raw, foldStore.aliases, autoFolds);
}

async function assignConversationProject(key, rawProject) {
  if (!key || !index[key]) throw new Error('unknown conversation');
  const oldProject = projectNameOf(index[key].cwd, key);
  const requested = String(rawProject || '').trim();
  if (!requested) delete conversationProjects[key];
  else {
    const project = canonicalProjectName(requested);
    if (!project || project === '?' || project === LOOSE_PROJECT) throw new Error('select a real project');
    if (!projectMetaFor(project)) throw new Error('unknown project: ' + project);
    conversationProjects[key] = project;
  }
  await fsp.mkdir(path.dirname(CONVERSATION_PROJECTS_FILE), { recursive: true });
  await writeFileAtomic(CONVERSATION_PROJECTS_FILE, JSON.stringify(conversationProjects, null, 2) + '\n');
  const project = projectNameOf(index[key].cwd, key);
  try { if (searchIdx) searchIdx.setProject('conv:' + key, project); } catch {}
  if (oldProject !== LOOSE_PROJECT) scheduleDocsRegen(oldProject);
  if (project !== LOOSE_PROJECT && project !== oldProject) scheduleDocsRegen(project);
  broadcast({ type: 'conversation-project', key, project });
  return { ok: true, key, project };
}

// Model choices are user preferences, not derived cache. Keep one project
// default and one explicit model set per conversation, shared by every UI
// connected to this server.
const MODEL_PREFS_FILE = path.join(NOTES_DIR, 'model-preferences.json');
let modelPrefs = { projects: {}, conversations: {}, context: {} };
try {
  modelPrefs = { projects: {}, conversations: {}, context: {}, ...JSON.parse(fs.readFileSync(MODEL_PREFS_FILE, 'utf8')) };
} catch {}
if (!modelPrefs.context || typeof modelPrefs.context !== 'object' || Array.isArray(modelPrefs.context)) modelPrefs.context = {};
function normalizePickedModel(raw) {
  const provider = String(raw && raw.provider || '').trim();
  const modelId = String(raw && (raw.modelId || raw.model) || '').trim();
  return provider && modelId ? { provider, modelId } : null;
}
function normalizePickedModels(raw) {
  const out = [], seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const model = normalizePickedModel(item);
    if (!model) continue;
    const id = model.provider + '/' + model.modelId;
    if (!seen.has(id)) { seen.add(id); out.push(model); }
  }
  return out.slice(0, 12);
}
function saveModelPrefs() {
  fs.mkdirSync(path.dirname(MODEL_PREFS_FILE), { recursive: true });
  const tmp = MODEL_PREFS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(modelPrefs, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, MODEL_PREFS_FILE);
}
function projectDefaultModel(project) {
  return normalizePickedModel(modelPrefs.projects[canonicalProjectName(String(project || ''))]);
}
function resolvedProjectDefaultModel(project) {
  const explicit = projectDefaultModel(project);
  if (explicit) return { ...explicit, source: 'project' };
  const pi = readPiDefault();
  const fallback = normalizePickedModel({ provider: pi.provider, modelId: pi.model });
  return fallback ? { ...fallback, source: 'pi' } : null;
}
function setProjectDefaultModel(project, raw) {
  const key = canonicalProjectName(String(project || ''));
  if (!projectMetaFor(key)) throw new Error('project not found');
  const model = normalizePickedModel(raw);
  if (model) modelPrefs.projects[key] = model;
  else delete modelPrefs.projects[key];
  saveModelPrefs();
  return { ok: true, model: projectDefaultModel(key), resolved: resolvedProjectDefaultModel(key) };
}
function saveConversationModels(key, raw) {
  if (!index[key]) throw new Error('conversation not found');
  const models = normalizePickedModels(raw);
  if (!models.length) throw new Error('pick at least one model');
  modelPrefs.conversations[key] = models;
  saveModelPrefs();
  return models;
}
const MEMORY_DOC_KINDS = ['overview', 'intent', 'environment', 'status'];
function normalizeContextItems(raw) {
  const out = [], seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (item && item.type === 'chat') {
      const key = String(item.key || '').trim();
      if (!key) continue;
      const idx = Number.isInteger(item.i) ? item.i : null;
      const id = 'chat\0' + key + '\0' + (idx == null ? '*' : String(idx));
      if (seen.has(id)) continue;
      seen.add(id);
      const row = { type: 'chat', key };
      if (idx != null) row.i = idx;
      if (item.title) row.title = String(item.title).replace(/\s+/g, ' ').trim().slice(0, 80);
      out.push(row);
      continue;
    }
    const project = String(item && item.project || '').trim();
    if (!project) continue;
    const kinds = [];
    if (item.kind === 'map' || item.kind === 'all') kinds.push('map');
    else if (typeof item.kind === 'string' && MEMORY_DOC_KINDS.includes(item.kind)) kinds.push(item.kind);
    if (Array.isArray(item.kinds)) {
      for (const k of item.kinds) {
        if (k === 'map' || k === 'all' || MEMORY_DOC_KINDS.includes(k)) kinds.push(k === 'all' ? 'map' : k);
      }
    }
    for (const kind of kinds) {
      const id = project + '\0' + kind;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ project, kind });
    }
  }
  return out.slice(0, 24);
}
function conversationContextOf(key) {
  return normalizeContextItems(modelPrefs.context && modelPrefs.context[key]);
}
function saveConversationContext(key, raw) {
  if (!index[key]) throw new Error('conversation not found');
  const items = normalizeContextItems(raw);
  if (items.length) modelPrefs.context[key] = items;
  else delete modelPrefs.context[key];
  saveModelPrefs();
  return items;
}
async function inferredConversationModels(key, cached) {
  if (conversationKind(index[key]) === 'claude') return [];
  const stored = normalizePickedModels(modelPrefs.conversations[key]);
  if (stored.length) return stored;
  const remember = models => {
    const normalized = normalizePickedModels(models);
    if (normalized.length) {
      modelPrefs.conversations[key] = normalized;
      saveModelPrefs();
    }
    return normalized;
  };
  // The usual case needs no native-session parse: the cached active path
  // already carries the provider and model on its latest assistant reply.
  const last = [...(cached && cached.messages || [])].reverse()
    .find(m => !m.off && m.role === 'assistant' && m.provider && m.model);
  if (last) return remember([{ provider: last.provider, modelId: last.model }]);
  try {
    const { sessionPath } = sessionPathsFor(key);
    const nodes = parseTreeEntries('pi', await fsp.readFile(sessionPath, 'utf8'));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const seen = new Set();
    for (let node = nodes[nodes.length - 1]; node && !seen.has(node.id); node = node.parent ? byId.get(node.parent) : null) {
      seen.add(node.id);
      const raw = node.modelChange
        ? { provider: node.modelChange.provider, modelId: node.modelChange.model }
        : node.model ? { provider: node.provider, modelId: node.model } : null;
      const model = normalizePickedModel(raw);
      if (model) return remember([model]);
      if (raw && raw.modelId) {
        const hits = (modelsCache.models || []).filter(m => m.model === raw.modelId);
        if (hits.length === 1) return remember([{ provider: hits[0].provider, modelId: hits[0].model }]);
      }
    }
  } catch {}
  const entry = index[key];
  const fallback = entry && resolvedProjectDefaultModel(projectOfEntry(entry, key));
  return fallback ? remember([{ provider: fallback.provider, modelId: fallback.modelId }]) : [];
}

// A linked worktree's cwd resolves to the MAIN worktree root; that is the
// automatic fold. `--git-common-dir` points at the shared .git; for the main
// worktree itself dirname(common) === toplevel, so nothing folds.
const worktreeMainCache = new Map(); // cwd -> { at, main }
async function worktreeMainRootFor(cwd) {
  const hit = worktreeMainCache.get(cwd);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.main;
  let main = '';
  try {
    const [toplevel, common] = await Promise.all([
      gitText(cwd, ['rev-parse', '--show-toplevel']),
      gitText(cwd, ['rev-parse', '--git-common-dir']),
    ]);
    const top = path.resolve(cwd, toplevel.trim());
    const commonDir = path.resolve(cwd, common.trim());
    if (path.basename(commonDir) === '.git') {
      const root = path.dirname(commonDir);
      if (root && root !== top) main = root;
    }
  } catch {}
  worktreeMainCache.set(cwd, { at: Date.now(), main });
  return main;
}

let foldRefreshTimer = null;
const foldCheckedCwds = new Set();
// A newly indexed cwd may be an unseen worktree: probe soon, debounced.
function scheduleProjectFoldRefresh(cwd) {
  if (!cwd || foldCheckedCwds.has(cwd)) return;
  foldCheckedCwds.add(cwd);
  clearTimeout(foldRefreshTimer);
  foldRefreshTimer = setTimeout(() => { refreshProjectFolds().catch(() => {}); }, 3000);
}

const sortedJson = obj => JSON.stringify(Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])));

// Rebuild the automatic worktree folds from every conversation cwd.
async function refreshProjectFolds() {
  const cwds = [...new Set(Object.values(index).map(e => e && e.cwd).filter(Boolean))];
  const auto = {};
  await mapLimit(cwds, 8, async cwd => {
    foldCheckedCwds.add(cwd);
    const main = await worktreeMainRootFor(cwd);
    if (!main) return;
    const from = foldsLib.rawProjectOf(cwd);
    const into = foldsLib.rawProjectOf(main);
    if (from === LOOSE_PROJECT || into === LOOSE_PROJECT) return;
    if (from !== into) auto[from] = into;
  });
  if (sortedJson(auto) === sortedJson(autoFolds)) return false;
  autoFolds = auto;
  fsp.writeFile(PROJECT_FOLDS_CACHE, JSON.stringify({ scannedAt: Date.now(), auto })).catch(() => {});
  applyProjectFoldChange();
  return true;
}

// After any fold change: fix the baked project column in the search index,
// drop caches that carry project names, and tell every client to refetch.
function applyProjectFoldChange() {
  if (searchIdx) {
    for (const [key, entry] of Object.entries(index)) {
      try { searchIdx.setProject('conv:' + key, projectNameOf(entry.cwd, key)); } catch {}
    }
  }
  gitRepoIndexCache.at = 0;
  foldSuggestionsCache.at = 0;
  broadcast({ type: 'project-folds' });
}

const remoteUrlCache = new Map(); // repo root -> { at, remote }
async function gitRemoteFor(root) {
  const hit = remoteUrlCache.get(root);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.remote;
  let remote = '';
  try { remote = (await gitText(root, ['config', '--get', 'remote.origin.url'])).trim(); } catch {}
  remoteUrlCache.set(root, { at: Date.now(), remote });
  return remote;
}

// Fold suggestions: same git remote or a name-shape twin. Quiet evidence,
// never an action; at least one side must have conversations on record.
let foldSuggestionsCache = { at: 0, list: [] };
async function projectFoldSuggestions() {
  if (Date.now() - foldSuggestionsCache.at < 60000) return foldSuggestionsCache.list;
  const counts = {};
  for (const [key, entry] of Object.entries(index)) {
    if (!entry) continue;
    const p = projectOfEntry(entry, key);
    if (p === LOOSE_PROJECT) continue;
    counts[p] = (counts[p] || 0) + 1;
  }
  const remotes = {};
  let repos = [];
  try { repos = await discoverGitRepos(); } catch {}
  await mapLimit(repos, 8, async repo => {
    const remote = foldsLib.normalizeRemote(await gitRemoteFor(repo.root));
    if (!remote) return;
    const p = projectNameOf(repo.root);
    (remotes[p] = remotes[p] || new Set()).add(remote);
  });
  const remoteLists = Object.fromEntries(Object.entries(remotes).map(([k, v]) => [k, [...v]]));
  const list = foldsLib.suggestPairs(counts, remoteLists, foldStore.dismissed || [])
    .filter(s => (counts[s.from] || 0) + (counts[s.into] || 0) > 0);
  foldSuggestionsCache = { at: Date.now(), list };
  return list;
}

async function foldProjects(from, into) {
  from = String(from || '').trim();
  into = String(into || '').trim();
  if (from === LOOSE_PROJECT || into === LOOSE_PROJECT) throw new Error('loose conversations are a collection, not a project');
  foldsLib.foldAlias(foldStore, from, into);
  saveFoldStore();
  // The folded project's memory dir may hold human-written, vouched intent
  // (and area docs). Never delete it: archive it under .folded/, out of the
  // active name space. The docs are regenerable, the human words are not.
  const fromDir = projectMemoryPaths(from).dir;
  if (fs.existsSync(fromDir)) {
    try {
      const graveyard = path.join(PROJECT_MEMORY_DIR, '.folded');
      fs.mkdirSync(graveyard, { recursive: true });
      fs.renameSync(fromDir, path.join(graveyard, projectMemorySlug(from) + '-' + Date.now()));
    } catch { try { fs.rmSync(fromDir, { recursive: true, force: true }); } catch {} }
  }
  try { fs.rmSync(projectMemoryPaths(from).inputs, { force: true }); } catch {} // derived cache only
  applyProjectFoldChange();
  // The target's memory (when built) absorbs the merged conversation set soon.
  scheduleDocsRegen(into, 60 * 1000);
  return projectFoldsResponse();
}

async function unfoldProject(name) {
  foldsLib.unfold(foldStore, String(name || '').trim(), autoFolds);
  saveFoldStore();
  applyProjectFoldChange();
  return projectFoldsResponse();
}

async function dismissFoldSuggestion(from, into) {
  const key = foldsLib.dismissKey(from, into);
  foldStore.dismissed = foldStore.dismissed || [];
  if (!foldStore.dismissed.includes(key)) foldStore.dismissed.push(key);
  saveFoldStore();
  foldSuggestionsCache.at = 0;
  return projectFoldsResponse();
}

// ---- created projects (directory-first birth registry) ----
// A project born in aiconvo exists on disk before any conversation. The
// registry pins it into the project list until real conversations take over.
// It records durable human intent, so it lives in ~/notes, not the cache.
const CREATED_PROJECTS_FILE = path.join(NOTES_DIR, 'projects.json');
let createdProjects = {}; // raw project name -> { cwd, createdAt, adopted? }
try { createdProjects = JSON.parse(fs.readFileSync(CREATED_PROJECTS_FILE, 'utf8')); } catch { createdProjects = {}; }
function saveCreatedProjects() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(CREATED_PROJECTS_FILE, JSON.stringify(createdProjects, null, 2) + '\n');
}
function createdRecordFor(project) {
  for (const [name, rec] of Object.entries(createdProjects)) {
    if (name === project || canonicalProjectName(name) === project) return rec;
  }
  return null;
}
function createdProjectsList() {
  return Object.entries(createdProjects).map(([name, rec]) => ({
    name: canonicalProjectName(name), cwd: rec.cwd || '', createdAt: rec.createdAt || 0,
  }));
}

// ---- areas (declared inner scopes) ----
// An area is the inverse of a fold: it splits one project into declared
// inner places. The registry is user data under the notes tree. Membership
// is a pure function of cwd + registry, so declaring an area over an
// existing folder adopts its past conversations retroactively, and removing
// an area only removes the scope — folders and conversations stay.
const PROJECT_AREAS_FILE = path.join(NOTES_DIR, 'projects', 'areas.json');
let areaStore = {}; // project name (as declared) -> { rel: { createdAt, title? } }
try { areaStore = JSON.parse(fs.readFileSync(PROJECT_AREAS_FILE, 'utf8')); } catch { areaStore = {}; }
if (!areaStore || typeof areaStore !== 'object' || Array.isArray(areaStore)) areaStore = {};
function saveAreaStore() {
  fs.mkdirSync(path.dirname(PROJECT_AREAS_FILE), { recursive: true });
  fs.writeFileSync(PROJECT_AREAS_FILE, JSON.stringify(areaStore, null, 2) + '\n');
}
// Declared areas of a canonical project. Registry keys canonicalize, so
// areas survive project folds. Matching is rel-path based, so worktree
// checkouts share the same areas as the main checkout.
function declaredAreasFor(project) {
  const out = {};
  for (const [name, areas] of Object.entries(areaStore)) {
    if (name !== project && canonicalProjectName(name) !== project) continue;
    for (const [rel, rec] of Object.entries(areas || {})) out[rel] = rec || {};
  }
  return out;
}
function areaOfCwdIn(project, cwd, declaredRels = Object.keys(declaredAreasFor(project))) {
  if (!declaredRels.length || !cwd) return null;
  return areasLib.deepestAreaOf(areasLib.relOfCwd(cwd), declaredRels);
}
function areaMemoryPaths(project, rel) {
  const dir = path.join(PROJECT_MEMORY_DIR, projectMemorySlug(project), 'areas', areasLib.areaSlug(rel));
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    overview: path.join(dir, 'overview.md'),
    intent: path.join(dir, 'intent.md'),
    environment: path.join(dir, 'environment.md'),
    status: path.join(dir, 'status.md'),
    inputs: path.join(PROJECT_MEMORY_INPUTS_DIR, projectMemorySlug(project) + '-area-' + areasLib.areaSlug(rel) + '-pyramid.json'),
  };
}
// The area's slice of the project: entries whose cwd sits under the area
// folder (inclusive), plus the resolved area folder itself.
function areaMetaFor(project, rel) {
  const meta = projectMetaFor(project);
  if (!meta) return null;
  const declared = declaredAreasFor(project);
  if (!(rel in declared)) return null;
  const entries = meta.entries.filter(({ entry }) =>
    entry.cwd && areasLib.relInArea(areasLib.relOfCwd(entry.cwd), rel));
  return { project, rel, record: declared[rel], entries, cwd: meta.cwd ? path.join(meta.cwd, rel) : null, meta };
}

// ---- project display titles (auto + manual + AI retitle) ----
// The big human-facing headline on the project panel. It is durable human/AI
// intent, so it lives in ~/notes next to the created-project registry.
const PROJECT_TITLES_FILE = path.join(NOTES_DIR, 'project-titles.json');
let projectTitles = {}; // canonical project name -> { title, manual, at }
try { projectTitles = JSON.parse(fs.readFileSync(PROJECT_TITLES_FILE, 'utf8')); } catch { projectTitles = {}; }
function saveProjectTitles() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(PROJECT_TITLES_FILE, JSON.stringify(projectTitles, null, 2) + '\n');
}

function setProjectTitle(project, rawTitle, manual = true) {
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('empty title');
  projectTitles[project] = { title, manual, at: Date.now() };
  saveProjectTitles();
  broadcast({ type: 'project-title', project, title, manual });
  return { project, title, manual };
}

const PROJECT_RETITLE_PROMPT =
  'The attached JSON describes one work project: its folder name, path, overview (when one exists), and recent conversation titles. ' +
  'Write the display title for this project on a personal dashboard. Reply with STRICT JSON only, no prose or code fence: {"title":"..."} — ' +
  'a short, dense, honest title, 2 to 6 words, at most 48 characters, no trailing period, ' +
  'no filler words such as project, repo, tool, app unless they are the essence of the work.';

// Retitle one project on demand, from its memory overview and recent work.
async function retitleProject(project, manual = true) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const memory = await projectMemoryInfo(project, meta).catch(() => null);
  const o = (memory && memory.overview) || {};
  const recent = [...meta.entries]
    .sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''))
    .slice(0, 12)
    .map(({ entry }) => entry.title || entry.timelineTitle || '')
    .filter(Boolean);
  const payload = {
    folderName: project, path: meta.cwd || '',
    identity: o.identity || '', overview: o.summary || '',
    recentConversationTitles: recent,
  };
  const raw = await runPi(JSON.stringify(payload), PROJECT_RETITLE_PROMPT);
  const parsed = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  return setProjectTitle(project, parsed.title, manual);
}

// Epic titles: an epic is a recursive project, so it renames the same way.
function setEpicTitle(id, rawTitle) {
  const epic = epics[id];
  if (!epic) throw new Error('unknown epic');
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('empty title');
  epic.title = title;
  saveEpics();
  return { id, title };
}

async function retitleEpic(id) {
  const epic = epics[id];
  if (!epic) throw new Error('unknown epic');
  const payload = {
    folderName: epic.title || 'epic', path: '',
    identity: '', overview: epic.abstract || '',
    recentConversationTitles: (epic.sessionIds || [])
      .map(k => (index[k] && (index[k].title || index[k].timelineTitle)) || '')
      .filter(Boolean).slice(0, 20),
  };
  const raw = await runPi(JSON.stringify(payload), PROJECT_RETITLE_PROMPT);
  const parsed = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  return setEpicTitle(id, parsed.title);
}

// Auto title: a titleless project names itself the first time its panel opens.
// A manual (or earlier AI) title always blocks this.
const projectTitleInFlight = new Set();
function maybeAutoProjectTitle(project) {
  if (projectTitles[project]) return;
  if (projectTitleInFlight.has(project)) return;
  projectTitleInFlight.add(project);
  setTimeout(() => {
    retitleProject(project, false)
      .catch(e => console.error('auto project title failed:', project, e.message))
      .finally(() => projectTitleInFlight.delete(project));
  }, 500);
}

function rawProjectNames() {
  const names = new Set();
  for (const entry of Object.values(index)) if (entry && entry.cwd) names.add(foldsLib.rawProjectOf(entry.cwd));
  for (const name of Object.keys(createdProjects)) names.add(name);
  return names;
}

async function projectFoldsResponse() {
  return {
    map: foldsLib.flattenMap(rawProjectNames(), foldStore.aliases, autoFolds),
    aliases: foldStore.aliases, auto: autoFolds, dismissed: foldStore.dismissed || [],
    created: createdProjectsList(),
    areas: clientAreasMap(),
    suggestions: await projectFoldSuggestions(),
  };
}

// Canonical project -> declared area rels, for the client's area labels
// and grouping. Small: only declared areas appear.
function clientAreasMap() {
  const out = {};
  for (const name of Object.keys(areaStore)) {
    const project = canonicalProjectName(name);
    for (const [rel, rec] of Object.entries(areaStore[name] || {})) {
      (out[project] = out[project] || {})[rel] = { title: (rec && rec.title) || null };
    }
  }
  return out;
}

// Raw names that fold into this canonical project, with the fold kind.
function foldedFromFor(project) {
  const names = rawProjectNames();
  for (const k of Object.keys(foldStore.aliases)) names.add(k);
  for (const k of Object.keys(autoFolds)) names.add(k);
  const out = [];
  for (const name of names) {
    if (name === project || canonicalProjectName(name) !== project) continue;
    out.push({ name, kind: foldStore.aliases[name] ? 'alias' : 'auto' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
const SETTINGS_FILE = path.join(os.homedir(), '.config', 'aiconvo', 'settings.json');
const THEMES_DIR = themesLib.defaultThemeDir(os.homedir());
const PI_SETTINGS_FILE = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
const PI_AUTH_FILE = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
const PI_MODELS_FILE = path.join(os.homedir(), '.pi', 'agent', 'models.json');
const CLAUDE_CODE_CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_CODE_EXT = path.join(os.homedir(), '.pi', 'agent', 'extensions', 'claude-code-fable-5', 'index.ts');
let appSettings = settingsLib.normalizeSettings(settingsLib.DEFAULT_SETTINGS);
try { appSettings = settingsLib.normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
function saveAppSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2) + '\n', { mode: 0o600 });
}
function readPiDefault() {
  try {
    const raw = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
    return { provider: raw.defaultProvider || '', model: raw.defaultModel || '' };
  } catch { return { provider: '', model: '' }; }
}
function readyProviders() {
  const ready = new Set();
  try {
    for (const name of Object.keys(JSON.parse(fs.readFileSync(PI_AUTH_FILE, 'utf8')))) ready.add(name);
  } catch {}
  // claude-code auth lives in the Claude Code CLI login, not Pi auth.json.
  try {
    if (settingsLib.hasClaudeCodeCredential(JSON.parse(fs.readFileSync(CLAUDE_CODE_CRED_FILE, 'utf8')))) {
      ready.add('claude-code');
    }
  } catch {}
  // Custom providers (models.json) carry their own baseUrl/apiKey — a
  // homelab endpoint needs no login, so it counts as ready.
  try {
    const custom = JSON.parse(fs.readFileSync(PI_MODELS_FILE, 'utf8'));
    for (const name of Object.keys(custom.providers || {})) ready.add(name);
  } catch {}
  return [...ready];
}
// The catalog survives restarts: the last GOOD list serves instantly while
// a fresh fetch runs in the background.
const MODELS_CATALOG_FILE = path.join(CACHE_DIR, 'models-catalog.json');
let modelsCache = { at: 0, models: [], text: '', error: null };
try {
  const saved = JSON.parse(fs.readFileSync(MODELS_CATALOG_FILE, 'utf8'));
  if (saved && saved.text) modelsCache = { at: 0, models: settingsLib.parseListModels(saved.text), text: saved.text, error: null };
} catch {}
let modelsPending = null;
let modelsSmallSeen = null; // row count of the last rejected small fetch
function listPiModels(force = false) {
  if (!force && modelsCache.models.length) {
    // Serve the last good catalog at once. An expired catalog refreshes in
    // the background, so opening a picker never waits for a Pi process.
    if (Date.now() - modelsCache.at >= 5 * 60 * 1000 && !modelsPending) {
      setImmediate(() => listPiModels(true).catch(() => {}));
    }
    return Promise.resolve(modelsCache);
  }
  if (modelsPending) return modelsPending;
  modelsPending = new Promise(resolve => {
    execFile('pi', ['--list-models'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parsed = err ? [] : settingsLib.parseListModels(stdout);
      if (err) {
        modelsCache = {
          at: Date.now(),
          models: modelsCache.models || [],
          text: modelsCache.text || '',
          error: String(stderr || '').trim() || err.message,
        };
      } else if (modelsCache.models.length >= 20 && parsed.length < modelsCache.models.length * 0.6
                 && !(modelsSmallSeen && Math.abs(parsed.length - modelsSmallSeen) <= Math.max(3, parsed.length * 0.1))) {
        // pi can exit 0 with a half-printed table when one provider fetch
        // dies mid-stream. A list that lost most of the catalog is such a
        // truncated print: keep the good list, note the failure. A real
        // shrink (a provider signed out) repeats — two agreeing small
        // fetches in a row are accepted.
        modelsSmallSeen = parsed.length;
        modelsCache = {
          at: Date.now(), models: modelsCache.models, text: modelsCache.text,
          error: `pi returned a partial list (${parsed.length} of ${modelsCache.models.length} models) — kept the previous catalog`,
        };
      } else {
        modelsSmallSeen = null;
        modelsCache = { at: Date.now(), models: parsed, text: stdout, error: null };
        fs.writeFile(MODELS_CATALOG_FILE, JSON.stringify({ at: modelsCache.at, text: stdout }), () => {});
      }
      modelsPending = null;
      resolve(modelsCache);
    });
  });
  return modelsPending;
}
function piArgs() {
  return settingsLib.buildPiArgs(appSettings, {
    claudeCodeExtension: fs.existsSync(CLAUDE_CODE_EXT) ? CLAUDE_CODE_EXT : '',
  });
}
function piContextTokens() {
  return appSettings.contextTokens || settingsLib.DEFAULT_CONTEXT_TOKENS;
}
function piTargetTokens() { return Math.floor(piContextTokens() * 0.80); }
function currentModelLabel() { return settingsLib.modelLabel(appSettings, readPiDefault()); }
function settingsResponse() {
  const piDefault = readPiDefault();
  return {
    settings: appSettings,
    resolved: {
      provider: appSettings.usePiDefault ? piDefault.provider : appSettings.provider,
      model: appSettings.usePiDefault ? piDefault.model : appSettings.model,
      label: currentModelLabel(),
      contextTokens: piContextTokens(),
      thinking: appSettings.thinking,
    },
    piDefault,
    readyProviders: readyProviders(),
    path: SETTINGS_FILE,
  };
}

function usageRange(searchParams) {
  const now = Date.now();
  const raw = searchParams.get('days') || '30';
  if (raw === 'all') return { fromMs: 0, toMs: now, days: 'all' };
  const days = Math.max(1, Math.min(3650, Number(raw) || 30));
  return { fromMs: now - days * 86400000, toMs: now, days };
}

function usageIndexEntries() {
  const entries = Object.entries(index).map(([key, entry]) => [key, {
    ...entry,
    project: projectNameOf(entry.cwd, key) || 'Unknown project',
  }]);
  try {
    const stat = fs.statSync(INTERNAL_USAGE_FILE);
    entries.push(['aiconvo:internal', {
      source: 'pi', mtimeMs: stat.mtimeMs, size: stat.size,
      firstTs: null, lastTs: new Date(stat.mtimeMs).toISOString(), project: 'Aiconvo system',
    }]);
  } catch {}
  return entries;
}

function usageDashboardResponse(searchParams) {
  if (!usageIdx) return { error: 'Token analytics needs node:sqlite, which is unavailable.' };
  const catalog = pricingCatalog();
  usageIdx.startSync(usageIndexEntries(), absPathForKey, catalog).catch(error => {
    console.error('usage index', error.message);
  });
  const range = usageRange(searchParams);
  const filters = {};
  for (const key of ['project', 'provider', 'model', 'billing']) {
    const value = searchParams.get(key);
    if (value) filters[key] = value;
  }
  const facts = usageIdx.facts(range.fromMs, range.toMs);
  const data = usageLib.aggregateFacts(facts, {
    ...range, filters, billing: appSettings.usageBilling, authTypes: usageAuthTypes(),
  });
  return {
    ...data,
    range,
    filters,
    billingConfig: appSettings.usageBilling,
    status: usageIdx.status(),
    catalogSources: catalog.sources,
    generatedAt: Date.now(),
    terminology: {
      estimatedCost: 'Catalog API-equivalent value. It is not a provider invoice.',
      apiCost: 'Catalog estimate for calls classified as API billed.',
      subscriptionValue: 'Estimated API retail value for subscription calls.',
    },
  };
}
// Code and JSON can use close to one token per two bytes. This is safer than chars / 4.
const estimateInputTokens = text => Math.max(
  Math.ceil(Buffer.byteLength(String(text), 'utf8') / 2),
  Math.ceil(String(text).split(/\s+/).filter(Boolean).length * 1.35),
);

function splitTextToTokenBudget(text, tokenBudget) {
  if (tokenBudget == null) tokenBudget = piTargetTokens();
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
    // JSON mode gives the final provider usage. These no-session calls were
    // previously invisible to every cost report.
    const child = execFile('pi', [...piArgs(), '--mode', 'json', '@' + tmp, prompt], { maxBuffer: 64 * 1024 * 1024, timeout: 1800000 },
      (err, stdout, stderr) => {
        fs.unlink(tmp, () => {});
        let finalMessage = null;
        for (const line of String(stdout).split('\n')) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'message_end' && event.message && event.message.role === 'assistant') finalMessage = event.message;
        }
        if (finalMessage && finalMessage.usage) {
          const record = {
            type: 'message', id: crypto.randomUUID(), parentId: null,
            timestamp: new Date(finalMessage.timestamp || Date.now()).toISOString(),
            aiconvoCategory: 'internal',
            message: { ...finalMessage, content: [] },
          };
          try { fs.appendFileSync(INTERNAL_USAGE_FILE, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch {}
        }
        if (err) return reject(new Error(stderr.trim() || err.message));
        if (!finalMessage) return resolve(String(stdout).trim());
        resolve(textOf(finalMessage.content).trim());
      });
    child.stdin.end(); // pi -p waits for stdin EOF otherwise
    if (onChunk) {
      let carry = '';
      child.stdout.on('data', data => {
        carry += String(data);
        const lines = carry.split('\n');
        carry = lines.pop() || '';
        for (const line of lines) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          const update = event.type === 'message_update' && event.assistantMessageEvent;
          if (update && update.type === 'text_delta') onChunk(String(update.delta || ''));
        }
      });
    }
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
    if (saved && saved.manual) return false; // never overwrite a user-owned title
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

// ---- per-conversation title overrides (manual edit + user-requested AI retitle) ----

// Store a durable title override. It wins over re-indexing and the background labeler;
// only another explicit override replaces it.
async function applyTitleOverride(key, fullTitle, shortTitle) {
  const entry = index[key];
  timelineTitles[key] = { hash: entry.timelineTitleHash, title: shortTitle, fullTitle, manual: true };
  entry.title = fullTitle;
  entry.timelineTitle = shortTitle;
  try {
    const file = cachePathFor(key);
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    data.title = fullTitle;
    data.timelineTitle = shortTitle;
    await fsp.writeFile(file, JSON.stringify(data));
  } catch {}
  saveTimelineTitles();
  saveIndexSoon();
  broadcast({ type: 'timeline-titles', titles: [{ key, title: shortTitle, fullTitle, manual: true }] });
  return { key, title: fullTitle, timelineTitle: shortTitle, manual: true };
}

async function setConversationTitle(key, rawTitle) {
  if (!index[key]) throw new Error('unknown conversation');
  const fullTitle = String(rawTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!fullTitle) throw new Error('empty title');
  return applyTitleOverride(key, fullTitle, timelineTitle(fullTitle));
}

const RETITLE_PROMPT =
  'The attached JSON array contains the opening user messages of one AI work conversation, in order. ' +
  'Name the actual work. Reply with STRICT JSON only, no prose or code fence: {"title":"...","label":"..."} — ' +
  'title: a short, dense noun phrase for the work, 3 to 7 words, at most 60 characters, no filler words, ' +
  'no trailing period, no generic words such as conversation, session, request, help; ' +
  'label: the same work in at most 10 characters, no period.';

// Auto retitle: fire once, when a conversation crosses from fewer than two real
// user messages to two or more. A manual/override title always blocks this.
const autoRetitleInFlight = new Set();
function maybeAutoRetitle(key, prev, entry) {
  const saved = timelineTitles[key];
  if (saved && saved.manual) return; // a person (or an earlier retitle) owns this title
  if (entry.realUserCount < 2) return;
  const crossed = prev
    ? Number(prev.realUserCount ?? NaN) < 2
    : !!entry.firstTs && Date.now() - entry.firstTs < 10 * 60 * 1000; // brand-new file, still fresh
  if (!crossed) return;
  if (autoRetitleInFlight.has(key)) return;
  autoRetitleInFlight.add(key);
  setTimeout(() => {
    retitleConversation(key)
      .catch(e => console.error('auto retitle failed:', key, e.message))
      .finally(() => autoRetitleInFlight.delete(key));
  }, 2000);
}

// Retitle one conversation on demand, from its first real (non-bootstrap) user messages.
async function retitleConversation(key) {
  if (!index[key]) throw new Error('unknown conversation');
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const users = data.messages.filter(m => m.role === 'user' && String(m.text || '').trim());
  const real = users.filter(m => !isBootstrapMessage(m.text));
  const chosen = (real.length ? real : users).slice(0, 4).map(m => String(m.text).slice(0, 2000));
  if (!chosen.length) throw new Error('no user messages to title from');
  const raw = await runPi(JSON.stringify(chosen), RETITLE_PROMPT);
  const parsed = JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, ''));
  const fullTitle = String(parsed.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!fullTitle) throw new Error('the model returned no title');
  const shortTitle = timelineTitle(String(parsed.label || parsed.title)).slice(0, 10);
  return applyTitleOverride(key, fullTitle, shortTitle);
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

// Evidence-state memo for the project page. The state of one conversation
// depends on exactly two files: its own cache (content hash) and the
// evidence cache (membership). Both are captured by mtime:size signatures,
// so the memo is exact, survives restarts, and needs no manual flushes.
// 'note' is a marker, not a value: the note freshness is computed live.
const EVIDENCE_STATE_FILE = path.join(CACHE_DIR, 'evidence-state-cache.json');
let evidenceStateMemo = {};
try { evidenceStateMemo = JSON.parse(fs.readFileSync(EVIDENCE_STATE_FILE, 'utf8')) || {}; } catch {}
let evidenceStateSaveT = null;
function saveEvidenceStateMemoSoon() {
  clearTimeout(evidenceStateSaveT);
  evidenceStateSaveT = setTimeout(() => {
    fs.writeFile(EVIDENCE_STATE_FILE, JSON.stringify(evidenceStateMemo), () => {});
  }, 2000);
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
  const sections = splitTextToTokenBudget(transcript, piTargetTokens() - promptReserve);
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
  while (level.length > 1 || estimateInputTokens(level[0]) > piTargetTokens() - promptReserve) {
    const groups = [];
    let group = [], tokens = 0;
    for (const item of level) {
      const n = estimateInputTokens(item);
      if (group.length && tokens + n > piTargetTokens() - promptReserve) { groups.push(group); group = []; tokens = 0; }
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

// ---------- project-level memory ----------
// A project memory bundle separates durable intent from implementation detail.
// It also keeps setup facts, current work, and reviewable epic candidates.
const PROJECT_MEMORY_DIR = path.join(NOTES_DIR, 'projects');
const PROJECT_MEMORY_INPUTS_DIR = path.join(CACHE_DIR, 'project-memory');
fs.mkdirSync(PROJECT_MEMORY_DIR, { recursive: true });
fs.mkdirSync(PROJECT_MEMORY_INPUTS_DIR, { recursive: true });

function modelJson(raw) {
  const s = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch {}
  // Tolerate prose around the JSON and trailing commas before retrying.
  const a = Math.min(...[s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0));
  const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (Number.isFinite(a) && b > a) {
    const cut = s.slice(a, b + 1);
    try { return JSON.parse(cut); } catch {}
    try { return JSON.parse(cut.replace(/,\s*([}\]])/g, '$1')); } catch {}
  }
  return JSON.parse(s); // throws with the original position info
}

// One corrective retry: strict-JSON replies fail rarely but kill whole jobs.
async function runPiJson(input, prompt, tries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const raw = await runPi(input, prompt + (attempt ? ' Your previous reply was not valid JSON. Reply again with VALID strict JSON only — no prose, no code fence, escape all quotes and newlines inside strings.' : ''));
    try { return modelJson(raw); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function projectMemorySlug(project) {
  const slug = String(project || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
  const hash = crypto.createHash('sha256').update(String(project)).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function projectMemoryPaths(project) {
  const dir = path.join(PROJECT_MEMORY_DIR, projectMemorySlug(project));
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    overview: path.join(dir, 'overview.md'),
    intent: path.join(dir, 'intent.md'),
    environment: path.join(dir, 'environment.md'),
    status: path.join(dir, 'status.md'),
    inputs: path.join(PROJECT_MEMORY_INPUTS_DIR, projectMemorySlug(project) + '.json'),
  };
}

function projectSourceHash(meta) {
  const rows = meta.entries.map(({ key, entry }) => [
    key, entry.memoryHash || `legacy:${entry.lastTs || ''}:${entry.userCount || 0}:${entry.assistantCount || 0}`,
    entry.notePath || '', entry.notedAt || 0,
  ])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update('project-memory-v1\x00' + JSON.stringify(rows)).digest('hex').slice(0, 32);
}

const clipped = (text, max = 12000) => {
  const value = String(text || '');
  if (value.length <= max) return value;
  const side = Math.floor((max - 80) / 2);
  return value.slice(0, side) + '\n… [middle omitted for project analysis] …\n' + value.slice(-side);
};

function stringItems(value) {
  return Array.isArray(value) ? value.map(x => oneLine(x, '')).filter(Boolean) : [];
}

function packTextBlocks(blocks, budget) {
  const groups = [];
  let group = [], tokens = 0;
  for (const block of blocks) {
    const pieces = estimateInputTokens(block) > budget ? splitTextToTokenBudget(block, budget) : [block];
    for (const piece of pieces) {
      const n = estimateInputTokens(piece);
      if (group.length && tokens + n > budget) { groups.push(group); group = []; tokens = 0; }
      group.push(piece); tokens += n;
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

const mdList = (items, empty = 'None found.') => {
  const values = stringItems(items);
  return values.length ? values.map(item => `- ${item}`).join('\n') : `- ${empty}`;
};

function projectDocMeta(project, builtAt, sourceHash) {
  return `- **Project:** ${project}\n- **Generated:** ${new Date(builtAt).toISOString()}\n- **Source snapshot:** ${sourceHash}`;
}

function quoteIntent(text) {
  return clipped(text, 1600).split('\n').map(line => `> ${line}`).join('\n');
}

function renderProjectEnvironmentDoc(project, environment, builtAt, sourceHash) {
  const e = environment || {};
  return `# Development environment: ${project}\n\n**Abstract.** ${e.summary || 'Project setup facts for new agents.'}\n\n${projectDocMeta(project, builtAt, sourceHash)}\n\n> Secret values are intentionally excluded. Store only authentication methods, variable names, and credential locations.\n\n## Setup\n\n${mdList(e.setup)}\n\n## Commands\n\n${mdList(e.commands)}\n\n## Services and addresses\n\n${mdList(e.services)}\n\n## Important locations\n\n${mdList(e.locations)}\n\n## Tools and CLIs\n\n${mdList(e.tooling)}\n\n## Authentication\n\n${mdList(e.authentication)}\n\n## Cautions\n\n${mdList(e.cautions)}\n`;
}

function normalizeProjectStatus(status) {
  const s = { ...(status || {}) };
  s.unfinished = stringItems(s.unfinished).map(item =>
    /automatic project-wide epic discovery/i.test(item)
      ? 'Unattended epic attachment and conservative rebuilding remain unfinished; discovered candidates require review.'
      : item
  );
  s.todos = stringItems(s.todos).map(item =>
    /(?:design|implement).*automatic epic discovery/i.test(item)
      ? 'Add confidence, audit history, and conservative update rules to reviewed epic candidates.'
      : item
  );
  return s;
}

function renderProjectStatusDoc(project, status, builtAt, sourceHash) {
  const s = status || {};
  return `# Project status: ${project}\n\n**Abstract.** Recent focus, unfinished work, and next actions.\n\n${projectDocMeta(project, builtAt, sourceHash)}\n\n## Recent focus\n\n${mdList(s.recentFocus)}\n\n## Unfinished work\n\n${mdList(s.unfinished)}\n\n## Todo\n\n${mdList(s.todos)}\n\n## Open questions\n\n${mdList(s.openQuestions)}\n`;
}

function cleanEpicCandidates(profile, meta) {
  const validIds = new Set(meta.entries.map(({ key }) => key));
  const existing = meta.epics.map(epic => new Set(epic.sessionIds));
  const out = [];
  for (const candidate of Array.isArray(profile.epicCandidates) ? profile.epicCandidates : []) {
    const ids = [...new Set((candidate.sessionIds || []).filter(id => validIds.has(id)))];
    if (ids.length < 2) continue;
    const duplicate = existing.some(set => ids.filter(id => set.has(id)).length / ids.length >= 0.8);
    if (duplicate) continue;
    out.push({
      id: crypto.createHash('sha256').update(ids.slice().sort().join('\x00')).digest('hex').slice(0, 12),
      title: oneLine(candidate.title, 'Discovered epic').slice(0, 70),
      abstract: oneLine(candidate.abstract, ''), reason: oneLine(candidate.reason, ''), sessionIds: ids,
    });
  }
  return out.slice(0, 20);
}

// ---- memory pyramid (design/27-memory-pyramid.md) ----
// Leaves accumulate per conversation (extracted once, cached forever).
// Documents regenerate fresh from all leaves — no synthesis pass ever reads
// its own previous output, so the prose cannot rot.
const MEMORY_LEAVES_DIR = path.join(CACHE_DIR, 'memory-leaves');
const LEAF_VERSION = 2; // v2: two focused calls, force+situation on intent, narrative abstracts

// Dialogue call: judgment work (abstract + intent candidates). It gets the
// project primer for WEIGHING only — facts must come from this conversation.
const LEAF_DIALOGUE_PROMPT =
  'The attached file is the dialogue of one AI-assisted work conversation from a software project: numbered user messages, each with the assistant message immediately before it. ' +
  'PROJECT CONTEXT, when present, tells you what the project is about — use it only to judge importance; extract facts only from THIS conversation. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"abstract":"one narrative paragraph, 4-8 sentences",' +
  '"intent":[{"id":N,"kind":"vision|motivation|outcome|principle|constraint|preference|non-goal","force":"reactive-fix|local-preference|considered-direction|core-drive","situation":"one line: what the user was reacting to","confidence":0.0,"reason":"one line"}]}. ' +
  'abstract: tell what the user was trying to do and WHY, how the direction changed along the way, what actually came out, and what this conversation means for the project. Write it as an honest narrative, not a list. ' +
  'intent: select ONLY numbered user messages that reveal durable, implementation-independent user intent — vision, motivation, desired outcome or experience, values, product principles, durable constraints, trade-offs, explicit non-goals. ' +
  'Judge the force honestly: a complaint while fixing a bug is a reactive-fix — select it only when it hints at a deeper durable want; an unprompted statement of direction or values is a considered-direction or core-drive. ' +
  'Routine commands, narrow implementation requests, and status checks are not intent. Use the exact ids from the input. ' +
  'An empty intent array is fine. Extract only what the conversation supports; do not invent.';

// Tool call: extraction work (environment + problems) from the tool slice.
const LEAF_TOOLS_PROMPT =
  'The attached file lists the tool activity (commands, file edits, results, errors) and the final exchange of one AI-assisted work conversation from a software project. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"environment":[{"type":"setup|command|service|location|tooling|auth|caution","fact":"one line"}],' +
  '"problems":[{"state":"open|resolved","fact":"one line"}]}. ' +
  'environment: reusable setup facts only — commands that matter, services and addresses, important paths, tooling, authentication METHODS. NEVER output passwords, tokens, private keys, secret values, or copied credentials. ' +
  'problems: what broke and stayed open, and notable resolutions that changed the approach. ' +
  'Empty arrays are fine. Extract only what the activity supports; do not invent.';

function leafPathFor(key) {
  return path.join(MEMORY_LEAVES_DIR, key.replace(/[:\/\\]/g, '__') + '.json');
}

// Small in-memory cache: project stats re-read every leaf on each open.
const memoryLeafCache = new Map(); // key -> { mtimeMs, size, leaf }
async function readLeaf(key) {
  const p = leafPathFor(key);
  let st = null;
  try { st = await fsp.stat(p); } catch { memoryLeafCache.delete(key); return null; }
  const hit = memoryLeafCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.leaf;
  try {
    const leaf = JSON.parse(await fsp.readFile(p, 'utf8'));
    memoryLeafCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, leaf });
    if (memoryLeafCache.size > 4000) memoryLeafCache.delete(memoryLeafCache.keys().next().value);
    return leaf;
  } catch { return null; }
}

function leafStateFor(entry, leaf) {
  if (!leaf) return 'missing';
  if (leaf.partial) return 'seeded'; // intent lane only (migrated from an old build)
  if ((leaf.v || 1) < LEAF_VERSION) return 'stale'; // older extraction quality — re-extract on the next backfill
  return leaf.memoryHash && entry && leaf.memoryHash === entry.memoryHash ? 'fresh' : 'stale';
}

// A small stable primer from the current manifest. It rides along in the
// dialogue extraction so the classifier can weigh importance against the
// project's real shape — the wisdom the whole-project classifier used to have.
async function projectPrimerFor(project) {
  try {
    const manifest = JSON.parse(await fsp.readFile(projectMemoryPaths(project).manifest, 'utf8'));
    const o = manifest.overview || {};
    const parts = [o.identity, o.summary, o.purpose, manifest.coreIntent].filter(Boolean);
    return parts.length ? clipped(parts.join(' · '), 1400) : '';
  } catch { return ''; }
}

// One conversation -> one leaf. Two focused calls: dialogue (judgment) and
// tools (extraction). Grouped calls with merged results when too big. The
// verbatim intent quotes are attached here from the transcript — the model
// only returns ids.
async function extractLeaf(key) {
  const entry = index[key];
  if (!entry) throw new Error('unknown conversation: ' + key);
  const memoryHash = entry.memoryHash || null; // captured before the call: growth during the job leaves the leaf correctly stale
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const messages = data.messages || [];
  const project = projectNameOf(entry.cwd, key);
  const primer = await projectPrimerFor(project);
  const intentItems = [];
  let prevAssistant = '';
  messages.forEach((m, i) => {
    if (m.role === 'assistant') prevAssistant = m.text || '';
    if (m.role !== 'user' || !String(m.text || '').trim() || isBootstrapMessage(m.text)) return;
    intentItems.push({ id: i, ts: m.ts || null, user: m.text || '', assistantBefore: prevAssistant });
  });
  const toolLines = [];
  for (const m of messages) {
    if (m.role === 'tool') toolLines.push(`[${m.ts || '?'}] ${m.name || 'tool'}${m.path ? ' ' + m.path : ''}: ${clipped(m.text, 500)}`);
    else if (m.role === 'toolresult') toolLines.push(`  -> ${m.err ? 'ERROR ' : ''}${clipped(m.text, 700)}`);
    else if (m.role === 'abort') toolLines.push(`[${m.ts || '?'}] ABORTED: ${clipped(m.text || 'aborted', 200)}`);
  }
  const tools = toolLines.length > 500
    ? toolLines.slice(0, 100).concat([`… ${toolLines.length - 400} tool events omitted …`], toolLines.slice(-300))
    : toolLines;
  const header = [
    `CONVERSATION ${key}`,
    `Project: ${project} · Directory: ${entry.cwd || '?'}`,
    `Date: ${data.firstTs || entry.firstTs || '?'} -> ${data.lastTs || entry.lastTs || '?'}`,
    `Title: ${oneLine(data.title || entry.title, '(untitled)')}`,
  ].join('\n');
  const runGrouped = async (head, blocks, prompt) => {
    const budget = piTargetTokens() - 8000 - estimateInputTokens(head);
    const groups = packTextBlocks(blocks, Math.max(20000, budget));
    return mapLimit(groups, 2, async (items, i) => {
      const label = groups.length > 1 ? `SECTION ${i + 1}/${groups.length}\n\n` : '';
      try { return await runPiJson(head + label + items.join('\n\n'), prompt); }
      catch (e) { throw new Error(`leaf extraction failed (${key}): ${e.message}`); }
    });
  };

  // Call 1 — dialogue: abstract + intent candidates, with the project primer.
  let dialogueResults = [];
  if (intentItems.length) {
    const dialogueHeader = header +
      (primer ? `\nPROJECT CONTEXT (for judging importance only): ${primer}` : '') + '\n\n';
    dialogueResults = await runGrouped(dialogueHeader, [
      '=== USER MESSAGES (numbered, each with the assistant message immediately before it) ===',
      ...intentItems.map(it => `[#${it.id}] ${it.ts || '?'}\nASSISTANT BEFORE: ${clipped(it.assistantBefore, 6000) || '(none)'}\nUSER: ${clipped(it.user, 12000)}`),
    ], LEAF_DIALOGUE_PROMPT);
  }

  // Call 2 — tools: environment + problems, plus the final exchange as context.
  let toolResults = [];
  if (tools.length) {
    const lastChat = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-2)
      .map(m => `${m.role}: ${clipped(m.text, 2000)}`);
    toolResults = await runGrouped(header + '\n\n', [
      '=== TOOL ACTIVITY (chronological, clipped) ===', ...tools,
      '=== FINAL EXCHANGE ===', ...(lastChat.length ? lastChat : ['(none)']),
    ], LEAF_TOOLS_PROMPT);
  }

  const byId = new Map(intentItems.map(it => [it.id, it]));
  const seen = new Set();
  const intent = [];
  for (const r of dialogueResults) {
    for (const sel of Array.isArray(r.intent) ? r.intent : []) {
      const it = byId.get(Number(sel.id));
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      intent.push({
        messageIndex: it.id, ts: it.ts, kind: oneLine(sel.kind, 'outcome'),
        force: oneLine(sel.force, 'local-preference'), situation: oneLine(sel.situation, ''),
        confidence: Number(sel.confidence) || 0, reason: oneLine(sel.reason, ''),
        user: clipped(it.user, 24000), assistantBefore: clipped(it.assistantBefore, 10000),
      });
    }
  }
  const dedupe = (rows, keyOf) => {
    const out = [], have = new Set();
    for (const row of rows) { const k = keyOf(row); if (!k || have.has(k)) continue; have.add(k); out.push(row); }
    return out;
  };
  const environment = dedupe(
    toolResults.flatMap(r => stringFactRows(r.environment, 'type')), r => r.type + '\x00' + r.fact).slice(0, 60);
  const problems = dedupe(
    toolResults.flatMap(r => stringFactRows(r.problems, 'state')), r => r.state + '\x00' + r.fact).slice(0, 40);
  const abstract = dialogueResults.map(r => oneLine(r.abstract, '')).filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
  const leaf = {
    v: LEAF_VERSION, key, memoryHash, builtAt: Date.now(),
    span: { firstTs: data.firstTs || entry.firstTs || null, lastTs: data.lastTs || entry.lastTs || null },
    title: oneLine(data.title || entry.title, '(untitled)').slice(0, 200),
    abstract, intent, environment, problems,
  };
  await fsp.mkdir(MEMORY_LEAVES_DIR, { recursive: true });
  await writeFileAtomic(leafPathFor(key), JSON.stringify(leaf));
  memoryLeafCache.delete(key);
  return leaf;
}

function stringFactRows(rows, field) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ [field]: oneLine(r && r[field], ''), fact: oneLine(r && r.fact, '') }))
    .filter(r => r.fact);
}

// Migration seed: old whole-project builds saved every selected intent
// message in inputs.json. Turn those into partial leaves (intent lane only)
// so the strongest lane survives with zero model calls.
async function seedLeavesFromSnapshots() {
  let files = [];
  try { files = (await fsp.readdir(PROJECT_MEMORY_INPUTS_DIR)).filter(f => f.endsWith('.json') && !f.endsWith('-pyramid.json')); } catch { return 0; }
  let made = 0;
  for (const f of files) {
    let snap = null;
    try { snap = JSON.parse(await fsp.readFile(path.join(PROJECT_MEMORY_INPUTS_DIR, f), 'utf8')); } catch { continue; }
    const byKey = new Map();
    for (const m of snap.selectedIntentMessages || []) {
      if (!m || !m.key) continue;
      if (!byKey.has(m.key)) byKey.set(m.key, []);
      byKey.get(m.key).push(m);
    }
    for (const [key, quotes] of byKey) {
      if (!index[key]) continue;
      if (fs.existsSync(leafPathFor(key))) continue;
      const entry = index[key];
      const leaf = {
        v: LEAF_VERSION, key, memoryHash: null, partial: true, seededFrom: snap.builtAt || null, builtAt: Date.now(),
        span: { firstTs: entry.firstTs || null, lastTs: entry.lastTs || null },
        title: oneLine(entry.title, '(untitled)').slice(0, 200),
        abstract: '', environment: [], problems: [],
        intent: quotes.map(q => ({
          messageIndex: q.messageIndex, ts: q.ts || null, kind: q.kind || 'outcome',
          confidence: Number(q.confidence) || 0, reason: oneLine(q.reason, ''),
          user: clipped(q.user, 24000), assistantBefore: clipped(q.assistantBefore, 10000),
        })),
      };
      await fsp.mkdir(MEMORY_LEAVES_DIR, { recursive: true });
      await writeFileAtomic(leafPathFor(key), JSON.stringify(leaf));
      made++;
    }
  }
  if (made) console.log(`memory pyramid: seeded ${made} partial leaves from old build snapshots`);
  return made;
}

// ---- layer 2: document regeneration ----
const PYRAMID_PARTIAL_SUFFIX = ' This is one chronological section of a larger project; produce a partial result of the same JSON shape for later merging.';
const PYRAMID_MERGE_SUFFIX = ' The attached file contains partial results from chronological sections of one project. Merge them into one result of the same JSON shape, without duplication; newer evidence wins on conflict.';

const PYRAMID_OVERVIEW_PROMPT =
  'The attached file lists dated narrative abstracts for every conversation of one software project, oldest first. ' +
  'Understand the WHOLE arc, then describe the project as it truly stands today. ' +
  'Be honest and specific: if this is a prototype, an experiment, a personal daily tool, an abandoned spike, or a real product, say so plainly. ' +
  'Trace the evolution: what it began as and what it became. When a newer direction clearly supersedes an older one, describe the current direction and drop the old one from purpose and vision. ' +
  'When an older direction was never revoked, it still stands — keep it even if recent work went elsewhere. ' +
  'Do not hedge, do not average conflicting evidence into vague prose, and do not pad lists. ' +
  'Also find coherent multi-session epic candidates not already covered by the listed existing epics. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"overview":{"summary":"an honest paragraph: what this is, for whom, and where it truly stands","identity":"one line: prototype | experiment | personal daily tool | product | … with a qualifier","evolution":["began as X, became Y because Z"],"purpose":"...","vision":"...","desiredOutcomes":["..."],"principles":["..."],"nonGoals":["..."]},' +
  '"epicCandidates":[{"title":"max 70 chars","abstract":"2-4 sentences","reason":"...","sessionIds":["exact session id"]}]}. ' +
  'Epic candidates need at least two related sessions. Use only exact session ids from the input.';

// Layer 1.5 — the global weighing pass. Per-conversation classifiers cannot
// compare across sessions; this pass sees every candidate quote at once and
// restores the cross-session judgment the old whole-project classifier had.
const PYRAMID_WEIGH_PROMPT =
  'The attached file lists candidate user-intent quotes from one software project, in chronological order with dates. ' +
  'Weigh them AGAINST EACH OTHER to find what the user truly, durably wants. ' +
  'For each quote judge: was the user just reacting to fix a momentary problem, or revealing a lasting goal? Does a later quote supersede it? Is it part of a repeated pattern across sessions? ' +
  'Assign every id exactly one tier: ' +
  '"core" — a deep drive, stated with force or returned to repeatedly; ' +
  '"standing" — a durable direction never revoked; ' +
  '"pattern" — weak alone but part of a clearly repeated preference; ' +
  '"superseded" — a real direction later clearly replaced (name the replacing direction in the note); ' +
  '"one-off" — a momentary reaction with no durable signal. ' +
  'Be strict: when in doubt between one-off and anything higher, choose one-off. ' +
  'Reply with STRICT JSON only, no prose or code fence: {"tiers":[{"id":"...","tier":"core|standing|pattern|superseded|one-off","note":"one line"}]}. Keep every input id.';

const PYRAMID_WEIGH_MERGE_PROMPT =
  'The attached file lists tier assignments for user-intent quotes, produced from chronological sections of the same project that could not see each other. ' +
  'Find cross-section corrections: promote quotes that form cross-section repeated patterns, and mark quotes superseded when a later section clearly replaced their direction. ' +
  'Reply with STRICT JSON only, listing ONLY the ids whose tier you change — never repeat unchanged rows: ' +
  '{"changes":[{"id":"...","tier":"core|standing|pattern|superseded|one-off","note":"one line"}]}. If nothing changes, reply {"changes":[]}.';

const PYRAMID_INTENT_PROMPT =
  'The attached file contains user intent evidence for one software project: verbatim user quotes weighed into tiers (core, standing, pattern, superseded — momentary one-offs were already removed), in chronological order with dates. ' +
  'Recover what the user truly wants: the deep goals that survive implementation changes. ' +
  'Weigh the evidence — core and repeated quotes dominate; a quote stated once in reaction to a bug is weak; superseded quotes are history: report the CURRENT direction, and describe the old direction only under evolution when it explains the project. ' +
  'Resolve repetition and evolution. Keep real tensions instead of forcing false agreement. ' +
  'Be honest and plain: if the project is a prototype, an experiment, or a personal tool, say so. Do not hedge, do not average opposing signals into mush, and never turn current implementation details into goals. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"coreIntent":"...","vision":"...","currentDirection":"where the work is truly pointed now and why","whatMatters":["..."],"desiredOutcomes":["..."],"principles":["..."],"constraints":["..."],"tensions":["..."],"nonGoals":["..."],"evolution":["wanted X, now wants Y because Z"],"openIntentQuestions":["..."]}.';

const PYRAMID_ENV_PROMPT =
  'The attached file lists dated environment facts extracted from every conversation of one software project, oldest first. ' +
  'Build the CURRENT development environment document. The newest evidence wins; drop superseded setup; put unresolved conflicts in cautions. ' +
  'NEVER output passwords, tokens, private keys, secret values, or copied credentials — only methods, variable names, commands, and credential locations. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"summary":"1-2 sentences","setup":["..."],"commands":["..."],"services":["..."],"locations":["..."],"tooling":["..."],"authentication":["..."],"cautions":["..."]}.';

const PYRAMID_STATUS_PROMPT =
  'The attached file lists dated problem records (open or resolved) and the newest conversation abstracts for one software project, oldest first. ' +
  'Build the CURRENT status snapshot. A problem resolved later is not open. Finished work is not unfinished. Prefer the newest evidence. ' +
  'Be specific and plain — name the real things, do not pad lists, and drop anything the newest evidence shows as done or abandoned. ' +
  'Reply with STRICT JSON only, no prose or code fence: ' +
  '{"recentFocus":["..."],"unfinished":["..."],"todos":["..."],"openQuestions":["..."]}.';

async function synthesizeLaneJson(header, blocks, prompt, emit, label, step, steps) {
  const budget = piTargetTokens() - 16000;
  const whole = header + blocks.join('\n\n');
  if (estimateInputTokens(whole) <= budget) {
    emit(label + '…', step, steps);
    return runPiJson(whole, prompt);
  }
  const groups = packTextBlocks(blocks, Math.max(20000, budget - estimateInputTokens(header)));
  emit(`${label} (${groups.length} sections)…`, step, steps);
  const partials = await mapLimit(groups, 2, (items, i) =>
    runPi(`${header}SECTION ${i + 1}/${groups.length}\n\n${items.join('\n\n')}`, prompt + PYRAMID_PARTIAL_SUFFIX));
  return runPiJson(`${header}PARTIAL RESULTS:\n${partials.join('\n\n=== PARTIAL ===\n')}`, prompt + PYRAMID_MERGE_SUFFIX);
}

const laneHashOf = items => crypto.createHash('sha256').update('lane-v1\x00' + JSON.stringify(items)).digest('hex').slice(0, 32);

// Weigh all intent candidates against each other. Returns Map(id -> {tier, note}).
// prevTiers (saved in the last build's inputs file) makes rebuilds incremental:
// only quotes never weighed before go through the expensive pass, then one
// cheap delta pass restores cross-build consistency (new work can still
// supersede old directions).
async function weighIntentCandidates(project, overview, candidates, emit, step, steps, prevTiers = new Map()) {
  const tiers = new Map();
  if (!candidates.length) return tiers;
  const header = `PROJECT: ${project}\nCURRENT OVERVIEW: ${clipped(JSON.stringify(overview), 2000)}\n\n`;
  const blockOf = q => JSON.stringify({
    id: q.id, date: String(q.ts || '?').slice(0, 10), kind: q.kind, force: q.force || null,
    situation: q.situation || null, reason: q.reason || null, quote: clipped(q.user, 900),
  });
  // Output scales with quote count here (one tier row per quote), so a large
  // context is a trap: one 800-quote call times out on generation. Cap each
  // section well below the context budget to keep every call fast; the delta
  // pass restores cross-section consistency.
  const budget = Math.min(35000, piTargetTokens() - 16000);
  const weighQuotes = async quotes => {
    const groups = packTextBlocks(quotes.map(blockOf), Math.max(20000, budget - estimateInputTokens(header)));
    const partials = await mapLimit(groups, 2, async (items, i) => {
      const label = groups.length > 1 ? `SECTION ${i + 1}/${groups.length}\n\n` : '';
      return runPiJson(header + label + items.join('\n'), PYRAMID_WEIGH_PROMPT);
    });
    return { rows: partials.flatMap(p => Array.isArray(p.tiers) ? p.tiers : []), sections: groups.length };
  };
  // Delta merge: the given rows are the baseline; the model returns only the
  // rows it corrects. This keeps the output tiny regardless of project size
  // (a full rewrite of 800+ rows can exceed the provider output cap).
  const deltaPass = async rows => {
    const compact = rows.map(t => JSON.stringify({ id: t.id, tier: t.tier, note: oneLine(t.note, '') }));
    const merged = await runPiJson(header + compact.join('\n'), PYRAMID_WEIGH_MERGE_PROMPT);
    const changes = Array.isArray(merged.changes) ? merged.changes : Array.isArray(merged.tiers) ? merged.tiers : [];
    const byId = new Map(rows.map(t => [String(t.id), t]));
    for (const c of changes) if (c && c.id != null && byId.has(String(c.id))) byId.set(String(c.id), c);
    return [...byId.values()];
  };

  const cachedRows = candidates.filter(q => prevTiers.has(String(q.id)))
    .map(q => ({ id: String(q.id), ...prevTiers.get(String(q.id)) }));
  const fresh = candidates.filter(q => !prevTiers.has(String(q.id)));
  let rows;
  if (cachedRows.length && fresh.length <= cachedRows.length) {
    // Incremental rebuild: most quotes keep their tier from the last build.
    if (!fresh.length) {
      emit(`Reusing ${cachedRows.length} weighed intent quotes…`, step, steps);
      rows = cachedRows;
    } else {
      emit(`Weighing ${fresh.length} new intent quotes (${cachedRows.length} cached)…`, step, steps);
      rows = cachedRows.concat((await weighQuotes(fresh)).rows);
      rows = await deltaPass(rows);
    }
  } else {
    emit(`Weighing ${candidates.length} intent quotes…`, step, steps);
    const res = await weighQuotes(candidates);
    // Sections could not compare across each other — one cheap merge pass over
    // the one-line assignments restores global consistency.
    rows = res.sections > 1 ? await deltaPass(res.rows) : res.rows;
  }
  const valid = new Set(['core', 'standing', 'pattern', 'superseded', 'one-off']);
  for (const t of rows) {
    if (!t || !valid.has(t.tier)) continue;
    tiers.set(String(t.id), { tier: t.tier, note: oneLine(t.note, '') });
  }
  return tiers;
}

function renderPyramidOverviewDoc(project, profile, builtAt, sourceHash) {
  const o = profile.overview || {};
  return `# Project overview: ${project}\n\n**Abstract.** ${o.summary || ''}\n\n${projectDocMeta(project, builtAt, sourceHash)}\n\n## What this is\n\n${o.identity || '(not established)'}\n\n## Evolution\n\n${mdList(o.evolution, 'No direction changes found.')}\n\n## Purpose\n\n${o.purpose || '(not established)'}\n\n## Vision\n\n${o.vision || '(not established)'}\n\n## Desired outcomes\n\n${mdList(o.desiredOutcomes)}\n\n## Product principles\n\n${mdList(o.principles)}\n\n## Non-goals\n\n${mdList(o.nonGoals)}\n`;
}

const PYRAMID_TIER_LABELS = [
  ['core', 'Core drives'], ['standing', 'Standing directions'],
  ['pattern', 'Repeated patterns'], ['superseded', 'Superseded directions (historical)'],
];

function renderPyramidIntentDoc(project, intent, quotes, tiers, builtAt, sourceHash) {
  const parts = [
    `# Deep project intent: ${project}`, '',
    `**Abstract.** ${intent.coreIntent || intent.vision || ''}`, '', projectDocMeta(project, builtAt, sourceHash), '',
    '## Core intent', '', intent.coreIntent || '(not established)', '',
    '## Vision', '', intent.vision || '(not established)', '',
    '## Current direction', '', intent.currentDirection || '(not established)', '',
    '## What matters', '', mdList(intent.whatMatters), '',
    '## Desired outcomes', '', mdList(intent.desiredOutcomes), '',
    '## Durable principles', '', mdList(intent.principles), '',
    '## Durable constraints', '', mdList(intent.constraints), '',
    '## Tensions and trade-offs', '', mdList(intent.tensions), '',
    '## Non-goals', '', mdList(intent.nonGoals), '',
    '## Evolution', '', mdList(intent.evolution, 'No superseded directions found.'), '',
    '## Open intent questions', '', mdList(intent.openIntentQuestions), '',
    '## Intent evidence', '',
    'Verbatim user quotes, weighed against the whole project span. Momentary one-off reactions are omitted.', '',
  ];
  for (const [tier, label] of PYRAMID_TIER_LABELS) {
    const rows = quotes.filter(q => (tiers.get(q.id) || {}).tier === tier);
    if (!rows.length) continue;
    parts.push(`### ${label}`, '');
    for (const item of rows) {
      const t = tiers.get(item.id) || {};
      parts.push(`#### ${String(item.ts || '?').slice(0, 10)} — ${oneLine(item.title, '(untitled)')}`, '',
        `- **Kind:** ${item.kind} · **Force:** ${item.force || '?'}${t.note ? ` · **Weighing:** ${t.note}` : ''}`);
      if (item.situation) parts.push(`- **Situation:** ${item.situation}`);
      parts.push(`- **Session:** \`${item.key}\` · message #${item.messageIndex}`, '',
        quoteIntent(item.user), '');
    }
  }
  return parts.join('\n');
}

function pyramidIntentBlock(item, tierInfo) {
  const historical = tierInfo.tier === 'superseded';
  return [
    `=== INTENT EVIDENCE ${item.id} ===`,
    `Date: ${item.ts || '?'}`,
    `Tier: ${tierInfo.tier}${tierInfo.note ? ' — ' + tierInfo.note : ''}`,
    `Kind: ${item.kind} · force: ${item.force || '?'} · situation: ${item.situation || '?'}`,
    '', 'USER:', clipped(item.user, historical ? 1500 : 12000),
    ...(historical ? [] : ['', 'ASSISTANT BEFORE:', clipped(item.assistantBefore, 4000) || '(none)']),
  ].join('\n');
}

// Regenerate all four documents from the current leaves. Lanes whose input
// set is unchanged skip their model call and keep the existing file.
// Epics are recursive projects: the same four documents, synthesized from
// the leaf subset of the epic's conversations.
function epicMemoryPaths(epicId) {
  const dir = path.join(NOTES_DIR, 'epics', epicId + '-mem');
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    overview: path.join(dir, 'overview.md'),
    intent: path.join(dir, 'intent.md'),
    environment: path.join(dir, 'environment.md'),
    status: path.join(dir, 'status.md'),
  };
}

async function epicMemoryInfo(epic) {
  try {
    const manifest = JSON.parse(await fsp.readFile(epicMemoryPaths(epic.id).manifest, 'utf8'));
    const entries = (epic.sessionIds || []).filter(id => index[id]).map(key => ({ key, entry: index[key] }));
    return {
      builtAt: manifest.builtAt, stale: manifest.sourceHash !== projectSourceHash({ entries }),
      overview: manifest.overview || {}, coreIntent: manifest.coreIntent || null,
    };
  } catch { return null; }
}

async function epicMemoryDocument(epicId, kind) {
  const paths = epicMemoryPaths(epicId);
  const file = ({ overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status })[kind];
  if (!file) throw new Error('unknown epic memory document');
  return { epicId, kind, path: file, text: await fsp.readFile(file, 'utf8') };
}

async function regenerateProjectDocs(project, emit = () => {}) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  return regenerateDocsCore({
    label: project, entries: meta.entries, paths: projectMemoryPaths(project),
    existingEpics: meta.epics, discoverCandidates: true,
    inputsPath: path.join(PROJECT_MEMORY_INPUTS_DIR, projectMemorySlug(project) + '-pyramid.json'),
  }, emit);
}

// An area is one more aggregation scope over the same leaves: same core,
// scoped entries, own document directory. No new extraction happens.
async function regenerateAreaDocs(project, rel, emit = () => {}) {
  const am = areaMetaFor(project, rel);
  if (!am) throw new Error('area not found');
  if (!am.entries.length) throw new Error('this area has no conversations yet');
  const paths = areaMemoryPaths(project, rel);
  return regenerateDocsCore({
    label: `${project}/${rel}`, entries: am.entries, paths,
    existingEpics: [], discoverCandidates: false,
    inputsPath: paths.inputs,
  }, emit);
}

async function regenerateEpicDocs(epicId, emit = () => {}) {
  const epic = epics[epicId];
  if (!epic) throw new Error('epic not found');
  const entries = (epic.sessionIds || []).filter(id => index[id]).map(key => ({ key, entry: index[key] }));
  if (!entries.length) throw new Error('epic has no readable conversations');
  return regenerateDocsCore({
    label: `${epic.title || epicId} (epic)`, entries, paths: epicMemoryPaths(epicId),
    existingEpics: [], discoverCandidates: false,
    inputsPath: path.join(PROJECT_MEMORY_INPUTS_DIR, 'epic-' + epicId + '-pyramid.json'),
  }, emit);
}

async function regenerateDocsCore({ label, entries, paths, existingEpics, discoverCandidates, inputsPath }, emit = () => {}) {
  const project = label;
  emit('Reading memory leaves…', 0, 5);
  const rows = (await mapLimit(entries, 16, async ({ key, entry }) => ({ key, entry, leaf: await readLeaf(key) })))
    .filter(r => r.leaf)
    .sort((a, b) => String(a.leaf.span?.firstTs || '').localeCompare(String(b.leaf.span?.firstTs || '')));
  if (!rows.length) throw new Error('no memory leaves yet — run the leaf backfill first');
  let prev = null;
  try { prev = JSON.parse(await fsp.readFile(paths.manifest, 'utf8')); } catch {}
  const prevHashes = (prev && prev.pyramid && prev.pyramid.laneHashes) || {};
  const dated = ts => String(ts || '?').slice(0, 10);

  // Lane inputs.
  const abstractBlocks = rows.map(r => [
    `=== SESSION ${r.key} ===`,
    `Date: ${dated(r.leaf.span?.firstTs)} -> ${dated(r.leaf.span?.lastTs)}`,
    `Title: ${r.leaf.title}`,
    `Abstract: ${r.leaf.abstract || '(none)'}`,
    (r.leaf.problems || []).some(p => p.state === 'open') ? `Open problems: ${(r.leaf.problems || []).filter(p => p.state === 'open').map(p => p.fact).join('; ')}` : '',
  ].filter(Boolean).join('\n'));
  const intentSelected = rows.flatMap(r => (r.leaf.intent || []).map((q, i) => ({
    id: r.key + ':' + q.messageIndex, key: r.key, messageIndex: q.messageIndex, ts: q.ts || r.leaf.span?.lastTs || null,
    title: r.leaf.title, kind: q.kind || 'outcome', confidence: q.confidence || 0, reason: q.reason || '',
    user: q.user || '', assistantBefore: q.assistantBefore || '',
  }))).sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const envFacts = rows.flatMap(r => (r.leaf.environment || []).map(f => `[${dated(r.leaf.span?.lastTs)}] ${f.type}: ${f.fact}`));
  const problemFacts = rows.flatMap(r => (r.leaf.problems || []).map(f => `[${dated(r.leaf.span?.lastTs)}] ${f.state}: ${f.fact} (session ${r.key})`));
  const newestAbstracts = rows.slice(-12).map(r => `[${dated(r.leaf.span?.lastTs)}] ${r.leaf.title}: ${r.leaf.abstract || '(none)'}`);

  const laneHashes = {
    overview: laneHashOf(abstractBlocks),
    intent: laneHashOf(intentSelected.map(q => [q.id, q.force || '', q.kind])),
    environment: laneHashOf(envFacts), status: laneHashOf(problemFacts.concat(newestAbstracts)),
  };
  const skip = lane => prevHashes[lane] === laneHashes[lane] && fs.existsSync(paths[lane === 'status' ? 'status' : lane]);

  // Overview first: it is cheap and feeds the weighing and the intent
  // synthesis as context.
  const header = `PROJECT: ${project}\n` +
    (discoverCandidates ? `EXISTING EPICS (do not duplicate):\n${JSON.stringify(existingEpics.map(e => ({ title: e.title, sessionIds: e.sessionIds })))}\n` : 'This is one epic (workstream) of a larger project — describe THIS epic, not the whole project. Skip epicCandidates.\n') + '\n';
  let profile = null;
  if (skip('overview') && prev && prev.overview) {
    emit('Overview unchanged — keeping it.', 1, 6);
    profile = { overview: prev.overview, epicCandidates: (prev.candidates || []) };
  } else {
    profile = await synthesizeLaneJson(header, abstractBlocks, PYRAMID_OVERVIEW_PROMPT, emit, 'Building the project overview', 1, 6);
  }
  const overview = profile.overview || {};

  // Intent: weigh all candidates globally (layer 1.5), then synthesize from
  // the surviving tiers. One-off reactions are dropped before synthesis so
  // they cannot dilute the result.
  let intent = null, tiers = new Map(), weighedQuotes = intentSelected;
  if (!skip('intent')) {
    // Tier assignments from the last build make the weighing incremental.
    const prevTiers = new Map();
    try {
      const validTier = new Set(['core', 'standing', 'pattern', 'superseded', 'one-off']);
      for (const t of JSON.parse(await fsp.readFile(inputsPath, 'utf8')).tiers || [])
        if (t && t.id && validTier.has(t.tier)) prevTiers.set(String(t.id), { tier: t.tier, note: oneLine(t.note, '') });
    } catch {}
    tiers = await weighIntentCandidates(project, overview, intentSelected, emit, 2, 6, prevTiers);
    weighedQuotes = intentSelected.filter(q => {
      const t = tiers.get(q.id);
      return t && t.tier !== 'one-off';
    });
    if (!weighedQuotes.length) weighedQuotes = intentSelected; // weighing failed or everything one-off: keep all rather than nothing
    const intentBlocks = weighedQuotes.map(q => pyramidIntentBlock(q, tiers.get(q.id) || { tier: 'standing', note: '' }));
    const intentHeader = `PROJECT: ${project}\nHIGH-LEVEL OVERVIEW:\n${clipped(JSON.stringify(overview), 2500)}\n\n`;
    intent = await synthesizeLaneJson(intentHeader, intentBlocks, PYRAMID_INTENT_PROMPT, emit, `Synthesizing ${weighedQuotes.length} weighed intent quotes`, 3, 6);
  } else emit('Intent unchanged — keeping it.', 3, 6);

  let environment = null, status = null;
  const envHeader = `PROJECT: ${project}\n\n`;
  await Promise.all([
    (async () => {
      if (skip('environment')) return emit('Environment unchanged — keeping it.', 4, 6);
      environment = await synthesizeLaneJson(envHeader, envFacts.length ? envFacts : ['(no environment facts yet)'], PYRAMID_ENV_PROMPT, emit, 'Building the environment document', 4, 6);
    })(),
    (async () => {
      if (skip('status')) return;
      const statusBlocks = ['=== PROBLEMS ===', ...(problemFacts.length ? problemFacts : ['(none)']), '=== NEWEST ABSTRACTS ===', ...newestAbstracts];
      status = normalizeProjectStatus(await synthesizeLaneJson(envHeader, statusBlocks, PYRAMID_STATUS_PROMPT, emit, 'Building the status document', 4, 6));
    })(),
  ]);

  emit('Writing project memory documents…', 5, 6);
  const builtAt = Date.now();
  const sourceHash = projectSourceHash({ entries });
  const candidates = discoverCandidates ? cleanEpicCandidates(profile, { entries, epics: existingEpics }) : [];
  await fsp.mkdir(paths.dir, { recursive: true });
  const writes = [];
  if (!skip('overview')) writes.push(writeFileAtomic(paths.overview, renderPyramidOverviewDoc(project, profile, builtAt, sourceHash)));
  if (intent) writes.push(writeFileAtomic(paths.intent, renderPyramidIntentDoc(project, intent, weighedQuotes, tiers, builtAt, sourceHash)));
  if (environment) writes.push(writeFileAtomic(paths.environment, renderProjectEnvironmentDoc(project, environment, builtAt, sourceHash)));
  if (status) writes.push(writeFileAtomic(paths.status, renderProjectStatusDoc(project, status, builtAt, sourceHash)));
  writes.push(writeFileAtomic(inputsPath, JSON.stringify({
    project, builtAt, sourceHash, laneHashes, leaves: rows.map(r => ({ key: r.key, state: leafStateFor(r.entry, r.leaf) })),
    intentQuotes: intentSelected.length, weighedQuotes: weighedQuotes.length,
    tiers: [...tiers.entries()].map(([id, t]) => ({ id, ...t })),
    envFacts: envFacts.length, problems: problemFacts.length,
  })));
  await Promise.all(writes);
  const manifest = {
    project, builtAt, sourceHash, conversations: rows.length,
    classifiedMessages: prev && prev.classifiedMessages || 0,
    selectedIntentMessages: intentSelected.length,
    coreIntent: (intent && intent.coreIntent) || (prev && prev.coreIntent) || null,
    overview: profile.overview || (prev && prev.overview) || {}, candidates,
    paths: { overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status, inputs: inputsPath },
    pyramid: { v: 2, builtAt, laneHashes, leafCount: rows.length, seededLeaves: rows.filter(r => r.leaf.partial).length },
  };
  await writeFileAtomic(paths.manifest, JSON.stringify(manifest));
  emit('Project memory saved.', 6, 6);
  return manifest;
}

async function projectMemoryInfo(project, meta = projectMetaFor(project)) {
  if (!meta) return null;
  const paths = projectMemoryPaths(project);
  try {
    const manifest = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    return {
      builtAt: manifest.builtAt, stale: manifest.sourceHash !== projectSourceHash(meta),
      conversations: manifest.conversations, classifiedMessages: manifest.classifiedMessages,
      selectedIntentMessages: manifest.selectedIntentMessages,
      coreIntent: manifest.coreIntent || null,
      overview: manifest.overview || {}, candidates: manifest.candidates || [], paths: manifest.paths || {},
      pyramid: manifest.pyramid || null,
    };
  } catch { return null; }
}

async function projectMemoryDocument(project, kind) {
  const paths = projectMemoryPaths(project);
  const file = ({ overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status })[kind];
  if (!file) throw new Error('unknown project memory document');
  return { project, kind, path: file, text: await fsp.readFile(file, 'utf8') };
}

async function areaMemoryDocument(project, rel, kind) {
  const paths = areaMemoryPaths(project, rel);
  const file = ({ overview: paths.overview, intent: paths.intent, environment: paths.environment, status: paths.status })[kind];
  if (!file) throw new Error('unknown area memory document');
  return { project, area: rel, kind, path: file, text: await fsp.readFile(file, 'utf8') };
}

// Cheap catalog for the @ palette: every known project plus which of the
// four map documents exist on disk. No file bodies, no projectResponse.
function projectMemoryIndex() {
  const names = new Set();
  for (const [key, entry] of Object.entries(index)) {
    if (!entry) continue;
    const project = projectNameOf(entry.cwd, key);
    if (project && project !== '?' && project !== LOOSE_PROJECT) names.add(project);
  }
  for (const name of Object.keys(createdProjects)) {
    if (name) names.add(canonicalProjectName(name));
  }
  const out = [];
  for (const name of names) {
    if (!name || name === '?') continue;
    const meta = projectMetaFor(name);
    const paths = projectMemoryPaths(name);
    const docs = {};
    let any = false;
    for (const kind of MEMORY_DOC_KINDS) {
      const ok = fs.existsSync(paths[kind]);
      docs[kind] = ok;
      if (ok) any = true;
    }
    if (!meta && !any) continue;
    out.push({
      name,
      title: (projectTitles[name] && projectTitles[name].title) || null,
      cwd: (meta && meta.cwd) || null,
      conversations: meta && meta.entries ? meta.entries.length : 0,
      docs,
    });
  }
  out.sort((a, b) => (b.conversations - a.conversations) || a.name.localeCompare(b.name));
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
  const budget = piTargetTokens() - 12000;
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
  if (key === 'aiconvo:internal') return INTERNAL_USAGE_FILE;
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
  const leaves = { fresh: 0, stale: 0, seeded: 0, missing: 0 };
  for (const s of sessions) leaves[leafStateFor(s, await readLeaf(s.key))]++;
  const docsJob = memoryDocsJobs.get('epic:' + epic.id);
  return {
    ...epic, text: await fsp.readFile(epic.notePath, 'utf8'), sessions,
    project: sessions.length ? projectOfEntry(sessions[0], sessions[0].key) : null,
    memory: await epicMemoryInfo(epic), leaves,
    docsRunning: !!(docsJob && !docsJob.finished),
  };
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
const projectDistillJobs = new Map(); // project -> batch job
const evidenceJobs = new Map(); // batch id -> job
const epicJobs = new Map();    // epic id -> job
const memoryExtractJobs = new Map(); // batch id -> leaf extraction job
const memoryDocsJobs = new Map();    // project -> document regeneration job
const memoryBackfillJobs = new Map(); // project -> backfill job

function jobView(job) {
  return {
    id: job.id, type: job.type, key: job.key || null, epicId: job.epicId || null,
    project: job.project || null, parentId: job.parentId || null,
    title: job.title, status: job.status, statusText: job.statusText,
    done: job.done || 0, total: job.total || 0,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null,
    result: job.result || null, error: job.error || null,
    model: job.model || null,
    fanoutId: job.fanoutId || null, fanoutRootKey: job.fanoutRootKey || null,
    fanoutNode: job.fanoutNode || null, fanoutIndex: job.fanoutIndex ?? null,
    fanoutCount: job.fanoutCount || null,
    uiRequests: job.uiRequests && job.uiRequests.length ? job.uiRequests : undefined,
    notices: job.notices && job.notices.length ? job.notices : undefined,
    customViews: job.customViews && Object.keys(job.customViews).length ? job.customViews : undefined,
  };
}

function jobChanged(job) {
  job.updatedAt = Date.now();
  if (job.type === 'agent-run') saveAgentRuns();
  broadcast({ type: 'job', job: jobView(job) });
}

function allJobs() {
  const cutoff = Date.now() - JOB_KEEP_MS;
  return [...distillJobs.values(), ...projectDistillJobs.values(), ...evidenceJobs.values(), ...epicJobs.values(), ...memoryExtractJobs.values(), ...memoryDocsJobs.values(), ...memoryBackfillJobs.values(), ...agentRunJobs.values()]
    .map(jobView)
    .concat([...restoredRunJobs.values()].filter(j => (j.finishedAt || 0) > cutoff))
    .sort((a, b) => b.startedAt - a.startedAt);
}

function startDistillJob(key, data, options = {}) {
  // Capture the source version now. If the conversation grows while this job
  // runs, its final note remains correctly marked as stale.
  const sourceMtime = index[key] && index[key].mtimeMs || Date.now();
  const job = {
    id: 'distill:' + key, type: 'distill', key, title: data.title || key,
    project: options.project || null, parentId: options.parentId || null,
    events: [], listeners: new Set(), finished: false, status: 'running',
    statusText: 'Starting distillation…', done: 0, total: 0, startedAt: Date.now(),
    model: currentModelLabel(),
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
  job.completion = (async () => {
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
      if (index[key]) { index[key].notePath = file; index[key].notedAt = sourceMtime; saveIndexSoon(); }
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

function startProjectDistillJob(project) {
  const running = projectDistillJobs.get(project);
  if (running && !running.finished) return running;
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const targets = meta.entries.filter(({ entry }) => noteStateForEntry(entry) !== 'fresh');
  const job = {
    id: 'project-distill:' + project, type: 'project-distill', project,
    title: `${project}: update all notes`, status: 'running',
    statusText: targets.length ? 'Preparing project notes…' : 'All project notes are current.',
    done: 0, total: targets.length, startedAt: Date.now(), finished: false,
    model: currentModelLabel(),
  };
  projectDistillJobs.set(project, job);
  jobChanged(job);
  job.completion = (async () => {
    let updated = 0;
    const failures = [];
    await mapLimit(targets, 2, async ({ key }) => {
      try {
        let child = distillJobs.get(key);
        if (!child || child.finished) {
          const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
          child = startDistillJob(key, data, { project, parentId: job.id });
        }
        await child.completion;
        if (child.status !== 'done') throw new Error(child.error || child.statusText || 'distillation failed');
        updated++;
      } catch (e) {
        failures.push(`${key}: ${e.message}`);
      } finally {
        job.done++;
        job.statusText = `Updating project notes ${job.done}/${job.total}…`;
        jobChanged(job);
      }
    });
    job.result = { project, updated, failed: failures.length };
    if (failures.length) {
      job.status = 'error';
      job.error = `${failures.length} of ${targets.length} notes failed.`;
      job.statusText = job.error;
    } else {
      job.status = 'done';
      job.statusText = targets.length ? `All project notes are current: ${updated} updated.` : 'All project notes are current.';
    }
    job.finished = true;
    job.finishedAt = Date.now();
    jobChanged(job);
    setTimeout(() => {
      if (projectDistillJobs.get(project) === job) projectDistillJobs.delete(project);
    }, 60 * 60 * 1000);
  })();
  return job;
}

// ---- memory pyramid jobs ----

// A batch of leaf extractions. Each leaf fails alone; the batch reports the
// count. Concurrency 2 keeps the trickle polite to rate limits.
function startMemoryExtractJob(ids, label = null) {
  const keys = [...new Set(ids)].filter(k => index[k]);
  if (!keys.length) throw new Error('no conversations to extract');
  const id = crypto.randomUUID();
  const job = {
    id: 'memory-extract:' + id, type: 'memory-extract',
    key: keys.length === 1 ? keys[0] : null, sessionIds: keys,
    title: label || `${keys.length} memory ${keys.length === 1 ? 'leaf' : 'leaves'}`,
    status: 'running', statusText: 'Extracting memory leaves…', done: 0, total: keys.length,
    startedAt: Date.now(), finished: false, model: currentModelLabel(),
  };
  memoryExtractJobs.set(job.id, job);
  jobChanged(job);
  job.completion = (async () => {
    const failures = [];
    const projects = new Set();
    await mapLimit(keys, 2, async key => {
      try {
        await extractLeaf(key);
        const entry = index[key];
        if (entry) projects.add(projectNameOf(entry.cwd, key));
      } catch (e) { failures.push(e.message); }
      job.done++;
      job.statusText = `Extracted ${job.done}/${job.total} leaves…`;
      jobChanged(job);
    });
    if (failures.length === keys.length) {
      job.status = 'error'; job.error = failures[0]; job.statusText = failures[0];
    } else {
      job.status = 'done';
      job.statusText = failures.length ? `${keys.length - failures.length} leaves saved · ${failures.length} failed` : 'Memory leaves saved.';
      job.result = { extracted: keys.length - failures.length, failed: failures.length };
    }
    job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
    for (const project of projects) scheduleDocsRegen(project);
    scheduleEpicRegenForKeys(keys);
    setTimeout(() => { if (memoryExtractJobs.get(job.id) === job) memoryExtractJobs.delete(job.id); }, 60 * 60 * 1000);
  })();
  return job;
}

function startMemoryDocsJob(project) {
  if (!projectMetaFor(project)) throw new Error('project not found');
  return startDocsJobCore(project, project + ': regenerate memory documents', project, null,
    emit => regenerateProjectDocs(project, emit));
}

function startAreaDocsJob(project, rel) {
  if (!areaMetaFor(project, rel)) throw new Error('area not found');
  return startDocsJobCore('area:' + project + '\0' + rel, `${project}/${rel}: regenerate area memory`, project, null,
    emit => regenerateAreaDocs(project, rel, emit));
}

function startEpicDocsJob(epicId) {
  const epic = epics[epicId];
  if (!epic) throw new Error('epic not found');
  return startDocsJobCore('epic:' + epicId, (epic.title || epicId) + ': regenerate epic memory', null, epicId,
    emit => regenerateEpicDocs(epicId, emit));
}

function startDocsJobCore(mapKey, title, project, epicId, run) {
  const running = memoryDocsJobs.get(mapKey);
  if (running && !running.finished) return running;
  const job = {
    id: 'memory-docs:' + mapKey, type: 'memory-docs', project, epicId,
    title, status: 'running', statusText: 'Reading memory leaves…',
    done: 0, total: 5, startedAt: Date.now(), finished: false, model: currentModelLabel(),
  };
  memoryDocsJobs.set(mapKey, job);
  jobChanged(job);
  job.completion = (async () => {
    try {
      const manifest = await run((text, done, total) => {
        job.statusText = text; job.done = done; job.total = total; jobChanged(job);
      });
      job.status = 'done'; job.statusText = 'Memory documents regenerated.'; job.done = job.total;
      job.result = { project, epicId, paths: manifest.paths, candidates: (manifest.candidates || []).length };
    } catch (e) {
      job.status = 'error'; job.statusText = e.message; job.error = e.message;
    } finally {
      job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
      setTimeout(() => { if (memoryDocsJobs.get(mapKey) === job) memoryDocsJobs.delete(mapKey); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

// The one-time backfill for old projects: oldest first, resumable (finished
// leaves persist), pausable. Regenerates the documents once at the end.
function startMemoryBackfillJob(project) {
  const running = memoryBackfillJobs.get(project);
  if (running && !running.finished) return running;
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const job = {
    id: 'memory-backfill:' + project, type: 'memory-backfill', project,
    title: `${project}: memory leaf backfill`, status: 'running', statusText: 'Checking leaves…',
    done: 0, total: 0, startedAt: Date.now(), finished: false, model: currentModelLabel(),
    cancelRequested: false,
  };
  memoryBackfillJobs.set(project, job);
  jobChanged(job);
  job.completion = (async () => {
    try {
      const sorted = [...meta.entries].sort((a, b) => String(a.entry.firstTs || '').localeCompare(String(b.entry.firstTs || '')));
      const todo = [];
      for (const { key, entry } of sorted) {
        if (!entry.realUserCount) continue;
        if (leafStateFor(entry, await readLeaf(key)) !== 'fresh') todo.push(key);
      }
      job.total = todo.length;
      if (!todo.length) { job.status = 'done'; job.statusText = 'All leaves are current.'; return; }
      jobChanged(job);
      let failed = 0;
      await mapLimit(todo, 2, async key => {
        if (job.cancelRequested) return;
        try { await extractLeaf(key); } catch { failed++; }
        job.done++;
        job.statusText = `Backfill ${job.done}/${job.total} leaves…${failed ? ` (${failed} failed)` : ''}`;
        jobChanged(job);
      });
      if (job.cancelRequested) {
        job.status = 'done'; job.statusText = `Paused at ${job.done}/${job.total}. Start again to resume.`;
        job.result = { paused: true, done: job.done, total: job.total };
        return;
      }
      job.status = failed === todo.length ? 'error' : 'done';
      job.statusText = failed ? `Backfill finished · ${failed} leaves failed.` : 'Backfill finished.';
      job.result = { done: job.done, failed };
      if (failed < todo.length) {
        try { startMemoryDocsJob(project); } catch {}
        scheduleEpicRegenForKeys(todo, 60 * 1000); // backfill already batched: refresh epic docs soon after
      }
    } catch (e) {
      job.status = 'error'; job.statusText = e.message; job.error = e.message;
    } finally {
      job.finished = true; job.finishedAt = Date.now(); jobChanged(job);
      setTimeout(() => { if (memoryBackfillJobs.get(project) === job) memoryBackfillJobs.delete(project); }, 60 * 60 * 1000);
    }
  })();
  return job;
}

// ---- pyramid triggers ----
// Settle -> extract: a conversation whose content changed and then stayed
// quiet for LEAF_SETTLE_MS gets its leaf re-extracted automatically.
// Guarded against re-index floods: only a real memoryHash change marks dirty.
const LEAF_SETTLE_MS = 10 * 60 * 1000;
const LEAF_SWEEP_MS = 2 * 60 * 1000;
const leafDirty = new Map(); // key -> last content change (ms)

function markLeafDirty(key, prevEntry, entry, mtimeMs) {
  if (!entry || !entry.realUserCount) return;
  if (prevEntry && prevEntry.memoryHash === entry.memoryHash) return; // re-index without content change
  if (!prevEntry && Date.now() - (mtimeMs || 0) > 24 * 60 * 60 * 1000) return; // old file first seen (cache bump / backfill territory)
  leafDirty.set(key, Date.now());
}

async function sweepSettledLeaves() {
  const now = Date.now();
  const ready = [];
  for (const [key, at] of leafDirty) {
    const entry = index[key];
    if (!entry) { leafDirty.delete(key); continue; }
    if (now - Math.max(at, entry.mtimeMs || 0) < LEAF_SETTLE_MS) continue;
    leafDirty.delete(key);
    ready.push(key);
  }
  if (!ready.length) return;
  const stale = [];
  for (const key of ready) {
    if (leafStateFor(index[key], await readLeaf(key)) !== 'fresh') stale.push(key);
  }
  if (stale.length) {
    try { startMemoryExtractJob(stale, `${stale.length} settled conversation${stale.length === 1 ? '' : 's'}`); } catch {}
  }
}

// Leaves changed -> regenerate the documents, debounced. Only projects that
// already opted into memory (a manifest exists) regenerate automatically.
const DOCS_REGEN_DEBOUNCE_MS = 30 * 60 * 1000;
const docsRegenTimers = new Map(); // project or 'epic:<id>' -> timer
function scheduleDocsRegen(project, delayMs = DOCS_REGEN_DEBOUNCE_MS) {
  if (!project || project === '?') return;
  clearTimeout(docsRegenTimers.get(project));
  docsRegenTimers.set(project, setTimeout(() => {
    docsRegenTimers.delete(project);
    fsp.access(projectMemoryPaths(project).manifest).then(
      () => { try { startMemoryDocsJob(project); } catch {} },
      () => {});
  }, delayMs));
  // Declared areas with built memory refresh on the same debounce. Area docs
  // are pure functions of the same leaves, only over a narrower entry set.
  for (const rel of Object.keys(declaredAreasFor(project))) {
    const mapKey = 'area:' + project + '\0' + rel;
    clearTimeout(docsRegenTimers.get(mapKey));
    docsRegenTimers.set(mapKey, setTimeout(() => {
      docsRegenTimers.delete(mapKey);
      fsp.access(areaMemoryPaths(project, rel).manifest).then(
        () => { try { startAreaDocsJob(project, rel); } catch {} },
        () => {});
    }, delayMs));
  }
}

// Epics are recursive projects: an epic whose manifest exists keeps itself
// current on the same settle -> leaf -> debounced-docs path. Epics never
// create themselves; only already-built epic memory refreshes.
function scheduleEpicRegenForKeys(keys, delayMs = DOCS_REGEN_DEBOUNCE_MS) {
  const touched = new Set(keys);
  for (const epic of Object.values(epics)) {
    if (!epic || !epic.id) continue;
    if (!(epic.sessionIds || []).some(id => touched.has(id))) continue;
    const mapKey = 'epic:' + epic.id;
    clearTimeout(docsRegenTimers.get(mapKey));
    docsRegenTimers.set(mapKey, setTimeout(() => {
      docsRegenTimers.delete(mapKey);
      fsp.access(epicMemoryPaths(epic.id).manifest).then(
        () => { try { startEpicDocsJob(epic.id); } catch {} },
        () => {});
    }, delayMs));
  }
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
    model: currentModelLabel(),
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
    model: currentModelLabel(),
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

// ---------- native Alacritty launch + process scan ----------
function firstExisting(paths) {
  return paths.find(p => p && fs.existsSync(p)) || null;
}

function alacrittyBin() {
  return process.env.AICONVO_TERMINAL
    || firstExisting(['/snap/bin/alacritty', '/usr/bin/alacritty', '/usr/local/bin/alacritty'])
    || 'alacritty';
}

function python3Bin() {
  return firstExisting(['/usr/bin/python3', '/usr/local/bin/python3']) || 'python3';
}

function bridgeScript() {
  return path.join(__dirname, 'aiconvo-bridge.py');
}

function socketPathForTitle(title) {
  return path.join(CACHE_DIR, 'pty', String(title || 'unknown') + '.sock');
}

// Launched-window registry: maps a custom Alacritty title (aiconvo-project-*,
// aiconvo-git-*) to the conversation key discovered after launch. Without it,
// the app cannot bind a project-start terminal to its conversation, thinks no
// live terminal exists, and a send spawns a second writer on the same session.
const LAUNCHED_TITLES_FILE = path.join(CACHE_DIR, 'launched-windows.json');
let launchedTitles = null; // title -> key

function loadLaunchedTitles() {
  if (launchedTitles) return launchedTitles;
  launchedTitles = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(LAUNCHED_TITLES_FILE, 'utf8'));
    for (const [title, key] of Object.entries(raw)) launchedTitles.set(title, key);
  } catch {}
  return launchedTitles;
}

function recordLaunchedTitle(title, key) {
  if (!title || !key) return;
  const map = loadLaunchedTitles();
  map.set(title, key);
  while (map.size > 200) map.delete(map.keys().next().value);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LAUNCHED_TITLES_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch {}
}

function keyForLaunchedTitle(title) {
  if (!title) return null;
  return loadLaunchedTitles().get(title) || null;
}

function piBin() {
  return process.env.AICONVO_PI
    || firstExisting([
      path.join(os.homedir(), '.nvm/versions/node/v22.23.1/bin/pi'),
      '/usr/local/bin/pi',
    ])
    || 'pi';
}

function claudeBin() {
  return process.env.AICONVO_CLAUDE
    || firstExisting([
      path.join(os.homedir(), '.local/bin/claude'),
      '/usr/local/bin/claude',
    ])
    || 'claude';
}

function agentEnv() {
  const extra = [
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.nvm/versions/node/v22.23.1/bin'),
    '/run/current-system/sw/bin', // NixOS: xdg-open, git… live here
    '/snap/bin',
  ].filter(d => fs.existsSync(d));
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const xauthority = process.env.XAUTHORITY
    || firstExisting([
      path.join(os.homedir(), '.Xauthority'),
      '/run/user/' + uid + '/gdm/Xauthority',
    ]);
  return {
    ...process.env,
    HOME: os.homedir(),
    DISPLAY: process.env.DISPLAY || ':0',
    ...(xauthority ? { XAUTHORITY: xauthority } : {}),
    PATH: [...extra, process.env.PATH || '/usr/bin:/bin'].join(':'),
  };
}

function conversationKind(entry) {
  if (entry.source === 'claude') return 'claude';
  if (entry.source === 'pi' || entry.source === 'pi-remote') return 'pi';
  return null;
}

function windowTitleFor(key) {
  return 'aiconvo-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && args[i + 1]) return args[i + 1];
      if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
    }
  }
  return null;
}

function parseCmdline(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline').toString().split('\0').filter(Boolean);
  } catch { return null; }
}

function isInteractiveAgent(args) {
  if (!args || !args.length) return false;
  if (args.includes('--no-session') || args.includes('-p') || args.includes('--print')) return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1] === 'rpc') return false;
    if (args[i] === '--mode=rpc') return false;
  }
  const names = args.map(a => path.basename(a).toLowerCase());
  return names.includes('pi') || names.includes('claude') || names.includes('alacritty');
}

function matchArgsToKey(args) {
  const title = flagValue(args, ['--title', '-t']);
  if (title) {
    const mapped = keyForLaunchedTitle(title);
    if (mapped && index[mapped]) return mapped;
  }
  if (title && title.startsWith('aiconvo-') && !title.startsWith('aiconvo-project-')) {
    for (const key of Object.keys(index)) {
      if (windowTitleFor(key) === title) return key;
    }
  }
  const session = flagValue(args, ['--session']);
  if (session) {
    let resolved = session;
    try { resolved = path.resolve(session); } catch {}
    for (const [key, e] of Object.entries(index)) {
      const relPath = key.slice(e.source.length + 1);
      try {
        if (path.resolve(SOURCES[e.source], relPath) === resolved) return key;
      } catch {}
      if (e.sessionId && (session === e.sessionId || e.sessionId.startsWith(session) || session.startsWith(e.sessionId))) return key;
    }
  }
  const resume = flagValue(args, ['--resume', '-r', '--session-id']);
  if (resume) {
    for (const [key, e] of Object.entries(index)) {
      if (e.sessionId && (resume === e.sessionId || e.sessionId.startsWith(resume) || resume.startsWith(e.sessionId))) return key;
    }
  }
  return null;
}

function listRunningAgents() {
  const running = [];
  const seen = new Set();
  let pids = [];
  try { pids = fs.readdirSync('/proc'); } catch { return running; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const args = parseCmdline(pid);
    if (!isInteractiveAgent(args)) continue;
    const key = matchArgsToKey(args);
    const title = flagValue(args, ['--title', '-t']);
    const names = args.map(a => path.basename(a).toLowerCase());
    const kind = names.includes('claude') ? 'claude' : names.includes('pi') ? 'pi' : null;
    if (!key && !(title && title.startsWith('aiconvo-'))) continue;
    const id = key || title;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let cwd = null;
    try { cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch {}
    const entry = key ? index[key] : null;
    running.push({
      pid: Number(pid),
      key: key || null,
      kind: kind || (entry && conversationKind(entry)) || 'pi',
      title: entry ? (entry.timelineTitle || entry.title) : title,
      cwd: cwd || (entry && entry.cwd) || null,
      windowTitle: title || (key && windowTitleFor(key)) || null,
      source: entry ? entry.source : (kind || 'pi'),
    });
  }
  return running;
}

function findRunningConversation(key) {
  if (!key) return null;
  return listRunningAgents().find(item => item.key === key) || null;
}

// Ambient "who is working" signal. Every 15 s, diff the set of session keys
// that a live terminal agent owns; broadcast only when the set changes. The
// browser pairs this with file mtimes and headless runs to paint a static
// working/recent mark — no browser polling, no per-second churn (e-ink safe).
function runningAgentKeys() {
  try { return [...new Set(listRunningAgents().map(r => r.key).filter(Boolean))].sort(); }
  catch { return []; }
}
// Identifies this server process. A client that reconnects and sees a new
// boot id knows the server (and possibly the interface) was replaced — it
// offers a reload instead of running yesterday's code against today's API.
const BOOT_ID = crypto.randomUUID();
let runningAgentsSig = null;
setInterval(() => {
  const keys = runningAgentKeys();
  const sig = keys.join('|');
  if (sig === runningAgentsSig) return;
  runningAgentsSig = sig;
  broadcast({ type: 'agents', keys });
}, 15000).unref();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findWindowId(title) {
  if (!title) return null;
  const patterns = ['^' + title + '$', title];
  for (const name of patterns) {
    try {
      const out = execFileSync('xdotool', ['search', '--onlyvisible', '--name', name], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: agentEnv(),
      });
      const wid = String(out).trim().split('\n').filter(Boolean).pop();
      if (wid) return wid;
    } catch {}
  }
  return null;
}

function focusWindow(title) {
  const wid = findWindowId(title);
  if (!wid) return false;
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', wid], {
      timeout: 3000, stdio: 'ignore', env: agentEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForWindow(title, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const wid = findWindowId(title);
    if (wid) return wid;
    await sleep(200);
  }
  return null;
}

function setClipboard(kind, payload, mime) {
  const args = ['-selection', 'clipboard'];
  if (kind === 'image') args.push('-t', mime || 'image/png');
  execFileSync('xclip', args, {
    input: payload,
    timeout: 10000,
    env: agentEnv(),
  });
}

function trySetClipboard(kind, payload, mime) {
  try { setClipboard(kind, payload, mime); return true; }
  catch { return false; }
}

async function saveInboxImage(img, index) {
  const dir = path.join(CACHE_DIR, 'inbox');
  await fsp.mkdir(dir, { recursive: true });
  const ext = (img.mime || '').includes('jpeg') || (img.mime || '').includes('jpg') ? '.jpg'
    : (img.mime || '').includes('webp') ? '.webp'
    : (img.mime || '').includes('gif') ? '.gif'
    : '.png';
  const file = path.join(dir, Date.now() + '-' + index + ext);
  await fsp.writeFile(file, img.buf);
  return file;
}

function sendKeys(wid, combo) {
  execFileSync('xdotool', ['windowactivate', '--sync', wid], {
    timeout: 3000, stdio: 'ignore', env: agentEnv(),
  });
  execFileSync('xdotool', ['key', '--window', wid, '--clearmodifiers', combo], {
    timeout: 3000, stdio: 'ignore', env: agentEnv(),
  });
}

function spawnAlacritty(cwd, title, argv) {
  const term = alacrittyBin();
  const sock = socketPathForTitle(title);
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const child = spawn(term, [
    '--title', title,
    '--working-directory', cwd,
    '-e', python3Bin(), bridgeScript(), sock, '--', ...argv,
  ], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: agentEnv(),
  });
  child.unref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, title, terminal: term, socket: sock }), 200);
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error('Could not start ' + term + ': ' + err.message));
    });
  });
}

function bridgeRequest(title, msg, timeoutMs = 3000) {
  const sock = socketPathForTitle(title);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('bridge timeout'));
    }, timeoutMs);
    const client = net.createConnection(sock);
    let buf = '';
    client.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    client.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      client.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); }
      catch (e) { reject(e); }
    });
    client.on('connect', () => client.write(JSON.stringify(msg) + '\n'));
  });
}

async function bridgePing(title) {
  try {
    const res = await bridgeRequest(title, { op: 'ping' }, 800);
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

async function waitForBridge(title, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await bridgePing(title)) return true;
    await sleep(150);
  }
  return false;
}

function extractChoices(text) {
  const choices = [];
  const re = /^[ \t]*[›>❯]?\s*(\d+)\.\s+(\S.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const label = m[2].replace(/\s+$/, '');
    if (label.length > 120) continue;
    choices.push({ id: m[1], label });
  }
  const seen = new Set();
  return choices.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

function classifyPane(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const choices = extractChoices(raw);
  if (/resume from summary/.test(t) && /resume full session/.test(t)) {
    return { state: 'picker', reason: 'claude-resume', choices: choices.length ? choices : [
      { id: '1', label: 'Resume from summary (recommended)' },
      { id: '2', label: 'Resume full session as-is' },
      { id: '3', label: "Don't ask me again" },
    ] };
  }
  if (choices.length >= 2 && (/enter to confirm/.test(t) || /esc to cancel/.test(t))) {
    return { state: 'picker', reason: 'numbered', choices };
  }
  if (/\byes\b/.test(t) && /\bno\b/.test(t) && (/allow/.test(t) || /permission/.test(t))) {
    return { state: 'permission', reason: 'permission', choices: [
      { id: 'y', label: 'Yes / allow' },
      { id: 'n', label: 'No / deny' },
    ] };
  }
  if (!raw.trim()) return { state: 'booting', reason: 'empty', choices: [] };
  return { state: 'ready', reason: 'prompt', choices: [] };
}

async function captureConversation(key) {
  const entry = index[key];
  if (!entry) throw new Error('Conversation not found.');
  const title = windowTitleFor(key);
  const running = findRunningConversation(key);
  const liveTitle = (running && running.windowTitle) || title;
  if (!(await bridgePing(liveTitle))) {
    return { ok: true, attached: false, title: liveTitle, text: '', state: 'offline', choices: [] };
  }
  const cap = await bridgeRequest(liveTitle, { op: 'capture' });
  const text = (cap && cap.text) || '';
  const cls = classifyPane(text);
  // raw === false means the TUI has not switched the tty to raw mode yet:
  // pasted bytes would be line-buffered and kernel-echoed, and Enter would
  // merge into the paste burst. Treat that as still booting.
  if (cap && cap.raw === false) Object.assign(cls, { state: 'booting', reason: 'tty-cooked' });
  return { ok: true, attached: true, title: liveTitle, text, html: (cap && cap.html) || '', rows: cap.rows, cols: cap.cols, ...cls };
}

async function actOnConversation(key, payload) {
  const opened = await openConversationInTerminal(key, { focus: !payload || !payload.quick });
  const title = opened.title;
  if (!(await waitForBridge(title))) throw new Error('Terminal bridge did not start.');
  if (payload && payload.keys != null) {
    await bridgeRequest(title, { op: 'keys', data: String(payload.keys) });
  } else if (payload && payload.choice != null) {
    const choice = String(payload.choice);
    const data = /^[yn]$/i.test(choice) ? choice : choice + '\r';
    await bridgeRequest(title, { op: 'keys', data });
  } else if (payload && payload.enter) {
    await bridgeRequest(title, { op: 'enter' });
  } else if (payload && payload.esc) {
    await bridgeRequest(title, { op: 'esc' });
  } else {
    throw new Error('No action.');
  }
  if (payload && payload.quick) return { ok: true, acted: true, ...opened };
  await sleep(200);
  const pane = await captureConversation(key);
  return { ok: true, acted: true, ...opened, ...pane };
}

async function openConversationInTerminal(key, opts) {
  const focus = !opts || opts.focus !== false;
  const entry = index[key];
  if (!entry) throw new Error('Conversation not found.');
  const kind = conversationKind(entry);
  if (!kind) throw new Error('This conversation source cannot open in a terminal.');
  const title = windowTitleFor(key);
  // The terminal is sovereign: any headless web run on this file yields now.
  await releaseHeadless(absPathForKey(key), 'terminal opened');
  const running = findRunningConversation(key);
  if (running) {
    const focused = focus ? focusWindow(running.windowTitle || title) : false;
    return { ok: true, created: false, focused, pid: running.pid, title: running.windowTitle || title, kind };
  }
  if (focus && focusWindow(title)) return { ok: true, created: false, focused: true, title, kind };
  const { sessionPath, cwd } = sessionPathsFor(key);
  const argv = kind === 'claude'
    ? [claudeBin(), '--resume', entry.sessionId]
    : [piBin(), '--session', sessionPath];
  if (!argv[2]) throw new Error('This conversation has no session identifier.');
  await spawnAlacritty(cwd, title, argv);
  return { ok: true, created: true, focused: false, title, kind, cwd };
}

function decodeImagePayload(img) {
  if (!img || !img.data) return null;
  const mime = String(img.mime || 'image/png').toLowerCase();
  if (!mime.startsWith('image/')) return null;
  const buf = Buffer.from(String(img.data), 'base64');
  if (!buf.length) return null;
  return { mime, buf };
}

// Browser composer images → pi RPC ImageContent blocks. The browser already
// downscaled and re-encoded; this only validates and caps.
function rpcImagesOf(raw) {
  const out = [];
  for (const img of Array.isArray(raw) ? raw : []) {
    if (!img || typeof img.data !== 'string' || !img.data) continue;
    const mime = String(img.mime || img.mimeType || 'image/png').toLowerCase();
    if (!mime.startsWith('image/')) continue;
    if (img.data.length > 16 * 1024 * 1024) continue; // ~12 MB decoded
    out.push({ type: 'image', data: img.data, mimeType: mime });
    if (out.length >= 8) break;
  }
  return out;
}

function pasteEchoFragment(body) {
  const line = String(body || '').split('\n').find(l => l.trim()) || '';
  return line.trim().slice(0, 16);
}

// Wait until the TUI enables bracketed paste (DECSET 2004). Only then does a
// paste land as one atomic block and Enter submit instead of joining it.
// Some programs never enable it, so the caller proceeds after the timeout.
async function waitForPasteMode(title, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await bridgeRequest(title, { op: 'ping' }, 800);
      if (res && res.paste) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

async function waitForPasteEcho(title, body, ms) {
  const frag = pasteEchoFragment(body);
  if (!frag) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const cap = await bridgeRequest(title, { op: 'capture' });
      const text = (cap && cap.text) || '';
      if (text.includes(frag)) return true;
      if (/pasted text/i.test(text)) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function composerHoldsText(text, frag) {
  const lines = String(text || '').split('\n').map(l => l.trim());
  const edges = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[\u2500\u2501\u2504\u2508\u254c-]{10,}$/.test(lines[i])) edges.push(i);
    else if (/^\u256d[\u2500]+\u256e$/.test(lines[i]) || /^\u2570[\u2500]+\u256f$/.test(lines[i])) edges.push(i);
  }
  if (edges.length < 2) return String(text || '').includes(frag);
  const top = edges[edges.length - 2];
  const bottom = edges[edges.length - 1];
  return lines.slice(top + 1, bottom).join('\n').includes(frag);
}

async function confirmSubmit(title, body) {
  const frag = pasteEchoFragment(body);
  if (!frag) return true;
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    let cap;
    try { cap = await bridgeRequest(title, { op: 'capture' }); } catch { return false; }
    const text = (cap && cap.text) || '';
    if (/esc to interrupt/i.test(text)) return true;
    const cls = classifyPane(text);
    if (cls.state === 'picker' || cls.state === 'permission') return false;
    if (!composerHoldsText(text, frag)) return true;
    try { await bridgeRequest(title, { op: 'enter' }); } catch { return false; }
  }
  return false;
}

async function sendToConversation(key, payload) {
  let text = payload && payload.text != null ? String(payload.text) : '';
  const rawImages = Array.isArray(payload && payload.images) ? payload.images : [];
  const images = rawImages.map(decodeImagePayload).filter(Boolean).slice(0, 8);
  const contextItems = payload && payload.context !== undefined
    ? normalizeContextItems(payload.context) : conversationContextOf(key);
  if (payload && payload.context !== undefined) saveConversationContext(key, contextItems);
  if (contextItems.length) {
    const bundle = await writeAttachedContextFile(contextItems);
    text = bundle.text + (text.trim() ? '\n\n---\n\n' + text : '');
  }
  if (!text.trim() && !images.length) throw new Error('Type text or attach an image first.');
  const opened = await openConversationInTerminal(key);
  const title = opened.title;
  const hasBridge = await waitForBridge(title, opened.created ? 15000 : 800);
  if (hasBridge) {
    if (opened.created) await sleep(300);
    let pane = await captureConversation(key);
    const bootDeadline = Date.now() + (opened.created ? 20000 : 4000);
    while (pane.state === 'booting' && Date.now() < bootDeadline) {
      await sleep(300);
      pane = await captureConversation(key);
    }
    if (pane.state === 'booting') {
      throw new Error('The agent terminal is still starting. Try again in a moment.');
    }
    if (pane.state === 'picker' || pane.state === 'permission') {
      const err = new Error(pane.state === 'picker'
        ? 'The terminal is waiting for a choice. Pick one below.'
        : 'The terminal is waiting for a permission answer.');
      err.blocked = { ...pane, opened };
      throw err;
    }
    const files = [];
    for (let i = 0; i < images.length; i++) {
      files.push(await saveInboxImage(images[i], i));
      trySetClipboard('image', images[i].buf, images[i].mime);
      await sleep(60);
      try { await bridgeRequest(title, { op: 'ctrl', key: 'v' }); } catch {}
      await sleep(250);
    }
    const body = [files.map(f => '@' + f).join(' '), text].filter(Boolean).join('\n');
    if (body) {
      await waitForPasteMode(title, opened.created ? 6000 : 1200);
      await bridgeRequest(title, { op: 'paste', text: body });
      await waitForPasteEcho(title, body, opened.created ? 8000 : 2000);
      await sleep(150);
    }
    await bridgeRequest(title, { op: 'enter' });
    const submitted = body ? await confirmSubmit(title, body) : true;
    return { ok: true, sent: true, submitted, via: 'bridge', images: files.length, files, chars: text.length, ...opened };
  }
  const wid = await waitForWindow(title);
  if (!wid) {
    const env = agentEnv();
    throw new Error(
      'Alacritty did not open (DISPLAY=' + (env.DISPLAY || '?') +
      ', XAUTHORITY=' + (env.XAUTHORITY ? 'set' : 'missing') + ').'
    );
  }
  if (opened.created) await sleep(1800);
  else await sleep(150);
  const files = [];
  for (let i = 0; i < images.length; i++) {
    files.push(await saveInboxImage(images[i], i));
    trySetClipboard('image', images[i].buf, images[i].mime);
    await sleep(80);
    try { sendKeys(wid, 'ctrl+v'); } catch {}
    await sleep(250);
  }
  const body = [files.map(f => '@' + f).join(' '), text].filter(Boolean).join('\n');
  if (body) {
    trySetClipboard('text', body);
    await sleep(80);
    sendKeys(wid, 'ctrl+shift+v');
    await sleep(opened.created ? 600 : 150);
  }
  sendKeys(wid, 'Return');
  return { ok: true, sent: true, via: 'xdotool', images: files.length, files, chars: text.length, ...opened };
}

async function sendFileFeedback(body) {
  const key = body.key || '';
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const image = String(body.image || '');
  const match = image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('image must be a PNG data URL');
  const dir = path.join(CACHE_DIR, 'feedback');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = path.join(dir, stamp + '.png');
  const mdPath = path.join(dir, stamp + '.md');
  await fsp.writeFile(pngPath, Buffer.from(match[1], 'base64'));
  const rel = body.relativePath || body.path || 'file';
  const md = [
    '# Inked file feedback',
    '',
    `- File: ${body.path || rel}`,
    `- Lines: ${body.fromLine || '?'}–${body.toLine || '?'}`,
    `- Page: ${body.page || 1}/${body.pages || 1}`,
    `- Image: ${pngPath}`,
    `- Conversation: ${key}`,
    '',
    'The red ink is the user\'s requested edit. Apply those marks to the file.',
    '',
  ].join('\n');
  await fsp.writeFile(mdPath, md);
  if (findRunningConversation(key)) {
    return { ok: true, launched: false, pngPath, mdPath, warning: 'that conversation is already open. The marked page was saved.' };
  }
  const kind = conversationKind(entry);
  const { sessionPath, cwd } = sessionPathsFor(key);
  const prompt = `Read ${mdPath} and the PNG at ${pngPath}. The red ink is requested file feedback for ${rel} lines ${body.fromLine}–${body.toLine} (page ${body.page}/${body.pages}). Apply those edits.`;
  const argv = kind === 'claude'
    ? [claudeBin(), '--resume', entry.sessionId, prompt]
    : [piBin(), '--session', sessionPath, '@' + pngPath, prompt];
  await spawnAlacritty(cwd || entry.cwd || os.homedir(), windowTitleFor(key) + ' feedback', argv);
  return { ok: true, launched: true, pngPath, mdPath };
}

// ---------- agent file diffs ----------
// Extract intended file changes from edit/write tool calls. These are agent
// file touches, not Git diffs: a tool call can fail and files can change later.
const DIFF_CACHE_FILE = path.join(CACHE_DIR, 'diff-cache.json');
let diffCache = {};
try { diffCache = JSON.parse(fs.readFileSync(DIFF_CACHE_FILE, 'utf8')); } catch {}
const DIFF_CACHE_VERSION = 'v6:';


function pruneDiffCache() {
  for (const key of Object.keys(diffCache)) {
    const row = diffCache[key];
    const stale = !row || typeof row.cacheKey !== 'string' || !row.cacheKey.startsWith(DIFF_CACHE_VERSION) || !index[key];
    if (stale) delete diffCache[key];
  }
}
pruneDiffCache();

function saveDiffCacheSoon() {
  clearTimeout(saveDiffCacheSoon.t);
  saveDiffCacheSoon.t = setTimeout(() => {
    pruneDiffCache();
    fs.writeFile(DIFF_CACHE_FILE, JSON.stringify(diffCache), () => {});
  }, 500);
}

function diffEventHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function lineCount(text) { return text ? String(text).split('\n').length : 0; }
function makeDiffEvent(key, entry, pathValue, kind, oldText, newText, ts, editIndex, callId = null) {
  if (!pathValue) return null;
  // pi often records relative paths; resolve them against the session cwd so
  // grouping and disk reads work across conversations.
  if (String(pathValue).startsWith('~/')) pathValue = path.join(os.homedir(), String(pathValue).slice(2));
  else if (!path.isAbsolute(String(pathValue)) && entry.cwd) pathValue = path.resolve(entry.cwd, String(pathValue));
  const oldLines = lineCount(oldText), newLines = lineCount(newText);
  const relativePath = entry.cwd && String(pathValue).startsWith(entry.cwd + '/')
    ? String(pathValue).slice(entry.cwd.length + 1)
    : path.basename(String(pathValue));
  const id = diffEventHash([key, pathValue, kind, ts, editIndex, oldText, newText]);
  return {
    id, key, source: entry.source || 'claude', project: projectOfEntry(entry, key),
    path: String(pathValue), relativePath, ts: ts || null, kind,
    conversationTitle: entry.timelineTitle || entry.title || key,
    agent: entry.source === 'claude' ? 'claude' : 'pi', branch: entry.gitBranch || null,
    oldText: oldText || null, newText: newText || null, editIndex, callId,
    outcome: 'unknown', resultSummary: null,
    stats: {
      oldChars: oldText ? oldText.length : 0,
      newChars: newText ? newText.length : 0,
      oldLines, newLines,
    },
  };
}

function shellWords(text) {
  return [...String(text || '').matchAll(/"([^"]+)"|'([^']+)'|([^\s;&|]+)/g)].map(match => match[1] || match[2] || match[3]);
}

function shellWithoutHeredocBodies(command) {
  const kept = [];
  let delimiter = null;
  for (const line of String(command || '').split('\n')) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const match = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (match) delimiter = match[1];
  }
  return kept.join('\n');
}

function shellSegments(command) {
  const out = [];
  let part = '', quote = null, escaped = false;
  const text = String(command || '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) { part += char; escaped = false; continue; }
    if (char === '\\') { part += char; escaped = true; continue; }
    if (quote) {
      part += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; part += char; continue; }
    const pair = text.slice(i, i + 2);
    if (char === '\n' || char === ';' || char === '|' || pair === '&&' || pair === '||') {
      if (part.trim()) out.push(part.trim());
      part = '';
      if (pair === '&&' || pair === '||') i++;
      continue;
    }
    part += char;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

function shellMutationPaths(command) {
  const source = String(command || '');
  const shell = shellWithoutHeredocBodies(source);
  const found = new Set();
  const add = value => {
    value = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value || /[$*?<>()[\]{}]/.test(value) || value === '/dev/null' || value.startsWith('-')) return;
    found.add(value);
  };
  // Patch and literal-language writes remain useful inside a heredoc.
  for (const match of source.matchAll(/^\s*\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)$/gm)) add(match[1]);
  for (const match of source.matchAll(/\bPath\(\s*['"]([^'"]+)['"]\s*\)\.(?:write_text|write_bytes|rename|replace)\b/g)) add(match[1]);
  for (const match of source.matchAll(/\bopen\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/g)) add(match[1]);
  for (const match of source.matchAll(/\b(?:writeFileSync|writeFile)\(\s*['"]([^'"]+)['"]/g)) add(match[1]);
  for (const match of shell.matchAll(/(?:^|[\s\d])>>?\s*(['"]?[^\s;&|'"]+['"]?)/gm)) add(match[1]);
  for (const segment of shellSegments(shell)) {
    let words = shellWords(segment.trim());
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['then', 'do', 'sudo', 'env', 'command'].includes(words[0]))) words.shift();
    if (!words.length) continue;
    let commandName = path.basename(words[0]);
    let args = words.slice(1);
    if (commandName === 'git' && ['mv', 'rm'].includes(args[0])) { commandName = args[0]; args = args.slice(1); }
    if (['sed', 'perl'].includes(commandName)) {
      if (args.some(word => /^-(?:i|pi)/.test(word))) add(args[args.length - 1]);
      continue;
    }
    if (!['mv', 'cp', 'install', 'rm', 'touch', 'truncate', 'tee'].includes(commandName)) continue;
    args = args.filter(word => !word.startsWith('-'));
    if (commandName === 'mv') args.slice(-2).forEach(add);
    else if (commandName === 'cp' || commandName === 'install') args.slice(-1).forEach(add);
    else args.forEach(add);
  }
  return [...found];
}

function shellMutationEvents(key, entry, input, ts, callId) {
  const command = input && (input.command || input.cmd) || '';
  let shellEntry = entry;
  const cd = String(command).match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*&&/);
  if (cd && entry.cwd) shellEntry = { ...entry, cwd: path.resolve(entry.cwd, cd[1] || cd[2] || cd[3]) };
  const hasOtherCd = /(?:^|[;&|]\s*)cd\s+/m.test(String(command).replace(/^\s*cd\s+[^;&|]+\s*&&/, ''));
  return shellMutationPaths(command).filter(file => path.isAbsolute(file) || file.startsWith('~/') || !hasOtherCd).map((file, i) => {
    const event = makeDiffEvent(key, shellEntry, file, 'shell', null, null, ts, i, callId);
    if (event) event.command = clipped(command, 8000);
    return event;
  }).filter(Boolean);
}

function diffEventsFromContent(key, entry, name, input, ts, callId = null) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const lower = String(name || '').toLowerCase();
  if (lower === 'bash' || lower === 'shell') return shellMutationEvents(key, entry, input, ts, callId);
  const pathValue = input.file_path || input.path || input.notebook_path || null;
  if (!pathValue) return out;
  if (lower === 'write') out.push(makeDiffEvent(key, entry, pathValue, 'write', null, input.content || '', ts, 0, callId));
  else if (Array.isArray(input.edits)) {
    input.edits.forEach((edit, i) => out.push(makeDiffEvent(key, entry, pathValue, 'multi-edit', edit.oldText || edit.old_string || '', edit.newText || edit.new_string || '', ts, i, callId)));
  } else if (lower === 'edit' || lower === 'multiedit') {
    out.push(makeDiffEvent(key, entry, pathValue, lower === 'multiedit' ? 'multi-edit' : 'edit', input.oldText || input.old_string || '', input.newText || input.new_string || '', ts, 0, callId));
  }
  return out.filter(Boolean);
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => typeof item === 'string' ? item : item && (item.text || item.content) || '').filter(Boolean).join('\n');
}

async function conversationDiffs(key) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  // Use disk stats, not the index, so a missed watch event cannot serve stale diffs.
  let mtimeMs = entry.mtimeMs || 0, size = entry.size || 0;
  try {
    const st = await fsp.stat(absPathForKey(key));
    mtimeMs = st.mtimeMs; size = st.size;
  } catch {}
  const cacheKey = DIFF_CACHE_VERSION + String(mtimeMs) + ':' + String(size);
  const cached = diffCache[key];
  if (cached && cached.cacheKey === cacheKey) return cached.events;
  const raw = await fsp.readFile(absPathForKey(key), 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  const results = new Map();
  for (const d of records) {
    if (entry.source === 'claude') {
      for (const block of (d.message && d.message.content) || []) {
        if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;
        const text = toolResultText(block.content);
        results.set(block.tool_use_id, { outcome: block.is_error ? 'failed' : 'applied', text });
      }
    } else if (d.type === 'message' && d.message && d.message.role === 'toolResult' && d.message.toolCallId) {
      const text = toolResultText(d.message.content);
      results.set(d.message.toolCallId, { outcome: d.message.isError || d.message.is_error ? 'failed' : 'applied', text });
    }
  }
  const events = [];
  for (const d of records) {
    if (entry.source === 'claude') {
      if (d.type !== 'assistant' || d.isSidechain || d.isMeta) continue;
      for (const b of (d.message && d.message.content) || []) {
        if (!b || b.type !== 'tool_use') continue;
        events.push(...diffEventsFromContent(key, entry, b.name, b.input, d.timestamp, b.id || null));
      }
    } else {
      if (d.type !== 'message' || !d.message || d.message.role !== 'assistant') continue;
      for (const b of d.message.content || []) {
        if (!b || b.type !== 'toolCall') continue;
        events.push(...diffEventsFromContent(key, entry, b.name, b.arguments, d.timestamp, b.id || null));
      }
    }
  }
  for (const event of events) {
    const result = event.callId && results.get(event.callId);
    if (!result) continue;
    event.outcome = result.outcome;
    event.resultSummary = clipped(result.text, 500);
  }
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.path.localeCompare(b.path) || a.editIndex - b.editIndex);
  diffCache[key] = { cacheKey, events, createdAt: Date.now() };
  saveDiffCacheSoon();
  return events;
}

// Targeted view for ONE clicked file-change tool call. It reuses the cached
// conversationDiffs parse (one transcript read, no snapshot reconstruction,
// no conversation-wide grouping) and ships the current disk file so the
// editor opens with zero further requests. The conversation-wide keyframe
// history stays an explicit opt-in from the client.
async function conversationFileEventResponse(key, callId, tsValue, pathValue) {
  const entry = index[key];
  if (!entry) throw new Error('not found');
  const events = await conversationDiffs(key);
  let picked = callId ? events.filter(e => e.callId === callId) : [];
  // One bash call can touch several files; the clicked path narrows the view.
  if (picked.length > 1 && pathValue) {
    const byPath = picked.filter(e => e.path === pathValue || e.relativePath === pathValue || e.path.endsWith('/' + pathValue));
    if (byPath.length) picked = byPath;
  }
  if (!picked.length && pathValue) {
    const same = events.filter(e => e.path === pathValue || e.relativePath === pathValue || e.path.endsWith('/' + pathValue));
    const wantMs = Date.parse(tsValue || '');
    if (Number.isFinite(wantMs) && same.length) {
      let best = null, bestGap = Infinity;
      for (const e of same) {
        const gap = Math.abs((Date.parse(e.ts || '') || 0) - wantMs);
        if (gap < bestGap) { best = e; bestGap = gap; }
      }
      picked = best && best.callId ? same.filter(e => e.callId === best.callId) : best ? [best] : [];
    }
    if (!picked.length) picked = same.slice(-1);
  }
  if (!picked.length) throw new Error('no recorded file change for this tool call');
  const abs = picked[0].path;
  let disk = null;
  try {
    const checked = await editableFilePath(abs);
    const text = await fsp.readFile(checked, 'utf8');
    disk = { path: checked, text, sha: sha256Hex(text), editable: true };
  } catch (error) {
    try {
      const st = await fsp.stat(abs);
      if (st.isFile() && st.size <= FILE_EDIT_MAX)
        disk = { path: abs, text: await fsp.readFile(abs, 'utf8'), sha: null, editable: false, note: error.message };
    } catch {}
  }
  return {
    key, path: abs, relativePath: picked[0].relativePath, cwd: entry.cwd || null,
    events: picked.map(e => ({
      id: e.id, kind: e.kind, ts: e.ts, editIndex: e.editIndex, outcome: e.outcome,
      resultSummary: e.resultSummary, oldText: e.oldText, newText: e.newText, command: e.command || null,
    })),
    disk,
  };
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

// ---------- Git-weaved project file history ----------
const gitHistoryCache = new Map();
const gitPatchCache = new Map();
const gitTrackedCache = new Map();
const cwdGitRootCache = new Map();
const worktreeCache = new Map();
const GIT_REPOS_FILE = path.join(CACHE_DIR, 'git-repos.json');
const GIT_HIST_DIR = path.join(CACHE_DIR, 'git-history');

function execText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000, ...options },
      (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout || '')));
  });
}

async function gitText(root, args) {
  return execText('git', ['-C', root, ...args]);
}

async function projectGitRepositories(meta) {
  const roots = new Set();
  for (const cwd of [...new Set(meta.entries.map(({ entry }) => entry.cwd).filter(Boolean))]) {
    try {
      const root = (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim();
      if (root && fs.existsSync(root)) roots.add(path.resolve(root));
    } catch {}
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

function renamedNumstatPath(value) {
  const text = String(value || '');
  const brace = text.match(/^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/);
  if (brace) return brace[1] + brace[3] + brace[4];
  const arrow = text.lastIndexOf(' => ');
  return arrow >= 0 ? text.slice(arrow + 4) : text;
}

function parseGitLog(text, root) {
  const commits = [];
  for (const record of String(text).split('\x1e')) {
    if (!record.trim()) continue;
    const lines = record.replace(/^\n/, '').split('\n');
    const fields = lines.shift().split('\x1f');
    if (fields.length < 7) continue;
    const [hash, shortHash, parents, ts, author, email, subject, decorate] = fields;
    const files = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!match) continue;
      files.push({
        path: renamedNumstatPath(match[3]),
        additions: match[1] === '-' ? null : Number(match[1]),
        deletions: match[2] === '-' ? null : Number(match[2]),
      });
    }
    const branches = String(decorate || '').split(',').map(part => part.trim())
      .map(part => part.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
      .filter(part => part && part !== 'HEAD');
    commits.push({
      hash, shortHash, parents: parents ? parents.split(' ') : [], ts, author, email, subject,
      repoRoot: root, branches: [...new Set(branches)].slice(0, 12), files,
    });
  }
  return commits;
}

function parseGitStatus(text) {
  const rows = [];
  const parts = String(text).split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const status = item.slice(0, 2);
    let file = item.slice(3);
    if ((status.includes('R') || status.includes('C')) && parts[i + 1]) file = parts[++i];
    rows.push({ path: file, status });
  }
  return rows;
}

async function resolveGitDir(root) {
  const marker = path.join(root, '.git');
  try {
    const st = await fsp.stat(marker);
    if (st.isDirectory()) return marker;
    const text = await fsp.readFile(marker, 'utf8');
    const match = text.match(/^gitdir:\s*(.+)$/m);
    if (match) return path.resolve(root, match[1].trim());
  } catch {}
  return marker;
}

async function stampPath(file) {
  try {
    const st = await fsp.stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch { return '0'; }
}

async function walkRefStamps(dir, depth = 0) {
  if (depth > 6) return '';
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return ''; }
  let out = '';
  for (const ent of ents) {
    const next = path.join(dir, ent.name);
    out += ent.isDirectory()
      ? ent.name + '{' + await walkRefStamps(next, depth + 1) + '}'
      : ent.name + ':' + await stampPath(next) + ';';
  }
  return out;
}

async function gitHistorySignature(root) {
  const dir = await resolveGitDir(root);
  const parts = [await stampPath(path.join(dir, 'HEAD')), await stampPath(path.join(dir, 'packed-refs'))];
  try {
    const common = path.resolve(dir, (await fsp.readFile(path.join(dir, 'commondir'), 'utf8')).trim());
    parts.push(await stampPath(path.join(common, 'packed-refs')));
    parts.push(await walkRefStamps(path.join(common, 'refs')));
  } catch {
    parts.push(await walkRefStamps(path.join(dir, 'refs')));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

function gitHistoryDiskPath(root, histSig) {
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(GIT_HIST_DIR, id + '-' + histSig + '.json');
}

async function readGitHistoryDisk(root, histSig) {
  try {
    const data = JSON.parse(await fsp.readFile(gitHistoryDiskPath(root, histSig), 'utf8'));
    if (data && data.root === root && Array.isArray(data.commits)) return data;
  } catch {}
  return null;
}

function writeGitHistoryDisk(root, histSig, value) {
  const payload = {
    root: value.root, id: value.id, currentBranch: value.currentBranch, head: value.head,
    refs: value.refs, commits: value.commits, truncated: value.truncated, histSig,
  };
  fsp.mkdir(GIT_HIST_DIR, { recursive: true }).then(() =>
    fsp.writeFile(gitHistoryDiskPath(root, histSig), JSON.stringify(payload))).catch(() => {});
}

async function loadGitRepository(root) {
  const [refsText, statusText, histSig] = await Promise.all([
    gitText(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads', 'refs/remotes']).catch(() => ''),
    gitText(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''),
    gitHistorySignature(root),
  ]);
  const workingTree = parseGitStatus(statusText);
  const cached = gitHistoryCache.get(root);
  if (cached && cached.histSig === histSig) {
    cached.value.workingTree = workingTree;
    return cached.value;
  }
  const disk = await readGitHistoryDisk(root, histSig);
  if (disk) {
    disk.workingTree = workingTree;
    gitHistoryCache.set(root, { histSig, value: disk });
    return disk;
  }
  const logText = await gitText(root, [
    'log', '--all', '--max-count=2000', '--date=iso-strict', '--find-renames', '--diff-merges=first-parent',
    '--format=%x1e%H%x1f%h%x1f%P%x1f%cI%x1f%aN%x1f%aE%x1f%s%x1f%D', '--numstat',
  ]).catch(() => '');
  const commits = parseGitLog(logText, root);
  const refs = refsText.split('\n').filter(Boolean).map(line => {
    const [name, hash] = line.split('\t'); return { name, hash };
  }).filter(ref => ref.name && ref.hash);
  let currentBranch = null, head = null;
  try { currentBranch = (await gitText(root, ['branch', '--show-current'])).trim() || null; } catch {}
  try { head = (await gitText(root, ['rev-parse', 'HEAD'])).trim() || null; } catch {}
  const value = {
    id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 12), root,
    currentBranch, head, refs, commits, workingTree, truncated: commits.length >= 2000,
  };
  gitHistoryCache.set(root, { histSig, value });
  writeGitHistoryDisk(root, histSig, value);
  return value;
}

const GIT_SCAN_SKIP = new Set([
  'node_modules', 'target', 'dist', 'build', '.cache', '.local', '.nvm', '.npm', '.cargo',
  '.rustup', '.mozilla', '.config', '.var', 'Trash', '.Trash', 'snap', '.steam', 'proc',
]);
let gitRepoIndexCache = { at: 0, repos: [] };

async function walkGitRoots(dir, depth, maxDepth, out) {
  if (depth > maxDepth || out.size >= 400) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (ents.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
    out.add(path.resolve(dir));
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (GIT_SCAN_SKIP.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.pi' && e.name !== '.claude') continue;
    await walkGitRoots(path.join(dir, e.name), depth + 1, maxDepth, out);
  }
}

async function worktreeRoots(root) {
  const dir = await resolveGitDir(root);
  const stamp = (await stampPath(path.join(dir, 'worktrees'))) + '|' + (await stampPath(path.join(dir, 'HEAD')));
  const hit = worktreeCache.get(root);
  if (hit && hit.stamp === stamp) return hit.roots;
  const text = await gitText(root, ['worktree', 'list', '--porcelain']).catch(() => '');
  const roots = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) roots.push(path.resolve(line.slice(9).trim()));
  }
  const value = roots.length ? roots : [path.resolve(root)];
  worktreeCache.set(root, { stamp, roots: value });
  return value;
}

const CWD_GIT_ROOT_TTL_MS = 5 * 60 * 1000;

async function gitRootForCwd(cwd) {
  const cached = cwdGitRootCache.get(cwd);
  if (cached && Date.now() - cached.at < CWD_GIT_ROOT_TTL_MS) return cached.root;
  try {
    const root = (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const resolved = root ? path.resolve(root) : '';
    cwdGitRootCache.set(cwd, { at: Date.now(), root: resolved });
    return resolved;
  } catch {
    cwdGitRootCache.set(cwd, { at: Date.now(), root: '' });
    return '';
  }
}

async function scanGitRoots() {
  const found = new Set();
  const home = os.homedir();
  for (const start of [path.join(home, 'Projects'), path.join(home, 'src'), path.join(home, 'code'), home]) {
    if (fs.existsSync(start)) await walkGitRoots(start, 0, start === home ? 3 : 5, found);
  }
  const cwds = [...new Set(Object.values(index).map(entry => entry && entry.cwd).filter(Boolean))];
  await mapLimit(cwds, 8, async cwd => {
    const root = await gitRootForCwd(cwd);
    if (root) found.add(root);
  });
  return found;
}

async function refreshGitRepoCard(root, prev) {
  let head = '';
  try { head = (await gitText(root, ['rev-parse', 'HEAD'])).trim(); } catch { return null; }
  if (!head) return null;
  let branch = null;
  try { branch = (await gitText(root, ['branch', '--show-current'])).trim() || null; } catch {}
  if (prev && prev.head === head && prev.branch === branch && prev.lastTs) {
    // project recomputes every pass: a fold can re-attribute a cached card.
    return { ...prev, head, branch, project: projectNameForPath(root), hasMemory: !!projectMetaFor(projectNameForPath(root)) };
  }
  let lastTs = null, subject = '';
  try {
    const line = (await gitText(root, ['log', '-1', '--format=%cI%x1f%s'])).trim();
    const at = line.indexOf('\x1f');
    lastTs = at >= 0 ? line.slice(0, at) : line;
    subject = at >= 0 ? line.slice(at + 1) : '';
  } catch {}
  return {
    id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 12),
    root, name: path.basename(root), project: projectNameForPath(root), branch, head,
    lastTs, subject, hasMemory: !!projectMetaFor(projectNameForPath(root)),
  };
}

function projectNameForPath(dir) {
  return projectOfEntry({ cwd: dir });
}

async function discoverGitRepos(force = false) {
  if (!force && Date.now() - gitRepoIndexCache.at < 45000 && gitRepoIndexCache.repos.length) return gitRepoIndexCache.repos;
  let disk = null;
  try { disk = JSON.parse(await fsp.readFile(GIT_REPOS_FILE, 'utf8')); } catch {}
  const now = Date.now();
  let roots;
  if (!force && disk && Array.isArray(disk.roots) && disk.roots.length && now - (disk.scannedAt || 0) < 10 * 60 * 1000) {
    roots = new Set(disk.roots);
  } else {
    roots = await scanGitRoots();
    disk = { ...(disk || {}), scannedAt: now, roots: [...roots] };
  }
  const expanded = new Set();
  await mapLimit([...roots], 8, async root => {
    for (const wt of await worktreeRoots(root)) expanded.add(wt);
  });
  const prevByRoot = new Map((disk.repos || gitRepoIndexCache.repos || []).map(repo => [repo.root, repo]));
  const repos = (await mapLimit([...expanded], 8, root => refreshGitRepoCard(root, prevByRoot.get(root)))).filter(Boolean);
  repos.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')) || a.root.localeCompare(b.root));
  gitRepoIndexCache = { at: now, repos };
  fsp.writeFile(GIT_REPOS_FILE, JSON.stringify({ scannedAt: disk.scannedAt, roots: disk.roots || [...roots], repos })).catch(() => {});
  return repos;
}

function gitRowsFromRepo(repo) {
  const rows = new Map();
  const rowFor = relativePath => {
    const id = `${repo.id}:${relativePath}`;
    let row = rows.get(id);
    if (!row) {
      row = {
        id, repoId: repo.id, repoRoot: repo.root, relativePath,
        path: path.join(repo.root, relativePath), aiEvents: [], commitEvents: [], workingTree: null, latestTs: null,
      };
      rows.set(id, row);
    }
    return row;
  };
  for (const commit of repo.commits) {
    for (const file of commit.files) {
      const row = rowFor(file.path);
      row.commitEvents.push({
        id: `git:${repo.id}:${commit.hash}:${file.path}`, hash: commit.hash, shortHash: commit.shortHash,
        ts: commit.ts, subject: commit.subject, author: commit.author, parents: commit.parents,
        branches: commit.branches, additions: file.additions, deletions: file.deletions,
      });
      if (!row.latestTs || String(commit.ts || '') > String(row.latestTs)) row.latestTs = commit.ts;
    }
  }
  for (const working of repo.workingTree) rowFor(working.path).workingTree = working.status;
  return [...rows.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
}

async function gitFileHistoryResponse(rootValue) {
  const listed = await discoverGitRepos();
  const wanted = path.resolve(rootValue || '');
  const match = listed.find(item => item.root === wanted);
  if (!match) throw new Error('repository not found');
  const repo = await loadGitRepository(match.root);
  const rowsMap = new Map(gitRowsFromRepo(repo).map(row => [row.relativePath, row]));
  for (const relativePath of await gitTrackedPaths(match.root)) {
    if (rowsMap.has(relativePath)) continue;
    rowsMap.set(relativePath, {
      id: `${repo.id}:${relativePath}`, repoId: repo.id, repoRoot: repo.root, relativePath,
      path: path.join(repo.root, relativePath), aiEvents: [], commitEvents: [], workingTree: null, latestTs: null,
    });
  }
  const rows = [...rowsMap.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
  return {
    scope: 'git', project: match.project, cwd: match.root,
    repositories: [{
      id: repo.id, root: repo.root, currentBranch: repo.currentBranch, head: repo.head,
      refs: repo.refs.map(ref => ref.name), commitCount: repo.commits.length,
      workingTreeFiles: repo.workingTree.length, truncated: repo.truncated, isGit: true,
    }],
    rows,
    totals: {
      files: rows.length, aiEvents: 0, failed: 0, paired: 0,
      commits: repo.commits.length,
      commitFileEvents: rows.reduce((n, row) => n + row.commitEvents.length, 0),
      workingTreeFiles: repo.workingTree.length,
    },
  };
}

async function gitTrackedPaths(root) {
  let head = '';
  try { head = (await gitText(root, ['rev-parse', 'HEAD'])).trim(); } catch {}
  const key = root + '\0' + head;
  if (gitTrackedCache.has(key)) return gitTrackedCache.get(key);
  const text = await gitText(root, ['ls-tree', '-r', '--name-only', 'HEAD']).catch(() => '');
  const paths = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  gitTrackedCache.set(key, paths);
  if (gitTrackedCache.size > 80) gitTrackedCache.delete(gitTrackedCache.keys().next().value);
  return paths;
}

async function gitFileContext(rootValue, fileValue) {
  const listed = await discoverGitRepos();
  const root = path.resolve(rootValue || '');
  if (!listed.some(item => item.root === root)) throw new Error('repository is not indexed');
  const { fullPath, relativePath } = normalizedRepoFile(root, fileValue);
  const repo = await loadGitRepository(root);
  const commits = repo.commits.filter(commit => commit.files.some(file => file.path === relativePath))
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.hash.localeCompare(b.hash));
  let current = null;
  try { current = await fsp.readFile(fullPath, 'utf8'); } catch {}
  const version = diffEventHash([repo.head || '', commits.map(c => c.hash), current === null ? '' : current.length]);
  return {
    project: projectNameForPath(root), root, relativePath, fullPath, repo,
    events: [], commits, current, version,
  };
}

async function gitIntervalNumstat(root, fromId, toId) {
  const fromHash = String(fromId || '').startsWith('git:') ? String(fromId).slice(4) : '';
  const toHash = String(toId || '').startsWith('git:') ? String(toId).slice(4) : '';
  if (!fromHash && !toHash) return [];
  const args = ['diff', '--numstat', '--find-renames'];
  if (fromHash && toHash) args.push(fromHash, toHash);
  else if (fromHash) args.push(fromHash);
  else return [];
  const text = await gitText(root, args).catch(() => '');
  const files = [];
  for (const line of String(text).split('\n')) {
    const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!match) continue;
    files.push({
      path: renamedNumstatPath(match[3]),
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

async function gitFileCompareResponse(root, file, fromId = '', toId = '', fromAt = '', toAt = '', light = false) {
  const ctx = await gitFileContext(root, file);
  const points = fileHistoryPoints(ctx);
  if (!points.length) throw new Error('this file has no Git or working-tree points');
  let to = points.find(point => point.id === toId) || nearestFilePoint(points, toAt) || points[points.length - 1];
  const beforeTo = points.filter(point => point.order < to.order);
  const defaultFrom = [...beforeTo].reverse().find(point => point.kind === 'git') || beforeTo[beforeTo.length - 1] || to;
  let from = points.find(point => point.id === fromId) || nearestFilePoint(points, fromAt) || defaultFrom;
  if (from.order > to.order) [from, to] = [to, from];
  const [oldSnapshot, newSnapshot] = await Promise.all([snapshotAtFilePoint(ctx, from), snapshotAtFilePoint(ctx, to)]);
  const changes = [];
  if (!light) {
    for (const commit of ctx.commits) {
      const point = points.find(item => item.hash === commit.hash);
      if (!point || point.order <= from.order || point.order > to.order) continue;
      const patch = await commitPatch(ctx.root, commit.hash, ctx.relativePath);
      changes.push({
        type: 'git', id: commit.hash, hash: commit.hash, shortHash: commit.shortHash,
        ts: commit.ts, kind: 'commit', subject: commit.subject, ...patchChangeText(patch),
      });
    }
    changes.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')) || a.id.localeCompare(b.id));
  }
  return {
    scope: 'git', project: ctx.project, repoRoot: ctx.root, path: ctx.fullPath, relativePath: ctx.relativePath,
    points, from: from.id, to: to.id, old: oldSnapshot, new: newSnapshot, changes,
    truth: 'Git and current-file points are exact. This view has no AI reconstructions.',
  };
}

async function gitFileSnapshotsResponse(root, file) {
  const ctx = await gitFileContext(root, file);
  const points = fileHistoryPoints(ctx);
  const snapshots = await mapLimit(points, 6, async point => snapshotAtFilePoint(ctx, point));
  return {
    scope: 'git', project: ctx.project, repoRoot: ctx.root, path: ctx.fullPath, relativePath: ctx.relativePath,
    points, snapshots,
  };
}

async function gitCommitResponse(root, hash) {
  const listed = await discoverGitRepos();
  const resolved = path.resolve(root || '');
  if (!listed.some(item => item.root === resolved)) throw new Error('repository is not indexed');
  if (!/^[0-9a-f]{7,40}$/i.test(hash || '')) throw new Error('bad commit hash');
  const repo = await loadGitRepository(resolved);
  const commit = repo.commits.find(item => item.hash === hash || item.hash.startsWith(hash));
  if (!commit) throw new Error('commit not found in indexed history');
  const patch = await gitText(resolved, ['show', '--format=fuller', '--find-renames', '--stat', '--patch', commit.hash, '--']).catch(e => e.message);
  return { ...commit, repoId: repo.id, patch: clipped(patch, 2 * 1024 * 1024) };
}

async function sendGitFileFeedback(body) {
  const root = path.resolve(body.repo || body.repoRoot || '');
  const listed = await discoverGitRepos();
  const repo = listed.find(item => item.root === root);
  if (!repo) throw new Error('repository not found');
  const image = String(body.image || '');
  const match = image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('image must be a PNG data URL');
  const dir = path.join(CACHE_DIR, 'feedback');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = path.join(dir, stamp + '.png');
  const mdPath = path.join(dir, stamp + '.md');
  await fsp.writeFile(pngPath, Buffer.from(match[1], 'base64'));
  const rel = body.relativePath || body.path || 'file';
  const fromId = body.from || '';
  const toId = body.to || '';
  const md = [
    '# Inked Git file feedback',
    '',
    `- Repository: ${root}`,
    `- File: ${body.path || path.join(root, rel)}`,
    `- Relative path: ${rel}`,
    `- Old point: ${fromId || '?'}`,
    `- New point: ${toId || '?'}`,
    `- Lines: ${body.fromLine || '?'}–${body.toLine || '?'}`,
    `- Page: ${body.page || 1}/${body.pages || 1}`,
    `- Image: ${pngPath}`,
    '',
    'The red ink is the user\'s requested edit on this Git file compare.',
    'The file may never have been edited by an AI agent. Apply the marks.',
    '',
  ].join('\n');
  await fsp.writeFile(mdPath, md);
  const project = repo.project;
  const meta = projectMetaFor(project);
  const cwd = root;
  const kind = body.agent === 'claude' ? 'claude' : 'pi';
  let briefing = null;
  let prefix = '';
  if (meta) {
    briefing = await buildProjectBriefing(project, { map: true, notes: true, epics: [], evidenceKeys: [] }, 'Git ink');
    prefix = `Read ${briefing} — it maps this project's work memory with full file paths. Read every file listed under "Project memory" first. Then read every file listed under "Fresh distilled notes". `;
  }
  const prompt = prefix +
    `Read ${mdPath} and the PNG at ${pngPath}. The red ink is requested file feedback for ${rel} lines ${body.fromLine}–${body.toLine} (page ${body.page}/${body.pages}), comparing ${fromId || 'an older Git point'} to ${toId || 'a newer Git point'} in ${root}. Apply those edits.`;
  const name = 'aiconvo-git-' + crypto.createHash('sha256').update(root + stamp).digest('hex').slice(0, 12);
  const argv = kind === 'claude'
    ? [claudeBin(), prompt]
    : [piBin(), '--name', String(repo.name + ' git ink').slice(0, 80), '@' + pngPath, prompt];
  const startedAt = Date.now();
  const existing = new Set(Object.keys(index));
  await spawnAlacritty(cwd, name, argv);
  const key = await waitForNewConversation(kind, cwd, startedAt, existing).catch(() => null);
  if (key) recordLaunchedTitle(name, key);
  return { ok: true, launched: true, pngPath, mdPath, briefing, project, key, cwd, kind, name };
}

function repoForEvent(event, repositories) {
  const full = path.resolve(event.path);
  return repositories.find(repo => full === repo.root || full.startsWith(repo.root + path.sep)) || null;
}

function usefulLineSet(text) {
  return new Set(String(text || '').split('\n').map(line => line.trim())
    .filter(line => line.length >= 4 && /[a-zA-Z0-9]/.test(line)));
}

function setCoverage(wanted, actual) {
  if (!wanted.size) return null;
  let hit = 0;
  for (const line of wanted) if (actual.has(line)) hit++;
  return hit / wanted.size;
}

function patchLineSets(patch) {
  const added = new Set(), removed = new Set();
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const text = line.slice(1).trim();
    if (text.length < 4 || !/[a-zA-Z0-9]/.test(text)) continue;
    if (line.startsWith('+')) added.add(text);
    else if (line.startsWith('-')) removed.add(text);
  }
  return { added, removed };
}

async function cachedGitObject(root, cacheKey, args, fallback = '') {
  const key = `${root}\x00${cacheKey}`;
  if (gitPatchCache.has(key)) return gitPatchCache.get(key);
  const pending = gitText(root, args).catch(() => fallback);
  gitPatchCache.set(key, pending);
  const value = await pending;
  gitPatchCache.set(key, value);
  if (gitPatchCache.size > 3000) gitPatchCache.delete(gitPatchCache.keys().next().value);
  return value;
}

async function commitPatch(root, hash, file) {
  return cachedGitObject(root, `patch\x00${hash}\x00${file}`, ['show', '--format=', '--find-renames', '--unified=0', hash, '--', file]);
}

async function commitBlob(root, hash, file) {
  return cachedGitObject(root, `blob\x00${hash}\x00${file}`, ['show', `${hash}:${file}`], null);
}

function branchMatches(eventBranch, branches) {
  if (!eventBranch) return false;
  return (branches || []).some(branch => branch === eventBranch || branch.endsWith('/' + eventBranch));
}

// Pairing an AI edit to a commit runs git patch inspection per candidate.
// The inputs only change when the repo history moves (head) or the event's
// outcome resolves — memoize on exactly that. In-memory, bounded, safe.
const pairMemo = new Map();
async function pairEventToCommitMemo(event, repo, commitsForFile) {
  const headHash = repo.head && (repo.head.hash || repo.head) || 'nohead';
  const memoKey = event.id + '\x00' + repo.id + '\x00' + headHash + '\x00' + (event.outcome || '');
  if (pairMemo.has(memoKey)) return pairMemo.get(memoKey);
  const value = await pairEventToCommit(event, repo, commitsForFile);
  if (pairMemo.size > 30000) pairMemo.clear();
  pairMemo.set(memoKey, value);
  return value;
}

async function pairEventToCommit(event, repo, commitsForFile) {
  if (event.outcome === 'failed') return null;
  const eventMs = Date.parse(event.ts || '');
  if (!Number.isFinite(eventMs)) return null;
  const windowed = commitsForFile.filter(commit => {
    const delta = Date.parse(commit.ts) - eventMs;
    return delta >= -10 * 60 * 1000 && delta <= 14 * 86400000;
  }).sort((a, b) => {
    const ab = branchMatches(event.branch, a.branches) ? 1 : 0;
    const bb = branchMatches(event.branch, b.branches) ? 1 : 0;
    if (ab !== bb) return bb - ab;
    return Math.abs(Date.parse(a.ts) - eventMs) - Math.abs(Date.parse(b.ts) - eventMs);
  }).slice(0, 6);
  let best = null;
  const wantedNew = usefulLineSet(event.newText);
  const wantedOld = usefulLineSet(event.oldText);
  for (const commit of windowed) {
    const patch = await commitPatch(repo.root, commit.hash, event.repoRelativePath);
    const lines = patchLineSets(patch);
    const newCoverage = setCoverage(wantedNew, lines.added);
    const oldCoverage = setCoverage(wantedOld, lines.removed);
    const coverages = [newCoverage, oldCoverage].filter(value => value !== null);
    let contentScore = coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0;
    let exactBlob = false;
    if (event.kind === 'write' && event.newText && windowed.indexOf(commit) < 3) {
      const blob = await commitBlob(repo.root, commit.hash, event.repoRelativePath);
      if (blob !== null && String(blob).replace(/\n$/, '') === String(event.newText).replace(/\n$/, '')) {
        exactBlob = true; contentScore = 1;
      }
    }
    const deltaMs = Date.parse(commit.ts) - eventMs;
    const timeScore = Math.max(0, 1 - Math.max(0, deltaMs) / (14 * 86400000));
    const branchScore = branchMatches(event.branch, commit.branches) ? 1 : 0;
    const score = contentScore * 0.78 + timeScore * 0.14 + branchScore * 0.08;
    if (!best || score > best.score) best = { commit, score, contentScore, exactBlob, deltaMs, branchScore };
  }
  if (!best) return null;
  let confidence = null, basis = 'content';
  if (best.exactBlob || best.contentScore >= 0.75) confidence = 'high';
  else if (best.contentScore >= 0.35) confidence = 'medium';
  else if (best.contentScore >= 0.12) confidence = 'low';
  else if (best.branchScore && best.deltaMs >= 0 && best.deltaMs <= 48 * 3600000) { confidence = 'low'; basis = 'time-and-branch-only'; }
  if (!confidence) return null;
  return {
    hash: best.commit.hash, shortHash: best.commit.shortHash, subject: best.commit.subject,
    ts: best.commit.ts, branches: best.commit.branches, confidence, basis,
    score: Number(best.score.toFixed(3)), contentScore: Number(best.contentScore.toFixed(3)),
    deltaMs: best.deltaMs,
  };
}

// Full project file tree for the project tree mode: every repository under
// the project with tracked / modified / untracked / ignored paths, branches,
// and worktrees. Lists are capped so the endpoint stays cheap.
async function projectTreeResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  const repos = [];
  for (const root of roots) {
    let branch = null;
    try { branch = (await gitText(root, ['branch', '--show-current'])).trim() || null; } catch {}
    let refs = [];
    try {
      refs = String(await gitText(root, ['branch', '--format=%(refname:short)']))
        .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 40);
    } catch {}
    const tracked = (await gitTrackedPaths(root).catch(() => [])).slice(0, 8000);
    const untracked = String(await gitText(root, ['ls-files', '--others', '--exclude-standard']).catch(() => ''))
      .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2000);
    const ignored = String(await gitText(root, ['ls-files', '--others', '-i', '--directory', '--exclude-standard']).catch(() => ''))
      .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 800);
    const modified = String(await gitText(root, ['status', '--porcelain']).catch(() => ''))
      .split('\n').filter(Boolean)
      .map(line => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim().replace(/^"|"$/g, '') }))
      .filter(item => item.path).slice(0, 2000);
    let worktrees = [];
    try { worktrees = (await worktreeRoots(root)).filter(wt => wt !== root); } catch {}
    repos.push({ root, name: path.basename(root), branch, refs, worktrees, tracked, untracked, ignored, modified });
  }
  return { project, cwd: meta.cwd, repos };
}

// Background diff-cache warmer. Gentle concurrency, one warm per project at
// a time; conversationDiffs itself is mtime-cached, so repeats are cheap.
const warmingProjects = new Set();
function warmProjectDiffs(project) {
  if (warmingProjects.has(project)) return;
  const meta = projectMetaFor(project);
  if (!meta || !meta.entries || meta.entries.length < 2) return;
  warmingProjects.add(project);
  setTimeout(async () => {
    try { await mapLimit([...meta.entries], 2, ({ key }) => conversationDiffs(key).catch(() => {})); }
    catch {} finally { warmingProjects.delete(project); }
  }, 100);
}

// Recent file activity is a small durable index. Git seeds committed work,
// the working tree seeds edits made before a watcher starts, and fs.watch
// records later saves. The code view can therefore open recent folders
// without scanning file contents on every request.
const PROJECT_FILE_ACTIVITY_FILE = path.join(CACHE_DIR, 'project-file-activity.json');
const PROJECT_FILE_DAY = 24 * 60 * 60 * 1000;
let projectFileActivity = {};
try { projectFileActivity = JSON.parse(fs.readFileSync(PROJECT_FILE_ACTIVITY_FILE, 'utf8')); } catch {}
if (!projectFileActivity || typeof projectFileActivity !== 'object' || Array.isArray(projectFileActivity)) projectFileActivity = {};
let projectFileActivitySaveTimer = null;
const projectFileSnapshots = new Map();
const projectFileWatchers = new Map();
const projectFileWatchPending = new Map();

function saveProjectFileActivitySoon() {
  clearTimeout(projectFileActivitySaveTimer);
  projectFileActivitySaveTimer = setTimeout(() => writeFileAtomic(PROJECT_FILE_ACTIVITY_FILE, JSON.stringify(projectFileActivity)).catch(() => {}), 500);
}

function recordProjectFileActivity(file, event) {
  const key = path.resolve(file);
  const cutoff = Date.now() - PROJECT_FILE_DAY;
  const current = projectFileActivity[key] && Array.isArray(projectFileActivity[key].events) ? projectFileActivity[key].events : [];
  const events = current.filter(item => Number(item.ts) >= cutoff && item.id !== event.id);
  events.push({ id: event.id, ts: Number(event.ts) || Date.now(), added: Number(event.added) || 0, removed: Number(event.removed) || 0, source: event.source || 'watch' });
  projectFileActivity[key] = { events };
  saveProjectFileActivitySoon();
}

function recentProjectFileActivity(file) {
  const key = path.resolve(file);
  const cutoff = Date.now() - PROJECT_FILE_DAY;
  const entry = projectFileActivity[key];
  if (!entry || !Array.isArray(entry.events)) return null;
  entry.events = entry.events.filter(item => Number(item.ts) >= cutoff);
  if (!entry.events.length) { delete projectFileActivity[key]; return null; }
  return {
    events: entry.events.length,
    added: entry.events.reduce((sum, item) => sum + (Number(item.added) || 0), 0),
    removed: entry.events.reduce((sum, item) => sum + (Number(item.removed) || 0), 0),
    latestTs: Math.max(...entry.events.map(item => Number(item.ts) || 0)),
  };
}

function watchedLineDelta(oldText, newText) {
  const before = String(oldText || '').split('\n');
  const after = String(newText || '').split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length - 1, newEnd = after.length - 1;
  while (oldEnd >= start && newEnd >= start && before[oldEnd] === after[newEnd]) { oldEnd--; newEnd--; }
  return { removed: Math.max(0, oldEnd - start + 1), added: Math.max(0, newEnd - start + 1) };
}

async function readProjectFileSnapshot(file) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const text = await fsp.readFile(file, 'utf8');
    if (text.includes('\0')) return null;
    return { text, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; }
}

async function updateWatchedProjectFile(root, relativePath) {
  const file = path.resolve(root, relativePath);
  if (file !== root && !file.startsWith(root + path.sep)) return;
  const old = projectFileSnapshots.get(file) || null;
  const next = await readProjectFileSnapshot(file);
  if (!old && !next) return;
  let delta;
  if (!old) delta = { added: String(next.text || '').split('\n').length, removed: 0 };
  else if (!next) delta = { added: 0, removed: String(old.text || '').split('\n').length };
  else if (old.text === next.text) return;
  else delta = watchedLineDelta(old.text, next.text);
  if (next) projectFileSnapshots.set(file, next); else projectFileSnapshots.delete(file);
  recordProjectFileActivity(file, { id: `watch:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`, ts: Date.now(), ...delta, source: 'watch' });
}

async function ensureProjectFileWatch(roots, rows) {
  await mapLimit(rows, 24, async row => {
    if (projectFileSnapshots.has(row.path)) return;
    const snap = await readProjectFileSnapshot(row.path);
    if (snap) projectFileSnapshots.set(row.path, snap);
  });
  for (const root of roots) {
    if (projectFileWatchers.has(root) || !fs.existsSync(root)) continue;
    try {
      const watcher = fs.watch(root, { recursive: true }, (event, filename) => {
        const rel = String(filename || '').replace(/\\/g, '/');
        if (!rel || rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) return;
        const key = root + '\0' + rel;
        clearTimeout(projectFileWatchPending.get(key));
        projectFileWatchPending.set(key, setTimeout(() => {
          projectFileWatchPending.delete(key);
          updateWatchedProjectFile(root, rel).catch(() => {});
        }, 220));
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} projectFileWatchers.delete(root); });
      projectFileWatchers.set(root, watcher);
    } catch (error) { console.error('project file watch failed:', root, error.message); }
  }
}

async function seedProjectFileActivity(repositories, rows) {
  const cutoff = Date.now() - PROJECT_FILE_DAY;
  for (const row of rows) {
    const recentCommits = (row.commitEvents || []).filter(event => (Date.parse(event.ts || '') || 0) >= cutoff);
    const latestCommit = recentCommits.reduce((max, event) => Math.max(max, Date.parse(event.ts || '') || 0), 0);
    if (latestCommit && projectFileActivity[row.path] && Array.isArray(projectFileActivity[row.path].events)) {
      projectFileActivity[row.path].events = projectFileActivity[row.path].events.filter(event => event.source === 'git' || Number(event.ts) > latestCommit);
    }
    for (const event of recentCommits) recordProjectFileActivity(row.path, {
      id: `git:${event.hash}:${row.relativePath}`, ts: Date.parse(event.ts), added: event.additions, removed: event.deletions, source: 'git',
    });
  }
  for (const repo of repositories) {
    const numstat = String(await gitText(repo.root, ['diff', 'HEAD', '--numstat', '--']).catch(() => ''));
    for (const line of numstat.split('\n')) {
      const [addedRaw, removedRaw, ...nameParts] = line.split('\t');
      const rel = nameParts.join('\t');
      if (!rel) continue;
      const row = rows.find(item => item.repoRoot === repo.root && item.relativePath === rel);
      if (!row) continue;
      let stat; try { stat = await fsp.stat(row.path); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      if (projectFileActivity[row.path] && Array.isArray(projectFileActivity[row.path].events))
        projectFileActivity[row.path].events = projectFileActivity[row.path].events.filter(event => event.source === 'git');
      recordProjectFileActivity(row.path, {
        id: `working:${repo.id}:${rel}:${Math.round(stat.mtimeMs)}`, ts: stat.mtimeMs,
        added: Number(addedRaw) || 0, removed: Number(removedRaw) || 0, source: 'working',
      });
    }
    for (const item of repo.workingTree.filter(item => item.status === '??')) {
      const row = rows.find(candidate => candidate.repoRoot === repo.root && candidate.relativePath === item.path);
      if (!row) continue;
      const snap = await readProjectFileSnapshot(row.path);
      if (!snap || snap.mtimeMs < cutoff) continue;
      if (projectFileActivity[row.path] && Array.isArray(projectFileActivity[row.path].events))
        projectFileActivity[row.path].events = projectFileActivity[row.path].events.filter(event => event.source === 'git');
      recordProjectFileActivity(row.path, {
        id: `new:${repo.id}:${item.path}:${Math.round(snap.mtimeMs)}`, ts: snap.mtimeMs,
        added: String(snap.text || '').split('\n').length, removed: 0, source: 'working',
      });
    }
  }
}

async function projectFileHistoryResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  const repositories = await mapLimit(roots, 3, loadGitRepository);
  if (!repositories.length && meta.cwd && fs.existsSync(meta.cwd)) {
    const root = path.resolve(meta.cwd);
    repositories.push({
      id: crypto.createHash('sha256').update('workspace:' + root).digest('hex').slice(0, 12),
      root, currentBranch: null, head: null, refs: [], commits: [], workingTree: [], truncated: false, isGit: false,
    });
  }
  const allEvents = [];
  const conversations = [...meta.entries].sort((a, b) => String(a.entry.firstTs || '').localeCompare(String(b.entry.firstTs || '')));
  // Parallel parse: the cold path reads every session file once (the diff
  // cache then holds). Order stays deterministic — results land by index.
  const perConv = await mapLimit(conversations, 6, async ({ key }) => {
    try { return await conversationDiffs(key); } catch { return []; }
  });
  for (const events of perConv) allEvents.push(...events);
  const fullEvents = new Map();
  for (const event of allEvents) {
    fullEvents.set(event.id, event);
    const repo = repoForEvent(event, repositories);
    if (!repo) continue;
    event.repoRoot = repo.root;
    event.repoId = repo.id;
    event.repoRelativePath = path.relative(repo.root, event.path).replace(/\\/g, '/');
  }
  const commitFilesByRepo = new Map();
  for (const repo of repositories) {
    const byFile = new Map();
    for (const commit of repo.commits) {
      for (const file of commit.files) {
        if (!byFile.has(file.path)) byFile.set(file.path, []);
        byFile.get(file.path).push(commit);
      }
    }
    commitFilesByRepo.set(repo.id, byFile);
  }
  await mapLimit(allEvents.filter(event => event.repoId), 4, async event => {
    const repo = repositories.find(item => item.id === event.repoId);
    const commits = commitFilesByRepo.get(repo.id).get(event.repoRelativePath) || [];
    event.commitPair = await pairEventToCommitMemo(event, repo, commits);
    const working = new Set(repo.workingTree.map(item => item.path));
    event.repositoryState = event.outcome === 'failed' ? 'failed' : event.commitPair ? 'committed' : working.has(event.repoRelativePath) ? 'working-tree' : 'unresolved';
    event.inferredBranch = event.branch === 'HEAD'
      ? event.commitPair && event.commitPair.branches && event.commitPair.branches[0] || (event.repositoryState === 'working-tree' ? repo.currentBranch : null)
      : null;
  });
  const rows = new Map();
  const rowFor = (repo, relativePath) => {
    const id = `${repo.id}:${relativePath}`;
    let row = rows.get(id);
    if (!row) {
      row = { id, repoId: repo.id, repoRoot: repo.root, relativePath, path: path.join(repo.root, relativePath), aiEvents: [], commitEvents: [], workingTree: null, latestTs: null };
      rows.set(id, row);
    }
    return row;
  };
  for (const event of allEvents) {
    if (!event.repoId) continue;
    const repo = repositories.find(item => item.id === event.repoId);
    const row = rowFor(repo, event.repoRelativePath);
    row.aiEvents.push({
      id: event.id, key: event.key, ts: event.ts, kind: event.kind, stats: event.stats,
      conversationTitle: event.conversationTitle, agent: event.agent, branch: event.branch,
      inferredBranch: event.inferredBranch || null,
      outcome: event.outcome, repositoryState: event.repositoryState, commitPair: event.commitPair,
      command: event.command || null,
    });
    if (!row.latestTs || String(event.ts || '') > String(row.latestTs)) row.latestTs = event.ts;
  }
  let totalCommitFileEvents = 0;
  for (const repo of repositories) {
    // Include every current tracked and untracked workspace file, even when
    // it has no commit or AI event yet. The code tree is a file browser.
    if (repo.isGit === false) {
      let count = 0;
      for await (const relativePath of walk(repo.root, repo.root)) {
        rowFor(repo, relativePath).current = true;
        if (++count >= 12000) break;
      }
    } else {
      for (const relativePath of await gitTrackedPaths(repo.root).catch(() => [])) rowFor(repo, relativePath).current = true;
      for (const working of repo.workingTree) rowFor(repo, working.path).current = true;
    }
    for (const commit of repo.commits) {
      for (const file of commit.files) {
        const row = rowFor(repo, file.path);
        row.commitEvents.push({
          id: `git:${repo.id}:${commit.hash}:${file.path}`, hash: commit.hash, shortHash: commit.shortHash,
          ts: commit.ts, subject: commit.subject, author: commit.author, parents: commit.parents,
          branches: commit.branches, additions: file.additions, deletions: file.deletions,
        });
        totalCommitFileEvents++;
        if (!row.latestTs || String(commit.ts || '') > String(row.latestTs)) row.latestTs = commit.ts;
      }
    }
    for (const working of repo.workingTree) rowFor(repo, working.path).workingTree = working.status;
  }
  const projectDiffEvents = projectDiffEventsFor(project);
  projectDiffEvents.set(Date.now(), { at: Date.now(), events: [...fullEvents.values()] });
  const outputRows = [...rows.values()].filter(row => row.current || fs.existsSync(row.path))
    .sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
  await seedProjectFileActivity(repositories, outputRows);
  for (const row of outputRows) row.recent24 = recentProjectFileActivity(row.path);
  outputRows.sort((a, b) => Number((b.recent24 && b.recent24.latestTs) || 0) - Number((a.recent24 && a.recent24.latestTs) || 0) || a.relativePath.localeCompare(b.relativePath));
  ensureProjectFileWatch(repositories.map(repo => repo.root), outputRows).catch(() => {});
  const repositoryEvents = allEvents.filter(event => event.repoId);
  const paired = repositoryEvents.filter(event => event.commitPair).length;
  return {
    project, cwd: meta.cwd,
    repositories: repositories.map(repo => ({
      id: repo.id, root: repo.root, currentBranch: repo.currentBranch, head: repo.head,
      refs: repo.refs.map(ref => ref.name), commitCount: repo.commits.length,
      workingTreeFiles: repo.workingTree.length, truncated: repo.truncated, isGit: repo.isGit !== false,
    })),
    conversations: conversations.length, rows: outputRows, totals: {
      files: outputRows.length, aiEvents: repositoryEvents.length, externalAiEvents: allEvents.length - repositoryEvents.length,
      applied: repositoryEvents.filter(event => event.outcome === 'applied').length,
      failed: repositoryEvents.filter(event => event.outcome === 'failed').length, paired,
      commits: repositories.reduce((sum, repo) => sum + repo.commits.length, 0), commitFileEvents: totalCommitFileEvents,
      workingTreeFiles: repositories.reduce((sum, repo) => sum + repo.workingTree.length, 0),
    },
  };
}

async function projectCommitResponse(project, root, hash) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  const resolved = path.resolve(root || '');
  if (!roots.includes(resolved)) throw new Error('repository is not part of this project');
  if (!/^[0-9a-f]{7,40}$/i.test(hash || '')) throw new Error('bad commit hash');
  const repo = await loadGitRepository(resolved);
  const commit = repo.commits.find(item => item.hash === hash || item.hash.startsWith(hash));
  if (!commit) throw new Error('commit not found in indexed history');
  const patch = await gitText(resolved, ['show', '--format=fuller', '--find-renames', '--stat', '--patch', commit.hash, '--']).catch(e => e.message);
  return { ...commit, repoId: repo.id, patch: clipped(patch, 2 * 1024 * 1024) };
}

const projectFileContextCache = new Map();
const projectFileSnapshotCache = new Map();

function normalizedRepoFile(root, file) {
  const resolved = path.resolve(root, String(file || ''));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('file is outside the repository');
  return { fullPath: resolved, relativePath: path.relative(root, resolved).replace(/\\/g, '/') };
}

async function projectFileContext(project, rootValue, fileValue) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const gitRoots = await projectGitRepositories(meta);
  const fallbackRoot = !gitRoots.length && meta.cwd ? path.resolve(meta.cwd) : null;
  const root = path.resolve(rootValue || '');
  if (!gitRoots.includes(root) && root !== fallbackRoot) throw new Error('repository is not part of this project');
  const { fullPath, relativePath } = normalizedRepoFile(root, fileValue);
  const cacheKey = `${project}\x00${root}\x00${relativePath}`;
  const cached = projectFileContextCache.get(cacheKey);
  let diskMtime = 0;
  try { diskMtime = (await fsp.stat(fullPath)).mtimeMs; } catch {}
  if (cached && Date.now() - cached.at < 15000 && cached.diskMtime === diskMtime) return cached.context;
  const repo = gitRoots.includes(root) ? await loadGitRepository(root) : {
    id: crypto.createHash('sha256').update('workspace:' + root).digest('hex').slice(0, 12),
    root, commits: [], workingTree: [], isGit: false,
  };
  const events = [];
  const conversations = [...meta.entries].sort((a, b) => String(a.entry.firstTs || '').localeCompare(String(b.entry.firstTs || '')));
  for (const { key } of conversations) {
    try {
      for (const event of await conversationDiffs(key)) {
        if (path.resolve(event.path) !== fullPath) continue;
        events.push(event);
      }
    } catch {}
  }
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.editIndex - b.editIndex || a.id.localeCompare(b.id));
  const commits = repo.commits.filter(commit => commit.files.some(file => file.path === relativePath))
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.hash.localeCompare(b.hash));
  let current = null;
  try { current = await fsp.readFile(fullPath, 'utf8'); } catch {}
  const version = diffEventHash([diskMtime, repo.head || '', events.map(event => `${event.id}:${event.outcome}`), commits.map(commit => commit.hash)]);
  const context = { project, root, relativePath, fullPath, repo, events, commits, current, version };
  projectFileContextCache.set(cacheKey, { at: Date.now(), diskMtime, context });
  if (projectFileContextCache.size > 200) projectFileContextCache.delete(projectFileContextCache.keys().next().value);
  return context;
}

function applyEventText(text, event, reverse = false) {
  if (event.outcome === 'failed' || event.kind === 'shell') return { text, applied: false };
  if (event.kind === 'write') {
    if (reverse) return { text, applied: false };
    return { text: String(event.newText || ''), applied: true };
  }
  const from = String((reverse ? event.newText : event.oldText) || '');
  const to = String((reverse ? event.oldText : event.newText) || '');
  if (!from) return { text, applied: false };
  const at = text.indexOf(from);
  if (at < 0) return { text, applied: false };
  return { text: text.slice(0, at) + to + text.slice(at + from.length), applied: true };
}

function fileHistoryPoints(ctx) {
  const points = [];
  for (const event of ctx.events) {
    const ms = Date.parse(event.ts || '');
    if (!Number.isFinite(ms)) continue;
    points.push({
      id: `ai:${event.id}`, kind: 'ai', ts: event.ts, ms, eventId: event.id,
      label: `${event.kind} · ${event.conversationTitle} · ${new Date(ms).toLocaleString()}`,
      key: event.key, outcome: event.outcome,
    });
  }
  for (const commit of ctx.commits) {
    const ms = Date.parse(commit.ts || '');
    if (!Number.isFinite(ms)) continue;
    points.push({
      id: `git:${commit.hash}`, kind: 'git', ts: commit.ts, ms, hash: commit.hash,
      label: `${commit.shortHash} · ${commit.subject} · ${new Date(ms).toLocaleString()}`,
    });
  }
  points.sort((a, b) => a.ms - b.ms || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'ai' ? -1 : 1));
  points.forEach((point, order) => { point.order = order; });
  if (ctx.current !== null) points.push({
    id: 'current', kind: 'current', ts: new Date().toISOString(), ms: Date.now(), order: points.length,
    label: 'current working file',
  });
  return points;
}

async function snapshotAtFilePoint(ctx, point) {
  const cacheKey = `${ctx.root}\x00${ctx.relativePath}\x00${ctx.version}\x00${point.id}`;
  if (projectFileSnapshotCache.has(cacheKey)) return projectFileSnapshotCache.get(cacheKey);
  let snapshot;
  if (point.kind === 'current') snapshot = { point, content: ctx.current || '', exact: true, method: 'current file', applied: 0, skipped: 0 };
  if (point.kind === 'git') {
    const content = await commitBlob(ctx.root, point.hash, ctx.relativePath);
    snapshot = { point, content: content === null ? '' : content, exact: true, method: `Git ${point.hash.slice(0, 10)}`, applied: 0, skipped: 0 };
  }
  if (snapshot) {
    projectFileSnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  }
  const target = ctx.events.find(event => event.id === point.eventId);
  if (!target) throw new Error('AI edit point not found');
  const targetMs = Date.parse(target.ts || '');
  const candidates = [];
  const baseline = [...ctx.commits].filter(commit => Date.parse(commit.ts || '') <= targetMs).pop() || null;
  const baselineContent = baseline ? await commitBlob(ctx.root, baseline.hash, ctx.relativePath) : null;
  if (baselineContent !== null) {
    let content = baselineContent, applied = 0, skipped = 0;
    const baselineMs = Date.parse(baseline.ts || '');
    for (const event of ctx.events) {
      const eventMs = Date.parse(event.ts || '');
      if (!Number.isFinite(eventMs) || eventMs <= baselineMs || eventMs > targetMs) continue;
      const result = applyEventText(content, event, false);
      content = result.text;
      if (result.applied) applied++; else if (event.outcome !== 'failed') skipped++;
      if (event.id === target.id) break;
    }
    candidates.push({ content, method: `replayed after Git ${baseline.shortHash}`, applied, skipped, preference: 0 });
  }
  if (ctx.current !== null) {
    let content = ctx.current, applied = 0, skipped = 0;
    for (const event of [...ctx.events].reverse()) {
      const eventMs = Date.parse(event.ts || '');
      if (!Number.isFinite(eventMs) || eventMs <= targetMs) continue;
      const result = applyEventText(content, event, true);
      content = result.text;
      if (result.applied) applied++; else if (event.outcome !== 'failed') skipped++;
    }
    candidates.push({ content, method: 'reverse-replayed from current file', applied, skipped, preference: 1 });
  }
  if (!candidates.length) {
    let content = '', applied = 0, skipped = 0;
    for (const event of ctx.events) {
      const eventMs = Date.parse(event.ts || '');
      if (!Number.isFinite(eventMs) || eventMs > targetMs) continue;
      const result = applyEventText(content, event, false);
      content = result.text;
      if (result.applied) applied++; else if (event.outcome !== 'failed') skipped++;
      if (event.id === target.id) break;
    }
    candidates.push({ content, method: 'replayed from recorded writes', applied, skipped, preference: 2 });
  }
  candidates.sort((a, b) => a.skipped - b.skipped || b.applied - a.applied || a.preference - b.preference);
  const best = candidates[0];
  snapshot = { point, content: best.content, exact: false, method: best.method, applied: best.applied, skipped: best.skipped };
  projectFileSnapshotCache.set(cacheKey, snapshot);
  if (projectFileSnapshotCache.size > 1000) projectFileSnapshotCache.delete(projectFileSnapshotCache.keys().next().value);
  return snapshot;
}

function patchChangeText(patch) {
  const oldLines = [], newLines = [];
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

function nearestFilePoint(points, value) {
  if (value === '' || value === null || value === undefined) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  return points.reduce((best, point) => !best || Math.abs(point.ms - ms) < Math.abs(best.ms - ms) ? point : best, null);
}

async function projectFileCompareResponse(project, root, file, fromId = '', toId = '', fromAt = '', toAt = '') {
  const ctx = await projectFileContext(project, root, file);
  const points = fileHistoryPoints(ctx);
  if (!points.length) throw new Error('this file has no selectable history points');
  let to = points.find(point => point.id === toId) || nearestFilePoint(points, toAt) || points[points.length - 1];
  const beforeTo = points.filter(point => point.order < to.order);
  const defaultFrom = [...beforeTo].reverse().find(point => point.kind === 'git') || beforeTo[beforeTo.length - 1] || to;
  let from = points.find(point => point.id === fromId) || nearestFilePoint(points, fromAt) || defaultFrom;
  if (from.order > to.order) [from, to] = [to, from];
  const [oldSnapshot, newSnapshot] = await Promise.all([snapshotAtFilePoint(ctx, from), snapshotAtFilePoint(ctx, to)]);
  const changes = [];
  for (const event of ctx.events) {
    const point = points.find(item => item.eventId === event.id);
    if (!point || point.order <= from.order || point.order > to.order) continue;
    changes.push({
      type: 'ai', id: event.id, key: event.key, ts: event.ts, kind: event.kind,
      agent: event.agent, conversationTitle: event.conversationTitle, outcome: event.outcome,
      oldText: event.oldText || '', newText: event.newText || '',
    });
  }
  for (const commit of ctx.commits) {
    const point = points.find(item => item.hash === commit.hash);
    if (!point || point.order <= from.order || point.order > to.order) continue;
    const patch = await commitPatch(ctx.root, commit.hash, ctx.relativePath);
    changes.push({
      type: 'git', id: commit.hash, hash: commit.hash, shortHash: commit.shortHash,
      ts: commit.ts, kind: 'commit', subject: commit.subject, ...patchChangeText(patch),
    });
  }
  changes.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')) || a.id.localeCompare(b.id));
  return {
    project, repoRoot: ctx.root, path: ctx.fullPath, relativePath: ctx.relativePath,
    points, from: from.id, to: to.id, old: oldSnapshot, new: newSnapshot, changes,
    truth: 'Git and current-file points are exact. AI points replay recorded tool calls and can skip divergent edits.',
  };
}

async function conversationFileHistoryResponse(key) {
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const events = await conversationDiffs(key);
  const project = projectOfEntry(entry, key);
  const meta = projectMetaFor(project);
  const roots = meta ? await projectGitRepositories(meta) : [];
  const rows = new Map();
  for (const event of events) {
    let root = roots.find(candidate => event.path === candidate || event.path.startsWith(candidate + path.sep));
    if (!root && entry.cwd && (event.path === entry.cwd || event.path.startsWith(entry.cwd + path.sep))) root = entry.cwd;
    if (!root) root = path.dirname(event.path);
    root = path.resolve(root);
    const relativePath = path.relative(root, event.path).replace(/\\/g, '/') || path.basename(event.path);
    const repoId = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    const id = `${repoId}:${relativePath}`;
    let row = rows.get(id);
    if (!row) {
      row = { id, repoId, repoRoot: root, relativePath, path: event.path, aiEvents: [], commitEvents: [], workingTree: null, latestTs: null, contentEvents: 0 };
      rows.set(id, row);
    }
    row.aiEvents.push({
      id: event.id, key: event.key, ts: event.ts, kind: event.kind, stats: event.stats,
      conversationTitle: event.conversationTitle, agent: event.agent, outcome: event.outcome,
    });
    if (event.kind !== 'shell') row.contentEvents++;
    if (!row.latestTs || String(event.ts || '') > String(row.latestTs)) row.latestTs = event.ts;
  }
  const outputRows = [...rows.values()].sort((a, b) => Number(b.contentEvents > 0) - Number(a.contentEvents > 0) || String(b.latestTs || '').localeCompare(String(a.latestTs || '')) || a.relativePath.localeCompare(b.relativePath));
  return {
    scope: 'conversation', key, project, cwd: entry.cwd || null,
    title: entry.timelineTitle || entry.title || key, firstTs: entry.firstTs || null, lastTs: entry.lastTs || null,
    repositories: [...new Map(outputRows.map(row => [row.repoId, { id: row.repoId, root: row.repoRoot }])).values()],
    rows: outputRows, totals: { files: outputRows.length, aiEvents: events.length, failed: events.filter(event => event.outcome === 'failed').length },
  };
}

async function conversationFileContext(key, root, file) {
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const conversationEvents = await conversationDiffs(key);
  const { fullPath } = normalizedRepoFile(path.resolve(root || ''), file);
  if (!conversationEvents.some(event => path.resolve(event.path) === fullPath)) throw new Error('file was not touched in this conversation');
  const project = projectOfEntry(entry, key);
  try { return await projectFileContext(project, root, file); }
  catch {
    const meta = projectMetaFor(project);
    const events = [];
    for (const { key: candidateKey } of meta ? meta.entries : [{ key }]) {
      try {
        for (const event of await conversationDiffs(candidateKey)) if (path.resolve(event.path) === fullPath) events.push(event);
      } catch {}
    }
    events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.editIndex - b.editIndex || a.id.localeCompare(b.id));
    const resolvedRoot = path.resolve(root);
    let repo;
    try { repo = await loadGitRepository(resolvedRoot); }
    catch { repo = { id: crypto.createHash('sha256').update('workspace:' + resolvedRoot).digest('hex').slice(0, 12), root: resolvedRoot, commits: [], workingTree: [], isGit: false }; }
    const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, '/');
    const commits = (repo.commits || []).filter(commit => commit.files.some(changed => changed.path === relativePath))
      .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || a.hash.localeCompare(b.hash));
    let current = null, diskMtime = 0;
    try { const stat = await fsp.stat(fullPath); diskMtime = stat.mtimeMs; current = await fsp.readFile(fullPath, 'utf8'); } catch {}
    const version = diffEventHash([diskMtime, repo.head || '', events.map(event => `${event.id}:${event.outcome}`), commits.map(commit => commit.hash)]);
    return { project, root: resolvedRoot, relativePath, fullPath, repo, events, commits, current, version };
  }
}

async function conversationFileCompareResponse(key, root, file, fromId = '', toId = '', fromAt = '', toAt = '') {
  const ctx = await conversationFileContext(key, root, file);
  const allPoints = fileHistoryPoints(ctx);
  const scopedEvents = ctx.events.filter(event => event.key === key);
  const eventPoints = scopedEvents.map(event => allPoints.find(point => point.eventId === event.id)).filter(Boolean);
  if (!eventPoints.length) throw new Error('this conversation has no timed file changes for this file');
  const entry = index[key];
  const firstGlobal = eventPoints[0], lastGlobal = eventPoints[eventPoints.length - 1];
  const previous = [...allPoints].reverse().find(point => point.order < firstGlobal.order) || null;
  const entryStart = Date.parse(entry.firstTs || '');
  const entryEnd = Date.parse(entry.lastTs || '');
  const startMs = Number.isFinite(entryStart) ? Math.min(entryStart, firstGlobal.ms - 1) : Math.max(0, firstGlobal.ms - 1);
  const endMs = Number.isFinite(entryEnd) ? Math.max(entryEnd, lastGlobal.ms + 1) : lastGlobal.ms + 1;
  const startBoundary = {
    id: 'conversation-start', kind: 'boundary', ts: new Date(startMs).toISOString(), ms: startMs, order: 0,
    label: 'conversation start · before this file changed', sourcePoint: previous,
  };
  const endBoundary = {
    id: 'conversation-end', kind: 'boundary', ts: new Date(endMs).toISOString(), ms: endMs, order: eventPoints.length + 1,
    label: 'conversation end · after this file changed', sourcePoint: lastGlobal,
  };
  const points = [startBoundary, ...eventPoints.map((point, i) => ({ ...point, order: i + 1 })), endBoundary];
  let to = points.find(point => point.id === toId) || nearestFilePoint(points, toAt) || points[points.length - 1];
  let from = points.find(point => point.id === fromId) || nearestFilePoint(points, fromAt) || points[0];
  if (from.order > to.order) [from, to] = [to, from];
  const scopedSnapshot = async point => {
    if (point.kind !== 'boundary') return snapshotAtFilePoint(ctx, point);
    if (point.sourcePoint) {
      const source = await snapshotAtFilePoint(ctx, point.sourcePoint);
      return { ...source, point };
    }
    const firstEvent = scopedEvents[0];
    if (firstEvent.kind === 'write') return { point, content: '', exact: false, method: 'before the first recorded write', applied: 0, skipped: 0 };
    const after = await snapshotAtFilePoint(ctx, firstGlobal);
    const reversed = applyEventText(after.content, firstEvent, true);
    return { point, content: reversed.text, exact: false, method: 'reversed from the first conversation edit', applied: reversed.applied ? 1 : 0, skipped: reversed.applied ? 0 : 1 };
  };
  const [oldSnapshot, newSnapshot] = await Promise.all([scopedSnapshot(from), scopedSnapshot(to)]);
  const changes = scopedEvents.map(event => {
    const point = points.find(item => item.eventId === event.id);
    if (!point || point.order <= from.order || point.order > to.order) return null;
    return {
      type: 'ai', id: event.id, key: event.key, ts: event.ts, kind: event.kind,
      agent: event.agent, conversationTitle: event.conversationTitle, outcome: event.outcome,
      oldText: event.oldText || '', newText: event.newText || '',
    };
  }).filter(Boolean).sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')) || a.id.localeCompare(b.id));
  return {
    scope: 'conversation', key, project: ctx.project, repoRoot: ctx.root, path: ctx.fullPath, relativePath: ctx.relativePath,
    points, from: from.id, to: to.id, old: oldSnapshot, new: newSnapshot, changes,
    truth: 'This view includes only file changes recorded in this conversation. Complete AI snapshots are reconstructed and can skip divergent edits.',
  };
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

// ---- direct file editing ----
// The whole-file view edits the CURRENT on-disk file, never a snapshot.
// Writes stay inside indexed Git repositories or indexed conversation
// working directories. A base hash makes each save optimistic: the write
// is refused when the disk changed after the read.
const FILE_EDIT_MAX = 2 * 1024 * 1024;

function expandHomePath(p) {
  const s = String(p || '');
  return s === '~' ? os.homedir() : s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
}

const sha256Hex = text => crypto.createHash('sha256').update(text).digest('hex');

// In-place rewrite: truncate + write + fsync on the SAME inode. A rename
// replacement orphans recursive fs.watch on Linux (verified empirically:
// appends after the rename emit no events), which froze live transcript
// updates. Transcript edits therefore write in place; the backup taken
// before the write is the crash-recovery path.
async function writeFileInPlace(abs, text) {
  const fh = await fsp.open(abs, 'r+');
  try {
    await fh.truncate(0);
    await fh.writeFile(text);
    await fh.sync();
  } finally { await fh.close(); }
}

async function editableFilePath(pathValue) {
  const abs = path.resolve(expandHomePath(pathValue));
  let st;
  try { st = await fsp.stat(abs); } catch { throw new Error('file not found on disk'); }
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > FILE_EDIT_MAX) throw new Error('file too large to edit here');
  const inside = root => root && (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  // Fast path: the cached repository list and indexed conversation
  // directories answer without spawning any git process. The full
  // discovery below is the slow fallback for unknown paths only.
  if ((gitRepoIndexCache.repos || []).some(repo => inside(repo.root))) return abs;
  for (const entry of Object.values(index)) if (inside(entry.cwd)) return abs;
  const repos = await discoverGitRepos();
  if (repos.some(repo => inside(repo.root))) return abs;
  throw new Error('this path is outside every indexed repository and project');
}

function pathWithoutLocation(pathValue) {
  return String(pathValue || '').replace(/:(\d+)(?::(\d+))?$/, '');
}

const pathRealRootCache = new Map();
function pathInside(abs, root) {
  if (!root) return false;
  let realRoot = pathRealRootCache.get(root);
  if (!realRoot) {
    try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
    pathRealRootCache.set(root, realRoot);
    if (pathRealRootCache.size > 2000) pathRealRootCache.clear();
  }
  return abs === realRoot || abs.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
}

// Resolve once, then apply the access policy to the canonical path. Local
// app windows can preview paths under home and tmp. Authenticated LAN readers
// keep the narrower project/repository policy and can never launch host apps.
async function transcriptPathInfo(key, pathValue, { local = false, maxBytes = Infinity } = {}) {
  const clean = pathWithoutLocation(pathValue);
  const expanded = expandHomePath(clean);
  const cwd = key && index[key] ? index[key].cwd || '' : '';
  if (!path.isAbsolute(expanded) && !cwd) throw new Error('relative path without a conversation');
  const wanted = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
  let abs, stat;
  try {
    abs = await fsp.realpath(wanted);
    stat = await fsp.stat(abs);
  } catch { throw new Error('file not found on disk'); }
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a regular file or directory');
  if (stat.isFile() && stat.size > maxBytes) throw new Error('file is too large to open here');

  let allowed = local && (pathInside(abs, os.homedir()) || pathInside(abs, os.tmpdir()));
  if (!allowed) allowed = (gitRepoIndexCache.repos || []).some(repo => pathInside(abs, repo.root)) ||
    Object.values(index).some(entry => pathInside(abs, entry.cwd));
  if (!allowed) {
    const repos = await discoverGitRepos();
    allowed = repos.some(repo => pathInside(abs, repo.root));
  }
  if (!allowed) throw new Error(local
    ? 'this path is outside your home, tmp, and projects'
    : 'this path is outside every indexed repository and project');
  return { abs, stat };
}

async function transcriptFilePath(key, pathValue, maxBytes = 32 * 1024 * 1024, local = false) {
  const found = await transcriptPathInfo(key, pathValue, { local, maxBytes });
  if (!found.stat.isFile()) throw new Error('not a regular file');
  return found;
}

async function transcriptFileReadResponse(key, pathValue, local = false) {
  const { abs } = await transcriptFilePath(key, pathValue, FILE_EDIT_MAX, local);
  const body = await fsp.readFile(abs);
  if (body.subarray(0, 8192).includes(0)) throw new Error('this is a binary file');
  const text = body.toString('utf8');
  return { path: abs, text, sha: sha256Hex(text) };
}

function imageMimeForPath(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] || null;
}

async function pathInfoResponse(key, pathValue, local = false) {
  const { abs, stat } = await transcriptPathInfo(key, pathValue, { local });
  if (stat.isDirectory()) return { path: abs, kind: 'directory', preview: 'none', hostActions: local };
  const mime = imageMimeForPath(abs);
  let preview = mime ? 'image' : 'text';
  if (!mime) {
    if (stat.size > FILE_EDIT_MAX) preview = 'none';
    else {
      const fh = await fsp.open(abs, 'r');
      try {
        const sample = Buffer.alloc(Math.min(8192, stat.size));
        if (sample.length) await fh.read(sample, 0, sample.length, 0);
        if (sample.includes(0)) preview = 'none';
      } finally { await fh.close(); }
    }
  }
  return { path: abs, kind: 'file', preview, mime: mime || null, size: stat.size, hostActions: local };
}

function spawnDesktop(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: agentEnv() });
    child.unref();
    const timer = setTimeout(resolve, 150);
    child.on('error', err => { clearTimeout(timer); reject(new Error(command + ' failed: ' + err.message)); });
  });
}

function runningOnWsl() {
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); }
  catch { return false; }
}

function windowsSystemPath(rel) {
  return '/mnt/c/Windows/' + String(rel).replace(/\\/g, '/');
}

function wslWindowsPath(abs) {
  return new Promise((resolve, reject) => {
    const child = spawn('wslpath', ['-w', abs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(new Error('wslpath failed: ' + e.message)));
    child.on('close', code => {
      const win = out.trim();
      if (code === 0 && win) resolve(win);
      else reject(new Error(err.trim() || 'wslpath failed'));
    });
  });
}

async function openOnWindows(abs, reveal, isDir) {
  const win = await wslWindowsPath(abs);
  const explorer = windowsSystemPath('explorer.exe');
  if (reveal) {
    await spawnDesktop(explorer, isDir ? [win] : ['/select,' + win]);
    return;
  }
  const ps = windowsSystemPath('System32/WindowsPowerShell/v1.0/powershell.exe');
  const literal = "'" + win.replace(/'/g, "''") + "'";
  try {
    await spawnDesktop(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath ' + literal]);
  } catch {
    await spawnDesktop(explorer, [win]);
  }
}

async function revealNativePath(abs, stat) {
  if (runningOnWsl()) {
    await openOnWindows(abs, true, stat.isDirectory());
    return;
  }
  const uri = pathToFileURL(abs).href;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'],
        { stdio: 'ignore', env: agentEnv() });
      const timer = setTimeout(() => { child.kill(); reject(new Error('file manager timed out')); }, 2000);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('file manager refused the request')); });
    });
  } catch {
    await spawnDesktop('xdg-open', [stat.isDirectory() ? abs : path.dirname(abs)]);
  }
}

// Explicit host actions. The operating system owns file-type associations;
// aiconvo only checks the path and forwards the user's local gesture.
async function nativePathAction(key, pathValue, action) {
  const { abs, stat } = await transcriptPathInfo(key, pathValue, { local: true });
  if (action === 'reveal') {
    await revealNativePath(abs, stat);
    return { ok: true, action, path: abs };
  }
  if (action !== 'open') throw new Error('unknown file action');
  if (stat.isFile() && path.extname(abs).toLowerCase() === '.desktop')
    throw new Error('desktop launcher files can only be shown in their folder');
  if (runningOnWsl()) await openOnWindows(abs, false, stat.isDirectory());
  else await spawnDesktop('xdg-open', [abs]);
  return { ok: true, action, path: abs };
}

async function fileReadResponse(pathValue) {
  const abs = await editableFilePath(pathValue);
  const text = await fsp.readFile(abs, 'utf8');
  return { path: abs, text, sha: sha256Hex(text) };
}

async function fileSaveResponse(body) {
  const { path: p, baseSha, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  const abs = await editableFilePath(p || '');
  if (baseSha) {
    const current = await fsp.readFile(abs, 'utf8');
    if (sha256Hex(current) !== baseSha) throw new Error('the file changed on disk after you loaded it — reload and edit again');
  }
  await writeFileAtomic(abs, text);
  return { ok: true, path: abs, sha: sha256Hex(text) };
}

// ---- documents: MRMD-backed markdown editing ----
// Aiconvo owns the file lifecycle: reads, autosaves, conflict checks, Git
// commits, and the provenance ledger. MRMD (vendored light bundle) owns the
// editing surface only. The ledger is durable append-only JSONL: it records
// who changed a document (human/ai) and through which input, outside the
// markdown itself — files stay ordinary markdown.
const DOC_EDITS_FILE = path.join(NOTES_DIR, 'doc-edits.jsonl');
const DOC_ACTORS = new Set(['human', 'ai', 'runtime', 'external-agent']);
const DOC_INPUTS = new Set(['keyboard', 'voice', 'pen', 'paste', 'ai-edit', 'filesystem']);

async function recordDocEdit(entry) {
  try {
    await fsp.mkdir(NOTES_DIR, { recursive: true });
    await fsp.appendFile(DOC_EDITS_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

function docLineDelta(oldText, newText) {
  const before = String(oldText || '').split('\n');
  const after = String(newText || '').split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length - 1, newEnd = after.length - 1;
  while (oldEnd >= start && newEnd >= start && before[oldEnd] === after[newEnd]) { oldEnd--; newEnd--; }
  return { removed: Math.max(0, oldEnd - start + 1), added: Math.max(0, newEnd - start + 1) };
}

// Autosave: write the markdown, refuse stale writes, record provenance.
// This is NOT a Git commit — explicit save commits (docCommitResponse).
async function docSaveResponse(body) {
  const { path: p, baseSha, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  const abs = await editableFilePath(p || '');
  if (!abs.endsWith('.md')) throw new Error('only markdown documents save here');
  const oldText = await fsp.readFile(abs, 'utf8');
  if (baseSha && sha256Hex(oldText) !== baseSha) throw new Error('the file changed on disk after you loaded it');
  if (oldText !== text) {
    await writeFileAtomic(abs, text);
    const delta = docLineDelta(oldText, text);
    await recordDocEdit({
      ts: Date.now(), path: abs, action: 'save',
      actor: DOC_ACTORS.has(body.actor) ? body.actor : 'human',
      input: DOC_INPUTS.has(body.input) ? body.input : 'keyboard',
      added: delta.added, removed: delta.removed, sha: sha256Hex(text),
    });
    // The 24h activity index (code tree badges) hears about editor saves
    // directly — no dependency on a watcher being attached yet.
    recordProjectFileActivity(abs, {
      id: `doc:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`,
      ts: Date.now(), added: delta.added, removed: delta.removed, source: 'doc',
    });
  }
  return { ok: true, path: abs, sha: sha256Hex(text), changed: oldText !== text };
}

const DOC_COMMIT_TITLE_PROMPT =
  'The attached file is a git diff of one markdown document revision. ' +
  'Write a commit title that names what changed in the document (content, not formatting mechanics). ' +
  'Reply with STRICT JSON only, no prose or code fence: {"title":"max 60 chars, no period"}.';

// Fire-and-forget: give the fresh commit an AI title. Amend only while HEAD
// is still that exact commit and the stage is clean — never rewrite other work.
function scheduleDocCommitTitle(root, hash, diffText) {
  setTimeout(async () => {
    try {
      const raw = await runPi(clipped(diffText, 60000), DOC_COMMIT_TITLE_PROMPT);
      const title = oneLine(JSON.parse(raw.replace(/^```(json)?\s*|\s*```$/g, '')).title, '').slice(0, 60);
      if (!title) return;
      const head = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
      if (head !== hash) return;
      await gitText(root, ['diff', '--cached', '--quiet']); // throws when something is staged
      await gitText(root, ['commit', '--amend', '--no-verify', '-m', title]);
      broadcast({ type: 'doc-commit-titled', root, was: hash });
    } catch {}
  }, 50);
}

// Explicit save = a real Git commit of this one document.
async function docCommitResponse(body) {
  const abs = await editableFilePath(body.path || '');
  if (!abs.endsWith('.md')) throw new Error('only markdown documents commit here');
  let sha = null;
  if (typeof body.text === 'string') {
    sha = (await docSaveResponse({ path: abs, baseSha: body.baseSha, text: body.text, actor: body.actor, input: body.input })).sha;
  }
  const dir = path.dirname(abs);
  let root;
  try { root = (await gitText(dir, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new Error('this document is not inside a Git repository'); }
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  await gitText(root, ['add', '--', rel]);
  const staged = String(await gitText(root, ['diff', '--cached', '--numstat', '--', rel]).catch(() => '')).trim();
  if (!staged) return { ok: true, unchanged: true, path: abs, sha };
  const [addedRaw, removedRaw] = staged.split('\t');
  const subject = `doc: ${path.basename(abs)} (+${Number(addedRaw) || 0} −${Number(removedRaw) || 0})`;
  const diffText = await gitText(root, ['diff', '--cached', '--', rel]).catch(() => '');
  await gitText(root, ['commit', '--no-verify', '-m', subject, '--', rel]);
  const hash = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
  await recordDocEdit({ ts: Date.now(), path: abs, action: 'commit', hash, subject });
  scheduleDocCommitTitle(root, hash, diffText);
  return { ok: true, path: abs, hash, subject, sha };
}

// Create a new markdown document. Documents live in <projectRoot>/documents/
// by default — a plain folder agents and humans both find instantly.
async function docCreateResponse(body) {
  const project = String(body.project || '');
  const meta = projectMetaFor(project);
  if (!meta || !meta.cwd) throw new Error('project not found');
  const rawName = String(body.name || '').trim();
  if (!rawName) throw new Error('document name is required');
  const base = rawName.replace(/\.md$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim().replace(/\s+/g, '-');
  if (!base) throw new Error('document name has no usable characters');
  const dir = path.join(path.resolve(meta.cwd), 'documents');
  const abs = path.join(dir, base + '.md');
  if (fs.existsSync(abs)) throw new Error('a document with this name already exists');
  await fsp.mkdir(dir, { recursive: true });
  const text = `# ${rawName.replace(/\.md$/i, '')}\n\n`;
  await writeFileAtomic(abs, text);
  await recordDocEdit({ ts: Date.now(), path: abs, action: 'create', actor: 'human', input: 'keyboard', added: text.split('\n').length, removed: 0, sha: sha256Hex(text) });
  return { ok: true, path: abs, project };
}

// Cheap document catalog for the project documents surface: every markdown
// file in the project's repositories (tracked + untracked), newest first,
// with the 24h activity badge from the durable activity index.
async function projectDocsResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const roots = await projectGitRepositories(meta);
  if (!roots.length && meta.cwd && fs.existsSync(meta.cwd)) roots.push(path.resolve(meta.cwd));
  const docs = [];
  for (const root of roots) {
    const rels = new Set();
    for (const rel of await gitTrackedPaths(root).catch(() => [])) if (rel.endsWith('.md')) rels.add(rel);
    const untracked = String(await gitText(root, ['ls-files', '--others', '--exclude-standard', '--', '*.md']).catch(() => ''));
    for (const rel of untracked.split('\n')) if (rel.trim()) rels.add(rel.trim());
    for (const rel of rels) {
      const abs = path.join(root, rel);
      let st; try { st = await fsp.stat(abs); } catch { continue; }
      docs.push({ path: abs, rel, root, mtimeMs: st.mtimeMs, recent24: recentProjectFileActivity(abs) });
      if (docs.length >= 800) break;
    }
  }
  docs.sort((a, b) => Number((b.recent24 && b.recent24.latestTs) || b.mtimeMs) - Number((a.recent24 && a.recent24.latestTs) || a.mtimeMs));
  return { project, cwd: meta.cwd, docs: docs.slice(0, 400) };
}

// Serve a document-relative asset (image) for the editor's rendered view.
async function docAssetResponse(docPath, src) {
  const doc = await editableFilePath(docPath || '');
  const clean = String(src || '').split(/[?#]/)[0];
  if (!clean || /^[a-z]+:/i.test(clean) || clean.startsWith('//')) throw new Error('only relative asset paths resolve here');
  const abs = path.resolve(path.dirname(doc), clean);
  const inside = root => root && (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  if (!inside(os.homedir())) throw new Error('asset is outside home');
  const mime = imageMimeForPath(abs) || ({ '.svg': 'image/svg+xml' })[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error('not an image asset');
  const bytes = await fsp.readFile(abs);
  if (bytes.length > 24 * 1024 * 1024) throw new Error('asset too large');
  return { mime, bytes };
}

// Notes, epics, and project-memory documents are markdown under NOTES_DIR.
async function noteFileSaveResponse(body) {
  const { path: p, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  const abs = path.resolve(expandHomePath(p || ''));
  if (!abs.endsWith('.md') || !abs.startsWith(NOTES_DIR + path.sep)) throw new Error('only markdown files under ~/notes/aiconvo are editable here');
  await fsp.stat(abs); // the file must already exist: this edits, it does not create
  await writeFileAtomic(abs, text);
  return { ok: true, path: abs };
}

// ---- trust: the vouch ledger ----
// Pure logic lives in trust.js (tested). Records are append-only JSONL under
// ~/notes/aiconvo/vouches.jsonl, so the ledger stays a plain, durable,
// auditable file. Trust never excludes content; it only labels it.
const trustLib = require('./trust.js');
const VOUCH_LEDGER = path.join(NOTES_DIR, 'vouches.jsonl');
let vouchRecords = [];
function loadVouches() {
  vouchRecords = [];
  try {
    for (const line of fs.readFileSync(VOUCH_LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { vouchRecords.push(JSON.parse(line)); } catch {}
    }
  } catch {}
}
loadVouches();

const activeVouches = () => trustLib.activeRecords(vouchRecords);
const vouchStatusFor = (absPath, content) => trustLib.statusFor(vouchRecords, absPath, content);

async function vouchApply(body) {
  const action = body.action === 'dispute' ? 'dispute' : body.action === 'retract' ? 'retract' : 'vouch';
  let record;
  if (action === 'retract') {
    if (!body.ref) throw new Error('retract needs the record id in "ref"');
    record = { id: crypto.randomUUID(), ts: new Date().toISOString(), action, ref: String(body.ref) };
  } else {
    const abs = path.resolve(expandHomePath(String(body.path || '')));
    if (!path.isAbsolute(abs)) throw new Error('missing path');
    // The client sends the exact text it displayed; without it, vouch the disk file.
    let text = typeof body.text === 'string' ? body.text : await fsp.readFile(abs, 'utf8');
    if (text.length > 500000) throw new Error('this block is too large to vouch in one record');
    const range = Array.isArray(body.range) && body.range.length === 2 ? [Number(body.range[0]), Number(body.range[1])] : null;
    record = {
      id: crypto.randomUUID(), ts: new Date().toISOString(), action, path: abs,
      range: range || undefined, contentSha: sha256Hex(text), text,
      note: String(body.note || '').slice(0, 2000) || undefined,
      source: String(body.source || '').slice(0, 40) || undefined,
    };
  }
  await fsp.mkdir(NOTES_DIR, { recursive: true });
  await fsp.appendFile(VOUCH_LEDGER, JSON.stringify(record) + '\n');
  vouchRecords.push(record);
  broadcast({ type: 'vouch', path: record.path || null });
  return record;
}

// One disk-state summary per vouched path: for tree badges and review lists.
function vouchAllResponse() {
  const paths = {};
  for (const p of new Set(activeVouches().map(r => r.path))) {
    let content = null;
    try { content = fs.readFileSync(p, 'utf8'); } catch {}
    if (content === null) { paths[p] = { state: 'missing', disputed: false, ts: null }; continue; }
    const st = vouchStatusFor(p, content);
    const v = st.records.filter(r => r.action === 'vouch');
    const state = !v.length ? 'none' : v.every(r => r.state === 'fresh') ? 'fresh' : st.summary.vouched ? 'partial' : 'stale';
    paths[p] = {
      state, disputed: st.records.some(r => r.action === 'dispute' && r.matchedCount),
      ts: st.summary.lastVouchTs, records: st.records.length,
      vouchedLines: st.summary.vouched, disputedLines: st.summary.disputed, totalLines: st.summary.total,
    };
  }
  return { paths };
}

// Trust label for generated-content listings (briefings). Everything stays
// included; the label only states how much a human verified, and when.
function trustLabel(absPath) {
  if (!activeVouches().some(r => r.path === absPath)) return '[unverified]';
  let content = null;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return '[vouched earlier · file missing]'; }
  return trustLib.trustLabelFrom(vouchStatusFor(absPath, content));
}

// ---- transcript editing ----
// Everything in a transcript is editable: user text, assistant text, tool
// inputs, tool results, live or idle. Format safety is the one hard rule:
// parse the one target JSONL line, change only the target field, and
// re-serialize the full entry. No string surgery on raw lines. When a live
// agent owns the session, the server stops it first and reopens it after
// the write, so it resumes with the edited context.

// Replace the text of a message content. String content stays a string.
// In a block array the new text goes into the first text block; later text
// blocks fold into it; non-text blocks (thinking, tool_use, …) stay.
function editedTextContent(content, newText) {
  if (typeof content === 'string' || content == null) return newText;
  if (!Array.isArray(content)) return newText;
  const out = [];
  let placed = false;
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      if (!placed) { out.push({ ...b, text: newText }); placed = true; }
    } else out.push(b);
  }
  if (!placed) out.push({ type: 'text', text: newText });
  return out;
}

// Locate the edit target for message index i: the JSONL line, the entry,
// and — for tool calls and results — the exact content block. Blocks are
// matched by ordinal position among same-role messages of the same entry,
// the exact inverse of how parseFile builds the message list.
async function transcriptTarget(key, i) {
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const abs = absPathForKey(key);
  if (!abs) throw new Error('no session file for this conversation');
  const rawText = await fsp.readFile(abs, 'utf8');
  const { messages } = await parseFile(abs);
  const m = messages[i];
  if (!m) throw new Error('message not found — reload the conversation');
  if (!m.eid) throw new Error('this row has no entry in the session file');
  let ordinal = 0;
  for (let at = 0; at < i; at++) if (messages[at].eid === m.eid && messages[at].role === m.role) ordinal++;
  const lines = rawText.split('\n');
  let lineAt = -1, d = null;
  for (let at = 0; at < lines.length; at++) {
    if (!lines[at].trim()) continue;
    let parsed;
    try { parsed = JSON.parse(lines[at]); } catch { continue; }
    if (parsed && parsed.type !== 'session' && (parsed.id || parsed.uuid) === m.eid) { lineAt = at; d = parsed; break; }
  }
  if (lineAt < 0) throw new Error('entry not found in the session file — reload and retry');
  const content = d.message && d.message.content;
  if (m.role === 'user' || m.role === 'assistant') {
    return { abs, lines, lineAt, d, m, kind: 'text', raw: textOf(content),
      apply(newText) { d.message.content = editedTextContent(content, newText); } };
  }
  if (m.role === 'tool') {
    const blocks = (Array.isArray(content) ? content : []).filter(b => b && (b.type === 'tool_use' || b.type === 'toolCall'));
    const b = blocks[ordinal];
    if (!b) throw new Error('tool-call block not found in the entry');
    const input = b.input || b.arguments || {};
    return { abs, lines, lineAt, d, m, kind: 'json', raw: JSON.stringify(input, null, 2),
      apply(newText) {
        let parsed;
        try { parsed = JSON.parse(newText); } catch { throw new Error('tool input must stay valid JSON'); }
        if (!parsed || typeof parsed !== 'object') throw new Error('tool input must be a JSON object');
        if (b.arguments !== undefined) b.arguments = parsed; else b.input = parsed;
      } };
  }
  if (m.role === 'toolresult') {
    if (d.type === 'message' && d.message && d.message.role === 'toolResult') {
      // pi: the tool result is its own message entry
      const raw = textOf(content) || (typeof content === 'string' ? content : '');
      return { abs, lines, lineAt, d, m, kind: 'text', raw,
        apply(newText) { d.message.content = editedTextContent(content, newText); } };
    }
    // claude: a tool_result block inside a user turn
    const blocks = (Array.isArray(content) ? content : []).filter(b => b && b.type === 'tool_result');
    const b = blocks[ordinal];
    if (!b) throw new Error('tool-result block not found in the entry');
    const raw = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
    return { abs, lines, lineAt, d, m, kind: 'text', raw,
      apply(newText) { b.content = typeof b.content === 'string' || b.content == null ? newText : editedTextContent(b.content, newText); } };
  }
  throw new Error('this message kind is not editable');
}

async function stopRunningAgent(running) {
  try { process.kill(running.pid, 'SIGTERM'); } catch { return; }
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    try { process.kill(running.pid, 0); } catch { return; } // process is gone
    await sleep(120);
  }
  try { process.kill(running.pid, 'SIGKILL'); } catch {}
  await sleep(300);
}

// Wait until the session file stops changing (the exiting agent may still flush).
async function waitFileQuiet(abs, totalMs = 3000, quietMs = 500) {
  let last = null, since = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    let sig = 'none';
    try { const st = await fsp.stat(abs); sig = st.mtimeMs + ':' + st.size; } catch {}
    if (sig !== last) { last = sig; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return;
    await sleep(120);
  }
}

async function transcriptRawResponse(key, i) {
  const target = await transcriptTarget(key, i);
  return { key, i, role: target.m.role, kind: target.kind, raw: target.raw, sha: sha256Hex(target.raw) };
}

async function transcriptEditResponse(body) {
  const { id: key, i, baseSha, text } = body;
  if (typeof text !== 'string') throw new Error('missing text');
  await releaseHeadless(absPathForKey(key), 'transcript edit');
  const running = findRunningConversation(key);
  if (running) {
    await stopRunningAgent(running);
    await waitFileQuiet(absPathForKey(key));
  }
  // Locate the target AFTER the stop: the exiting agent may have appended.
  const target = await transcriptTarget(key, Number(i));
  if (baseSha && sha256Hex(target.raw) !== baseSha) throw new Error('the transcript changed after you loaded it — reload and edit again');
  // One backup per edit, for undo by hand.
  const backupDir = path.join(CACHE_DIR, 'edits');
  await fsp.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(target.abs) + '.' + Date.now() + '.bak');
  await fsp.copyFile(target.abs, backup);
  target.apply(text);
  target.lines[target.lineAt] = JSON.stringify(target.d);
  await writeFileInPlace(target.abs, target.lines.join('\n'));
  // Reindex now: the client reloads at once and must not see the stale cache.
  try {
    const at = key.indexOf(':');
    await indexFile(key.slice(0, at), key.slice(at + 1), await fsp.stat(target.abs));
  } catch {}
  let reopened = false;
  if (running) {
    try { await openConversationInTerminal(key, { focus: true }); reopened = true; }
    catch {}
  }
  return { ok: true, backup, stopped: !!running, reopened };
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
function projectOfEntry(entry, key = '') {
  return projectNameOf(entry && entry.cwd, key);
}

function projectMetaFor(project) {
  const entries = Object.entries(index)
    .filter(([key, entry]) => key && entry && projectOfEntry(entry, key) === project)
    .map(([key, entry]) => ({ key, entry }));
  if (!entries.length) {
    // A registered newborn: no conversations yet, but the folder is real.
    const rec = createdRecordFor(project);
    if (!rec) return null;
    return { project, cwd: rec.cwd || null, entries: [], epics: [], latestMs: rec.createdAt || 0, created: true };
  }
  // The project root is DERIVED, not chosen among conversation cwds: any
  // member cwd under /Projects/<name>/… yields the root by truncation. A
  // project whose conversations ALL live in subfolders still roots at the
  // project folder itself. Prefer roots whose own raw name IS the canonical
  // project (the main worktree beats folded worktree checkouts).
  const registered = createdRecordFor(project);
  let cwd = (registered && registered.cwd) || null;
  if (!cwd) {
    const roots = new Map(); // derived root -> best score seen
    for (const { entry } of entries) {
      const c = entry.cwd;
      if (!c) continue;
      const root = areasLib.projectRootOfCwd(c) || c;
      const score = (foldsLib.rawProjectOf(c) === project ? 2 : 0) + (areasLib.relOfCwd(c) === '' ? 1 : 0);
      const prev = roots.get(root);
      if (prev === undefined || score > prev) roots.set(root, score);
    }
    let bestScore = -1;
    for (const [root, score] of roots) {
      if (score > bestScore || (score === bestScore && cwd && root.length < cwd.length)) { cwd = root; bestScore = score; }
    }
  }
  const epicsForProject = Object.values(epics)
    .map(epic => ({
      id: epic.id, title: epic.title, abstract: epic.abstract || '',
      updatedAt: epic.updatedAt || 0, notePath: epic.notePath || null,
      sessionIds: (epic.sessionIds || []).filter(id => index[id] && projectOfEntry(index[id], id) === project),
    }))
    .filter(epic => epic.sessionIds.length)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const latestMs = entries.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
  return { project, cwd, entries, epics: epicsForProject, latestMs };
}

function noteStateForEntry(entry) {
  if (!entry || !entry.notePath) return 'missing';
  return entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt ? 'stale' : 'fresh';
}

async function projectResponse(project) {
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const { cwd, entries, epics: projectEpics, latestMs } = meta;
  const declaredAreas = declaredAreasFor(project);
  const declaredRels = Object.keys(declaredAreas);
  const now = Date.now();
  let notes = 0, freshNotes = 0, evidenceCards = 0, freshEvidence = 0;
  const recent = [];
  const sorted = [...entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''));
  // Parallel, memoized state per conversation. Full JSON parses happen only
  // when a signature moved; a settled project answers from stats alone.
  let evidSig = 'none';
  try { const st = await fsp.stat(EPIC_EVIDENCE_FILE); evidSig = Math.round(st.mtimeMs) + ':' + st.size; } catch {}
  let evidencedKeys = null; // lazy — built once, only when a miss needs the stale check
  const buildEvidencedKeys = () => {
    const set = new Set();
    for (const c of Object.values(epicEvidenceCache)) {
      if (c && typeof c === 'object' && c.key && typeof c.text === 'string') set.add(c.key);
    }
    return set;
  };
  const markers = await mapLimit(sorted, 16, async ({ key, entry }) => {
    const p = cachePathFor(key);
    let st = null;
    try { st = await fsp.stat(p); } catch {}
    if (!st) return 'missing';
    if (entry.notePath) return 'note';
    const sig = Math.round(st.mtimeMs) + ':' + st.size + ':' + evidSig;
    const memo = evidenceStateMemo[key];
    if (memo && memo.sig === sig) return memo.state;
    let data = null;
    try { data = JSON.parse(await fsp.readFile(p, 'utf8')); } catch {}
    let state = 'missing';
    if (data) {
      if (data.notePath) state = 'note';
      else {
        const h = epicEvidenceHash(data);
        if (h in epicEvidenceCache) state = 'fresh';
        else {
          if (!evidencedKeys) evidencedKeys = buildEvidencedKeys();
          state = evidencedKeys.has(key) ? 'stale' : 'missing';
        }
      }
    }
    evidenceStateMemo[key] = { sig, state };
    saveEvidenceStateMemoSoon();
    return state;
  });
  const leafMarks = await mapLimit(sorted, 16, async ({ key, entry }) =>
    entry.realUserCount ? leafStateFor(entry, await readLeaf(key)) : 'empty');
  const leaves = { fresh: 0, stale: 0, seeded: 0, missing: 0, empty: 0 };
  for (let si = 0; si < sorted.length; si++) {
    const { key, entry } = sorted[si];
    const noteState = noteStateForEntry(entry);
    if (entry.notePath) { notes++; if (noteState === 'fresh') freshNotes++; }
    const evidenceState = markers[si] === 'note' ? noteState : markers[si];
    if (evidenceState !== 'missing') { evidenceCards++; if (evidenceState === 'fresh') freshEvidence++; }
    leaves[leafMarks[si]] = (leaves[leafMarks[si]] || 0) + 1;
    if (recent.length < 12) {
      recent.push({
        key, title: entry.timelineTitle || entry.title || key, source: entry.source || 'claude',
        cwd: entry.cwd || null, lastTs: entry.lastTs || null, active: !!(entry.mtimeMs && now - entry.mtimeMs < 5 * 60 * 1000),
        area: areaOfCwdIn(project, entry.cwd, declaredRels),
        notePath: entry.notePath || null, note: noteState, evidence: evidenceState, leaf: leafMarks[si],
      });
    }
  }
  // Areas: one card per declared inner scope, with its own conversation
  // count, last activity, and memory freshness.
  const areas = [];
  for (const [rel, rec] of Object.entries(declaredAreas)) {
    const scoped = entries.filter(({ entry }) => entry.cwd && areasLib.relInArea(areasLib.relOfCwd(entry.cwd), rel));
    const last = scoped.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
    let areaMemory = null;
    try {
      const m = JSON.parse(await fsp.readFile(areaMemoryPaths(project, rel).manifest, 'utf8'));
      areaMemory = { builtAt: m.builtAt, stale: m.sourceHash !== projectSourceHash({ entries: scoped }) };
    } catch {}
    areas.push({
      rel, title: rec.title || null, createdAt: rec.createdAt || 0,
      conversations: scoped.length, lastTs: last ? new Date(last).toISOString() : null, memory: areaMemory,
    });
  }
  areas.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')) || a.rel.localeCompare(b.rel));
  const memory = await projectMemoryInfo(project, meta);
  const backfill = memoryBackfillJobs.get(project);
  const docsJob = memoryDocsJobs.get(project);
  const explicitDefault = projectDefaultModel(project);
  return {
    project, cwd, conversations: entries.length, notes, epics: projectEpics, memory, areas,
    title: (projectTitles[project] && projectTitles[project].title) || null,
    created: !!meta.created,
    defaultModel: explicitDefault,
    resolvedDefaultModel: resolvedProjectDefaultModel(project),
    latestTs: latestMs ? new Date(latestMs).toISOString() : null,
    freshness: {
      freshNotes, staleNotes: notes - freshNotes, missingNotes: entries.length - notes,
      freshEvidence, staleEvidence: evidenceCards - freshEvidence, missingEvidence: entries.length - evidenceCards,
    },
    recent,
    pyramid: {
      leaves,
      docs: memory && memory.pyramid ? { builtAt: memory.pyramid.builtAt, stale: memory.stale } : null,
      backfillRunning: !!(backfill && !backfill.finished),
      docsRunning: !!(docsJob && !docsJob.finished),
    },
    agents: ['pi', 'claude'],
  };
}

// "Create project" is directory-first: the folder IS the project. The
// registry entry only keeps it visible until the first conversation lands.
async function createProject(body) {
  const rawName = String(body.name || '').trim();
  if (!rawName) throw new Error('project name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/.test(rawName)) throw new Error('project name: letters, digits, ". _ -" and spaces only');
  const dirName = rawName.replace(/\s+/g, '-');
  const parent = path.resolve(expandHomePath(String(body.parent || '').trim() || '~/Projects'));
  const cwd = path.join(parent, dirName);
  const raw = foldsLib.rawProjectOf(cwd);
  const project = canonicalProjectName(raw);
  if (projectMetaFor(project)) throw new Error(`project "${project}" already exists`);
  const adopted = fs.existsSync(cwd);
  await fsp.mkdir(cwd, { recursive: true });
  if (body.git !== false && !fs.existsSync(path.join(cwd, '.git'))) {
    try { await gitText(cwd, ['init']); } catch {} // git is optional
  }
  createdProjects[raw] = { cwd, createdAt: Date.now(), ...(adopted ? { adopted: true } : {}) };
  saveCreatedProjects();
  // Human-written intent seeds intent.md before turn one. Human origin means
  // vouched: the trust ledger records it, so no [unverified] label.
  const intent = String(body.intent || '').trim();
  let intentPath = null;
  if (intent) {
    const paths = projectMemoryPaths(project);
    await fsp.mkdir(paths.dir, { recursive: true });
    const text = `# ${project} \u2014 intent\n\nWritten by the user at project creation (${new Date().toISOString().slice(0, 10)}).\n\n${intent}\n`;
    await fsp.writeFile(paths.intent, text);
    await vouchApply({ path: paths.intent, text, source: 'project-create', note: 'human-written intent at project creation' });
    intentPath = paths.intent;
  }
  let started = null;
  const firstPrompt = String(body.firstPrompt || '').trim();
  if (firstPrompt) {
    started = await startProjectConversation({
      project, agent: body.agent === 'claude' ? 'claude' : 'pi',
      mode: body.mode || null, models: Array.isArray(body.models) ? body.models : [],
      surface: body.surface || 'rpc',
      include: { map: false }, // no memory exists yet; nothing to brief
      context: intent
        ? `# Project: ${project}\n\n- Project root: ${cwd}\n- Born today \u2014 no conversations, no commits yet.\n\n## Intent (human-written at creation, vouched)\n\n${intent}`
        : null,
      kickoffText: firstPrompt, name: '',
    });
  }
  return { ok: true, project, cwd, adopted, intentPath, started };
}

function unregisterProject(name) {
  const target = String(name || '');
  let removed = false;
  for (const key of Object.keys(createdProjects)) {
    if (key === target || canonicalProjectName(key) === target) { delete createdProjects[key]; removed = true; }
  }
  if (removed) saveCreatedProjects();
  return { ok: true, removed }; // the folder stays; disk is truth
}

// "Create area" mirrors the project birth ritual, one level down: a folder
// inside the project root, an optional vouched intent seed, and an optional
// first prompt that starts the first conversation in that folder.
async function createArea(body) {
  const project = canonicalProjectName(String(body.project || '').trim());
  if (!project || project === '?' || project === LOOSE_PROJECT) throw new Error('areas need a real project');
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  if (!meta.cwd || !fs.existsSync(meta.cwd)) throw new Error('the project folder is missing: ' + (meta.cwd || '(unknown)'));
  const rel = areasLib.normalizeAreaRel(body.rel || body.name || '');
  if (!rel) throw new Error('area path: a relative folder — letters, digits, ". _ -", spaces, and "/" only');
  if (rel in declaredAreasFor(project)) throw new Error(`area "${rel}" already exists`);
  const cwd = path.join(meta.cwd, rel);
  const adopted = fs.existsSync(cwd);
  await fsp.mkdir(cwd, { recursive: true });
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!areaStore[project]) areaStore[project] = {};
  areaStore[project][rel] = { createdAt: Date.now(), ...(title ? { title } : {}) };
  saveAreaStore();
  // Human-written intent seeds the area's intent.md before turn one. Human
  // origin means vouched: no [unverified] label, ever.
  const intent = String(body.intent || '').trim();
  let intentPath = null;
  if (intent) {
    const paths = areaMemoryPaths(project, rel);
    await fsp.mkdir(paths.dir, { recursive: true });
    const text = `# ${project}/${rel} \u2014 intent\n\nWritten by the user at area creation (${new Date().toISOString().slice(0, 10)}).\n\n${intent}\n`;
    await fsp.writeFile(paths.intent, text);
    await vouchApply({ path: paths.intent, text, source: 'area-create', note: 'human-written intent at area creation' });
    intentPath = paths.intent;
  }
  let started = null;
  const firstPrompt = String(body.firstPrompt || '').trim();
  if (firstPrompt) {
    started = await startProjectConversation({
      project, area: rel, agent: body.agent === 'claude' ? 'claude' : 'pi',
      mode: body.mode || null, models: Array.isArray(body.models) ? body.models : [],
      surface: body.surface || 'rpc',
      include: { map: false }, // no area memory exists yet; nothing to brief
      context: `# Project: ${project} \u2014 area: ${rel}\n\n- Area folder: ${cwd}\n- Born today \u2014 a declared inner scope of the project.` +
        (intent ? `\n\n## Area intent (human-written at creation, vouched)\n\n${intent}` : ''),
      kickoffText: firstPrompt, name: '',
    });
  }
  // Reuse the folds channel: the client refetches /api/project-folds (which
  // carries the area map) and repaints without navigating.
  broadcast({ type: 'project-folds' });
  return { ok: true, project, rel, cwd, adopted, intentPath, started };
}

function removeArea(rawProject, rawRel) {
  const project = canonicalProjectName(String(rawProject || '').trim());
  const rel = areasLib.normalizeAreaRel(rawRel || '');
  let removed = false;
  for (const [name, areas] of Object.entries(areaStore)) {
    if (name !== project && canonicalProjectName(name) !== project) continue;
    if (areas && rel in areas) {
      delete areas[rel];
      if (!Object.keys(areas).length) delete areaStore[name];
      removed = true;
    }
  }
  if (removed) { saveAreaStore(); broadcast({ type: 'project-folds' }); }
  return { ok: true, removed }; // folder and conversations stay; only the scope goes
}

// The area view payload: the project view shape, scoped to one area.
async function areaResponse(rawProject, rawRel) {
  const project = canonicalProjectName(String(rawProject || '').trim());
  const rel = areasLib.normalizeAreaRel(rawRel || '');
  const am = areaMetaFor(project, rel);
  if (!am) throw new Error('area not found');
  const now = Date.now();
  const sorted = [...am.entries].sort((a, b) => Date.parse(b.entry.lastTs || '') - Date.parse(a.entry.lastTs || ''));
  const recent = sorted.slice(0, 40).map(({ key, entry }) => ({
    key, title: entry.timelineTitle || entry.title || key, source: entry.source || 'claude',
    cwd: entry.cwd || null, firstTs: entry.firstTs || null, lastTs: entry.lastTs || null,
    mtimeMs: entry.mtimeMs || 0, active: !!(entry.mtimeMs && now - entry.mtimeMs < 5 * 60 * 1000),
    notePath: entry.notePath || null,
  }));
  const paths = areaMemoryPaths(project, rel);
  let memory = null;
  try {
    const m = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    memory = {
      builtAt: m.builtAt, stale: m.sourceHash !== projectSourceHash({ entries: am.entries }),
      overview: m.overview || {}, coreIntent: m.coreIntent || null, paths: m.paths || {},
    };
  } catch {}
  const docs = {};
  for (const kind of MEMORY_DOC_KINDS) docs[kind] = fs.existsSync(paths[kind]);
  const latest = am.entries.reduce((max, { entry }) => Math.max(max, Date.parse(entry.lastTs || '') || 0), 0);
  const docsJob = memoryDocsJobs.get('area:' + project + '\0' + rel);
  return {
    project, rel, title: am.record.title || null, cwd: am.cwd,
    conversations: am.entries.length, recent, memory, docs,
    latestTs: latest ? new Date(latest).toISOString() : null,
    docsRunning: !!(docsJob && !docsJob.finished),
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

  // Narrow before wide: when the conversation starts inside a declared area,
  // its own memory documents come first.
  const briefAreaRel = typeof include.area === 'string' && include.area ? include.area : null;
  if (briefAreaRel) {
    const ap = areaMemoryPaths(project, briefAreaRel);
    lines.push('', `## Area memory: ${briefAreaRel} (this conversation's inner scope — read these first)`);
    if (fs.existsSync(ap.manifest)) {
      lines.push(`- Area overview: ${ap.overview}`);
      lines.push(`- Area intent: ${ap.intent}`);
      lines.push(`- Area environment: ${ap.environment}`);
      lines.push(`- Area todo and current work: ${ap.status}`);
    } else if (fs.existsSync(ap.intent)) {
      lines.push(`- Area intent: ${ap.intent}`);
    } else {
      lines.push('- No area memory documents yet.');
    }
  }

  lines.push('', '## Recent conversations');
  for (const r of info.recent) {
    lines.push(`- ${r.lastTs ? r.lastTs.slice(0, 10) : '?'} · ${r.title}` +
      (r.notePath ? ` · note: ${r.notePath}${r.note === 'stale' ? ' (stale: the conversation grew after distillation)' : ''}` : ''));
  }

  const wantMap = include.map !== false;
  const projectMemory = wantMap ? await projectMemoryInfo(project, meta) : null;
  if (projectMemory) {
    lines.push('', `## Project memory${projectMemory.stale ? ' (stale: new project activity exists)' : ''}`);
    lines.push('Read these first. They separate durable intent, project setup, and current work:');
    lines.push(`- High-level overview: ${projectMemory.paths.overview}`);
    lines.push(`- Deep user intent: ${projectMemory.paths.intent}`);
    lines.push(`- Development environment: ${projectMemory.paths.environment}`);
    lines.push(`- Todo, unfinished work, and recent focus: ${projectMemory.paths.status}`);
  }

  const wantedEpics = Array.isArray(include.epics) ? include.epics.filter(id => epics[id]) : [];
  if (wantedEpics.length) {
    lines.push('', '## Epics to read (cross-session narratives)');
    for (const id of wantedEpics) {
      const epic = epics[id];
      lines.push(`### ${epic.title || id}`);
      lines.push(`- File: ${epicPathFor(id)} ${trustLabel(epicPathFor(id))}`);
      if (epic.abstract) lines.push(`- Abstract: ${epic.abstract}`);
    }
  } else if (info.epics.length) {
    lines.push('', '## Epics (read on demand)');
    for (const epic of info.epics.slice(0, 6)) lines.push(`- ${epic.title} · ${epicPathFor(epic.id)} ${trustLabel(epicPathFor(epic.id))}`);
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

function includeFlag(include, name) {
  return !!(include && include[name]);
}

// ---- pi prompt modes (ModeDef JSON in ~/.pi/agent/modes) ----
// The modes extension (modes.ts in ~/.pi/agent/extensions) owns mode
// semantics: opener/appendix ride on the base system prompt, systemPrompt
// replaces it, removeSections drops named sections, tools replaces the tool
// set. aiconvo only reads and writes the same JSON files with the same
// validation, so the TUI and this UI stay one source of truth.
const MODES_DIR = path.join(os.homedir(), '.pi', 'agent', 'modes');
const MODE_SECTIONS = ['available_tools', 'custom_tools_note', 'guidelines', 'pi_docs', 'append_prompt', 'project_context', 'skills', 'date', 'cwd'];
const BUILTIN_MODES = [
  { key: 'coding', label: 'Coding', appendix: 'Focus on concise, practical coding help.' },
  { key: 'plan', label: 'Plan', opener: 'Make a concise implementation plan before changing files.', appendix: 'Do not edit files unless the user asks you to proceed.' },
  { key: 'review', label: 'Review', opener: 'Review the current work for correctness, risks, and missing tests.' },
  { key: 'explain', label: 'Explain', opener: 'Explain the relevant code and decisions clearly before proposing changes.' },
];

function validateModeDef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected a JSON object' };
  const allowed = new Set(['key', 'label', 'opener', 'appendix', 'systemPrompt', 'removeSections', 'tools']);
  const unknown = Object.keys(raw).filter(k => !allowed.has(k));
  if (unknown.length) return { error: 'unknown field' + (unknown.length === 1 ? '' : 's') + ': ' + unknown.join(', ') };
  const key = String(raw.key ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) return { error: 'key must match ^[a-z][a-z0-9_-]*$' };
  const label = String(raw.label ?? '').trim();
  if (!label) return { error: 'label must be a non-empty string' };
  for (const f of ['opener', 'appendix', 'systemPrompt']) {
    if (raw[f] !== undefined && typeof raw[f] !== 'string') return { error: f + ' must be a string' };
  }
  if (raw.removeSections !== undefined) {
    if (!Array.isArray(raw.removeSections) || raw.removeSections.some(s => !MODE_SECTIONS.includes(s))) {
      return { error: 'removeSections must contain only: ' + MODE_SECTIONS.join(', ') };
    }
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.some(t => typeof t !== 'string' || !t.trim())) {
      return { error: 'tools must be an array of non-empty strings' };
    }
  }
  const opener = String(raw.opener ?? '').trim();
  const appendix = String(raw.appendix ?? '').trim();
  const systemPrompt = String(raw.systemPrompt ?? '').trim();
  if (!opener && !appendix && !systemPrompt) return { error: 'at least one of opener, appendix, or systemPrompt must be non-empty' };
  const mode = { key, label };
  if (opener) mode.opener = opener;
  if (appendix) mode.appendix = appendix;
  if (systemPrompt) mode.systemPrompt = systemPrompt;
  if (Array.isArray(raw.removeSections) && raw.removeSections.length) mode.removeSections = [...raw.removeSections];
  if (raw.tools !== undefined) mode.tools = [...new Set(raw.tools.map(t => String(t).trim()))];
  return { mode };
}

function listPromptModes() {
  const byKey = new Map(BUILTIN_MODES.map(m => [m.key, { ...m, builtin: true, custom: false }]));
  try {
    if (fs.existsSync(MODES_DIR)) for (const file of fs.readdirSync(MODES_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const def = validateModeDef(JSON.parse(fs.readFileSync(path.join(MODES_DIR, file), 'utf8')));
        if (!def.mode) continue;
        const prev = byKey.get(def.mode.key);
        byKey.set(def.mode.key, { ...def.mode, builtin: !!prev?.builtin, custom: true });
      } catch {}
    }
  } catch {}
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// The injected context bundle. Unlike the briefing map (paths only), every
// included artifact is INLINED: the agent starts with the full memory in its
// system prompt (--append-system-prompt) and spends zero turns fetching.
async function buildProjectContextBundle(project, include, focusName) {
  const info = await projectResponse(project);
  const meta = projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  const parts = [];
  parts.push(`# aiconvo project context: ${project}`);
  parts.push('');
  parts.push(`- Generated: ${new Date().toISOString()}`);
  parts.push(`- Project root: ${info.cwd || '(unknown)'}`);
  parts.push(`- On record: ${info.conversations} conversations · ${info.notes} distilled notes (${info.freshness.freshNotes} fresh) · ${info.epics.length} epics`);
  if (typeof include.area === 'string' && include.area) parts.push(`- Working area (inner scope): ${include.area} — the conversation runs inside this subfolder`);
  if (focusName) parts.push(`- Focus for this new conversation: ${focusName}`);
  parts.push('');
  parts.push('Injected by aiconvo at conversation start. This is AI-generated work memory — a map, not verified truth. Items labeled [unverified] were never human-reviewed.');

  let docCount = 0;
  // Narrow before wide: area memory (when the start targets a declared area)
  // rides in front of the project memory.
  const ctxAreaRel = typeof include.area === 'string' && include.area ? include.area : null;
  if (ctxAreaRel && include.map !== false) {
    const blocks = [];
    for (const kind of MEMORY_DOC_KINDS) {
      try {
        const doc = await areaMemoryDocument(project, ctxAreaRel, kind);
        blocks.push(`### area ${kind} · ${doc.path} ${trustLabel(doc.path)}\n\n${doc.text.trim()}`);
        docCount++;
      } catch {}
    }
    if (blocks.length) {
      parts.push('', `## Area memory: ${ctxAreaRel} (this conversation's inner scope — narrowest first)`, '', blocks.join('\n\n---\n\n'));
    }
  }
  if (include.map !== false) {
    const docs = [];
    for (const kind of ['overview', 'intent', 'environment', 'status']) {
      try {
        const doc = await projectMemoryDocument(project, kind);
        docs.push(`### ${kind} · ${doc.path} ${trustLabel(doc.path)}\n\n${doc.text.trim()}`);
        docCount++;
      } catch {}
    }
    if (docs.length) {
      parts.push('', '## Project memory (read first — durable intent, setup facts, current work)', '', docs.join('\n\n---\n\n'));
    }
  }

  const wantedEpics = Array.isArray(include.epics) ? include.epics.filter(id => epics[id]) : [];
  if (wantedEpics.length) {
    const blocks = [];
    for (const id of wantedEpics.slice(0, 6)) {
      const epic = epics[id];
      const file = epicPathFor(id);
      let body = epic.abstract || '';
      try { body = (await fsp.readFile(file, 'utf8')).trim(); } catch {}
      blocks.push(`### ${epic.title || id} · ${file} ${trustLabel(file)}\n\n${body}`);
    }
    parts.push('', '## Epics (cross-session narratives)', '', blocks.join('\n\n---\n\n'));
  }

  // Starting from an epic: its own four memory documents ride along, so the
  // new agent gets the epic map in addition to the project map.
  if (include.epicMemory && epics[include.epicMemory]) {
    const blocks = [];
    for (const kind of ['overview', 'intent', 'environment', 'status']) {
      try {
        const doc = await epicMemoryDocument(include.epicMemory, kind);
        blocks.push(`### epic ${kind} · ${doc.path} ${trustLabel(doc.path)}\n\n${doc.text.trim()}`);
      } catch {}
    }
    if (blocks.length) {
      parts.push('', `## Epic memory: ${epics[include.epicMemory].title || include.epicMemory}`, '', blocks.join('\n\n---\n\n'));
    }
  }

  let noteCount = 0;
  if (includeFlag(include, 'notes')) {
    const blocks = [];
    for (const { entry } of meta.entries) {
      if (!entry.notePath) continue;
      if (entry.mtimeMs && entry.notedAt && entry.mtimeMs > entry.notedAt) continue; // stale
      try {
        const text = (await fsp.readFile(entry.notePath, 'utf8')).trim();
        blocks.push(`### ${path.basename(entry.notePath)} · ${entry.notePath} ${trustLabel(entry.notePath)}\n\n${text}`);
        noteCount++;
      } catch {}
    }
    parts.push('', `## Fresh distilled notes (${noteCount})`, '', blocks.length ? blocks.join('\n\n---\n\n') : '(none yet)');
  }

  let evidenceCount = 0;
  if (Array.isArray(include.evidenceKeys) && include.evidenceKeys.length) {
    const blocks = [];
    for (const key of include.evidenceKeys.slice(0, 20)) {
      const entry = index[key];
      if (!entry) continue;
      const latest = latestCachedEvidenceForKey(key);
      const head = `### ${entry.timelineTitle || entry.title || key}${entry.notePath ? ` · note: ${entry.notePath}` : ''}`;
      blocks.push(head + (latest && latest.cached.text ? `\n\n${latest.cached.text.trim()}` : ''));
      evidenceCount++;
    }
    parts.push('', '## Selected conversation evidence', '', blocks.join('\n\n---\n\n'));
  }

  const text = parts.join('\n') + '\n';
  return {
    text,
    bytes: Buffer.byteLength(text),
    tokens: estimateInputTokens(text),
    counts: { memoryDocs: docCount, epics: wantedEpics.length, notes: noteCount, evidence: evidenceCount },
  };
}

// Mid-conversation @ attachments. Map sections and conversation chat
// (user + assistant only) are inlined onto --append-system-prompt.
const ATTACH_CHAT_TOKEN_BUDGET = 12000;
function exchangeAround(messages, i) {
  const all = Array.isArray(messages) ? messages : [];
  if (i < 0 || i >= all.length) return [];
  let start = i;
  while (start > 0 && all[start].role !== 'user') start--;
  if (all[start].role !== 'user') {
    const m = all[i];
    return (m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim()) ? [m] : [];
  }
  const out = [all[start]];
  for (let j = start + 1; j < all.length; j++) {
    const m = all[j];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && String(m.text || '').trim()) out.push(m);
  }
  return out;
}
function newestChatWithinBudget(chat, tokenBudget) {
  const kept = [];
  let tokens = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const n = estimateInputTokens(chat[i].text || '');
    if (kept.length && tokens + n > tokenBudget) break;
    kept.push(chat[i]);
    tokens += n;
  }
  return kept.reverse();
}
function formatAttachedChat(entry, key, picked) {
  const title = entry.timelineTitle || entry.title || key;
  const lines = [
    '### conversation · ' + title,
    '- Session: `' + key + '`',
    '- Project: ' + (projectNameOf(entry.cwd, key) || '?'),
    '- Path: `' + (absPathForKey(key) || '?') + '`',
    '',
  ];
  for (const m of picked) {
    lines.push(m.role === 'user' ? '#### User' : '#### Assistant');
    lines.push('');
    lines.push(String(m.text || '').trim());
    lines.push('');
  }
  return { title, text: lines.join('\n') };
}
async function loadAttachedChat(item) {
  const key = item.key;
  const entry = index[key];
  if (!entry) throw new Error('conversation not found');
  const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  const messages = data.messages || [];
  let picked;
  if (Number.isInteger(item.i)) {
    picked = exchangeAround(messages, item.i).filter(m =>
      (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim());
  } else {
    const chat = messages.filter(m =>
      (m.role === 'user' || m.role === 'assistant') &&
      String(m.text || '').trim() &&
      !m.off &&
      !(m.role === 'user' && (isBootstrapMessage(m.text) || isNoise(m.text))));
    picked = newestChatWithinBudget(chat, ATTACH_CHAT_TOKEN_BUDGET);
  }
  if (!picked.length) throw new Error('no user or assistant text in that conversation');
  return formatAttachedChat(entry, key, picked);
}
async function writeAttachedContextFile(items) {
  const normalized = normalizeContextItems(items);
  const maps = normalized.filter(i => i.type !== 'chat');
  const chats = normalized.filter(i => i.type === 'chat');
  const chatByKey = new Map();
  for (const c of chats) {
    const prev = chatByKey.get(c.key);
    if (!prev || c.i == null) chatByKey.set(c.key, c);
  }
  const parts = [];
  parts.push('# aiconvo attached context');
  parts.push('');
  parts.push('- Generated: ' + new Date().toISOString());
  parts.push('');
  parts.push('Added by the user for this conversation. Project memory is AI-generated — a map, not verified truth. Conversation excerpts are the original user and assistant messages.');
  let docCount = 0;
  const seen = new Set();
  const byProject = new Map();
  for (const item of maps) {
    const kinds = item.kind === 'map' ? MEMORY_DOC_KINDS : [item.kind];
    for (const kind of kinds) {
      const id = item.project + '\0' + kind;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const doc = await projectMemoryDocument(item.project, kind);
        if (!byProject.has(item.project)) byProject.set(item.project, []);
        byProject.get(item.project).push('### ' + item.project + ' · ' + kind + ' · ' + doc.path + ' ' + trustLabel(doc.path) + '\n\n' + doc.text.trim());
        docCount++;
      } catch {}
    }
  }
  for (const [project, docs] of byProject) {
    parts.push('', '## ' + project, '', docs.join('\n\n---\n\n'));
  }
  let chatCount = 0;
  const chatBlocks = [];
  for (const item of chatByKey.values()) {
    try {
      const block = await loadAttachedChat(item);
      chatBlocks.push(block.text);
      chatCount++;
    } catch {}
  }
  if (chatBlocks.length) {
    parts.push('', '## Attached conversations (user and assistant only)', '', chatBlocks.join('\n\n---\n\n'));
  }
  if (!docCount && !chatCount) throw new Error('none of those context items exist yet');
  const text = parts.join('\n') + '\n';
  const file = path.join(BRIEFINGS_DIR,
    new Date().toISOString().replace(/[:.]/g, '-') + '-attached-context.md');
  await fsp.writeFile(file, text);
  return { file, text, tokens: estimateInputTokens(text), docs: docCount, chats: chatCount };
}

// Wait for the session file the just-spawned agent creates. `existing` is a
// snapshot of index keys taken before the spawn: only a key that was not in
// the index before counts. Without that guard, any busy conversation in the
// same cwd has the newest mtime and gets stolen as the "new" conversation,
// which later binds the window to the wrong session and forks it on send.
async function waitForNewConversation(kind, cwd, sinceMs, existing, timeoutMs = 20000) {
  const source = kind === 'claude' ? 'claude' : 'pi';
  let want = null;
  try { want = path.resolve(cwd); } catch { want = cwd; }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let best = null, bestM = 0;
    for (const [key, e] of Object.entries(index)) {
      if (!e || e.source !== source) continue;
      if (existing && existing.has(key)) continue;
      if (!e.mtimeMs || e.mtimeMs + 2000 < sinceMs) continue;
      if (!e.cwd) continue;
      let got = e.cwd;
      try { got = path.resolve(e.cwd); } catch {}
      if (got !== want) continue;
      if (e.mtimeMs >= bestM) { best = key; bestM = e.mtimeMs; }
    }
    if (best) return best;
    await sleep(400);
  }
  return null;
}

async function startProjectConversation(options) {
  // A loose conversation is deliberately rooted at the user's home. It has
  // no project registry entry, project model, memory, briefing, or Git root.
  // Keep this path in the same session lifecycle as project starts so blank
  // SDK sessions persist and open in the web composer in exactly one way.
  const projectless = options.projectless === true;
  const project = projectless ? LOOSE_PROJECT : options.project;
  const meta = projectless ? { cwd: os.homedir() } : projectMetaFor(project);
  if (!meta) throw new Error('project not found');
  // The "where" of a project start. Never fall back to home in silence: a
  // conversation rooted at home would index as Loose, not as the project.
  let cwd = os.homedir();
  let areaRel = null;
  if (!projectless) {
    if (!meta.cwd || !fs.existsSync(meta.cwd)) {
      throw new Error(`the project folder is missing: ${meta.cwd || '(unknown)'} — re-create or adopt it first`);
    }
    cwd = meta.cwd;
    // options.area: a declared area — identity + scope (memory, briefing order).
    // options.cwd: a plain subfolder — scope only, no identity.
    if (options.area) {
      areaRel = areasLib.normalizeAreaRel(options.area);
      if (!areaRel) throw new Error('bad area path');
      if (!(areaRel in declaredAreasFor(project))) throw new Error('unknown area: ' + areaRel);
      cwd = path.join(meta.cwd, areaRel);
      await fsp.mkdir(cwd, { recursive: true }); // the folder is the scope; restore it if it vanished
    } else if (options.cwd) {
      const subRel = areasLib.normalizeAreaRel(options.cwd);
      if (!subRel) throw new Error('bad subfolder path — give a relative path inside the project');
      cwd = path.join(meta.cwd, subRel);
      if (!fs.existsSync(cwd)) throw new Error('subfolder not found: ' + subRel);
      areaRel = areaOfCwdIn(project, cwd); // an undeclared subfolder may still sit inside a declared area
    }
  }
  const kind = options.agent === 'claude' ? 'claude' : 'pi';
  const label = String(options.name || (projectless ? 'Loose conversation' : 'Project: ' + project)).slice(0, 80);
  const name = 'aiconvo-' + (projectless ? 'loose-' : 'project-') + crypto.createHash('sha256').update(project + ':' + Date.now() + ':' + kind).digest('hex').slice(0, 12);
  const mode = kind === 'pi' && typeof options.mode === 'string' && options.mode.trim() ? options.mode.trim() : null;
  // Lead model for the kickoff run; any further models stay in the project's
  // composer strip for later fan-out sends.
  const requestedModels = normalizePickedModels(options.models);
  const inheritedModel = kind === 'pi' && !projectless ? resolvedProjectDefaultModel(project) : null;
  const launchModels = requestedModels.length
    ? requestedModels
    : inheritedModel ? [{ provider: inheritedModel.provider, modelId: inheritedModel.modelId }] : [];
  const leadModel = kind === 'pi' ? (launchModels[0] || null) : null;
  const include = { ...(options.include || {}) };
  if (areaRel) include.area = areaRel; // briefing and context go narrow-first
  // Inline-context path (pi only): the user composed and approved the bundle
  // in the UI. It rides in the system prompt via --append-system-prompt, so
  // the agent spends zero fetch turns. Claude has no equivalent through our
  // spawn path and keeps the briefing-map behavior below.
  let contextFile = null;
  if (kind === 'pi' && typeof options.context === 'string' && options.context.trim()) {
    contextFile = path.join(BRIEFINGS_DIR,
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + String(project).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) + '-context.md');
    await fsp.writeFile(contextFile, options.context.trim() + '\n');
  }
  const wantMap = include.map !== false;
  const wantNotes = includeFlag(include, 'notes');
  const wantEpics = Array.isArray(include.epics) && include.epics.length;
  const wantEvidence = Array.isArray(include.evidenceKeys) && include.evidenceKeys.length;
  const wantBriefing = !contextFile && (wantMap || wantNotes || wantEpics || wantEvidence);
  let briefing = null;
  // A creation kickoff carries the user's real first prompt; nothing rewrites it.
  const kickoffText = typeof options.kickoffText === 'string' ? options.kickoffText.trim() : '';
  let text = kickoffText || String(options.name || '').trim();
  if (options.silent) {
    // Silent start: the context rides in the system prompt, but no first
    // message goes out — the new conversation opens as an empty composer.
    text = '';
  } else if (kickoffText) {
    // The seed context (if any) already rides in the system prompt.
  } else if (contextFile) {
    // The context is already in the system prompt: the first user message
    // stays small and real, so it never pollutes the transcript.
    const focus = options.name ? ` Today's focus: "${options.name}".` : '';
    text = `Your system prompt carries this project's work memory.` + focus +
      ' Reply with at most 3 lines on where the project stands, then wait for instructions.';
  } else if (wantBriefing) {
    briefing = await buildProjectBriefing(project, include, options.name || '');
    const focus = options.name ? ` Today's focus: "${options.name}".` : '';
    const memory = wantMap ? await projectMemoryInfo(project, meta) : null;
    const first = memory ? ' Read every file listed under "Project memory" first.' : '';
    const reading = wantNotes
      ? ' Read every file listed under "Fresh distilled notes".'
      : (wantMap ? ' Read the other files you need.' : '');
    text = `Read ${briefing} — it maps this project's work memory (notes, epics, evidence) with full file paths.${first}${reading}${focus}` +
      ' Then reply with at most 3 lines on where the project stands, and wait for instructions.';
  }
  // pi flags that carry the mode and the injected context. Both RPC warm
  // starts and alacritty spawns get them; the modes extension composes
  // --prompt-mode with --append-system-prompt.
  const piCtxArgs = [
    ...(mode ? ['--prompt-mode', mode] : []),
    ...(contextFile ? ['--append-system-prompt', contextFile] : []),
  ];
  const argv = kind === 'claude'
    ? (text ? [claudeBin(), text] : [claudeBin()])
    : [piBin(), '--name', label, ...piProviderExtraArgs(), ...piCtxArgs,
       ...(leadModel ? ['--provider', leadModel.provider, '--model', leadModel.modelId] : []),
       ...(text ? [text] : [])];
  const useRpc = kind === 'pi' && options.surface !== 'alacritty';
  let key = null;
  if (useRpc) {
    const begun = await piEng().piBeginWarm({ cwd, env: agentEnv(), extraArgs: ['--name', label, ...piProviderExtraArgs(), ...piCtxArgs] });
    // Pi reports sessionFile before it writes. The first prompt creates the file.
    const job = {
      id: 'run:' + crypto.randomUUID().slice(0, 8),
      type: 'agent-run', key: null,
      title: (leadModel ? leadModel.modelId + ' · ' : '') + (text || label).replace(/\s+/g, ' ').slice(0, 60),
      status: 'running', statusText: text ? 'starting' : 'ready',
      startedAt: Date.now(), model: leadModel ? leadModel.provider + '/' + leadModel.modelId : null,
    };
    let handle = null;
    if (text) {
      handle = piEng().piHeadlessRun({ sessionPath: begun.file, cwd, env: agentEnv(), extraArgs: [...piProviderExtraArgs(), ...piCtxArgs] }, {
        provider: leadModel && leadModel.provider, modelId: leadModel && leadModel.modelId,
        message: text, onEvent: runEventForwarder(job),
      });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { await fsp.stat(begun.file); break; } catch {}
      await sleep(50);
    }
    try { await fsp.stat(begun.file); }
    catch {
      stopAnyWarmSession(begun.file);
      endLiveRunTail(job.id);
      throw new Error('pi did not write the session file');
    }
    key = await indexNewSessionFile(begun.file);
    job.key = key;
    if (handle) {
      agentRunJobs.set(job.id, job);
      jobChanged(job);
      const record = { jobId: job.id, key, startedAt: job.startedAt, model: job.model, handle, yielded: null };
      headlessRuns.set(begun.file, record);
      const entry = index[key];
      handle.done.then(async result => {
        headlessRuns.delete(begun.file);
        job.uiRequests = [];
        if (record.yielded) { job.status = 'done'; job.statusText = 'stopped — ' + record.yielded; }
        else if (job.errorMessage) { job.status = 'error'; job.statusText = job.errorMessage; job.error = job.errorMessage; }
        else if (handle.uiAutoCancelled) { job.status = 'done'; job.statusText = 'settled · ' + handle.uiAutoCancelled + ' unanswered dialog(s) cancelled'; }
        else { job.status = 'done'; job.statusText = 'settled'; }
        job.finishedAt = Date.now();
        try { await indexFile(entry.source, key.slice(entry.source.length + 1), await fsp.stat(begun.file)); } catch {}
        if (job.status === 'done' && !record.yielded) job.doneSpeechSource = job.lastAssistantText || '';
        endLiveRunTail(job.id);
        jobChanged(job);
        broadcast({ type: 'run-event', jobId: job.id, key, status: job.status, statusText: job.statusText, model: job.model,
          fanoutId: job.fanoutId, fanoutRootKey: job.fanoutRootKey, fanoutNode: job.fanoutNode,
          fanoutIndex: job.fanoutIndex, fanoutCount: job.fanoutCount, final: true });
        speakRunDone(job);
      }).catch(async e => {
        headlessRuns.delete(begun.file);
        job.status = 'error'; job.statusText = e.message; job.error = e.message; job.finishedAt = Date.now();
        endLiveRunTail(job.id);
        jobChanged(job);
        broadcast({ type: 'run-event', jobId: job.id, key, status: job.status, statusText: job.statusText, model: job.model,
          fanoutId: job.fanoutId, fanoutRootKey: job.fanoutRootKey, fanoutNode: job.fanoutNode,
          fanoutIndex: job.fanoutIndex, fanoutCount: job.fanoutCount, final: true });
      });
    }
    if (key && launchModels.length) saveConversationModels(key, launchModels);
    return {
      name, kind, cwd, title: name, key, surface: 'rpc',
      project, projectless, area: areaRel, include, briefing, kickoff: wantBriefing || !!contextFile,
      contextFile, mode, models: launchModels,
    };
  }
  const startedAt = Date.now();
  const existing = new Set(Object.keys(index));
  await spawnAlacritty(cwd, name, argv);
  key = await waitForNewConversation(kind, cwd, startedAt, existing);
  if (key) {
    recordLaunchedTitle(name, key);
    if (launchModels.length) saveConversationModels(key, launchModels);
  }
  return {
    name, kind, cwd, title: name, key, surface: 'alacritty',
    project, projectless, area: areaRel, include, briefing, kickoff: wantBriefing || !!contextFile,
    contextFile, mode, models: launchModels,
  };
}

// ---------- Kokoro TTS (family server, same stack as readerd) ----------
const TTS_DIR = path.join(CACHE_DIR, 'tts');
// Document cell runs in flight, keyed by client runId — the cancel
// endpoint interrupts the kernel and ends the matching subprocess.
const activeDocRuns = new Map();
const KOKORO_URL = process.env.KOKORO_URL || 'http://192.168.2.24:8880';
const SPEECH_URL = process.env.SPEECH_URL || 'http://192.168.2.24:8078';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'bm_george';
const REWRITE_URL = process.env.REWRITE_URL || 'http://192.168.2.24:8000/v1/chat/completions';
const REWRITE_MODEL = process.env.REWRITE_MODEL || 'qwen/qwen3.8-27b';
const REWRITE_API_KEY = process.env.REWRITE_API_KEY || 'inktype-local';
const ttsJobs = new Map();

const TTS_REWRITE_PROMPT = 'You are a text-to-speech preprocessor. Rewrite the text so it sounds natural when spoken. Spell out abbreviations and numbers. Skip code syntax and URLs. Output only the spoken script.';

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function httpJson(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Authorization: 'Bearer ' + REWRITE_API_KEY,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, json: null, raw }); }
      });
    });
    req.setTimeout(timeoutMs || 120000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

function httpRaw(urlStr, body, contentType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.setTimeout(timeoutMs || 180000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

function httpPcm(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.setTimeout(timeoutMs || 180000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(data);
  });
}

async function rewriteForSpeech(text) {
  const res = await httpJson(REWRITE_URL, {
    model: REWRITE_MODEL,
    messages: [
      { role: 'system', content: TTS_REWRITE_PROMPT },
      { role: 'user', content: text },
    ],
    max_tokens: 4096,
    chat_template_kwargs: { enable_thinking: false },
  }, 90000);
  const out = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
    && res.json.choices[0].message.content;
  return String(out || '').trim();
}

async function synthesizeSpeech(text, rewrite, speed = 1) {
  const src = String(text || '').trim();
  if (!src) throw new Error('No text to read.');
  const id = crypto.createHash('sha256').update((rewrite ? 'r1|' : 'r0|') + (speed !== 1 ? 's' + speed + '|' : '') + src).digest('hex').slice(0, 24);
  const wavPath = path.join(TTS_DIR, id + '.wav');
  const metaPath = path.join(TTS_DIR, id + '.json');
  if (fs.existsSync(wavPath)) {
    let meta = { id, cached: true };
    try { meta = { ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), cached: true }; } catch {}
    return { ...meta, id, url: '/api/tts/audio?id=' + id };
  }
  if (ttsJobs.has(id)) return ttsJobs.get(id);
  const job = (async () => {
    await fsp.mkdir(TTS_DIR, { recursive: true });
    let spoken = src;
    if (rewrite) {
      try {
        const rewritten = await rewriteForSpeech(src.slice(0, 12000));
        if (rewritten) spoken = rewritten;
      } catch (e) {
        console.log('tts rewrite failed: ' + e.message);
      }
    }
    const tts = await httpPcm(KOKORO_URL.replace(/\/$/, '') + '/tts', {
      text: spoken, voice: KOKORO_VOICE, speed,
    }, 180000);
    if (tts.status !== 200 || !tts.buf.length) {
      throw new Error('Kokoro TTS failed (' + tts.status + '). Is kokoro-tts running?');
    }
    const rate = Number(tts.headers['x-sample-rate'] || 24000);
    const wav = pcmToWav(tts.buf, rate);
    await fsp.writeFile(wavPath, wav);
    const meta = {
      id, chars: src.length, spokenChars: spoken.length, rewrite: !!rewrite,
      sampleRate: rate, bytes: wav.length, durationMs: Math.round(tts.buf.length / 2 / rate * 1000),
    };
    await fsp.writeFile(metaPath, JSON.stringify(meta));
    return { ...meta, cached: false, url: '/api/tts/audio?id=' + id };
  })();
  ttsJobs.set(id, job);
  try { return await job; }
  finally { ttsJobs.delete(id); }
}

// ---------- spoken completion ----------
// When a web run settles, tell the user in one spoken sentence what was just
// finished: last assistant message → Qwen (one-sentence summary) → Kokoro →
// local speakers through pipewire. Fire and forget; every failure is silent.
const SPEAK_SUMMARY_PROMPT = 'You are a voice announcer for a person who runs several coding-agent conversations. One conversation just returned a new reply. You get an OPENING line, the conversation title, and the full reply. Speak a short digest: start with the OPENING exactly as given, then say in two to four short sentences what there is to read in the reply — what it did, what it found, and what it asks or recommends, if anything. Talk about the reply in the third person ("it says", "it recommends"). Plain spoken words only: no code, no file paths, no markdown, no lists. Keep the whole thing under sixty words.';

// Spoken playback speed for announcements and confirmations.
const VOICE_SPEED = Number(process.env.AICONVO_VOICE_SPEED) || 1.5;

// Name the conversation only when it changes: back-to-back replies from the
// same conversation open with a short line instead of the full title.
function voiceOpeningFor(key, title) {
  const same = voice.lastAnnouncedKey === key;
  voice.lastAnnouncedKey = key;
  return same ? 'The same conversation has returned again.'
    : 'Your conversation about ' + title + ' has just returned.';
}

// Fallback announcement when the Qwen summarizer is unreachable: opening plus
// the first plain words of the reply.
function fallbackSpokenLine(text, opening) {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const head = plain.split(' ').slice(0, 25).join(' ').replace(/[,;:]+$/, '');
  return opening + (head ? ' It starts with: ' + head : '');
}

async function speakRunDone(job) {
  try {
    if (process.env.AICONVO_SPEAK_DONE === '0') return;
    if (job.fanoutId) return; // parallel runs would talk over each other
    const text = String(job.doneSpeechSource || '').trim();
    if (!text) return;
    const entry = job.key && index[job.key];
    const title = (entry && (entry.title || entry.timelineTitle) || '').trim() || 'an untitled task';
    const opening = voiceOpeningFor(job.key, title);
    let sentence = '';
    try {
      const res = await httpJson(REWRITE_URL, {
        model: REWRITE_MODEL,
        messages: [
          { role: 'system', content: SPEAK_SUMMARY_PROMPT },
          { role: 'user', content: 'OPENING: ' + opening + '\nTITLE: ' + title + '\n\nFull reply:\n' + text.slice(0, 16000) },
        ],
        max_tokens: 400,
        chat_template_kwargs: { enable_thinking: false },
      }, 45000);
      sentence = String(res.json && res.json.choices && res.json.choices[0]
        && res.json.choices[0].message && res.json.choices[0].message.content || '').trim();
    } catch (e) { console.log('speak-done summarizer unreachable, using fallback: ' + e.message); }
    if (!sentence) sentence = fallbackSpokenLine(text, opening);
    const clip = await synthesizeSpeech(sentence, false, VOICE_SPEED);
    enqueueAnnouncement({ job, title, wavPath: path.join(TTS_DIR, clip.id + '.wav') });
  } catch (e) { console.log('speak-done failed: ' + e.message); }
}

// ---------- voice loop ----------
// Announcements queue so they never talk over each other. After each one the
// microphone opens: a beep, then up to 10 s of waiting for speech. What the
// user says goes through STT, then a Qwen gate decides: a dictated reply for
// the conversation that just finished, an app command (mute, skip, status),
// or noise to ignore.
const voice = { queue: [], playing: false, mutedUntil: 0, lastAnnouncedKey: null, current: null, paused: false };
const voiceMuted = () => voice.mutedUntil && Date.now() < voice.mutedUntil;

const VOICE_GATE_PROMPT = 'You are a voice gate for a coding-agent app. The user just heard a spoken summary of an agent reply and the microphone opened. You get the full transcript captured so far; the user paused, and you must decide what to do. The user often thinks in silence between phrases, so an unfinished thought is normal. Answer STRICT JSON only, no prose, no code fence: {"action":"send|wait|command|ignore","command":"mute|skip|status|read|goto|none","target":"...","text":"..."}. Use "send" ONLY when the user clearly ended the message with a send word such as: send, done, go, submit, enter, control enter, ship it, that is all. Put the cleaned message in "text" with the trailing send word removed. Use "wait" when the user dictated something addressed to the agent but no send word ended it yet — they are still thinking; keep the microphone open. Use "command" for short standalone app commands: "mute" (also: stop, be quiet, shut up, pause notifications), "skip" (also: next, dismiss), "status" (also: what is running, what is done), "read" (read a reply aloud — matches: read it, read the reply, read me the last reply, what did it say; put any named conversation or project in "target", empty means the one that just spoke), "goto" (open something on screen — matches: go to, open, show me; put the named conversation or project in "target"). Use "ignore" ONLY when the transcript is clearly not addressed to the app: background noise, other people talking to each other, phone calls, or the user talking to someone else in the room. The topic does not matter — the user may ask the agent anything, including casual requests. The strongest signal that speech is addressed to the app is a trailing send word. A message that ends with a send word is a send even when the topic is casual. Transcription is imperfect: stray trailing words after the send word (like "complete" or "thank you") still count as a send. Examples: "can you tell me a joke? send" is send with text "can you tell me a joke?". "I will pick it up on the way home no worries" is ignore (talking to someone else, no send word). "refactor the queue and add tests, send" is send. "maybe we should split that function" is wait.';

// Small state tones. Each is a distinct earcon:
//   open  — rising two notes: the microphone is now listening
//   ack   — one short high tick: speech was captured, the gate is deciding
//   wait  — two quick high ticks: kept open, keep thinking or talking
//   close — falling two notes: the microphone closed, nothing was sent
const VOICE_TONES = {
  open: [[660, 90], [880, 120]],
  ack: [[988, 70]],
  wait: [[880, 60], [0, 50], [880, 60]],
  close: [[660, 90], [440, 150]],
};

function tonePath(name) {
  const p = path.join(TTS_DIR, 'tone-' + name + '.wav');
  if (!fs.existsSync(p)) {
    const rate = 24000;
    const parts = [];
    for (const [freq, ms] of VOICE_TONES[name]) {
      const n = Math.floor(rate * ms / 1000);
      const pcm = Buffer.alloc(n * 2);
      if (freq > 0) for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / (rate * 0.008), (n - i) / (rate * 0.03));
        pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000 * env), i * 2);
      }
      parts.push(pcm);
    }
    fs.mkdirSync(TTS_DIR, { recursive: true });
    fs.writeFileSync(p, pcmToWav(Buffer.concat(parts), rate));
  }
  return p;
}

const playTone = name => playWav(tonePath(name));

// Play one wav. Speech clips (speech=true) register as the pausable,
// mutable "now playing" clip and notify browsers; short tones do not.
function playWav(p, speech = false) {
  return new Promise(resolve => {
    const child = spawn('pw-play', [p], { stdio: 'ignore' });
    if (speech) {
      voice.current = child;
      voice.paused = false;
      broadcast({ type: 'voice-playing', playing: true, paused: false });
    }
    const done = () => {
      if (speech && voice.current === child) {
        voice.current = null;
        voice.paused = false;
        broadcast({ type: 'voice-playing', playing: false, paused: false });
      }
      resolve();
    };
    child.on('close', done);
    child.on('error', done);
  });
}

function voicePauseToggle() {
  if (!voice.current) return false;
  try {
    voice.current.kill(voice.paused ? 'SIGCONT' : 'SIGSTOP');
    voice.paused = !voice.paused;
    broadcast({ type: 'voice-playing', playing: true, paused: voice.paused });
  } catch {}
  return true;
}

function voiceStopCurrent() {
  if (!voice.current) return false;
  try { voice.current.kill('SIGCONT'); voice.current.kill('SIGKILL'); } catch {}
  return true;
}

async function speakLine(text) {
  try {
    const clip = await synthesizeSpeech(text, false, VOICE_SPEED);
    await playWav(path.join(TTS_DIR, clip.id + '.wav'), true);
  } catch (e) { console.log('voice speak failed: ' + e.message); }
}

function enqueueAnnouncement(item) {
  if (voiceMuted()) return;
  voice.queue.push(item);
  if (voice.queue.length > 5) voice.queue.splice(0, voice.queue.length - 5);
  voicePump();
}

async function voicePump() {
  if (voice.playing) return;
  voice.playing = true;
  try {
    while (voice.queue.length) {
      const item = voice.queue.shift();
      if (voiceMuted()) continue;
      await playWav(item.wavPath, true);
      if (voiceMuted()) continue; // muted mid-announcement: no mic window
      await voiceListen(item).catch(e => console.log('voice listen failed: ' + e.message));
    }
  } finally { voice.playing = false; }
}

// One utterance from the room microphone: wait up to waitMs for speech to
// start, then stop after tailMs of trailing silence. Returns raw s16/16k/mono
// PCM, or null when nobody spoke.
function recordUtterance({ waitMs = 10000, tailMs = 2200, maxMs = 120000 } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('pw-record', ['--raw', '--format', 's16', '--rate', '16000', '--channels', '1', '-'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const chunks = [];
    let leftover = Buffer.alloc(0);
    // The first five 100 ms frames calibrate the ambient floor. Speech must
    // then run three consecutive frames above the threshold: one-frame spikes
    // (keys, clicks) never open the gate.
    const calib = [];
    let started = false, lastVoice = 0, floor = 0, loudRun = 0;
    const t0 = Date.now();
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(ok && started ? Buffer.concat(chunks) : null);
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (!started && now - t0 > waitMs) finish(false);
      else if (started && now - lastVoice > tailMs) finish(true);
      else if (now - t0 > maxMs) finish(started);
    }, 100);
    child.on('error', () => finish(false));
    child.on('close', () => finish(started));
    child.stdout.on('data', buf => {
      chunks.push(buf);
      leftover = leftover.length ? Buffer.concat([leftover, buf]) : buf;
      while (leftover.length >= 3200) { // 100 ms frames
        const frame = leftover.subarray(0, 3200);
        leftover = leftover.subarray(3200);
        let sum = 0;
        for (let i = 0; i < 3200; i += 2) { const v = frame.readInt16LE(i); sum += v * v; }
        const rms = Math.sqrt(sum / 1600);
        if (calib.length < 5) {
          calib.push(rms);
          if (calib.length === 5) floor = [...calib].sort((a, b) => a - b)[2]; // median
          continue;
        }
        floor = Math.min(floor, Math.max(rms, 40));
        const threshold = Math.max(floor * 3, floor + 600);
        if (rms > threshold) {
          loudRun++;
          if (loudRun >= 3) { started = true; lastVoice = Date.now(); }
        } else {
          loudRun = 0;
        }
      }
    });
  });
}

async function transcribePcm(pcm) {
  const out = await httpRaw(SPEECH_URL.replace(/\/$/, '') + '/transcribe', pcm,
    'audio/L16;rate=16000;channels=1', 60000 + Math.floor(pcm.length / 128));
  if (out.status !== 200) throw new Error('speech service ' + out.status);
  return out.buf.toString('utf8').trim();
}

// The send word may sit at the very end, or be followed by a couple of
// stray transcription words ("Send. Complete.", "send thank you").
const VOICE_SEND_TAIL = /[\s.,!]*(send|done|go|submit|enter|control enter|ship it|that'?s all)[\s.,!]*(\w+[\s.,!]*){0,2}$/i;

async function voiceGate(transcript) {
  try {
    const res = await httpJson(REWRITE_URL, {
      model: REWRITE_MODEL,
      messages: [
        { role: 'system', content: VOICE_GATE_PROMPT },
        { role: 'user', content: transcript },
      ],
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false },
    }, 30000);
    const raw = String(res.json && res.json.choices && res.json.choices[0]
      && res.json.choices[0].message && res.json.choices[0].message.content || '');
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);
    if (['send', 'wait', 'command', 'ignore'].includes(parsed.action)) return parsed;
  } catch (e) { console.log('voice gate unreachable, using heuristic: ' + e.message); }
  // Heuristic fallback when Qwen is down: commands, an explicit send word at
  // the end sends, anything else with real length waits for more.
  const t = transcript.toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(mute|stop|be quiet|shut up|pause)\b/.test(t) && t.split(' ').length <= 4) return { action: 'command', command: 'mute', text: '' };
  if (/^(skip|next|dismiss)\b/.test(t) && t.split(' ').length <= 3) return { action: 'command', command: 'skip', text: '' };
  if (/^(status|what'?s? (is )?(running|done))/.test(t)) return { action: 'command', command: 'status', text: '' };
  if (VOICE_SEND_TAIL.test(transcript.trim()) && t.split(' ').length >= 2) {
    const cleaned = transcript.replace(VOICE_SEND_TAIL, '').trim();
    if (cleaned) return { action: 'send', command: 'none', text: cleaned };
  }
  if (t.split(' ').filter(Boolean).length >= 2) return { action: 'wait', command: 'none', text: '' };
  return { action: 'ignore', command: 'none', text: '' };
}

// Resolve a spoken name ("the dspy conversation", "aiconvo") to the best
// matching recent conversation. Titles and project names are both searched;
// word overlap scores the match, recency breaks ties.
function voiceResolveTarget(spoken) {
  const words = String(spoken || '').toLowerCase()
    .replace(/\b(the|a|an|my|conversation|conversations|project|projects|one|about)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return null;
  let best = null, bestScore = 0;
  for (const [key, e] of Object.entries(index)) {
    if (!e || e.hiddenFanout) continue;
    const hay = ((e.title || '') + ' ' + (e.timelineTitle || '') + ' ' + projectNameOf(e.cwd, key)).toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (!score) continue;
    const age = Date.now() - Date.parse(e.lastTs || 0);
    const recency = Math.max(0, 1 - age / (30 * 24 * 3600 * 1000)); // 30-day fade
    score += recency;
    if (score > bestScore) { bestScore = score; best = { key, entry: e }; }
  }
  return bestScore >= 1.2 ? best : null; // at least one word plus some recency
}

// Read one conversation's last assistant reply aloud, shortened by Qwen when
// it is long.
async function voiceReadReply(key) {
  let text = '';
  try {
    const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
    const m = (data.messages || []).filter(x => x.role === 'assistant' && x.text && x.text.trim()).slice(-1)[0];
    text = m ? String(m.text) : '';
  } catch {}
  if (!text) { await speakLine('I found no reply to read.'); return; }
  let spoken = text;
  if (text.length > 600) {
    try { spoken = await rewriteForSpeech(text.slice(0, 12000)) || text.slice(0, 600); }
    catch { spoken = text.slice(0, 600); }
  }
  await speakLine(spoken.slice(0, 3000));
}

function voiceStatusLine() {
  const jobs = [...agentRunJobs.values()];
  const running = jobs.filter(j => j.status === 'running');
  const doneRecent = jobs.filter(j => j.status === 'done' && j.finishedAt && Date.now() - j.finishedAt < 15 * 60 * 1000);
  const nameOf = j => {
    const e = j.key && index[j.key];
    return (e && (e.title || e.timelineTitle) || j.title || 'untitled').slice(0, 60);
  };
  const parts = [];
  if (running.length) parts.push(running.length + ' running: ' + running.slice(0, 3).map(nameOf).join('; '));
  if (doneRecent.length) parts.push(doneRecent.length + ' finished in the last fifteen minutes: ' + doneRecent.slice(0, 3).map(nameOf).join('; '));
  return parts.length ? parts.join('. ') + '.' : 'Nothing is running, and nothing finished recently.';
}

// The listen session: beep, then segments of speech separated by pauses.
// Each pause sends the accumulated transcript to the Qwen gate. "wait" keeps
// the microphone open — the user thinks between phrases and only an explicit
// send word (send, done, go, submit, control enter) closes and sends.
async function voiceListen(item) {
  if (process.env.AICONVO_VOICE_REPLY === '0') return;
  await playTone('open');
  let transcript = '';
  const sessionStart = Date.now();
  for (let segment = 0; segment < 12; segment++) {
    if (Date.now() - sessionStart > 5 * 60 * 1000) break;
    // First segment: a short window. After "wait": a generous thinking window.
    const pcm = await recordUtterance({ waitMs: segment === 0 ? 10000 : 45000 });
    if (!pcm || pcm.length < 16000) {
      // Silence. With accumulated text the user walked away mid-thought:
      // drop it rather than send something unconfirmed.
      if (transcript) {
        console.log('voice window closed with unsent text: ' + transcript.slice(0, 120));
        await playTone('close');
        await speakLine('Closed without sending.');
      } else {
        await playTone('close');
      }
      return;
    }
    await playTone('ack'); // speech captured, the gate is deciding
    let piece = '';
    try { piece = await transcribePcm(pcm); }
    catch (e) {
      console.log('voice transcribe failed: ' + e.message);
      await playTone('close');
      await speakLine('Speech service failed. Closed.');
      return;
    }
    if (piece) transcript = (transcript ? transcript + ' ' : '') + piece;
    if (!transcript) { await playTone('wait'); continue; }
    console.log('voice heard so far: ' + transcript.slice(0, 200));
    const gate = await voiceGate(transcript);
    if (gate.action === 'ignore') {
      console.log('voice gate ignored: ' + transcript.slice(0, 120));
      if (!transcript.trim() || segment === 0) {
        await playTone('close');
        await speakLine('Ignored.');
        return;
      }
      await playTone('wait'); // noise on top of real dictation: still open
      continue;
    }
    if (gate.action === 'wait') {
      console.log('voice gate: wait');
      await playTone('wait'); // kept open — keep thinking, then talk again
      continue;
    }
    if (gate.action === 'command') {
      console.log('voice gate command: ' + gate.command + (gate.target ? ' · ' + gate.target : ''));
      if (gate.command === 'mute') {
        voice.mutedUntil = Date.now() + 30 * 60 * 1000;
        voice.queue.length = 0;
        broadcast({ type: 'voice-state', muted: true, mutedUntil: voice.mutedUntil });
        await speakLine('Muted for thirty minutes.');
      } else if (gate.command === 'skip') {
        voice.queue.length = 0;
        await speakLine('Skipped.');
      } else if (gate.command === 'status') {
        await speakLine(voiceStatusLine());
      } else if (gate.command === 'read') {
        const hit = gate.target ? voiceResolveTarget(gate.target) : (item.job && item.job.key ? { key: item.job.key } : null);
        if (!hit) await speakLine('I could not find that conversation.');
        else await voiceReadReply(hit.key);
      } else if (gate.command === 'goto') {
        const hit = voiceResolveTarget(gate.target || transcript);
        if (!hit) await speakLine('I could not find that.');
        else {
          broadcast({ type: 'voice-nav', key: hit.key });
          await speakLine('Opening ' + ((hit.entry && (hit.entry.title || '')) || 'it').slice(0, 60) + '.');
        }
      }
      await playTone('close');
      return;
    }
    // "send": deliver to the conversation that just spoke, same model.
    const text = String(gate.text || transcript).replace(VOICE_SEND_TAIL, '').trim();
    if (!text || !item.job || !item.job.key) { await playTone('close'); return; }
    const model = String(item.job.model || '');
    const slash = model.indexOf('/');
    try {
      await startAgentRun(item.job.key, {
        provider: slash > 0 ? model.slice(0, slash) : undefined,
        modelId: slash > 0 ? model.slice(slash + 1) : undefined,
        message: text, allowQueue: true,
      });
      await speakLine('Sent.');
    } catch (e) {
      console.log('voice reply send failed: ' + e.message);
      await speakLine('Sending failed.');
    }
    await playTone('close');
    return;
  }
  await playTone('close');
  await speakLine('Closed without sending.');
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
    if (LAN_TOKEN && !isLocalRequest(req)) {
      const setLanCookie = (next) => {
        res.writeHead(302, {
          Location: next || '/',
          'Set-Cookie': `aiconvo=${encodeURIComponent(LAN_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        });
        res.end();
      };
      if (u.searchParams.get('token') === LAN_TOKEN) return setLanCookie(u.pathname === '/' ? '/' : u.pathname);
      if (req.method === 'POST' && u.pathname === '/login') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const posted = new URLSearchParams(body).get('token') || '';
        if (posted === LAN_TOKEN) return setLanCookie('/');
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(lanLoginPage('That token is wrong. Try again.'));
      }
      if (!hasLanToken(req)) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(lanLoginPage());
      }
    }
    if (u.pathname === '/manifest.webmanifest') {
      const manifest = JSON.parse(await fsp.readFile(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));
      const tokens = await fsp.readFile(path.join(__dirname, 'design', 'tokens.css'), 'utf8');
      const colors = themesLib.manifestThemeColors(u.searchParams.get('theme') || '', tokens, THEMES_DIR);
      manifest.background_color = colors.backgroundColor;
      manifest.theme_color = colors.themeColor;
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(manifest));
    }
    const staticFile = {
      '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-store' },
      '/tokens.css': { file: 'design/tokens.css', type: 'text/css; charset=utf-8', cache: 'no-store' },
      '/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png', cache: 'public, max-age=86400' },
      '/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png', cache: 'public, max-age=86400' },
      '/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png', cache: 'public, max-age=86400' },
      '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
      '/vendor/mermaid.min.js': { file: 'vendor/mermaid.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/vendor/mrmd-document/0.9.4/mrmd-document.iife.min.js': { file: 'vendor/mrmd-document/0.9.4/mrmd-document.iife.min.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' },
      '/aiconvo.apk': { file: 'aiconvo.apk', type: 'application/vnd.android.package-archive', cache: 'no-store' },
    }[u.pathname];
    if (staticFile) {
      res.writeHead(200, { 'Content-Type': staticFile.type, 'Cache-Control': staticFile.cache });
      return res.end(await fsp.readFile(path.join(__dirname, staticFile.file)));
    }
    if (u.pathname === '/') {
      // no-store: without it the browser heuristically caches this page and
      // can keep serving a stale app.html after the file changes on disk.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await fsp.readFile(path.join(__dirname, 'app.html')));
    } else if (u.pathname === '/api/themes') {
      const themes = themesLib.readCustomThemes(THEMES_DIR);
      json(res, 200, {
        directory: THEMES_DIR,
        themes: themes.valid.map(({ id, name, scheme, mode, motion }) => ({ id, name, scheme, mode, motion })),
        invalid: themes.invalid.map(({ id, file, errors }) => ({ id, file, errors })),
      });
    } else if (u.pathname === '/api/themes.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(themesLib.bundleCustomThemes(THEMES_DIR));
    } else if (u.pathname === '/api/projects/memory-index' && req.method === 'GET') {
      json(res, 200, { projects: projectMemoryIndex() });
    } else if (u.pathname === '/api/projects/stats' && req.method === 'POST') {
      // Folder birth date and disk size per project path, for home Gantt ordering.
      let body = '';
      for await (const chunk of req) body += chunk;
      let paths = [];
      try { paths = (JSON.parse(body).paths || []).filter(p => typeof p === 'string').slice(0, 500); } catch {}
      const stats = {};
      await Promise.all(paths.map(async p => {
        try {
          const st = await fsp.stat(p);
          const size = await new Promise(resolve => {
            const child = spawn('/run/current-system/sw/bin/du', ['-sb', p], { timeout: 10000 });
            let out = '';
            child.stdout.on('data', c => { out += c; });
            child.on('error', () => resolve(0));
            child.on('close', code => { const m = out.match(/^(\d+)/); resolve(code === 0 && m ? Number(m[1]) : 0); });
          });
          stats[p] = { born: st.birthtimeMs, size };
        } catch { stats[p] = null; }
      }));
      json(res, 200, { stats });
    } else if (u.pathname === '/api/sessions') {
      // Temporary fan-out files do not enlarge the visible fork family.
      let n = 0, last = '', mt = 0;
      const visibleEntries = [];
      for (const pair of Object.entries(index)) {
        if (pair[1].hiddenFanout) continue;
        visibleEntries.push(pair);
        n++;
        if ((pair[1].lastTs || '') > last) last = pair[1].lastTs || '';
        if ((pair[1].mtimeMs || 0) > mt) mt = pair[1].mtimeMs || 0;
      }
      const etag = '"' + n + '-' + last + '-' + mt + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      const fam = groupFamilies(visibleEntries, keyForSessionPath);
      const list = visibleEntries.map(([key, e]) => {
        const f = fam.get(key);
        // family fields appear only on multi-member families: less payload.
        const project = projectNameOf(e.cwd, key);
        return f && f.size > 1 ? { key, ...e, project, family: f.primary, familySize: f.size } : { key, ...e, project };
      });
      list.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
      const body = JSON.stringify(list);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag });
      res.end(body);
    } else if (u.pathname === '/api/session') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const data = JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
      data.project = projectNameOf(index[key].cwd, key);
      data.selectedModels = await inferredConversationModels(key, data);
      data.attachedContext = conversationContextOf(key);
      json(res, 200, data);
    } else if (u.pathname === '/api/conversation/media' && req.method === 'GET') {
      try {
        const media = await transcriptImage(u.searchParams.get('id'), u.searchParams.get('entry'), u.searchParams.get('path'));
        res.writeHead(200, { 'Content-Type': media.mime, 'Content-Length': media.body.length,
          'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(media.body);
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/file' && req.method === 'GET') {
      try { json(res, 200, await transcriptFileReadResponse(u.searchParams.get('id'), u.searchParams.get('path'), isLocalRequest(req))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/path/info' && req.method === 'GET') {
      try { json(res, 200, await pathInfoResponse(u.searchParams.get('id'), u.searchParams.get('path'), isLocalRequest(req))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/path/read' && req.method === 'GET') {
      try { json(res, 200, await transcriptFileReadResponse(u.searchParams.get('id'), u.searchParams.get('path'), isLocalRequest(req))); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/path/action' && req.method === 'POST') {
      if (!isLocalRequest(req)) return json(res, 403, { error: 'system file actions are available only on the laptop' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const input = JSON.parse(body || '{}');
        json(res, 200, await nativePathAction(input.id, input.path, input.action));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if ((u.pathname === '/api/path/content' || u.pathname === '/api/conversation/file-content') && req.method === 'GET') {
      try {
        const found = await transcriptFilePath(u.searchParams.get('id'), u.searchParams.get('path'), 32 * 1024 * 1024, isLocalRequest(req));
        const mime = imageMimeForPath(found.abs);
        if (!mime) throw new Error('this file is not a supported image');
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': found.stat.size,
          'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(found.abs).pipe(res);
      } catch (e) { json(res, 404, { error: e.message }); }
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
      const q = (u.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { q, total: 0, groups: [] });
      const t0 = Date.now();
      const out = searchIdx
        ? searchIdx.search(q, {
            limit: Number(u.searchParams.get('limit')) || 40,
            offset: Number(u.searchParams.get('offset')) || 0,
            boostProject: u.searchParams.get('boost') || '',
          })
        : await legacySearch(q);
      // Conversation groups carry fresh index metadata (titles can change).
      for (const g of out.groups) {
        if (g.key && index[g.key]) {
          const e = index[g.key];
          g.title = e.title; g.timelineTitle = e.timelineTitle; g.cwd = e.cwd;
          g.source = e.source; g.firstTs = e.firstTs; g.lastTs = e.lastTs;
          g.notePath = e.notePath || null;
        }
      }
      json(res, 200, { q, tookMs: Date.now() - t0, sem: semanticEnabled(), ...out });
    } else if (u.pathname === '/api/search/semantic') {
      // Stage two: late-interaction hits from the GPU server. Failures are
      // soft — the client silently keeps the lexical results.
      const q = (u.searchParams.get('q') || '').trim();
      if (!semanticEnabled() || q.length < 2) return json(res, 200, { q, semantic: semanticEnabled(), groups: [] });
      const t0 = Date.now();
      try {
        const r = await semFetch('/search', { ns: semNs(), q, limit: 30 }, 8000);
        json(res, 200, { q, semantic: true, tookMs: Date.now() - t0, groups: semanticGroups(r.hits || []) });
      } catch (e) {
        json(res, 200, { q, semantic: true, groups: [], error: 'semantic stage unreachable' });
      }
    } else if (u.pathname === '/api/search/semantic-status') {
      const out = { enabled: semanticEnabled(), url: appSettings.semanticUrl || '', ns: semNs() };
      if (searchIdx) out.sync = searchIdx.semanticStats();
      if (out.enabled) {
        try { out.health = await semFetch('/health', undefined, 4000); }
        catch (e) { out.error = e.message; }
      }
      json(res, 200, out);
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
      try {
        const data = await projectResponse(project);
        // Fire-and-forget: opening a project usually precedes opening its
        // file Gantt. Warm the diff cache now so that click is not a cold
        // 2-minute parse of every session file.
        warmProjectDiffs(project);
        if (data.conversations) maybeAutoProjectTitle(data.project); // names itself once, in the background

        data.foldedFrom = foldedFromFor(data.project);
        const sugs = await projectFoldSuggestions().catch(() => []);
        // Quiet by design: only the three strongest pairs (suggestPairs
        // emits remote evidence before name evidence).
        data.foldSuggestions = sugs
          .filter(s => s.from === data.project || s.into === data.project)
          .map(s => ({ ...s, other: s.from === data.project ? s.into : s.from }))
          .slice(0, 3);
        json(res, 200, data);
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/diffs') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, { key, ...(index[key] || {}), events: await conversationDiffs(key) }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/file-history') {
      try { json(res, 200, await conversationFileHistoryResponse(u.searchParams.get('id') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/file-event') {
      try { json(res, 200, await conversationFileEventResponse(
        u.searchParams.get('id') || '', u.searchParams.get('call') || '',
        u.searchParams.get('ts') || '', u.searchParams.get('path') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/file-history/file') {
      try { json(res, 200, await conversationFileCompareResponse(
        u.searchParams.get('id') || '', u.searchParams.get('repo') || '', u.searchParams.get('path') || '',
        u.searchParams.get('from') || '', u.searchParams.get('to') || '',
        u.searchParams.get('fromAt') || '', u.searchParams.get('toAt') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/project/diffs') {
      const project = u.searchParams.get('name') || '';
      try { json(res, 200, await projectDiffResponse(project, u.searchParams.get('include') === 'full')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/project/file-history') {
      const project = u.searchParams.get('name') || '';
      try { json(res, 200, await projectFileHistoryResponse(project)); }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/project/tree') {
      try { json(res, 200, await projectTreeResponse(u.searchParams.get('name') || '')); }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/project/file-history/commit') {
      try { json(res, 200, await projectCommitResponse(
        u.searchParams.get('name') || '', u.searchParams.get('repo') || '', u.searchParams.get('hash') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/project/file-history/file') {
      try { json(res, 200, await projectFileCompareResponse(
        u.searchParams.get('name') || '', u.searchParams.get('repo') || '', u.searchParams.get('path') || '',
        u.searchParams.get('from') || '', u.searchParams.get('to') || '',
        u.searchParams.get('fromAt') || '', u.searchParams.get('toAt') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/repos') {
      try { json(res, 200, { repos: await discoverGitRepos(u.searchParams.get('refresh') === '1') }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history') {
      try { json(res, 200, await gitFileHistoryResponse(u.searchParams.get('repo') || '')); }
      catch (e) { json(res, e.message === 'repository not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history/commit') {
      try { json(res, 200, await gitCommitResponse(u.searchParams.get('repo') || '', u.searchParams.get('hash') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history/file') {
      try { json(res, 200, await gitFileCompareResponse(
        u.searchParams.get('repo') || '', u.searchParams.get('path') || '',
        u.searchParams.get('from') || '', u.searchParams.get('to') || '',
        u.searchParams.get('fromAt') || '', u.searchParams.get('toAt') || '',
        u.searchParams.get('light') === '1'));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history/snapshots') {
      try { json(res, 200, await gitFileSnapshotsResponse(u.searchParams.get('repo') || '', u.searchParams.get('path') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-history/interval') {
      try {
        json(res, 200, {
          repo: path.resolve(u.searchParams.get('repo') || ''),
          from: u.searchParams.get('from') || '',
          to: u.searchParams.get('to') || '',
          files: await gitIntervalNumstat(
            u.searchParams.get('repo') || '', u.searchParams.get('from') || '', u.searchParams.get('to') || ''),
        });
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/git/file-feedback' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await sendGitFileFeedback(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/blame') {
      const pathValue = u.searchParams.get('path') || '';
      if (!pathValue) return json(res, 400, { error: 'missing path' });
      try { json(res, 200, await fileBlameResponse(pathValue, u.searchParams.get('project') || '', u.searchParams.get('key') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/file/read' && req.method === 'GET') {
      try { json(res, 200, await fileReadResponse(u.searchParams.get('path') || '')); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await fileSaveResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await docSaveResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/commit' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await docCommitResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/doc/create' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await docCreateResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/docs' && req.method === 'GET') {
      try { json(res, 200, await projectDocsResponse(u.searchParams.get('name') || '')); }
      catch (e) { json(res, e.message === 'project not found' ? 404 : 500, { error: e.message }); }
    } else if (u.pathname === '/api/doc/asset' && req.method === 'GET') {
      try {
        const out = await docAssetResponse(u.searchParams.get('doc') || '', u.searchParams.get('src') || '');
        res.writeHead(200, { 'Content-Type': out.mime, 'Cache-Control': 'no-store' });
        return res.end(out.bytes);
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/notefile/save' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await noteFileSaveResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/vouch' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await vouchApply(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/vouch/status' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const parsed = JSON.parse(body || '{}');
        const abs = path.resolve(expandHomePath(String(parsed.path || '')));
        const content = typeof parsed.content === 'string' ? parsed.content : await fsp.readFile(abs, 'utf8');
        json(res, 200, vouchStatusFor(abs, content));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/vouch/all' && req.method === 'GET') {
      json(res, 200, vouchAllResponse());
    } else if (u.pathname === '/api/transcript/raw' && req.method === 'GET') {
      try { json(res, 200, await transcriptRawResponse(u.searchParams.get('id') || '', Number(u.searchParams.get('i')))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/transcript/edit' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await transcriptEditResponse(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/diff-event') {
      const id = u.searchParams.get('id') || '';
      const event = await findDiffEvent(id, u.searchParams.get('project') || '', u.searchParams.get('key') || '');
      if (!event) return json(res, 404, { error: 'not found' });
      json(res, 200, event);
    } else if (u.pathname === '/api/project/memory' && req.method === 'GET') {
      const project = u.searchParams.get('name') || '';
      const memory = await projectMemoryInfo(project);
      if (!memory) return json(res, 404, { error: 'no project memory yet' });
      json(res, 200, memory);
    } else if (u.pathname === '/api/project/memory/file' && req.method === 'GET') {
      try {
        const area = u.searchParams.get('area');
        json(res, 200, area
          ? await areaMemoryDocument(u.searchParams.get('name') || '', area, u.searchParams.get('kind') || '')
          : await projectMemoryDocument(u.searchParams.get('name') || '', u.searchParams.get('kind') || ''));
      } catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/epic/memory/file' && req.method === 'GET') {
      try { json(res, 200, await epicMemoryDocument(u.searchParams.get('id') || '', u.searchParams.get('kind') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/epic/memory/regenerate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 202, jobView(startEpicDocsJob(parsed.id || ''))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/memory/leaf' && req.method === 'GET') {
      const key = u.searchParams.get('id') || '';
      if (!index[key]) return json(res, 404, { error: 'not found' });
      const leaf = await readLeaf(key);
      json(res, 200, { key, state: leafStateFor(index[key], leaf), leaf });
    } else if (u.pathname === '/api/project/memory/regenerate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try {
        json(res, 202, jobView(parsed.area
          ? startAreaDocsJob(parsed.project || '', areasLib.normalizeAreaRel(parsed.area))
          : startMemoryDocsJob(parsed.project || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/memory/backfill' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try {
        if (parsed.action === 'pause') {
          const job = memoryBackfillJobs.get(parsed.project || '');
          if (!job || job.finished) return json(res, 404, { error: 'no running backfill for this project' });
          job.cancelRequested = true;
          job.statusText = 'Pausing after the current leaves…';
          jobChanged(job);
          return json(res, 200, jobView(job));
        }
        json(res, 202, jobView(startMemoryBackfillJob(parsed.project || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/distill' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 202, jobView(startProjectDistillJob(parsed.project || ''))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/start' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      parsed.projectless = false; // only the dedicated route can choose home
      try { json(res, 200, await startProjectConversation(parsed)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/start-loose' && req.method === 'POST') {
      // This endpoint accepts no cwd. A loose web start always uses the
      // server user's home, which prevents clients from choosing an
      // unexpected process directory.
      try {
        json(res, 200, await startProjectConversation({
          project: LOOSE_PROJECT, projectless: true, agent: 'pi', surface: 'rpc',
          models: [], include: { map: false }, silent: true,
        }));
      } catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/project/model' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, setProjectDefaultModel(p.project, p.model));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/fs/dirs' && req.method === 'GET') {
      // Folder picker: list subdirectories, so an existing folder can be
      // adopted as a project without a typed path. Local personal tool;
      // the same process already reads the whole home directory.
      try {
        const base = path.resolve(expandHomePath(String(u.searchParams.get('path') || '').trim() || '~/Projects'));
        const entries = await fsp.readdir(base, { withFileTypes: true });
        const dirs = [];
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const full = path.join(base, ent.name);
          dirs.push({
            name: ent.name,
            git: fs.existsSync(path.join(full, '.git')),
            known: !!projectMetaFor(projectNameOf(full)), // already on the timeline
          });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const home = os.homedir();
        const parent = path.dirname(base);
        json(res, 200, {
          path: base,
          display: base === home || base.startsWith(home + path.sep) ? '~' + base.slice(home.length) : base,
          parent: parent !== base ? parent : null,
          dirs,
        });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/create' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await createProject(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/area' && req.method === 'GET') {
      try { json(res, 200, await areaResponse(u.searchParams.get('project') || '', u.searchParams.get('rel') || '')); }
      catch (e) { json(res, 404, { error: e.message }); }
    } else if (u.pathname === '/api/area/create' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await createArea(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/area/remove' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, removeArea(p.project, p.rel));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/unregister' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, unregisterProject((JSON.parse(body || '{}')).name)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/context' && req.method === 'POST') {
      // Assemble the inline context bundle for preview. Nothing starts; the
      // user edits/approves the text before /api/project/start sends it.
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try {
        const include = { ...(parsed.include || {}) };
        if (parsed.area) include.area = areasLib.normalizeAreaRel(parsed.area);
        json(res, 200, await buildProjectContextBundle(parsed.project, include, parsed.name || ''));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/modes' && req.method === 'GET') {
      json(res, 200, { modes: listPromptModes() });
    } else if (u.pathname === '/api/modes' && (req.method === 'PUT' || req.method === 'POST')) {
      // Save a custom mode. A key that matches a builtin overrides it, the
      // same rule the modes extension applies.
      let body = '';
      for await (const chunk of req) body += chunk;
      const def = validateModeDef(JSON.parse(body || '{}'));
      if (def.error) return json(res, 400, { error: def.error });
      try {
        fs.mkdirSync(MODES_DIR, { recursive: true });
        fs.writeFileSync(path.join(MODES_DIR, def.mode.key + '.json'), JSON.stringify(def.mode, null, 2) + '\n');
        json(res, 200, { ok: true, mode: { ...def.mode, builtin: BUILTIN_MODES.some(m => m.key === def.mode.key), custom: true } });
      } catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/modes/delete' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const key = String(parsed.key || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/.test(key)) return json(res, 400, { error: 'bad mode key' });
      const file = path.join(MODES_DIR, key + '.json');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no custom mode file for ' + key });
      try { fs.unlinkSync(file); json(res, 200, { ok: true }); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/project-folds') {
      json(res, 200, await projectFoldsResponse());
    } else if (u.pathname === '/api/project/fold' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await foldProjects(parsed.from, parsed.into)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/unfold' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await unfoldProject(parsed.name)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/fold-dismiss' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await dismissFoldSuggestion(parsed.from, parsed.into)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/tree') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      const tree = await sessionTreeFor(key);
      // Parallel opinions belong in the comparison stage, not as durable
      // fork branches in the navigation tree.
      tree.nodes = tree.nodes.filter(n => !(index[n.key] && index[n.key].hiddenFanout));
      tree.family = tree.family.filter(f => !(index[f.key] && index[f.key].hiddenFanout));
      // One typed classification serves the tree and transcript. The browser
      // must not infer fan-out again from ancestry or message text.
      tree.fanouts = fanoutLib.classifyFanoutGroups(tree).map(g => ({
        node: g.node,
        answers: g.answers.map(a => a.id),
        both: g.both ? g.both.id : null,
        merge: g.merge ? { bridge: g.merge.bridge.id, answer: g.merge.answer.id } : null,
      }));
      json(res, 200, tree);
    } else if (u.pathname === '/api/conversation/context' && req.method === 'GET') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await conversationContextResponse(key, u.searchParams.get('leaf') || null)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/compare') {
      const key = u.searchParams.get('id');
      if (!key || !index[key]) return json(res, 404, { error: 'not found' });
      try { json(res, 200, await compareGroupsResponse(key)); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/title' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await setConversationTitle(p.id, p.title));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/retitle' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await retitleConversation(p.id));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/title' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        if (!projectMetaFor(String(p.name || ''))) throw new Error('project not found');
        json(res, 200, setProjectTitle(String(p.name), p.title));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/project/retitle' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await retitleProject(String(p.name || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/epic/title' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, setEpicTitle(String(p.id || ''), p.title));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/epic/retitle' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await retitleEpic(String(p.id || '')));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/model' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const out = await setConversationModel(p.id, p.provider, p.modelId, !!p.force);
        saveConversationModels(p.id, [{ provider: p.provider, modelId: p.modelId }]);
        json(res, 200, out);
      } catch (e) { json(res, e.needsForce ? 409 : 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/conversation/thinking' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await setConversationThinking(p.id, p.level, !!p.force));
      } catch (e) { json(res, e.needsForce ? 409 : 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/conversation/project' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, await assignConversationProject(p.id, p.project));
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/models' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, { ok: true, models: saveConversationModels(p.id, p.models) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/attached-context' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, { ok: true, context: saveConversationContext(p.id, p.context) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/node/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const models = normalizePickedModels(p.models);
        if (models.length) saveConversationModels(p.id, models);
        const images = rpcImagesOf(p.images);
        if (models.length >= 2) {
          json(res, 202, { ok: true, runs: await startFanOut(p.id, { node: p.node || null, models, message: p.prompt, images, force: !!p.force, context: p.context }) });
        } else {
          const out = await startAgentRun(p.id, {
            node: p.node || null, provider: models[0] && models[0].provider, modelId: models[0] && models[0].modelId,
            message: p.prompt, images, force: !!p.force, allowQueue: true, context: p.context,
          });
          if (out && out.queued) json(res, 202, { ok: true, queued: true, job: out.job ? jobView(out.job) : null });
          else json(res, 202, { ok: true, job: jobView(out) });
        }
      } catch (e) { json(res, e.needsForce ? 409 : 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/node/aggregate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const out = await startAggregate(p.id, { node: p.node, provider: p.provider, modelId: p.modelId, instruction: p.instruction, answers: p.answers, force: !!p.force });
        json(res, 202, { ok: true, job: jobView(out.job), answers: out.answers });
      } catch (e) { json(res, e.needsForce ? 409 : 400, { error: e.message, needsForce: !!e.needsForce }); }
    } else if (u.pathname === '/api/node/both' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        json(res, 200, { ok: true, ...(await ensureBothBridge(p.id, p.node)) });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/run/abort' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const record = [...headlessRuns.values()].find(r => r.jobId === p.jobId);
        if (!record) return json(res, 404, { error: 'run not found or already finished' });
        record.yielded = 'aborted by you';
        if (record.handle && record.handle.abort) await record.handle.abort();
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/run/ui-input' && req.method === 'POST') {
      // Keyboard input for a hosted TUI view (ctx.ui.custom). data is raw
      // terminal key data ('\r', '\x1b[B', …); data:null closes the view.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const record = [...headlessRuns.values()].find(r => r.jobId === p.jobId);
        if (!record || !record.handle || !record.handle.uiInput) return json(res, 404, { error: 'run not found or already finished' });
        if (!record.handle.uiInput(String(p.id || ''), p.data === null ? null : String(p.data || ''))) {
          return json(res, 404, { error: 'that view is no longer open' });
        }
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/run/ui-response' && req.method === 'POST') {
      // Answer an extension dialog (confirm/select/input/editor) shown on a
      // run card. The response reaches the pi process through its stdin.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const record = [...headlessRuns.values()].find(r => r.jobId === p.jobId);
        if (!record || !record.handle || !record.handle.respondUi) return json(res, 404, { error: 'run not found or already finished' });
        const resp = {};
        if (p.cancelled) resp.cancelled = true;
        else if (typeof p.confirmed === 'boolean') resp.confirmed = p.confirmed;
        else resp.value = String(p.value == null ? '' : p.value);
        if (!record.handle.respondUi(String(p.id || ''), resp)) return json(res, 404, { error: 'that dialog is no longer waiting' });
        const job = agentRunJobs.get(record.jobId);
        if (job) {
          job.uiRequests = (job.uiRequests || []).filter(q => q.id !== p.id);
          job.statusText = 'answered · running';
          jobChanged(job);
          const t = liveRunTails.get(job.id);
          if (t && t.push) t.push(true);
        }
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
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
    } else if (u.pathname === '/api/usage' && req.method === 'GET') {
      const data = usageDashboardResponse(u.searchParams);
      json(res, data.error ? 503 : 200, data);
    } else if (u.pathname === '/api/usage/billing' && (req.method === 'PUT' || req.method === 'POST')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      appSettings = settingsLib.normalizeSettings({ ...appSettings, usageBilling: parsed });
      saveAppSettings();
      json(res, 200, { usageBilling: appSettings.usageBilling });
    } else if (u.pathname === '/api/settings' && req.method === 'GET') {
      json(res, 200, settingsResponse());
    } else if (u.pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const piDefault = readPiDefault();
      const listed = (modelsCache.models.length ? modelsCache : await listPiModels()).models;
      if (!parsed.usePiDefault && parsed.provider && parsed.model && listed.length && !settingsLib.findModel(listed, parsed.provider, parsed.model)) {
        return json(res, 400, { error: 'unknown model: ' + parsed.provider + '/' + parsed.model });
      }
      const prevSemTarget = (appSettings.semanticUrl || '') + '|' + semNs();
      appSettings = settingsLib.applyResolvedContext(parsed, listed, piDefault);
      saveAppSettings();
      // A new URL or namespace means a different remote index: re-push all.
      if (searchIdx && (appSettings.semanticUrl || '') + '|' + semNs() !== prevSemTarget) {
        searchIdx.semanticResetSync();
      }
      if (semanticEnabled()) scheduleSemanticSync(500); // backfill starts now
      json(res, 200, settingsResponse());
    } else if (u.pathname === '/api/models') {
      const listed = await listPiModels(u.searchParams.get('refresh') === '1');
      json(res, 200, {
        models: listed.models,
        readyProviders: readyProviders(),
        fetchedAt: listed.at,
        error: listed.error,
        piDefault: readPiDefault(),
      });
    } else if (u.pathname === '/api/agents/active') {
      // running: a live pi/claude process. writing: file changed in 5 min.
      // recent: file changed in the last hour and not already listed.
      // procs: EVERY pi/claude process on the machine, with owner tags and
      // pids, so runaway or untracked agents are visible and killable.
      const nowMs = Date.now();
      const running = listRunningAgents().map(item => ({
        key: item.key, source: item.source, title: item.title, cwd: item.cwd,
        pid: item.pid, kind: item.kind, windowTitle: item.windowTitle,
      }));
      const runningKeys = new Set(running.map(item => item.key).filter(Boolean));
      const writing = [], recent = [];
      for (const [key, e] of Object.entries(index)) {
        if (!e.mtimeMs) continue;
        const ageMs = nowMs - e.mtimeMs;
        const row = { key, source: e.source, title: e.timelineTitle || e.title, cwd: e.cwd, lastTs: e.lastTs, ageMs };
        if (ageMs < 5 * 60 * 1000) {
          if (!runningKeys.has(key)) writing.push(row);
        } else if (ageMs < 60 * 60 * 1000) {
          recent.push(row);
        }
      }
      writing.sort((a, b) => a.ageMs - b.ageMs);
      recent.sort((a, b) => a.ageMs - b.ageMs);
      json(res, 200, { running, writing, recent: recent.slice(0, 15), procs: agentProcsView(running) });
    } else if (u.pathname === '/api/node/commands') {
      // pi's slash commands for this conversation's cwd, for the composer
      // palette. Cached per cwd; a --no-session probe process fills it.
      const key = u.searchParams.get('id');
      const entry = key && index[key];
      if (!entry) return json(res, 404, { error: 'not found' });
      if (conversationKind(entry) !== 'pi') return json(res, 400, { error: 'slash commands over RPC need pi' });
      const { cwd } = sessionPathsFor(key);
      const cached = slashCommandsCache.get(cwd);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return json(res, 200, { commands: cached.list, cwd, cached: true });
      try {
        const list = await piListCommands({ cwd, env: agentEnv(), extraArgs: piProviderExtraArgs() });
        slashCommandsCache.set(cwd, { at: Date.now(), list });
        json(res, 200, { commands: list, cwd });
      } catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/agents/kill' && req.method === 'POST') {
      // Kill one agent process from the agents view. Refuses pids that are
      // not pi/claude/bridge processes. Web-owned RPC runs abort cleanly
      // through their own lifecycle so partial output lands in the file.
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        const pid = Number(p.pid);
        if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'bad pid' });
        if (pid === process.pid) {
          // An in-process (sdk) session: the conversation key names it.
          const key = String(p.key || '');
          if (!key || !index[key]) return json(res, 400, { error: 'this in-process session needs a conversation key to kill' });
          const { sessionPath } = sessionPathsFor(key);
          await releaseHeadless(path.resolve(sessionPath), 'killed from the agents view');
          stopAnyWarmSession(sessionPath);
          return json(res, 200, { ok: true, pid, kind: 'pi', owner: 'web', engine: 'sdk' });
        }
        const proc = scanAgentProcs().find(x => x.pid === pid);
        if (!proc) return json(res, 404, { error: 'pid ' + pid + ' is not a pi/claude/bridge process (already gone?)' });
        const warm = pirpc.listWarmSessions().find(w => w.pid === pid);
        if (warm) {
          await releaseHeadless(path.resolve(warm.sessionPath), 'killed from the agents view');
          stopAnyWarmSession(warm.sessionPath);
        } else {
          process.kill(pid, p.force ? 'SIGKILL' : 'SIGTERM');
        }
        json(res, 200, { ok: true, pid, kind: proc.kind, owner: warm ? 'web' : 'process' });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/file-feedback' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { json(res, 200, await sendFileFeedback(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/open' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await openConversationInTerminal(parsed.id)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await sendToConversation(parsed.id, parsed)); }
      catch (e) {
        if (e.blocked) json(res, 409, { error: e.message, blocked: true, ...e.blocked });
        else json(res, 500, { error: e.message });
      }
    } else if (u.pathname === '/api/conversation/pane' && req.method === 'GET') {
      const key = u.searchParams.get('id');
      try { json(res, 200, await captureConversation(key)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/conversation/act' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await actOnConversation(parsed.id, parsed)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/voice/state' && req.method === 'GET') {
      json(res, 200, { muted: voiceMuted(), mutedUntil: voice.mutedUntil || null, queued: voice.queue.length,
        playing: !!voice.current, paused: voice.paused });
    } else if (u.pathname === '/api/voice/pause' && req.method === 'POST') {
      json(res, 200, { ok: voicePauseToggle(), paused: voice.paused });
    } else if (u.pathname === '/api/voice/mute' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const p = JSON.parse(body || '{}');
        if (p.muted) {
          voice.mutedUntil = Date.now() + Math.max(1, Math.min(24 * 60, Number(p.minutes) || 30)) * 60 * 1000;
          voice.queue.length = 0;
          voiceStopCurrent(); // silence right now, not after the clip
        } else voice.mutedUntil = 0;
        broadcast({ type: 'voice-state', muted: voiceMuted(), mutedUntil: voice.mutedUntil || null });
        json(res, 200, { muted: voiceMuted(), mutedUntil: voice.mutedUntil || null });
      } catch (e) { json(res, 400, { error: e.message }); }
    } else if (u.pathname === '/api/speech/transcribe' && req.method === 'POST') {
      const max = 16000 * 2 * 600;
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > max) return json(res, 413, { error: 'Recording is longer than 10 minutes.' });
        chunks.push(chunk);
      }
      if (size < 3200) return json(res, 400, { error: 'Recording was too short.' });
      try {
        const pcm = Buffer.concat(chunks);
        const timeout = 60000 + Math.floor(pcm.length / 128);
        const out = await httpRaw(
          SPEECH_URL.replace(/\/$/, '') + '/transcribe', pcm,
          'audio/L16;rate=16000;channels=1', timeout);
        res.writeHead(out.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(out.buf);
      } catch (e) {
        json(res, 502, { error: 'Speech service failed: ' + e.message });
      }
    } else if (u.pathname === '/api/exec' && req.method === 'POST') {
      // Run one bash block from a reply, in the conversation's cwd. Same
      // trust surface as the terminal spawns beside it: this server already
      // opens agent terminals and edits session files on this machine.
      let body = '';
      for await (const chunk of req) body += chunk;
      const { cmd, cwd } = JSON.parse(body || '{}');
      if (!cmd || typeof cmd !== 'string') return json(res, 400, { error: 'cmd required' });
      const t0 = Date.now();
      const result = await new Promise(resolve => {
        const dir = cwd && typeof cwd === 'string' && fs.existsSync(cwd) ? cwd : os.homedir();
        const child = spawn('bash', ['-lc', cmd], { cwd: dir, env: process.env });
        let buf = '';
        const cap = s => { buf += s; if (buf.length > 200000) { buf = buf.slice(0, 200000) + '\n… (truncated — output capped at 200 KB)'; child.kill('SIGKILL'); } };
        child.stdout.on('data', d => cap(String(d)));
        child.stderr.on('data', d => cap(String(d)));
        const timer = setTimeout(() => { cap('\n… (stopped after 120 s)'); child.kill('SIGKILL'); }, 120000);
        child.on('close', code => { clearTimeout(timer); resolve({ out: buf, code }); });
        child.on('error', e => { clearTimeout(timer); resolve({ out: String(e.message), code: -1 }); });
      });
      json(res, 200, { ...result, cwd: cwd || '~', ms: Date.now() - t0 });
    } else if (u.pathname === '/api/doc/run-cell' && req.method === 'POST') {
      // Run one fenced code block from a document through the rat CLI.
      // Design boundary (deliberately thin — no MCP client, no kernel
      // state here): rat owns kernels, project resolution, venvs, and
      // lifecycle; aiconvo passes {lang, code, cwd} and shows the output.
      // Same trust surface as /api/exec above: this server already runs
      // arbitrary shell blocks on this machine at the user's request.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const { lang, code, cwd: reqCwd } = parsed;
      // rat resolves language aliases itself; this map only covers the
      // common markdown fence spellings of rat's built-in runtimes.
      const RAT_LANGS = { python: 'py', py: 'py', python3: 'py', r: 'r', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', julia: 'jl', jl: 'jl', javascript: 'js', js: 'js', node: 'js' };
      const runtime = RAT_LANGS[String(lang || '').toLowerCase()];
      if (!runtime) return json(res, 400, { error: 'no rat runtime for language "' + lang + '"' });
      if (!code || typeof code !== 'string' || !code.trim()) return json(res, 400, { error: 'code required' });
      const t0run = Date.now();
      // cwd decides which project kernel rat resolves to (py@<project>).
      const dir = reqCwd && typeof reqCwd === 'string' && fs.existsSync(reqCwd) ? reqCwd : os.homedir();
      // No hard timeout here: long runs are legitimate (training, big
      // queries). The client shows elapsed time and offers cancel, which
      // interrupts the KERNEL (rat cancel) — killing this subprocess alone
      // would leave the kernel computing. runId lets /api/doc/cancel-run
      // find the pending child.
      const runId = String(parsed.runId || '') || ('run-' + Date.now());
      const result = await new Promise(resolve => {
        const ratHome = path.join(os.homedir(), '.local', 'bin', 'rat');
        const ratBin = fs.existsSync(ratHome) ? ratHome : 'rat';
        const child = spawn(ratBin, ['run', runtime, code], { cwd: dir, env: process.env });
        let buf = '';
        const cap = s => { buf += s; if (buf.length > 200000) { buf = buf.slice(0, 200000) + '\n… (truncated — output capped at 200 KB)'; child.kill('SIGKILL'); } };
        child.stdout.on('data', d => cap(String(d)));
        child.stderr.on('data', d => cap(String(d)));
        activeDocRuns.set(runId, { child, runtime, dir, cancelled: false });
        child.on('close', codeNum => {
          const entry = activeDocRuns.get(runId);
          activeDocRuns.delete(runId);
          if (entry && entry.cancelled) buf += (buf ? '\n' : '') + '■ cancelled — the kernel was interrupted; its variables are intact';
          resolve({ out: buf, code: codeNum, cancelled: !!(entry && entry.cancelled) });
        });
        child.on('error', e => {
          activeDocRuns.delete(runId);
          const why = e.code === 'ENOENT' ? 'the rat CLI is not installed (or not on the PATH of this server)' : String(e.message);
          resolve({ out: why, code: -1 });
        });
      });
      json(res, 200, { ...result, runtime, ms: Date.now() - t0run });
    } else if (u.pathname === '/api/doc/cancel-run' && req.method === 'POST') {
      // Cancel a running cell: interrupt the kernel first (rat cancel —
      // keeps the namespace), then end the pending run subprocess.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const entry = activeDocRuns.get(String(parsed.runId || ''));
      if (!entry) return json(res, 404, { error: 'no such run (it may have finished already)' });
      entry.cancelled = true;
      const ratHome = path.join(os.homedir(), '.local', 'bin', 'rat');
      const ratBin = fs.existsSync(ratHome) ? ratHome : 'rat';
      const out = await new Promise(resolve => {
        const c = spawn(ratBin, ['cancel', entry.runtime], { cwd: entry.dir, env: process.env });
        let buf = '';
        c.stdout.on('data', d => buf += String(d));
        c.stderr.on('data', d => buf += String(d));
        const timer = setTimeout(() => c.kill('SIGKILL'), 15000);
        c.on('close', code => { clearTimeout(timer); resolve({ out: buf.trim(), code }); });
        c.on('error', e => { clearTimeout(timer); resolve({ out: String(e.message), code: -1 }); });
      });
      // The interrupt normally makes `rat run` return on its own; the kill
      // is a fallback for a wedged pipe.
      setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch {} }, 3000);
      json(res, 200, { ok: out.code === 0, ratCancel: out });
    } else if (u.pathname === '/api/doc/runtime-info' && req.method === 'GET') {
      // What kernel would this document use? Pure passthrough of rat's own
      // resolution — aiconvo adds no logic, so it can never disagree.
      const dir = String(u.searchParams.get('cwd') || '');
      if (!dir || !fs.existsSync(dir)) return json(res, 400, { error: 'cwd required' });
      const lang = /^[a-z0-9]{1,12}$/.test(String(u.searchParams.get('lang') || 'py')) ? String(u.searchParams.get('lang') || 'py') : 'py';
      const ratHome = path.join(os.homedir(), '.local', 'bin', 'rat');
      const ratBin = fs.existsSync(ratHome) ? ratHome : 'rat';
      const out = await new Promise(resolve => {
        const c = spawn(ratBin, ['resolve', lang, '--json'], { cwd: dir, env: process.env });
        let buf = '';
        c.stdout.on('data', d => buf += String(d));
        const timer = setTimeout(() => c.kill('SIGKILL'), 15000);
        c.on('close', () => { clearTimeout(timer); resolve(buf); });
        c.on('error', () => { clearTimeout(timer); resolve(''); });
      });
      try {
        const info = JSON.parse(out);
        // Enrich with what the fix bar needs to be honest: the venv path
        // rat's kernel binds to, and the name of the project's own package
        // (pyproject.toml) — so a failed import of the project itself can
        // offer `uv pip install -e .` instead of a wrong PyPI fetch.
        const root = info.cwd || dir;
        info.venv = fs.existsSync(path.join(root, '.venv')) ? path.join(root, '.venv') : null;
        try {
          const toml = await fsp.readFile(path.join(root, 'pyproject.toml'), 'utf8');
          const m = toml.match(/^\s*name\s*=\s*["']([A-Za-z0-9._-]+)["']/m);
          if (m) info.selfPackage = m[1];
        } catch {}
        json(res, 200, info);
      } catch { json(res, 502, { error: 'rat resolve failed' }); }
    } else if (u.pathname === '/api/doc/install-pkg' && req.method === 'POST') {
      // Install one Python package into the document's project venv, so a
      // failed `import` in a rat cell is one click from working. Facts this
      // design rests on (verified): a live rat kernel imports packages
      // installed into its venv from outside — no restart, no state loss.
      // Boundary: uv does the installing, rat owns the kernel; this server
      // only sequences them. Explicit user click — never automatic.
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const pkg = String(parsed.pkg || '').trim();
      // One PyPI requirement — or the project itself, editable ('-e .').
      // Nothing else: no other flags, no URLs, no spaces.
      const editableSelf = pkg === '-e .';
      if (!editableSelf && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(==[A-Za-z0-9._*+!-]{1,32})?$/.test(pkg)) {
        return json(res, 400, { error: 'not a valid package name' });
      }
      const docDir = parsed.cwd && typeof parsed.cwd === 'string' && fs.existsSync(parsed.cwd) ? parsed.cwd : null;
      if (!docDir) return json(res, 400, { error: 'cwd required' });
      const homeBin = name => { const p = path.join(os.homedir(), name); return fs.existsSync(p) ? p : null; };
      const uvBin = homeBin('.nix-profile/bin/uv') || homeBin('.local/bin/uv') || homeBin('.cargo/bin/uv') || 'uv';
      const ratBin = homeBin('.local/bin/rat') || 'rat';
      const sh = (bin, args, cwd, timeoutMs) => new Promise(resolve => {
        const child = spawn(bin, args, { cwd, env: process.env });
        let buf = '';
        const cap = s => { buf += s; if (buf.length > 100000) { buf = buf.slice(0, 100000); child.kill('SIGKILL'); } };
        child.stdout.on('data', d => cap(String(d)));
        child.stderr.on('data', d => cap(String(d)));
        const timer = setTimeout(() => { cap('\n… (timed out)'); child.kill('SIGKILL'); }, timeoutMs);
        child.on('close', code => { clearTimeout(timer); resolve({ out: buf, code }); });
        child.on('error', e => { clearTimeout(timer); resolve({ out: String(e.message), code: -1 }); });
      });
      // 1. The project root — rat's own resolution, so the venv lands where
      //    the kernel looks for it (rat walks up from the doc's directory).
      const resolved = await sh(ratBin, ['resolve', 'py', '--json'], docDir, 20000);
      let root = docDir;
      try { root = JSON.parse(resolved.out).cwd || docDir; } catch {}
      const venv = path.join(root, '.venv');
      const steps = [];
      // 2. No venv yet? Create it. The kernel (if any) was running on some
      //    other python — it must restart to bind to the new venv. That
      //    resets kernel variables; the client says so honestly.
      let created = false;
      if (!fs.existsSync(venv)) {
        const mk = await sh(uvBin, ['venv'], root, 60000);
        steps.push({ step: 'uv venv', code: mk.code, out: mk.out.slice(-2000) });
        if (mk.code !== 0) return json(res, 200, { error: 'could not create a venv', steps });
        created = true;
      }
      // 3. Install into that exact interpreter — never into system python.
      //    '-e .' installs the project's own package from the project root.
      const args = ['pip', 'install', '--python', path.join(venv, 'bin', 'python'), ...(editableSelf ? ['-e', '.'] : [pkg])];
      const inst = await sh(uvBin, args, root, 180000);
      steps.push({ step: 'uv pip install ' + (editableSelf ? '-e . (this project, editable)' : pkg), code: inst.code, out: inst.out.slice(-4000) });
      if (inst.code !== 0) return json(res, 200, { error: 'install failed', steps });
      // 4a. Editable installs land as a .pth finder hook, and .pth files
      //     are processed only at interpreter STARTUP — a live kernel
      //     cannot see them (verified). Normal wheels need no restart.
      let restarted = false;
      if (editableSelf && !created) {
        let name = 'py';
        try { name = JSON.parse(resolved.out).name || 'py'; } catch {}
        const rs = await sh(ratBin, ['restart', name], docDir, 60000);
        steps.push({ step: 'rat restart ' + name + ' (editable installs need a fresh interpreter)', code: rs.code, out: rs.out.slice(-1000) });
        restarted = rs.code === 0;
      }
      // 4b. Fresh venv: rebind the kernel. `rat restart` is NOT enough
      //     here — the runtime entry in rat's state remembers its old
      //     (no-venv) binding. Stop + remove clears the entry; the next
      //     run re-resolves and picks up the new .venv. (Verified; an
      //     existing venv never reaches this branch.)
      if (created) {
        let name = 'py';
        try { name = JSON.parse(resolved.out).name || 'py'; } catch {}
        const stop = await sh(ratBin, ['stop', name], docDir, 30000);
        steps.push({ step: 'rat stop ' + name, code: stop.code, out: stop.out.slice(-1000) });
        const rm = await sh(ratBin, ['remove', name, '--yes'], docDir, 30000);
        steps.push({ step: 'rat remove ' + name, code: rm.code, out: rm.out.slice(-1000) });
        restarted = rm.code === 0;
      }
      json(res, 200, { ok: true, pkg, venv, created, restarted, steps });
    } else if (u.pathname === '/api/tts' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      try { json(res, 200, await synthesizeSpeech(parsed.text, parsed.rewrite !== false)); }
      catch (e) { json(res, 500, { error: e.message }); }
    } else if (u.pathname === '/api/tts/audio' && req.method === 'GET') {
      const id = String(u.searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
      const wavPath = path.join(TTS_DIR, id + '.wav');
      if (!id || !fs.existsSync(wavPath)) return json(res, 404, { error: 'audio not found' });
      const st = await fsp.stat(wavPath);
      const size = st.size;
      const range = String(req.headers.range || '');
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : size - 1;
        if (start >= size || end >= size || start > end) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + size });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
          'Content-Length': end - start + 1,
        });
        return fs.createReadStream(wavPath, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': size });
      return fs.createReadStream(wavPath).pipe(res);
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
      // Seed the working-agent set right away: the periodic diff below only
      // broadcasts on change, so a fresh client would otherwise start blind.
      // boot + runs let a reconnecting client drop stale run cards and notice
      // a server replacement.
      try {
        res.write('data: ' + JSON.stringify({
          type: 'agents', keys: runningAgentKeys(), boot: BOOT_ID,
          runs: [...agentRunJobs.values()].filter(j => j.status === 'running').map(j => j.id),
        }) + '\n\n');
      } catch {}
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
      // Accepts a path relative to the notes tree (notes, epics/…, projects/…).
      const f = u.searchParams.get('f') || '';
      const abs = path.resolve(NOTES_DIR, f);
      if (!f.endsWith('.md') || !abs.startsWith(NOTES_DIR + path.sep)) return json(res, 400, { error: 'bad name' });
      try { json(res, 200, { file: path.relative(NOTES_DIR, abs), text: await fsp.readFile(abs, 'utf8') }); }
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
      sweepOrphanFanouts();
      await refreshProjectFolds().catch(() => {});
      syncSearchIndex();
      json(res, 200, { ok: true, count: Object.keys(index).length });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.requestTimeout = 0; // distillation can take minutes
server.headersTimeout = 60000;
function ensureLanTls() {
  const dir = path.join(CACHE_DIR, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const stampFile = path.join(dir, 'san.txt');
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map(ip => 'IP:' + ip)].join(',');
  let reuse = false;
  try { reuse = fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.readFileSync(stampFile, 'utf8').trim() === san; } catch {}
  if (!reuse) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
      '-keyout', keyFile, '-out', certFile, '-subj', '/CN=aiconvo', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
    fs.writeFileSync(stampFile, san + '\n');
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}
// ---------- graceful shutdown ----------
// systemd stops the whole cgroup. With KillMode=mixed only this process gets
// the first SIGTERM: abort every active run so pi settles and saves what
// already landed, mark each job with a visible reason, write the durable
// snapshot, then exit. Without this, a restart killed the warm pi children
// mid-answer and the run vanished with no trace.
let shuttingDown = false;
async function shutdownGracefully() {
  if (shuttingDown) return;
  shuttingDown = true;
  const hardExit = setTimeout(() => process.exit(0), 8000);
  try {
    const active = [...headlessRuns.values()];
    for (const record of active) record.yielded = 'aiconvo restarted';
    await Promise.race([
      Promise.allSettled(active.map(async record => {
        try { if (record.handle && record.handle.abort) await record.handle.abort(); } catch {}
        try { if (record.handle && record.handle.done) await record.handle.done; } catch {}
      })),
      sleep(5000),
    ]);
    await sleep(100); // let the finish handlers mark their jobs
    for (const job of agentRunJobs.values()) {
      if (job.status === 'running') {
        job.status = 'done';
        job.statusText = 'stopped — aiconvo restarted';
        job.finishedAt = Date.now();
      }
    }
  } catch {}
  try { stopAllEngineSessions(); } catch {}
  saveAgentRunsNow();
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGTERM', () => { shutdownGracefully(); });
process.on('SIGINT', () => { shutdownGracefully(); });

// ---------- speech preview relay ----------
// The live dictation preview is a WebSocket to the GPU speech stage. Phones
// and HTTPS clients cannot reach that LAN address (Tailscale routes only to
// this laptop; wss: from an HTTPS page cannot use a plain-ws LAN target), so
// the browser connects to this same-origin path and the server pipes bytes
// both ways. No frame parsing: a relay only needs the raw TCP stream.
function speechStreamUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/api/speech/stream') { socket.destroy(); return; }
  if (LAN_TOKEN && !isLocalRequest(req) && !hasLanToken(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const target = new URL(SPEECH_URL);
  const upstream = net.connect(Number(target.port) || 80, target.hostname);
  const drop = () => { try { socket.destroy(); } catch {} try { upstream.destroy(); } catch {} };
  upstream.on('connect', () => {
    const lines = [
      'GET /stream HTTP/1.1',
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
    ];
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (req.headers[name]) lines.push(name + ': ' + req.headers[name]);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', drop);
  socket.on('error', drop);
  upstream.setTimeout(0);
  socket.setTimeout(0);
  socket.setNoDelay(true);
  upstream.setNoDelay(true);
}
server.on('upgrade', speechStreamUpgrade);

server.listen(PORT, HOST, () => {
  console.log(`aiconvo → http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== '::1') {
    for (const ip of lanAddresses()) console.log(`aiconvo LAN → http://${ip}:${PORT}/?token=${LAN_TOKEN}`);
    console.log(`aiconvo LAN token file → ${LAN_TOKEN_FILE}`);
    try {
      const tls = ensureLanTls();
      const tlsServer = https.createServer(tls, (req, res) => server.emit('request', req, res));
      tlsServer.on('upgrade', speechStreamUpgrade);
      tlsServer.listen(TLS_PORT, HOST, () => {
        for (const ip of lanAddresses()) console.log(`aiconvo PWA → https://${ip}:${TLS_PORT}/?token=${LAN_TOKEN}`);
        console.log('Install the tablet icon from the HTTPS URL: browser menu → Add to Home screen.');
      });
    } catch (error) {
      console.log('aiconvo TLS skipped: ' + error.message);
    }
  }
  fullScan().then(() => {
    watch(); watchNotes();
    sweepOrphanFanouts();
    refreshProjectFolds().catch(() => {})
      .then(() => syncSearchIndex())
      .then(() => scheduleSemanticSync(2000));
    seedLeavesFromSnapshots().catch(() => {});
    setInterval(() => { sweepSettledLeaves().catch(() => {}); }, LEAF_SWEEP_MS);
  });
  listPiModels().finally(() => setTimeout(() => listPiModels(true), 2500));
});
