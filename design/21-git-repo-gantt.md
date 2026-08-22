# 21 — Git repository Gantt

## Purpose

Browse every local Git repository and worktree. Compare two commit (or working-tree) points of one file. Annotate the compare view. Send the page to a new coding agent with project memory.

This view does not use AI conversation events.

## Entry

The **repos** tab lists discovered repositories. Press **4**. Deep links: `#git` and `#git=<absolute-root>`.

Discovery walks `~/Projects`, `~/src`, `~/code`, and the home directory. It also includes conversation working directories. Linked worktrees appear as separate roots.

## Chart

Reuse the file Gantt:

- One row is one repository-relative file.
- Diamonds are commits that touch that file.
- A right-edge bar is the working tree.
- There are no AI squares.

The focused tree lists tracked files (`git ls-tree -r HEAD`) plus working-tree paths.

## Compare

Keyframes are Git commits and the current file only. Snapshots are exact blobs or the file on disk.

## Ink send

**send** starts a new Pi or Claude session in the repository root. The prompt includes the ink PNG, the compare points, and, when aiconvo already has project memory for that directory, the project briefing and current notes.
