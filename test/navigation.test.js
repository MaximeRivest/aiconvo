'use strict';
// design/44: the back/forward stack, against a fake browser history.
const test = require('node:test');
const assert = require('node:assert/strict');
const Navigation = require('../navigation.js');

// A browser's session history, as far as pushState/replaceState/go and
// popstate are concerned. `pop()` is what the page sees after a traversal.
function fakeBrowser() {
  const list = [{ state: null, url: '/' }];
  let at = 0;
  const location = { pathname: '/', search: '', get href() { return 'http://h' + list[at].url; }, get hash() { const u = list[at].url; const i = u.indexOf('#'); return i < 0 ? '' : u.slice(i); } };
  const history = {
    get state() { return list[at].state; },
    get length() { return list.length; },
    pushState(state, _t, url) { list.length = at + 1; list.push({ state, url: String(url).replace(/^http:\/\/h/, '') }); at++; },
    replaceState(state, _t, url) { list[at] = { state, url: String(url).replace(/^http:\/\/h/, '') }; },
    go(delta) { const to = at + delta; if (to < 0 || to >= list.length) throw new Error('out of range'); at = to; },
  };
  const storage = new Map();
  return {
    history, location, list, position: () => at,
    storage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    // A link click or a typed hash: the browser makes an entry we did not stamp.
    foreign(hash) { list.length = at + 1; list.push({ state: null, url: '/#' + hash }); at++; },
    hash() { return location.hash.slice(1); },
  };
}
const titles = { '': 'home', 'project=chattering': 'chattering', 'k1': 'Chat flow', 'k2': 'Diff links', 'file=/a.md': 'a.md' };
const describe = hash => ({ kind: hash ? hash.split('=')[0] : 'home', title: titles[hash] || hash });
const make = (browser, extra = {}) => Navigation.createStack({ history: browser.history, location: browser.location, storage: browser.storage, describe, now: () => 1, ...extra });

test('project scope travels with each history entry, including explicit All and reloads', () => {
  const b = fakeBrowser(), nav = make(b);
  nav.load('');
  const chat = nav.push('k1', { projectScope: '' });
  nav.push('project=chattering', { projectScope: 'chattering' });
  b.history.go(-1);
  assert.equal(nav.arrive(b.history.state, b.hash()).entry.projectScope, '');
  const restored = make(b); restored.load(b.hash());
  assert.equal(restored.current().projectScope, '');
  assert.equal(restored.rememberScope(chat.id, 'Loose conversations'), true);
  restored.replace('k1', { kind: 'conversation' });
  assert.equal(restored.current().projectScope, 'Loose conversations');
  b.history.go(1);
  assert.equal(restored.arrive(b.history.state, b.hash()).entry.projectScope, 'chattering');
});

test('push, back, forward: one entry per screen, forward dropped by a new push', () => {
  const b = fakeBrowser();
  const nav = make(b);
  nav.load('');
  assert.equal(nav.length(), 1);
  assert.equal(nav.canBack(), false);
  assert.equal(nav.canForward(), false);
  nav.push('project=chattering', { kind: 'project' });
  nav.push('k1', { kind: 'conversation' });
  assert.deepEqual(nav.entries().map(e => e.title), ['home', 'chattering', 'Chat flow']);
  assert.equal(b.history.state.nav.id, nav.current().id, 'the browser entry carries our stamp');
  assert.equal(b.hash(), 'k1');
  assert.ok(nav.back());
  const arrived = nav.arrive(b.history.state, b.hash());
  assert.equal(arrived.entry.title, 'chattering');
  assert.equal(arrived.delta, -1);
  assert.equal(nav.canForward(), true);
  assert.deepEqual(nav.ahead().map(e => e.title), ['Chat flow']);
  assert.deepEqual(nav.behind().map(e => e.title), ['home']);
  nav.push('k2', { kind: 'conversation' });
  assert.equal(nav.canForward(), false, 'a new screen forgets the forward path');
  assert.deepEqual(nav.entries().map(e => e.title), ['home', 'chattering', 'Diff links']);
  assert.equal(b.list.length, 3);
  assert.equal(nav.go(1), false, 'no forward → no browser call');
  assert.equal(nav.go(0), false);
});

test('go(n) walks several steps and reports the distance on arrival', () => {
  const b = fakeBrowser();
  const nav = make(b);
  nav.load('');
  for (const h of ['project=chattering', 'k1', 'file=/a.md', 'k2']) nav.push(h);
  assert.ok(nav.go(-3));
  let a = nav.arrive(b.history.state, b.hash());
  assert.equal(a.entry.title, 'chattering');
  assert.equal(a.delta, -3);
  assert.equal(nav.behind(15).length, 1);
  assert.equal(nav.ahead(15).length, 3);
  assert.ok(nav.go(2));
  a = nav.arrive(b.history.state, b.hash());
  assert.equal(a.entry.title, 'a.md');
  assert.equal(a.delta, 2);
});

test('replace updates the current entry in place and keeps the stamp', () => {
  const b = fakeBrowser();
  const nav = make(b);
  nav.load('');
  nav.push('file=/a.md');
  const id = nav.current().id;
  nav.replace('file&to=v2&path=/a.md');
  assert.equal(nav.current().id, id);
  assert.equal(nav.length(), 2);
  assert.equal(b.hash(), 'file&to=v2&path=/a.md');
  assert.equal(b.history.state.nav.id, id);
});

test('scroll positions are remembered per entry and survive traversal', () => {
  const b = fakeBrowser();
  const nav = make(b);
  nav.load('');
  nav.push('project=chattering');
  const project = nav.current().id;
  nav.push('k1');
  assert.ok(nav.remember(project, { view: 740, win: 0 }));
  assert.equal(nav.remember('nope', { view: 1 }), false);
  nav.back();
  const a = nav.arrive(b.history.state, b.hash());
  assert.deepEqual(a.entry.scroll, { view: 740, win: 0 });
});

test('a reload adopts the persisted stack at the stamped entry', () => {
  const b = fakeBrowser();
  const nav = make(b);
  nav.load('');
  nav.push('project=chattering');
  nav.push('k1');
  nav.back(); nav.arrive(b.history.state, b.hash());
  // Reload: a new stack object, the same tab storage, the same browser entry.
  const again = make(b);
  const entry = again.load(b.hash());
  assert.equal(entry.title, 'chattering');
  assert.equal(again.index(), 1);
  assert.equal(again.canForward(), true);
  assert.equal(again.length(), 3);
});

test('a foreign entry (link click, typed hash, pre-upgrade entry) joins as the newest', () => {
  const b = fakeBrowser();
  const nav = make(b);
  nav.load('');
  nav.push('project=chattering');
  nav.push('k1');
  nav.back(); nav.arrive(b.history.state, b.hash());
  b.foreign('k2');
  const a = nav.arrive(b.history.state, b.hash());
  assert.equal(a.foreign, true);
  assert.equal(a.entry.title, 'Diff links');
  assert.deepEqual(nav.entries().map(e => e.title), ['home', 'chattering', 'Diff links'], 'the forward path was dropped, as the browser did');
  assert.equal(b.history.state.nav.id, a.entry.id, 'the foreign entry is stamped so the next reload knows it');
  // First load of a tab whose history predates the stack: same rule.
  const fresh = fakeBrowser();
  fresh.foreign('k1');
  const cold = make(fresh);
  const first = cold.load(fresh.hash());
  assert.equal(first.title, 'Chat flow');
  assert.equal(cold.length(), 1);
  assert.equal(fresh.history.state.nav.id, first.id);
});

test('the stack is capped; the index follows the trim', () => {
  const b = fakeBrowser();
  const nav = make(b, { limit: 5 });
  nav.load('');
  for (let i = 0; i < 20; i++) nav.push('k' + i);
  assert.equal(nav.length(), 5);
  assert.equal(nav.index(), 4);
  assert.equal(nav.current().hash, 'k19');
  assert.equal(nav.behind(15).length, 4);
});

test('refresh learns titles that arrive late; listeners hear every change', () => {
  const b = fakeBrowser();
  const late = {};
  const nav = Navigation.createStack({ history: b.history, location: b.location, storage: b.storage, describe: h => ({ kind: 'x', title: late[h] || '' }) });
  const seen = [];
  nav.onChange(s => seen.push(s.index()));
  nav.load('');
  nav.push('k9');
  assert.equal(nav.current().title, '');
  late.k9 = 'Learned later';
  nav.refresh();
  assert.equal(nav.current().title, 'Learned later');
  assert.deepEqual(seen, [0, 1, 1]);
});

test('storage that throws or is missing does not break navigation', () => {
  const b = fakeBrowser();
  const broken = { getItem() { throw new Error('private mode'); }, setItem() { throw new Error('quota'); } };
  const nav = Navigation.createStack({ history: b.history, location: b.location, storage: broken, describe });
  nav.load('');
  nav.push('k1');
  assert.equal(nav.canBack(), true);
  const none = Navigation.createStack({ history: b.history, location: b.location });
  none.load('k1');
  none.push('k2');
  assert.equal(none.length(), 2);
});

test('holdScroll keeps the position while content settles and stops on input', () => {
  const observers = [];
  class RO { constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() { this.disconnected = true; } }
  const timers = [];
  const listeners = {};
  const scroller = { scrollTop: 0, isConnected: true, children: [{}], addEventListener(type, fn) { listeners[type] = fn; } };
  const stop = Navigation.holdScroll(scroller, 300, { ResizeObserver: RO, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
  assert.equal(scroller.scrollTop, 300);
  scroller.scrollTop = 0;           // content grew and the browser reset us
  observers[0].cb();
  assert.equal(scroller.scrollTop, 300, 'reapplied after a resize');
  listeners.wheel();                // the person scrolls: the hold ends
  assert.equal(observers[0].disconnected, true);
  scroller.scrollTop = 20; observers[0].cb();
  assert.equal(scroller.scrollTop, 20, 'no longer forced');
  assert.equal(timers[0].ms, 1200);
  stop();
  assert.equal(typeof Navigation.holdScroll(null, 1), 'function');
});
