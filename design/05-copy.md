# UI copy

Tone: plain, short, technical. No marketing words. No exclamation marks.
Sentence case everywhere. Buttons are verbs.

## Glossary (use these words, no synonyms)

- **Conversation** — one session file. Never "chat", "thread", or "log".
- **Note** — the distilled result of one conversation.
- **Epic** — a timeline across conversations.
- **Job** — a running distillation or epic build.
- **Source** — claude, pi, or pi-remote.

## Copy table

| Place | Current | New |
|---|---|---|
| Search placeholder | "Search titles and directories. Press Enter for full-text search." | "Search titles — press Enter for full-text search" |
| Empty right pane | "Select a conversation on the left." | "Select a conversation to read it." |
| Empty list | "No conversations." | "No conversations match. Clear the search or change the filters." |
| Empty list (server empty) | — | "No conversations found. Check the SOURCES map in server.js." |
| Notes tab empty | "No notes yet. Open a conversation and press Distill." | "No notes yet. Open a conversation and press Distill." (keep) |
| Epics tab empty | "No epics yet. Select conversations and press Build epic." | "No epics yet. Select two or more conversations and choose Build epic." |
| Jobs drawer empty | "No recent jobs." | "No background work. Distill a conversation or build an epic to start a job." |
| Settings hint | — | "Notes, evidence, epics, titles, and project memory use this Pi model." |
| Settings default | — | "use pi default ([provider/model])" |
| Settings empty catalog | — | "no models match. Clear the search or show all providers." |
| Export with no selection | alert "Select at least one conversation." | Button disabled. Tooltip: "Select conversations first." |
| Build epic with < 2 | alert "Select at least two conversations." | Button disabled. Tooltip: "Epics need at least two conversations." |
| Distill start toast | "⏳ Distillation started. Continue browsing." | "Distillation started." |
| Note saved toast | "📝 Saved: [title]" | "Note saved: [title]" |
| Epic saved toast | "✓ Epic saved: [title]" | "Epic saved: [title]" |
| Distill failed | alert | Error toast: "Distillation failed: [reason]" |
| Note viewer intro | "Select a problem on the left. ▸ opens a branch." | "Select a section in the tree." |
| Distill button tooltip | "Distill this session into a note (runs in the background, auto-saves)" | "Distill this conversation into a note. Runs in the background and saves automatically." |
| Re-distill tooltip | "The session grew since the note was saved…" | "New messages arrived since this note. Re-distill to update it. Unchanged parts reuse cached work." |
| Count text | "N conversations · M active" | Keep. "N matches" in search mode. Keep. |
| Selection bar | — | "N selected" + Copy / Export .md / Build epic / Clear |
| Epic name dialog | prompt() | Dialog title "Name this epic". Placeholder: "Leave empty to auto-generate". Buttons: "Build epic" (primary), "Cancel". |

## Microcopy rules

- Timestamps: locale short form (`8/13, 2:41 PM`) in meta lines; full form in
  tooltips.
- Paths: shorten the home directory to `~`. Middle-ellipsis over 48 chars.
- Numbers: use the compact `12u/48a` form in list rows; spell out
  ("12 user, 48 assistant messages") in tooltips.
