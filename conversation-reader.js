/* Reading a conversation never writes its continuation. The app supplies message,
   model, file, and session controls; ancestry lives in ConversationFlow. */
const readerStates = new Map();
const readerSessions = new Map();
const readerLiveMessages = new Map();
const readerDrafts = new Map();
function rememberConversationDraft() {
  const ta = $('agentText');
  const key = ta?.closest('[data-conversation-key]')?.dataset.conversationKey;
  if (key) readerDrafts.set(key, ta.value);
}
let readerFlow = { groups: [], branches: [] };
let readerRenderSerial = 0;

function readerState(key) {
  if (!readerStates.has(key)) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('aiconvo.reader.v1:' + key) || '{}') || {}; } catch {}
    const state = { leaf: typeof saved.leaf === 'string' ? saved.leaf : null, revision: saved.revision };
    for (const name of ['routes', 'groups', 'accepted', 'positions', 'work']) state[name] = Object.assign(Object.create(null), saved[name] && typeof saved[name] === 'object' && !Array.isArray(saved[name]) ? saved[name] : {});
    readerStates.set(key, state);
  }
  return readerStates.get(key);
}
function saveReaderState(key) {
  try { localStorage.setItem('aiconvo.reader.v1:' + key, JSON.stringify(readerState(key))); } catch {}
}
function readerGroup(key, node) {
  const state = readerState(key);
  return state.groups[node] || (state.groups[node] = { compare: false, pair: [], sources: null, instruction: '' });
}
function readerMessage(button) {
  const key = button.closest('[data-msg-key]')?.dataset.msgKey || current?.key;
  const d = key === current?.key ? current : readerSessions.get(key);
  return Number(button.dataset.msgIndex) < 0 ? readerLiveMessages.get(button.closest('[data-eid]')?.dataset.eid) : d?.messages[Number(button.dataset.msgIndex)];
}
async function readerMessageAction(button, action) {
  const key = button.closest('[data-msg-key]')?.dataset.msgKey;
  if (!key || key === current?.key) return action(button);
  const m = readerMessage(button), cls = ['msg-edit', 'msg-regenerate'].find(c => button.classList.contains(c));
  if (!m?.eid || !cls) return;
  await browseConversationPath(key, m.eid, m.eid, { exact: true });
  const target = $('view').querySelector(`[data-eid="${CSS.escape(m.eid)}"] .${cls}`);
  if (target) return action(target);
}

async function loadConversationFlow(key) {
  if (compareCache.has(key)) return compareCache.get(key);
  const pending = fetch('/api/compare?id=' + encodeURIComponent(key)).then(async r => {
    const data = await r.json();
    if (!r.ok || data.error) throw Error(data.error || 'Could not load conversation paths.');
    return { groups: [], branches: [], ...data };
  }).catch(error => { compareCache.delete(key); throw error; });
  compareCache.set(key, pending);
  return pending;
}

function rememberReaderAnchor() {
  const view = $('view');
  if (!view || !current || viewKind !== 'conversation' || $('liveReplies')?.dataset.conversationKey !== current.key) return null;
  if (view.scrollHeight - view.scrollTop - view.clientHeight < 4) return { bottom: true };
  const top = view.getBoundingClientRect().top;
  const candidates = [...view.querySelectorAll('#conversationTranscript [data-flow-anchor], #conversationTranscript .msg[data-eid]')];
  const el = candidates.find(e => e.getBoundingClientRect().bottom > top + 8 && e.getClientRects().length);
  if (!el) return null;
  return { id: el.dataset.flowAnchor || el.dataset.eid, flow: !!el.dataset.flowAnchor, offset: el.getBoundingClientRect().top - top };
}
function restoreReaderAnchor(anchor) {
  const view = $('view');
  if (!view || !anchor) return false;
  if (anchor.bottom) { view.scrollTop = view.scrollHeight; return true; }
  if (typeof anchor.id !== 'string') return false;
  const el = [...view.querySelectorAll(`#conversationTranscript [${anchor.flow ? 'data-flow-anchor' : 'data-eid'}="${CSS.escape(anchor.id)}"]`)].find(e => e.getClientRects().length);
  if (!el) return false;
  view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - (Number(anchor.offset) || 0);
  return true;
}

function rememberConversationPosition() {
  const anchor = rememberReaderAnchor();
  if (!anchor) return;
  const state = readerState(current.key);
  // A history route may already have selected another leaf while the old
  // DOM is still on screen. Save under the path that was actually rendered.
  state.positions[$('liveReplies').dataset.readingLeaf || 'live'] = anchor;
  state.revision = current.mtimeMs;
  saveReaderState(current.key);
}

let readerLandingCleanup = null;
function stopReaderLanding() {
  readerLandingCleanup?.(); readerLandingCleanup = null;
}
// Layout can grow after landing (images, fonts, run cards, composer). Follow
// that growth, not a timer or an after-growth distance guess. Real scrolling
// or a new screen immediately hands control back to the reader.
function maintainReaderLanding(apply) {
  stopReaderLanding();
  const view = $('view'), transcript = $('conversationTranscript');
  if (!view || !transcript || typeof ResizeObserver === 'undefined') return;
  const key = current.key, seq = conversationLoadSeq;
  let observer;
  let lastTop = view.scrollTop, lastHeight = view.scrollHeight, lastClient = view.clientHeight;
  const movedWithoutResize = () => view.scrollHeight === lastHeight && view.clientHeight === lastClient && Math.abs(view.scrollTop - lastTop) > 4;
  const events = new AbortController();
  const cleanup = () => { observer?.disconnect(); events.abort(); };
  readerLandingCleanup = cleanup;
  const cancel = () => { if (readerLandingCleanup === cleanup) stopReaderLanding(); else cleanup(); };
  for (const event of ['wheel', 'touchstart', 'pointerdown']) view.addEventListener(event, cancel, { passive: true, signal: events.signal });
  view.addEventListener('scroll', () => { if (movedWithoutResize()) cancel(); }, { passive: true, signal: events.signal });
  view.addEventListener('keydown', e => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) cancel();
  }, { signal: events.signal });
  observer = new ResizeObserver(() => {
    if (!transcript.isConnected || current?.key !== key || activeRel !== key || viewKind !== 'conversation' || conversationLoadSeq !== seq) return cancel();
    if (movedWithoutResize()) return cancel();
    apply();
    lastTop = view.scrollTop; lastHeight = view.scrollHeight; lastClient = view.clientHeight;
  });
  observer.observe(view);
  for (const child of view.children) observer.observe(child);
}
function readerRoute(key, leaf, anchor, replace = false) {
  const hash = 'path=' + encodeURIComponent(JSON.stringify({ key, leaf: leaf || null, anchor: anchor || null }));
  history[replace ? 'replaceState' : 'pushState'](null, '', '#' + hash);
  currentHash = hash;
}
async function browseConversationPath(key, id, anchor, { exact = false, history: record = true } = {}) {
  const sameView = key === current?.key && viewKind === 'conversation';
  rememberConversationDraft();
  if (record && current && viewKind === 'conversation') readerRoute(current.key, readerState(current.key).leaf, rememberReaderAnchor()?.id, true);
  const origin = sameView && anchor ? $('view').querySelector(`[data-flow-anchor="${CSS.escape(anchor)}"]`) : null;
  const old = origin ? { offset: origin.getBoundingClientRect().top - $('view').getBoundingClientRect().top } : null;
  const state = readerState(key);
  let data = key === current?.key ? current : readerSessions.get(key);
  if (!data && id) {
    try {
      const response = await fetch('/api/session?id=' + encodeURIComponent(key));
      data = await response.json();
      if (!response.ok || data.error) throw Error(data.error || 'Conversation unavailable.');
      readerSessions.set(key, data);
    } catch (error) { return errToast(error.message); }
  }
  const trace = data && ConversationFlow.trace(data);
  if (data) {
    const previous = ConversationFlow.trace(data, state.leaf);
    for (const ancestor of previous?.chain || []) state.routes[ancestor] = previous.leaf;
  }
  state.leaf = id ? (exact ? id : ConversationFlow.follow(trace, id, state.routes[id])) : null;
  saveReaderState(key);
  if (!sameView) await open(key, anchor ? 'flow:' + anchor : 'top', 'path=' + encodeURIComponent(JSON.stringify({ key, leaf: state.leaf, anchor })));
  else await renderConv('preserve');
  if (old && anchor) restoreReaderAnchor({ id: anchor, flow: true, offset: old.offset });
  else if (anchor) $('view').querySelector(`[data-flow-anchor="${CSS.escape(anchor)}"], [data-eid="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' });
  if (record && sameView && current?.key === key) readerRoute(key, state.leaf, anchor);
}
function resetConversationReading(key) {
  const state = readerState(key);
  state.leaf = null;
  saveReaderState(key);
}

function readerPendingChoice(d) {
  const t = computeSendTrace(d);
  const last = ConversationFlow.project(d, t).filter(m => ['user', 'assistant'].includes(m.role)).at(-1);
  return last && ConversationFlow.operation(last)?.kind === 'both'
    && last.operation?.unresolved && !readerState(d.key).accepted[last.eid] ? last.eid : null;
}
function readerIsBrowsing(d) {
  const read = computeTrace(d), send = computeSendTrace(d);
  if (!read || !send || read.leaf === send.leaf) return false;
  const last = t => ConversationFlow.project(d, t).at(-1)?.eid;
  return last(read) !== last(send);
}
function readerSendAllowed() {
  if (!current) return true;
  if ([...activeRuns.values()].some(r => r.fanoutRootKey === current.key)) {
    errToast('Wait for the parallel answers to finish before choosing what the next reply should include.');
    return false;
  }
  if (readerIsBrowsing(current)) {
    errToast('You are reading another path. Choose “Continue from here” or return to the current conversation.');
    $('readerDestination')?.scrollIntoView({ block: 'nearest' });
    return false;
  }
  if (readerPendingChoice(current)) {
    errToast('Choose an answer, include all answers, or merge them before sending.');
    $('readerDestination')?.scrollIntoView({ block: 'nearest' });
    return false;
  }
  return true;
}
function readerDestinationHtml(d) {
  if (readerIsBrowsing(d)) return `<div class="reader-destination" id="readerDestination" role="status"><span><b>Reading another path</b> · Send has not moved.</span><button data-reader-continue title="Use this conversation context. Files on disk are not rewound.">Continue from here</button><button data-reader-return>Return to current</button></div>`;
  const pending = readerPendingChoice(d);
  if (pending) return `<div class="reader-destination" id="readerDestination" role="status"><span><b>Choose what the next reply should include.</b> Read one answer, include all, or merge.</span><button data-reader-include="${esc(pending)}">Include all answers</button><button data-reader-review>Review answers</button></div>`;
  return '';
}
async function continueReadingPath(key, id, button, expectedLeaf = null) {
  if (!key || !id) return;
  if (current?.source === 'claude') {
    return forkFrom(key, { id }, button);
  }
  const old = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Moving continuation…'; }
  try {
    const out = await postJson('/api/branch', { id: key, node: id, expectedLeaf: expectedLeaf || (current?.key === key ? computeSendTrace(current)?.fileLeaf : null) });
    if (!out || out.error) throw Error(out?.error || 'Could not change continuation.');
    readerState(key).accepted[id] = true;
    resetConversationReading(key);
    compareCache.delete(key);
    if (current?.key === key && activeRel === key) {
      await open(key, 'bottom');
      readerRoute(key, null, null);
      $('agentText')?.focus({ preventScroll: true });
    }
    toast('Continue here. Other paths are preserved. Files on disk have not been rewound.');
  } catch (error) { errToast(error.message); }
  finally { if (button?.isConnected) { button.disabled = false; button.textContent = old; } }
}

// Every answer, whether ordinary, compared, or included together, uses this
// fragment renderer. Tools and their matching results never cross paths.
function transcriptFragmentHtml(d, messages, { after = new Map(), before = new Map(), replacements = new Map(), skip = new Set(), q = '', exact = null } = {}) {
  const indexes = new Map(d.messages.map((m, i) => [m, i]));
  const msgs = messages.map(m => ({ ...m, _source: m }));
  const calls = new Map();
  for (const m of msgs) {
    if (m.role === 'tool') { m._result = null; calls.set(m.id, m); }
    else if (m.role === 'toolresult') {
      const call = m.tid && calls.get(m.tid);
      m._merged = !!call && m.eid !== exact;
      if (call) { call._result = m; calls.delete(m.tid); }
    }
  }
  const out = [];
  const hl = text => q ? esc(text).replace(termRegex(q), match => `<mark>${match}</mark>`) : esc(text);
  let work = [], barModel = null;
  const flush = () => {
    if (!work.length) return;
    const key = work[0].eid || work[0].ts;
    const names = new Map(), files = new Map();
    for (const m of work) {
      const name = m.role === 'thinking' || m.role === 'assistant' ? 'thinking' : m.name || 'tool';
      if (m.role !== 'toolresult') names.set(name, (names.get(name) || 0) + 1);
      for (const path of (isFileWriteTool(m) ? [m.path] : m.writes || [])) files.set(path, m);
    }
    const tally = [...names].map(([n, count]) => n + (count > 1 ? ' ×' + count : '')).join(' · ');
    const links = [...files].map(([path, m]) => `<button class="tg-file" data-file-diff="${esc(path)}" data-file-ts="${esc(m.ts || '')}" data-file-anchor="${esc(m.ts || '')}" data-file-call="${esc(m.id || '')}">${esc(path.split('/').pop())}</button>`).join(' ');
    const opened = toolGroupOpen.get(d.key + '|' + key) ?? readerState(d.key).work?.[key];
    out.push(`<details class="toolgroup" data-msg-key="${esc(d.key)}" data-gkey="${esc(key)}"${opened ? ' open' : ''}><summary>${[...names.values()].reduce((a, b) => a + b, 0)} steps · ${esc(tally)}${files.size <= 3 ? ' ' + links : ''}</summary>${work.map(m => msgBlock(m, hl, m.eid === exact, q, indexes.get(m._source), d.key)).join('')}</details>`);
    const reviewCalls = [...new Set(work.filter(m => m.role === 'tool' && m.id).map(m => m.id))];
    if (reviewCalls.length) out.push(`<button class="tg-review" data-step-review="${esc(JSON.stringify({ key: d.key, calls: reviewCalls })).replace(/"/g, '&quot;')}">${files.size ? `${files.size} files touched · ` : ''}Review changes</button>`);
    const launches = work.filter(m => m.role === 'tool' && m.name === 'delegate');
    if (launches.length) out.push('<div class="dg-cards">' + launches.map((m, ordinal) => {
      const dg = delegateCallOf(m);
      return `<div class="dg-card" data-dg-key="${esc(d.key)}" data-dg-eid="${esc(m.eid || '')}" data-dg-call="${esc(m.id || '')}" data-dg-id="${esc(dg.taskId || '')}" data-dg-title="${esc(dg.title)}" data-dg-ordinal="${ordinal}"></div>`;
    }).join('') + '</div>');
    work = [];
  };
  if (after.has('')) out.push(after.get(''));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i], first = i === 0 || msgs[i - 1].eid !== m.eid;
    if (first && before.has(m.eid)) { flush(); out.push(before.get(m.eid)); }
    if (replacements.has(m.eid) && m.eid !== exact) {
      flush(); if (first) out.push(replacements.get(m.eid));
    } else if ((!skip.has(m.eid) && !ConversationFlow.transport(m)) || m.eid === exact) {
      // Assistant commentary is addressed to the reader even when the same
      // source entry also contains tool calls. Preserve its position.
      if (['tool', 'toolresult', 'thinking'].includes(m.role)) work.push(m);
      else {
        flush();
        if (m.role === 'assistant' && m.model && m.model !== barModel) {
          if (barModel) out.push(`<div class="modelbar">model → ${esc(m.model)}</div>`);
          barModel = m.model;
        }
        const op = ConversationFlow.operation(m);
        if (op?.kind === 'edit') out.push(`<div class="flow-origin">${m.role === 'user' ? 'Edited question' : 'Your correction'}${op.sourceEntryId ? ` · <button data-reader-entry="${esc(op.sourceEntryId)}">Read original</button>` : ''}</div>`);
        out.push(msgBlock(m, esc, true, q, indexes.get(m._source), d.key));
      }
    }
    if (msgs[i + 1]?.eid !== m.eid && after.has(m.eid)) { flush(); out.push(after.get(m.eid)); }
  }
  flush();
  return out.join('');
}

function answerChoices(group) {
  return [...group.answers.map((a, i) => ({ ...a, label: `${a.operation?.kind === 'edit' ? 'Your correction' : 'Answer ' + (i + 1)} · ${a.model || 'assistant'}${a.fork ? ' · separate conversation' : ''}` })),
    ...(group.both ? [{ ...group.both, label: 'All answers included', kind: 'both' }] : []),
    ...(group.merges || (group.merge ? [group.merge] : [])).map((m, i) => ({ ...m.answer, kind: 'merge', label: 'Merged answer' + (i ? ' ' + (i + 1) : '') + ' · ' + (m.answer.model || 'assistant') }))];
}
function choiceToken(a) { return JSON.stringify({ key: a.key || current.key, id: a.id }); }
// Dataset tokens are JSON embedded in double-quoted attributes. A token that
// does not survive the HTML round-trip must surface as a toast, not die as a
// console exception behind a dead button.
function parseChoiceToken(raw, what = 'control') {
  try { return JSON.parse(raw); } catch { errToast('This ' + what + ' lost its target. Reload the conversation.'); return null; }
}
function answerPackageHtml(d, group, answer) {
  const source = answer.key === d.key || !answer.key ? d : readerSessions.get(answer.key);
  if (!source) return `<div class="flow-load-error">This answer’s conversation could not be loaded. <button data-reader-path="${esc(choiceToken(answer))}">Open separate conversation</button></div>`;
  const messages = ConversationFlow.packageMessages(source, ConversationFlow.trace(source), group, answer);
  if (!messages.length) return `<div class="flow-load-error">Answer unavailable in the current snapshot. <button data-reader-retry>Reload answers</button></div>`;
  return transcriptFragmentHtml(source, messages);
}
function includedAnswersHtml(d, group) {
  const ids = new Set([group.both.id, ...(group.both.entryIds || [])]);
  const bridge = d.messages.find(m => ids.has(m.eid) && ConversationFlow.operation(m)?.kind === 'both');
  const sources = bridge?.operation?.sources || [];
  const quote = () => bridge ? msgBlock({ ...bridge, text: bridge.text.replace(/<!--[\s\S]*?-->/g, '').trim() }, esc, true, '', d.messages.indexOf(bridge), d.key) : '<p>The included-answer snapshot is unavailable. Reload this conversation.</p>';
  const quoted = [];
  const pieces = sources.map((source, i) => {
    const data = !source.key || source.key === d.key ? d : readerSessions.get(source.key);
    if (!data || !source.id) return null;
    const entryIds = new Set(source.entryIds?.length ? source.entryIds : [source.id]);
    const toolEntries = new Set(data.messages.filter(m => m.role === 'tool').map(m => m.eid));
    const messages = data.messages.filter(m => entryIds.has(m.eid) && m.role === 'assistant' && !toolEntries.has(m.eid));
    if (!messages.length) return null;
    quoted.push(`=== ${source.model || 'model'} ===\n${messages.map(m => m.text).join('\n\n').trim()}`);
    return `<section class="flow-answer"><div class="flow-answer-head">Answer ${i + 1} · ${esc(source.model || 'assistant')}<button data-reader-path="${esc(choiceToken({ key: data.key, id: source.id }))}" data-at="${esc(group.node)}">Read original and work</button></div>${transcriptFragmentHtml(data, messages)}</section>`;
  });
  // The saved bridge is the context snapshot. If source files were edited
  // outside the app, never substitute their changed text for what was included.
  const matchesSnapshot = bridge && quoted.join('\n\n') === bridge.text.replace(/\s*<!--\s*aiconvo:both\s*-->\s*$/, '').trim();
  return `<div class="flow-included"><div class="flow-origin">Included answer text · tool histories and images are not combined</div>${pieces.length && pieces.every(Boolean) && matchesSnapshot ? pieces.join('') : quote()}</div>`;
}
function answerDetailsHtml(answer) {
  const details = [['Model', answer.model || 'not recorded'], ['Source entry', answer.id]];
  if (answer.tok != null) details.push(['Tokens', Number(answer.tok).toLocaleString()]);
  if (answer.cost != null) details.push(['Recorded cost', '$' + Number(answer.cost).toFixed(4)]);
  if (answer.secs != null) details.push(['Reply time', answer.secs + ' seconds']);
  return `<details class="flow-answer-info"><summary>Answer details</summary><dl>${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details>`;
}
function comparisonHtml(d, group) {
  const state = readerGroup(d.key, group.node);
  if (!state.compare) return '';
  const choices = answerChoices(group).filter(a => a.kind !== 'both');
  const ids = new Set(choices.map(a => a.id));
  state.pair = [state.pair[0], state.pair[1]].map((id, i) => ids.has(id) ? id : choices[i]?.id);
  const selected = state.pair.map(id => choices.find(a => a.id === id)).filter(Boolean);
  return `<div class="flow-comparison" data-msg-key="${esc(d.key)}" data-mobile-side="${state.compareSide === 1 ? 1 : 0}"><div class="flow-mobile-switch" role="group" aria-label="Comparison answer to read">${selected.map((a, i) => `<button data-reader-side="${esc(group.node)}" data-side="${i}" aria-pressed="${i === (state.compareSide || 0)}">${i === 0 ? 'First answer' : 'Second answer'}</button>`).join('')}</div><div class="flow-pair">${selected.map((a, side) => `<section class="flow-answer" data-compare-side="${side}"><div class="flow-answer-head"><select aria-label="${side === 0 ? 'First' : 'Second'} answer to compare" data-reader-pair="${esc(group.node)}" data-side="${side}">${choices.map(c => `<option value="${esc(c.id)}"${a.id === c.id ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>${answerPackageHtml(d, group, a)}<div class="flow-answer-foot"><button data-reader-path="${esc(choiceToken(a))}" data-at="${esc(group.node)}">Read this path and its follow-up</button>${answerDetailsHtml(a)}</div></section>`).join('')}</div></div>`;
}
function answerGroupHtml(d, group, trace) {
  const choices = answerChoices(group);
  const on = choices.find(c => (!c.key || c.key === d.key) && trace?.onPath.has(c.id));
  if (readerGroup(d.key, group.node).compare) return `<section class="flow-turn" data-flow-anchor="${esc(group.node)}"><div class="flow-turn-bar"><b class="flow-compare-title">Compare answers</b><button data-reader-compare="${esc(group.node)}" aria-expanded="true">Back to reading</button>${d.source !== 'claude' ? `<button data-reader-merge="${esc(group.node)}">Merge…</button>` : ''}</div>${comparisonHtml(d, group)}<div class="flow-origin">${on ? 'Conversation below follows ' + esc(on.label) : 'Choose a path to read its follow-up.'}</div></section>`;
  return `<section class="flow-turn" data-flow-anchor="${esc(group.node)}"><div class="flow-turn-bar"><label><span>${group.kind === 'parallel' ? 'Parallel answers' : 'Answers'} · ${group.answers.length}</span><select data-reader-answer="${esc(group.node)}" aria-label="Answer to read"><option value=""${!on ? ' selected' : ''} disabled>Choose an answer to read</option>${choices.map(c => `<option value="${esc(choiceToken(c))}"${c === on ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label><button data-reader-prev="${esc(group.node)}" aria-label="Previous answer">←</button><button data-reader-next="${esc(group.node)}" aria-label="Next answer">→</button><button data-reader-compare="${esc(group.node)}" aria-expanded="${!!readerGroup(d.key, group.node).compare}">Compare</button>${d.source !== 'claude' ? `<button data-reader-both="${esc(group.node)}">Include all</button><button data-reader-merge="${esc(group.node)}">Merge…</button>` : ''}</div>${comparisonHtml(d, group)}</section>`;
}
function branchPointHtml(point) {
  return `<details class="flow-paths" data-flow-anchor="${esc(point.node)}"><summary>${point.choices.length === 1 ? 'Saved continuation · read what followed' : point.choices.length + ' conversation paths · choose a path to read'}</summary><div>${point.choices.map(c => `<button class="flow-path" data-reader-path="${esc(choiceToken(c))}" data-at="${esc(point.node)}"${c.current ? ' aria-current="true"' : ''}><b>${esc(c.kind || 'Another path')}${c.current ? ' · reading' : ''}</b><span>${esc(c.text || c.title || 'Continue from this point')}</span>${c.count ? `<small>${c.count} messages in this path and its alternatives</small>` : ''}</button>`).join('')}</div></details>`;
}

async function prepareConversationReading(d, scroll) {
  const serial = ++readerRenderSerial;
  readerSessions.set(d.key, d);
  let flow;
  try { flow = await loadConversationFlow(d.key); }
  catch (error) { flow = { groups: [], branches: [], error: error.message }; }
  if (serial !== readerRenderSerial || current !== d) return null;
  readerFlow = flow;
  // Exact/search links read the containing path, not an isolated off-path bubble.
  const entry = typeof scroll === 'string' && scroll.startsWith('entry:') ? scroll.slice(6)
    : typeof scroll === 'string' && scroll.startsWith('hit:') ? d.messages[Number(scroll.slice(4))]?.eid : null;
  let trace = computeTrace(d);
  if (entry && trace && !trace.onPath.has(entry)) {
    readerState(d.key).leaf = ConversationFlow.follow(trace, entry, readerState(d.key).routes[entry]);
    trace = computeTrace(d); saveReaderState(d.key);
  }
  for (const g of flow.groups) {
    const state = readerGroup(d.key, g.node), live = g.runId && readerState(d.key).groups['run:' + g.runId];
    if (live && !state.fromRun) {
      state.fromRun = g.runId; state.compare = !!live.compare;
      const index = Math.min(live.liveIndex || 0, g.answers.length - 1);
      state.pair = [g.answers[index]?.id, g.answers[(index + 1) % g.answers.length]?.id];
      if (!readerState(d.key).leaf && g.both && readerPendingChoice(d) === g.both.id) readerState(d.key).leaf = g.answers[index]?.id || null;
      saveReaderState(d.key); trace = computeTrace(d);
    }
  }
  const groups = flow.groups.filter(g => !trace || trace.onPath.has(g.node));
  const visibleExternal = new Set();
  for (const g of groups) if (readerGroup(d.key, g.node).compare || (g.both && trace?.onPath.has(g.both.id))) {
    for (const a of [...g.answers, ...(g.merges || []).map(m => m.answer)]) if (a.key && a.key !== d.key) visibleExternal.add(a.key);
  }
  await Promise.all([...visibleExternal].map(async key => {
    try {
      const res = await fetch('/api/session?id=' + encodeURIComponent(key));
      const source = await res.json();
      if (res.ok && !source.error) readerSessions.set(key, source);
      else readerSessions.delete(key);
    } catch { readerSessions.delete(key); } // Never substitute a stale source snapshot.
  }));
  if (serial !== readerRenderSerial || current !== d) return null;
  for (const key of readerSessions.keys()) if (key !== d.key && !visibleExternal.has(key)) readerSessions.delete(key);
  const after = new Map(), before = new Map(), replacements = new Map(), skip = new Set();
  const add = (map, id, html) => map.set(id, (map.get(id) || '') + html);
  const projected = ConversationFlow.project(d, trace);
  const displayed = new Set(projected.map(m => m.eid));
  const anchorFor = id => {
    const seen = new Set();
    while (id && !displayed.has(id) && !seen.has(id)) { seen.add(id); id = trace?.parents.get(id); }
    return id || '';
  };
  for (const g of groups) {
    add(after, anchorFor(g.node), answerGroupHtml(d, g, trace));
    if (readerGroup(d.key, g.node).compare) {
      for (const a of g.answers) if ((!a.key || a.key === d.key) && trace?.onPath.has(a.id) && readerGroup(d.key, g.node).pair.includes(a.id)) {
        for (const m of ConversationFlow.packageMessages(d, trace, g, a)) skip.add(m.eid);
      }
    }
    if (g.both && trace?.onPath.has(g.both.id)) {
      replacements.set(g.both.id, includedAnswersHtml(d, g));
    }
    for (const merge of g.merges || (g.merge ? [g.merge] : [])) {
      if (!trace?.onPath.has(merge.answer.id)) continue;
      const sourceNames = (merge.sources || []).map(s => s.model || 'answer');
      add(before, merge.bridgeId, `<div class="flow-origin">Merged ${sourceNames.length ? 'from ' + esc(sourceNames.join(' + ')) : 'answer · earlier source selection not recorded'} · <button data-reader-sources="${esc(g.node)}">View source answers</button></div>`);
    }
  }
  const excluded = new Set(groups.map(g => g.node));
  const local = ConversationFlow.branches(d, trace, excluded);
  const points = new Map(local.map(p => [p.node, p]));
  for (const point of flow.branches || []) {
    if (trace && !trace.onPath.has(point.node)) continue;
    const existing = points.get(point.node);
    if (existing) {
      for (const choice of point.choices) if (choice.key !== d.key && !existing.choices.some(c => c.id === choice.id)) existing.choices.push(choice);
    } else points.set(point.node, { ...point, anchor: anchorFor(point.node) });
  }
  for (const point of points.values()) add(after, point.anchor || '', branchPointHtml(point));
  const unlinked = trace ? d.messages.filter(m => !m.eid || !trace.parents.has(m.eid)) : [];
  const unlinkedHtml = unlinked.length ? `<details class="flow-paths" data-flow-anchor="unlinked"${entry && unlinked.some(m => m.eid === entry) ? ' open' : ''}><summary>${unlinked.length} messages without a recorded path</summary>${transcriptFragmentHtml(d, unlinked, { exact: entry })}</details>` : '';
  const origin = flow.origin ? `<div class="flow-origin flow-fork">Separate conversation · forked from <button data-reader-origin="${esc(JSON.stringify(flow.origin))}">${esc(flow.origin.title)}</button></div>` : '';
  const error = flow.error ? `<div class="flow-load-error">${esc(flow.error)} The conversation is still readable. <button data-reader-retry>Retry paths</button></div>` : '';
  return { html: origin + error + transcriptFragmentHtml(d, projected, { after, before, replacements, skip, exact: entry, q: typeof scroll === 'string' && scroll.startsWith('hit:') ? transcriptQuery : '' }) + unlinkedHtml, trace };
}

function wireConversationReader() {
  const view = $('view'), key = current.key;
  view.querySelectorAll('[data-step-review]').forEach(b => b.onclick = () => { const d = parseChoiceToken(b.dataset.stepReview, 'review button'); if (d) openStepReview(d); });
  const blocked = readerIsBrowsing(current) || !!readerPendingChoice(current);
  for (const id of ['agentRun', 'agentSend']) if ($(id)) $(id).disabled = blocked;
  const group = node => readerFlow.groups.find(g => g.node === node);
  const redraw = async node => {
    const el = view.querySelector(`[data-flow-anchor="${CSS.escape(node)}"]`);
    const anchor = el ? { id: node, flow: true, offset: el.getBoundingClientRect().top - view.getBoundingClientRect().top } : rememberReaderAnchor();
    saveReaderState(key); await renderConv('preserve'); restoreReaderAnchor(anchor);
  };
  view.querySelectorAll('[data-reader-continue-at]').forEach(b => b.onclick = async () => {
    const choice = parseChoiceToken(b.dataset.readerContinueAt, 'continue button');
    if (!choice) return;
    if (choice.key !== current?.key) await browseConversationPath(choice.key, choice.id, choice.id, { exact: true });
    if (current?.key === choice.key) await continueReadingPath(choice.key, choice.id, b);
  });
  view.querySelectorAll('[data-reader-fork-at]').forEach(b => b.onclick = () => {
    const choice = parseChoiceToken(b.dataset.readerForkAt, 'fork button');
    if (choice) forkFrom(choice.key, { id: choice.id }, b);
  });
  view.querySelectorAll('[data-reader-path]').forEach(b => b.onclick = () => {
    const choice = parseChoiceToken(b.dataset.readerPath, 'path button');
    if (choice) browseConversationPath(choice.key, choice.id, b.dataset.at);
  });
  view.querySelectorAll('[data-reader-answer]').forEach(select => select.onchange = () => {
    const choice = parseChoiceToken(select.value, 'answer picker');
    if (choice) browseConversationPath(choice.key, choice.id, select.dataset.readerAnswer);
  });
  for (const [attr, step] of [['readerPrev', -1], ['readerNext', 1]]) view.querySelectorAll(`[data-${attr.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}]`).forEach(b => {
    const g = group(b.dataset[attr]), choices = g && answerChoices(g), t = computeTrace(current);
    const at = choices?.findIndex(c => c.key === key && t?.onPath.has(c.id));
    const choice = choices?.[(at < 0 ? (step > 0 ? -1 : 1) : at) + step];
    b.disabled = !choice;
    if (choice) b.onclick = () => browseConversationPath(choice.key || key, choice.id, g.node);
  });
  view.querySelectorAll('[data-reader-compare], [data-reader-sources]').forEach(b => b.onclick = () => {
    const node = b.dataset.readerCompare || b.dataset.readerSources, state = readerGroup(key, node);
    state.compare = b.dataset.readerSources ? true : !state.compare;
    redraw(node);
  });
  view.querySelectorAll('[data-reader-side]').forEach(b => b.onclick = () => {
    const node = b.dataset.readerSide, side = Number(b.dataset.side);
    readerGroup(key, node).compareSide = side; saveReaderState(key);
    const comparison = b.closest('.flow-comparison'); comparison.dataset.mobileSide = String(side);
    comparison.querySelectorAll('[data-reader-side]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.side) === side)));
  });
  view.querySelectorAll('[data-reader-pair]').forEach(select => select.onchange = () => {
    readerGroup(key, select.dataset.readerPair).pair[Number(select.dataset.side)] = select.value;
    redraw(select.dataset.readerPair);
  });
  view.querySelectorAll('[data-reader-merge]').forEach(b => b.onclick = () => openConversationMerge(key, b.dataset.readerMerge));
  view.querySelectorAll('[data-reader-both]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const g = group(b.dataset.readerBoth);
      const out = await postJson('/api/node/both', { id: key, node: g.node });
      if (out?.error || !out?.id) throw Error(out?.error || 'Could not include these answers.');
      await continueReadingPath(key, out.id, b, !out.existed ? out.id : null);
    } catch (error) { errToast(error.message); }
    finally { if (b.isConnected) b.disabled = false; }
  });
  view.querySelectorAll('[data-reader-entry]').forEach(b => b.onclick = () => open(key, 'entry:' + b.dataset.readerEntry));
  view.querySelectorAll('[data-reader-origin]').forEach(b => b.onclick = () => {
    const origin = parseChoiceToken(b.dataset.readerOrigin, 'fork origin');
    if (origin) open(origin.key, origin.entryId ? 'entry:' + origin.entryId : 'top');
  });
  view.querySelectorAll('[data-reader-retry]').forEach(b => b.onclick = () => { compareCache.delete(key); renderConv('preserve'); });
  $('readerDestination')?.querySelector('[data-reader-return]')?.addEventListener('click', () => browseConversationPath(key, null, null));
  $('readerDestination')?.querySelector('[data-reader-continue]')?.addEventListener('click', e => continueReadingPath(key, computeTrace(current)?.leaf, e.currentTarget));
  $('readerDestination')?.querySelector('[data-reader-include]')?.addEventListener('click', e => continueReadingPath(key, e.currentTarget.dataset.readerInclude, e.currentTarget));
  $('readerDestination')?.querySelector('[data-reader-review]')?.addEventListener('click', () => {
    const node = readerFlow.groups.find(g => g.both?.id === readerPendingChoice(current))?.node;
    if (node) view.querySelector(`[data-flow-anchor="${CSS.escape(node)}"]`)?.scrollIntoView({ block: 'start' });
  });
  view.querySelectorAll('.flow-paths').forEach(el => {
    const state = readerGroup(key, el.dataset.flowAnchor);
    el.open = !!state.pathsOpen;
    el.ontoggle = () => { state.pathsOpen = el.open; saveReaderState(key); };
  });
  // Store element-relative reading positions, not fragile document pixels.
  if (!view.dataset.readerScrollBound) {
    view.dataset.readerScrollBound = '1';
    let timer;
    view.addEventListener('scroll', () => {
      clearTimeout(timer);
      const transcript = $('conversationTranscript'), key = current?.key;
      timer = setTimeout(() => {
        if (viewKind !== 'conversation' || current?.key !== key || $('conversationTranscript') !== transcript) return;
        rememberConversationPosition();
      }, 180);
    }, { passive: true });
  }
}

async function openConversationMerge(key, node) {
  let data;
  try { data = await loadConversationFlow(key); } catch (error) { return errToast(error.message); }
  const existing = document.querySelector('.flow-merge-dialog');
  if (existing) { existing.focus(); return; }
  const group = data.groups.find(g => g.node === node);
  if (!group) return errToast('These answers are no longer available. Reload the conversation.');
  const state = readerGroup(key, node), trigger = document.activeElement;
  if (!state.sources) state.sources = group.answers.map(a => a.id);
  const models = key === current?.key ? fanModels() : readerSessions.get(key)?.selectedModels || [];
  if (!state.model && models[0]) state.model = models[0];
  const dialog = document.createElement('dialog');
  dialog.className = 'flow-merge-dialog';
  dialog.setAttribute('aria-labelledby', 'flowMergeTitle');
  dialog.innerHTML = `<h2 id="flowMergeTitle">Merge answers</h2><p>Write a new answer from the selected sources and their shared conversation. Originals stay saved. The new answer becomes your continuation.</p><fieldset><legend>Source answers</legend>${group.answers.map((a, i) => `<label class="flow-source"><input type="checkbox" value="${esc(a.id)}"${state.sources.includes(a.id) ? ' checked' : ''}><span><b>Answer ${i + 1} · ${esc(a.model || 'assistant')}</b><span>${esc(String(a.text || '').replace(/\s+/g, ' ').slice(0, 160))}</span></span></label>`).join('')}</fieldset><label class="flow-instruction">Instructions <span>(optional)</span><textarea rows="4" placeholder="For example: resolve disagreements and explain the final recommendation."></textarea></label><button data-merge-model></button><p class="flow-merge-error" role="alert"></p><div class="flow-merge-footer"><button data-merge-cancel>Cancel</button><button class="primary" data-merge-start>Merge answers</button></div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('keydown', event => event.stopPropagation());
  const ta = dialog.querySelector('textarea'); ta.value = state.instruction || '';
  const error = dialog.querySelector('.flow-merge-error'), start = dialog.querySelector('[data-merge-start]');
  const save = () => { state.sources = [...dialog.querySelectorAll('input:checked')].map(i => i.value); state.instruction = ta.value; saveReaderState(key); start.disabled = state.sources.length < 2; };
  ta.oninput = save;
  dialog.querySelectorAll('input').forEach(i => i.onchange = save);
  const model = dialog.querySelector('[data-merge-model]');
  const paintModel = () => model.textContent = 'Merge model · ' + (state.model?.modelId || 'session model') + ' ▾';
  paintModel();
  model.onclick = () => {
    openModelPicker(model, { multi: false, selected: new Set(state.model ? [state.model.provider + '/' + state.model.modelId] : []) }, picked => {
      if (picked?.[0]) { state.model = picked[0]; saveReaderState(key); paintModel(); model.focus(); }
    });
    // Keep the picker inside the dialog's accessible top layer.
    const picker = document.querySelector('.mpick');
    if (picker) dialog.appendChild(picker);
  };
  const close = () => { save(); dialog.close(); dialog.remove(); if (trigger?.isConnected) trigger.focus(); };
  dialog.querySelector('[data-merge-cancel]').onclick = close;
  dialog.addEventListener('cancel', e => { e.preventDefault(); if (!start.dataset.busy) close(); });
  start.onclick = async () => {
    save(); if (start.disabled) return;
    start.dataset.busy = '1'; start.textContent = 'Starting merge…'; error.textContent = '';
    dialog.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = true; });
    const payload = { id: key, node, answers: state.sources, instruction: state.instruction, provider: state.model?.provider, modelId: state.model?.modelId };
    try {
      let out = await postJson('/api/node/aggregate', payload);
      if (out?.needsForce && confirm('A terminal owns this conversation. Stop it and merge from the web?')) out = await postJson('/api/node/aggregate', { ...payload, force: true });
      if (!out || out.error) throw Error(out?.error || 'The merge did not start.');
      compareCache.delete(key); resetConversationReading(key); close();
      if (activeRel === key) await open(key, 'bottom');
      toast('Merging the selected answers. Originals stay saved.');
    } catch (e) { error.textContent = e.message; }
    finally { if (start.isConnected) {
      delete start.dataset.busy;
      dialog.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = false; });
      start.textContent = 'Merge answers'; save();
    } }
  };
  save(); dialog.showModal();
}

// Live replies share the transcript renderer, not the work monitor.
function savedLiveReplies(ledger, messages) {
  const matches = new Map();
  let after = -1;
  for (const id of ledger.order) {
    const b = ledger.blocks.get(id);
    if (b.kind === 'tool' || !b.text || (!b.done && !ledger.done)) continue;
    const index = messages.findIndex((m, i) => i > after && m.role === 'assistant'
      && Date.parse(m.ts) >= ledger.startedAt && m.text === b.text);
    if (index >= 0) { matches.set(id, messages[index]); after = index; }
  }
  return matches;
}

function liveReplyUnits(L) {
  const units = [];
  let work = null;
  for (const id of L.order) {
    const b = L.blocks.get(id);
    if (b.kind === 'tool' || b.think) {
      if (!work) { work = { kind: 'work', id, order: [], blocks: new Map() }; units.push(work); }
      work.order.push(id); work.blocks.set(id, b);
    }
    if (b.kind !== 'tool' && b.text) {
      units.push({ kind: 'reply', id, block: b }); work = null;
    }
  }
  return units;
}

function renderLiveReplyLedger(host, jobId, L, saved = new Map(), { expandedWork = false } = {}) {
  const selection = window.getSelection();
  let previous = null;
  const place = el => {
    const next = previous ? previous.nextElementSibling : host.firstElementChild;
    if (next !== el) host.insertBefore(el, next);
    previous = el;
  };
  const workKeys = new Set();
  const savedThrough = L.order.reduce((last, id, i) => saved.has(id) ? i : last, -1);
  for (const unit of liveReplyUnits(L)) {
    // Work before an already-saved reply is already in the transcript too.
    // Reopening mid-run must not append a second copy of that work.
    if (unit.kind === 'work' && unit.order.every(id => L.order.indexOf(id) <= savedThrough)) continue;
    const id = unit.id, b = unit.block;
    const token = jobId + ':' + id;
    if (unit.kind === 'work') {
      workKeys.add(token);
      let work = host.querySelector(`[data-live-work="${CSS.escape(token)}"]`);
      if (!work) {
        work = document.createElement('details');
        work.className = 'toolgroup'; work.dataset.liveWork = token;
        work.innerHTML = '<summary></summary><div></div>';
        work._ledger = { order: [], blocks: new Map() };
      }
      place(work);
      if (expandedWork) work.open = true;
      const blocks = [...unit.blocks.values()];
      const names = [...new Set(blocks.map(b => b.kind === 'tool' ? b.name || 'tool' : 'thinking'))];
      const working = blocks.some(b => b.kind === 'tool' ? b.phase !== 'done' : !b.done);
      setLiveText(work.querySelector('summary'), (working && !L.done ? '◌ ' : '') + blocks.length + ' steps · ' + names.join(' · '));
      work._ledger.order = unit.order; work._ledger.blocks = unit.blocks;
      if (work.open) renderLsBlocks(work._ledger, work.querySelector('div'));
      work.ontoggle = () => { if (work.open) renderLsBlocks(work._ledger, work.querySelector('div')); };
      continue;
    }
    let el = host.querySelector(`[data-live-reply="${CSS.escape(token)}"]`);
    if (saved.has(id)) { if (el) el.remove(); continue; }
    if (!el) {
      const template = document.createElement('template');
      template.innerHTML = msgBlock({ role: 'assistant', text: '', eid: 'live:' + token }, esc, true, '', -1, L.key);
      el = template.content.firstElementChild; el.dataset.liveReply = token;
    }
    place(el);
    const message = { role: 'assistant', text: b.text, eid: 'live:' + token };
    readerLiveMessages.set(message.eid, message);
    const selected = selection && !selection.isCollapsed && (el.contains(selection.anchorNode) || el.contains(selection.focusNode));
    const now = Date.now(), interval = isEink() ? 1200 : 160;
    if (el._text !== b.text && !selected && (!el._paintAt || now - el._paintAt >= interval || b.done || L.done)) {
      el.querySelector('.md').innerHTML = mdRender(b.text, '');
      el._text = b.text; el._paintAt = now;
    }
  }
  for (const work of host.querySelectorAll('[data-live-work]')) if (!workKeys.has(work.dataset.liveWork)) work.remove();
}

function selectedLiveStream() {
  const runs = [...activeRuns.values()].filter(r => r.key === activeRel);
  const running = runs.at(-1);
  if (running) return [running.jobId, runLedgers.get(running.jobId)];
  return [...runLedgers].filter(([, L]) => L.key === activeRel && L.done).at(-1) || [];
}

function renderOpenLiveStream(L, jobId) {
  const host = $('lsBlocks');
  if (!host || !L || !jobId || current?.key !== activeRel || L.key !== activeRel) return;
  if (host._replyLedger !== L) {
    host.replaceChildren(); host._replyLedger = L;
    host.dataset.conversationKey = L.key;
    host.scrollTop = 0;
  }
  const pin = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  renderLiveReplyLedger(host, jobId, L, new Map(), { expandedWork: true });
  if (pin) host.scrollTop = host.scrollHeight;
}

function renderLiveReplies() {
  const host = $('liveReplies');
  if (!host || !current || current.key !== activeRel || host.dataset.conversationKey !== activeRel) return;
  host.hidden = readerIsBrowsing(current);
  if (host.hidden) return;
  for (const run of [...host.children]) {
    const owner = runLedgers.get(run.dataset.replyRun);
    if (!owner || owner.key !== activeRel) run.remove();
  }
  for (const [jobId, L] of runLedgers) {
    if (L.key !== activeRel || (L.fanoutId && L.fanoutRootKey === activeRel)) continue;
    let run = host.querySelector(`[data-reply-run="${CSS.escape(jobId)}"]`);
    if (!run) {
      run = document.createElement('div'); run.dataset.replyRun = jobId;
      host.appendChild(run);
    }
    const saved = savedLiveReplies(L, current.messages);
    const texts = L.order.filter(id => L.blocks.get(id).text);
    if (L.done && texts.length && texts.every(id => saved.has(id))) { run.remove(); continue; }
    // Live text belongs to one visible surface: the open stream or the
    // transcript. Both are projections of this conversation's same ledger.
    run.hidden = liveOpen && selectedLiveStream()[1] === L;
    if (!run.hidden) renderLiveReplyLedger(run, jobId, L, saved);
  }
}

function captureLiveReplyHandoff(d) {
  const host = $('liveReplies');
  if (!host || host.dataset.conversationKey !== d.key) return null;
  const adopted = [];
  for (const [jobId, L] of runLedgers) {
    if (L.key !== d.key || (L.fanoutId && L.fanoutRootKey === d.key)) continue;
    for (const [id, m] of savedLiveReplies(L, d.messages)) {
      const el = host.querySelector(`[data-live-reply="${CSS.escape(jobId + ':' + id)}"]`);
      if (el && m.eid) adopted.push({ el, eid: m.eid });
    }
  }
  return { host, adopted };
}

function restoreLiveReplyHandoff(handoff) {
  if (!handoff) return;
  $('liveReplies').replaceWith(handoff.host);
  for (const { el, eid } of handoff.adopted) {
    const saved = $('conversationTranscript').querySelector(`.msg.assistant[data-eid="${CSS.escape(eid)}"]`);
    if (!saved) continue;
    // Preserve the message and Markdown nodes; only saved-history controls
    // acquire the real entry identity and index.
    const message = current.messages.find(m => m.eid === eid && m.role === 'assistant');
    if (message && el._text !== message.text) {
      el.querySelector('.md').innerHTML = mdRender(message.text, '');
      el._text = message.text;
    }
    readerLiveMessages.delete(el.dataset.eid);
    el.querySelector('.msg-actions').replaceWith(saved.querySelector('.msg-actions'));
    for (const attr of [...saved.attributes]) el.setAttribute(attr.name, attr.value);
    delete el.dataset.liveReply;
    saved.replaceWith(el);
  }
}

function renderReaderParallel(stage, entries) {
  if (!stage) return;
  const runId = entries[0]?.[1].fanoutId;
  const represented = runId && readerFlow.groups.some(g => g.runId === runId);
  if (!entries.length || represented || (current && readerIsBrowsing(current))) {
    stage.hidden = true;
    return;
  }
  stage.hidden = false; stage.classList.add('flow-live');
  if ($('agentRun')) $('agentRun').disabled = entries.some(([, L]) => !L.done);
  const state = readerGroup(activeRel, 'run:' + runId);
  if (stage.dataset.fanout !== runId) {
    stage.dataset.fanout = runId;
    stage.dataset.flowAnchor = 'live:' + runId;
    stage.innerHTML = '<div class="flow-turn-bar"><label><span>Parallel answers</span><select aria-label="Live answer to read" data-live-select></select></label><button data-live-compare>Compare</button></div><div class="flow-live-answers"></div><div class="flow-live-note" role="status"></div>';
    stage.querySelector('[data-live-select]').onchange = e => {
      state.liveIndex = Number(e.target.value); saveReaderState(activeRel); renderParallelStage();
    };
    stage.querySelector('[data-live-compare]').onclick = () => { state.compare = !state.compare; saveReaderState(activeRel); renderParallelStage(); };
  }
  const select = stage.querySelector('[data-live-select]');
  for (const [i, [, L]] of entries.entries()) {
    let option = select.options[i];
    if (!option) { option = new Option('', String(i)); select.add(option); }
    const status = L.done ? (L.status === 'error' ? 'failed' : 'finished') : 'working';
    setLiveText(option, `Answer ${i + 1} · ${L.model || 'model'} · ${status}`);
  }
  select.value = String(Math.min(state.liveIndex || 0, entries.length - 1));
  stage.classList.toggle('comparing', !!state.compare);
  stage.querySelector('[data-live-compare]').setAttribute('aria-pressed', String(!!state.compare));
  const host = stage.querySelector('.flow-live-answers');
  for (const [i, [jobId, L]] of entries.entries()) {
    let section = host.querySelector(`[data-live-job="${CSS.escape(jobId)}"]`);
    if (!section) {
      section = document.createElement('section'); section.className = 'flow-answer'; section.dataset.liveJob = jobId;
      section.innerHTML = '<div class="flow-answer-head"><b></b><span class="flow-live-status"></span><button>Stop</button></div><details class="flow-live-work"><summary>Work and tools</summary><div class="flow-live-ledger"></div></details><div class="flow-live-reply"></div><div class="flow-answer-foot"><button data-live-open hidden>Open separate conversation</button></div>';
      host.appendChild(section);
      section.querySelector('[data-live-open]').onclick = () => open(L.key, 'reply');
      section.querySelector('button').onclick = async e => {
        const b = e.currentTarget; b.disabled = true;
        try { const out = await postJson('/api/run/abort', { jobId }); if (out?.error) throw Error(out.error); }
        catch (error) { errToast(error.message); b.disabled = false; }
      };
    }
    const selected = Number(select.value);
    // Reading owns one full-width answer. Explicit compare adds one neighbour,
    // not arbitrarily many narrow columns.
    section.hidden = i !== selected && (!state.compare || i !== (selected + 1) % entries.length);
    section.toggleAttribute('data-live-selected', i === selected);
    setLiveText(section.querySelector('b'), `Answer ${i + 1} · ${L.model || 'model'}`);
    setLiveText(section.querySelector('.flow-live-status'), L.done ? (L.status === 'error' ? 'Failed · ' + (L.error || L.statusText || '') : 'Finished') : L.statusText || 'Working…');
    section.querySelector('button').hidden = !!L.done;
    section.querySelector('[data-live-open]').hidden = !state.retained;
    section.querySelector('.flow-live-work').hidden = true;
    renderLiveReplyLedger(section.querySelector('.flow-live-reply'), jobId, L);
  }
  setLiveText(stage.querySelector('.flow-live-note'), state.retained
    ? 'These workers own delegated work, so their conversations stay separate. Open an answer’s conversation to continue there.'
    : entries.every(([, L]) => L.done)
    ? 'Saving these answers into the conversation…'
    : 'Read while the models work. When finished, choose an answer, include all, or merge.');
}
