# 19 — Whole-file time comparison

## Purpose

Let a user select one file in the file Gantt, read its complete content at two times, compare both states, and trace one line through recorded changes.

## Entry and focus

Click or touch a sticky file label in the project file Gantt.

The app opens a focused file workspace:

- A navigable repository file tree stays on the left.
- One Gantt for only the selected file stays above the content.
- The complete two-state file comparison fills the remaining space.
- **all files** returns to the project-wide file Gantt.

Selecting another tree file keeps both keyframe times and maps them to that file's nearest available points.

## Time points

Each file provides two draggable range markers on one file-only time track:

- AI edit/write points.
- Git commits that touched the file.
- The current working file, when it exists.

The old and new marker labels update during movement. Moving one marker past the other moves the second marker too.

Clicking a time mark or empty track space moves the nearest keyframe. Drag either diamond directly with mouse, pen, or touch. Arrow keys also move a focused diamond.

The old marker uses a hollow diamond and dashed stem. The new marker uses a filled diamond and solid stem. These shapes remain distinct in binary e-ink mode.

The comparison request starts after a short input delay. It does not rebuild the timeline during a drag.

The client aborts replaced requests and caches recent comparisons. The server caches file contexts and point snapshots. This keeps slider and file-tree movement fast.

## Snapshots and truth

- Git snapshots are exact blobs from the selected commit.
- The current snapshot is the exact file on disk.
- AI snapshots are reconstructions. Start from the latest earlier Git blob and replay recorded tool calls. If no Git blob exists, reverse-replay from the current file or replay from recorded writes.
- Show the reconstruction method and skipped divergent events.
- Never label reconstructed AI state as exact.

## Whole-file diff

Show every line. Do not collapse unchanged sections.

- Unchanged lines use one full-width column.
- Changed rows split the width in two: removals left, additions right.
- Do not print the same unchanged line twice.
- If the two keyframes have no line changes, show one file column.
- **show lines** draws row separators. **hide lines** removes them. The source text stays visible.
- Align unchanged lines and changed runs.
- Show line numbers on the occupied cells.
- Wrap long lines inside their own cell. Text must never cross into another column.
- Prefix removals with `−` and additions with `+`.
- Use removal and addition colors where available.
- In e-ink mode, removals use a dashed edge and strike-through. Additions use a double edge, bold text, and underline.
- Permit horizontal and vertical scrolling for large files.
- Apply a small built-in highlighter per line. It never reflows lines, so the old/new grid stays aligned.
- Code files mark keywords, strings, comments, numbers, and tags.
- Markdown files keep source lines and decorate headings, lists, quotes, emphasis, links, and fenced code.
- E-ink uses weight, italic, underline, and borders instead of hue.

## Line history

Click or touch any comparison row to unfold its history directly below that row.

- List matching AI and Git changes in reverse chronological order.
- Show a small old/new excerpt for each change.
- Keep the history open until another line is selected.
- Click an AI change to open its conversation at the tool-call timestamp.
- Click a Git change to open its commit patch.

Line history follows matching line text through old/new fragments. It is recorded-change provenance, not a complete semantic line identity system. Common or blank lines can have no safe attribution.

## API

```text
GET /api/project/file-history/file?name=<project>&repo=<root>&path=<relative>&from=<point>&to=<point>
```

Point IDs:

```text
current
git:<full-hash>
ai:<diff-event-id>
```

The response contains selectable points, both complete snapshots, snapshot truth metadata, and interval changes for line-history unfolding.
