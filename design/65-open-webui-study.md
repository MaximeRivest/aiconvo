# 65 — What Open WebUI gets right (study for Chattering)

Studied 2026-09-23 against Open WebUI **v0.11.4** (source checkout:
`~/Projects/_study/open-webui`, trial instance on lambda at port 3000).
Behaviour below was read from the source; the stored chat structure was
checked against a real chat in the running instance. File references are
relative to that checkout.

The goal is not to copy Open WebUI. It is to name the *job* each feature does
and the *idea* that makes it feel good, so Chattering can take the idea and
leave the mechanism.

---

## The one idea behind branching, comparing, regenerating and artifacts

**One pointer decides everything: `history.currentId`.**

A chat is a single JSON object held in the browser:

```js
history = {
  currentId: "<id of the last message on the visible path>",
  messages: { "<id>": { id, parentId, childrenIds[], role, content,
                        model, modelIdx, done, merged?, annotation? } }
}
```

Everything else is *derived* from that one pointer:

| What you see / what happens | How it is derived |
|---|---|
| The transcript | walk `parentId` up from `currentId`, reverse (`Messages.svelte buildMessages`) |
| What the model sees next | the same walk (backend `utils/misc.py get_message_list`) |
| The artifact panel | every HTML/CSS/JS/SVG block in assistant messages on that same walk (`Chat.svelte getContents`) |
| The highlighted line in the tree overview | edges on that walk are animated (`Overview/View.svelte`) |
| Which side-by-side card is "selected" | the card whose id is on that walk |

Every navigation action is one assignment:
`currentId = deepestChild(clickedMessage)` — where *deepest child* means
"follow the newest child down to the end" (`utils/index.ts getDeepestChildId`).
The ‹ 1/2 › arrows, clicking a card, clicking a tree node, and the per-column
arrows under side-by-side answers all do only that.

**Why it feels fast and flawless:**

1. **What you see is exactly what continues.** There is no second state
   ("reading here, but sending there"). The screen *is* the context.
2. **No round trip.** The whole tree is already in the browser; switching a
   branch changes one string and re-renders. Nothing is fetched.
3. **One gesture everywhere.** Arrows, cards, tree nodes: same operation, same
   result, so the user learns it once.
4. **Nothing is ever destroyed.** Regenerate, edit, "save as copy" all *add a
   sibling* under the same parent. Old versions stay one arrow-click away.

> Contrast with Chattering today (`design/34-conversation-reading.md`):
> Chattering deliberately separates *reading a path* from *the continuation
> target*, shows a destination notice, and blocks sending until the two agree.
> That is a principled choice, but it is exactly the second state Open WebUI
> avoids — and it is the likely root of "less intuitive". This is the central
> decision for the integration work (see *Questions for Chattering* below).

---

## 1. Branching and the ‹ 1/2 › navigator

**Job:** "Let me try again / say it differently, without losing what I had."

- **Regenerate** adds a new assistant sibling under the same user message
  (`Chat.svelte regenerateResponse` → `sendMessage(parent)`). The arrows show
  *n of m* among siblings (`ResponseMessage.svelte`, `siblings`).
- **Regenerate with a nudge** (menu: *Try again*, *Add details*, *More
  concise*, or free text *Suggest a change*): the old answer stays in context
  and the nudge is appended as a hidden user turn
  (`middleware.py`: `messages.append({'role':'user','content':regeneration_prompt})`).
  Result is still a sibling, so it reads as "version 2 of the answer", not as
  a new exchange.
- **Edit a user message** creates a *sibling user message* and runs it
  (`Messages.svelte editMessage`) — the question gets its own ‹ 1/2 ›.
- **Edit an answer** either overwrites it (keeping `originalContent`) or
  *Save as copy* → a new sibling.
- Going to another sibling jumps to that branch's newest end
  (`getDeepestChildId`). Open WebUI does not ask "which descendant?"; it
  picks the newest, and in practice that is what people want.

**Essence:** alternatives are *versions of one turn*, reached in place, and
switching versions switches the whole rest of the conversation with it.

## 2. Several models at once, streaming side by side

**Job:** "Ask once, see how different models answer, keep the best."

- The user message records `models: [A, B, C]`. One request goes to the
  backend with a list `{model_id, message_id, modelIdx}`; the backend fans out
  and streams every answer into its own placeholder (`Chat.svelte sendMessage`,
  `main.py` ~L1216).
- `modelIdx` is the **column**. Regenerating in column 1 regenerates only that
  model and keeps the column; each column has its own ‹ 1/2 ›
  (`MultiResponseMessages.svelte groupedMessageIds`).
- Cards are equal-width, horizontally scrollable, snap on phones. The
  selected card is solid; the others dashed. **Clicking a card is the
  selection** — it sets `currentId` to that answer.
- The next message simply continues from the selected card. Both models are
  asked again, and **both see only the selected answer as "their" previous
  reply**. The other answers leave the context silently.
- Live and finished answers use the same card; there is no layout switch when
  streaming ends.

**Essence:** comparison lives *in the transcript*, at the exact turn, in the
same layout while streaming and afterwards; picking a winner is one click and
is also the continuation.

## 3. Merge

**Job:** "Take the best of all these answers."

- The merge button appears under the last multi-answer group once all are
  done. It sends the currently shown version of each column to a
  *mixture-of-agents* prompt (`config.py DEFAULT_MOA_GENERATION_PROMPT_TEMPLATE`:
  "synthesize these responses… critically evaluate…") and streams a
  **Merged Response** block under the cards (`Chat.svelte mergeResponses`).

**Weaknesses we should not copy** (read from the code):

- It uses **only the last user question**, not the rest of the conversation.
- The merged text is stored on the selected message's `merged` field, and
  the backend never replays `merged` (`middleware.py MESSAGE_REPLAY_KEYS`). So
  in a saved chat, **the next turn does not see the merge**; it continues from
  whichever card is selected. Only temporary chats substitute it.
- The model doing the merge is whichever card was selected, not a choice.

**Essence worth keeping:** the one-click "combine these" at the point of
comparison, streaming right there.

## 4. Clone and fork

**Job:** "Keep this conversation as it is, and take a copy somewhere else."

- **Clone** (sidebar menu): copies the whole chat, *all* branches, titled
  "Clone of …" (`routers/chats.py clone_chat_by_id`).
- **Fork** (button under a finished answer, or typing `/fork`): a new chat
  holding only the path root→that message, linear (`utils/chat_fork.py`),
  titled "… (fork)"; unfinished answers are marked done.
- Both record `originalChatId` and `branchPointMessageId`, but the UI never
  shows the origin. It is a copy, instantly usable, and that is all.

**Essence:** cheap, instant, no questions asked. Branch *inside* a chat for
alternatives; fork *out* for a new direction.

## 5. Tree overview

**Job:** "Where am I, and what other paths exist?"

- Svelte Flow graph in the right panel, one node per message with model and
  first words; active path edges animated; clicking a node = the same
  `currentId` jump; the view refocuses on the current node
  (`Overview/View.svelte`).

**Essence:** a map, not a second editor. It uses the same single gesture as
everything else.

## 6. Artifacts

**Job:** "Show me the thing the answer made, working, next to the chat."

- Nothing is stored. Artifacts are recomputed from the visible path on every
  change (`Chat.svelte getContents`): each `html` block starts a page, the
  following `css`/`js` blocks are poured into it, SVG blocks become
  pan-and-zoom images (`utils/index.ts getCodeBlockContents`).
- "Version n of m" = every artifact found **on the current path**, in order.
  Switching a branch or clicking another card changes the path, so the panel
  changes by itself. The *Preview* button on a code block just selects the
  matching version.
- Rendered in an `<iframe srcdoc>` with `sandbox="allow-scripts allow-forms
  allow-downloads"` (no same-origin), an admin-set CSP injected, links kept
  inside the frame, full screen and download.

**Essence:** the artifact is a *view of the current branch*, not a saved
object — so it is always consistent with what you are reading, for free.

**Limits:** only HTML/CSS/JS/SVG; no multi-file projects, no React build, no
editing in the panel; a model that splits code oddly can produce a broken page.

## 7. Workspace

**Job:** "Package how I like to work, so I can reuse and share it."

| Item | What it is | Stored as |
|---|---|---|
| **Models** | a named preset on top of a base model: system prompt, parameters, attached knowledge, tools, skills, filters, actions, default features, suggestion prompts, avatar, access rights. Shows up in the model picker like a real model. | `models` table: `base_model_id`, `params`, `meta` |
| **Prompts** | reusable text triggered with `/command`, with fill-in variables, versioned | `prompts`: `command`, `content`, `version_id` |
| **Knowledge** | a folder of documents, indexed for retrieval; attach with `#` in chat or permanently to a model preset | `knowledge`, directories, files |
| **Skills** | named instructions with a description. The model gets a list of names+descriptions and loads a skill's full text on demand (`view_skill`); mentioning one inlines it | `skills`: `name`, `description`, `content` |
| **Tools** | Python classes whose methods become callable tools, with admin settings ("Valves") and per-user settings ("UserValves") | `tools`: code + specs |

**Essence:** a *model* in Open WebUI is really a **persona = base model +
instructions + knowledge + abilities**, and it is picked exactly like a model.
That makes presets first-class and comparable (you can put two presets side by
side, and rate them).

## 8. Ratings and leaderboard

**Job:** "Learn which model (or preset) is actually better for *my* work."

- 👍/👎 under every answer. After a click, an optional panel asks for a
  1–10 score, a reason and a comment; the model also auto-generates topic
  tags for the conversation (`ResponseMessage.svelte feedbackHandler`).
- Each rating is saved as a *feedback* with a **full snapshot of the chat**
  and the ids of the **sibling answers' models** — the other answers to the
  same question.
- Leaderboard = Elo (start 1000, K=32). A 👍 counts as a win against every
  sibling, a 👎 as a loss (`routers/evaluations.py _calculate_elo`). A rating
  on an answer **with no siblings does not move the Elo at all.**
- Searching the leaderboard ("coding", "French") re-weights each rating by how
  close its tags are to the query (embeddings) → a per-topic ranking.
- **Arena**: an optional hidden "Arena model" that secretly picks one of
  several models, so ratings are blind.

**Essence:** ratings only mean something **relative to alternatives for the
same question** — which is exactly what side-by-side and regenerate produce.
The three features feed each other.

## 9. Functions

**Job:** "Change what happens around a model call, without changing the app."

Three kinds (Python, admin-installed, `utils/plugin.py`):

- **Pipe** — a custom model/provider; appears in the model picker.
- **Filter** — `inlet` (edit the request), `stream` (edit chunks), `outlet`
  (edit the finished reply). Can be global or per model preset.
- **Action** — an extra button under answers that runs code on that message.

Each has settings for the admin and for each user. They run arbitrary Python
inside the server, which is why only admins can install them.

**Essence (the part worth keeping, without their mechanism):** three hook
points around every model call — *make a model*, *transform in/out*, *act on
an answer* — each installable, configurable, and switchable per preset.

---

## How the features reinforce each other

```
side-by-side / regenerate ──► siblings ──► ratings that mean something ──► leaderboard
          │                                                                  ▲
          └─► one currentId ──► transcript, context, tree, artifacts          │
                                                                              │
workspace preset (model+prompt+knowledge+tools) ── picked like a model ───────┘
functions ── attach to presets (filters, actions) or become models (pipes)
```

## Questions for Chattering (the next step)

1. **Reading = continuing?** Adopt the single-pointer rule, or keep the
   separation? Open WebUI can afford "view = continue" because a chat is only
   text. A Chattering conversation is an agent that **changed files**:
   switching to another branch does not undo those changes. Whatever we
   choose must make that visible rather than silently mixing worlds.
2. **Where does the tree live?** Open WebUI's speed comes from having the
   whole tree client-side. What does Chattering load when switching branches
   (Pi session entries, forked session files folded back by `fanoutmerge.js`,
   Claude sessions that can't branch in place — `sessionfork.js`)?
3. **Side-by-side as the default comparison.** Chattering shows one answer at
   full width with a selector, opens comparison as a separate step, and
   requires an explicit choice before a follow-up to a parallel run; Open
   WebUI shows all answers as cards at that turn and makes the click the
   choice.
4. **Merge that actually continues.** Keep Chattering's stronger merge
   (sources recorded, reply becomes the continuation) but launch it from the
   card group in one click, streaming in place.
5. **Artifacts derived from the path.** Chattering has a hardened HTML preview
   (`html-preview.js`) for files; the new idea is tying preview *versions* to
   the visible branch.
6. **Presets.** Pi *modes* are the closest counterpart to Open WebUI "models";
   knowledge ≈ project memory/records; skills and extensions ≈ skills and
   tools. The idea to borrow is picking a preset *like a model* and comparing
   presets side by side.
7. **Ratings.** `ai-feedback.js` already records outcomes of in-file AI
   proposals as preference data; 👍/👎 on conversation answers with sibling
   context would extend the same dataset and could feed an Elo view.
