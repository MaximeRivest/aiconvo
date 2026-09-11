# Task reviews and location-aware repair

## Corrected review meaning

Schema-2 reviews default to **This task**, using explicit write/edit targets.
Whole-checkout differences remain under **Other / unassigned**. Bash file-write
candidates and copy destinations are references/artifacts, not proof of authorship.
A polling command does not own changes that happened while it waited. Known edits
by another conversation to a targeted file are marked shared; this detection is
bounded and is not a guarantee of exclusive authorship when no conflict is found.

Workspace boundary completeness, task-file version availability and artifact
availability are separate concepts. Omission from a Git-filtered manifest is not
proof that a file did not exist.

## Location identity

`task-locations.js` retains host, execution directory, original reference and
resolved path. It handles common POSIX SSH/cd/heredoc, rsync/scp, redirection and
literal file-writer patterns without running shell text. SSH paths never default
to the local cwd. Copy commands connect remote references to local copies, even
when the copy appears later in the same conversation. Existence does not prove
remote-content equality. Unknown substitutions, remote home directories and
unsupported subshells remain unresolved.

The older shell mutation cache version is bumped so newly indexed file activity
uses the qualified local outputs rather than flattened remote filenames.

## Capture

The awaited tool hooks capture explicit local write/edit targets before and after
execution, independently of Git ignore rules and workspace snapshots. Their bytes
share the existing private Git object store and compressed-blob budget. Private
blob refs preserve targeted versions even when the workspace tree excludes them.
Deletion is recorded distinctly from unknown or unsupported contents.

Folder capture is explicit and reversible: **View → Include an experiment
folder** changes private capture policy, not `.gitignore`. It affects future
updated workers, not historical snapshots. It does not disable direct-target
capture when removed. Obvious credential/key paths, symlinks and binary contents
are excluded; these protections are not a universal secret detector. Broad home
or `/tmp` launch directories capture only explicit targets, not whole-directory
scans. Targets outside the main workspace are limited to the owner's home/tmp
roots. Existing per-file archives are retained and can support recovery.

## Repair and saved data

**View → Rebuild task review** creates a new immutable review version. Original
reviews and comments remain linked and unchanged; comments are not automatically
moved to guessed file locations. Updated evidence gets a linked successor rather
than quietly replacing a comparison. Live-file changes alone do not change the
identity of an existing review.

Recovery can use captured target versions, checkpoint entries, older saved file
observations, and successful literal writes. Exact-string edit replay must apply
unambiguously and is labelled reconstructed, not independently verified. Missing
states are never replaced with invented empty files. Recorded endpoint labels
and times remain available in the recorded-file reader.

Combined cross-conversation reviews must be rebuilt at their original and
follow-up sources, then combined again.

## Optional model assistance

**View → Suggest unresolved locations** first shows the precise bounded input and
configured model. It makes one tool-free model invocation only after confirmation.
The payload contains reference metadata and selected command excerpts, not reads
of project source or `.env` files. Excerpts may themselves contain sensitive text;
redaction is best-effort and the user must inspect the preview.

Results are proposals. Local candidates must be regular files in an allowed
workspace or a recorded copy destination, pass sensitive-path checks, and be
explicitly accepted into a new review. This verifies current availability only;
it does not establish historical equivalence or replace snapshot identities.
Unknown hosts are not accepted from model output. No SSH commands are run by
repair or verification. Remote suggestions remain unverified metadata.

Request tokens prevent automatic repeat invocations; failures are persisted.
Model calls have a one-minute deadline, at most 20 references / 12 command
excerpts / 48 KiB of input and ten proposals. Provider-internal retries remain
owned by the configured model integration.

## Artifacts and access

Images/audio/video with a verified local path have a current-file preview, bounded
to 20 MiB. Text artifacts can expose recorded versions where available. Remote
files without a known local copy remain remote/unverified; background processes
and arbitrary scripts are not automatically instrumented on the remote host.
SVG/HTML are shown as text rather than executable documents.

An exact review-bound location can open outside the usual indexed repository
roots, without granting arbitrary path access. Requests revalidate the canonical
file, sensitive-path policy and size. A literal filename suffix such as `:123`
is not reinterpreted as a line number on this path. No arbitrary host application
is launched.

## Scope limits

This is conservative location analysis, not a complete shell/Python interpreter
or process-level file-effect tracer. Unobserved program-generated filenames may
remain unknown. Review analysis bounds command text, references and per-step file
entries, with visible resolution notes. Directory capture retains the existing
file/size/time budgets. It does not create isolated worktrees or serialize tools.

## Verified incident

A read-only audit of GeminiLive (`01a09064`, 2026-09-11), alongside DSPyReview
(`01a0901b`, same date), rebuilt the interpretation of review
`b7a4e5e8-9f9c-40a1-a6fb-b3d6a38c1ea8` in temporary storage. It recovered paired
observations for `scratch/wizard_voice/wizard.py` and `README.md`, separated 13
DSPy files into other/unassigned changes, and linked `resumed.log` to its local
copy. Production reviews were not modified and no remote/model call was made.

## Tests

`test/task-reviews.test.js` covers remote namespaces/heredocs/copies, ignored and
external target snapshots, concurrent polling, capture scopes and protections,
archive recovery, immutable repairs, media references and model-proposal gates.
`test/conversation-app.test.js` covers the scope selector, local artifact access,
forbidden asset paths, scope approval and rebuilt review links in a real browser.
The real Pi SDK probe verifies ignored-target before/after capture using the
actual installed runtime and a fixture provider.
