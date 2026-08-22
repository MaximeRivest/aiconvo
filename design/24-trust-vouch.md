# 24 · Trust and vouching

## Problem

Most of aiconvo's memory — notes, intent, environment, status, epics — is AI-generated. It is valuable, but it is not verified truth. The same is true for most repository files: an agent wrote them, and nobody re-read them. Some content, however, *was* reviewed, corrected, or hand-edited by the user. The system had no way to record that difference, so agents and readers had to treat everything with the same (unknown) confidence.

## Model

One primitive: the **vouch**. A vouch is a single human assertion:

> "I checked this exact content at this time."

- **One level.** There is no strength scale; you vouched or you did not.
- **Nothing is excluded.** Trust never filters or hides content anywhere. It only labels it. A disputed note still goes into a briefing — with its label.
- **Dispute** is the negative twin: "I checked this and it is wrong." It is as valuable a signal as a vouch.
- **Retract** cancels an earlier record by id. The ledger stays append-only.

### Trust states of content

| state | meaning |
| --- | --- |
| unverified | AI-generated or never reviewed. The default for everything. |
| vouched | a human checked this exact content; it is unchanged since. |
| partly vouched | some lines were checked (or some checked lines changed since). |
| changed since review | vouched earlier, but the content changed after — probably still useful, possibly stale. |
| disputed | a human marked it wrong. Read critically; never treat as fact. |

## Anchoring

Vouches anchor to **exact line text, matched in order** (`trust.js`, tested):

- A record stores the vouched block's exact lines and a content hash.
- Against the current content, lines match with an ordered two-pointer scan.
- A **moved** line keeps its vouch. A **changed** line silently loses it.
- Staleness therefore falls out for free: no diff tracking, no Git dependency, and it works identically for notes outside Git and for repository files.
- Identical content (hash match) is a fast path: every line is vouched.

## Storage

`~/notes/aiconvo/vouches.jsonl` — append-only JSONL, one record per line:

```json
{ "id": "…", "ts": "…", "action": "vouch|dispute|retract", "path": "/abs/path",
  "range": [12, 40], "contentSha": "…", "text": "…exact vouched lines…",
  "note": "optional", "source": "file-view|note|note-section" }
```

Plain, durable, auditable, rebuildable — like every other durable artifact. The server loads it at boot and appends on write.

## API

- `POST /api/vouch` — append a record. `retract` needs `ref`.
- `POST /api/vouch/status` `{path, content?}` — full status against the given content (or the disk file): per-record freshness plus a `lines` map (`'v'` vouched, `'d'` disputed; dispute wins per line).
- `GET /api/vouch/all` — one disk-state summary per vouched path, for tree badges and the review queue.

## UI

- **Whole-file views** (conversation diffs, project file Gantt, Git scope): `✓ vouch` / `✗ dispute` in the status bar. They act on the browser text selection (line-granular) or, with no selection, on the whole displayed file. The buttons keep the selection alive (`mousedown` prevented). Vouched lines show `✓`, disputed `✗`, in the line-number gutter — shape, not color, so e-ink keeps meaning.
- **Note views** (notes, epics, project memory docs): trust state next to the title (`⚠ AI-generated · unverified` until vouched), `✓ vouch file`, `✗ dispute`, and a per-section `✓ vouch section`.
- **Project file tree:** vouched files get a `✓` / `✓±` / `⚠` / `✗` badge. Unvouched files stay unmarked — unverified is the silent default.
- **Project overview → trust section:** a review queue. Disputed first, then changed-since-review, then partial, then fresh. Clicking an entry opens the note, epic, memory doc, or file. This is the "help with staleness" surface: a short re-reading session keeps the vouched surface honest.

## Agents

Briefings carry a **Trust warning** section explaining the labels, and every listed path (project memory docs, notes, epics, evidence notes) gets its label inline:

```
- Deep user intent: /home/…/intent.md [partly vouched 2026-08-19, changed since review]
- /home/…/notes/aiconvo/2026-08-18-….md [unverified]
```

Everything is still included; the agent decides how much weight to give it.

## Non-goals

- No trust filtering, ranking, or hiding of content anywhere.
- No multi-level confidence scores.
- No automatic vouching. A vouch is a human act; implicit signals (human Git commits) may later become *hints*, never vouches.
