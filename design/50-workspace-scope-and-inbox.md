# 50 — Explicit project browsing and a machine-wide Inbox

## The distinction

The old Chats panel combined machine-wide unread/read replies with a recent
list that alone obeyed a project/all switch. Its project header was a link,
not a selector, and Files could inherit scope from a stale open conversation.
The badge and the visible list consequently meant different things.

Three independent choices now have one meaning each:

1. Machine = workspace.
2. Project scope = All projects, one named project, or No project.
3. Section = Projects, Chats, Files, Agents, Inbox.

| Section | Scope / contents |
|---|---|
| Projects | Directory of all visible projects on this machine |
| Chats | Selected scope; pinned and recent conversations |
| Files | Selected scope; human/agents/both remains independent |
| Agents | Selected scope; work associated with that project's conversations |
| Inbox | All visible projects on this machine; Unread, Read, Jobs tabs |

Home remains the whole-system timeline. Scope is a browsing filter, **not an
access-control boundary**; server permissions still decide which records are
available. Selecting scope never calls the conversation-assignment endpoint.

## Selector and transitions

`sideProject` is an always-visible dropdown beside Home. It offers All
projects, No project, and a searchable project directory. Clicking, not
hovering, selects. The Projects directory and dropdown use the same scope:
choosing a named project opens its overview; No project opens the existing
loose collection. All broadens the browser without closing the current page.
The obsolete per-section project/all switches are removed.

`project-scope.js` holds normalization/membership/navigation rules. Selection
is persisted in `agentSections.projectScope`; absent legacy state defaults to
All. It is no longer derived from `currentProjectName()` or the last chat.

- Ordinary navigation from a specific project to a chat/file in another
  adopts the destination project. Ordinary All-project browsing stays All.
- Opening an Inbox conversation selects that conversation's project, even
  from All. Inbox itself stays global and labels each reply's project.
- Files use explicit recorded project attribution or the longest known root
  path, not the last conversation. Unassigned files use No project.
- Drafts adopt their actual folder's project when known; loose drafts never
  secretly inherit the previous conversation's project.
- New here follows the selected scope. In a matching conversation it uses
  the existing sibling workflow; elsewhere it uses the project's reviewed
  start workflow. All/No project offer a plain new conversation.
- Each navigation entry stores `projectScope`. Reload and Back/Forward restore
  that exact scope, including All, instead of re-inferring it from the page.
  Legacy entries without scope use the normal destination rules.

Project/area fetches have a generation guard: an old project response cannot
paint over a newer file, conversation, or another project selection.

## Inbox and work

Activity becomes Inbox. Unread and Read no longer appear in Chats; reading a
reply also no longer removes that chat from the project browser. Pins are
filtered in Chats but never remove an unread reply from Inbox.

Read means an actual read receipt, not completed/resolved work and not the
first-use guard that suppresses ancient unread items. Background job history
lives in Jobs; interrupted-run recovery stays with Unread. `a` focuses Inbox
Unread in side layout; `j` opens Jobs. The top-bar tray remains an aggregate,
with explicit all-project Inbox labels and a scope selector for browsing.

Agents filters processes, terminal/web activity and delegated work by the
associated project. Unknown processes are only visible in All, not guessed to
be No project. A live worker whose parent belongs elsewhere can appear in its
own project's Agents view. Global Inbox/read state does not suppress a process
from the separate Agents panel.

Global unread indicators move from Chats to Inbox. The existing quiet-count
preference remains: dots by default, optional numbers for scoped agent processes
and machine-wide unread replies. Recovery/jobs can signal attention even when
there is no numeric unread count.

## Verification

- `test/project-scope.test.js`: All vs No project, folds, cross-project
  navigation and file attribution independent of any previous chat.
- `test/navigation.test.js`: per-entry scope persistence, traversal, reload.
- `test/workspace-scope-app.test.js`: real selector and project/file/chat
  navigation across two projects and the loose collection; Inbox globality,
  read history, pins, scoped agents/badges, Back/Forward, reload, and a forced
  late project response. It asserts no assignment PUT or transcript rewrite.
- Existing sidebar/project-directory tests now exercise the new organization.

Screenshots: `/tmp/workspace-inbox.png`, `/tmp/workspace-files.png`,
`/tmp/workspace-project-picker.png`.
