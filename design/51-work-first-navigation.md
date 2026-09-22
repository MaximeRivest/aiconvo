# 51 — Work first, projects second

Supersedes the hierarchy, Agents scope and Jobs placement in design/50.

The everyday cycle is: remember past work on Gantt, start or continue several
conversations, check returned replies, and return to deeper file/review work.
The folder hierarchy supports this cycle; it does not organize attention.

## Panel navigation

- There is no left icon rail. The top row holds the machine picker, Gantt,
  then the project-memory button and picker. The panel is 288px wide, retaining
  its previous content width while giving the former rail's space to the main
  workspace. Chats no longer has a separate button; old saved Chats selections
  open Agents. Gantt retains its timeline route, not a new dashboard.
- A floating Files icon opens the right-hand file panel independently of the
  left panel. There is no right rail or reserved width when closed. Inside,
  All / Project switches between global and selected-project file activity;
  Project is unavailable until a project is selected on the left. The close
  button or Escape within the panel closes it and returns focus to the icon.
  Source filters, paging, file opening, forgetting activity, and live updates
  use the same data as before. Selection/open state is saved per browser.
  The composer and expanded timelines respect the open 288px panel. At
  701–1100px it overlays the workspace instead. Phones retain their layout.
- Project browsing lives
  at the top of the adjacent panel instead: the main project button opens its
  memory/overview page, and a separate small arrow opens the project picker.
  With All projects selected, the main button opens the searchable project
  picker. Browsing projects never replaces the agent sidebar.
  The selection filters Read or Files only when that section's own Project
  toggle is selected, and remains the target of New here. Back/Forward and New here share one row below the project control.
- Agents starts directly with its reply sections, without a repeated panel
  title or all-projects caption.
- The first footer control is the signed-in user's initials or picture,
  opening Settings → your profile. There is no separate gear, people stack,
  or Agents button in the footer. Other people and device links remain in
  Settings → people. Folding hides the panel and leaves a floating reopen
  button with an attention badge. The composer and expanded charts use
  the freed space. `a` still opens Agents directly.
- Every browser uses Agents as its left panel. The internal `inbox` id is
  retained; all old panel choices, including `projects`, migrate to it and
  the corrected preference is saved. Project scope, Read scope, file-panel
  choices and other preferences are preserved. Legacy file selections move
  to the right-hand file panel.
- Recent reuses the existing human/agent/both file selection and retention
  rules; opening a global view does not change the chosen project scope.

Agents includes web runs, terminal work, delegated work and busy untracked
processes across projects. Idle/unknown-busy processes are in a closed-by-default
fold. Project browsing cannot hide an agent. When the panel is hidden, its
reopen symbol changes while work runs; its attention dot is reserved for
unread/interrupted work.
Optional numbers count unread replies, not processes.

Agents shows Unread first and Read immediately below in one scrolling region,
with no tabs or collapsed reply sections. Read has a remembered All / Project
filter, independent of Files. Project uses the explicit selected workspace
project (including No project); it is unavailable until one is chosen. This
filter applies before Read pagination and does not affect unread replies,
interruptions, running agents, badges, or the timeline. Working is docked underneath, capped
at 42% of panel height with its own scrolling, so long read history cannot push
running work out of reach. Both scroll positions survive live repaints; Read
pagination uses the reply scroller. Running/interrupted conversations do not
also appear in Read. Interrupted runs appear visibly above unread replies;
recovery options remain a separate fold.

`a` opens/focuses Agents, unfolding the panel if necessary. Conversation rows
link their project names to the project overview, with the folder path in the
tooltip. These are real links (keyboard, modified click and link context menu
work), separate from the row's conversation action. Routine background jobs live
under Settings → background jobs (`j`), update while that page is open, and do
not contribute attention badges or unsolicited job-event completion/error
toasts. Agent-run success/error toasts remain clickable. Direct action feedback
and the existing sound/phone notification preferences are unchanged.

## Check-in and return

*Superseded 2026-09-22 (design/59): the "Return to work" button is gone;
Back does this job.*

Opening a conversation through Agents or an agent-run alert remembers
the current navigation entry. Repeated check-ins and inspecting files along
the way keep the original return target until that page is reached again.
Return to work traverses the existing browser history, so existing
scroll, editor and project-scope restoration rules still apply; this is not a
second router. The return id survives refresh in sessionStorage, is discarded
if its entry leaves the stack, and clears when that page is reached again.
The button is in the desktop panel; the top-bar/phone layout retains Back.

## Gantt

The toolbar contains only the four project sort buttons and the magnifying-glass
project search. Auxiliary timeline controls are no longer shown; existing sort
and zoom state and zoom keyboard/wheel shortcuts remain. The now marker has its
own second line in the axis header, just to the right of its line, so it cannot
collide with a date or time label. This costs 14 pixels of chart height rather
than hiding or truncating dates. Leave 16 pixels around the desktop chart rather
than placing it flush against the window. Phone layouts keep their compact view.

## Verification

- `test/workflow-navigation.test.js`: actual toolbar visibility/bounds at
  multiple widths, filter opening, global rail order, quiet background jobs,
  clickable agent alerts, visible interruptions, busy versus idle processes,
  folded access, file → agent → Return after reload, e-ink and phone bounds.
- `test/workspace-scope-app.test.js`: global Agents and Recent from a specific
  project, independent scoped Files, global Inbox and scope-aware history.
- Sidebar, directory, navigation and recovery regression tests remain in use.

Navigation changes only need an interface reload, with no transcript migration.
Profile-picture saving requires the matching server update; restart only after
active runs finish. Profile storage and permissions are described in design/46.
