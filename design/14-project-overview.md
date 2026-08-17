# 14 — Project overview: timeline label to workstream brief

Clicking a project label on the Gantt should answer three questions fast:

1. What did I do here?
2. Where is the current thread?
3. How do I start the next agent conversation with the right memory?

This is a **project-level memory view**, not another conversation list and not
a dashboard. It keeps the terminal-native rule: dense, plain, keyboard-first,
no decorative panels.

## Interaction model

The project label is a **target**, not a tooltip.

- Click a project label: open the project overview in the right `#view`.
- `Shift` + click: open the overview and keep the current transcript open in a
  picture-in-picture context when it exists.
- `Esc` or the project row's `×` action: return to the previous right-pane
  content without changing scroll or selection.
- `p`: open the overview for the focused conversation's project.
- The project filter in the Gantt toolbar is separate. It hides other
  projects. Clicking a label does not change that filter.
- Deep link form: `#project=<project-name>`. It restores the overview without
  selecting a conversation.

## Overview structure

Use one sticky project header, then four flat sections. Do not use a tab bar
inside the overview. The overview is one scannable page with jump links.

### Zone 1 — identity and actions

```text
❯ aiconvo
/home/maxime/Projects/aiconvo · 1672 conversations · 98 notes · 12 epics · active 2m ago
[refresh evidence] [start conversation ▾] [latest: WorkMemory]
```

- The project color appears as the left border and text glyph, not a fill.
- `active Nm ago` uses the newest source-file modification.
- `refresh evidence` is visible but secondary. It shows pending work in the
  Jobs drawer.
- `latest` opens the newest conversation in that project.

### Zone 2 — project map

```text
map      workstreams 4 · epics 12 · open questions 7
         ├─ Local AI work memory          2026-08-12 → 2026-08-13
         ├─ Gantt / project ergonomics    2026-08-13
         ├─ Herdr terminal integration    2026-08-13
         └─ E-ink and grayscale themes    2026-08-13
```

A **workstream** is the user-facing grouping. It can come from epics now and
from tickets later. The UI treats it as a named narrative bundle, not as a
literal filesystem object.

Show at most eight rows. Each row has one line. Do not show narrative prose
here. Open questions get a count only; details live below.

### Zone 3 — epics and tickets

Each epic/workstream gets one card. Cards are collapsed by default except the
most recent one.

```text
▾ ▸ Local AI work memory                    8 conv · evidence fresh · updated 1h
  abstract: one line
  timeline: 3 phases · current state: durable memory vault
  evidence: 5 notes · 3 cards · 2 stale
  [open] [rebuild] [select for new conversation]
```

Card controls must keep their job names:

- `open` — read the epic.
- `rebuild` — start an explicit rebuild job.
- `select for new conversation` — include this epic in the next launch.

Tickets use the same shape. A ticket can be a short manual note or an external
work item later. Do not invent a ticket editor in the first pass.

### Zone 4 — recent and fresh evidence

```text
freshness  64 current · 21 stale · 9 missing
[ refresh missing ] [ refresh stale ] [ build all evidence ]

recent conversations
● WorkMemory       2m   note ✓  evidence ✓
● Say test         8m   note —  evidence —
● HerdrFind        42m  note ✓  evidence stale
```

This section is the **memory health check**. It must answer: can I trust the
project summary as current context?

- Show a maximum of 12 recent conversations.
- Each row links to its conversation.
- The glyph and text carry the status. Do not rely on color only.
- Stale means the source changed after its note or evidence.
- Missing means no note/evidence exists.
- `refresh missing` and `refresh stale` are explicit background jobs.
- `build all evidence` is available only after an explicit confirmation when
  it could launch many paid model jobs.

## Starting a new conversation

The primary action opens one inline launcher, not a modal.

```text
new conversation in /home/maxime/Projects/aiconvo
agent     [pi ▾ | claude ▾]
name      [ optional: workstream title ]
memory    [x] project map
          [x] current epics (2 selected)
          [ ] all fresh notes
          [ ] selected evidence cards
          budget ~12k tokens   [small | medium | large]
[start]
```

### Rules

- The agent selector remembers the last choice per project.
- Memory selection defaults to the project map plus the currently open
  workstream. The user can include more.
- Show the estimated input size before launch.
- The launch creates a Herdr workspace rooted at the project directory.
- The prompt/context assembly is a server workflow concern. The UI sends only
  the chosen artifact IDs and budget. Another agent can implement the model
  workflow.
- After start, the project overview stays open and the new agent appears in
  the activity ticker and agents popover. Do not steal focus.

## Freshness policy

The UI must separate **view** from **rebuild**. A stale note or evidence card
is still readable and is labeled as stale. It is never silently replaced.

Use three freshness states:

| State | Meaning | UI |
| --- | --- | --- |
| fresh | artifact matches its source conversation state | `✓ fresh` |
| stale | source changed after the artifact was made | `⚠ stale`, rebuild available |
| missing | no artifact exists | `— missing`, build available |

The overview itself gets one freshness stamp:

```text
project map generated 2026-08-13 19:20 · based on 58 notes · 12 stale
```

If the map is stale, show it with `⚠ stale` and offer `refresh map`.
Do not hide the old map while the job runs.

## Anti-recency-bias rules

Large projects need hierarchy, not a bag of old and new fragments.

The launcher and overview must expose these three layers explicitly:

1. **Project map** — stable, small, chronological cross-project context.
2. **Epic/workstream summaries** — phase-level decisions and outcomes.
3. **Recent evidence** — current state and unresolved work.

The UI must not present “last 20 notes” as equivalent to full project memory.
The default includes the project map before recent items. Budget controls
change how much of layer 2 and layer 3 is included, never whether layer 1
exists.

## Keyboard and terminal-native behavior

| Key | Scope | Action |
| --- | --- | --- |
| `p` | anywhere | Open overview for the focused conversation's project |
| `j/k` or `↓/↑` | overview | Move between workstream cards |
| `enter` | focused card | Open the epic/ticket |
| `space` | focused card | Include/exclude it in the next conversation |
| `r` | overview | Refresh stale/missing evidence for the visible project |
| `n` | overview | Focus the new-conversation launcher |
| `esc` | overview | Return to previous content |

- Focus order goes from identity actions to the project map, then cards, then
  the launcher.
- Every action has text, not only a glyph.
- Motion follows the existing themes. E-ink mode uses inverse rows and plain
  borders; no color-only status.

## Empty and edge states

- No notes or epics: show recent conversations and one primary `build
  evidence` action.
- No project directory on disk: show the historical project name, mark the
  directory as missing, and disable `start conversation`.
- Very large project: load the header and freshness summary first, then load
  cards. Keep the page readable.
- Refresh already running: disable the button, show `refresh running…`, and
  link to the Jobs drawer.
- Map generation fails: keep the last good map visible, show the error inline,
  and do not block conversation start with selected raw artifacts.

## Implementation-facing API shape

The UI should ask the server for one project object, not assemble five
client-side views:

```text
GET /api/project?name=<project>
```

Response sketch:

```json
{
  "name": "aiconvo",
  "cwd": "/home/maxime/Projects/aiconvo",
  "conversations": 1672,
  "notes": 98,
  "epics": [{ "id": "...", "title": "...", "updatedAt": 0, "freshness": "fresh" }],
  "recent": [{ "key": "...", "title": "...", "lastTs": "...", "note": "fresh", "evidence": "stale" }],
  "map": { "text": "...", "generatedAt": 0, "stale": false }
}
```

Launch sketch:

```text
POST /api/project/start
{ "project": "aiconvo", "agent": "pi", "name": "optional",
  "include": { "map": true, "epics": ["..."], "notes": false, "evidence": [] },
  "budget": "medium" }
```

These are contracts for another agent. The UX must work even when the first
implementation uses existing notes/evidence and returns `map: null`.
