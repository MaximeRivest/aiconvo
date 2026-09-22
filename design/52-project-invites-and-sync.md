# Project invites and sync: working on one project from several machines

*2026-09-20. Builds on design/46 (users and multiplayer). Modules:
`projectid.js`, `sync.js`, changes in `users.js`, `access.js`, `server.js`,
`people.js`, the `chattering` CLI. Tests: `project-sync-units`,
`project-sync` (two real installs).*

## The question

"I am hiring someone to keep building Chattering. I want to send them a link,
have them get the whole project memory, let them build on my machine or on
theirs, share all the conversations and knowledge, and keep our agents
from getting confused about whose commands and environment are whose."

The word *invite* mixes three things that must stay separate:

1. **Access** — the person can log into *my* Chattering and act as themselves.
   Design/46 built most of this (members, invite links, `identify(req)`,
   `access.json`).
2. **Replication** — they run *their own* Chattering and the project's
   knowledge flows both ways.
3. **Execution location** — whose computer the agent runs on when a message
   is sent. That is a property of a conversation, not of a person: a
   conversation stays bound to one machine (design/46).

An invite grants (1), offers (2), and leaves (3) to each conversation.
Fusing them gives either "everyone must work on my box" or "everyone must
install things before seeing anything"; both are wrong.

## The primitive that was missing: a project identity that is not a path

On this install a project *is* its folder (`~/Projects/<name>`). On the
hire's laptop the same project sits at `~/work/chattering`, so nothing lines
up. `projectid.js` gives each project a random stable id (`p_` + 16 hex)
kept in two places:

- the registry `~/notes/chattering/projects/ids.json` (`id → { name, cwd,
  origin, policy }`), local to the install;
- the marker `.chattering/project.json` inside the checkout, which travels
  with every clone.

The marker wins over the registry: a clone that carries it resolves to the
same id under whatever local folder name it has. The marker is written by
an explicit act — an invite or a join — never by listing, because it adds
a file to someone's repository. Everything that crosses machines (invite,
feed, mirrored conversation, leaf) is keyed by the id, never by the path.

## Guests: the same roster, the opposite default

A household member sees everything the rules do not hide. A **guest**
(`scope: 'guest'` on the roster entry) sees nothing except what a rule
*lists* for them. Same roles, same credentials, same handoff; only the
default flips. In `access.js`, `mode: everyone` now means "everyone in the
household"; a guest needs a `listed` entry, which is exactly what an
invite writes (`grant(rules, 'project:<name>', 'user:<id>', right)`). A
rule that only admits a guest to an open project is kept on disk (it is
not the default any more). A guest arriving by handoff on a paired install
stays a guest there.

## The invite link

`https://<install>/?invite=<one-time secret>` — issued from a project's
sharing dialog (◎) by the owner or an admin, stored hashed on the roster
(`roster.invites`), valid 14 days, spent on claim. It carries the project
ids and names, the right (`see` or `act`), the scope and a suggested name.
Issuing it writes the id marker into the checkout and tells you to commit
it.

Opening the link shows a plain page: who invited you, to what, your name,
and — for people who want the project on their own machine — the one
command `chattering join <link> [--name] [--folder]`. Joining in the browser
creates the guest, writes the grants, sets the cookie, lands on the app.
The person works on the host's machine immediately; connecting their own
Chattering is a later, optional step, never a fork in the road.

`act` on the host's machine is stated plainly in the dialog: **the guest's
agents run as your account there**. Hidden things stay hidden in the app,
but an agent they drive could read files outside the project. Give `see`
to someone you do not fully trust and let them act on their own machine.
This is the trade-off design/46 named (polite walls); real isolation
(spawning a guest's agents as a separate Unix user) is a deployment mode
the `principalFor → spawnAs` seam is reserved for. It is not built here:
running the Pi worker through `sudo` with an IPC channel, per-guest home
directories and session ownership is a second deployment of the program,
not a feature to half-ship.

## Replication: one origin per record, so there is nothing to merge

A project, for sharing, is four things:

| piece | lives at | portability |
| --- | --- | --- |
| code and docs | the git repository | git, already solved |
| conversations | `~/.pi/agent/sessions/…`, `~/.claude/projects/…` | append-only files, copied |
| memory leaves and notes | `~/.cache/chattering/memory-leaves`, the notes tree | keyed by conversation, copied |
| synthesized documents (overview, intent, environment, status) | `~/notes/chattering/projects/<slug>/` | **never copied — regenerated** |

**Every record has one origin install and only the origin writes it.** A
conversation made on lambda is lambda's; the hire's install holds a
read-only *mirror* (readable, searchable, forkable; a fork is a new
conversation owned by their install). The same the other way. Nothing is
edited in two places, so there is no merge and no conflict resolution.
Documents are synthesized locally from the union of leaves, which is the
existing rule (documents regenerate from evidence, never accumulate).

### Transport

- `GET /api/sync/feed?project=<id>&since=<cursor>` — the origin's own
  conversations of one project (never its mirrors), *as the asking person
  may see them*: the peer authenticates with the credential that names
  its person on this roster, and the ordinary access rules decide what is
  in the feed. Items carry the transcript, the index facts, the memory
  leaf and the distilled note; ordered by version (newest of transcript
  mtime, leaf build, note time); paged by count and bytes.
- `POST /api/sync/push` — for an install nobody can reach (a laptop behind
  a home router): it computes the same feed of its own side and posts it.
  Needs `act` on the project there: contributing conversations is acting.
- Pull and push land in the same import path. No server in the middle;
  each side polls every minute (`sync.js` engine) and `chattering sync` runs
  one now.

### The join handshake (`chattering join <link>`)

Two round trips to the host's `/api/sync/join`: first with the invite (or
a device link of an existing person) to learn who they are and receive a
credential for this install; then, after making the host's owner a guest
here (listed with `act` on the joined project) and issuing them a
credential, once more with `install: { name, url, publicKey, credential }`
so the host registers this install as a peer. Both installs then hold a
credential for the other and the list of shared project ids. With
`--folder`, the id is bound to a local checkout (marker written,
registered as a project); without, the project exists here only through
its mirrors until a checkout with the marker appears.

### Mirrors on disk

A new conversation source, `mirror`, at
`~/.local/share/chattering/mirrors/sessions/<peer>/<origin source>/<rel>`
(durable user data, not cache). Keys look like `mirror:<peer>/pi/…`. The
ordinary indexer, search, notes and memory pipelines see them as any
transcript; a manifest next to them records the peer, the project id and
the note path so a re-index or a later folder binding keeps them filed.
`assertCan(…, 'act', …)` refuses a mirror with the reason and the peer's
name; `/api/fork` on a mirror needs only `see` and lands the fork in this
machine's session folder for the local checkout, with the working
directory rewritten. The origin never learns of the fork; that is right.
Mirrored leaves are never re-extracted here (single writer): the origin's
leaf arrives with the next sync, tagged with its host.

## Sharing is also leaking: filter at export

Transcripts hold tool output. An agent that once ran `cat ~/.ssh/config`
inside a project conversation put it into the transcript. Before a
conversation leaves the machine, `sync.js` classifies each tool call:
absolute paths outside the project folder (`~` and `$HOME` count as
outside; `/tmp`, `/nix/store`, `/usr` and the like do not), or commands
that smell of secrets (`printenv`, `.env`, `auth.json`, `GITHUB_TOKEN`,
…). The project's policy (`ids.json`, set from the sharing dialog) says
what happens: **redact** the flagged tool results (default), **exclude**
any conversation with a flagged step, or send **whole**. Over-redacting one
step is the safe error; the pattern for `token`/`secret` requires the word
to stand alone or be joined by `_`/`-`, so `tokens.css` does not trip it.

Revoking a guest (settings → people → ✕) removes their grants, their
credentials and the peer that acted as them, so their pulls stop. Copies
already on their machine are theirs; the dialog says so.

## Keeping the agents unconfused: environment in two levels

`environment.md` blended project facts ("run `node --test`") with machine
facts ("ssh `aurel@192.168.2.17`"). With a hire on a third machine, an
agent reading it would run your addresses with confidence. Now:

- every memory leaf records the **host** it was extracted on and the
  participants; environment facts reach the synthesizer as
  `[date] [host: lambda] command: …`;
- the environment prompt separates the **project level** (true in any
  checkout on any machine) from a **machine level** with one entry per
  host (absolute paths, addresses, credential locations, quirks);
- the document renders the project part first, then "Machine (this one):
  <host>" and "Machine (elsewhere): <host>" sections, with a standing
  caution that other machines' sections describe other computers;
- the briefing every new agent gets names this machine, says how many of
  the project's conversations happened elsewhere and on which peers, and
  states the caution in one line.

A leaf without a host was extracted before hosts existed, on this
machine; it is labelled with this host, which is correct. `CHATTERING_HOSTNAME`
overrides the name an install goes by (tests, and hosts with unhelpful
names).

## Trade-offs, stated

- **Pull/push every minute, not live.** Knowledge arrives within a minute;
  in exchange there is no server in the middle and no conflict handling.
  Live collaboration (shared compose box, shared file) stays per install.
- **Single writer.** A guest cannot retitle or edit *your* conversation
  from their install; they fork it. Provenance over tidiness.
- **Guests default to nothing.** More friction than "everyone" for a
  friend you would rather trust; the person can be flipped to household
  scope in settings → people.
- **No real isolation on the host.** `act` for a guest means running as
  the account; the dialog says it, the invite answer carries
  `runsAsAccount: true, isolation: false`. The seam for spawning as a
  separate Unix user exists (`principalFor → spawnAs`); building it is a
  deployment change (sudo-spawned Pi workers with IPC, per-guest homes,
  group-writable checkouts), not a code fork.
- **Redaction is a heuristic.** Paths and secret-words; it will blank a
  harmless `ls /etc/hosts` and cannot see a secret echoed by a command
  that names no path. `exclude` exists for projects where that is not
  acceptable, and the transcript itself is never altered on the origin.
- **Two installs only see each other's own conversations.** A ↔ B and
  B ↔ C never gives A what C wrote; mirrors of mirrors are refused. Fan-in
  happens where the people are, not through a relay.
- **The claim page is server-rendered plain HTML,** like the login page:
  it is the first thing a stranger to this install sees and must work on
  anything, offline-capable app shell or not.
