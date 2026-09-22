# 40 — New conversation: a draft until the first message

## The moment this serves

"I have a thought. Let me start saying it now; where it belongs and what it
needs can come after." The workspace's loop (find → understand → direct →
inspect → continue) had no frictionless entry for that moment: **+ project**
starts nothing, the project panel starts only after a reviewed briefing, and
the old **+ conversation** existed on home alone and created a home-rooted
session before a word was typed, freezing the working directory.

## Model

- **One global action, one stable meaning.** *New conversation* = a blank
  page: no borrowed transcript, file, project memory, or specialised mode.
  Home folder, pi defaults. It is reachable from every view (top bar, key
  `C`, the phone home's floating pill). The contextual starts keep their
  meanings: *+ in this project* (transcript bar), *reviewed start* (project
  and epic panels), *ask for a change* (files).
- **Not started is a real state.** Until the first send there is no session
  file and no Pi process — the session header fixes the cwd, so a session
  created early would have made the folder unchangeable. The draft keeps
  text, images, folder, mode, models, reasoning, and context in this
  browser's `localStorage` (`chattering.draft.v1:<id>`), routed as
  `#new=<id>`; `#new` mints a fresh id. An untouched page leaves no trace.
- **Same composer.** The draft renders the ordinary composer with a pseudo
  `current` (`{ draft: true, key: 'draft:<id>' }`). The composer controls
  that would write to a session are redirected to the draft store at their
  entry points (`setFanModels`, `persistConversationContext`,
  `setConversationMode`, `cycleThinking`, `headlessSendFromComposer`,
  `refreshCtxMeter`, `ensureSlashCmds`). No second composer.
- **Three separate facts** the interface must not blur:
  - *folder* — where the tools run (Pi loads settings, AGENTS.md, skills
    from it) and, by the index's cwd rule, which project the conversation
    joins;
  - *project membership* — a consequence of the folder (or a later manual
    assignment), never a flag on the draft;
  - *attached context* — what rides in the system prompt bundle. Picking a
    project folder does **not** attach that project's memory.
- **Instructions are context.** Per-conversation instructions are a
  `{ type: 'note', text }` context item: previewable in the context panel,
  removable as a chip, rendered first in the bundle under
  "Instructions for this conversation", re-applied on every send. Not a
  saved mode; the mode button picks those.
- **The first send commits.** `POST /api/conversation/start-loose` with
  `{ draftId, folder, mode, models, thinking, context, prompt, images }`:
  validate the folder (existing directory), write the bundle, create the
  session silently with `--prompt-mode`, the model, and
  `--append-system-prompt` (warm process A), record the applied bundle,
  set the reasoning level natively, then run the prompt through
  `startAgentRun` / `startFanOut`. `draftId` makes the call idempotent for
  one hour so a retried request cannot create a twin. If the session exists
  but the run fails to start, the response carries `runError`; the client
  opens the conversation with the words back in the composer.

## Setup surface

One line above the composer: `not started · runs in ~ · loose  [setup]`.
The panel: folder (typed or browsed through `/api/fs/dirs`) with its
consequence read from `GET /api/conversation/folder-info` (exists, implied
project/area, the AGENTS.md files Pi will read, the default model and where
it comes from), and the instructions box. Mode, reasoning, model, and Context
stay the composer buttons. Reasoning on a draft opens a level list (applied
at start) rather than blind cycling, because the model's available levels
are unknown until a session exists. `GET /api/conversation/draft-defaults`
supplies Pi's default reasoning level and the default mode for display.

## Warm-process reuse (shared with every send)

`startAgentRun` used to restart the warm Pi process on every send that had
attached context. It now restarts only when the chip set changed or the
same chips render to different text (`contextBundleHash`, the bundle text
minus its generation timestamp). `appliedContextBySession` stores
`{ sig, hash }`. To keep the invariant "an alive process was created with
the bundle recorded for it", `setConversationThinking` — the other path that
can create a warm process — now passes the conversation's bundle too.

## Trade-offs (stated, not absorbed)

- Startup cost moves to the first send: opening is instant, the send waits
  for the Pi cold start (seconds). No speculative process is kept warm for
  drafts; that would spend memory and add lifecycle for a page that may never
  send.
- Drafts are per browser, like reading state. A phone draft is not on the
  laptop. Server-side drafts would sync but turn a scratch page into a
  record; not done.
- Images beyond ~1.5 MB (JSON) are not stored; they live in memory for the
  page and the draft says so.
- The first-send idempotency map is in server memory: a server restart
  between a lost response and a retry can still produce a twin.
- A loose start may now name any existing directory (previously home only).
  The LAN token remains the access boundary; the choice equals `cd X && pi`.
- Existing blank sessions (old starts, `+ in this project`) keep a fixed
  folder; their mode/model/reasoning/context remain changeable as before.
- Per-conversation instructions can be written only on a draft for now; a
  started conversation edits context through the panel and modes through
  the mode picker.
- Slash commands are refused on a draft (they run inside a session).
- Pi persists a reasoning change as its global default
  (`defaultThinkingLevel`); the draft's shown default follows that.

## Verification

`node --test test/conversation-draft.test.js` (notes in the bundle, the
reuse rule, `describeStartFolder`, the draft store). Live checks done
against an isolated HOME: endpoints, refusal of a missing folder, session
created in the chosen folder with the reasoning entry before the first user
message, idempotent retry (one file on disk), and a headless-Chromium pass
over the draft page (open, reload, folder change, instructions chip, other
drafts, loose list, phone pill).
