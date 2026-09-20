# 51 — Work first, projects second

Supersedes the hierarchy, Agents scope and Jobs placement in design/50.

The everyday cycle is: remember past work on Home, start or continue several
conversations, check returned replies, and return to deeper file/review work.
The folder hierarchy supports this cycle; it does not organize attention.

## Rail

- Primary: Home (timeline), Inbox (returned/interrupted), Agents (working),
  Recent (file activity). All cover all visible projects on this machine.
- Secondary, below a separator: project picker, Projects, Chats, Files.
  Choosing a named project opens its overview. The selection only filters
  Chats and Files, and remains the target of New here.
- Machine switching and Settings sit at the foot. Folding retains the rail.
- A fresh browser starts with Inbox; existing saved panel choices survive.
- Recent reuses the existing human/agent/both file selection and retention
  rules; opening a global view does not change the chosen project scope.

Agents includes web runs, terminal work, delegated work and busy untracked
processes across projects. Idle/unknown-busy processes are in a closed-by-default
fold. Project browsing cannot hide an agent. Counts, when enabled, retain their
meaning as process counts; the default working dot signals actual activity.

Inbox keeps Unread and Read. Interrupted runs appear visibly above unread
replies; recovery options remain a separate fold. Routine background jobs live
under Settings → background jobs (`j`), update while that page is open, and do
not contribute attention badges or unsolicited job-event completion/error
toasts. Agent-run success/error toasts remain clickable. Direct action feedback
and the existing sound/phone notification preferences are unchanged.

## Check-in and return

Opening a conversation through Inbox, Agents or an agent-run alert remembers
the current navigation entry. Repeated check-ins and inspecting files along
the way keep the original return target until that page is reached again.
Return to work traverses the existing browser history, so existing
scroll, editor and project-scope restoration rules still apply; this is not a
second router. The return id survives refresh in sessionStorage, is discarded
if its entry leaves the stack, and clears when that page is reached again.
The button is in the desktop panel; the top-bar/phone layout retains Back.

## Home

The old `body.home #ganttBar { display: none !important }` hid the toolbar and
all its children, including sorting. Restore it, add a visible Filters button,
and wrap controls at narrower desktop widths. Preserve the existing sorting
and zoom defaults. Leave 16 pixels around the desktop chart rather than placing
it flush against the window. Phone layouts keep their existing compact view.
This trades a little chart area for visible controls and clearer boundaries.

## Verification

- `test/workflow-navigation.test.js`: actual toolbar visibility/bounds at
  multiple widths, filter opening, global rail order, quiet background jobs,
  clickable agent alerts, visible interruptions, busy versus idle processes,
  folded access, file → agent → Return after reload, e-ink and phone bounds.
- `test/workspace-scope-app.test.js`: global Agents and Recent from a specific
  project, independent scoped Files, global Inbox and scope-aware history.
- Sidebar, directory, navigation and recovery regression tests remain in use.

No server restart or transcript migration is required; reload the interface.
