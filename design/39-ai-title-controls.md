# AI title controls

## Why

Naming is the one place aiconvo talks to a model without being asked. A new
conversation gets a timeline title, a second user message triggers a retitle, a
new project gets named, a doc commit gets its message amended — all on timers,
all provider calls. There is currently no way to stop them. That matters for
anyone on a metered key, on a slow or local provider, or working on material
they would rather not send anywhere on a background timer.

`aiTitles` is that off switch. Default `true`, so nothing changes unless it is
turned off.

## Delivered flow

`aiTitles: false` suppresses **standalone naming calls only**: conversation and
timeline titles, automatic retitles, project and epic retitles, automatic
project labels, and doc commit-title amendments. It does not touch distillation,
memory, review, or the conversation engine — those keep working and keep their
own headings, abstracts and structural sections.

Existing titles are kept. Nothing is renamed or re-derived on the way down.

Distillation still produces an abstract when titles are off: the same single
call asks for `{"abstract"}` instead of `{"title","abstract"}`, so a note is
never left bare. Its heading falls back to the source title.

Because that fallback slug is no longer unique, note filenames gain a
session-derived suffix (`2026-09-12-some-slug-<16 hex>.md`) so two sessions
distilled on the same day cannot overwrite each other.

## Where the switch is checked

Four places, because a naming call has four chances to leak a title:

1. **Entry point** — `retitleProject`, `retitleEpic`, `retitleConversation`
   throw immediately.
2. **Timer** — `scheduleTimelineTitles`, `scheduleAutoRetitle`,
   `maybeAutoProjectTitle`, `scheduleDocCommitTitle` never arm.
3. **Shared transport** — `runPi` rejects the five naming prompts before it
   spawns anything, so a path added later cannot bypass the switch by accident.
4. **Before publication** — checked again after the model returns.

A request already in flight cannot be recalled. The fourth check is what stops
its answer from being applied.

## Revocation during publication

Turning the switch off mid-write must not half-publish. `writeFileAtomic` takes
an optional `guard`; when present it re-checks permission and uses `renameSync`,
so there is no `await` between the check and the replacement.

The timeline batch and `note-publication.js` use this. Note publication writes
to a temp file, re-checks permission, then renders the final heading and renames
in one synchronous step — a revocation during `mkdir`, during the write, or at
the guard all produce the source-titled note under the deterministic filename,
with no stray file left behind.

These are separate atomic files, not one transaction. A later guard failure
keeps earlier replacements; it just cannot publish another file or the in-memory
title. `runPi` tracks guard failures separately from transport failures so a
revoked-but-successful call is never counted as a provider error or retried.

## Coverage

- `test/memory-titles.test.js` — every naming entry point, timer and prompt is
  fenced; title-off distillation asks for an abstract only and keeps the
  existing title; revoking during an outstanding retitle blocks publication.
- `test/memory-timeline-acceptance.test.js` — Given/When/Then over the real
  atomic-write path: permission, manual-title and source-title changes at each
  awaited I/O boundary (read, cache temp file, titles temp file) all fence every
  subsequent replacement and broadcast.
- `test/note-publication.test.js` — revocation during mkdir, write and guard.
