# 46 · Users, presence and multiplayer

Status: thinking, nothing built. Written 2026-09-19 after reading the code
as it stands (`server.js` at 7bc985e).

## What aiconvo is today, seen from the question "who did this?"

Every fact below shapes what a *user* can be. None of them are opinions.

1. **An install is a Unix account's home directory on one host.** Conversations
   are Pi and Claude session files under `~/.pi/agent/sessions` and
   `~/.claude/projects`; notes, vouches, the ledger and settings are files under
   `~/notes/aiconvo`, `~/.config/aiconvo`, `~/.cache/aiconvo`. Agents run as
   that account, with that account's API keys and git identity. When Maxime
   opens Lilly's aiconvo, everything he does happens *as her account*: the file
   lands in her home, the agent spends her key, `git` records her name. The
   files cannot tell people apart because the machine cannot.

2. **There is no identity, only admission.** One token per install
   (`~/.cache/aiconvo/lan-token`). Whoever has it in a cookie or `Bearer`
   header is "in". A request from loopback without proxy headers is "local"
   and skips the token. The server cannot distinguish Maxime's phone from
   Lilly's laptop from the e-ink tablet.

3. **Machines are islands that know each other's address and token.** Pairing
   (`/api/machines/connect`, `/api/machines/register`) is symmetric: paste one
   link, both installs remember the other with a token. "Going to Lilly's
   machine" is a plain navigation to her URL with her token in the query; the
   page then talks only to her server. No data is federated.

4. **Live updates are one broadcast channel.** `/api/events` is server-sent
   events, broadcast to every connected browser, with no idea who is behind
   each connection. There is no presence.

5. **A message enters a conversation two ways.** Web runs: `pisdk-runtime.js`
   calls `session.prompt(text)` in a worker; Pi writes the user message into
   the JSONL. Terminal conversations: the server pastes the text into the Pi
   TUI running in Alacritty through the bridge. Neither path records who typed.
   Pi's session format has a hook for this: `custom` entries
   (`sessionManager.appendCustomEntry`) live in the same tree as messages;
   aiconvo already writes one per mode switch (`extensions/modes.ts`).
   Claude Code sessions are read-only here.

6. **Files are single-player with a lock.** The editor is the vendored
   `mrmd-document` bundle (CodeMirror), which deliberately excludes Yjs,
   awareness and every collaboration part. Saves carry `baseSha`; a mismatch is
   refused. The ledger (`fileledger.js`) records `actor ∈ {ai, human, git,
   external}` and `input ∈ {keyboard, voice, pen, paste, …}`. "human" is
   anonymous. Vouches (`design/24`) are anonymous human assertions too.

7. **Drafts and the compose box are per browser** (`localStorage`,
   `conversation-draft.js`). Two people cannot see the same draft even on the
   same install.

8. **A project is a folder name.** Registered in `~/notes/aiconvo/projects.json`,
   matched by session `cwd`. No owner, no visibility.

9. **Admitted means powerful.** `/api/exec` runs any bash line as the account;
   agents read any file; the `aiconvo` CLI and the Pi records tools run as the
   Unix user and see every conversation. 187 `/api/*` routes; 9 places check
   `isLocalRequest`. There is no middle tier between "outside" and "the
   account".

10. **Tailscale cannot name people here.** Every device, Lilly's PC included,
    joined under one Tailscale login, so `Tailscale-User-Login` says the same
    name for everyone. The identity has to be aiconvo's own.

## The concept

A **user** is a person: the one typing in a compose box, editing a file,
vouching a note, taking control of a browser. A **machine** is an install:
where agents run and where files live. Users are orthogonal to machines:
the same person is the same user on every install, and an install can host
any admitted user.

Three consequences that should be stated plainly and never fudged:

- **The install owner sees everything on their install.** The files are in
  their home directory; the agents run as them. A permission that claims to
  hide project X on Lilly's machine from Lilly would be a lie. Permissions
  are about *other* users on an install: Lilly on lambda, Jacob on lambda,
  Maxime on Lilly's PC.
- **Permissions between admitted users are polite walls, not vaults.** Any
  admitted user can ask an agent to `cat` a file, or run `/api/exec`. Real
  walls would need agents sandboxed per user and every file route gated —
  a different product. Polite walls are still worth having: they prevent
  accidental reading, keep lists uncluttered, and express intent. The UI must
  say "hidden from", not "protected from".
- **Attribution is a claim the server makes**, and its quality is that of the
  sign-in. Which is why identity comes before presence, and presence before
  permissions.

### User record

```json
{ "id": "u_3f9c…", "name": "Maxime", "glyph": "M", "color": "#…", "createdAt": "…" }
```

`id` is random at creation and never changes; `name` is display only. The
roster lives at `~/.config/aiconvo/users.json` per install, and is a plain
file like everything else. One roster entry is marked `owner`: the person
whose account this is. On first run, the roster is created with the owner
named after the account (Maxime on lambda and XPSwhite, Lilly on lilly-pc),
and the local console *is* the owner.

### Sign-in

Two candidate designs; the differences matter.

**A. Per-user credential per install.** Each roster entry can issue an invite
link (`https://lambda…/?user=<secret>`), exactly how the LAN token works
today, but the cookie now names a user. Simple, secure (a real bearer
secret), and the tablet and Android app keep their token flow unchanged: the
existing LAN token becomes the owner's credential at migration, so nothing
already signed in breaks. Cost: one paste per (person, install). Loss of a
device = rotate that user's secret on each install.

**B. Device keypairs.** Each browser generates a key (WebCrypto); a person's
user is the set of their device keys; an install admits a key once. No
secrets travel, rotation is per device. Cost: WebCrypto key storage is per
browser profile and gets wiped with site data; the e-ink tablet's WebView
and the Android app need their own key store; enrolment is a click-to-approve
that needs a second admitted person or the console to be present.

Recommendation: **A**, plus one addition that gives the "orthogonal to
machines" feeling without a central server:

**Handoff between paired installs.** Installs already trust each other
completely (pairing shares the whole token). Give each install an Ed25519
key (`crypto.generateKeyPairSync`, no dependency) exchanged at pairing. When
a signed-in user clicks lambda → lilly in the switcher, lambda mints a
30-second signed handoff `{user record, exp}`; the navigation goes to
`https://lilly…/?handoff=…`; Lilly's install verifies lambda's signature,
upserts the user record into its roster if absent (so rosters converge
without a sync job), sets the cookie for that user, and lands on the page.
No paste. One user id everywhere. The trust assumption — "a paired install
may assert who someone is" — is the assumption pairing already makes today.

Two independently created "Maxime" entries (installs paired late) need a
"same person" merge in settings → users. Rare; keep the merge but do not
design around it.

### Authorization tiers

| tier | who | can |
| --- | --- | --- |
| console | loopback, no proxy headers | everything (unchanged) |
| owner | the roster owner, signed in | everything |
| user | any other admitted user | see and act on what is shared with them |
| nobody | no cookie | login page (unchanged) |

The single `hasLanToken` check becomes `identify(req) → {user, tier}` in one
place, and the request carries it. Every route that writes gets the user
handed to it; nothing else about routing changes.

## Attribution: who sent, who edited

Once a request carries a user, record it where the artifact lives:

- **Web-run messages.** Right before `session.prompt`, the runtime appends a
  custom entry `aiconvo-author {user, device, input}` meaning "the next user
  message is by…". It sits in Pi's entry tree, so it travels with the file,
  survives forks, and survives copying the session to another machine. The
  indexer (`indexFile`) reads it and sets `author` on the following user
  message, plus `participants` on the conversation.
- **Terminal-bridge messages.** The server does not own that file (the TUI
  does; two writers corrupt JSONL). A sidecar
  `~/notes/aiconvo/authorship.jsonl` `{key, ts, user, chars}` is matched to
  the next user message by time and length. Weaker, local to the install,
  and honest about it: the index marks these `author.via: "bridge"`.
- **Files.** `file_events` gets a `user` column (SQLite migration, nullable),
  `doc-edits.jsonl` a `user` field; `/api/file/save`, `/api/doc/save` and
  `/api/doc/commit` fill it from the request. Commits made by aiconvo set
  `--author "Name <id@aiconvo>"`, so git, the one identity carrier every tool
  already reads, agrees with the ledger.
- **Vouches** get `user`; the trust label becomes "vouched by Maxime". This
  changes the meaning of `vouched` from "a human" to "this human", which is
  strictly more useful and costs one field.
- **Everything that exists today** is attributed to the install owner. That is
  the truth for nearly all of it and the best available guess for the rest.

"Conversations I have been in" is then a filter on `participants`, on the
home Gantt, the tree and search. Cheap once the index carries it.

## Presence: seeing each other

The SSE channel is already there; it only lacks a way in.

- Browser → server: `POST /api/presence` every ~5 s and on every route
  change: `{route, kind: viewing|typing|editing, position?}`. `route` is the
  conversation key, file path, project or `home`; `position` for a file is a
  line, for a conversation a message id. Typing is signalled by the composer.
- Server: in-memory `Map<connection, presence>`, keyed by the SSE connection
  (the heartbeat names its connection with an id the server gave at
  connect). Broadcast a compact diff on the same channel; drop on close.
- UI: a coloured bubble with the glyph, in the header (who is on this
  install), on tree and home rows (who is in that conversation), in the
  conversation header ("Lilly is typing…"), in the file gutter (a cursor mark
  at her line). The e-ink theme uses shape and initials, not colour.

This is per install: presence on lambda is not visible from lilly-pc. Cross-
install presence would be a small relay over the existing pairing
(`remoteJson` peer summaries every few seconds) and can wait until per-
install presence has proven useful.

## Multiplayer: two people in one compose box, one file

This is the part that changes the substrate, and it should be done once,
right, with Yjs — the mrmd stack (`yjs`, `y-codemirror.next`, awareness)
already solves cursors, selections and merges, and no one should write a
second CRDT.

What it costs, honestly:

1. **A Yjs runtime on the server.** The server must hold the authoritative
   `Y.Doc` per shared document, persist it, and merge disk changes into it —
   agents write the same files with plain `write`/`edit`, and those changes
   must appear in everyone's editor without clobbering typed text. mrmd-sync
   (now inside the mrmd daemon) already does the disk↔CRDT reconciliation.
   For aiconvo that is either a vendored server bundle of Yjs (the project
   has no npm dependencies and it is a stated property worth keeping) or the
   first dependency. Vendoring is consistent with how the editor bundle
   arrived.
2. **A WebSocket endpoint.** The server already upgrades one path
   (`/api/speech/stream`); a `/api/collab/<doc>` upgrade with the y-websocket
   wire protocol is the same mechanism.
3. **A second editor bundle**, `mrmd-document` *with* the collaboration parts
   (or a flag in the same build). The current one excludes them on purpose;
   the exclusion was right until now.
4. **The compose box becomes a shared document.** A draft moves from
   `localStorage` to a server doc `draft:<id>`; the composer of an existing
   conversation gets `compose:<conversation key>`. Anyone signed in on that
   install and allowed to see the conversation can join it; cursors and names
   show through awareness. Send clears the doc and records the sender as
   author, with `coauthors` from Yjs per-client attribution when someone else
   typed part of it. Attachments (images, context) stay outside the CRDT:
   they are references, not text.
5. **Files.** The live editor keeps its history, ledger and Ask; only the
   text buffer changes from "mine, lock on save" to "shared, always merged".
   The `baseSha` refusal goes away for collaborative files, replaced by the
   ledger recording each user's contribution from awareness. Autosave to disk
   stays server-side, so agents reading the file see what people typed.

Order that keeps each step useful on its own: shared compose box first (small
doc, no disk sync, the thing Maxime described), then files.

Where the transcript is concerned: **never** put a conversation's JSONL under
a CRDT. It is Pi's append-only log with one writer. Multiplayer applies to
what people type *before* it becomes a message, and to files.

## Permissions: owners and privacy

Keep it small enough to be enforced in one module.

- **Subjects:** users, `everyone` (every admitted user on this install).
- **Objects:** projects (a folder), conversations (a session file), and
  through them notes, memory, reviews and file history *about* them. Loose
  conversations (no project) are their own object.
- **Rights:** `see` (list, read, search hits), `act` (send, edit, run,
  vouch), `own` (change sharing, delete, transfer).
- **Defaults:** everything is `see`+`act` for `everyone` (a household), the
  creator owns what they create, the install owner owns everything created
  before users existed and is always allowed everything. A project's setting
  is inherited by its conversations unless a conversation says otherwise.
- **Private:** the owner marks a project or a conversation "only me" or
  "me and Lilly". It disappears from lists, search, memory briefings and the
  home Gantt for others, and their `send`/`act` calls are refused.
- **Storage:** `~/notes/aiconvo/access.json` `{ "project:name": {...},
  "conversation:key": {...} }`, per install. Sharing does not federate:
  Maxime's setting on lambda says nothing about Lilly's PC, which has its
  own files and its own owner.
- **Enforcement:** one function `can(user, right, object)` in
  `access.js`, called at chokepoints, not per route: index listing and
  timelines, conversation read, `send`/`act`/`node/send`, file routes (path →
  project → object), search and semantic hits, records API when the request
  is HTTP with a user. The CLI and Pi tools run as the account and are not
  gated — this is the "polite walls" boundary, said out loud in the UI.

## Easy, hard, wise, unwise

**Easy (days each, each useful alone):**
- Roster, per-user credentials, `identify(req)`, owner migration from the
  LAN token, settings → users. The tablet and Android keep working.
- Attribution on web-run sends (custom entry), file saves, doc commits,
  vouches; `participants` in the index; the "mine" filter.
- Presence bubbles over the existing SSE channel.
- Handoff between paired installs (install keypair, signed 30-second claim).

**Medium:**
- Shared compose box on Yjs: server Yjs runtime, WebSocket endpoint, collab
  editor bundle, drafts moved server-side.
- Polite-wall permissions with `access.js` and the chokepoints.
- Terminal-bridge attribution (sidecar; inherently approximate).

**Hard:**
- Collaborative files with agent edits merging live (the mrmd-sync problem,
  redone inside aiconvo's history/ledger model).
- Cross-install presence and roster sync beyond handoff.
- Real (not polite) permissions: per-user agent sandboxes, gating every file
  route and `/api/exec`. Not for a household; noted so no one mistakes the
  polite version for it.

**Unwise:**
- A central account server. Installs are islands that pair; keep it so.
- Users as Unix accounts. Then Maxime on Lilly's PC needs an account on her
  PC, and the agent could not act in her checkout for him.
- Claiming to hide anything from an install's owner.
- A CRDT of our own, or a CRDT over the transcript.
- Presence or permissions before identity is real; both would be built on a
  guess.

## Order

1. Identity: roster, credentials, `identify`, owner migration, handoff. No
   UI change except settings → users and a name in the header.
2. Attribution + `participants` + "mine" filter + vouched-by.
3. Presence.
4. Permissions (polite walls), one module, chokepoints, honest labels.
5. Shared compose box on Yjs.
6. Collaborative files.

Each step lands as its own change with its own tests, and each is worth
having if the next one never comes.
