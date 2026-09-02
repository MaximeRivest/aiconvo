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
- A project overview toggles into **☷ file tree** mode: every tracked, modified, untracked, and gitignored path of every repository under the project, plus branches and worktrees. Click any file to open its whole-file view (Git scope) and come back with the breadcrumb. A filter box searches across the tree.
- Open **file Gantt** in a project overview to weave mined AI edits and recognized shell mutations with Git history. Files are rows and time runs left-to-right. AI edits are squares, commits are diamonds, working-tree changes use a right-edge bar, and inferred AI-to-commit links show confidence. Pairing uses file path, content overlap, commit timing, and branch membership. Failed tool calls never pair. Click any mark for its tool-call diff, conversation, commit patch, branch, and provenance.
- Click or touch a file name in the file Gantt to enter a focused file workspace. A navigable repository tree stays on the left. One Gantt for only that file stays above the complete side-by-side content. Click the track, click a time mark, or directly drag either keyframe diamond with mouse, pen, or touch. The hollow/dashed old marker and filled/solid new marker remain distinct in binary e-ink mode. Long lines wrap inside their own side. Unchanged lines use the full width. Changed rows split left/right into removed and added text. If the two keyframes have no line changes, the file is one view. **show lines** draws row separators; they stay off by default. A small built-in highlighter decorates code and Markdown in place, without reflow, so the change grid stays aligned. Changed lines also use `−`/`+`, border shapes, strike-through, bold, and underline instead of color alone. Moving to another tree file keeps both times. Select a line to unfold matching interval changes below it, newest first. Select a change to open its conversation at that edit, or its Git commit. Git/current snapshots are exact; reconstructed AI snapshots show their replay method and skipped events (`design/19-whole-file-time-compare.md`).
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
- **Type in the search box** to search everything as you type: conversations (messages, tool calls, results, thinking), distilled notes, epics, and project memory. An SQLite FTS5 index under `~/.cache/aiconvo/search.db` answers in milliseconds; it is a derived cache and rebuilds on the next boot if deleted.
- Results are ranked passage cards grouped by conversation or document: role, marked snippet, match count, and branch / hidden-record flags. Click a passage to land on that exact message — the everything view and folded branches open automatically when the match hides there.
- Multi-word queries AND their words; `"quoted phrases"` match exactly; the last word prefix-matches while you type. Operators: `project:aiconvo`, `role:user`, `source:pi`, `type:note|epic|memory|conversation`, `after:2026-08-01`, `before:…`, `path:server.js`.
- **Keyboard control**: `/` focuses search; `↑`/`↓` move the passage selection (also while typing); `Enter` opens the selected passage; `alt+1…5` switch scope chips (all / conversations / notes / epics / memory — they write a visible `type:` operator); `↓` past the last result loads more. Inside an opened conversation, `n` / `N` walk the highlighted matches with a `match 3/17` counter; expanding folded content recounts.
- Ranking weights title > note and epic sections > user > assistant > tool text, with small boosts for fresh work and the selected project. The query lives in the URL hash (`#q=…`), so back returns to the same results.
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
- The **tree** tab in the artifact switcher shows the conversation as a message tree. The root is at the top and time flows down. Each box is one user message or one merged assistant turn, titled by its first sentence. Solid boxes and green edges mark the current branch (the path a resume continues); dashed marks other branches. Branching is a context-engineering strategy, so other branches are first-class history, not failures: the transcript folds them into "⑂ other branch" blocks at their chronological position, and exports label them "(other branch)". Both formats store real trees: pi entries have `id`/`parentId`, Claude Code entries have `uuid`/`parentUuid`.
- Select a box to get up to four actions. **read from here** opens the transcript at that message and highlights it. **continue from here** (pi only) continues the SAME conversation after that message: it appends one no-op `label` entry parented at that node — the same anchor pi's own branch flow writes — so the next Alacritty resume picks up there and the tree grows a new in-file branch. **edit this message** (pi user messages only) forks into a new session that stops just before that message; open that session in Alacritty to edit and resend. **fork (copy)** continues from that message in a NEW session file; the original does not change.
- pi forks run through pi itself: a short-lived `pi --mode rpc` process with the `aiconvo-bridge.ts` extension performs the fork (`SessionManager.createBranchedSession`), so the new `<timestamp>_<uuid>.jsonl` with its `parentSession` pointer is written by pi's own runtime, not by hand. Claude has no arbitrary-node fork API, so aiconvo copies the root→node chain into a new `<uuid>.jsonl` (session id rewritten, temp file + atomic rename; logic in `sessionfork.js`, tests in `test/`).
- Branch vs fork: a branch stays in one conversation with many paths (what the pi TUI does natively). A fork is a copy that continues in a new conversation. Claude Code stores real in-file trees too (edits and /rewind create them), but its CLI always continues at the last real message and ignores external anchors — verified empirically — so Claude conversations can only fork. Branching refuses if a pi process still holds that session file. Quit that Alacritty window first. Fork and branch operations on one session file are serialized by a per-file lock.
- The tree shows the whole **fork family**, not just one file. Sessions that share their first entry id (all forks copy the root chain) or that point at each other via pi's `parentSession` merge into one tree. Boxes that live in a linked fork are magenta with an **↳ fork** tag; their read and fork actions target that session. This covers forks made in aiconvo, forks made in the pi TUI, and Claude fork-session files.
- The list and timeline show **one row per fork family**: the origin's title, the family's whole time span, and a `⤑N` badge. Opening the row lands on the newest branch (or the one already open). The conversation header shows `⤑ N branches · tree` — and `you read a branch` when the open file is a fork. A filters checkbox (`show fork branches as separate rows`) restores one row per file.
- **T** opens the tree with a keyboard cursor: `↑ ↓` walk parent/child along the active path, `← →` walk sibling branches and forks, `enter` opens the action menu, `r / s / b / f / a / e` run read / send / continue / fork / aggregate / edit directly, `T` or `esc` returns to the transcript.
- File controls use one interaction grammar. Click opens the best aiconvo view: images preview in a lightbox, file changes open their recorded diff, and plain paths open a current-file preview. Ctrl-click opens the current disk file with its system application. Right-click, or long-press on touch, adds **open in aiconvo**, **view this change**, **open with system application**, **show in folder**, and **copy full path** when applicable.
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

## Config

- `PORT=8000 node server.js` changes the port (default 7433).
- `POST /api/rescan` forces a full rescan.
- Open **settings** (key `,`) to pick the Pi model used for notes, evidence, epics, titles, and project memory. The list comes from `pi --list-models`. The choice is stored in `~/.config/aiconvo/settings.json`. The **claude-code** provider uses your local Claude Code login and the `claude-code-fable-5` Pi extension.
