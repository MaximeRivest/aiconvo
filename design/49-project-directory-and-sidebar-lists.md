# 49 — Projects directory, quiet rail counts, complete scrolling lists

Scope and Inbox organization are subsequently unified in [design/50](50-workspace-scope-and-inbox.md).

## Requests

- Expanded project timelines must not paint beneath or across the sidebar.
- Agents/Activity rail counts are opt-in rather than always shown.
- A Projects rail entry, above Chats, offers navigation without the Gantt.
- Sidebar lists must not silently stop at eight items.

## Projects

`sidebar-projects.js` builds the directory from the current conversation index,
registered projects and the existing project memory catalog. Empty registered
projects appear too. Folded project names use the existing canonical mapping;
loose conversations and hidden fan-out storage do not become project entries.
The server catalog's root path takes priority over a conversation's subfolder.

The panel includes a search field and these sorts:

- Recent activity (default): latest conversation or recorded file activity;
  creation time is a fallback for empty projects.
- Name (display title, then canonical name).
- Conversation count (indexed, visible conversation records).
- Folder date and disk size: existing `/api/projects/stats` data, requested
  only for those sorts, using the existing server-side disk-size cache.

Unknown measurements go last and are labelled unavailable, never displayed as
zero. The UI remains usable while measurements run; failures offer Retry.
Requests over 500 paths are batched to respect the endpoint's bound. Repainting
the list does not request measurements again. The sort is remembered locally;
search and scroll-page depth are transient. Search focus/caret survive updates.

Clicking a project opens its usual overview, retaining the directory alongside
it. Selecting the Projects rail entry alone leaves the main page untouched.
There is no new Gantt button; Home remains the whole-system timeline route.

## Counts

Appearance → **Show counts on Agents and Activity icons** is off by default.
Off uses quiet activity dots; on shows detected agent process counts and running
background-job counts. Chats retains its unread-reply count in either mode.
The preference lives in the browser's existing `agentSections` state.

## Lists

Recent conversations and read replies lose their old 8/15-row caps. File
selection filters/deduplicates all retained observations before rendering,
rather than taking eight. Projects use the same paging mechanism.

Render 100 rows at a time; nearing the end loads the next 100. A Show more
button is also available for keyboard/touch access, with the remaining count.
There is no fixed final display cutoff. Loaded depth and scroll position survive
live repaints; changing source/scope/search resets the relevant list to its top.
Folded sections cannot accidentally trigger scroll loading.

This is a display change, not a new unlimited file-history store. The retention
policy from design/47 remains: 100 paths per project/source, capped at 3,000 per
source across projects. Previously discarded human history cannot be recovered
by removing a UI cutoff. All *retained* matching records can now be reached.

## Expanded Gantt

The fixed chart uses the content pane's bounds: top 0, left at the sidebar edge
(or the 56px rail when folded). Top-bar/phone mode retains its original header
inset. Zen mode has no sidebar inset. The sidebar and chart no longer compete
for the same pixels or cover each other's controls.

## Tests

`test/sidebar-projects.test.js` covers directory facts, search/sorting, known vs
unknown measurements, actual project navigation, chart bounds at desktop,
folded and phone sizes, count defaults/persistence, lazy disk measurements, and
205-item chat/read/file lists plus 206 projects. Both scroll loading and the
Show more fallback reach the last row. Screenshots:
`/tmp/projects-gantt-layout.png`, `/tmp/projects-directory.png`.
