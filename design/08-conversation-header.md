# 08 — Conversation header: one switcher, honest actions

Status: implemented.

## Problem

The old header mixed navigation and actions across two button rows:

- `evidence` (action row) and `evidence card` (related row) did the same thing.
- `note ✓` (action row) and `note` (related row) did the same thing.
- `conversation` in the related row was a self-link.
- `distill` opened the note when one existed, started a job otherwise.
- `↻ re-distill` appeared conditionally and shifted the layout.
- The meta line wrapped to three lines.

## Model

The view pane shows **one artifact** of a session at a time: the
transcript, the note, the evidence card, or an epic. So the header has
three zones with separate jobs:

```
┌────────────────────────────────────────────────────────────┐
│ Title (one line, ellipsis)              [copy] [distill]   │  identity + actions
│ ■ pi · aiconvo · main · 13 Aug 08:38 → 12:46  view [▾] [↻] │  meta + view controls
│ [transcript|note|evidence|▸epic]                           │  artifact switcher
└────────────────────────────────────────────────────────────┘
```

### Zone 1 — identity + actions

Actions **do** something. They never navigate.

- `copy` copies the transcript as markdown.
- `distill` controls the distillation **job** only. States:
  - no note: `distill`, primary style. Starts the job.
  - job running: `distilling…`. Opens the jobs drawer.
  - note fresh: `↻`, ghost. Tooltip: "note is up to date — re-distill anyway".
  - note stale (new messages since): `↻ re-distill`, normal style.
- Opening the note is not this button's job. The `d` key keeps the
  intent-based toggle: open the note if it exists, distill otherwise.

### Zone 2 — meta + view controls

One line. Source dot + name, short directory, branch, compact dates.
Right side: the `view` mode select and the `↻ new messages` reload
button. View controls change what you see, not where you are.

### Zone 3 — artifact switcher

Segmented control. Exactly one item is `.on`.

- `transcript` — the conversation.
- `note` — only when a note exists.
- `evidence` — always; builds the card on demand.
- `▸ epic-title` — one item per related epic.

The per-epic evidence button is gone. Epic evidence is reachable from
the epic view. The same switcher appears in the note, evidence, and
epic headers, so navigation works identically everywhere.

## Rules

- A button either navigates (switcher) or acts (actions). Never both.
- No duplicate paths to the same place.
- No conditional buttons that shift the layout. State changes restyle
  the button in place.
- The title and the meta line never wrap.
