# aiconvo

Installed as a system app:

- The server runs as a systemd user service: `systemctl --user status aiconvo`.
- A tray icon sits in the top-right panel (via `yad`). Left click opens the app in a Chromium app window (no tabs, no URL bar). Right click gives Open / Rescan / Restart / Quit. It autostarts at login (`~/.config/autostart/aiconvo-tray.desktop`).
- "aiconvo" also appears in the app launcher. The launcher uses `open.sh`: it starts the server if needed, focuses an existing window, or opens Chromium `--app`.

Browse, search, and export all Claude Code and pi conversations on this computer.

## Start

```bash
node server.js
```

Then open <http://localhost:7433>.

To use it from a tablet on the same local network, set `AICONVO_LAN=1` (the user service already does). The laptop still opens terminals and agent windows. The tablet only needs the printed LAN URL with `?token=…`. The token is stored in `~/.cache/aiconvo/lan-token`. After the first open, a cookie keeps the tablet signed in. On the e-paper tablet, pick the **e-ink** theme.

For a tablet icon, install the Android APK: `android/app/build/outputs/apk/debug/app-debug.apk`. The app opens the laptop UI full screen. On first launch, enter the laptop address and token `4148`. Terminals still start on the laptop. Rebuild with `cd android && ./gradlew assembleDebug`.

## What it does

- Scans three sources: `~/.claude/projects`, `~/.pi/agent/sessions`, and `~/.pi/remote/sessions` (subagent transcripts are skipped). Add more folders in the `SOURCES` map in `server.js`.
- Keeps only user and assistant text. Tool calls, tool results, and slash-command noise are removed.
- Watches the folder. New and changed conversations appear automatically (UI refreshes every 30 s).
- Caches the index in `~/.cache/aiconvo/`. A restart re-indexes only changed files.
- Distills one conversation into a problem tree and a reusable note.
- Groups selected conversations into an epic with a chronological, cross-session narrative.

## UI

- The conversation panel is a Gantt timeline. Four layouts: horizontal strip at the bottom, vertical column on the left, full-screen project swimlanes, or hidden. Pick a layout with the timeline icons, or press **g** to cycle. The choice is saved.
- Drag the handle above the bottom Gantt tray to make it larger or smaller. Its height is saved. Double-click the handle to reset it.
- The bottom and full-screen layouts have a row toggle. **rows: project** is the default and groups work by project. **rows: compact** restores the original shared-lane view, while project colors remain. Project groups sort by their most recent message. Overlapping conversations use separate tracks. The chart renders only the visible time window for fast scrolling and zooming.
- Use the project selector in the Gantt toolbar to show one project or repository. This filter also applies to notes through their source conversations. Click a full-screen conversation to return to the bottom layout and open it.
- Click a project label on the left of the Gantt to open a project overview. It shows memory health, workstreams/epics, recent conversations, and a launcher for a new conversation in that project root. **update all notes** distills every conversation without a note and re-distills every stale note, with two model jobs at a time. **build project memory** classifies every user message for durable intent, keeps the preceding assistant response as context, and writes a high-level overview, deep intent note, safe environment guide, and current todo/focus note. It also proposes project-wide epic candidates for review and one-click building. Secret values never enter the environment document. The launcher remembers the selected agent per project. Its briefing lists project memory first, then chosen epics, fresh note paths, and selected evidence. When **read all current notes** is selected, the kickoff tells the new agent to read every listed note. The new session file appears in the list after the first message.
- Open **diffs** in a conversation header to enter the focused file Gantt for that conversation. The left tree contains only files touched there. Each selected file shows only that conversation's keyframes across the conversation start-to-end span, using the state before its first file change and after its last change. As you move either keyframe, the tree marks every file changed in that interval and shows `−N +N` lines; its header shows interval totals. **jump to latest changes** selects the latest changed file and its latest edit burst. The complete side-by-side file view and line history remain available. No unrelated project edits or times enter this conversation view.
- Open **file Gantt** in a project overview to weave mined AI edits and recognized shell mutations with Git history. Files are rows and time runs left-to-right. AI edits are squares, commits are diamonds, working-tree changes use a right-edge bar, and inferred AI-to-commit links show confidence. Pairing uses file path, content overlap, commit timing, and branch membership. Failed tool calls never pair. Click any mark for its tool-call diff, conversation, commit patch, branch, and provenance.
- Click or touch a file name in the file Gantt to enter a focused file workspace. A navigable repository tree stays on the left. One Gantt for only that file stays above the complete side-by-side content. Click the track, click a time mark, or directly drag either keyframe diamond with mouse, pen, or touch. The hollow/dashed old marker and filled/solid new marker remain distinct in binary e-ink mode. Long lines wrap inside their own side. Unchanged lines use the full width. Changed rows split left/right into removed and added text. If the two keyframes have no line changes, the file is one view. **show lines** draws row separators; they stay off by default. A small built-in highlighter decorates code and Markdown in place, without reflow, so the change grid stays aligned. Changed lines also use `−`/`+`, border shapes, strike-through, bold, and underline instead of color alone. Moving to another tree file keeps both times. Select a line to unfold matching interval changes below it, newest first. Select a change to open its conversation at that edit, or its Git commit. Git/current snapshots are exact; reconstructed AI snapshots show their replay method and skipped events (`design/19-whole-file-time-compare.md`).
- The file Gantt keeps attempted AI edits, successful tool results, inferred commit links, and Git facts separate. Low-confidence time-and-branch-only links remain clearly labeled. Deep link: `#project=<name>&files`.
- Each file row in the older edit-list view has a **blame** action. Blame replays recorded edits and shows which agent conversation last touched each reconstructed line. This remains agent-attributed blame, not Git blame. Deep link: `#blame=<path>`.
- Continuous zoom with three presets: **hrs**, **days**, **wks**. Zoom with **Ctrl+wheel** (anchored at the pointer), **+** / **-** (anchored at the viewport center), or **0** to reset. Grid ticks follow the zoom: hours, days, or weeks. Mark labels hide at low zoom; hover still shows details.
- Jump with the toolbar buttons or keys: **n** to now, **b** to the oldest session, **t** to a date field. A view pinned at now stays pinned across live updates.
- On the chart the wheel scrolls along the time axis. Shift+wheel scrolls the cross axis.
- The ergonomics are specified in `design/07-gantt-ergonomics.md`.
- Each bar shows session duration; message density sets the violin thickness.
- Mark colors identify projects, not Claude or Pi. The project comes from the working directory.
- The lane layout tries to keep conversations from the same project together.
- Four or more short conversations from one project within 15 minutes collapse into one wider mark.
- Labels use compact titles with at most 10 characters. Hover to see the full title and details.
- Enable **include tool calls in timeline density** in Filters to include tool calls.
- Click a mark to open it. Shift-click or Ctrl-click marks to select conversations.
- **Drag on the timeline** to select every conversation in the rectangle. Shift-drag adds to the selection.
- The notes tab uses the same timeline: notes are green bars that span their source conversation. Each mark shows a compact title from the note's filename slug (date dropped, at most 10 characters); hover shows the full name.
- **Type in the search box** to filter by title and directory.
- **Press Enter** to run a full-text search across all messages. Matches show snippets and are highlighted in the conversation view.
- **Source dropdown** filters by agent (claude, pi, pi-remote).
- **Directory dropdown** filters by working directory.
- **"Export selected (.md)"** downloads the chosen conversations as one simplified markdown file.
- Every copy and export starts with a provenance block: the session id, the full path of the original transcript, the extracted JSON, the distilled note, the epics it belongs to, and an aiconvo link. A receiving agent can follow these paths to learn more.
- **Select conversations + "Build evidence"** prepares and caches evidence without creating an epic.
- Open one conversation and select **evidence** to view existing evidence. It builds once only when none exists.
- Select **rebuild evidence** inside the evidence view to replace it explicitly.
- **Select two or more conversations + "Build epic"** creates a timeline for the larger problem.
- **"Epics"** lists saved timelines. Rebuild an epic to add selected conversations or include new work.
- Focus a conversation to get direct links between its conversation, note, evidence, and related epics.
- The filters popover has a **theme** select: auto, dark, light, grayscale, or e-ink. Grayscale removes hue but keeps grey tones (`design/12-grayscale-theme.md`). The e-ink theme is binary black/white: no greys, no opacity, no animation (`design/11-eink-theme.md`).
- On e-ink, Gantt states are drawn without color: hatched fills for selected marks, a dashed frame for the open conversation, a static dot for live sessions. The transcript is paginated instead of scrolled: **[** / **]** or PageUp / PageDown turn pages, and the last page follows new messages.
- These links appear in the fixed content header. They do not replace or change the Gantt timeline.
- Open an epic and select **evidence** to inspect every note or evidence card used for that build.
- The evidence view marks distilled notes, cached cards, new cards, missing conversations, and possibly outdated notes.
- The **tree** tab in the artifact switcher shows the conversation as a message tree. The root is at the top and time flows down. Each box is one user message or one merged assistant turn, titled by its first sentence. Solid boxes and green edges mark the current branch (the path a resume continues); dashed marks other branches. Branching is a context-engineering strategy, so other branches are first-class history, not failures: the transcript folds them into "⑂ other branch" blocks at their chronological position, and exports label them "(other branch)". Both formats store real trees: pi entries have `id`/`parentId`, Claude Code entries have `uuid`/`parentUuid`.
- Select a box to get up to four actions. **read from here** opens the transcript at that message and highlights it. **continue from here** (pi only) continues the SAME conversation after that message: it appends one no-op `label` entry parented at that node — the same anchor pi's own branch flow writes — so the next Alacritty resume picks up there and the tree grows a new in-file branch. **edit this message** (pi user messages only) forks into a new session that stops just before that message; open that session in Alacritty to edit and resend. **fork (copy)** continues from that message in a NEW session file; the original does not change.
- pi forks run through pi itself: a short-lived `pi --mode rpc` process with the `aiconvo-bridge.ts` extension performs the fork (`SessionManager.createBranchedSession`), so the new `<timestamp>_<uuid>.jsonl` with its `parentSession` pointer is written by pi's own runtime, not by hand. Claude has no arbitrary-node fork API, so aiconvo copies the root→node chain into a new `<uuid>.jsonl` (session id rewritten, temp file + atomic rename; logic in `sessionfork.js`, tests in `test/`).
- Branch vs fork: a branch stays in one conversation with many paths (what the pi TUI does natively). A fork is a copy that continues in a new conversation. Claude Code stores real in-file trees too (edits and /rewind create them), but its CLI always continues at the last real message and ignores external anchors — verified empirically — so Claude conversations can only fork. Branching refuses if a pi process still holds that session file. Quit that Alacritty window first. Fork and branch operations on one session file are serialized by a per-file lock.
- The tree shows the whole **fork family**, not just one file. Sessions that share their first entry id (all forks copy the root chain) or that point at each other via pi's `parentSession` merge into one tree. Boxes that live in a linked fork are magenta with an **↳ fork** tag; their read and fork actions target that session. This covers forks made in aiconvo, forks made in the pi TUI, and Claude fork-session files.
- Each transcript message has a small **copy md** button. It copies the complete original message text, including hidden content and Markdown syntax.
- Long messages in the transcript collapse to an abstract-sized preview (about 5 lines). Click **… show more** to expand, **▴ show less** to collapse. Messages with a search hit stay expanded.
- The header ticker shows the latest session update. Click it to open that conversation.
- **"● N"** in the header lists running, writing, and recent agents (key **a**), each with its working directory. Running means a live `pi` or `claude` process. Writing means the session file changed in the last 5 minutes. Click a row to open the conversation.
- Opening a conversation lands at the bottom, at the newest messages.
- **"Jobs"** shows running and recent distillation and epic jobs.
- **"settings"** opens the memory-model panel. Pick any model from your Pi catalog. Signed-in providers are listed first. **use pi default** follows `~/.pi/agent/settings.json`.
- Background jobs continue when you open another conversation. You can start multiple jobs in parallel.
- Every Pi or Claude conversation has **continue in alacritty** and an **open & send** box. aiconvo starts the native CLI in Alacritty through a thin PTY bridge. The window still looks like a normal Alacritty session. The web UI can read the screen and send keys. If Claude asks “resume from summary?”, the box shows that choice. Send pastes images (Ctrl+V) and text (bracketed paste), then Enter.
- **start conversation** on a project overview does the same for a new session: it writes the briefing, then opens Alacritty with the kickoff as the first prompt.

## Epics

An epic uses distilled notes when they exist. It summarizes other selected conversations once and caches that evidence.
Large conversations are split into large sections near 80% of the model context limit. Section evidence is cached and merged.
If the provider rejects an estimated section, the app splits only that section again and retries it.
Very large epic evidence sets use chronological timeline drafts before the final merge.
It then creates chronological phases, outcomes, the current state, and open questions.

- The epic markdown lists full file paths for each source conversation: the original transcript (raw JSONL), the extracted conversation (JSON), the distilled note, and an aiconvo link. A model that reads the epic can follow these paths to learn more.
- Epic metadata is stored in `~/.cache/aiconvo/epics.json`.
- Epic markdown is stored in `~/notes/aiconvo/epics/`.
- The exact evidence inputs for each new epic build are stored in `~/.cache/aiconvo/epic-inputs/`.
- Rebuilding keeps the same epic file and includes all previous conversations.

## Config

- `PORT=8000 node server.js` changes the port (default 7433).
- `POST /api/rescan` forces a full rescan.
- Open **settings** (key `,`) to pick the Pi model used for notes, evidence, epics, titles, and project memory. The list comes from `pi --list-models`. The choice is stored in `~/.config/aiconvo/settings.json`. The **claude-code** provider uses your local Claude Code login and the `claude-code-fable-5` Pi extension.
