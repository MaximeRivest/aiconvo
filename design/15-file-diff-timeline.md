# 15 — File diff timeline

## Purpose

Answer three questions without opening every conversation:

1. Which files did agents touch?
2. When did the same file receive repeated changes?
3. What exactly changed in one edit?

This is a **file-level memory and review view**. It complements the existing
conversation timeline. It must not become a full Git client.

## Placement

Add one artifact view, not a fifth main tab:

- Conversation artifact switcher gains `diffs` after `evidence`.
- Project overview gains a `file diffs` action.
- The Gantt remains the main browser. File changes open as a focused right
  pane view when possible.
- Deep links:
  - conversation: `#diffs=<conversation-key>`
  - project: `#project=<name>&diffs`
  - file: `#diffs-file=<encoded-path>` when useful.

This follows the current model: the left Gantt provides time context, the
right view shows the focused artifact.

## Core visual model

Use a **file × time swimlane Gantt**.

- One row per file, sorted by most recent touch.
- Time runs left-to-right, same as the bottom Gantt.
- A mark is one edit/write event, not a conversation span.
- Mark width comes from the edit size estimate; minimum width stays readable.
- Mark color comes from the project, as in the conversation Gantt.
- Repeated edits on one file create a visible train of marks.
- A file row can split into tracks only when marks overlap visually.
- Use the same zoom, wheel, keyboard, and now-jump controls as the Gantt.

Do not show conversation violin shapes here. That shape means message density.
For diffs, use small diamonds/squares and optional short bars for ranges.

## Diff event model

Normalize Claude and pi into one event:

```json
{
  "key": "conversation key",
  "source": "claude | pi | pi-remote",
  "project": "aiconvo",
  "path": "/absolute/or/repo/relative/path",
  "relativePath": "server.js",
  "ts": "2026-08-13T18:00:00Z",
  "kind": "edit | write | multi-edit | patch",
  "conversationTitle": "Add provenance paths",
  "agent": "claude | pi",
  "oldText": "...",
  "newText": "...",
  "editIndex": 0,
  "stats": { "oldChars": 820, "newChars": 910, "oldLines": 18, "newLines": 21 },
  "preview": "first changed line / file name / tool summary"
}
```

### Extraction rules

Claude Code:

- `Edit` → one event with `old_string` / `new_string`.
- `MultiEdit` → one event per `edits[]`, same timestamp and path.
- `Write` → one event with `content`, `oldText = null`.

pi:

- `edit` → one event with `oldText` / `newText`.
- `edits[]` → one event per item.
- `write` → one event with `content`, `oldText = null`.

Ignore:

- Reads and views.
- Shell commands that only redirect output. They are useful later, but the
  first version must stay trustworthy and quiet.
- Tool results as diff evidence. The result may contain command output, not the
  intended change.

## Sizes and labels

The mark communicates three things without opening it:

- **size** — from old/new line counts.
- **type** — glyph: `~` edit, `+` write, `±` multi-edit.
- **risk** — not computed in v1. Do not guess semantic risk from size.

The row label shows:

```text
server.js        84 edits · latest 2h · +610 / -590
```

Show basename first. Show directory on hover and in the selected card.
Collisions use the shortest unique suffix, such as `server.js` vs
`docs/server.js`.

## Interaction

### Click

- Click a diff mark: open the focused diff card.
- Click a file label: select the file and show its aggregate card.
- Click the conversation title inside the card: open that conversation at the
  relevant message.

### Diff card

The card opens in the right pane, not as a modal:

```text
~ server.js · aiconvo · 13 Aug 18:02
Add provenance paths · claude · conversation ▸

- 18 lines   + 21 lines
[compact | full] [copy diff] [open conversation]

--- old
+++ new
@@ function provenanceMarkdown(s)
...
```

### View modes

- **compact** — changed lines plus a little context. Default.
- **full** — complete old/new blocks side by side or stacked, depending on
  width. Do not force a two-column layout on narrow screens.

There is no syntax highlighting requirement in v1. Monospace plain text is
better than wrong highlighting.

## Project file Gantt

The project view gets a dedicated screen:

```text
❯ aiconvo · file diffs
/home/maxime/Projects/aiconvo · 84 touched files · 912 edits · latest 2m
[all files | edited only | written only] [search file] [copy selected]

[file rows over time]
```

Rules:

- Default to **edited only**. Written files can be noisy.
- Sort rows by most recent touch.
- Show at most 80 file rows initially; search reveals hidden rows.
- Render marks only in the visible time window, as with the conversation
  Gantt.
- Use existing project filter state when the project view opened from one.

## Conversation diff view

The conversation `diffs` artifact shows the same extraction scoped to one
conversation:

- Summary line: `N files · M edits · +A / -B`.
- File cards collapsed by default.
- A small horizontal timeline above the cards when there are more than five
  edits.
- Each card links back to the conversation message.

This is the audit view for "what did the model change here?".

## Overwhelm controls

The design must keep the default surface small:

1. Files, not hunks, are the top-level rows.
2. One event per file edit, not one row per line changed.
3. Cards stay collapsed except the selected or newest one.
4. Search by path filters rows and cards.
5. Full diffs open only on demand.
6. Tool results and shell output stay out of v1.
7. Row count is capped and explicitly reported: `showing 80 of 412 files`.

## Git truth boundary

Do not imply these are Git diffs. They are **agent-intended changes** extracted
from tool calls. A tool call can fail, and a file can change again outside the
conversation.

Label the view:

```text
agent file touches — extracted from edit/write tool calls
```

When the file still exists, add an optional action:

- `current file` — open/read the current file separately.
- `compare with git` — later extension, not v1.

## Keyboard

| Key | Scope | Action |
| --- | --- | --- |
| `g` | file timeline | keep existing Gantt layout cycle |
| `+` / `-` / `0` | file timeline | existing zoom controls |
| `n` / `b` / `t` | file timeline | now / oldest / date jump |
| `enter` | focused mark or file | open diff card |
| `space` | focused mark | select it for comparison/export |
| `c` | diff card | copy unified diff |
| `o` | diff card | open conversation |
| `esc` | diff view | back to previous artifact |

## Empty and edge states

- No edit/write calls: show "no file edits in this scope" and keep the normal
  transcript accessible.
- Missing timestamps: put events at the conversation end and label them
  `time unknown`.
- Same file edited many times in seconds: cluster marks; click shows a small
  burst list before opening one diff.
- Very large old/new content: cap card preview, but never destroy source data.
  Export/copy uses the full stored extraction.
- Deleted file: mark the row with `✕ deleted now` only if current filesystem
  lookup is cheap. Do not infer deletion from edit history alone.

## Performance

- Extract events lazily per conversation, then cache them by conversation
  content hash.
- Reuse existing cache invalidation when a conversation grows.
- Project responses should return row summaries first and full old/new text
  only for selected diff events.
- Render visible rows and visible time windows only.

## API shape

```text
GET /api/conversation/diffs?id=<key>
GET /api/project/diffs?name=<project>&include=rows
GET /api/project/diff-event?id=<event-hash>
```

Rows response should be small and renderable:

```json
{
  "project": "aiconvo",
  "files": [{
    "path": "/home/maxime/Projects/aiconvo/server.js",
    "relativePath": "server.js",
    "count": 84,
    "latestTs": "2026-08-13T18:02:00Z",
    "events": [{ "id": "...", "ts": "...", "kind": "edit", "stats": {"oldLines":18,"newLines":21} }]
  }]
}
```

Full event response contains `oldText`, `newText`, and provenance. Keep this
separate so project timelines stay fast.
