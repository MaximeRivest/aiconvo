# 18 — Git-weaved file Gantt

## Purpose

Show how AI work moved through project files and became repository history.
The chart combines agent edit/write tool calls, common shell mutation paths, Git commits, branches, and the current working tree.

## Truth levels

The interface must keep three facts separate:

1. **Agent event** — an edit, write, or recognized shell mutation was attempted.
2. **Applied event** — the tool result reported success.
3. **Committed change** — Git records a file change in a commit.

A link between an agent event and a commit is inferred. It is never shown as certain without content evidence.

## Chart

- Time runs left-to-right.
- One row represents one repository-relative file.
- Squares represent AI edits and writes.
- Diamonds represent Git commits touching that file.
- A right-edge marker represents an uncommitted working-tree file.
- Dotted lines connect inferred AI-event and commit pairs.
- Row labels stay fixed while the time surface scrolls.
- Search and branch filters reduce the visible rows and marks.
- Zoom controls use hours, days, and weeks.

## Provenance

Each AI mark links to:

- Tool-call diff.
- Conversation.
- Agent and timestamp.
- Conversation branch.
- Tool result and outcome.

Each commit mark links to:

- Full and short commit hash.
- Subject, author, and commit time.
- Parent commits.
- Containing branches.
- Changed files and patch.

## Pairing

Candidate commits must touch the same repository-relative path.
Prefer commits after the AI event and within 14 days.

Calculate confidence from:

- Exact committed blob equality for full writes.
- Added-line overlap with `newText`.
- Removed-line overlap with `oldText`.
- Time distance.
- Conversation branch membership.

Confidence levels:

- **high** — exact blob or very strong content overlap.
- **medium** — substantial content overlap with compatible time or branch.
- **low** — weak content, or time and branch evidence only.
- **none** — no responsible match.

Failed tool calls never pair to commits.

Common shell mutations include redirects, `mv`, `cp`, `rm`, `touch`, `truncate`, `tee`, in-place `sed` or `perl`, patch headers, and literal Python file writes.
Arbitrary program side effects cannot be reconstructed safely. Keep them outside attribution unless Git or another source proves the file change.
Unpaired successful events show as committed-unknown, working-tree, superseded, reverted, or otherwise unresolved.

## Repository and branch reconstruction

- Resolve each conversation working directory with `git rev-parse --show-toplevel`.
- Preserve the branch recorded in the transcript.
- Read commits from all local and remote refs.
- Build branch membership from ref tips and `git rev-list`.
- Read the working tree with Git porcelain status.
- Support more than one repository inside one project group.

## Performance

- Cache parsed tool calls by transcript file version.
- Cache Git history by refs and working-tree signature.
- Return small timeline events first.
- Load full AI diffs and commit patches only after selection.
- Cap initial file rows and Git commit count explicitly.

## API

```text
GET /api/project/file-history?name=<project>
GET /api/project/file-history/commit?name=<project>&repo=<root>&hash=<hash>
```

The response includes repositories, rows, AI events, Git commit marks, inferred pairs, and working-tree status.
