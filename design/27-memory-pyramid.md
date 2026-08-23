# 27 — Memory pyramid: accumulate facts, regenerate prose

Project memory today is one big batch job behind one button. It rereads every
message on every rebuild, its overview depends on whether the user distilled
notes, and one failure loses the whole build. This design replaces the batch
with a pyramid: small immutable assets built once per conversation, and
project-level documents regenerated fresh from the whole span.

## The core principle

**Prose rots when it accumulates. Facts do not.**

- A model that edits its own previous summary appends corrections, hedges
  ("but no longer…"), and overweights recent work. The output drifts.
- A model that reads dated, immutable facts from the whole project span and
  writes one snapshot in one pass produces clean prose every time.

The proof is in the current pipeline: `intent.md` is the strongest document
because it already follows this shape — select immutable quotes, then
synthesize once from all of them. `overview.md` is the weakest because it
summarizes summaries (notes), twice removed from the source.

Two hard rules follow:

1. **Leaves accumulate.** A finished conversation is extracted once and the
   result is cached forever. Extraction produces typed facts, not summaries.
2. **Documents never update. They regenerate.** Every project document is a
   pure function of all current leaves. A synthesis pass never reads the
   previous version of its own output.

## The pyramid

```text
layer 2   deep intent · environment · status · overview      (regenerated docs)
             ▲              ▲            ▲         ▲
layer 1   intent quotes · env facts · problems · abstract    (per-conversation leaf, cached)
             ▲              ▲            ▲         ▲
layer 0   raw transcript (immutable once the conversation settles)
```

### Layer 0 — raw transcripts

Unchanged. The cached conversation JSON is the source of truth. Its existing
`memoryHash` identifies a conversation version.

### Layer 1 — the leaf: one extraction per conversation

One background job per settled conversation produces one leaf file. The leaf
is JSON, small, dated, and typed. It contains four lanes, each extracted from
the transcript slice that carries that information:

| Lane | Reads | Produces |
| --- | --- | --- |
| `intent` | user messages + the assistant message before each | selected quotes with kind, confidence, reason (same classifier as today, minus the overview dependency) |
| `environment` | tool calls, commands, and command outputs | dated facts: setup steps, commands, services, paths, tooling, auth methods, cautions |
| `problems` | failure/retry loops, abort markers, final states | what broke, what was resolved, what stayed open |
| `abstract` | first and last user/assistant messages | 2–3 lines: what was attempted, what came out |

Leaf shape:

```json
{
  "key": "<session key>",
  "memoryHash": "<version this leaf was built from>",
  "builtAt": 0,
  "span": { "firstTs": "...", "lastTs": "..." },
  "abstract": "...",
  "intent": [{ "messageIndex": 12, "kind": "principle", "confidence": 0.9,
               "reason": "...", "user": "verbatim quote", "assistantBefore": "clipped" }],
  "environment": [{ "ts": "...", "type": "command", "fact": "..." }],
  "problems": [{ "ts": "...", "state": "open|resolved", "fact": "..." }]
}
```

Rules:

- Leaves live under `~/.cache/aiconvo/memory-leaves/<session-key>.json`.
- Leaves are keyed by **conversation, not project**. Project folds regroup
  conversations; the leaves follow without any rebuild.
- Extraction context is minimal and stable: project name, cwd, title, dates.
  No generated document is ever an extraction input, so a leaf never needs a
  rebuild when documents change.
- A leaf is stale only when `memoryHash` moved (the conversation grew). Then
  the leaf is re-extracted whole. Old, settled conversations never re-run.
- One conversation = one model call (all four lanes in one strict-JSON
  response). Measured cost: ~10–40k input tokens per conversation.
- Notes are **out of the memory path**. They remain a human-readable artifact
  built on demand, but no document depends on their existence.

### Layer 2 — documents: fresh full-span synthesis

Four documents, same files and same on-disk locations as today
(`~/notes/aiconvo/projects/<slug>/`). Each is one synthesis pass over one
lane, across all leaves of the project, ordered by date:

| Document | Input | Synthesis rule |
| --- | --- | --- |
| `intent.md` | all `intent` quotes | today's synthesis prompt, unchanged: keep tensions, ignore implementation. Verbatim quotes appended as evidence |
| `environment.md` | all `environment` facts | newest evidence wins; unresolved conflicts go to cautions; never output secret values |
| `status.md` | all `problems` facts + the newest abstracts | snapshot of open items and recent focus; resolved items disappear |
| `overview.md` | all `abstract` lines on the full timeline | purpose, vision, outcomes, principles, non-goals — written from the whole arc, not from recent work |

Rules:

- A synthesis pass reads facts and quotes only — never a previous document.
- All passes fit in one call on normal projects (measured: 20–80k tokens).
  When a project exceeds the budget, keep the existing map-reduce
  (partials + merge), and cap `intent` input by confidence before splitting.
- Epic candidate discovery moves into the overview pass (it already reads the
  full timeline of abstracts, which is what candidate discovery needs).

## Triggers: no buttons

The pyramid maintains itself. All jobs appear in the jobs drawer.

1. **Settle → extract.** A conversation with no file change for ~10 minutes
   (and not currently open in an active agent) queues a leaf extraction.
   Concurrency 2. Failures retry with backoff and affect only that leaf.
2. **Leaves changed → regenerate, debounced.** When one or more leaves of a
   project changed, queue a document regeneration for that project, debounced
   (~30 minutes, and immediately when the user opens the project view or
   starts a conversation there). Regeneration skips lanes whose input set is
   unchanged — each document stores the hash of its input leaf set.
3. **Backfill, once.** Old projects run a resumable queue over all sessions
   without a current leaf, oldest first, low concurrency, pausable. Documents
   regenerate once at the end, then follow rule 2. Interrupting the backfill
   loses nothing: finished leaves stay.

Freshness becomes exact and cheap:

- leaf fresh ⇔ `leaf.memoryHash == entry.memoryHash`
- document fresh ⇔ `doc.inputHash == hash(sorted leaf hashes of its lane)`

## Cost model (measured on real projects, 2026-08)

- Extraction: ~0.8k tokens per user message → 10–40k per conversation, once.
- Regeneration: 20–80k tokens per document set on normal projects.
- The old pipeline reclassified everything each build: aiconvo ~487k tokens
  per press; a 249-session project ~4.8M tokens per press. Under the pyramid
  the same press costs one regeneration, and daily upkeep is a trickle of
  per-conversation extractions.
- Target users hold subscriptions: the binding constraints are rate limits
  and latency, not token price. Small spread-out jobs fit; giant batches do
  not.

## Trust interaction

Regenerated documents are new machine text: any vouch on them goes stale, as
the trust model already requires (design/24). Verbatim intent quotes keep
their human origin visible. The human-written `intent.md` seed from project
creation is preserved as a pinned, vouched preamble section that synthesis
includes verbatim and never rewrites.

## Migration

1. Keep the four document files and their paths; readers (project view,
   conversation launcher, briefings) do not change.
2. Seed leaves from the existing `inputs.json` snapshots where present: the
   saved `selectedIntentMessages` become `intent` lanes without any model
   call. Other lanes backfill lazily.
3. The "build project memory" button becomes "regenerate now" during the
   transition, and disappears once triggers are proven.
4. `project-distill` (notes batch) stays available but leaves the critical
   path; the launcher checkbox "read all current notes" is unaffected.
5. Delete the whole-project classification step (`classifyProjectIntent` over
   all messages) after the backfill path ships.

## Edge cases

- **Empty or tiny project:** documents regenerate from whatever leaves exist;
  one conversation is enough for a first snapshot.
- **Huge conversation:** the extractor clips per message exactly as today
  (user 12k chars, assistant-before 6k) and splits into groups when needed;
  the leaf merges the groups' selections.
- **Model returns bad JSON:** the leaf job fails alone and retries; documents
  keep their last good version, labeled stale.
- **Secrets:** the environment lane keeps the existing rule — methods,
  variable names, and locations only; never values.
- **Folds and renames:** leaves are project-independent; regeneration groups
  leaves by the current fold mapping at synthesis time.

## API sketch

```text
GET  /api/memory/leaf?id=<key>          → one leaf (debug/inspection)
GET  /api/project/memory?name=…         → document manifest + per-lane freshness
POST /api/project/memory/regenerate     → { project } queue regeneration now
POST /api/memory/backfill               → { project } start/resume leaf backfill
```

Job types: `memory-extract` (one conversation), `memory-docs` (one project),
`memory-backfill` (one project, resumable). The existing `project-memory` job
type is retired after migration.
