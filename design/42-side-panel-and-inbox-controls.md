# 42 — Side panel layout, pinned conversations, unread and dismiss controls

## The moment this serves

Some people keep the agent inbox open all day and glance at it, the way a
mail client or a chat app keeps its list on the left. The top bar with its
drop-down tray serves a different habit: chrome out of the way, the tray
opened on demand with `a`. Both habits are legitimate; the app should not
pick one for everyone. The second half of this note is the inbox itself
gaining the three controls every inbox has: pin, mark unread, remove.

## Model

- **One layout choice per device.** `chattering.layout` in `localStorage`:
  `top` (default, unchanged) or `side`. It is a device preference, like the
  theme, not a server setting: the same person wants the panel on a wide
  screen and the top bar on a phone. It is set from settings → appearance
  and applied before the first paint (no flash). Below 701 px the side
  layout falls back to the top layout: a permanent 280 px column has no
  room on a phone.
- **Side layout = the tray becomes a column.** The very same `#agentsPop`
  element moves into `<aside id="side">` and stays open; no second
  renderer, no second state. The top bar's global controls (home, new,
  agents, machine, settings, fold) move to the column. What stays above the
  content is the *page* strip — project › title, move, Conversation/Files —
  and only in a conversation. Everywhere else there is no top bar at all.
- **Column order, top to bottom:** home · `+ new` (starts where you are:
  a sibling in the open conversation's project, else a loose one; `▾`
  offers the other) · pinned · unread replies · read replies · recent
  (conversations a person last wrote in, `lastUserTs` in the index) ·
  with its files under a small `files` label) · free space · **dock**:
  folded sections, traffic (every process, no sub-headers), notifications ·
  machine, settings, fold. A section folded by click leaves the flow and
  docks at the bottom as one line with its count, so the top of the column
  only ever holds open lists; the fold is remembered per device
  (`chattering.agentSections.v1`). *Recent* has one `project | all` toggle for
  its conversations and files together (the open conversation's, page's or
  file's project); in project scope its rows are one line, since the
  project is known.
- **Row shape:** the title takes the whole first line; the project name
  (not the path) and a short age (`40s`, `12m`, `3h`, `2d`) share the
  second; one-line rows put the age at the end of the title line. No icon
  columns: unread is a filled accent dot after the title, working a hollow
  pulsing one. Actions (`⋯`, stop) overlay the row on hover. The tray
  (top-bar layout) uses the same rows and sections, minus files, and does
  not dock.
- **Quiet by default, square on paper.** Sections are separated by space,
  not lines; heads are small faint labels with a chevron only on hover or
  when folded. Four tokens shape the panel and the tray, so a theme can
  flatten them: `--panel-bg`, `--panel-r` (tray corners), `--panel-row-r`
  (row highlights), `--panel-border` (column edge; transparent by
  default). The e-ink theme sets the radii to 0 and the border to black;
  binary mode keeps solid borders on the scope toggle.
- **Recent files** are the files a person opened or saved in the editor,
  newest first, shared across devices (`~/notes/chattering/recent-files.json`,
  `/api/recent-files`, SSE `recent-files`). This remains the default human
  view; [design/47](47-recent-file-activity.md) adds an independent source
  filter for agents or both, without displacing the human visit history.
- **Pinned, marked unread, removed** live in the shared inbox state
  (`agent-read.json`, logic in `agentread.js`), so every device agrees:
  - `pinned[key] = at` — a section of its own above the inbox. A pinned row
    shows its live state (unread dot, working). Pinned keys leave the unread
    and read sections (one row per conversation in the inbox); the process
    sections below still list a pinned conversation while it works, because
    those rows carry the pid and the stop button.
  - `flagged[key] = at` — marked unread by hand. It counts as unread while
    the flag is newer than the last read, whatever the transcript's age
    (the `since` guard does not apply: the person asked for it). Opening the
    conversation clears it, as any read does.
  - `dismissed[key] = at` — removed from the inbox. Hidden from the unread
    and read sections while its activity is not newer than the dismissal; a
    later reply brings it back as unread. Dismissing also reads.
- **Server clock wins**, as for reads. Marks are explicit clicks, so they go
  to the server at once (no coalescing) with an optimistic local update; the
  server's answer replaces the local copy.
- **Keyboard.** `a` still means "the inbox": in side layout it moves the
  cursor into the column instead of opening a tray; Escape hands focus back.
  With a row under the cursor: `p` pin/unpin, `u` unread/read,
  `Delete` remove. `` ` `` folds the column to a rail, as it folds the bar.
- **Row actions** are one `⋯` button per conversation row (and right-click):
  pin/unpin, mark unread/read, remove from inbox, open. Same menu style as
  file paths.

## Non-goals

- A drawer variant of the column on phones. The phone keeps the tray.
- Moving the conversation title into the column. The title belongs to the
  page; the column is navigation.
- Per-project or per-device pins. Pins are per person, shared.

## Second pass (2026-09-19): no bar at all

Asked after the first round, in this order:

1. The top bar goes away in every view of the side layout, the
   conversation included.
2. The column's first line is `⌂ home` on the left and `project ↗` (the
   project area) on the right.
3. The conversation title floats over the top of the page — no bar, a
   translucent label — and hides on scroll down, returns on scroll up.
   Renaming by click stays; the move-to-project arrow stays beside it.
4. The Conversation / Files switch leaves that view (`F` still works).
5. The composer is pinned to the bottom and never moves while reading.
6. The user message box loses its extra bottom padding and its minimum
   height, so a one-line message is one line tall.

All six landed the same day. Notes on how:

- `#floatHead` is an absolutely positioned label inside `main`; `#chTitle`,
  `#chMove` and `#convHeadExtra` move into it when the layout is applied and
  back into the bar when it is not. The hide-on-scroll reuses the phone's
  `chrome-min` mechanism (accumulated scroll distance per direction).
- The composer is `position: fixed` from the column's right edge; the
  transcript's bottom padding follows the composer's measured height
  (`--compose-h`), as on the phone.
- The message action row was 22 px + 8 px of reserved space under every
  message even while invisible, and `.md p` margins stacked with the box
  padding. The row now draws inside the bottom padding on hover and the
  first/last blocks drop their outer margins. This applies in both layouts.
