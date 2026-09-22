# 58 — Phone shell

Supersedes the header and tab rules of design/23 for phones. Desktop and
e-ink keep their layouts; the shell is on only when the phone media query
matches, the side column is off, and the theme is not binary.

## Why

The desktop moved its destinations into a side column (design/51). A phone
has no column, so those destinations fell back into a 52px top row of nine
controls (new, Gantt, ‹, +, title, agents, machine, you) that squeezed the
conversation title to three letters. Agents opened as a floating tray under
that row, with the whole Read history in one scroll, so a running agent was
hundreds of rows down. There was no way to reach recent files at all.

## The bar

One bottom bar, 54px plus the safe-area inset, five tabs: **Agents**,
**Gantt**, **New**, **Files**, **You**.

- Agents and Files open **sheets**: full screen above the bar. The bar stays
  while a sheet is open, so the way out is always on screen. A tab taps its
  sheet closed again; opening one closes the other. Leaving for a page (a
  row, a project link, a file, Back) closes the sheet; Settings is a modal
  over the page and keeps it.
- Gantt is home. New is design/51's "new here": a sibling in the current
  project, otherwise a loose conversation.
- You is `#settingsBtn` itself, moved into the bar. The desktop column and
  the top bar keep their own placement of the same element.
- The Agents tab carries the unread count (and `!` for interruptions) and
  turns live while something works. The counts come from `updateActiveBtn`.

Reading and typing own the screen: `chrome-min` (scroll down, or focus in
the composer) hides the bar with the top bar and drops the composer to the
bottom edge; scrolling up brings both back. A sheet never hides.

## The sheets

The Agents sheet is the desktop **inbox**, not the old tray: Interrupted,
Unread, then Read (paged, All/Project) in one scroll, with **Working** docked
underneath at up to 42% of the height with its own scroll. `renderAgentsPop`
treats the shell as `panel === 'inbox'`; nothing is rendered twice.

The Files sheet is the desktop right column (`#rightFiles`): All/Project,
the human/agents/both filter, paging, forgetting, and opening a file. The
mode is remembered per browser as before; the open state is not — a sheet
starts closed on every load.

## The head

In a conversation the top row is: ‹, the title on up to two lines, and one
**⋯** with the rest in the desktop's words: New here, Open project, Rename,
Who can see this, Move to another project, Conversation tree, Browse
project files, Switch machine. Items appear only when they apply. Other
pages keep ‹ alone; the bar carries the rest.

## The Android back button

`window.chatteringBack()` is asked first by the app. Anything transient closes:
a menu, a picker, a sheet, an on-the-fly dialog, then the fixed overlays,
search, settings, the mark preview. It returns `true` when it handled the
press; `false` means the app should move through the page history, and with
nothing left there, leave.

## Streaming that stopped

`EventSource` reconnects only when it notices an error. A phone that slept,
or a network that changed under it, can keep a socket open that never
delivers. The server now sends a named `ping` event every 25 s; the page
counts a stream stale after 70 s without one while visible, and on wake,
`online`, or a bfcache restore checks at once and replaces the stream.
`live.onopen` already reloads the list and reconciles the open transcript
on every reconnect.

## Verification

`test/phone-shell.test.js`: desktop shows nothing of the shell; the bar
sits on the bottom edge with finger-sized tabs; Agents opens as the inbox
with Working on screen; a row opens its conversation and closes the sheet;
the head holds the title and ⋯; scrolling and typing hide the bar; Files
lists and opens a recent file; one sheet at a time; the back hook; Gantt,
New and a project link; the column returns on a desk.
