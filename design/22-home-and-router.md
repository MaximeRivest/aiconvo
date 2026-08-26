# Home and the router

## Model

- **Home is the whole-system view.** It fills the work area with the timeline
  tray: tabs, Gantt toolbar, timeline, list, and selection bar. There is no
  permanent side rail anywhere else.
- Every click **lowers one level**. Every view below home fills the work area
  and carries a **breadcrumb spine** under the top bar.

## Levels

```
home (system timeline: conversations · notes · epics · repos lenses)
 ├─ project ── info mode  ⇄  ☷ file tree mode
 │    ├─ file gantt ── focused file
 │    ├─ diffs list ── blame
 │    └─ tree file ── focused file (git scope)
 ├─ conversation ── tree · note · evidence · diffs ── focused file
 ├─ repo (git history) ── focused file (git scope)
 ├─ epic ── epic evidence
 ├─ note file
 └─ settings
```

## Router rules

- One global `viewKind` plus one hash route per view. `setRoute` is the only
  way to change them. `dispatchHash` is the only reader.
- The browser back button, refresh, and deep links work for every view.
- **The app never navigates by itself.** SSE updates, job completions, and
  timers only patch data in place, show a quiet toast, or a badge.
  - The live tail refreshes the transcript only when `viewKind` is
    `conversation`, the same conversation, and the user is at the bottom.
  - A live-tail re-render keeps composer text, caret, and focus.
- The brand button = go home. Shift-click also clears all filters.

## Breadcrumb spine

- `❯ home ▸ project ▸ conversation ▸ artifact ▸ file`. Every segment is a
  link. The last segment is plain text, except the conversation segment:
  clicking it opens a **sibling quick-switch** list (same project, newest
  first). No permanent rail is needed to move between conversations.

## Home marks

- Violin = conversation (click opens it). Green square = note (click reads
  it). Triangle = epic (click opens it). `⌂ branch` on a project row label =
  Git history for that project's repository.

## Project tree mode

- The project overview toggles into `☷ file tree`: all repositories under the
  project, each with branches, worktrees, and every tracked / modified /
  untracked path; gitignored entries appear dimmed and inert. A file click
  lowers to the whole-file view in Git scope, and the breadcrumb returns to
  the tree. `/api/project/tree?name=` serves the data with capped lists.

## Hash grammar

`''` home · `<key>` conversation · `tree=` · `diffs=` · `note=` · `epic=` ·
`project=` · `project=…&files` · `project=…&diffs` · `project=…&tree` ·
`git` (repos lens) · `git=<root>` · `blame=` · `settings`.
