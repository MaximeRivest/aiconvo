# 16 — Agent blame: line-level file history

## Purpose

The diff timeline answers "what happened when". Blame answers the more common
question: **"who (which agent, which conversation, when) last touched this
line?"**

It is the compact reading view. The diff timeline stays as the drill-down.

## Model

One row per **current file line**, reconstructed by replaying recorded agent
edit/write events in chronological order:

- `write` → the whole file content becomes attributed to that event.
- `edit` / `multi-edit` → the replaced region's new lines become attributed to
  that event; untouched lines keep their attribution.
- An edit whose `oldText` no longer matches is skipped and counted, because
  the history diverged (failed edit, outside change, or missing earlier
  events).

Each rendered line shows: line number, relative age, agent glyph, age bar,
and the text. Hover shows the conversation title, full timestamp, and event
kind. Click opens that event's diff card.

## Truth boundary

This is **agent-attributed blame**, not Git blame:

- Attribution comes from edit/write tool calls only.
- Changes made outside recorded conversations are invisible to it.
- When the reconstructed content differs from the file on disk, the header
  says so: `⚠ file changed outside recorded edits`. The view still shows the
  reconstructed agent state, because that is the state we can attribute.

## Placement

- Every file row in the diff views gets a `blame` action.
- Deep link: `#blame=<encoded-path>`.
- Blame opens in the right pane, scoped like its parent: project blame uses
  the project's recent conversations; conversation blame uses one session.

## Layout

```text
~ server.js · aiconvo · blame
42 attributed lines · 84 events · 3 skipped · ⚠ file changed outside recorded edits
[back to diffs] [agent: all ▾] [filter text]

── 13 Aug 2026 ───────────────────────────────
  91  2h  ~ ▎ function provenanceMarkdown(s) {
  92  2h  ~ ▎   const key = s.key || '';
  93  3d  ± ▎   const notePath = ...
```

- Day separators group lines visually, like a ledger.
- Age classes: `<1h`, `<1d`, `<1w`, `<1M`, older. Recency uses the accent
  color with decreasing weight; e-ink uses bold for `<1d` and plain text
  otherwise. Never color-only: the age text is always printed.
- A compact event strip on top (dots on a time axis) gives the file's edit
  rhythm. It is a summary, not the main reading surface.

## Interaction

| Action | Result |
| --- | --- |
| click line | open that line's event diff card |
| hover line | conversation title · full timestamp · kind |
| `back to diffs` | return to the parent diff view |
| agent select | filter attribution glyphs and attribution stats |
| filter input | filter visible lines by text |

No editing, no Git operations, no inline diff expansion beyond the existing
diff card.

## Performance

- Blame replays cached conversation diff events; extraction is not redone.
- Rendering caps at 3000 lines with an explicit "showing 3000 of N" note plus
  the text filter.
- Server returns the attributed line list in one response.

## API

```text
GET /api/file/blame?path=<path>&project=<name>
GET /api/file/blame?path=<path>&key=<conversation-key>
```

```json
{
  "path": "/home/maxime/Projects/aiconvo/server.js",
  "lines": [{ "n": 91, "text": "...", "event": { "id": "...", "ts": "...", "agent": "claude", "kind": "edit", "conversationTitle": "..." } }],
  "events": 84,
  "applied": 81,
  "skipped": 3,
  "matchesDisk": false,
  "scanned": 60
}
```
