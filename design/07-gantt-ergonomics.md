# Gantt rendering, zoom and navigation

Status: implemented; not yet exercised on real devices (see the end).

## Ownership

`timeline-chart.js` is one renderer for three charts: the home conversations
timeline, the notes timeline, and the expanded project masthead. It owns the
camera (pixels per day and scroll offsets), input (wheel, keys through the
adapters, one- and two-finger touch), the animation frame, and a windowed SVG
drawing. `app.html` owns the data: which conversations, which lane, which
label, which classes; plus navigation, selection, tooltips and the detail card.

The contract is `new TimelineChart({ scroller, ... })` then `setData(data)`
whenever the data changes. A gesture never re-filters conversations, re-packs
lanes, replaces the scroller, or reads coordinates from a previous drawing.

Adapters:

- Home (`paintHomeTimeline`): one chart for the conversations and notes tabs.
  Switching tab or row grouping disposes it, so the next one opens at "now".
  Leaving the home route only stops it; it stays mounted behind the route.
- Project masthead (`mgPaintOpen`): mounted when the ridgeline expands,
  destroyed when it folds or the route changes. Its scale, center and row
  scroll survive in `mgUI`; a search keystroke hands it new data and keeps
  the input, the scroller and the camera.

## Camera invariants

- Scale is px/day, continuous. Home keeps 160 px/day as the `days` preset,
  0.08×–8× limits and the hours/days/weeks presets. The project chart's
  lowest zoom fits the whole history (`fitMinimum`); its first open shows
  about a week ending now. Very long histories are additionally capped by the
  browser's scroll extent.
- `x = gutter + (time − start) / DAY × scale`. The origin is the data's
  start; no pixel is ever computed from an earlier drawing.
- One primitive keeps orientation through every change of scale, viewport
  or data: `anchor()` records what the viewer looks at (the end of history
  while pinned there, else the time under the viewport center) and restores
  it after the change. Resize, data updates, `fit` and scale clamping all go
  through it.
- Zoom keeps the date under the pointer or the pinch midpoint. A pinch uses
  distance for scale and midpoint movement for panning, so both happen in
  one motion. Clamping wins at the bounds of history.
- Every input updates the camera immediately; one animation frame commits
  surface size, scroll offsets, the drawing window and all geometry together.
  The camera keeps fractions of a pixel so slow pans accumulate instead of
  rounding to nothing; an offset the browser already holds is not
  reassigned, which would cut a native smooth scroll short.
- Native scrolling (scrollbar, keys, plain wheel) is folded in as a delta,
  so it cannot overwrite a zoom queued for the same frame. Our own commits
  are recognised and ignored by the scroll listener.
- Data arriving during a touch gesture is deferred until the fingers lift;
  only the newest update is kept. Otherwise a data update keeps the view.
- Hidden charts do not draw or animate; the ResizeObserver wakes them.

## Input

| Input | Action |
| --- | --- |
| Plain wheel / trackpad | Native two-axis scrolling, inertia included |
| Shift + wheel | Horizontal pan |
| Ctrl/⌘ + wheel, trackpad pinch | Proportional zoom at the pointer, 80 ms interpolated |
| One finger | Pan; a quick release coasts briefly |
| Two fingers | Continuous anchored zoom and pan, no dead zone |
| `+` `−` `0`, zoom buttons, presets | 140 ms interruptible transition around the center |
| `b` / Home, `n` / End | Beginning of history / now |
| Shift + PageUp/PageDown | Horizontal page (native scroll) |

Wheel deltas are normalised across pixel, line and page units. A running
transition is retargeted by the next input, not restarted. The reduced-motion
preference removes the interpolation; touch is always direct.

While a chart is mounted its scroller has `touch-action: none`, so the chart
owns touch panning as well as pinching: one and two fingers cannot be split
between the chart and the browser mid-gesture, and no pointer is cancelled.
Pointer capture begins with the drag, not the touch, so a tap still lands on
the mark under it. A click that ends a drag is suppressed; keyboard
activation is not. Blur, hiding the page, rotation and destruction release
the gesture. The e-ink reading gestures skip `.timeline-scroller`. E-ink
gets the same continuous loop as every other screen; only the theme differs.

Mouse drags are left to the adapter (rubber-band selection on the home chart).

## Drawing

- Lanes are packed in time, not pixels: zoom changes distances, never the
  vertical layout. Crowded titles hide; conversations never move rows.
- Marks are indexed once per data change by track and start time, with
  prefix maxima of end times, so a window query skips off-screen history
  while still finding long marks that cross it.
- One retained SVG covers the viewport plus a bounded buffer. The large
  scrollable surface is only a spacer. Marks, grid ticks and project bands
  keep their DOM nodes while in the window; only geometry attributes change
  per frame. A focused mark stays mounted until focus leaves it.
- Everything that does not move with the camera (classes, selection, the
  highlighted project row, live state, titles) is decided by the adapter per
  data change and applied once per mark object. Changing the highlighted
  row is therefore a render, like changing the selection.
- Ticks fall on local calendar boundaries, advancing by date across
  daylight-saving changes; hours within a day are minor lines. Labels use
  cached formatters.
- Adapters read hit geometry (`x0`, `x1`, `y`, `laneHeight`) from the marks
  the last frame drew, never from a live closure over the camera.

## Trade-offs

- Time-based lanes can let tiny marks overlap at wide zoom; the alternative,
  zoom-dependent repacking, moves every row under the finger.
- Overlapping labels are dropped by a character-width budget instead of
  measured text, which can leave unused space with narrow glyphs. Full
  titles remain in the tooltip and detail card.
- Chart-owned touch panning replaces native touch scrolling of the list on
  the home route. Without it, a pinch that starts as a one-finger scroll is
  cancelled by the browser.
- Toggling row grouping opens the new layout at "now" rather than keeping
  the time center: the rows underneath change entirely, so the previous
  vertical position is meaningless anyway.
- SVG is retained: its styling, focus and click semantics carry over. The
  bottleneck was full rebuilds, not SVG itself.

## Serving

`app.html` loads `/timeline-chart.js`; `server.js` serves it with the same
no-cache policy as the other first-party scripts. Deploy them together; a
running backend needs a restart before a reload can load the route.

## Verification status

Only parsing and whitespace checks have been run. Before calling this done,
exercise on a laptop, the phone and the e-ink tablet: repeated pinch
reversal, a pinch whose midpoint moves, zero/one/many conversations, long
marks crossing the window, scrollbar jumps, both zoom bounds, rotation and
sidebar resizing, touch cancellation, tapping versus dragging a mark, binary
selection hatching, project search while open, and navigating away with a
transition pending.
