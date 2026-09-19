# 47 — Recent files: human, agents, or both

## UI

The Files panel follows the shared project dropdown (All projects, a named
project, or No project; design/50). Its **human / agents / both** choice is
independent. Default: human. The choice lives in `aiconvo.agentSections.v1`
as `files:actor`, independent of `projectScope`, and survives reloads.

Rows show matching paths once each, newest activity first. The original
eight-row display cap is replaced by scroll loading in design/49. A short action (opened, saved, read, wrote, edited) accompanies the time;
"both" also names the latest actor. The tooltip carries the full path and
exact time. A click opens the live file; agent rows retain their originating
conversation as the return link.

## Facts, not guesses

- Human: a successfully mounted editor/file-history view, or a successful save
  in aiconvo. Automatic editor refreshes are not new human visits.
- Agent: named local read/write/edit/multiedit/notebook-edit calls that have a
  successful tool result. Empty successful results count; pending and failed
  calls do not. File edits made through the editor API with a recorded agent
  actor are also included. Runtime-generated notebook output is not human work.
- Only local Pi/Claude transcripts seed agent observations. Remote-only paths,
  URLs, arbitrary paths mentioned in prose, and guessed shell effects are not
  offered as local files. Shell commands that indirectly read or generate files
  are deliberately outside this first version; a success exit code alone is
  insufficient proof of which files changed.
- Actual tool-result timestamps are retained. Rescanning or copying a fork
  does not make an old action recent. Off-branch actions still happened.

## Store and filtering

`recent-files.js` is shared by the server and browser. The durable v2 record
at `~/notes/aiconvo/recent-files.json` stores one last observation **per actor
and path**, not one per path. This is essential: a newer agent edit cannot
replace the human visit when selecting human-only. Legacy rows lacking an
actor migrate as human, with their original times.

Filtering by source and project happens **before** path deduplication and
rendering pages. "Both" chooses the newest of the matching observations
for each path. A project can therefore still show older human visits even
when other projects have heavy agent activity.

Retention: 100 paths per project/source, with a safety cap of 3,000 paths per
source overall. Human activity cannot be evicted by agent activity. UI source
and scope choices are local; observations and dismissals are shared across
devices through the existing `/api/recent-files` endpoint and event stream.
The endpoint returns a full snapshot; live events carry only changed/removed
actor-path pairs, so each new tool call does not resend thousands of rows.

Forgetting a row removes the selected source(s), not the other source's visit.
A durable timestamp watermark stops replayed transcripts from resurrecting it;
new activity can bring it back. Opening A, then B, then A immediately updates
A's recency: the old one-minute same-file throttle is gone. Only persistence
and broadcasts are coalesced (1 second and 250ms respectively).

Index cache version 17 performs a one-time parse of existing transcripts to
populate agent recents. It does not change transcript files. All later updates
are incremental and reuse the normal indexing path. The browser refetches
recents when the event stream connects/reconnects.

## Verification

- `test/recent-files.test.js`: migration, separate actors, all filter
  combinations, sorting/deduplication, idempotent replay, source-aware durable
  forgetting, bounded retention, failed/pending/empty results, branch order.
- `test/side-panel.test.js`: real server + browser, successful empty tool
  results in transcripts, live updates, project/source combinations, opening
  agent-touched files, return context, preference persistence, rapid revisits,
  and durable dismissal across rescans. Screenshot: `/tmp/recent-files-both.png`.
- `test/document-format.test.js`: human versus agent editor saves.
