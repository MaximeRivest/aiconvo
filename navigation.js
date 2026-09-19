'use strict';
// The back/forward stack of the main screen (design/44).
//
// The browser keeps the session history but tells a page almost nothing
// about it: no length it can trust, no titles, no "is there a forward". So
// the app keeps its own mirror: one entry per screen, stamped into each
// browser history entry through history.state, and persisted per tab in
// sessionStorage so a reload finds its place again. From that mirror come the
// ‹ › buttons, their tooltips, the long-press list of screens, and the scroll
// position each screen is returned to.
//
// The stack never renders anything: the app dispatches the hash as it always
// did. This file is loaded in the page as `Navigation` and by tests through
// require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Navigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const STORAGE_KEY = 'aiconvo.nav';
  const LIMIT = 200;
  const VERSION = 1;

  function stamp(entry) { return { nav: { id: entry.id } }; }

  // One stack per tab. `history` and `location` are the browser's (or fakes
  // in tests); `storage` is sessionStorage or null; `describe(hash)` turns a
  // hash into { kind, title } and may be missing.
  function createStack({ history, location, storage = null, describe = null, limit = LIMIT, key = STORAGE_KEY, now = Date.now } = {}) {
    if (!history || !location) throw new Error('createStack needs history and location');
    let entries = [], index = -1, seq = 0;
    const listeners = new Set();

    // The document's own URL with the fragment swapped: works on every
    // origin (a served page, a file, about:blank), unlike a rebuilt path.
    const url = hash => {
      try { const u = new URL(location.href); u.hash = hash ? '#' + hash : ''; return u.href; }
      catch { return hash ? '#' + hash : location.pathname + location.search; }
    };
    const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } } };
    const persist = () => {
      if (!storage) return;
      try { storage.setItem(key, JSON.stringify({ v: VERSION, seq, index, entries })); } catch {}
    };
    const restore = () => {
      if (!storage) return false;
      try {
        const raw = storage.getItem(key);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || data.v !== VERSION || !Array.isArray(data.entries)) return false;
        entries = data.entries.filter(e => e && typeof e.id === 'string' && typeof e.hash === 'string');
        seq = Number.isInteger(data.seq) ? data.seq : entries.length;
        index = Math.min(Math.max(-1, Number(data.index)), entries.length - 1);
        return entries.length > 0;
      } catch { return false; }
    };
    const described = (hash, meta) => {
      let d = null;
      if (describe) { try { d = describe(hash) || null; } catch { d = null; } }
      return { kind: (meta && meta.kind) || (d && d.kind) || '', title: (d && d.title) || (meta && meta.title) || '' };
    };
    const make = (hash, meta) => {
      const d = described(hash, meta);
      return { id: 'n' + (++seq).toString(36), hash: hash || '', kind: d.kind, title: d.title, at: now(), scroll: null,
        ...(typeof meta?.projectScope === 'string' ? { projectScope: meta.projectScope } : {}) };
    };
    const trim = () => {
      const extra = entries.length - limit;
      if (extra > 0) { entries.splice(0, extra); index = Math.max(0, index - extra); }
    };
    const findIndex = id => entries.findIndex(e => e.id === id);
    const stateId = state => state && state.nav && typeof state.nav.id === 'string' ? state.nav.id : null;

    // Append a new entry after the current one, dropping any forward
    // entries — what browsers do. `own` tells whether the browser entry
    // already exists (a link click, a typed hash) or must be created.
    const append = (hash, meta, own) => {
      entries.length = index + 1;
      const entry = make(hash, meta);
      entries.push(entry);
      index = entries.length - 1;
      trim();
      try { history[own ? 'pushState' : 'replaceState'](stamp(entry), '', url(entry.hash)); } catch {}
      persist();
      emit();
      return entry;
    };

    const api = {
      // Page load. Adopts the persisted stack when the browser entry carries
      // our stamp; otherwise starts a stack at the current hash.
      load(hash) {
        const had = restore();
        const id = stateId(history.state);
        const i = had && id != null ? findIndex(id) : -1;
        if (i >= 0) {
          index = i;
          // A refresh keeps the hash; a stale mirror is corrected here.
          if (entries[i].hash !== (hash || '')) { entries[i] = { ...entries[i], hash: hash || '', ...described(hash, null) }; persist(); }
          emit();
          return entries[i];
        }
        // Fresh tab, first run after the upgrade, or a foreign entry: this
        // screen becomes the newest entry (after anything the tab already had).
        if (!had) { entries = []; index = -1; }
        return append(hash || '', null, false);
      },
      push(hash, meta) { return append(hash || '', meta, true); },
      // The current screen changed its own address (a pane, a version pick):
      // one entry, updated.
      replace(hash, meta) {
        if (index < 0) return api.push(hash, meta);
        const d = described(hash, meta);
        entries[index] = { ...entries[index], hash: hash || '', kind: d.kind || entries[index].kind, title: d.title || entries[index].title,
          ...(typeof meta?.projectScope === 'string' ? { projectScope: meta.projectScope } : {}) };
        try { history.replaceState(stamp(entries[index]), '', url(entries[index].hash)); } catch {}
        persist();
        emit();
        return entries[index];
      },
      // popstate: the browser moved. Returns where we are now and how far it
      // moved. An entry without our stamp is foreign (a link click, a typed
      // hash, an old-style entry): it joins the stack as the newest entry.
      arrive(state, hash) {
        const id = stateId(state);
        const i = id != null ? findIndex(id) : -1;
        if (i >= 0) {
          const delta = i - index;
          index = i;
          if (typeof hash === 'string' && entries[i].hash !== hash) entries[i] = { ...entries[i], hash, ...described(hash, null) };
          persist();
          emit();
          return { entry: entries[i], delta, foreign: false };
        }
        return { entry: append(hash || '', null, false), delta: 1, foreign: true };
      },
      remember(id, scroll) {
        const i = findIndex(id);
        if (i < 0) return false;
        entries[i] = { ...entries[i], scroll: scroll || null };
        persist();
        return true;
      },
      rememberScope(id, projectScope) {
        const i = findIndex(id);
        if (i < 0 || typeof projectScope !== 'string') return false;
        entries[i] = { ...entries[i], projectScope };
        persist(); return true;
      },
      // Titles can be learned late (a conversation loads, an epic is
      // renamed): refresh them from the describer without moving anything.
      refresh() {
        if (!describe) return;
        let changed = false;
        entries = entries.map(e => {
          const d = described(e.hash, null);
          if (d.title && d.title !== e.title) { changed = true; return { ...e, title: d.title, kind: d.kind || e.kind }; }
          return e;
        });
        if (changed) { persist(); emit(); }
      },
      current() { return index >= 0 ? entries[index] : null; },
      index() { return index; },
      entries() { return entries.slice(); },
      length() { return entries.length; },
      canBack() { return index > 0; },
      canForward() { return index >= 0 && index < entries.length - 1; },
      // Nearest first: what one press of ‹ or › would show.
      behind(n = 15) { return entries.slice(Math.max(0, index - n), index).reverse(); },
      ahead(n = 15) { return entries.slice(index + 1, index + 1 + n); },
      back() { return api.go(-1); },
      forward() { return api.go(1); },
      go(delta) {
        const target = index + delta;
        if (!delta || target < 0 || target >= entries.length) return false;
        history.go(delta);
        return true;
      },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    return api;
  }

  // Keep a scroller at `top` while its content settles (fonts, late fetches,
  // images), the way browsers retry scroll restoration. Any user input ends
  // it: the person's scroll wins over the remembered one.
  function holdScroll(scroller, top, { duration = 1200, ResizeObserver: RO = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
    if (!scroller || typeof top !== 'number' || !(top >= 0)) return () => {};
    const apply = () => { scroller.scrollTop = top; };
    apply();
    let observer = null, timer = null, stopped = false;
    const events = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const stop = () => { stopped = true; observer?.disconnect(); observer = null; if (timer) ct(timer); timer = null; events?.abort(); };
    if (RO && scroller.children) {
      observer = new RO(() => {
        if (stopped) return;
        if (!scroller.isConnected) return stop();
        if (Math.abs(scroller.scrollTop - top) > 1) apply();
      });
      observer.observe(scroller);
      for (const child of scroller.children) observer.observe(child);
    }
    if (events && scroller.addEventListener) {
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroller.addEventListener(event, stop, { passive: true, signal: events.signal });
    }
    timer = st(stop, duration);
    return stop;
  }

  // The ‹ › controls: any number of button pairs (top bar, side column),
  // kept in step with the stack. Click moves one step; right-click or a long
  // press lists the screens in that direction, like a browser's back menu.
  function mount(stack, { document: doc = typeof document !== 'undefined' ? document : null, back = [], forward = [], label = e => e.title || e.hash || 'home', glyph = () => '', longPress = 450, onSelect = null } = {}) {
    if (!doc) return { update() {}, close() {} };
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; } };
    const go = delta => { close(); if (onSelect) onSelect(delta); else stack.go(delta); };
    const tooltip = (dir, entry) => {
      const word = dir < 0 ? 'Back' : 'Forward';
      if (!entry) return dir < 0 ? 'Nothing to go back to' : 'Nothing ahead';
      return `${word} to ${label(entry)} (alt+${dir < 0 ? '←' : '→'}) — hold or right-click for the list`;
    };
    const update = () => {
      close(); // the stack moved: a list of the old neighbours would lie
      const prev = stack.behind(1)[0] || null, next = stack.ahead(1)[0] || null;
      for (const el of back) { el.disabled = !prev; el.title = tooltip(-1, prev); el.setAttribute('aria-label', el.title); }
      for (const el of forward) { el.disabled = !next; el.title = tooltip(1, next); el.setAttribute('aria-label', el.title); }
    };
    const open = (anchor, dir) => {
      close();
      const list = dir < 0 ? stack.behind(15) : stack.ahead(15);
      if (!list.length) return;
      menu = doc.createElement('div');
      menu.className = 'file-action-menu nav-menu';
      menu.setAttribute('role', 'menu');
      const head = doc.createElement('div');
      head.className = 'file-action-head';
      head.textContent = dir < 0 ? 'Back to' : 'Forward to';
      menu.appendChild(head);
      list.forEach((entry, i) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        const g = glyph(entry);
        b.textContent = (g ? g + ' ' : '') + label(entry);
        b.title = label(entry);
        b.onclick = () => go(dir < 0 ? -(i + 1) : i + 1);
        menu.appendChild(b);
      });
      doc.body.appendChild(menu);
      const r = anchor.getBoundingClientRect();
      const width = menu.offsetWidth || 240, height = menu.offsetHeight || 200;
      const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      menu.style.left = Math.max(4, Math.min(r.left, vw - width - 4)) + 'px';
      menu.style.top = (r.bottom + 4 + height > vh ? Math.max(4, r.top - height - 4) : r.bottom + 4) + 'px';
      menu.querySelector('button')?.focus({ preventScroll: true });
      const away = e => { if (menu && !menu.contains(e.target) && e.target !== anchor) { close(); doc.removeEventListener('pointerdown', away, true); } };
      doc.addEventListener('pointerdown', away, true);
      menu.addEventListener('keydown', e => {
        const items = [...menu.querySelectorAll('button')];
        const at = items.indexOf(doc.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
      });
    };
    const wire = (el, dir) => {
      let timer = null, held = false;
      el.addEventListener('click', e => { if (held) { held = false; e.preventDefault(); return; } go(dir); });
      el.addEventListener('contextmenu', e => { e.preventDefault(); open(el, dir); });
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        held = false;
        timer = setTimeout(() => { held = true; open(el, dir); }, longPress);
      });
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      el.addEventListener('pointerup', cancel);
      el.addEventListener('pointerleave', cancel);
      el.addEventListener('pointercancel', cancel);
      el.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || (e.key === 'Enter' && e.shiftKey)) { e.preventDefault(); open(el, dir); } });
    };
    for (const el of back) wire(el, -1);
    for (const el of forward) wire(el, 1);
    const off = stack.onChange(update);
    update();
    return { update, close, destroy() { off(); close(); } };
  }

  return { createStack, holdScroll, mount, STORAGE_KEY, LIMIT };
});
