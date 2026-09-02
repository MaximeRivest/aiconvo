'use strict';
// Agent inbox read state, shared by every device that talks to this server.
//
// One conversation is "unread" when its last activity (transcript mtime, or
// the moment a web run ended) is newer than the last time a person read it on
// ANY device. The server is the single owner of this state; browsers keep a
// local copy for instant boot and push their reads here.
//
// Clock rule: the server clock wins. A read timestamp is never lower than the
// server's now, the transcript's mtime, or the recorded finish time, so a phone
// with a skewed clock cannot hide a reply that lands a moment later.
//
// `since` is the first-use guard: activity older than it is treated as read,
// so enabling the feature (or wiping the state) never floods the inbox with
// every old conversation.

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

function createState(now = Date.now()) {
  return { since: now, read: {}, finished: {} };
}

function normalize(raw, now = Date.now()) {
  const state = createState(now);
  if (!raw || typeof raw !== 'object') return state;
  if (num(raw.since)) state.since = num(raw.since);
  for (const [k, v] of Object.entries(raw.read || {})) if (k && num(v)) state.read[k] = num(v);
  for (const [k, v] of Object.entries(raw.finished || {})) if (k && num(v)) state.finished[k] = num(v);
  return state;
}

// A person read `key`. Returns the delta to broadcast ({ read: { key: at } })
// or null when nothing moved.
function markRead(state, key, { now = Date.now(), mtimeMs = 0 } = {}) {
  if (!key) return null;
  const at = Math.max(num(now), num(mtimeMs), num(state.finished[key]), num(state.read[key]));
  const changed = at !== state.read[key] || key in state.finished;
  state.read[key] = at;
  delete state.finished[key];
  return changed ? { read: { [key]: at } } : null;
}

// A run on `key` ended at `at` (server time). The finish time survives even
// when the transcript file did not change (aborted or failed runs), so the
// reply still reaches the inbox on every device.
function markFinished(state, key, at = Date.now()) {
  if (!key) return null;
  const t = Math.max(num(at), num(state.finished[key]));
  if (t === state.finished[key]) return null;
  state.finished[key] = t;
  return { finished: { [key]: t } };
}

// One-time import of a browser's old local state. Raw merge: reads keep their
// original times (bumping them to now would silently mark unread replies as
// read), `since` takes the earliest guard so nothing a device already showed
// as unread disappears.
function importState(state, raw) {
  const incoming = normalize(raw, state.since);
  const delta = { read: {}, finished: {} };
  let changed = false;
  if (incoming.since < state.since) { state.since = incoming.since; delta.since = state.since; changed = true; }
  for (const [k, v] of Object.entries(incoming.read)) {
    if (v > num(state.read[k])) { state.read[k] = v; delta.read[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(incoming.finished)) {
    // A finish that a read already covers is not new activity.
    if (v > num(state.finished[k]) && v > num(state.read[k])) { state.finished[k] = v; delta.finished[k] = v; changed = true; }
  }
  return changed ? delta : null;
}

// Time of the newest unread activity for `key`, or 0 when it is read.
function unreadAt(state, key, mtimeMs = 0) {
  const activity = Math.max(num(mtimeMs), num(state.finished[key]));
  const read = Math.max(num(state.since), num(state.read[key]));
  return activity > read ? activity : 0;
}

module.exports = { createState, normalize, markRead, markFinished, importState, unreadAt };
