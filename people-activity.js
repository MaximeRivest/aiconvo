'use strict';
// people-activity.js — what each person did in a project (design/55).
//
// Three records already name the person: a user message carries its author
// (design/46), a human save in the file ledger carries user_id and an agent
// edit carries the conversation it came from, and a guest's commit carries
// `<id>@aiconvo` as its email (sandbox.js). This module folds them into one
// per-person account for a time window: the conversations they wrote into
// (with where their last message is), the files that changed by their hand
// or by an agent they were driving, and the commits they made. Pure: the
// server supplies the rows and the readers, and filters by what the asking
// person may see before calling.

const DEFAULT_CAPS = { conversations: 20, files: 30, commits: 20 };

function tsOf(v) { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; }

// A commit's author, as a roster id: `<id>@aiconvo` first (what a guest's
// sandbox writes), then a person on the roster with that exact name.
function commitPersonId(commit, { resolveId, idByName }) {
  const m = /^([^@\s]+)@aiconvo$/.exec(String(commit.email || '').trim());
  if (m) return resolveId(m[1]);
  const byName = idByName(String(commit.author || '').trim());
  return byName ? resolveId(byName) : null;
}

async function projectActivity({
  project, from, to, entries = [], readMessages, fileEvents = [], commits = [],
  resolveId = id => id, userById = () => null, idByName = () => null, exclude = null, caps = DEFAULT_CAPS,
}) {
  const people = new Map(); // canonical id -> account
  const account = id => {
    let a = people.get(id);
    if (!a) {
      a = { id, lastTs: 0, conversations: new Map(), files: new Map(), commits: [], messages: 0 };
      people.set(id, a);
    }
    return a;
  };
  const inWindow = t => t >= from && t <= to;
  const touch = (a, t) => { if (t > a.lastTs) a.lastTs = t; };

  // Conversations: every entry whose participants include someone; their
  // own messages counted from the transcript, newest one kept for "go".
  // Who wrote into which conversation, from the index alone: an agent edit
  // in a conversation counts for its writers even when their last message
  // was before the window (an agent runs on for hours after the prompt).
  const convKeysOf = new Map(); // canonical id -> Set of keys they wrote into
  for (const { key, entry } of entries) {
    if (!entry || !Array.isArray(entry.participants)) continue;
    for (const p of entry.participants) {
      if (!p || !p.id) continue;
      const id = resolveId(p.id);
      if (!convKeysOf.has(id)) convKeysOf.set(id, new Set());
      convKeysOf.get(id).add(key);
    }
  }
  for (const { key, entry } of entries) {
    if (!entry || !Array.isArray(entry.participants) || !entry.participants.length) continue;
    if (tsOf(entry.lastTs) < from) continue;
    let messages = null;
    try { messages = await readMessages(key); } catch { messages = null; }
    if (!Array.isArray(messages)) continue;
    const perPerson = new Map();
    for (const m of messages) {
      if (m.role !== 'user' || !m.author || !m.author.id) continue;
      const t = tsOf(m.ts);
      if (!inWindow(t)) continue;
      for (const who of [m.author, ...(m.author.coauthors || [])]) {
        if (!who || !who.id) continue;
        const id = resolveId(who.id);
        let c = perPerson.get(id);
        if (!c) { c = { n: 0, lastTs: 0, lastEntry: null }; perPerson.set(id, c); }
        c.n++;
        if (t >= c.lastTs) { c.lastTs = t; c.lastEntry = m.eid || null; }
      }
    }
    for (const [id, c] of perPerson) {
      const a = account(id);
      a.conversations.set(key, { key, title: entry.timelineTitle || entry.title || key, messages: c.n, lastTs: c.lastTs, lastEntry: c.lastEntry, started: resolveId(entry.createdBy || '') === id });
      a.messages += c.n;
      touch(a, c.lastTs);
    }
  }

  // Files: a human save names its person; an agent edit names the
  // conversation, and the conversation's writers were driving it.
  for (const ev of fileEvents) {
    if (!ev || !inWindow(Number(ev.ts)) || ev.outcome === 'failed') continue;
    const owners = [];
    if (ev.actor === 'human' && ev.user_id) owners.push({ id: resolveId(ev.user_id), via: 'saved', convKey: null });
    else if (ev.actor === 'ai' && ev.conv_key) for (const [id, keys] of convKeysOf) if (keys.has(ev.conv_key)) owners.push({ id, via: 'agent', convKey: ev.conv_key });
    for (const o of owners) {
      const a = account(o.id);
      const k = ev.path + '\0' + o.via;
      let f = a.files.get(k);
      if (!f) { f = { path: ev.path, repoRoot: ev.repo_root || '', via: o.via, convKey: o.convKey, n: 0, added: 0, removed: 0, ts: 0 }; a.files.set(k, f); }
      f.n++;
      f.added += Number(ev.added) || 0;
      f.removed += Number(ev.removed) || 0;
      if (Number(ev.ts) > f.ts) { f.ts = Number(ev.ts); f.convKey = o.convKey; }
      touch(a, Number(ev.ts));
    }
  }

  // Commits: by the sandbox's email, or an exact roster name.
  const seenCommits = new Set();
  for (const c of commits) {
    if (!c || !c.hash || seenCommits.has(c.hash)) continue;
    const t = tsOf(c.ts);
    if (!inWindow(t)) continue;
    const id = commitPersonId(c, { resolveId, idByName });
    if (!id) continue;
    seenCommits.add(c.hash);
    const a = account(id);
    a.commits.push({ hash: c.hash, shortHash: c.shortHash || String(c.hash).slice(0, 7), ts: t, subject: c.subject || '', repoRoot: c.repoRoot || '', files: Array.isArray(c.files) ? c.files.length : 0 });
    touch(a, t);
  }

  const byTs = (x, y) => (y.lastTs || y.ts) - (x.lastTs || x.ts);
  const out = [];
  for (const [id, a] of people) {
    if (exclude && id === exclude) continue;
    const conversations = [...a.conversations.values()].sort(byTs);
    const files = [...a.files.values()].sort(byTs);
    const commitsOut = a.commits.sort(byTs);
    out.push({
      user: userById(id) || { id, name: 'someone' },
      lastTs: a.lastTs,
      counts: { messages: a.messages, conversations: conversations.length, files: files.length, commits: commitsOut.length },
      conversations: conversations.slice(0, caps.conversations),
      files: files.slice(0, caps.files),
      commits: commitsOut.slice(0, caps.commits),
    });
  }
  out.sort((x, y) => y.lastTs - x.lastTs);
  return { project, from, to, people: out };
}

module.exports = { projectActivity, commitPersonId, DEFAULT_CAPS };
