# 07 — Gantt ergonomics: zoom and navigation

Status: implemented.

## Problem

The timeline covers months of history. Three discrete zoom steps and manual
scrolling are not enough:

- At `hrs` zoom the chart is ~180 000 px wide. Finding a moment is work.
- There is no way to jump: to now, to the oldest session, to a date.
- Zoom is not anchored. Changing scale loses the moment you looked at.
- The wheel scrolls lanes, not time. Time is the primary axis.

## Design decisions

### 1. Continuous zoom, named presets

Zoom is a float multiplier, not three states. Base = the `days` density
(160 px/day horizontal, 180 px/day vertical). Range: 0.08× to 8×.

The `hrs | days | wks` buttons stay, but they are presets that set the
multiplier (6×, 1×, 0.15×). A preset button lights up when the current
zoom is near it. Users zoom smoothly; the presets are landmarks.

Grid ticks derive from the effective px/day, not from a mode:

| px/day | tick step | labels |
|---|---|---|
| ≥ 480 | 1 hour | date at midnight (solid), hour every 3 h |
| 40–480 | 1 day | date every day |
| < 40 | 1 week (Monday) | date every week |

Mark labels hide below 40 px/day. Tooltips always work.

### 2. Anchored zoom

Zoom keeps the moment under the cursor fixed in the viewport.
Keyboard and button zoom anchor on the viewport center.
Wheel zoom (Ctrl+wheel) anchors on the pointer.

### 3. Time-axis wheel

On the chart, the wheel follows the time axis:

| gesture | action |
|---|---|
| wheel | scroll along time (horizontal in bottom layout, vertical in left layout) |
| Shift+wheel | cross axis |
| Ctrl+wheel | zoom at pointer |

Lists without a chart (epics, empty states) keep the default wheel.

### 4. Jumps

| control | key | action |
|---|---|---|
| `«` | `b` | jump to the beginning (oldest session) |
| `»` | `n` | jump to now |
| date field | `t` | focus the date field; Enter jumps and centers |
| `+` / `-` | `+` `-` | zoom in / out around the viewport center |
| — | `0` | reset zoom to `days` |

### 5. Follow-now

If the view is pinned at now when a live update arrives, it stays pinned.
If the user scrolled into the past, nothing moves.

### 6. Toolbar

A slim bar between the tabs and the chart, visible only when the timeline
is on:

```
[«] [»] │ [−] [+] [hrs|days|wks] │ [date]
```

The zoom presets move here from the tab bar. The layout icons stay in the
tab bar. All controls have tooltips with their keys.

## Edge cases

- Zoom clamps at 0.08× and 8×.
- A jump during a rubber-band drag cancels nothing; selection is untouched.
- The date field rejects unparseable input silently (no toast).
- Hidden timeline (`off`) disables the toolbar and the zoom keys.
- Zoom and jumps work identically on the notes timeline.
