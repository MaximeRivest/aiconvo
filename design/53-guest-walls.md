# Guest walls: a guest acts inside one project and nowhere else

*2026-09-21. Builds on design/52 (invites, guests, sync). Modules:
`sandbox.js`, `keyproxy.js`, `keyproxy-worker.js`; changes in `users.js`
(`identify`), `pisdk.js` (sandboxed workers), `pisdk-runtime.js`,
`server.js`, `people.js`, the `aiconvo` CLI, `extensions/records.ts`,
`open.sh`. Tests: `sandbox` (arguments, and for real with bubblewrap),
`guest-walls` (a real server, a real guest, real walls), `users`,
`lan-switch`.*

## The demo, precisely

A link is pasted into a video call. The person opens it, types their
name, and is inside the owner's aiconvo — and the only thing that exists
for them is one project. They read its conversations, start new ones, run
code, edit files, commit; the agents they drive have the owner's powers
*in that folder* and nothing anywhere else. Not "hidden in the UI":
enforced by the kernel.

Design/52 gave them the identity (a guest on the roster, the project
grant, presence, attribution). This document gives them the walls.

## Same identity, smaller world: a namespace, not a second Unix user

Every process a guest causes — the Pi worker behind their sends, a bash
block from a reply, a notebook cell — starts through **bubblewrap**:

- the project folder bound read-write **at its real path**, so paths in
  transcripts, briefings and git stay true;
- `/nix`, `/run/current-system`, `/etc`, `/usr` and friends read-only;
  `/run/systemd/resolve` and `/run/nscd` too (NixOS keeps `resolv.conf`
  and the name-service socket there: without them nothing resolves);
- an **empty home on tmpfs** with only three things bound into it: the
  guest's own Pi directory at `~/.pi/agent`, the project's session folders
  (read-write, so what their agent writes is what this server indexes),
  and, read-only, the aiconvo checkout, the Pi package and the node
  prefix when those live under the home;
- a private `/tmp`, its own PID namespace, a hostname of `aiconvo-guest`,
  `--die-with-parent`; the network stays on.

Files they write are owned by the account, so git, tests and every tool
behave exactly as for the owner; `~/.ssh`, `~/.pi/agent/auth.json`, the
other projects and the aiconvo cache do not exist inside. A second Unix
user was rejected: it would need ACLs on every folder, a sudoers rule and
a rewrite of the worker IPC, and would still need a sandbox for `/tmp`
and the desktop — more work for the weaker property. Flatpak makes the
same choice for the same reason.

The environment is deny-by-default (`sandbox.sandboxEnv`): PATH and
locale, `PI_*` and `AICONVO_*`, the guest's git identity
(`GIT_AUTHOR_NAME`, `<id>@aiconvo`), nothing else — no `DISPLAY`, no
`SSH_AUTH_SOCK`, no API keys. It is the environment bwrap is *spawned
with*, not `--clearenv` inside: node hands the IPC channel to a forked
worker through environment variables added at spawn time, and clearing
them inside left the worker mute (the first bug found).

## The seam does the work

`principalFor(identity)` returns `{ guest: true, sandbox: null }` for a
guest; `principalInProject(principal, project)` builds the sandbox once
the project is known (from the conversation, the folder, or the draft's
start folder). `agentLaunch(principal, file, args, { cwd })` is the one
place a command is wrapped. `pisdk.js` keys warm workers by
`(session, walls)`: the same conversation driven by a guest and by the
owner gets two different workers, and a warm one behind other walls is
retired first, never reused. New sessions carry `sessionDir` so Pi
writes into the project's own folder (the only one bound in).

Routes that touch the machine beyond a project refuse guests at the
chokepoint, through an `AsyncLocalStorage` request context: terminal
windows, `xdg-open`, resuming delegated workers, deriving notebooks. The
Pi slash-command list comes back empty for guests.

## The console loophole, closed

Before: any process on this machine got `127.0.0.1:7433` as the owner.
Inside a sandbox with network, that was a shell as the owner. Now **being
on this machine is not a credential**: with a LAN token, local requests
need it too; the console is *this machine plus the install token*. A
sandboxed agent asking the API is the guest (its `AICONVO_TOKEN` names it),
never the console — and the local-only file powers (`isConsoleRequest`)
follow the tier, not the address.

Costs, paid: the local browser signs in once (`open.sh` opens with the
token; the response that flips the network switch on sets the cookie so
nobody locks themselves out); the `aiconvo` CLI and the Pi records tools
read the token file when no `AICONVO_TOKEN` is set. With no LAN token at
all (the machine answers only itself) nothing changes.

## Keys never enter the sandbox

Whoever runs an agent can read its key. So the guest's Pi holds
**placeholders**: `models.json` routes every provider through
`http://127.0.0.1:<port>/<provider>` and `auth.json` holds
`sk-ant-oat-guest-<token>` for Anthropic-shaped providers (pi sees
`sk-ant-oat` and speaks OAuth itself — Bearer header, Claude Code identity,
beta features) or `guest-<token>` for the rest. The **key proxy** is a
child of the server that loads the Pi SDK (the server process never
does), resolves the real credential through `ModelRegistry`
(`getApiKeyForProvider`, so OAuth refresh is Pi's code) or, for the Claude
Code subscription provider, through that extension's own `token.mjs`, and
swaps the placeholder in whatever header it arrived in. The reply streams
back verbatim. A wrong placeholder is a 401; a revoked grant fails
mid-flight. Usage per guest is reported to the server.

Providers offered to guests: those whose request can be re-credentialed
by a header swap (`anthropic-messages`, `openai-*`,
`google-generative-ai`) and the Claude Code provider. OAuth providers that
shape requests in provider-specific ways (Codex, Gemini CLI, Antigravity)
are left out. A conversation whose model is not guest-servable is
answered by the best servable one and the run card says so.

Two facts the extension asks the host for are answered from outside:
`CLAUDE_CODE_VERSION` (it runs `claude --version` at load; no `claude`
exists inside) and `PI_CLAUDE_CODE_BASE_URL` (the extension pins
`api.anthropic.com`; `models.json` cannot redirect an extension-registered
provider, so the extension itself reads the override — a two-line change
in `~/.pi/agent/extensions/claude-code-fable-5/index.ts`).

## What else is gated

- **Attached context.** Files, conversations and memory documents a
  request attaches are filtered by what the asker may see, in
  `normalizeContextItems`, the one place context is shaped. A guest
  attaching `~/.ssh/config` gets it dropped, not inlined.
- **Kill switch.** Settings → people → "stop their work": every worker
  behind that person's walls stops, every exec/cell child is killed, and
  the proxy grant is revoked so a run in flight loses its keys. Disabling
  or removing a guest does the same.
- **The people API** says whether walls exist here (`walls.available`,
  `keyProxy`, `providers`); the invite dialog states plainly what `act`
  means on this machine, in both cases.

## Verified

`test/guest-walls`: a real server with bubblewrap, a guest with `act`,
commands through `/api/exec`: the project reads and writes (and writes
land on disk, owned by the account, committed under the guest's name);
`~/.ssh`, the other project and the owner's `auth.json` do not exist; a
cwd outside the project is refused before anything runs; from inside,
the API without a credential is "sign in first" and with the guest's
token is the guest, seeing only the shared project; the terminal route
is 403; the kill switch stops a running command; context outside the
project never reaches a prompt.

Live rehearsal (2026-09-20 22:00, lambda): a guest claimed an invite to
`aiconvo`, started a conversation from the browser route, and the run
inside the walls — Fable 5.1 through the Claude Code subscription via the
proxy — ran `whoami; ls ~; test -d ~/.ssh` and answered `maxime |
Projects | ~/.ssh does not exist`. The transcript names the guest.

## Trade-offs, stated

- **Same uid, sandboxed**, not separate users: simpler and stronger where
  it matters; if a kernel namespace bug exists, the blast radius is the
  account. Accepted, as Flatpak accepts it.
- **Network stays on.** A guest can reach anything on the LAN that trusts
  locality (the semantic server, local model endpoints). Those should
  require a token too; not done here.
- **Resource caps** came the next day (design/55): one systemd slice per
  guest, entered by `systemd-run --scope` at every launch.
- **Git push does not work for guests** (no ssh keys inside). Their
  commits are local; the owner pushes. Correct, and said in the dialog.
- **Delegation, notebook derivation and terminals are refused** for
  guests rather than sandboxed. Each needs its own spawn path walled;
  none is needed for the demo.
- **`uv`, `cargo`, `rcargo` and friends start cold** inside (no caches in
  the home) or fail (ssh). Fine for a Node project; a Python or Rust
  project will want its cache directories bound in.
- **The local browser needs the token once** and the CLI reads a file. A
  small price for closing a real hole.
- **Redaction and sync (design/52) are unchanged**; the walls are about
  what runs here, sync is about what leaves.
