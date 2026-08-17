# 13 — Conversation tree & fork

The tree view sits in the artifact switcher: `transcript | tree | note | evidence | ▸epic`.
It answers two questions: "where did this conversation branch?" and "how do I continue from an earlier point?".

## Source data

Both providers store a real message tree, not a list:

- **pi**: every JSONL entry has `{id, parentId}`. The TUI branches natively: when the user
  rewinds and continues, new entries attach to an earlier parent. A `branch_summary` entry
  marks a return from an abandoned branch. 151 sessions on this machine already branch.
- **Claude Code**: every entry has `{uuid, parentUuid}`. Edits, retries, and rewinds create
  sibling branches the same way. 456 sessions on this machine contain branch points.

The server (`/api/tree`) contracts the raw entry graph to user/assistant text messages:
tool calls, tool results, meta entries, and mode changes collapse into their nearest text
ancestor. A linear assistant→assistant run merges into one **turn** box (`×N msgs`), titled
by its last message — the outcome, not the first step.

## Layout

- Root at the top. The y axis is time: one row per box, ordered by timestamp, with
  day + `HH:MM` labels inside each box.
- Columns work like a git graph: the first child continues its parent's column;
  every later child opens a new column to the right.
- The **active branch** (the path that ends at the newest appended message) uses solid
  borders and accent edges. Abandoned branches use dashed borders, dimmed text, and a
  `branch` tag. This also survives e-ink: solid vs dashed carries the meaning without color.
- Boxes: `user` boxes carry a `--role-user` left bar, `asst` boxes a `--role-asst` bar.
  Titles are the first sentence of the message, two lines max.

## Selection actions

Clicking a box selects it (accent outline) and opens a compact action bar below it:

- **read from here** — opens the transcript and scrolls to that exact message
  (matched by its timestamp anchor `data-ts`), with a temporary accent outline.
- **fork from here** — `POST /api/fork`. The server copies the entry chain from the root
  to that box into a **new session file** the native CLI can resume:
  - pi: `<timestamp>_<new-uuid>.jsonl` next to the original, with a fresh session header.
  - Claude: `<new-uuid>.jsonl` in the same project folder, `sessionId` rewritten on every line.
  The original file never changes. The fork is indexed immediately, appears on the timeline,
  and the existing composer / terminal resume path (Herdr) continues it from that point.

## Branch vs fork

Two different continuations, two different actions:

- **branch from here** (pi only) — the SAME conversation grows a new path. pi's session
  manager picks its leaf as the last entry in the file on load, and pi's own `branch()`
  writes a no-op `label` entry parented at the branch point. aiconvo appends exactly that
  one entry; the next resume continues from the chosen message, and the old path stays as
  a dashed branch. Requires the conversation's Herdr agent to be closed (a running pi
  keeps its leaf in memory). Verified end-to-end with `pi -p --session`.
- **fork (copy)** — a NEW session file continues from the chosen message; the original
  never changes. Works for pi and Claude. For Claude it is the only option: its CLI
  reconstructs context from the last real message and ignores externally appended
  anchors (verified empirically with `claude -p --resume` against a synthetic anchor),
  even though its JSONL stores real in-file trees (456 local sessions have branch
  points from edits and /rewind — the tree view renders them).

## Fork families

Forks live in separate session files, so a single-file tree would stay linear. The tree
therefore unions the whole family:

- Membership: sessions that share their first entry id (every fork copies the root chain
  verbatim, so the first `id`/`uuid` matches), plus sessions linked by pi's `parentSession`
  header field (written by the pi TUI's native fork and by aiconvo's fork).
- The `rootId` and `parentSession` are captured at index time (CACHE_VERSION 4), so family
  lookup is an in-memory scan — no file reads until a tree is actually opened.
- Entries dedupe by id across files; each fork's new messages attach to the shared chain
  as real branches. Assistant-run merging never crosses a file boundary.
- The active path belongs to the file being viewed. Boxes owned by another family member
  are magenta with an `↳ fork` tag, and their read/fork actions target that session.

## Non-goals

- No model calls: box titles are deterministic first sentences, so the tree is instant and free.
- The tree does not try to show tool traffic; the transcript's "everything" mode does that.
