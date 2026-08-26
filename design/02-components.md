# Component specs

Direction: **terminal-native + brutalist**. Read `01-tokens.md` first.
Global rules: mono font everywhere, square corners, 1 px borders, no shadows,
glyphs instead of icons. Every component lists structure, states, measurements.
Use the tokens from `tokens.css`. Do not hardcode colors.

## 1. App header

Height `--header-h` (44 px). Background `--surface-1`. Bottom border `--border`.
Zones, left to right:

1. **Brand.** `aiconvo` prefixed with a green `❯`. 700 weight, `--text`.
   Acts as home button (clears search and filters).
2. **Search zone.** One input, flex-grows, min 240 px.
3. **Action zone.** `filters` button, view-mode select, `jobs [N]` button,
   overflow `…`.

Selection actions (Copy, Export, Build epic) live in the selection bar
(component 4c), never in the header.

States: below 1100 px window width, the selects fold into the filter popover.

## 2. Search input

- Background `--surface-1`, border `--border-strong`, square, height 30 px.
- Focus: border becomes `--accent`. No glow ring. A blinking `█` cursor
  inside marks focus (native caret is enough if styled `--accent`).
- Placeholder: `search titles — enter for full-text search` in `--text-faint`.
- Full-text search running: a `…` indicator at the right edge. Result state:
  an `✗` button inside the input clears back to filter mode.

## 3. Filter popover

The `filters` button shows a popover. The button label shows active state:
`filters` or `filters:2`.

Popover: `--surface-1`, 1 px `--border-strong`, no shadow, square, min width
260 px. Contains:

- Source: radio list with source squares (all / claude / pi / pi-remote).
- Directory: searchable single-select list.
- Timeline options (for example: include tool calls in density).

The popover holds **list filters only**. Anything that changes the open
conversation (view mode: chat / commands / everything / unique commands /
files read) lives in the conversation header, not here.

Filters stay applied when the user switches between the conversations,
notes, and epics tabs. Notes filter by search text, and by source and
directory through their source conversation. Notes without a matched
conversation hide when a source or directory filter is active.
Epics filter by search text only.

## 4. List pane (left column)

Width `--list-w` (400 px). Background `--surface-1`. Right border `--border`.

### 4a. Mode tabs

Segmented control at the top: `conversations · notes · epics`.
Replaces the three self-renaming header buttons.

- Container: 1 px `--border`, square, full list width.
- Segment: height 28 px, `--fs-label`, `--text-dim`, right border between
  segments.
- Active segment: **inverse video** — background `--accent-strong`, text
  `--accent-ink`, 700.
- Hover on inactive: background `--surface-2`.

### 4b. Conversation row

```
[checkbox] [title, 2-line clamp]
           [src square+name] · [dir] · [date] · [12u/48a] · [note ✓]
           [search snippet, dim, matches bold --yellow]
```

- Padding `8px 10px`. Rows separate with 1 px `--border`.
- Title: `--fs-body`, 700. Meta: `--fs-meta`, `--text-dim`.
- Source marker: 7 px **square** in the source color + name.
- Live marker: blinking green `█` before the title. Tooltip "active now".
- Distilling: title in `--text-dim` with a `░` spinner substitute
  (cycle `░▒▓` at 300 ms) before it.

States:

| State | Style |
|---|---|
| Hover | Background `--surface-2`. |
| Active (open) | **Inverse video**: background `--accent-strong`, text `--accent-ink`. Meta goes to 75% opacity ink. |
| Checked | Checkbox fills `--accent-strong`; row itself unchanged. |

The checkbox is hidden until row hover, any selection exists, or keyboard
focus. This keeps the list calm.

### 4c. Selection bar

Bottom of the list pane, appears when ≥ 1 row is checked.
Background `--surface-1`, top border `--border-strong`, padding `6px 10px`.

Contents: `3 selected` (dim) + `copy` / `export .md` (primary) /
`build epic` (disabled under 2) / `clear` (ghost).

### 4d. Note marks and epic rows

Notes use the same Gantt timeline as conversations. A note is a green
(`--success`) violin mark that spans the duration of its source conversation
(matched via `notePath`). Unmatched notes render as a short mark at the save
time. Click opens the note. Hover shows name, save date, and source title.

Epics stay list rows for now: magenta `▸` sigil, meta line
`N conversations · updated [date]`.

## 5. Conversation view (right pane)

Background `--bg`. Padding `12px 20px`. Content column max `--read-max`
(780 px), left-aligned with auto margins.

### 5a. Conversation header (sticky)

Sticky top. Background `--bg`, bottom border fades in after scroll.

- Line 1: title, `--fs-title`, 700.
- Line 2 (meta, `--fs-meta`, `--text-dim`): source · dir (mono path) ·
  branch · date range.
- Right: `copy`, `note ✓` / `distill`, `↻ re-distill` when the session grew,
  the **view-mode select** (chat / commands / everything / unique commands /
  files read), `↻ new messages` on live updates.

### 5b–5d. Transcript blocks (replaces bubbles)

The conversation renders as one bordered transcript: a single 1 px `--border`
container, blocks separated by 1 px `--border` rows. No rounded bubbles.
This reads like a terminal scrollback and keeps long conversations dense.

| Block | Background | Role label | Label color |
|---|---|---|---|
| user | `--bg` | `❯ user` | `--role-user` |
| assistant | `--surface-1` | `❯ assistant` | `--role-asst` |
| tool call | `--bg` | `$ [tool name]` | `--role-tool` |
| tool result | `--bg` | `↳ result` | `--role-tool` |

- Block padding `10px 14px`. Text `--fs-body`, line-height 1.5, `pre-wrap`.
- Tool text: 12 px, `--text-dim`.
- Tool results collapse above 20 lines: `… show NNN more lines` expander in
  `--cyan`. No inner scroll boxes.

### 5e. Search highlight

`mark`: no background. Color `--yellow`, 700. In a mono UI, bold yellow reads
better than a paint swatch. First match scrolls to center.

## 6. Note / epic viewer

Keep the two-column repo layout (tree left, rendered section right).

- Tree and pane: `--surface-1`, 1 px `--border`, square.
- Tree row height 26 px. Twist `▸`/`▾`. Selected row: inverse video.
- Header block: title, abstract (prose width), meta line, actions
  (`copy .md`, `← back to conversation`, `rebuild timeline` for epics).
- Rendered markdown: headings 700 with a leading `#` per level, code fences
  on `--surface-2` with `--border`, inline code in `--cyan`.

## 7. Jobs button + drawer

Header button: `jobs [N]`. While jobs run, `[N]` is `--accent` and the label
gets the `░▒▓` cycle.

Drawer: right side, anchored under the header, width 360 px, `--surface-1`,
left border `--border-strong`, no shadow. Slide-in 60 ms. Closes on Esc and
click outside. Header row: `background work` + `✗` close.

Job card: 1 px `--border`, square, padding `8px 10px`.

- Status line uses text progress: `██████░░░░░░░░ 3/8 · distilling problems`
  (bar in `--accent`; done → `--success` `✓ saved`; error → `--danger`
  `✗ failed: [reason]`).
- Whole card clickable. Click behavior in `04-interactions.md`.

## 8. Toasts

Bottom-right, stacked, max 3, width ~360 px.
`--surface-1`, 1 px `--border-strong`, square, `--fs-label`, padding `8px 10px`.
Severity = 3 px left border: neutral `--border-strong`, success `--success`,
error `--danger`. Auto-dismiss 5 s, hover pauses, click runs the action.
All `alert()` calls become error toasts.

## 9. Empty states

Centered: one dim sentence, one faint hint or action. No icons, no mascot.
Copy in `05-copy.md`.

## 10. Buttons

| Variant | Style | Use |
|---|---|---|
| Primary | bg `--accent-strong`, text `--accent-ink`, 700 | One per view. |
| Default | bg `--surface-1`, border `--border-strong` | Everything else. |
| Ghost | transparent, `--text-dim`, hover `--text` | Low-priority actions. |
| Danger | border `--danger`, text `--danger`; hover fills `--danger` | Destructive only. |

All: height 30 px, square, padding `0 12px`, `--fs-label`, lowercase.
Disabled: opacity .4. Focus: border `--accent`. Hover on default:
background `--surface-3`.

## 11. Selects and checkboxes

- Selects match default buttons; `▾` at the right edge.
- Checkbox: 14 px square, 1 px `--border-strong`, 2 px radius. Checked:
  `--accent-strong` fill with `✓` in `--accent-ink`.
