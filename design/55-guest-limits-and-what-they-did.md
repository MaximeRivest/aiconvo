# Guest limits, and what each person did in a project

*2026-09-21. Builds on design/53 (walls) and design/54 (presence). Changes
in `sandbox.js`, `settings.js`, `server.js`, `people-activity.js` (new),
`people.js`, `people.css`, `app.html`. Tests: `sandbox` (caps, for real),
`people-activity` (the accounting), `guest-walls` (a real guest's commit
on the owner's project page), `people-app` (two browsers: the strip,
opening a file from it, never yourself).*

## One budget per guest

The walls of design/53 say where a guest's processes may look. They said
nothing about how much of the machine those processes may use: a guest's
agent could take every core and all the memory, and a fork bomb typed into
a prompt would have taken the owner's work down with it.

Every guest now has a systemd slice, `aiconvo-guest-<id>.slice`, nested by
the dash naming under `aiconvo-guest.slice` under `aiconvo.slice`. Every
launch of theirs — the Pi worker behind a send, a run-bash block, a
notebook cell — is `systemd-run --user --scope … --slice=<theirs> -- bwrap
…`. systemd-run registers its own pid in the scope and execs bwrap, so the
child the server holds is still the sandbox (the IPC channel rides through,
`--die-with-parent` still means the server), and the process tree lands in
the guest's cgroup. The properties on the slice:

- `MemoryMax`: a quarter of the machine's memory, never under 2 GiB.
- `MemorySwapMax=0`: a guest at the cap is killed, not allowed to swap the
  owner's work to disk.
- `CPUQuota`: half the cores, as a ceiling; `CPUWeight=50` so that under
  contention the owner's processes win before the quota bites.
- `TasksMax=512`: a fork bomb stops long before the machine notices.

The slice's properties are written as unit drop-ins (`systemctl
set-property` without `--runtime`): a slice that went idle and was
garbage-collected comes back capped at the next launch, and `systemctl
revert` removes the files when the guest is removed. The owner can set the
three numbers in settings → people ("guest limits"); a change applies to
guests already running, because a slice is a live cgroup. The kill switch
("stop their work") now also kills the whole slice, which catches a process
that double-forked away from a scope's first child.

**One thing systemd-run needs and the sandbox hides.** The sandbox
environment deliberately drops `XDG_RUNTIME_DIR` and the session bus, but
systemd-run runs *outside* the walls and needs them to reach the user
manager. They ride in the spawn environment and are stripped again by
`/usr/bin/env -u … XDG_RUNTIME_DIR=/run/user/guest` right before bwrap, so
nothing inside ever sees the host's runtime directory. The test asserts
both: the process is in its slice, and the bus never crossed.

**Where there is no user manager** (a container, a WSL distribution
without systemd, `AICONVO_NO_CGROUP=1` in tests), the walls stand without
caps; settings → people and the invite dialog say so in words.

## What each person did here

The people panel and the presence marks (design/54) answer "where is Sam
right now". The project page now also answers "what has Sam done here" —
the other half of the question a person asks when they come back to a
shared project.

Three records already name the person, and none of them was new:

- A user message carries its author (design/46), and the index carries the
  participants of each conversation.
- A human save in the file ledger carries `user_id`; an agent edit carries
  the conversation it came from — and that conversation's writers were
  driving it.
- A guest's commit carries `<id>@aiconvo` as its email (sandbox.js). For a
  household member committing under their own git identity, an exact
  roster name matches; otherwise the commit belongs to nobody here.

`people-activity.js` folds them into one account per person for a window
(14 days by default, at most 90): the conversations they wrote into with
the count and the id of their last message, the files that changed by
their hand or by an agent they were driving (with the conversation), and
their commits. It is pure: the server supplies the rows, already filtered
by what the asking person may see, and the readers. The commits come from
the cached repository history the files mode already keeps, so nothing
new is spawned per request beyond a thirty-second cache.

On the project page, under the "here now" strip, a section lists each
other person, newest first: bubble (live when they are in the project),
name, a guest badge, a count line, when. Behind the disclosure, three
lists. A conversation opens **at their last message** (the same landing
as "go" in the people panel); a file opens in the editor; a commit copies
its hash and names the checkout, because there is no commit viewer in the
app and pretending otherwise would be worse than a plain `git show`. With
two people or fewer everything is open; with more, the newest one. The
section is hidden when nobody else did anything: a solo project page looks
exactly as before.

It refreshes at most once every ten seconds while the page is open, on
the events that change the answer (a message, a save, an index change);
a presence tick only flips the live mark on a row in place, so the strip
never rebuilds under a click.

## Trade-offs, stated

- **Ceilings, not weights alone.** A pure `CPUWeight` would let a guest use
  idle cores, which is friendlier; a quota is a hard promise that the
  owner can state to someone watching a demo. Both are set, weight for
  contention and quota as the cap.
- **The caps are persistent unit configuration** (files under
  `~/.config/systemd/user.control/`), not runtime state. That is what makes
  them survive an idle slice; it also means they outlive an aiconvo that
  was uninstalled without removing guests. `systemctl --user revert
  aiconvo-guest-<id>.slice` cleans up by hand.
- **Same uid still.** A cgroup bounds resources; it is not a second user.
  The design/53 trade-off stands.
- **Network stays on inside the walls.** Unchanged from design/53; the
  proxy the guest's Pi talks to is on loopback, and a network namespace
  would cut it off. LAN services that trust locality remain the open item.
- **A human member's commit matches by exact roster name only.** No fuzzy
  matching of emails to people: a wrong attribution is worse than a
  missing one. Guests are always exact, by email.
- **Agent edits count for every writer of the conversation**, not only the
  one whose message the agent was answering. Two people driving one
  conversation both get the file; the conversation link shows which.
- **Commits copy a hash** rather than open a view. Stated above.
- **Fourteen days, no picker.** Longer windows on a big project mean reading
  many cached transcripts per request; the `days` parameter exists (≤ 90)
  for a later control, the page does not offer it yet.
- **Owner's other devices never show as "others"**: the roster's aliases
  resolve to one person before counting, the rule set in design/46.
