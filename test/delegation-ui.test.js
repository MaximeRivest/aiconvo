'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('../delegation-ui.js');
const task = (id, extra = {}) => ({ id, title: id, parentTaskId: null, parentKey: 'origin', key: 'child-' + id,
  parentEntryId: 'entry-a', status: 'running', review: 'unreviewed', createdAt: 1, ...extra });

test('recursive work uses only explicit ancestry and exact conversation/entry identity', () => {
  const index = D.indexTasks([
    task('a'), task('b', { parentTaskId: 'a', parentKey: 'child-a' }),
    task('c', { parentEntryId: 'entry-b' }), task('unrelated', { parentKey: 'other', cwd: '/same' }),
  ]);
  const scope = D.contextTasks(index, 'origin', 'entry-a');
  assert.deepEqual([...scope.selected], ['a', 'b']);
  assert.deepEqual([...scope.other], ['c']);
  assert.deepEqual(scope.selectedRoots, ['a']);
  assert.deepEqual(scope.roots, ['c']);
  assert.equal(D.contextTasks(index, 'child-a').self.id, 'a');
  assert.equal(D.contextTasks(index, 'other', 'entry-b').selected.size, 0);
  assert.deepEqual(D.parentTarget(index.byId.get('b')), { key: 'child-a', entryId: 'entry-a' });
});

test('cycles, missing parents, duplicate IDs, and invalid records remain bounded and discoverable', () => {
  const index = D.indexTasks([null, {}, task('a', { parentTaskId: 'b' }), task('b', { parentTaskId: 'a' }),
    task('orphan', { parentTaskId: 'missing' }), task('self', { parentTaskId: 'self' }),
    task('__proto__'), task('a', { title: 'new title', parentTaskId: 'b', updatedAt: 2 })]);
  assert.equal(index.tasks.length, 5);
  assert.equal(index.byId.get('a').title, 'new title');
  assert.equal(D.descendants(index, index.roots).size, 5);
  assert.equal(index.warnings.size, 3);
  assert.match(index.warnings.get('orphan'), /outside this snapshot/);
  assert.match(D.cancellationMessage(index, 'b'), /2 tasks/, 'cycle display repair must not undercount the recorded subtree');
  assert.deepEqual(D.indexTasks(null).roots, []);
});

test('a 2000-level task chain has no recursive stack limit or arbitrary truncation', () => {
  const tasks = Array.from({ length: 2000 }, (_, i) => task(String(i), {
    parentTaskId: i ? String(i - 1) : null, parentKey: i ? 'child-' + (i - 1) : 'origin',
  }));
  const index = D.indexTasks(tasks);
  assert.equal(D.descendants(index, index.roots).size, 2000);
  assert.equal(D.contextTasks(index, 'origin').all.size, 2000);
});

test('execution never accepts generated work or treats lost as success', () => {
  for (const status of ['planned', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'lost']) {
    assert.deepEqual(D.taskState({ status }), { execution: status, review: 'unreviewed' });
  }
  assert.deepEqual(D.taskState({ status: 'succeeded', review: 'accepted' }), { execution: 'succeeded', review: 'accepted' });
  assert.deepEqual(D.taskState({ status: 'done', review: 'read' }), { execution: 'unknown', review: 'unreviewed' });
});

test('process deduplication requires saved identity, never PID or cwd alone', () => {
  const index = D.indexTasks([task('a', { pid: 10, cwd: '/same', sessionPath: '/saved/a' })]);
  assert.equal(D.trackedProcess(index, { pid: 10, cwd: '/same' }), false);
  assert.equal(D.trackedProcess(index, { key: 'unrelated' }), false);
  assert.equal(D.trackedProcess(index, { key: 'child-a', pid: 99 }), true);
  assert.equal(D.trackedProcess(index, { sessionPath: '/saved/a' }), true);
  assert.equal(D.trackedProcess(index, { delegationId: 'a' }), true);
});

test('cancellation states the full subtree count and does not promise immediate termination', () => {
  const index = D.indexTasks([task('a'), task('b', { parentTaskId: 'a', status: 'succeeded' }), task('c', { parentTaskId: 'b' })]);
  assert.match(D.cancellationMessage(index, 'a'), /3 tasks/);
  assert.match(D.cancellationMessage(index, 'a'), /after the supervisor/);
  assert.match(D.cancellationMessage(index, 'a'), /Completed work stays saved/);
});

test('malicious labels escape HTML and detail payloads have bounded prompt, mode, and log text', () => {
  assert.equal(D.escape('<img src=x onerror="bad()">&\''), '&lt;img src=x onerror=&quot;bad()&quot;&gt;&amp;&#39;');
  const detail = D.detailText({ prompt: 'p'.repeat(30000), mode: 'm'.repeat(30000), logTail: 'l'.repeat(20000) + 'END' });
  assert.ok(detail.includes('p'.repeat(24000)) && !detail.includes('p'.repeat(24001)));
  assert.ok(detail.includes('m'.repeat(24000)) && !detail.includes('m'.repeat(24001)));
  assert.ok(detail.includes('END') && !detail.includes('l'.repeat(16001)));
  assert.match(detail, /Full log:/);
  assert.match(detail, /Standard error/);
});

// A small DOM fixture tests the actual controller with no packages, live
// APIs, model launches, browser profiles, or filesystem mutations.
class Node {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.dataset = {}; this.attrs = {}; this._text = ''; this.hidden = false; this.open = false; }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Delegation content must not use innerHTML'); }
  get isConnected() { return this === this.doc.body || !!this.parentNode?.isConnected; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.remove(); const i = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(i >= 0); this.children.splice(i, 0, node); node.parentNode = this;
  }
  remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
  focus() { this.doc.activeElement = this; }
  click() { if (!this.disabled) return this.onclick?.(); }
}
function fixture(t, tasks, overrides = {}) {
  const document = { createElement(tag) { return new Node(tag, this); } };
  document.body = document.createElement('body');
  const host = document.createElement('div'); document.body.append(host);
  const calls = [], opened = [], confirms = [];
  let records = tasks, isVisible = true, failure = false;
  const controller = D.createController({ document,
    visible: () => isVisible,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (failure) return { ok: false, json: async () => ({ error: 'offline' }) };
      if (url.includes('/detail?')) return { ok: true, json: async () => ({ prompt: '<script>bad()</script>', mode: { tools: ['read'] }, logTail: 'tail' }) };
      if (url.endsWith('/control')) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ tasks: records, revision: 'v1' }) };
    },
    openTarget: target => opened.push(target), confirm: message => { confirms.push(message); return true; },
    ...overrides,
  });
  t.after(() => controller.destroy());
  return { controller, document, host, calls, opened, confirms,
    setRecords: value => { records = value; }, hide: () => { isVisible = false; }, fail: () => { failure = true; } };
}
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found; } }
function cls(node, name) { return find(node, n => n.className === name); }
function row(host, id) { return find(host, n => n.dataset.delegationId === id); }
function control(host, label) { return find(host, n => n.tagName === 'BUTTON' && n.textContent === label); }
function expand(node) { node.open = true; return node.ontoggle?.(); }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('tree package membership matches raw entries and source sessions without inventing branch identity', () => {
  const index = D.indexTasks([task('a'), task('b', { parentKey: 'fork', parentEntryId: 'entry-a' })]);
  const view = D.contextTasks(index, 'origin', ['end-of-package'], {
    familyKeys: ['origin', 'fork'], entryRefs: [{ key: 'origin', id: 'entry-a' }],
  });
  assert.deepEqual([...view.selected], ['a']);
  assert.deepEqual([...view.other], ['b']);
});

test('new conversations start collapsed and returning restores their disclosure state', async t => {
  const f = fixture(t, [task('a'), task('b', { parentKey: 'other-origin' })]);
  f.controller.mount(f.host, { kind: 'conversation', key: 'origin' }); await f.controller.refresh();
  expand(cls(f.host, 'delegation-main'));
  f.controller.mount(f.host, { kind: 'conversation', key: 'other-origin' });
  assert.equal(cls(f.host, 'delegation-main').open, false);
  f.controller.mount(f.host, { kind: 'conversation', key: 'origin' });
  assert.equal(cls(f.host, 'delegation-main').open, true);
});

test('actual rendering uses text nodes, lazily expands depth, and retains focus and details during updates', async t => {
  const evil = '<img src=x onerror="bad()">';
  const f = fixture(t, [task('a', { title: evil }), task('b', { parentTaskId: 'a', parentKey: 'child-a' }), task('c', { parentTaskId: 'b', parentKey: 'child-b' })]);
  f.controller.mount(f.host, { kind: 'agents' });
  await f.controller.refresh();
  const a = row(f.host, 'a');
  assert.ok(a.textContent.includes(evil));
  assert.equal(find(f.host, n => n.tagName === 'IMG'), undefined);
  assert.equal(row(f.host, 'b'), undefined, 'deeper DOM is not built until requested');
  expand(cls(a, 'delegation-children'));
  assert.ok(row(f.host, 'b'));
  assert.equal(row(f.host, 'c'), undefined);
  const pause = control(a, 'Pause new descendants'); pause.focus();
  const info = cls(a, 'delegation-info'); expand(info); await settle();
  assert.equal(f.calls.filter(c => c.url.includes('/detail?')).length, 1);
  assert.ok(info.textContent.includes('<script>bad()</script>'));
  f.setRecords([task('a', { title: evil, status: 'succeeded' }), task('b', { parentTaskId: 'a', parentKey: 'child-a' })]);
  await f.controller.refresh();
  assert.equal(row(f.host, 'a'), a);
  assert.equal(f.document.activeElement, pause);
  assert.equal(cls(a, 'delegation-info'), info);
  assert.equal(info.open, true);
  assert.equal(cls(a, 'delegation-children').open, true);
  assert.match(a.textContent, /Execution: succeeded · Parent review: unreviewed/);
  assert.equal(f.calls.filter(c => c.url.includes('/detail?')).length, 1, 'snapshot updates never read logs');
});

test('tree selection isolates exact tasks while conversation-level work stays discoverable', async t => {
  const f = fixture(t, [task('a'), task('b', { parentEntryId: 'entry-b' })]);
  f.controller.mount(f.host, { kind: 'tree', key: 'origin', entryId: 'entry-a' });
  await f.controller.refresh();
  assert.ok(row(f.host, 'a'));
  assert.equal(row(f.host, 'b'), undefined);
  const other = find(f.host, n => n.tagName === 'DETAILS' && n.children[0]?.textContent.startsWith('Other work'));
  assert.match(other.textContent, /\(1\)/);
  expand(other); assert.ok(row(f.host, 'b'));
  assert.equal(control(f.host, 'fork'), undefined);
  assert.equal(control(f.host, 'branch'), undefined);
  f.controller.mount(f.host, { kind: 'tree', key: 'origin', entryId: 'entry-b' });
  const selected = find(f.host, n => n.tagName === 'DETAILS' && n.children[0]?.textContent.startsWith('From selected'));
  assert.ok(row(selected, 'b'));
  assert.equal(row(selected, 'a'), undefined);
});

test('completed child keeps parent link outside the closed work block and opens exact launch entry', async t => {
  const f = fixture(t, [task('a', { status: 'succeeded' })]);
  f.controller.mount(f.host, { kind: 'conversation', key: 'child-a' });
  await f.controller.refresh();
  const parent = cls(f.host, 'delegation-parent');
  assert.equal(parent.hidden, false);
  assert.equal(cls(f.host, 'delegation-main').open, false);
  control(parent, 'Parent launch point').click();
  assert.deepEqual(f.opened, [{ key: 'origin', entryId: 'entry-a' }]);
});

test('controls confirm subtree cancellation, report requests, and never write review', async t => {
  const f = fixture(t, [task('a'), task('b', { parentTaskId: 'a', parentKey: 'child-a' })]);
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  const a = row(f.host, 'a');
  await control(a, 'Pause new descendants').click();
  assert.match(cls(a, 'delegation-notice').textContent, /Running workers continue/);
  f.setRecords([task('a', { paused: true }), task('b', { parentTaskId: 'a', parentKey: 'child-a' })]);
  await f.controller.refresh();
  await control(a, 'Resume new descendants').click();
  await control(a, 'Cancel subtree…').click();
  assert.match(f.confirms[0], /2 tasks/);
  assert.match(cls(a, 'delegation-notice').textContent, /Waiting for supervisor/);
  const mutations = f.calls.filter(c => c.options?.method === 'POST').map(c => JSON.parse(c.options.body));
  assert.deepEqual(mutations, [{ id: 'a', action: 'pause' }, { id: 'a', action: 'resume' }, { id: 'a', action: 'cancel' }]);
});

test('declining cancellation sends no mutation and controls show request failures', async t => {
  const f = fixture(t, [task('a')], { confirm: () => false });
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  await control(f.host, 'Cancel subtree…').click();
  assert.equal(f.calls.filter(c => c.options?.method === 'POST').length, 0);
  f.fail(); await control(f.host, 'Pause new descendants').click();
  assert.match(cls(f.host, 'delegation-notice').textContent, /offline/);
});

test('hidden surfaces do not fetch, failures retain prior tasks, and a retry control stays available', async t => {
  const f = fixture(t, [task('a')]);
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  f.fail(); await f.controller.refresh();
  assert.ok(row(f.host, 'a'));
  assert.match(f.host.textContent, /last saved snapshot/);
  assert.equal(control(f.host, 'Retry delegation snapshot').hidden, false);
  f.hide(); const count = f.calls.length;
  f.controller.visibilityChanged(); await f.controller.invalidate();
  assert.equal(f.calls.length, count);
});

test('collapsed ancestors show unread results without accepting them or labelling live prompts as replies', async t => {
  const f = fixture(t, [task('a'), task('b', { parentTaskId: 'a', parentKey: 'child-a', status: 'succeeded' })], { unread: () => true });
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  assert.match(cls(f.host, 'delegation-main').children[0].textContent, /1 unread reply/);
  const a = row(f.host, 'a');
  assert.doesNotMatch(cls(a, 'delegation-state').textContent, /Unread reply/);
  assert.match(cls(a, 'delegation-children').children[0].textContent, /1 unread reply/);
  assert.equal(row(f.host, 'b'), undefined);
  expand(cls(a, 'delegation-children'));
  assert.match(cls(row(f.host, 'b'), 'delegation-state').textContent, /Parent review: unreviewed.*Unread reply/);
});

test('a cancelled subtree clears its pending notice only after the snapshot has no active tasks', async t => {
  const f = fixture(t, [task('a')]);
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  await control(f.host, 'Cancel subtree…').click();
  f.setRecords([task('a', { status: 'cancelled' })]); await f.controller.refresh();
  assert.match(cls(f.host, 'delegation-notice').textContent, /no active tasks/);
  assert.equal(control(f.host, 'Cancel subtree…').disabled, true);
});

test('snapshot refreshes never navigate, fetch logs, or change scroller positions', async t => {
  const f = fixture(t, [task('a')]);
  f.host.scrollTop = 42; f.host.scrollLeft = 9;
  f.document.body.scrollTop = 210; f.document.body.scrollLeft = 0;
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  f.setRecords([task('a', { status: 'failed' }), task('b')]); await f.controller.invalidate();
  assert.deepEqual([f.host.scrollTop, f.host.scrollLeft, f.document.body.scrollTop], [42, 9, 210]);
  assert.deepEqual(f.opened, []);
  assert.ok(f.calls.every(call => call.url === '/api/delegations'));
});

test('fallback polling runs at 30 seconds only while an appropriate surface is visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, [task('a')]);
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  const initial = f.calls.length;
  t.mock.timers.tick(29999); await settle();
  assert.equal(f.calls.length, initial);
  t.mock.timers.tick(1); await settle();
  assert.equal(f.calls.length, initial + 1);
  f.hide(); f.controller.visibilityChanged();
  t.mock.timers.tick(120000); await settle();
  assert.equal(f.calls.length, initial + 1);
});

test('concurrent invalidations share a request and reconcile one more snapshot afterward', async t => {
  let release;
  let calls = 0;
  const f = fixture(t, [], { fetch: async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ tasks: [task('a')] }) };
  } });
  f.controller.mount(f.host, { kind: 'agents' });
  const first = f.controller.refresh();
  const second = f.controller.invalidate();
  f.controller.invalidate();
  assert.equal(calls, 1);
  release(); await first; await second; await settle();
  assert.equal(calls, 2);
  assert.ok(row(f.host, 'a'));
});

test('dispatching an entry route again restores the exact launch target without fork or branch calls', () => {
  const html = fs.readFileSync(require.resolve('../app.html'), 'utf8');
  const start = html.indexOf('function dispatchHash(h) {');
  const code = html.slice(start, html.indexOf('// ---- route segments ----', start));
  const opened = [];
  const context = vm.createContext({ open: (...args) => opened.push(args), viewKind: 'home', errToast: message => { throw new Error(message); } });
  new vm.Script(code).runInContext(context);
  const target = { key: 'saved/path & 100%.jsonl', entryId: 'raw-entry-<42>' };
  const hash = 'read=' + encodeURIComponent(JSON.stringify(target));
  context.dispatchHash(decodeURIComponent(hash));
  context.dispatchHash('child-conversation');
  context.dispatchHash(decodeURIComponent(hash));
  assert.deepEqual(opened, [[target.key, 'entry:' + target.entryId], ['child-conversation'], [target.key, 'entry:' + target.entryId]]);
});

test('resumed web activity and surviving workers keep counts and subtree cancellation live', async t => {
  const records = [task('a', { status: 'succeeded', review: 'accepted' }),
    task('b', { parentTaskId: 'a', parentKey: 'child-a', status: 'succeeded', sessionActive: true }),
    task('c', { status: 'lost', workerAlive: true })];
  const f = fixture(t, records, { unread: () => true });
  f.controller.mount(f.host, { kind: 'agents' }); await f.controller.refresh();
  assert.match(cls(f.host, 'delegation-main').children[0].textContent, /2 running/);
  const a = row(f.host, 'a'), c = row(f.host, 'c');
  assert.equal(control(a, 'Cancel subtree…').disabled, false, 'collapsed resumed descendant stays cancellable');
  assert.equal(control(c, 'Cancel subtree…').disabled, false, 'lost live worker stays cancellable');
  assert.match(cls(c, 'delegation-state').textContent, /Execution: lost.*Worker process alive/);
  expand(cls(a, 'delegation-children'));
  const b = row(f.host, 'b');
  assert.match(cls(b, 'delegation-state').textContent, /Execution: succeeded · Parent review: unreviewed · Continuing in web/);
  assert.doesNotMatch(cls(b, 'delegation-state').textContent, /Unread reply/);
  assert.match(cls(a, 'delegation-state').textContent, /Parent review: accepted/);
  await control(a, 'Cancel subtree…').click();
  assert.doesNotMatch(cls(a, 'delegation-notice').textContent, /no active tasks/);
  const conversation = f.controller.mount(f.host, { kind: 'conversation', key: 'child-b' });
  assert.match(cls(conversation, 'delegation-parent').textContent, /Continuing in web/);
  f.setRecords(records.map(r => ({ ...r, sessionActive: false, workerAlive: false })));
  await f.controller.refresh();
  f.controller.mount(f.host, { kind: 'agents' });
  assert.equal(control(row(f.host, 'a'), 'Cancel subtree…').disabled, true);
  assert.equal(control(row(f.host, 'c'), 'Cancel subtree…').disabled, true);
  assert.match(cls(row(f.host, 'a'), 'delegation-notice').textContent, /no active tasks/);
});

test('real agent busy-key function includes terminal tasks with web or worker activity', () => {
  const html = fs.readFileSync(require.resolve('../app.html'), 'utf8');
  const start = html.indexOf('function agentBusyKeys() {');
  const code = html.slice(start, html.indexOf('\nfunction finishedUnreadSessions()', start));
  const index = D.indexTasks([task('web', { status: 'succeeded', sessionActive: true }),
    task('worker', { status: 'lost', workerAlive: true }), task('done', { status: 'succeeded' })]);
  const context = vm.createContext({ runningKeys: [], activeRuns: new Map(), agentsProcs: [],
    delegationUI: { index: () => index }, DelegationUI: D });
  new vm.Script(code).runInContext(context);
  assert.deepEqual([...context.agentBusyKeys()], ['child-web', 'child-worker']);
  assert.equal(D.trackedProcess(index, { key: 'child-web' }), true, 'deduplicated row remains counted through its task');
});

test('app scripts parse and integration uses separate task hosts and read-only navigation', () => {
  const html = fs.readFileSync(require.resolve('../app.html'), 'utf8');
  for (const [i, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
    if (match[1].trim()) new vm.Script(match[1], { filename: `app.html script ${i}` });
  }
  assert.ok(html.includes('<script src="/delegation-ui.js"></script>'));
  assert.ok(html.includes("live.addEventListener('delegation-update'"));
  assert.ok(html.includes("d.type === 'delegation-update'"));
  assert.ok(html.includes("$('agentsUnread').innerHTML = unreadTray"));
  // The agents panel is an attention list. Delegated conversations are
  // normal rows there (parent named on the second line); the task controls
  // and logs mount only in the conversation and tree views.
  assert.ok(html.includes('<div id="agentsUnread"></div><div id="agentsLegacy"></div>'));
  assert.ok(!html.includes('agentDelegations'));
  assert.ok(!html.includes("mountDelegationView('agents')"));
  assert.ok(html.includes("origin(key) || shortDir"));
  assert.ok(html.includes("d.messages.findIndex(m => m.eid === entryId)"));
  assert.ok(html.includes("if (h.startsWith('read='))"));
});

test('inbox attention: a worker counts only when no parent callback can reach a person', () => {
  const done = extra => task('x', { status: 'succeeded', delivery: 'web', ...extra });
  assert.equal(D.attentionState(done()), 'reported');
  assert.equal(D.attentionState(done({ notificationState: 'pending' })), 'reported');
  assert.equal(D.attentionState(done({ notificationState: 'delivered' })), 'reported');
  assert.equal(D.attentionState(done({ notificationState: 'blocked' })), 'unreported');
  assert.equal(D.attentionState(done({ notificationState: 'error' })), 'unreported');
  assert.equal(D.attentionState(done({ parentKey: null })), 'unreported');
  assert.equal(D.attentionState(done({ delivery: 'nextTurn' })), 'unreported');
  assert.equal(D.attentionState(done({ status: 'failed', delivery: 'none' })), 'unreported');
  assert.equal(D.attentionState(done({ status: 'running' })), 'silent');
  assert.equal(D.attentionState(done({ workerAlive: true })), 'silent');
  assert.equal(D.attentionState(done({ status: 'cancelled' })), 'silent');
  assert.equal(D.attentionState(done({ cancelRequested: true })), 'silent');
  assert.equal(D.attentionState(done({ notificationState: 'cancelled' })), 'silent');
  assert.equal(D.attentionState(null), 'silent');
});

test('orchestration progress counts the recorded subtree, not verdicts', () => {
  const index = D.indexTasks([
    task('a', { status: 'succeeded' }), task('b', { status: 'running' }),
    task('c', { parentTaskId: 'a', parentKey: 'child-a', status: 'failed' }),
    task('d', { parentTaskId: 'c', parentKey: 'child-c', status: 'succeeded', review: 'accepted' }),
    task('e', { parentTaskId: 'b', parentKey: 'child-b', status: 'lost' }),
    task('other', { parentKey: 'elsewhere', status: 'succeeded' }),
  ]);
  const p = D.progress(index, ['a', 'b']);
  assert.deepEqual(p, { total: 5, done: 4, live: 1, failed: 2, unreviewed: 1 });
  assert.equal(D.progressLabel(p), '4/5 done · 2 failed · 1 to review');
  assert.equal(D.progressLabel(D.progress(index, [])), '');
  assert.equal(D.rootOf(index, 'd'), 'a');
  assert.equal(D.rootOf(index, 'other'), 'other');
});
