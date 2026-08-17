# 09 — Notifications: quiet by default

Status: implemented.

## Problem

Toasts were in the way:

- **Position.** Bottom-right covers the Gantt's "now" edge — the most
  interactive part of the timeline. Toasts blocked clicks on marks.
- **Spam.** Every file change from the watcher fired a `● title` toast.
  During active agent work that is a constant stream.
- **Redundancy.** "N conversations selected" repeated what the selection
  bar already shows.

## Rules

### 1. The timeline is the live view

No toast for session updates. New and changed conversations already
appear on the Gantt: blinking `█` for live sessions, the count updates,
an open conversation live-tails. A toast adds nothing.

### 2. Toast only for answers, not for events

A toast must be a response to something the user did, or a job result:

| toast | stays |
|---|---|
| job done (✓ note saved, epic saved, evidence ready) | yes, clickable |
| job failed (✗) | yes |
| action feedback (distillation started, epic started) | yes, short |
| `●` session updated | **removed** |
| N conversations selected | **removed** (the selection bar shows it) |

### 3. Small, top-right, short-lived

- Top-right, under the app header. The bottom edges belong to the
  timeline and the selection bar.
- 300 px wide, micro font, 6 px padding.
- At most 2 visible. A third removes the oldest.
- Durations: info 3 s, success 5 s, error 8 s. Hover pauses.
- Identical text within 2 s does not re-toast.

### 4. Every toast is dismissible

Click acts (if it has an action) and dismisses. Click with no action
dismisses.
