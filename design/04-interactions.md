# Interaction spec

## Keyboard shortcuts

| Key | Context | Action |
|---|---|---|
| `w` | anywhere | Toggle the full-screen window overview. |
| `/` | anywhere | Focus the search input. |
| `Esc` | search focused | Clear search, back to filter mode, blur. |
| `Enter` | search focused | Run full-text search. |
| `↑` / `↓` | list pane | Move the active row. Opens on selection change. |
| `Space` | list row focused | Toggle its checkbox. |
| `e` | conversation open | Export this conversation (.md download). |
| `c` | conversation open | Copy this conversation as markdown. |
| `d` | conversation open | Distill / open note. |
| `f` | anywhere | Toggle the filter popover. Focuses the first select. |
| `,` | anywhere | Open or close the settings view. |
| `g` | anywhere | Cycle the Gantt layout: bottom / left / off. Saved in localStorage. |
| `j` | anywhere | Toggle the jobs drawer. |
| `1` `2` `3` | list pane | Switch tab: Conversations / Notes / Epics. |
| `?` | anywhere | Show the shortcut cheat sheet (small overlay). |

Single-key shortcuts never fire while an input, select, or textarea has focus.

## Selection model

- Selection persists across searches, filters, and tab switches.
  The selection bar always shows the true count.
- "Select shown" selects every conversation currently on the timeline.
- Click a mark to open it. Shift-click or Ctrl-click toggles its selection.
- **Rubber-band:** drag anywhere on the chart, including on a mark.
  The band activates after 6 px of movement and selects every mark that
  intersects the rectangle. Shift-drag adds to the current selection.
  A drag under 6 px counts as a click and opens the conversation.
  Clusters select all their members. The chart uses `user-select: none`,
  so drags never trigger native text selection.
- Rubber-band works on the notes timeline too: it selects the
  **conversations behind the notes** in the rectangle.
- Selected marks get a `--success` outline.

## Live updates

Current behavior is correct and must be kept: no view yanking.

- New/changed conversation: toast "● [title]". Click opens it scrolled to
  the newest message.
- Open conversation grew:
  - If the user is pinned to the bottom (within 80 px): live tail. Reload and
    keep the view at the bottom.
  - If the user scrolled up: do not touch the view. Show "↻ New messages" in
    the sticky header. Clicking reloads and jumps to the newest message.
- Scroll position of the list is preserved on every re-render (already done;
  regression-test it).

## Jobs

- Starting a job shows a neutral toast: "Distillation started."
  It never opens the drawer.
- Job done: success toast "Note saved: [title]". Click opens the result.
- Job failed: error toast with the reason. The failed card stays in the
  drawer until dismissed.
- Clicking a job card:
  - running distill → open the streaming progress view (read-only attach).
  - done distill → open the note.
  - done epic → open the epic.
  - error → no navigation; expand the card to show the error text.

## Focus and accessibility

- Focus is visible on every control: `--accent` border on inputs and buttons,
  inverse video on list rows and tree rows.
- Tab order follows the visual order: header left→right, list, content.
- The jobs drawer and the filter popover trap focus while open and return
  focus to the trigger on close.
- Live regions: job status changes and toasts use `aria-live="polite"`.
- All icon-only buttons have `aria-label`.
- Contrast targets (all met by the tokens): body text ≥ 7:1, meta text ≥ 4.5:1,
  UI borders ≥ 3:1 against the adjacent surface.

## Motion details

- Drawer, popovers, toasts: instant or 60 ms linear. No slides, no springs.
- Live cursor: `█` blink, 1 s steps. Distilling: `░▒▓` cycle, 300 ms steps.
  Both stop under `prefers-reduced-motion` (static glyph).
- Text progress bars (`████░░`) update in place, no animation.

## Error and edge cases

| Case | Behavior |
|---|---|
| Server unreachable | List pane shows empty state with "Reconnecting…" and a retry button. Do not clear the current conversation view. |
| Search returns nothing | Keep rows area: "No matches for “q”. Try different words." + button "Clear search". |
| Conversation file deleted on disk | Open shows an empty state: "This conversation is no longer available." + back action. |
| Very long title | 2-line clamp in rows, 1-line ellipsis in headers, full title in `title` tooltip. |
| Very long directory | Middle-ellipsis in meta lines: `~/Projects/…/aiconvo`. |
