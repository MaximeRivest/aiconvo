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

## Install on a new machine (Ubuntu or Windows + WSL2)

On Windows, do everything below inside WSL2 (Ubuntu). Enable systemd in
WSL first if needed: add `[boot]\nsystemd=true` to `/etc/wsl.conf`, then
run `wsl --shutdown` and start WSL again.

```bash
git clone https://github.com/MaximeRivest/aiconvo.git
cd aiconvo
./setup.sh
```

The script checks Node 22+, installs a systemd user service, starts it,
and prints the next steps. There are no npm dependencies.

Then, on Windows, open <http://localhost:7433> in Chrome or Edge (WSL2
forwards localhost) and use the browser menu → **Install aiconvo**. The
PWA gets its own window, own icon, and a Start-menu entry — the same
app-like feel as the Chromium `--app` window on Ubuntu.

Shared GPU services (optional): in settings → semantic search, enable
the stage and point the URL at the GPU server. Keep the **namespace**
unique per user — it defaults to your username. Voice endpoints
(`KOKORO_URL`, `SPEECH_URL`, `REWRITE_URL`) default to the family GPU
server and can be overridden with environment variables in the service
unit.

To use it from a tablet on the same local network, set `AICONVO_LAN=1` (the user service already does). The laptop still opens terminals and agent windows. The tablet only needs the printed LAN URL with `?token=…`. The token is stored in `~/.cache/aiconvo/lan-token`. After the first open, a cookie keeps the tablet signed in. On the e-paper tablet, pick the **e-ink** theme.

Install the Android APK from `android/app/build/outputs/apk/debug/app-debug.apk`. It detects iFLYTEK hardware and keeps the wide binary e-ink UI. Phones use a separate touch layout: project cards and recent work replace the home Gantt, tabs move to the bottom, conversations use a fixed compose dock, and file diffs switch between full-screen file tree and stacked comparison. The native microphone writes live and final Parakeet transcripts directly into the compose box without opening the keyboard. On first launch, enter the laptop address and token `4148`. Terminals still start on the laptop. Rebuild with `cd android && ./gradlew assembleDebug`. See `design/23-phone-layout.md`.

## Delegated conversations

Select **pi-orchestrator** in the mode picker. The managed `delegate` tool starts a saved child conversation with an exact parent launch point. Children can delegate again. Delegation shows where it happens: each `delegate` call is a one-line card under its step group in the parent transcript (open it for the result, the brief, the records, and cancel); the runner's return is a quiet `↩` bar; a delegated conversation carries one `↰ delegated by` line at its top that leads back to the exact launch line; the tree shows delegated conversations as dashed nodes under the entry that launched them, recursively. Delegation does not change branch or fork rules.

Execution and parent review are separate. A returned result still needs checks. Pause prevents new descendants; cancellation requests stop the subtree without removing saved files. The ordinary response stop button stops only that response.

Records live in `~/.local/share/aiconvo/delegations`, not the cache. Web SDK sessions run in separate processes. On systemd, delegated supervisors use independent user scopes. Existing unmanaged processes remain untracked; the app does not guess their parents.

The delegation tools and the browser tools (`agent_browser`, `agent_browser_session`) are opt-in. A mode gets them only when its `tools` list names them: `pi-orchestrator` lists the delegation tools, `browser` lists the browser tools. Every other mode runs without them, so their guidance text stays out of its system prompt.

`extensions/prompt-capture.ts` (installed to `~/.pi/agent/extensions` by setup) records the system prompt twice per turn: `pending` as assembled before the turn, and `wire` as found in the real provider payload. `/sysprompt` shows the wire copy, `/sysprompt pending` and `/sysprompt diff` the rest. Copies land in `~/.pi/agent/cache/sysprompt/<session>-{pending,wire}.md`.

Aiconvo loads `extensions/delegation.ts` automatically. For the Pi terminal, load it explicitly with `pi -e /path/to/aiconvo/extensions/delegation.ts`. Terminal roots receive next-turn reminders; web roots receive tracked callbacks. Setup and update install the default mode only when missing, preserving personal mode files.

This update requires matching frontend and server code. Restart the server only after active web runs finish, then reload clients. The implementation, limits, and trade-offs are in [design/29-delegation.md](design/29-delegation.md).

## Records for agents: the `aiconvo` command and the Pi tools

Every conversation, distilled note, project memory document, epic and evidence card is queryable from any folder, by people and by agents:

```
aiconvo                                  where was I? (last session in this folder)
aiconvo search "session abort rpc" --since 30d [--project X]
aiconvo show <id> [--at 214 --context 3]  one conversation: outline, or a slice around a message
aiconvo conversations | notes | epics | projects [PROJECT]
aiconvo memory [PROJECT] [overview|intent|environment|status] [--area REL] | --epic ID
aiconvo note <id|file> · aiconvo epic <id> · aiconvo evidence <id> · aiconvo help
```

Answers are compact plain text made for a context window: short ids, dates, trust labels (`[unverified]` = no person reviewed the note), and the exact follow-up command. Output is capped (`--max`) and paged. `--json` prints the raw record. The same text is served by `GET /api/records/<op>` and by the Pi tools `aiconvo_search`, `aiconvo_show`, `aiconvo_memory`, `aiconvo_read`, `aiconvo_list` (`extensions/records.ts`, loaded automatically for web sessions and delegated workers; terminal: `pi -e /path/to/aiconvo/extensions/records.ts`). The Pi tools drop the running conversation's own hits from search.

Conversations started from a project get a short "Looking things up" section in their injected context that names these commands. Records are AI transcripts and AI-written notes: a map of what was said, not verified truth.

## Custom themes

User themes live in `~/.config/aiconvo/themes/<theme-id>.css`. The fastest
path: import your terminal or Hyprland (Omarchy) color scheme directly:

```bash
node themeimport.js          # auto-detects alacritty/kitty/ghostty/foot/pywal
```

Or copy `design/theme-template.css`, rename its selector to match the file
name, and refresh the app. Valid themes appear in the theme selector.

Validate a theme before use:

```bash
node test/theme-check.js ~/.config/aiconvo/themes/my-theme.css
```

The theme contract, tokens, modes, and metadata are in
`design/25-themes.md`. The importer and a ready-made prompt for coding
agents are in `design/26-theme-import.md`. `design/tokens.css` is the
built-in runtime source.

## What it does

- Scans three sources: `~/.claude/projects`, `~/.pi/agent/sessions`, and `~/.pi/remote/sessions` (subagent transcripts are skipped). Add more folders in the `SOURCES` map in `server.js`.
- Keeps only user and assistant text. Tool calls, tool results, and slash-command noise are removed.
- Watches the folder. New and changed conversations appear automatically (UI refreshes every 30 s).
- Caches the index in `~/.cache/aiconvo/`. A restart re-indexes only changed files.
- **Usage and cost dashboard.** Open Settings, then **usage and cost dashboard**. It deduplicates copied fork entries and groups input, output, cache, and reasoning usage by day, model, project, and billing type. Pi's stored cost is shown as an API-equivalent estimate, never as invoice data. Provider rules separate API, subscription, free, local, and unknown routes. Optional monthly fees support subscription-value comparisons. Pi pricing is primary; cached LiteLLM and Models.dev metadata provide fallback prices. The derived ledger lives at `~/.cache/aiconvo/usage.db`.
- Distills one conversation into a problem tree and a reusable note.
- Groups selected conversations into an epic with a chronological, cross-session narrative.
- **Trust / vouch.** Most notes, memory documents, and epics are AI-generated, so nothing generated is treated as verified truth. A **vouch** records one human assertion — “I checked this exact content at this time” — in an append-only ledger (`~/notes/aiconvo/vouches.jsonl`). Vouches are granular (whole file, note section, or selected lines) and anchor to exact line text: a moved line keeps its vouch, a changed line silently loses it, so staleness falls out for free. A **dispute** marks content as wrong. Trust never hides anything; it only labels content everywhere — in file views, note views, project trees, and agent briefings (`[vouched DATE]`, `[partly vouched]`, `changed since review`, `[disputed]`, `[unverified]`). See `design/24-trust-vouch.md`.
- **Editing.** Three levels of direct editing, all saved to the native files:
  - **Whole-file view** — the `edit file` button edits the current on-disk file in place. Saves are atomic and optimistic (a base hash refuses the write when the disk changed after the read). Writes stay inside indexed repositories or indexed conversation directories.
  - **Notes, epics, and project memory** — every markdown view under `~/notes/aiconvo` has `edit file`, and each selected section has its own `edit` that splices only that heading and body back into the file.
  - **Transcripts** — every message (user text, assistant text, tool input, tool result) has an `edit` button that rewrites the one entry in the native JSONL (`~/.claude/projects`, `~/.pi/agent/sessions`). The server parses the target line, changes only the target field, and re-serializes it, so the format stays valid. Tool inputs must stay valid JSON. If a live agent owns the session, the server stops it, applies the edit, and reopens the terminal so the agent resumes with the edited context. Each edit keeps a backup under `~/.cache/aiconvo/edits/`.
- **Models, branches, and headless runs (pi).** The blessed fast path next to the sovereign terminal:
  - **One model set per conversation** — the composer shows the models for the next reply. One model makes one run. Two or more models make parallel Pi-native forks. The selected set updates immediately and persists on the server.
  - **Project default model** — each project panel has one default. A new conversation inherits it unless its launcher selects another model set. Existing conversations keep their own selections.
  - **Headless send** — the composer's `send` button drives a warm `pi --mode rpc` process on the session file (same extension discovery as the TUI). Follow-ups reuse the process; it exits after 5 idle minutes, or at once if you open a terminal. Progress streams live into a run card; runs are jobs with an abort button. Slash commands and images still use `open & send`.
  - **Send from any node** — in the tree view, `send from here…` continues from any entry. One model = an in-file pi branch (a label anchor, nothing rewritten). Several models = one pi-native fork per model, run in parallel; the family tree shows them as sibling branches.
  - **Parallel runs are web-only** — one terminal runs one model. With two or more model chips set, `ctrl+shift+enter` and terminal sends refuse with a hint. Remove extra chips to use the terminal.
  - **Aggregate** — on a node with two or more answer branches, `aggregate replies…` quotes each branch's answer with its model name and asks one model to synthesize, continuing on the original conversation.
  - **Trace transcript** — the transcript shows one path through the entry tree. Branch points render a `⑂ branch i/N` pill with ◀ ▶ switching and a list of alternatives; a banner offers `back to newest`. `everything` mode keeps the complete file record.
  - **Ownership rules** — the terminal is sovereign: opening one aborts any headless run on that file. A headless send or model switch refuses while a terminal owns the session, with an explicit force option that stops the terminal first. Every run holds the per-file operation lock. Approval prompts cannot be answered headlessly: the run is marked `needs a terminal`.

## UI

- **Home is the whole-system view.** The full work area shows the timeline, tabs (conversations / notes / epics / repos), and search. There is no permanent side rail. Every click lowers one level: a project label opens the project, a violin mark opens its conversation, a green square opens its note, a triangle opens its epic, and the `⌂ branch` link on a project row opens its Git history.
- Below home, a **breadcrumb spine** (`❯ home ▸ project ▸ conversation ▸ …`) sits under the top bar. Each segment is a link. Clicking the conversation segment while reading it opens a sibling quick-switch list for the same project. The brand button always goes home; shift-click also clears every filter.
- One router owns navigation. Every view has a hash route, so the browser back button, refresh, and deep links work everywhere. The app never navigates by itself: live updates only patch data, show a toast, or a badge (`design/22-home-and-router.md`).
- The home timeline is a Gantt. Four layouts: horizontal, vertical, full-screen project swimlanes, or hidden. Pick a layout with the timeline icons, or press **g** to cycle. The choice is saved.
- The bottom and full-screen layouts have a row toggle. **rows: project** is the default and groups work by project. **rows: compact** restores the original shared-lane view, while project colors remain. Project groups sort by their most recent message. Overlapping conversations use separate tracks. The chart renders only the visible time window for fast scrolling and zooming.
- Use the project selector in the Gantt toolbar to show one project or repository. This filter also applies to notes through their source conversations.
- Click a project label on the left of the Gantt to open a project overview. It shows memory health, workstreams/epics, recent conversations, and a launcher for a new conversation in that project root. **update all notes** distills every conversation without a note and re-distills every stale note, with two model jobs at a time. **build project memory** classifies every user message for durable intent, keeps the preceding assistant response as context, and writes a high-level overview, deep intent note, safe environment guide, and current todo/focus note. It also proposes project-wide epic candidates for review and one-click building. Secret values never enter the environment document. The launcher remembers the selected agent per project. **start** (pi) creates the session in the app and sends the briefing through warm RPC. **in alacritty** is the desktop TUI escape hatch. Claude still starts in Alacritty only. Its briefing lists project memory first, then chosen epics, fresh note paths, and selected evidence. When **read all current notes** is selected, the kickoff tells the new agent to read every listed note.
- Open **diffs** in a conversation header to enter the focused file Gantt for that conversation. The left tree contains only files touched there. Each selected file shows only that conversation's keyframes across the conversation start-to-end span, using the state before its first file change and after its last change. As you move either keyframe, the tree marks every file changed in that interval and shows `−N +N` lines; its header shows interval totals. **jump to latest changes** selects the latest changed file and its latest edit burst. The complete side-by-side file view and line history remain available. No unrelated project edits or times enter this conversation view.
- Open the **repos** tab (key **4**) to browse local Git repositories and worktrees. This Gantt uses commits and the working tree only. Click a file to compare two commit points, draw with the pen, and **send** the page to a new coding session. If that directory already has project notes, the new session also receives the project briefing. Deep link: `#git=<repo-root>` (`design/21-git-repo-gantt.md`).
- A project overview's **files** switch opens the files landing (README, tree, ridge — see *Files mode*).
- Open **file Gantt** in a project overview to weave mined AI edits and recognized shell mutations with Git history. Files are rows and time runs left-to-right. AI edits are squares, commits are diamonds, working-tree changes use a right-edge bar, and inferred AI-to-commit links show confidence. Pairing uses file path, content overlap, commit timing, and branch membership. Failed tool calls never pair. Click any mark for its tool-call diff, conversation, commit patch, branch, and provenance.
- Click or touch a file name in the file Gantt to enter a focused file workspace. A navigable repository tree stays on the left. One Gantt for only that file stays above the complete side-by-side content. Click the track, click a time mark, or directly drag either keyframe diamond with mouse, pen, or touch. The hollow/dashed old marker and filled/solid new marker remain distinct in binary e-ink mode. Long lines wrap inside their own side. Unchanged lines use the full width. Changed rows split left/right into removed and added text. If the two keyframes have no line changes, the file is one view. **show lines** draws row separators; they stay off by default. A small built-in highlighter decorates code and Markdown in place, without reflow, so the change grid stays aligned. Changed lines also use `−`/`+`, border shapes, strike-through, bold, and underline instead of color alone. Moving to another tree file keeps both times. Select a line to unfold matching interval changes below it, newest first. Select a change to open its conversation at that edit, or its Git commit. Git/current snapshots are exact; reconstructed AI snapshots show their replay method and skipped events (`design/19-whole-file-time-compare.md`).
- The whole-file view is built for big files. Only the rows near the viewport (or on the current e-ink page) exist in the DOM; row heights are monospace arithmetic, measured once from probe rows and corrected for what is rendered, so long lines wrap at any character. The diff is `linediff.js` (shared with the server): exact, no size cap, run in a worker. The client asks for the keyframe list once per file, one snapshot per keyframe (revalidated by `ETag` = content sha, cached by content), and change bodies only when a line number is opened. Moving between keyframes already seen makes no request.
- The file Gantt keeps attempted AI edits, successful tool results, inferred commit links, and Git facts separate. Low-confidence time-and-branch-only links remain clearly labeled. Deep link: `#project=<name>&files`.
- Whole-file views and note views carry the trust controls: **✓ vouch** and **✗ dispute** act on the browser text selection (line-granular) or, with no selection, on the whole file. Vouched lines show ✓ and disputed lines ✗ in the line-number gutter (shape, not color — e-ink safe). Notes show their trust state next to the title, and every section has **✓ vouch section**. The project overview has a **trust** section that works as a review queue: disputed and changed-since-review content first. The project file tree badges vouched files. The new-conversation briefing warns the agent that memory is AI-generated and labels every listed path with its trust state.
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
- Titles come from the first real user request. Memory-briefing bootstrap prompts ("Read …/briefings/….md") are skipped, so injected sessions are named after the actual work.
- Titles are editable. In the conversation header: double-click the title (or click the ✎ pencil) for an inline edit — Enter saves, Escape cancels. The **↻ title** button asks the model for a fresh title and timeline label. Both write a durable override in `~/.cache/aiconvo/timeline-titles.json`; a manual title survives re-indexing and is never overwritten by the background labeler.
- Snippets are sentences you repeat often. Type `;;` in the composer (the trigger is a setting) and the letters after it filter the list; Enter or Tab replaces the token with the snippet, Esc keeps what you typed. The `;;` button and **alt+;** open the same list detached (phone, e-ink). **alt+shift+;** saves the composer selection (or the whole draft) as a new snippet; user messages have a **snippet** hover action for the same. `$1`, `$2`, `$@` in a snippet become blanks: the first is selected on insert and Tab walks to the next. Files live in pi's prompt folders — `~/.pi/agent/prompts/<name>.md` or `<project>/.pi/prompts/<name>.md` — with `kind: snippet` in the frontmatter, so the pi terminal also sees them as `/name`. Project files need the project trusted in pi before the terminal lists them; aiconvo inserts them either way. Use counts live in `~/.cache/aiconvo/snippet-uses.json`, never in the files. The settings panel lists every snippet and opens its file in the Markdown editor.
- Enable **include tool calls in timeline density** in Filters to include tool calls.
- Click a mark to open it. Shift-click or Ctrl-click marks to select conversations.
- **Drag on the timeline** to select every conversation in the rectangle. Shift-drag adds to the selection.
- The notes tab uses the same timeline: notes are green bars that span their source conversation. Each mark shows a compact title from the note's filename slug (date dropped, at most 10 characters); hover shows the full name.
- **Search (`Ctrl+F` or `/`)** opens a modal that searches everything as you type: conversations (messages, tool calls, results, thinking), distilled notes, epics, and project memory. An SQLite FTS5 index under `~/.cache/aiconvo/search.db` answers in milliseconds; it is a derived cache and rebuilds on the next boot if deleted.
- Results are ranked passage cards grouped by conversation or document: role, marked snippet, match count, and branch / hidden-record flags. Click a passage (or `↑`/`↓` then `Enter`) to land on that exact message — folded branches open automatically when the match hides there.
- Multi-word queries AND their words; `"quoted phrases"` match exactly; the last word prefix-matches while you type. Operators: `project:aiconvo`, `role:user`, `source:pi`, `type:note|epic|memory|conversation`, `after:2026-08-01`, `before:…`, `path:server.js`.
- Inside an opened conversation, `n` / `N` walk the highlighted matches of the query that led there, with a `match 3/17` counter; expanding folded content recounts.
- Ranking weights title > note and epic sections > user > assistant > tool text, with small boosts for fresh work and the selected project.
- **Optional semantic stage** (settings → semantic search): a late-interaction ColBERT service on the GPU server (`semantic/`) adds meaning-based matches — it forgives reworded speech-to-text queries. Lexical paints first; `≈ semantic` passages merge in when they arrive. The host pushes changed units through a resumable ledger; a dead server silently means lexical-only.
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
- The **tree** tab in the artifact switcher shows the conversation as a message tree. The root is at the top and time flows down. Each box is one user message or one merged assistant turn, titled by its first sentence. Solid boxes and green edges mark the current branch (the path a resume continues); dashed marks other branches. Branching is a context-engineering strategy, so other paths are first-class history, not failures. The transcript shows one coherent reading path, with labelled alternatives at each divergence; exports still label other-branch records. Both formats store real trees: pi entries have `id`/`parentId`, Claude Code entries have `uuid`/`parentUuid`.
- Select a box to get up to four actions. **read from here** opens the transcript at that message and highlights it. **continue from here** (pi only) continues the SAME conversation after that message: it appends one no-op `label` entry parented at that node — the same anchor pi's own branch flow writes — so the next Alacritty resume picks up there and the tree grows a new in-file branch. **edit this message** opens the same branch-preserving editor as the transcript. Saving a Pi question creates another path and generates an answer while keeping the original. **fork (copy)** continues from that message in a NEW session file; the original does not change.
- Pi forks use `SessionManager.createBranchedSession` on a private snapshot of the saved source file. This file-only utility is used for both SDK and RPC agent configurations: it starts no model or agent process, never stops the original runtime, and cannot migrate the original file in place. Pi preserves the selected ancestry, model/mode records, and labels; Aiconvo restores the original `parentSession` link and atomically publishes the finished file. Claude forks copy the root→node chain with `sessionfork.js`. Snapshot and publication safeguards live in `session-snapshot.js`.
- Branch vs fork: a branch changes the continuation in the same conversation, so it still requires exclusive ownership. A fork copies history through a selected saved entry into an independent conversation and **can run alongside the original** without waiting for its current response. Text still streaming beyond that entry is not included. Active delegated-worker sessions retain their ownership restrictions. Conversations share the project's current files: a fork is not a Git worktree or file rollback. The first Pi fork may take a few seconds to load the public SDK; later forks reuse that import. Copying uses temporary disk space, cleaned up afterward, to protect the original and keep incomplete forks out of the index.
- The tree shows the whole **fork family**, not just one file. Sessions that share their first entry id (all forks copy the root chain) or that point at each other via pi's `parentSession` merge into one tree. Boxes that live in a linked fork are magenta with an **↳ fork** tag; their read and fork actions target that session. This covers forks made in aiconvo, forks made in the pi TUI, and Claude fork-session files.
- The list and timeline show **one row per fork family**: the origin's title, the family's whole time span, and a `⤑N` badge. Opening the row lands on the newest branch (or the one already open). A separate conversation has a visible origin link in its transcript. A filters checkbox (`show fork branches as separate rows`) restores one row per file.
- **T** opens the tree with a keyboard cursor: `↑ ↓` walk parent/child along the active path, `← →` walk sibling branches and forks, `enter` opens the action menu, `r / s / b / f / a / e` run read / send / continue / fork / aggregate / edit directly, `T` or `esc` returns to the transcript.
- File controls use one interaction grammar. Click opens the best aiconvo view: images preview in a lightbox, file changes open their recorded diff, and plain paths open a current-file preview. Ctrl-click opens the current disk file with its system application. Right-click, or long-press on touch, adds **open in aiconvo**, **view this change**, **open with system application**, **show in folder**, and **copy full path** when applicable.
- Each transcript message has **copy**, **read**, and **more…** controls. Copy preserves the complete Markdown. The menu includes edit, regenerate, continue here, and fork where supported.
- Answers stay complete and full-width. **Compare** opens two readable desktop columns; phones and e-ink use one full-width comparison pane at a time. **Merge…** chooses sources, model, and instructions in one dialog. Merged replies retain their source line; **Include all** preserves a snapshot of answer text without combining tool histories.
- Reading another path does not move Send. The composer offers **Continue from here** or **Return to current**. New parallel answers require a context choice before sending a follow-up. Forking/branching preserves chat history, not a snapshot of project files. Reading routes, comparison choices, merge drafts, and scroll landmarks survive refreshes. See [the conversation-reading design](design/34-conversation-reading.md) for the flow, safeguards, and tests.
- The header ticker shows the latest session update. Click it to open that conversation.
- **"● N"** in the header lists running, writing, and recent agents (key **a**), each with its working directory. Running means a live `pi` or `claude` process. Writing means the session file changed in the last 5 minutes. Click a row to open the conversation.
- Opening a conversation lands at the bottom, at the newest messages.
- **"Jobs"** shows running and recent distillation and epic jobs.
- **"settings"** opens the memory-model panel. Pick any model from your Pi catalog. Signed-in providers are listed first. **use pi default** follows `~/.pi/agent/settings.json`.
- Background jobs continue when you open another conversation. You can start multiple jobs in parallel.
- Every Pi or Claude conversation has **continue in alacritty** and an **open & send** box. aiconvo starts the native CLI in Alacritty through a thin PTY bridge. The window still looks like a normal Alacritty session. The web UI can read the screen and send keys. If Claude asks “resume from summary?”, the box shows that choice. Send pastes images (Ctrl+V) and text (bracketed paste), then Enter.
- **start conversation** on a project overview does the same for a new session: it writes the briefing, then opens Alacritty with the kickoff as the first prompt.

## Files mode

Press **F** (or the `conv | files` switch next to the home button) to turn the app around. Conversations mode is the default: home is a Gantt of conversations, a project opens its memory, a conversation opens files as a side trip. **Files mode** inverts the funnel (`design/33-files-mode.md`):

- **Home is a Gantt of files.** One row per file inside each project row, the twelve most recently edited files per project (`+ N more` unfolds a project; the project filter shows up to eighty). A violin is one **edit session** — an agent's edits to that file inside one conversation, or your own editing run in the aiconvo editor — with its thickness following how much text changed; a diamond is a Git commit. Shapes carry the actor so e-ink stays honest: solid = you, hatched = an agent, hollow dashed = an unexplained write on disk. Click a file name to open it; click a mark to open the file at that change (an agent mark opens the compare around that session; shift+click opens the conversation at its first edit). `docs` and `code` narrow the rows by kind. Home shows the last 90 days.
- **A project opens its README**, editable, with the file tree on the left (24 h `+N −N` badges) and a ridge of every file's sessions on top. `memory ▸` reaches the generated overview; `+ doc` creates a markdown document.
- **The file workspace** (`#file&p=<project>&path=<abs>`) has one time track and two bodies. **write** edits the current file: markdown in the MRMD editor (autosave, `save revision` = a Git commit, code cells), everything else in a CodeMirror code editor from the same vendored bundle (explicit save with Ctrl+S — code never autosaves, because build watchers, tests, and agents read files the instant they change). **history** is the two-keyframe compare that already existed; dragging either keyframe on the track enters it. The head strip names who touched the file — conversations (click one to land on its first edit of this file), your own sessions, unexplained writes, commits. In code files the gutter marks vouched (✓), disputed (✗), and freshly changed (+) lines.
- **Live and safe.** When the file changes on disk — an agent, a `git checkout`, anything — a clean editor reloads and marks the changed lines; an editor with unsaved edits shows a banner instead (`see history · reload from disk`), and a save whose base changed is refused with the same choices plus `overwrite anyway`. An unsaved code draft survives navigation (sessionStorage) and comes back with a banner.
- **✎ ask for a change** (Ctrl+K) docks a composer under the file. Your prompt goes, with the file (line-numbered; a ±200-line window for big files), your selection or cursor line, the file's recent edit sessions, the other files those sessions touched, and — for a new conversation — the project map, to the newest free conversation of the project that touched this file in the last six hours, or to a new conversation rooted at the project (or its declared area). The chip shows the pick; flip it. `what goes along` shows the exact text. While the run is active the editor is read-only (a banner, `stop`, `open the conversation`); when it settles the file reloads and the status says `agent changed +a −b`. The file stays attached to that conversation as an `@file` chip, so later sends from the transcript keep it.

Behind it is the **file edit ledger** (`~/.cache/aiconvo/files.db`, `fileledger.js`): one row per recorded change, from transcripts as they index, Git when a repository's history moves, the editor's saves and commits, and filesystem watchers on every active project's repositories (started at boot; `AICONVO_NO_WATCH=1` turns them off). A watcher event within a few seconds of an agent or editor change is the same change seen twice and is dropped; the rest is `external`, never "you". Fork twins (the same tool calls copied into forked session files) collapse into one session. The ledger is a derived cache: delete it and the next boot rebuilds it (a background job in the jobs panel). `GET /api/files/timeline`, `/api/files/touched?path=`, `/api/files/ridge?name=`, `/api/files/project?name=`, `POST /api/files/ask`.

Trade-offs made on purpose: code does not autosave; the editor locks while an agent run is active on the target conversation; home rows are the files inside the project folder (a transcript that wrote `/tmp/x.log` stays in the ledger and in the file view, not in the project row); the ask composer is its own small box, not the full conversation composer (no snippets, `@` palette, or dictation there yet).

## Project setup

Use **+ project** to create a new folder or add an existing folder. Setup never starts an agent. Existing folders keep their names and contents. The project page offers **Start conversation** and a separate **Edit project purpose** action.

The form keeps entries after errors and supports keyboard and touch input. New folders show their resulting path and Git setting before creation. Purpose saves check for newer text before replacing it.

This change needs matching server and frontend code. Wait for active work to finish, restart Aiconvo, then reload. The form blocks setup writes to an older server. See [design/30-project-setup.md](design/30-project-setup.md) for checks and trade-offs.

## Project folds

A "project" is a name computed from a conversation's working directory. Git worktrees and second clones would split one project into several, so folds collapse raw names into one canonical project. Memory, epics, briefings, search, and the Gantt all follow the canonical name.

- **Automatic worktree folds.** A conversation inside a linked git worktree counts for the main worktree's project. The server probes `git rev-parse --git-common-dir` per conversation directory and caches the result in `~/.cache/aiconvo/project-folds.json` (derived; safe to delete).
- **Manual folds.** The project overview has `⇄ fold into…`: pick a target, one confirm line, done. The smaller project folds into the bigger one by default; `flip` swaps that. Manual folds live in `~/notes/aiconvo/projects/aliases.json` (user data). A self-alias (`"foo": "foo"`) pins a name against automatic folding.
- **Fast fold, no history.** The folded project's memory directory is deleted; the next memory build absorbs the merged conversation set. A fold is always reversible from the `contains … ✕` chips on the overview — only grouping changes, never source files.
- **Suggestions.** Quiet chips propose folds from evidence: same git remote (one star per remote group around its biggest member) or a name twin that git does not refute. Dismissing a pair is remembered. Overviews show at most three.
- API: `GET /api/project-folds`, `POST /api/project/fold {from,into}`, `POST /api/project/unfold {name}`, `POST /api/project/fold-dismiss {from,into}`.

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

## License

Aiconvo's original code and documentation are licensed under [Apache 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution and scope. Third-party components keep their own licenses and notices.

## Config

- `PORT=8000 node server.js` changes the port (default 7433). `AICONVO_CACHE_DIR=/tmp/x` moves the derived caches (index, search, file ledger) — handy for running a second instance against the same transcripts.
- `POST /api/rescan` forces a full rescan.
- Open **settings** (key `,`) to pick the Pi model used for notes, evidence, epics, titles, and project memory. The list comes from `pi --list-models`. The choice is stored in `~/.config/aiconvo/settings.json`. The **claude-code** provider uses your local Claude Code login and the `claude-code-fable-5` Pi extension.
- A memory-model call stops after two minutes without output. Three failed calls pause automatic work for 10, then 20, then at most 30 minutes. One manual action can test the model during a pause. Failed memory leaves retry after the same 10/20/30-minute delays. The jobs panel shows the pause, and `~/.cache/aiconvo/memory-model-health.json` keeps it across restarts. Set `AICONVO_MODEL_ACTIVITY_TIMEOUT_MS` to change the two-minute silence limit.
