# People panel, "take me there", follow, and presence on files

*2026-09-21. Builds on design/46 (presence) and design/53 (guests).
Changes in `people.js`, `people.css`, `app.html` (header, project page,
recent files), `files-browser.js`, `live-file.js`, `filesmode.js`. Test:
`people-app` (two real browsers).*

## What was there, and what was not

Design/46 built the presence book: every live browser reports a route
(`conversation:<key>`, `file:<path>`, `project:<name>`, `draft:<id>`,
`home`, `settings`), a kind (`viewing`, `typing`, `editing`) and an
optional position (`entry`, `line`); the server broadcasts the whole
book, filtered per receiver by what they may see. Marks on conversation
rows and "Lilly is typing…" under a title were drawn from it.

Two things were missing. **Positions and kinds were never reported**: the
composer never called `peopleTyping()`, the editor never sent a line, the
reader never sent an entry — so the book only ever knew *which page*
someone was on. And there was **no way to act on it**: no list of who is
here, nothing to click to go where they are.

## Reporting: the page, and the place on the page

- A conversation reports the entry at the top of the viewport
  (`.msg[data-eid]`), on scroll, throttled to one report per 600 ms.
- A file reports the cursor line (`editor.selection().line`) on keys,
  clicks and selection changes; `editing` for six seconds after a
  keystroke, then `viewing` again.
- The composer (conversation or draft) reports `typing` on input, for six
  seconds after the last keystroke.

All three go through one throttle (`peopleSetPosition`) because presence
is a whole-book broadcast to everyone on the install: a scroll must not
become a stream. Kinds and positions are cleared on every route change.

## The people button and the panel

`#peopleBtn` in the header shows **other people only** (quiet
self-presence: my own bubble is the settings button), three bubbles and
a count, typing bubbles pulsing. Hidden when nobody else is here. Click:
the people panel — one row per person here: bubble, name (guest badge
for guests), what they are doing and where ("editing · people.js · line
212 · just now"), and two buttons: **go** and **follow**. Below, who is on
the roster but not here now.

**Go** opens what they are looking at, at their place: a conversation at
their entry (`open(key, 'entry:<id>')`, or a smooth scroll with a brief
highlight when the conversation is already open), a file at their line
(`openLiveFile(path, { line })`, or `gotoLine` when the file is already
open), a project page. Drafts, settings and the home page are not
destinations (a draft is someone's unsent text; the button is disabled
with the reason).

**Follow** keeps going: a chip in the header says "following Lilly ✕";
every presence broadcast in which her route or position changed moves
you there. Your own navigation ends it — any route change the follow did
not cause — except landing where she already is. If she leaves the
install, the chip says "waiting for Lilly" and following resumes when she
returns; clicking the chip stops it.

## Presence on files and on the project page

`renderPresenceMarks` now fills two kinds of slot: `[data-presence-key]`
on conversation rows (as before) and `[data-presence-file]` on file rows
in the files browser, in the recent-files list, and in the file editor's
header, with the line in the tooltip. The project page gets a "here now"
strip under the title: everyone whose route is inside this project (the
project page itself, a conversation filed under it, a file under its
folder), each a button that goes there.

## Trade-offs, stated

- **Whole-book broadcast, throttled**, rather than per-route
  subscriptions: a household or a small team is a few dozen rows; the
  simplicity is worth more than the bytes. A thirty-person office would
  want subscriptions.
- **Positions are coarse**: an entry, a line. Not a character offset in
  the reader, not the selection in the editor (the shared editor already
  shows selections through Yjs awareness when both are in the file).
- **Follow moves the view, never the composer or the editor's focus**,
  so the person following can keep typing where they are; it is a
  spectator mode, not remote control.
- **No keyboard shortcut** for the panel: the header is already dense
  with single-letter keys (`P` moves a conversation), and a collision is
  worse than a click.
- **Drafts are not destinations.** A draft is unsent text; opening
  someone else's is a shared-compose question (design/46), not a
  navigation one.
