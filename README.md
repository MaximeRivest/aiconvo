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
- Click a project label on the left of the Gantt to open a project overview. It shows memory health, workstreams/epics, recent conversations, and a launcher for a new Herdr conversation in that project root. The launcher remembers the selected agent per project. The **memory to include** boxes are really injected: aiconvo writes a briefing file under `~/.cache/aiconvo/briefings/` (project map, chosen epics with paths and abstracts, fresh note paths, evidence cards for the selected conversations) and sends the new agent one kickoff prompt pointing at it. The agent reads the files it needs — the same provenance-by-path pattern as exports and epics. The kickoff waits for the agent to settle at its prompt and verifies delivery (herdr must see it start working), because keystrokes sent during TUI startup are lost. Starting a conversation lands directly in the new agent's live terminal: the session file only exists after the first message, so the terminal binds to the Herdr agent itself (`agent:<name>`); once the first message writes the file, the conversation appears in the list and the normal per-conversation views take over. Unmatched Herdr agents in the **"● N"** popover open the same direct terminal.
- Open **diffs** in a conversation header, or **file diffs** in a project overview, to see agent file touches over time. One row is one file. One mark is one edit/write tool call. Click a mark to inspect a compact or full diff. These are extracted agent-intended changes, not Git diffs.
- Each file row in a diff view has a **blame** action. Blame replays the recorded edits in order and shows one row per current file line, with the age, agent, and conversation that last touched it. Click a line to open that edit's diff. If the file changed outside recorded conversations, the header says so. Deep link: `#blame=<path>`.
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
- Select a box to get up to four actions. **read from here** opens the transcript at that message and highlights it. **continue from here** (pi only) continues the SAME conversation after that message: it appends one no-op `label` entry parented at that node — the same anchor pi's own branch flow writes — so pi's resume picks up there and the tree grows a new in-file branch. **edit this message** (pi user messages only) forks into a new session that stops just before that message and puts its text in the composer, ready to edit and resend. **fork (copy)** continues from that message in a NEW session file; the original does not change.
- pi forks run through pi itself: a short-lived `pi --mode rpc` process with the `aiconvo-bridge.ts` extension performs the fork (`SessionManager.createBranchedSession`), so the new `<timestamp>_<uuid>.jsonl` with its `parentSession` pointer is written by pi's own runtime, not by hand. Claude has no arbitrary-node fork API, so aiconvo copies the root→node chain into a new `<uuid>.jsonl` (session id rewritten, temp file + atomic rename; logic in `sessionfork.js`, tests in `test/`).
- Branch vs fork: a branch stays in one conversation with many paths (what the pi TUI does natively). A fork is a copy that continues in a new conversation. Claude Code stores real in-file trees too (edits and /rewind create them), but its CLI always continues at the last real message and ignores external anchors — verified empirically — so Claude conversations can only fork. Branching needs the conversation's Herdr agent to be closed, because a running pi keeps its own position; aiconvo closes an idle agent automatically (`pane.close`) before it branches, and refuses only while the agent is working. Fork and branch operations on one session file are serialized by a per-file lock.
- The tree shows the whole **fork family**, not just one file. Sessions that share their first entry id (all forks copy the root chain) or that point at each other via pi's `parentSession` merge into one tree. Boxes that live in a linked fork are magenta with an **↳ fork** tag; their read and fork actions target that session. This covers forks made in aiconvo, forks made in the pi TUI, and Claude fork-session files.
- Each transcript message has a small **copy md** button. It copies the complete original message text, including hidden content and Markdown syntax.
- Long messages in the transcript collapse to an abstract-sized preview (about 5 lines). Click **… show more** to expand, **▴ show less** to collapse. Messages with a search hit stay expanded.
- The header ticker shows the latest session update. Click it to open that conversation.
- **"● N"** in the header lists active, recent, and Herdr-managed agents (key **a**), each with its working directory. Click a row to open the conversation.
- Opening a conversation lands at the bottom, at the newest messages.
- **"Jobs"** shows running and recent distillation and epic jobs.
- Background jobs continue when you open another conversation. You can start multiple jobs in parallel.
- Every Pi or Claude conversation has a message box below its transcript. Sending resumes that exact session in Herdr, or reuses its open Herdr agent. Live Herdr output appears in a picture-in-picture panel, so you can continue browsing. When work finishes, the app reloads the indexed conversation. Press **Ctrl+Enter** to send.
- The whole Herdr lifecycle (workspace create, agent start, prompt) runs over Herdr's socket API. Both launchers (resume a conversation, new project conversation) share one path: create the workspace, wait until its pane runs a bare shell, start the agent, and retry while the pane spins up (`agent_pane_busy`); on failure the workspace is closed, never left behind. Completion uses Herdr's server-side `agent.prompt` wait — event-driven and pinned to the pane occupant — instead of client-side status polling. If Herdr reports `agent_prompt_stalled` (no agent activity after submit), the app says so and points you to the terminal view.
- The **terminal** button in the conversation header toggles the main view between the rendered chat and a live Herdr terminal. The terminal shows the agent's real screen with colors, themed to match the app: the 16 ANSI colors map onto the app palette, and in light mode truecolor output from the dark TUI is lightness-flipped with a contrast guard so it stays readable. When you toggle back to the chat view, the app re-indexes the transcript so new messages appear.
- The terminal talks to Herdr over its socket API (no CLI spawns): ~8 screen updates per second and ~130 ms per input round trip. It streams the recent scrollback, so you can scroll up through history with the wheel.
- While the terminal is open, **all keys go to the agent** (letters, arrows, Enter, Esc, Tab, F1–F12, Ctrl/Alt combos, paste). Press **F8** to release the keyboard back to the app, and F8 or a click on the terminal to capture it again. Ctrl+Shift combos always stay with the browser.
- The **pip** button in the terminal bar shrinks the terminal to a floating picture-in-picture panel, so you can browse other conversations while it runs. Expand it back with ⛶.
- The app remembers the terminal choice per conversation: coming back to that conversation lands in the terminal only while its Herdr agent is still open. Everywhere else lands on the transcript.

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
