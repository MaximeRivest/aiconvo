'use strict';
// What each person did in a project (people-activity.js): messages by
// author, files by hand or by their agent, commits by the sandbox's email
// or a roster name — inside one window, never counting the asker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectActivity, commitPersonId } = require('../people-activity.js');

const T0 = Date.parse('2026-09-21T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const roster = {
  u_max: { id: 'u_max', name: 'Maxime' },
  u_sam: { id: 'u_sam', name: 'Sam' },
  u_lil: { id: 'u_lil', name: 'Lilly' },
};
const alias = { u_sam2: 'u_sam' }; // Sam's second device id merged into Sam
const resolveId = id => alias[id] || id;
const userById = id => roster[id] || null;
const idByName = name => (Object.values(roster).find(u => u.name === name) || {}).id || null;

const entries = [
  { key: 'k1', entry: { title: 'the open plan', timelineTitle: 'open plan', lastTs: iso(T0 + 3600e3), createdBy: 'u_sam2', participants: [{ id: 'u_sam2' }, { id: 'u_max' }] } },
  { key: 'k2', entry: { title: 'old talk', lastTs: iso(T0 - 48 * 3600e3), participants: [{ id: 'u_sam' }] } },
  { key: 'k3', entry: { title: 'nobody recorded', lastTs: iso(T0 + 100e3), participants: [] } },
];
const transcripts = {
  k1: [
    { role: 'user', text: 'hi', ts: iso(T0 + 60e3), eid: 'e1', author: { id: 'u_sam2', name: 'Sam' } },
    { role: 'assistant', text: 'ok', ts: iso(T0 + 61e3), eid: 'e2' },
    { role: 'user', text: 'more', ts: iso(T0 + 600e3), eid: 'e3', author: { id: 'u_sam', name: 'Sam', coauthors: [{ id: 'u_lil', name: 'Lilly' }] } },
    { role: 'user', text: 'mine', ts: iso(T0 + 700e3), eid: 'e4', author: { id: 'u_max', name: 'Maxime' } },
    { role: 'user', text: 'way before', ts: iso(T0 - 10 * 86400e3), eid: 'e0', author: { id: 'u_sam' } },
  ],
};
const fileEvents = [
  { ts: T0 + 120e3, path: '/p/a.js', repo_root: '/p', actor: 'ai', conv_key: 'k1', added: 10, removed: 2, outcome: 'applied' },
  { ts: T0 + 130e3, path: '/p/a.js', repo_root: '/p', actor: 'ai', conv_key: 'k1', added: 1, removed: 1, outcome: 'failed' },
  { ts: T0 + 200e3, path: '/p/b.md', repo_root: '/p', actor: 'human', user_id: 'u_sam2', added: 5, removed: 0, outcome: 'applied' },
  { ts: T0 + 210e3, path: '/p/b.md', repo_root: '/p', actor: 'human', user_id: 'u_sam', added: 3, removed: 1, outcome: 'applied' },
  { ts: T0 + 220e3, path: '/p/c.md', repo_root: '/p', actor: 'human', user_id: 'u_max', added: 3, removed: 1, outcome: 'applied' },
  { ts: T0 + 230e3, path: '/p/z.js', repo_root: '/p', actor: 'ai', conv_key: 'k2', added: 3, removed: 1, outcome: 'applied' }, // Sam's older conversation, agent still at work
  { ts: T0 + 240e3, path: '/p/x.js', repo_root: '/p', actor: 'ai', conv_key: 'k3', added: 3, removed: 1, outcome: 'applied' }, // nobody recorded: the owner's, unnamed
];
const commits = [
  { hash: 'aaaa1111', shortHash: 'aaaa111', ts: iso(T0 + 900e3), author: 'Sam', email: 'u_sam2@aiconvo', subject: 'add a', repoRoot: '/p', files: [{ path: 'a.js' }] },
  { hash: 'bbbb2222', shortHash: 'bbbb222', ts: iso(T0 + 950e3), author: 'Lilly', email: 'lilly@example.com', subject: 'by name', repoRoot: '/p', files: [] },
  { hash: 'cccc3333', shortHash: 'cccc333', ts: iso(T0 + 960e3), author: 'Stranger', email: 'x@example.com', subject: 'not ours', repoRoot: '/p', files: [] },
  { hash: 'aaaa1111', shortHash: 'aaaa111', ts: iso(T0 + 900e3), author: 'Sam', email: 'u_sam2@aiconvo', subject: 'add a (second checkout lists it too)', repoRoot: '/p2', files: [] },
];

test('one account per person: conversations with their last message, files by hand and by agent, commits', async () => {
  const out = await projectActivity({ project: 'p', from: T0 - 86400e3, to: T0 + 86400e3, entries, readMessages: async k => transcripts[k] || null, fileEvents, commits, resolveId, userById, idByName, exclude: 'u_max' });
  const names = out.people.map(p => p.user.name);
  assert.deepEqual(names, ['Lilly', 'Sam'], 'newest first (Lilly committed last), the asker left out');
  const sam = out.people[1];
  assert.deepEqual(sam.counts, { messages: 2, conversations: 1, files: 3, commits: 1 });
  assert.equal(sam.conversations[0].key, 'k1');
  assert.equal(sam.conversations[0].messages, 2, 'the message before the window does not count');
  assert.equal(sam.conversations[0].lastEntry, 'e3', 'where their last message is');
  assert.equal(sam.conversations[0].started, true, 'created by their other device id');
  const byPath = Object.fromEntries(sam.files.map(f => [f.path + ':' + f.via, f]));
  assert.deepEqual({ n: byPath['/p/b.md:saved'].n, added: byPath['/p/b.md:saved'].added, removed: byPath['/p/b.md:saved'].removed }, { n: 2, added: 8, removed: 1 }, 'two device ids, one person, one file');
  assert.equal(byPath['/p/a.js:agent'].n, 1, 'the failed edit is not counted');
  assert.equal(byPath['/p/a.js:agent'].convKey, 'k1');
  assert.equal(byPath['/p/z.js:agent'].convKey, 'k2', 'an agent edit in an older conversation of theirs still counts');
  assert.equal(sam.commits.length, 1, 'the same commit seen from two checkouts is one commit');
  assert.equal(sam.commits[0].subject, 'add a');
  const lilly = out.people[0];
  assert.deepEqual(lilly.counts, { messages: 1, conversations: 1, files: 0, commits: 1 }, 'a coauthor counts; a commit matches by exact roster name');
  assert.ok(!JSON.stringify(out).includes('/p/x.js'), 'edits nobody is recorded for belong to no one here');
});

test('the window bounds everything, and caps trim the lists', async () => {
  const out = await projectActivity({ project: 'p', from: T0 + 650e3, to: T0 + 86400e3, entries, readMessages: async k => transcripts[k] || null, fileEvents, commits, resolveId, userById, idByName, caps: { conversations: 1, files: 1, commits: 0 } });
  const sam = out.people.find(p => p.user.name === 'Sam');
  assert.ok(sam, 'Sam still has a commit in the window');
  assert.equal(sam.counts.messages, 0);
  assert.equal(sam.counts.commits, 1);
  assert.equal(sam.commits.length, 0, 'capped');
  const max = out.people.find(p => p.user.name === 'Maxime');
  assert.equal(max.counts.messages, 1, 'nobody excluded: the owner appears too');
});

test('commit attribution: the sandbox email wins, then an exact roster name, else nobody', () => {
  const opts = { resolveId, idByName };
  assert.equal(commitPersonId({ email: 'u_sam2@aiconvo', author: 'Whoever' }, opts), 'u_sam');
  assert.equal(commitPersonId({ email: 'lilly@example.com', author: 'Lilly' }, opts), 'u_lil');
  assert.equal(commitPersonId({ email: 'x@example.com', author: 'Nobody' }, opts), null);
});
