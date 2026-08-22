# 15 — Project memory: intent, environment, status, and discovered epics

A project needs memory above individual conversations and epics. This layer must preserve why the project exists.

## Artifacts

Each build writes four Markdown files under `~/notes/aiconvo/projects/<project>-<hash>/`:

1. `overview.md` — purpose, vision, desired outcomes, principles, and non-goals.
2. `intent.md` — implementation-independent user intent with source message excerpts.
3. `environment.md` — setup, commands, services, addresses, paths, tools, and authentication methods.
4. `status.md` — recent focus, unfinished work, todo items, and open questions.

The build also saves its complete input and classification record under `~/.cache/aiconvo/project-memory/`.

## Intent pipeline

1. Read every project conversation and its current note or evidence.
2. Build a high-level project overview.
3. Inspect every user message.
4. Pair each user message with the preceding assistant response.
5. Classify durable intent: vision, motivation, outcomes, principles, constraints, preferences, and non-goals.
6. Send all selected messages to one synthesis pass when they fit the context.
7. Use hierarchical partial synthesis only when the selected set exceeds the safe context budget.
8. Save source session ids, message indexes, transcript paths, and user excerpts.

Routine commands and short-term implementation work are not intent unless they reveal a durable goal.

## Epic discovery

The project profile can propose coherent multi-session epics. It excludes candidates substantially covered by existing epics.
The project view shows candidates for review. **build epic** uses the existing evidence-backed epic builder.
No candidate becomes an epic without user confirmation.

## Environment safety

Never write passwords, access tokens, private keys, secret values, or copied credentials.
Write only authentication methods, environment variable names, commands, and credential locations.

## Freshness

A source hash covers every project conversation version and note version.
Any changed conversation marks the project memory stale.
A stale bundle remains readable until the user rebuilds it.

## New sessions

The project briefing lists all four project files first.
A new agent reads these files before epics, notes, or selected evidence.
