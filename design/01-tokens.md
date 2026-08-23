# Design tokens

Direction: **terminal-native with brutalist edges**.
The file `tokens.css` in this folder is the source of truth. It is drop-in.
Dark is the default theme. Light is fully supported through the same tokens.

## Color theory (how the palette is built)

The palette is computed, not picked. Four rules:

1. **Convention-fixed hues.** Red = error, yellow = warning, green = success.
   Users already know this code. We keep it.
2. **Equal perceptual weight.** All colors are computed in OKLCH with the
   same chroma (`C = 0.13`) and the same lightness per theme. No color
   shouts louder than another.
3. **Even hue spacing.** The five hues sit near-equidistant on the OKLCH
   hue wheel: 27° (red), 95° (yellow), 150° (green), 225° (cyan),
   320° (magenta). Gaps: 68 / 55 / 75 / 95 / 67. A modified pentadic harmony.
4. **Tinted neutrals.** Every grey carries a small amount of hue 150°
   (the accent hue). The whole UI reads as one material.

Theme mapping:

- Dark theme: accents near `L = 0.78` on dark neutrals. Contrast 8.3–9.2:1.
- Light theme: accents at `L = 0.52` on light neutrals. Contrast 4.7–5.4:1.
  Same hues, same chroma. Only lightness mirrors.
- Fills (inverse video, primary buttons) use `--accent-strong`, not
  `--accent`. In dark it equals the accent; in light it is a deeper green
  (`#005f21`, 7.9:1 with white text). This keeps light-mode fills readable.

Verified contrast (WCAG): body text 12.4:1 dark / 15.0:1 light,
dim text 5.4:1 / 6.6:1, all accents ≥ 4.5:1 in both themes.

The rules behind the tokens:

1. **One font: monospace.** UI text, prose, code — all mono.
2. **Square corners.** Radius 0. Only 2 px where a join looks broken.
3. **No shadows, no blur, no gradients.** Layers separate with 1 px borders.
4. **ANSI palette.** Colors come from the terminal: green, cyan, yellow, red,
   magenta. Green is the accent.
5. **Inverse video for selection.** The active row is accent background with
   dark text, like a terminal cursor line.
6. **Near-instant motion.** 60 ms or nothing. No easing curves.

## Color

### Surfaces (dark | light)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#101412` | `#f2f6f3` | App background. |
| `--surface-1` | `#171c19` | `#eaeeea` | Header, list pane, drawers. |
| `--surface-2` | `#1f2521` | `#dfe4e0` | Hover, inputs, cards. |
| `--surface-3` | `#272e2a` | `#d2d8d3` | Subtle emphasis, progress tracks. |
| `--border` | `#343c36` | `#c3c9c4` | Hairlines everywhere. |
| `--border-strong` | `#4d564f` | `#9aa09b` | Hover borders, separators. |

Contrast between surfaces is deliberately small. Borders do the work.

### Text (dark | light)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--text` | `#dce3dd` | `#1b211c` | Primary. |
| `--text-dim` | `#98a29a` | `#525953` | Metadata, paths, counts. |
| `--text-faint` | `#5f6a61` | `#6a716b` | Placeholders, disabled, tool labels. |

### ANSI colors (dark | light)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--green` | `#7dd492` | `#1d7d3e` | Accent, live, success, user role, pi source. |
| `--cyan` | `#53c8f1` | `#0076a0` | Assistant role, info, links inside prose. |
| `--blue` | `#79a8ff` | `#315ea8` | ANSI blue and imported terminal themes. |
| `--yellow` | `#d3ba54` | `#816600` | Search highlight text, warnings, claude source. |
| `--red` | `#f79d94` | `#a7463e` | Errors, failed jobs. |
| `--magenta` | `#dc9fe9` | `#894d97` | pi-remote source, epic identity. |

`--accent` is an alias of `--green`. Use it for text and borders.
Use `--accent-strong` + `--accent-ink` for fills (inverse video, primary
buttons, checkboxes). In dark they equal the accent + near-black. In light
they are a deeper green + white.

### Source identity

| Source | Color |
|---|---|
| claude | `--yellow` |
| pi | `--green` |
| pi-remote | `--magenta` |

Sources show as a 7 px square (not circle — squares fit the direction) plus
the source name in `--text-dim`.

## Typography

One stack: `--font: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace`.

| Token | Size / weight | Use |
|---|---|---|
| `--fs-title` | 15 px / 700 | Conversation and note titles. |
| `--fs-body` | 13 px / 400 | Message text, list rows, UI. |
| `--fs-label` | 12 px / 400 | Buttons, tabs. |
| `--fs-meta` | 12 px / 400 | Meta lines (dim color). |
| `--fs-micro` | 11 px / 400 | Role labels. |

- Line height: 1.5 for prose, 1.4 for UI.
- Role labels are lowercase with a sigil: `user ❯`, `assistant ❯`, `$ bash`.
  No uppercase, no letter-spacing. Mono does not need it.
- Weight contrast replaces size contrast: titles 700, body 400, meta dim.
- Reading column max width: 1080 px.

## Spacing

Dense 8-point grid: `--sp-1: 4` `--sp-2: 8` `--sp-3: 12` `--sp-4: 16` `--sp-6: 24`.

- List row padding: `8px 10px`.
- Header height: 44 px.
- Transcript block gap: 2 px (bordered blocks sit close, like terminal output).
- Transcript block padding: `10px 14px`.

## Edges, borders, effects

- `--r: 0` default. `--r-sm: 2px` for checkboxes and the mark highlight only.
- Borders: 1 px `--border`. Adjacent panes share one border, no doubles.
- `--shadow: none`. Drawers and toasts use a `--border-strong` outline.
- Selection and focus use **inverse video**: background `--accent-strong`,
  text `--accent-ink`. Focused inputs keep a `--accent` border instead.

## Theming mechanics

- `design/tokens.css` is the runtime source. `app.html` loads it from `/tokens.css`.
- Dark is the default. Light activates via `prefers-color-scheme: light`.
- Manual override: `<html data-theme="light">` or `"dark"`.
- User themes live in `~/.config/aiconvo/themes`. See `25-themes.md`.
- Components must never reference theme-specific hex values. Tokens only.
  If a component needs a new color, add a token to all built-in themes first.

## Motion

- One duration: `--t: 60ms linear`. Hover, focus, drawer, toast.
- Live marker: a block cursor `█` that blinks (1 s steps). No smooth pulses.
  Under `prefers-reduced-motion`: static `█`.
- Progress bars can also render as text: `██████░░░░░░ 3/8`. Both are allowed;
  pick one and stay consistent. The HTML bar is preferred for layout stability.

## Glyph language

Emoji stay out of the UI. Use this fixed ASCII/Unicode set instead:

| Glyph | Meaning |
|---|---|
| `❯` | prompt sigil for roles, expandable rows |
| `●` | live session |
| `█` | blinking cursor, progress fill |
| `░` | progress empty |
| `✓` | done, saved, note exists |
| `✗` | error, failed |
| `∅` | empty result |
| `›` `▸` `▾` | tree twists |
| `←` | back |
| `[x]` `[ ]` | checkbox states in ASCII contexts |
