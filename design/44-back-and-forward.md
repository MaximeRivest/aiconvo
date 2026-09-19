# 44 — Back and forward through the screens

## The moment this serves

You read a conversation, open the file it changed, look at the project's
overview, follow a link to an epic, and want to be *back where you were* —
the same conversation, the same place in it — then forward again. A browser
gives its users this for free: two arrows, a hover that names the page, a
long press that lists the last few, the scroll position kept. aiconvo runs
where there is no browser chrome at all: the standalone PWA on the tablet
and the phone, the Android app, the e-ink reader. This note gives the app
its own back and forward, as good as the browser's in its best case.

## What already existed (design/22)

One router owns every screen change: `setRoute(kind, hash)` writes the
screen's address after the `#`, `dispatchHash()` rebuilds any screen from
its address. That is why a reload works and why the browser's Back already
worked in a tab. What was missing:

- the app did not know its own history — `history.state` was never used,
  so it could not say whether Back stays in the app, whether Forward
  exists, or where either goes;
- four screens changed without changing the address (launch progress,
  distillation progress, the two evidence views), so Back skipped them or
  skipped past them;
- only the transcript remembered its scroll; every other screen came back
  at the top;
- five places wrote `history.replaceState(null, …)`, which would erase any
  per-entry state.

## Model

- **One stack per tab, mirroring the browser's history**
  (`navigation.js`, `Navigation.createStack`). Every screen is an entry
  `{ id, hash, kind, title, at, scroll }`. The entry's `id` is stamped into
  the browser's history entry through `history.state = { nav: { id } }`,
  so on `popstate` the app knows *which* entry it arrived at and how far it
  moved. The stack is persisted in `sessionStorage` (the lifetime of a tab,
  like the browser's own history) and capped at 200 entries.
- **Push, replace, arrive.** `setRoute()` pushes when the address changes
  (and drops the forward path, as browsers do); `replaceRoute()` updates
  the current entry when a screen changes its own address — a settings
  pane, a files-browser mode, a file version, the reading position saved
  before browsing another path. `popstate` calls `arrive(state)`: a stamped
  entry is found in the stack; an unstamped one (a link click, a typed
  hash, an entry made before this design) is *foreign* and joins as the
  newest entry, stamped for next time. There is one `popstate` listener
  and no `hashchange` listener any more; the old suppress-counter is gone.
- **One entry per screen, not per state change.** Switching a settings
  pane or a file version does not make an entry; browsing another reading
  path inside a conversation does (it is a different page of the same
  book). This differs from a browser, which pushes on every URL change; it
  is the difference between "where was I" and "what did I click".
- **Transient screens are not places.** `launch` and `distill` are progress
  screens; they never enter the stack. Nothing should go back to
  "launching…".
- **Every place has an address.** Evidence views gained
  `evidence=KEY` and `epicevidence=ID[&focus=KEY]`; the saved-note pane
  reuses `note=…`.
- **Scroll comes back.** Before a screen is left (`setRouteKind`, and the
  `popstate` handler) its `#view` scroll is saved on its entry. After a
  traversal renders, `Navigation.holdScroll` puts it back and keeps it
  there while late content settles (a `ResizeObserver`, up to 1.2 s), the
  way browsers retry scroll restoration; any wheel, touch, or key ends the
  hold. The transcript keeps its own anchor-based memory (design/34): a
  live transcript grows, and an anchor survives that where a pixel offset
  does not. Home is a chart with its own position logic.
  `history.scrollRestoration = 'manual'` keeps the browser from fighting.
- **Labels are derived, not stored.** `describeRoute(hash)` turns an
  address into `{ kind, title }` from the session index, so a title learned
  after the visit (a conversation renamed, an epic titled) shows the next
  time the list opens. The entry keeps a copy only as a fallback.

## Controls

- `‹ ›` in the top bar (next to ⌂) and in the side column's first line
  (before ⌂ home). Both pairs follow the same stack. A disabled arrow stays
  visible so the pair never jumps. Hover names the destination: *Back to
  Chat flow*.
- Right-click, a long press (450 ms), `↓` on a focused arrow, or shift+enter
  opens the list of screens in that direction, nearest first, with a glyph
  for the kind; a pick moves that many steps in one go.
- `alt+←` / `alt+→` are the keys, handled by the app so the PWA window, the
  Android app and the e-ink reader behave like a browser. Not while typing:
  on a Mac, option+arrow moves the caret by a word.
- Android's hardware key keeps calling `WebView.goBack()`; the stack sees
  it as a normal `popstate`.
- Phone bar: back keeps its place, forward appears only when it exists.
  To fit the 360 px row the Conversation/Files switch is hidden on phones
  (the `F` key still toggles it — the same call design/42 made for the side
  layout).

## Fast?

A push is a `pushState` and one `sessionStorage` write: under a
millisecond. A traversal costs what clicking the item costs: the screen is
rebuilt from its address, from caches when they exist (`readerSessions`,
`filesBrowserPlaces`), 50–300 ms for a large transcript. It is not
browser-instant: browsers keep the old page's DOM alive (bfcache); this
design does not.

## Trade-offs, stated

- **No DOM snapshots.** Keeping the last few screens' DOM for an instant
  swap was rejected for now: screens are wired to globals (`current`,
  `fileWs`, `docState`), a live transcript goes stale, and the memory cost
  on the e-ink reader is real. Reversible later if re-render speed bothers.
- **Per-screen entries, not per-state.** See above; a deliberate choice.
- **Transcript scroll is per conversation, not per entry.** Visiting the
  same conversation twice at two places returns to the last-remembered one.
  The anchor mechanism is worth more than per-entry fidelity on a page
  that grows while you are away.
- **Foreign entries lose direction.** A hash typed into the address bar of
  the same tab becomes a fresh entry; the app cannot know whether it was a
  back or a forward. Rare and harmless.
- **Reopening the current screen adds nothing.** Browsers would add an
  entry; here it is a no-op, as before.
- **The stack dies with the tab** and is not shared across devices —
  syncing it would surprise more than help.

## Tests

- `test/navigation.test.js`: the stack against a fake browser history —
  push, truncate, replace, traversal distance, foreign entries, reload
  adoption, the cap, scroll memory, late titles, broken storage,
  `holdScroll`.
- `test/navigation-app.test.js`: the real server and a headless Chromium —
  the two button pairs, tooltips, alt+arrows, the browser's own Back, the
  long-press lists, scroll return on a plain page, a reload keeping both
  directions, a foreign hash, and a settings pane replacing its entry.
  On lambda the `chromium` on PATH is the shared agent browser; set
  `CHROMIUM=/path/to/plain/chromium` to run it.
