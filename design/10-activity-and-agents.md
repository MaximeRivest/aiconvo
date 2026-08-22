# 10 — Activity awareness and the agents popover

Status: implemented.

## Problem

Update toasts were removed because they covered the timeline. But then
all live awareness was gone: no sign when a new session appears or an
agent finishes a burst. Separately, the "N active" count was dead text —
the user wants to see *which* agents are running, writing, or recent.

## 1. Activity ticker

A single-line element in the header, between search and the count.
One slot, updated in place. It never stacks, never covers anything.

- Shows the latest session event: `❯ response · title · now`.
- The event kind comes from diffing the old and new index entries:

  | kind | signal | color |
  |---|---|---|
  | `● new` | session not seen before | accent |
  | `❯ response` | assistant message count grew | cyan |
  | `→ message` | user message count grew | green |
  | `⚙ tool call` | tool density grew, counts unchanged | dim yellow |
  | `~ update` | anything else | dim |

- A brief flash on change, in the kind color. Motion draws the eye.
- Click opens that conversation.
- Hidden when nothing has happened yet.

## 1b. Active pulse

While at least one session is active, the `● N` button pulses gently
(opacity 1 → .55 → 1, 2.4 s). A constant, quiet "things are running"
signal that never blocks anything.

## 2. Agents popover

The "N active" text in the header is now a button (`● N`, key `a`).
It opens a popover with three sections:

| section | content |
|---|---|
| running | a live `pi` or `claude` process, matched by `--session` / `--resume` / window title |
| writing | sessions with file changes in the last 5 min and no live process |
| recent | sessions from the last hour, dimmed |

- Rows show source dot, title, directory, and age or pid.
- Click a conversation row to open it.
- The popover refreshes every 15 s while open.

## Server

Endpoint `GET /api/agents/active`:

```json
{ "running": [{ "key", "source", "title", "cwd", "pid" }],
  "writing": [{ "key", "source", "title", "cwd", "ageMs" }],
  "recent": [...] }
```
