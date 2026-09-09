/* Inline file completion: the text field remains the editor. */
(() => {
  let closeCurrent = () => {};
  window.installFileCompletion = (ta, key) => {
    closeCurrent();
    const listeners = new AbortController();
    const listen = (name, fn, capture = false) => ta.addEventListener(name, fn, { capture, signal: listeners.signal });
    const pop = document.createElement('div');
    pop.className = 'file-completion'; pop.hidden = true;
    pop.setAttribute('role', 'listbox'); pop.id = 'fileCompletion';
    document.body.append(pop);
    let controller, timer, items = [], selected = 0, snapshot, disposed = false;
    const close = () => {
      clearTimeout(timer); controller?.abort(); controller = null;
      pop.hidden = true; items = []; snapshot = null;
      ta.removeAttribute('aria-activedescendant'); ta.setAttribute('aria-expanded', 'false');
    };
    closeCurrent = () => { disposed = true; listeners.abort(); close(); pop.remove(); };
    ta.setAttribute('aria-autocomplete', 'list'); ta.setAttribute('aria-controls', pop.id);
    const token = () => {
      if (ta.selectionStart !== ta.selectionEnd) return null;
      const before = ta.value.slice(0, ta.selectionStart);
      const match = before.match(/(?:^|\s)(@(?:"[^"\n]*|[^\s"@]*))$/);
      return match ? { start: before.length - match[1].length, end: before.length, query: match[1].slice(1) } : null;
    };
    const position = () => {
      const rect = ta.getBoundingClientRect(), style = getComputedStyle(ta);
      const mirror = document.createElement('div');
      for (const name of ['font', 'letterSpacing', 'lineHeight', 'padding', 'border', 'boxSizing', 'tabSize']) mirror.style[name] = style[name];
      Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', width: rect.width + 'px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
      mirror.textContent = ta.value.slice(0, ta.selectionStart);
      const caret = document.createElement('span'); caret.textContent = '\u200b'; mirror.append(caret); document.body.append(mirror);
      const x = rect.left + caret.offsetLeft - ta.scrollLeft;
      const y = Math.max(rect.top, Math.min(rect.bottom, rect.top + caret.offsetTop - ta.scrollTop));
      mirror.remove();
      pop.style.left = Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8)) + 'px';
      const height = pop.offsetHeight, line = parseFloat(style.lineHeight) || 22;
      pop.style.top = Math.max(8, y + line + height < innerHeight - 8 ? y + line : y - height) + 'px';
    };
    const pick = i => {
      if (!snapshot || ta.value !== snapshot.text || ta.selectionStart !== snapshot.end || !items[i]) return close();
      const item = items[i], start = snapshot.start, end = snapshot.end;
      const quoted = item.value.startsWith('@"');
      const replaceEnd = quoted && ta.value[end] === '"' ? end + 1 : end;
      const suffix = item.directory ? '' : ' ';
      close(); ta.focus(); ta.setRangeText(item.value + suffix, start, replaceEnd, 'end');
      // Keep the caret inside quotes while descending into a directory.
      if (item.directory && quoted) ta.setSelectionRange(start + item.value.length - 1, start + item.value.length - 1);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const paint = message => {
      pop.replaceChildren();
      if (message) { const row = document.createElement('div'); row.textContent = message; row.className = 'file-completion-status'; pop.append(row); }
      items.forEach((item, i) => {
        const row = document.createElement('div'); row.id = 'fileCompletion-' + i;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === selected));
        const name = document.createElement('b'); name.textContent = item.label;
        const detail = document.createElement('small'); detail.textContent = item.description;
        row.append(name, detail); row.onpointerdown = e => { e.preventDefault(); pick(i); }; pop.append(row);
      });
      pop.hidden = false; ta.setAttribute('aria-expanded', 'true');
      if (items.length) ta.setAttribute('aria-activedescendant', 'fileCompletion-' + selected);
      position(); pop.children[selected]?.scrollIntoView({ block: 'nearest' });
    };
    const update = () => {
      close(); if (disposed || !ta.isConnected) return;
      const t = token(); if (!t) return;
      snapshot = { ...t, text: ta.value }; paint('Searching files…');
      const expected = snapshot;
      timer = setTimeout(async () => {
        const ctl = controller = new AbortController();
        try {
          const response = await fetch('/api/files/complete?id=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(t.query), { signal: ctl.signal });
          if (!response.ok) throw new Error('File search unavailable');
          const result = await response.json();
          if (snapshot !== expected || disposed || !ta.isConnected) return;
          items = result.items || []; selected = 0; paint(items.length ? '' : 'No matching files · Esc to dismiss');
        } catch (e) { if (e.name !== 'AbortError' && snapshot === expected) paint('File search unavailable · Esc to dismiss'); }
      }, 100);
    };
    listen('input', e => { if (!e.isComposing) update(); });
    listen('compositionstart', close);
    listen('compositionend', update);
    listen('click', update);
    listen('blur', close);
    listen('scroll', close);
    listen('keydown', e => {
      if (pop.hidden || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Escape') close();
        else if (e.key === 'Enter' || e.key === 'Tab') { if (items.length) pick(selected); }
        else if (items.length) { selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) close();
    }, true);
  };
})();
