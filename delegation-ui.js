/* Delegation UI contract: serve this file at /delegation-ui.js.
 * GET /api/delegations -> {tasks, revision}; records include key, parentKey, paused.
 * GET /api/delegations/detail?id= -> record plus logTail, prompt, mode.
 * POST /api/delegations/control {id, action} -> {ok:true}.
 * SSE delegation-update (named event or JSON type) invalidates the compact snapshot.
 * GET /api/agents/active procs should expose delegationId or exact sessionPath
 * to remove duplicate process rows before indexing supplies key. PID alone is unsafe.
 * Existing /api/session messages need eid for exact parent-entry landing; the
 * read=<encoded JSON {key,entryId}> hash reuses open() and the hit landing path.
 * Logs load only on disclosure, then refresh on explicit request. Snapshot
 * fallback runs every 30 seconds while a relevant surface and tab are visible.
 * This module never starts workers, changes review, or infers ancestry from cwd/PIDs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DelegationUI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'lost']);
  const statuses = new Set(['planned', 'starting', 'running', ...terminal]);
  const text = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const escape = v => text(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function indexTasks(records) {
    const byId = new Map();
    for (const task of Array.isArray(records) ? records : []) {
      if (!task || typeof task.id !== 'string' || !task.id) continue;
      const old = byId.get(task.id);
      if (!old || Number(task.updatedAt || 0) > Number(old.updatedAt || 0)) byId.set(task.id, { ...task });
    }
    const tasks = [...byId.values()].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || a.id.localeCompare(b.id));
    const children = new Map(), recordedChildren = new Map(), parent = new Map(), warnings = new Map();
    for (const t of tasks) {
      if (!t.parentTaskId) continue;
      if (!byId.has(t.parentTaskId)) warnings.set(t.id, 'Parent task is outside this snapshot.');
      else {
        parent.set(t.id, t.parentTaskId);
        if (!recordedChildren.has(t.parentTaskId)) recordedChildren.set(t.parentTaskId, []);
        recordedChildren.get(t.parentTaskId).push(t.id);
      }
    }
    // Each node has at most one parent. Break one edge per cycle, not an
    // arbitrary depth limit. Every recorded task remains reachable once.
    const done = new Set();
    for (const t of tasks) {
      const path = new Set();
      let id = t.id;
      while (id && !done.has(id)) {
        if (path.has(id)) {
          parent.delete(id);
          warnings.set(id, 'Task ancestry contains a cycle.');
          break;
        }
        path.add(id);
        id = parent.get(id);
      }
      for (const seen of path) done.add(seen);
    }
    for (const t of tasks) {
      const p = parent.get(t.id);
      if (!p) continue;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(t.id);
    }
    return { tasks, byId, children, recordedChildren, parent, warnings, roots: tasks.filter(t => !parent.has(t.id)).map(t => t.id) };
  }
  function descendants(index, ids, recorded = false) {
    const seen = new Set(), stack = [...ids].reverse();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !index.byId.has(id)) continue;
      seen.add(id);
      for (const child of [...((recorded ? index.recordedChildren : index.children).get(id) || [])].reverse()) stack.push(child);
    }
    return seen;
  }
  function contextTasks(index, key, entryId, options = {}) {
    const sourceKeys = new Set(options.familyKeys || [key]);
    const direct = index.tasks.filter(t => t.parentKey && sourceKeys.has(t.parentKey));
    const entryIds = Array.isArray(entryId) ? entryId : entryId == null ? [] : [entryId];
    const refs = new Set((options.entryRefs || entryIds.map(id => ({ key, id }))).map(ref => ref.key + '\n' + ref.id));
    const matching = direct.filter(t => refs.has(t.parentKey + '\n' + t.parentEntryId));
    const selected = descendants(index, matching.map(t => t.id));
    const all = descendants(index, direct.map(t => t.id));
    const rootsOf = set => [...set].filter(id => !set.has(index.parent.get(id)));
    const other = new Set([...all].filter(id => !selected.has(id)));
    return { self: index.tasks.find(t => key && t.key === key), all, selected,
      selectedRoots: rootsOf(selected), roots: rootsOf(other), other };
  }
  function trackedProcess(index, process) {
    // A recycled PID is not identity. Hide a process only with a recorded
    // delegation ID, exact indexed key, or exact saved session path.
    return index.tasks.some(t => process.delegationId === t.id ||
      (t.key && process.key === t.key) || (t.sessionPath && process.sessionPath === t.sessionPath));
  }
  function taskState(t) {
    return { execution: statuses.has(t.status) ? t.status : 'unknown',
      review: ['accepted', 'rejected', 'unreviewed'].includes(t.review) ? t.review : 'unreviewed' };
  }
  function isLive(t) {
    return !!(t.sessionActive || t.workerAlive || !terminal.has(t.status));
  }
  function activityLabel(t) {
    return [t.sessionActive ? 'Continuing in web' : '', t.workerAlive ? 'Worker process alive' : ''].filter(Boolean).join(' · ');
  }
  // Inbox attention. A worker's result is addressed to its parent, not to a
  // person. It needs a person only when no callback will carry it upward:
  //   reported   a parent turn has carried or will carry this result
  //   unreported no callback can reach anyone; list it in the inbox
  //   silent     still working, or cancelled on request
  function attentionState(t) {
    if (!t) return 'silent';
    if (isLive(t)) return 'silent';
    if (t.status === 'cancelled' || t.cancelRequested || t.notificationState === 'cancelled') return 'silent';
    if (t.delivery !== 'web') return 'unreported';
    if (!t.parentKey) return 'unreported';
    if (t.notificationState === 'blocked' || t.notificationState === 'error') return 'unreported';
    return 'reported';
  }
  function rootOf(index, id) {
    const seen = new Set();
    let current = id;
    while (index.parent.has(current) && !seen.has(current)) { seen.add(current); current = index.parent.get(current); }
    return current;
  }
  // Progress of one orchestration: every recorded descendant of the given
  // tasks. Counts are facts, not verdicts.
  function progress(index, ids) {
    const counts = { total: 0, done: 0, live: 0, failed: 0, unreviewed: 0 };
    for (const id of descendants(index, ids)) {
      const t = index.byId.get(id); if (!t) continue;
      counts.total++;
      if (isLive(t)) counts.live++;
      else if (terminal.has(t.status)) counts.done++;
      if (t.status === 'failed' || t.status === 'lost') counts.failed++;
      if (t.status === 'succeeded' && t.review !== 'accepted' && t.review !== 'rejected') counts.unreviewed++;
    }
    return counts;
  }
  function progressLabel(counts) {
    if (!counts.total) return '';
    return counts.done + '/' + counts.total + ' done' + (counts.failed ? ' \u00b7 ' + counts.failed + ' failed' : '') +
      (counts.unreviewed ? ' \u00b7 ' + counts.unreviewed + ' to review' : '');
  }
  function summaryState(index, ids) {
    const counts = { running: 0, failed: 0, unreviewed: 0 };
    for (const id of ids) {
      const t = index.byId.get(id); if (!t) continue;
      if (isLive(t)) counts.running++;
      if (t.status === 'failed' || t.status === 'lost') counts.failed++;
      if (t.status === 'succeeded' && t.review !== 'accepted' && t.review !== 'rejected') counts.unreviewed++;
    }
    return [counts.running ? counts.running + ' running' : '', counts.failed ? counts.failed + ' failed or lost' : '',
      counts.unreviewed ? counts.unreviewed + ' to review' : ''].filter(Boolean).join(' · ');
  }
  function cancellationMessage(index, id) {
    const count = descendants(index, [id], true).size;
    return `Request cancellation of “${text(index.byId.get(id)?.title || id)}” and its subtree (${count} ${count === 1 ? 'task' : 'tasks'} in this snapshot)? Completed work stays saved. Running workers stop only after the supervisor handles the request.`;
  }
  function parentTarget(task) {
    return task && task.parentKey ? { key: task.parentKey, entryId: task.parentEntryId || null } : null;
  }
  function detailText(record) {
    const tail = text(record.logTail ?? record.log?.tail ?? '').slice(-16000);
    const prompt = text(record.prompt ?? record.promptText ?? '').slice(0, 24000);
    const mode = text(record.mode ?? record.modeContract ?? '').slice(0, 24000);
    return `Prompt (up to 24000 characters)\n${prompt || 'Not available.'}\nFull prompt: ${text(record.promptPath)}\n\nMode contract (up to 24000 characters)\n${mode || 'Not available.'}\nFull mode: ${text(record.modePath)}\n\nMode hash: ${text(record.modeHash)}\nTools: ${text(record.tools)}\nThinking: ${text(record.thinking)}\nOutput: ${text(record.outputDir)}\nSupervision: ${text(record.supervision)}\nSurvives web service restart: ${record.survivesServiceRestart === true ? 'yes' : 'not guaranteed'}\nPermissions: ${text(record.permissions || 'Same user permissions. Not a sandbox.')}\nReview evidence: ${text(record.reviewEvidence)}\nError: ${text(record.error)}\n\nLog tail (up to 16000 characters)\n${tail || 'No log output.'}\nFull log: ${text(record.logPath)}\n\nStandard error (up to 8000 characters)\n${text(record.stderrTail).slice(-8000)}`;
  }

  function createController(options) {
    const { document: doc, fetch: request, visible, openTarget, confirm: ask } = options;
    let index = indexTasks([]), error = '', loaded = false, limited = false, pending = null, dirty = false, timer = null, destroyed = false;
    const views = new Map(), details = new Map(), busy = new Set(), requests = new Set();
    async function requestJSON(url, init = {}) {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 10000);
      requests.add(abort);
      try {
        const response = await request(url, { ...init, signal: abort.signal });
        return { ok: response.ok, data: await response.json() };
      } finally { clearTimeout(timeout); requests.delete(abort); }
    }
    const el = (tag, cls, value) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (value != null) node.textContent = value;
      return node;
    };
    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    function button(label, fn) {
      const b = el('button', '', label); b.type = 'button'; b.onclick = fn; return b;
    }
    // Reuse nodes by task/group ID. Never replace an open details element or
    // its controls during an update. Only changed text and attributes patch.
    function place(container, nodes) {
      const wanted = new Set(nodes);
      for (const child of [...container.children]) if (!wanted.has(child)) child.remove();
      nodes.forEach((node, i) => { if (container.children[i] !== node) container.insertBefore(node, container.children[i] || null); });
    }
    function group(view, id, label, open = false) {
      let g = view.groups.get(id);
      if (!g) {
        const node = el('details', 'delegation-group'), summary = el('summary'), body = el('div', 'delegation-list');
        node.open = open; node.append(summary, body);
        g = { node, summary, body }; view.groups.set(id, g);
        node.ontoggle = () => { if (node.open) paint(view); };
      }
      setText(g.summary, label); return g;
    }
    async function loadDetail(row, force = false) {
      const task = index.byId.get(row.id);
      if (!task) return;
      if (!force && details.has(row.id)) { setText(row.pre, details.get(row.id)); return; }
      if (row.loading) return;
      row.loading = true; row.refresh.disabled = true;
      setText(row.pre, 'Loading task details…');
      try {
        const response = await requestJSON('/api/delegations/detail?id=' + encodeURIComponent(row.id));
        if (!response.ok) throw new Error('Task details are not available.');
        const record = response.data;
        if (record.error && !record.id && !record.task) throw new Error(text(record.error));
        const value = detailText(record.task ? { ...record.task, ...record } : record);
        details.set(row.id, value); setText(row.pre, value);
      } catch (e) { setText(row.pre, text(e.message)); }
      finally { row.loading = false; row.refresh.disabled = false; }
    }
    async function control(id, action) {
      if (busy.has(id)) return;
      if (action === 'cancel' && !ask(cancellationMessage(index, id))) return;
      busy.add(id); paintAll();
      try {
        const response = await requestJSON('/api/delegations/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
        const result = response.data;
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'Control request failed.');
        for (const view of views.values()) if (view.rows.has(id)) {
          const row = view.rows.get(id);
          row.requestedAction = action;
          setText(row.notice, action === 'cancel' ? 'Cancellation requested. Waiting for supervisor status.' :
            action === 'pause' ? 'Pause requested. Running workers continue.' : 'Resume requested. New descendants can start when the pause clears.');
        }
        await refresh();
      } catch (e) {
        for (const view of views.values()) if (view.rows.has(id)) setText(view.rows.get(id).notice, text(e.message));
      } finally { busy.delete(id); paintAll(); }
    }
    function taskRow(view, id) {
      let row = view.rows.get(id);
      if (!row) {
        const node = el('div', 'delegation-row'); node.dataset.delegationId = id;
        const title = el('b'), meta = el('div', 'delegation-meta'), state = el('div', 'delegation-state');
        const warning = el('div', 'delegation-meta'), actions = el('div', 'delegation-actions');
        const child = button('Open child conversation', () => { const t = index.byId.get(id); if (t?.key) openTarget({ key: t.key }); });
        const parent = button('Parent launch point', () => { const target = parentTarget(index.byId.get(id)); if (target) openTarget(target); });
        const pause = button('Pause new descendants', () => control(id, index.byId.get(id)?.paused ? 'resume' : 'pause'));
        const cancel = button('Cancel subtree…', () => control(id, 'cancel'));
        actions.append(child, parent);
        const notice = el('div', 'delegation-notice'); notice.setAttribute('role', 'status');
        const info = el('details', 'delegation-info'), summary = el('summary', '', 'Details and controls');
        const pre = el('pre'), refresh = button('Refresh details', () => loadDetail(row, true));
        info.append(summary, pause, cancel, refresh, pre);
        const children = el('details', 'delegation-children'), childSummary = el('summary'), childBody = el('div', 'delegation-list');
        children.append(childSummary, childBody);
        node.append(title, meta, state, warning, actions, notice, info, children);
        row = { id, node, title, meta, state, warning, child, parent, pause, cancel, notice, info, pre, refresh, children, childSummary, childBody };
        view.rows.set(id, row);
        info.ontoggle = () => { if (info.open) loadDetail(row); };
        children.ontoggle = () => { if (children.open) paint(view); };
      }
      const t = index.byId.get(id), state = taskState(t);
      setText(row.title, text(t.title || 'Untitled task'));
      setText(row.meta, [t.role || 'worker', text(t.model) || 'model not recorded'].join(' · '));
      setText(row.state, `Execution: ${state.execution} · Parent review: ${state.review}${activityLabel(t) ? ' · ' + activityLabel(t) : ''}${t.paused ? ' · New descendants paused; running workers continue' : ''}${isUnread(t) ? ' · Unread reply' : ''}`);
      const warning = [index.warnings.get(id), t.error,
        terminal.has(t.status) && t.workerAlive ? 'The worker process is still alive. Inspect it before continuing this conversation.' : '',
        t.notificationError, t.notificationState === 'pending' ? 'Parent review callback pending.' :
          t.notificationState === 'delivering' ? 'Parent review in progress.' : ''].filter(Boolean).join(' ');
      setText(row.warning, warning);
      row.warning.hidden = !warning;
      row.child.disabled = !t.key; row.child.title = t.key ? 'Read the saved conversation' : 'Conversation is not indexed yet';
      row.parent.disabled = !parentTarget(t); row.parent.title = t.parentKey ? 'Read the exact parent entry' : 'Parent conversation is not indexed';
      setText(row.pause, t.paused ? 'Resume new descendants' : 'Pause new descendants');
      row.pause.disabled = busy.has(id);
      const subtreeLive = [...descendants(index, [id], true)].some(k => isLive(index.byId.get(k)));
      row.cancel.disabled = busy.has(id) || !subtreeLive;
      if (row.requestedAction === 'cancel' && !subtreeLive) {
        setText(row.notice, 'This subtree has no active tasks. Completed work stays saved.');
        row.requestedAction = null;
      } else if ((row.requestedAction === 'pause' && t.paused) || (row.requestedAction === 'resume' && !t.paused)) {
        setText(row.notice, t.paused ? 'New descendants paused. Running workers continue.' : 'New descendants are not paused on this task.');
        row.requestedAction = null;
      }
      return row;
    }
    function renderRows(view, container, roots, allowed) {
      // Only create deeper rows after their parent expands. The explicit
      // stack also handles 2000-deep snapshots without JS call-stack growth.
      const stack = [{ container, ids: roots, depth: 0 }];
      while (stack.length) {
        const { container, ids, depth } = stack.pop();
        const rows = ids.filter(id => allowed.has(id)).map(id => taskRow(view, id));
        place(container, rows.map(row => row.node));
        for (const row of rows) {
          const kids = (index.children.get(row.id) || []).filter(id => allowed.has(id));
          row.children.hidden = !kids.length;
          const members = new Set([...descendants(index, kids)].filter(id => allowed.has(id)));
          setText(row.childSummary, `Delegated tasks (${kids.length})${unreadLabel(members)}`);
          // Deep work keeps real nested disclosures without narrowing the
          // reading column forever on a phone.
          row.children.className = 'delegation-children' + (depth >= 5 ? ' delegation-deep' : '');
          if (row.children.open) stack.push({ container: row.childBody, ids: kids, depth: depth + 1 });
        }
      }
    }
    function isUnread(task) {
      return task && !isLive(task) && terminal.has(task.status) && task.key && options.unread?.(task.key);
    }
    function unreadLabel(ids) {
      const count = [...ids].filter(id => isUnread(index.byId.get(id))).length;
      return count ? ` · ${count} unread ${count === 1 ? 'reply' : 'replies'}` : '';
    }
    function paint(view) {
      if (!view.host.isConnected) return;
      const focused = doc.activeElement;
      const scroll = [];
      for (let node = view.node; node; node = node.parentNode) {
        if (typeof node.scrollTop === 'number') scroll.push([node, node.scrollTop, node.scrollLeft]);
      }
      paintContent(view);
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
      for (const [node, top, left] of scroll) { node.scrollTop = top; node.scrollLeft = left; }
    }
    function paintContent(view) {
      const { context } = view;
      const scoped = contextTasks(index, context.key, context.entryIds || context.entryId, context);
      const parent = scoped.self;
      view.parent.hidden = !parent;
      if (parent) {
        setText(view.parentLabel, `Delegated conversation · ${text(parent.role || 'worker')} · ${taskState(parent).execution} · ${taskState(parent).review}${activityLabel(parent) ? ' · ' + activityLabel(parent) : ''}`);
        view.parentButton.disabled = !parentTarget(parent);
        view.parentButton.onclick = () => { const target = parentTarget(parent); if (target) openTarget(target); };
      }
      const count = context.kind === 'agents' ? index.tasks.length : scoped.all.size;
      view.node.hidden = !error && count === 0 && !parent;
      view.main.hidden = loaded && count === 0 && !error;
      const activity = summaryState(index, context.kind === 'agents' ? index.byId.keys() : scoped.all);
      setText(view.summary, `Delegated work (${count})${activity ? ' · ' + activity : ''}${unreadLabel(context.kind === 'agents' ? index.byId.keys() : scoped.all)}${error ? ' · unavailable' : !loaded ? ' · loading' : ''}`);
      setText(view.health, error ? `${error}${loaded ? ' Showing the last saved snapshot.' : ''}` : !loaded ? 'Loading delegated work…' : limited ? 'Showing a bounded snapshot. Older completed tasks may not appear.' : '');
      view.health.hidden = loaded && !error && !limited;
      view.retry.hidden = !error;
      const groups = [];
      if (context.kind === 'agents') {
        const origins = new Map();
        for (const id of index.roots) {
          const t = index.byId.get(id), origin = t.parentKey || t.parentSessionPath || 'unknown';
          if (!origins.has(origin)) origins.set(origin, []);
          origins.get(origin).push(id);
        }
        for (const [origin, roots] of origins) {
          const key = index.byId.get(roots[0]).parentKey;
          const label = options.titleForKey?.(key) || (key ? text(key) : 'Parent not indexed: ' + text(index.byId.get(roots[0]).parentSessionPath || 'origin not recorded'));
          const members = descendants(index, roots);
          const g = group(view, 'origin:' + origin, `${label} · ${members.size} tasks${unreadLabel(members)}`, members.size <= 20);
          groups.push(g.node);
          if (view.main.open && g.node.open) renderRows(view, g.body, roots, new Set(index.byId.keys()));
        }
      } else {
        if (context.kind === 'tree' && context.entryId != null) {
          const g = group(view, 'selected:' + context.key + ':' + context.entryId, `From selected entry (${scoped.selected.size})${unreadLabel(scoped.selected)}`, true);
          groups.push(g.node);
          if (view.main.open && g.node.open) renderRows(view, g.body, scoped.selectedRoots, scoped.selected);
        }
        const g = group(view, 'conversation:' + context.key, `${context.kind === 'tree' ? 'Other work in this tree' : 'From this conversation'} (${scoped.other.size})${unreadLabel(scoped.other)}`, context.kind !== 'tree');
        groups.push(g.node);
        if (view.main.open && g.node.open) renderRows(view, g.body, scoped.roots, scoped.other);
      }
      place(view.body, groups);
      view.empty.hidden = !loaded || count > 0;
      for (const [id, row] of view.rows) if (!index.byId.has(id)) { row.node.remove(); view.rows.delete(id); }
    }
    function paintAll() {
      for (const view of views.values()) paint(view);
    }
    function mount(host, context) {
      let view = views.get(context.kind);
      if (!view) {
        const node = el('section', 'delegation-ui'); node.setAttribute('aria-label', 'Delegated work');
        const parent = el('div', 'delegation-parent'), parentLabel = el('span'), parentButton = button('Parent launch point', () => {});
        parent.append(parentLabel, parentButton);
        const main = el('details', 'delegation-main'), summary = el('summary'), health = el('div', 'delegation-meta');
        const retry = button('Retry delegation snapshot', () => refresh());
        const empty = el('p', 'delegation-meta', 'No delegated tasks recorded for this conversation.');
        const body = el('div'); main.append(summary, health, retry, empty, body); node.append(parent, main);
        view = { node, main, summary, health, retry, empty, body, parent, parentLabel, parentButton, rows: new Map(), groups: new Map(), contextStates: new Map() };
        main.open = context.kind !== 'conversation';
        main.ontoggle = () => { if (main.open) { paint(view); if (!loaded) refresh(); } };
        views.set(context.kind, view);
      }
      // A new conversation gets its own disclosure state, but updates of
      // the same context retain every node, focus, and expansion.
      if (view.context && view.context.key !== context.key) {
        view.contextStates.set(view.context.key, { rows: view.rows, groups: view.groups, open: view.main.open });
        const saved = view.contextStates.get(context.key);
        view.rows = saved?.rows || new Map(); view.groups = saved?.groups || new Map();
        view.main.open = saved ? saved.open : context.kind !== 'conversation';
        if (view.contextStates.size > 12) view.contextStates.delete(view.contextStates.keys().next().value);
      }
      view.host = host; view.context = context;
      if (view.node.parentNode !== host) host.append(view.node);
      paint(view);
      return view.node;
    }
    function schedule() {
      clearTimeout(timer); timer = null;
      if (!destroyed && visible()) timer = setTimeout(() => refresh(), 30000);
    }
    async function refresh() {
      if (destroyed) return;
      if (!visible()) { dirty = true; schedule(); return; }
      if (pending) { dirty = true; return pending; }
      dirty = false;
      pending = (async () => {
        try {
          const response = await requestJSON('/api/delegations');
          if (destroyed) return;
          if (!response.ok) throw new Error('Delegation snapshot is not available.');
          const snapshot = response.data;
          if (!Array.isArray(snapshot.tasks)) throw new Error('Delegation snapshot has an invalid format.');
          index = indexTasks(snapshot.tasks); loaded = true; limited = snapshot.truncated === true || Number(snapshot.listing?.omitted || 0) > 0; error = '';
          for (const id of details.keys()) if (!index.byId.has(id)) details.delete(id);
          options.onSnapshot?.(index);
        } catch (e) { error = e.name === 'AbortError' ? 'Delegation snapshot timed out.' : text(e.message); }
        finally { paintAll(); }
      })();
      try { await pending; }
      finally {
        pending = null;
        if (dirty && visible()) { dirty = false; schedule(); refresh(); }
        else schedule();
      }
    }
    return { mount, refresh, invalidate: refresh, repaint: paintAll, index: () => index,
      visibilityChanged() { if (visible()) refresh(); else schedule(); },
      destroy() { destroyed = true; clearTimeout(timer); for (const abort of requests) abort.abort(); views.clear(); details.clear(); } };
  }
  return { escape, indexTasks, descendants, contextTasks, trackedProcess, taskState, isLive, summaryState,
    attentionState, rootOf, progress, progressLabel, isTerminal: status => terminal.has(status), parentTarget, cancellationMessage, detailText, createController };
});
