# Screen specs

The app has one window with five view states. Layout skeleton:

```
┌──────────────────────────────────────────────────────────┐
│ aiconvo   [ search ………………………… ⏎ ]   Filters Mode ⚙N ⋯ │  52px
├───────────────┬──────────────────────────────────────────┤
│ [Conv|Notes|Epics]                                       │
│ ┌───────────┐ │                                          │
│ │ row       │ │        content column (max 760px)        │
│ │ row       │ │                                          │
│ │ row       │ │                                          │
│ ├───────────┤ │                                          │
│ │ 3 selected│ │                                          │
│ │ Copy Export│ │                                          │
│ └───────────┘ │                                          │
└───────────────┴──────────────────────────────────────────┘
     400px                       fluid
```

## Screen A — Conversation browser (default)

- List pane in "Conversations" tab.
- Right pane shows the empty state until a conversation is open.
- Sort: most recent first (server order).
- Live sessions sort into place by `lastTs`; their rows show the pulsing
  live dot.

Empty right pane: icon `message-square`, text
"Select a conversation to read it." + hint "Press / to search."

## Screen B — Conversation view

Components: sticky conversation header (5a), message list (5b–5d).

- On open from a full-text search: scroll the first `<mark>` into view,
  centered. Highlight all matches.
- View mode select changes the body rendering only; the header stays.
- "Unique commands" and "Files read" modes render in the same content column,
  using tool-style blocks and collapsible file cards.

## Screen C — Note / epic viewer

Triggered from: a note row, an epic row, "Note ✓" in a conversation header,
or a deep link (`#note=...`).

- Header card + two-column body (tree left, rendered section right).
- The list pane keeps its state in the background; the mode tabs stay visible
  so the user can switch lists without losing context.
- Actions in the header card:
  - Note from a conversation: `Copy .md`, `Back to conversation`.
  - Note from the Notes tab: `Copy .md`.
  - Epic: `Copy .md`, `Rebuild timeline` (label changes to
    "Add N selected + rebuild" when a selection exists).

## Screen D — Distillation progress

When the user starts a distillation and stays to watch:

- Sticky header: "Distilling [title]" + status text + "Continue browsing"
  button (ghost). The job continues on the server either way.
- Body: outline block (tool-style card) appears when the tree is known,
  then one card per problem leaf. Each leaf card streams text and ends with
  ✓ or ∅.
- The Jobs button shows the running count at all times.

## Screen E — Settings

Triggered from the header `settings` button, key `,`, or `#settings`.

- Header card shows the current memory model, context size, and thinking level.
- Body: thinking select, **use pi default**, then a searchable Pi catalog.
- Signed-in providers are grouped and can be expanded. Click a model row to save.
- This view does not change live Pi or Claude agent sessions.

## Modal cases (keep minimal)

| Case | UI |
|---|---|
| Epic name prompt | Replace `prompt()` with a small inline dialog in the selection bar: input + "Build" / "Cancel". Empty input = auto-generate. |
| Errors (distill, export, save) | Error toast with the server message. Never `alert()`. |
| "Select at least one/two" | Not a dialog. The buttons are disabled until valid, with a tooltip that explains why. |

## Responsive floor

- 960–1100 px: filters collapse into the popover; list pane shrinks to 340 px.
- Below 960 px: not supported. Show the layout as-is; do not add breakpoints.
