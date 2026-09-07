'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'lost']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function rootPath(options = {}) {
  return path.resolve(options.root || process.env.PI_DELEGATION_ROOT || path.join(os.homedir(), '.local/share/aiconvo/delegations'));
}
function taskDir(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid delegation ID');
  return path.join(root, id);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); syncDir(path.dirname(file)); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function appendEvent(dir, type, data = {}) {
  const fd = fs.openSync(path.join(dir, 'events.jsonl'), 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ version: 1, at: Date.now(), type, ...data }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
// Linux boot ID and start ticks distinguish reused process IDs, including across reboot.
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return { pid, start: fields[19], boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pgrp: Number(fields[2]) };
  } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return null; throw e; }
}
function sameProcess(saved) {
  if (!saved) return false;
  const live = identity(saved.pid);
  return !!live && live.start === saved.start && live.boot === saved.boot;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function text(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw new Error(`${name} must be a non-empty string, at most ${max} characters`);
  return value;
}
function tools(value) {
  if (!Array.isArray(value) || value.length > 256 || value.some(t => typeof t !== 'string' || !/^[\w.-]+$/.test(t))) throw new Error('tools must be an array of tool names');
  if (new Set(value).size !== value.length) throw new Error('tools must not contain duplicates');
  return [...value];
}
function sameTools(a, b) { return Array.isArray(a) && Array.isArray(b) && canonicalJson([...a].sort()) === canonicalJson([...b].sort()); }
function normalizeMode(raw) {
  const allowed = ['key', 'label', 'opener', 'appendix', 'systemPrompt', 'removeSections', 'tools'];
  const sections = ['available_tools', 'custom_tools_note', 'guidelines', 'pi_docs', 'append_prompt', 'project_context', 'skills', 'date', 'cwd'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('Invalid ModeDef fields');
  if (typeof raw.key !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(raw.key)) throw new Error('Invalid mode key');
  const mode = { key: raw.key, label: text(raw.label, 'mode.label', 256).trim() };
  for (const key of ['opener', 'appendix', 'systemPrompt']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 256 * 1024 || raw[key].includes('\0'))) throw new Error(`Invalid mode.${key}`);
    if (raw[key]?.trim()) mode[key] = key === 'opener' ? raw[key].trim() : raw[key];
  }
  if (!mode.opener && !mode.appendix && !mode.systemPrompt) throw new Error('Mode requires opener, appendix, or systemPrompt');
  if (raw.removeSections !== undefined) {
    if (!Array.isArray(raw.removeSections) || raw.removeSections.some(s => !sections.includes(s))) throw new Error('Invalid mode.removeSections');
    if (raw.removeSections.length) mode.removeSections = [...raw.removeSections];
  }
  if (raw.tools !== undefined) mode.tools = tools(raw.tools);
  return mode;
}
function readTask(root, id) {
  const dir = taskDir(root, id);
  const spec = readJson(path.join(dir, 'request.json'));
  const state = readJson(path.join(dir, 'state.json'), {});
  const lost = readJson(path.join(dir, 'lost.json'), null);
  const review = readJson(path.join(dir, 'review.json'), {});
  const pause = readJson(path.join(dir, 'pause.json'), {});
  const cancel = readJson(path.join(dir, 'cancel.json'), {});
  const supervision = readJson(path.join(dir, 'supervision.json'), {});
  return { ...spec, ...state, supervision: supervision.kind || null, survivesServiceRestart: supervision.survivesServiceRestart === true, ...(lost && !TERMINAL.has(state.status) ? lost : {}), ...review,
    paused: !!pause.paused, cancelRequested: !!cancel.at,
    updatedAt: Math.max(spec.updatedAt, state.updatedAt || 0, lost?.updatedAt || 0, review.updatedAt || 0, pause.at || 0, cancel.at || 0) };
}
function allIds(root) {
  try { return fs.readdirSync(root).filter(id => ID.test(id) && fs.existsSync(path.join(root, id, 'request.json'))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function ancestors(root, task) {
  const result = [task];
  const seen = new Set([task.id]);
  while (result.at(-1).parentTaskId) {
    const id = result.at(-1).parentTaskId;
    if (seen.has(id) || result.length >= 256) throw new Error('Invalid or excessive delegation ancestry');
    seen.add(id); result.push(readTask(root, id));
  }
  return result;
}
function gate(root, task) {
  const chain = ancestors(root, task);
  return { cancelled: chain.some(t => t.cancelRequested || t.status === 'cancelled'), paused: chain.some(t => t.paused) };
}
// Strict LF framing. Oversize lines are skipped without retaining their contents.
function jsonLines(onObject, onProblem = () => {}, max = 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '', dropping = false;
  function line(s) {
    if (!s.trim()) return;
    try { onObject(JSON.parse(s)); } catch (e) { onProblem('invalid JSON line'); }
  }
  function pushString(s) {
    let start = 0;
    for (;;) {
      const end = s.indexOf('\n', start);
      const part = s.slice(start, end < 0 ? undefined : end);
      if (!dropping) {
        if (pending.length + part.length > max) {
          const prefix = (pending.slice(0, 256) + part.slice(0, 256)).slice(0, 256);
          pending = ''; dropping = true; onProblem('oversize JSON line', { prefix });
        }
        else pending += part;
      }
      if (end < 0) break;
      if (!dropping) line(pending);
      pending = ''; dropping = false; start = end + 1;
    }
  }
  return { push(chunk) { pushString(typeof chunk === 'string' ? chunk : decoder.write(chunk)); }, end() { pushString(decoder.end()); if (pending && !dropping) line(pending); pending = ''; } };
}
async function scanJsonLines(file, onObject, onProblem) {
  const parser = jsonLines(onObject, onProblem);
  for await (const chunk of fs.createReadStream(file)) parser.push(chunk);
  parser.end();
}
module.exports = { TERMINAL, ID, rootPath, taskDir, readJson, atomic, appendEvent, syncDir, identity, sameProcess,
  canonicalJson, sha256, text, tools, sameTools, normalizeMode, readTask, allIds, ancestors, gate, jsonLines, scanJsonLines };
