# 28 — Areas: declared inner scopes of a project

## The two needs behind "start in a subfolder"

The request hides two different needs. Keep them separate:

1. **Tool scope.** "Run the agent in this subfolder." That is a **launch
   parameter**, not an identity. The start form passes a relative `cwd`;
   nothing else changes.
2. **Own memory.** "This subfolder has its own overview, intent, environment,
   and status." That is an **identity object**: the area.

## Deep intent

**Let the place of work carry the intent of work.**

- **Scope.** The cwd is the strongest prompt an agent gets. A subfolder cuts
  the blast radius.
- **Memory granularity.** A project's `status.md` averages everything. A long
  sub-thread (an experiment, a component, a rewrite) drowns in it.
- **Prospective structure.** Epics are retrospective: the system discovers
  them after the work. An area declares a focus *before* the work, and memory
  accumulates into it.
- **Place as commitment.** aiconvo is directory-first. A folder is a durable,
  tool-visible, git-visible statement. It survives cache wipes.

An epic is a **story** (time). An area is a **place** (space). The two types
stay separate. A later bridge may let an epic take a home folder; the concepts
do not merge now.

## Mental model

**An area is the inverse of a fold.**

- A fold merges many directories into one project name.
- An area splits one project into declared inner scopes.

Both are small user-data files under `~/notes`. Both are exceptions to one
unchanged default: everything under a project root belongs to the project.

Rules:

- **Opt-in, never automatic.** Auto-detection turns a monorepo into noise.
  The user declares each area.
- **Nested, not sibling.** An area lives inside its parent everywhere:
  breadcrumb, memory tree, project view. It never gets a home Gantt lane.
- **Membership by cwd, deepest declared prefix wins.** Membership is a pure
  function of cwd + registry, so declaring an area over an existing folder
  adopts its past conversations retroactively, and removal only removes the
  scope. Disk is truth.
- **Fold-aware by construction.** Matching is rel-path based (the path below
  the project root), so worktree checkouts share the same areas as the main
  checkout, and the registry keys on the canonical project name.
- **Recursive in the model, flat in the UI.** One visible level for now.
- **Areas only inside real projects.** No areas in loose space — that would
  grow a second, weaker project system.

## Memory: one new aggregation node, no new pipeline

The memory pyramid (design 27) separates immutable per-conversation leaves
from regenerated documents. An area adds **one more regeneration scope over a
subset of the same leaves**:

```text
project docs  ← pure function of ALL project leaves
area docs     ← pure function of the leaves whose conversation sits in the area
leaves        ← unchanged: one per conversation, extracted once, shared
```

- Zero new extraction cost. Zero new leaf-layer model calls.
- Area docs are the same four files (`overview.md`, `intent.md`,
  `environment.md`, `status.md`) under
  `~/notes/aiconvo/projects/<project>-<hash>/areas/<rel-slug>/`.
- The docs-regen debounce refreshes area docs on the same trigger as project
  docs, and only when an area manifest already exists (opt-in, like projects).
- Neither scope mutates the other. Both regenerate from leaves only.

## Data model

Registry, next to the fold aliases (user data, survives cache wipes):

```json
// ~/notes/aiconvo/projects/areas.json
{ "aiconvo": { "experiments/vector-search": { "createdAt": 0, "title": "…" } } }
```

Logic lives in `areas.js` (pure, tested): rel normalization (rejects `..`
and absolute paths), project-root/rel resolution from a cwd, deepest-prefix
membership, slugs.

## Lifecycle and UX

- **Birth** mirrors the project birth ritual, one level down: relative folder
  (created or adopted), optional display title, optional **vouched**
  `intent.md` seed, optional first prompt that starts the first conversation
  in the folder. Form: `⊞ area` on the project panel footer.
- **Start "where".** The reviewed-start dialog gains a `where` select:
  project root (default), a declared area (identity + scope), or a plain
  subfolder (scope only). Changing it rebuilds the context preview.
- **Briefing order — narrow before wide.** Area memory first, then project
  memory, then recent conversations. Both the briefing map and the inline
  context bundle follow this order.
- **Project panel.** One card per area: title, rel, conversation count, last
  activity, memory freshness, `+ start here`.
- **Area view** (`#project=<name>&area=<rel>`): the project panel shape,
  scoped — mini Gantt, memory summary, conversation list, the four documents,
  regenerate, and `un-declare`.
- **Breadcrumb.** `home ▸ project ▸ area ▸ conversation`. The area segment
  appears on any conversation whose cwd sits inside a declared area.
- **Promotion / demotion** are re-interpretations of the same disk state:
  promote = register the subfolder as a created project and pin its name;
  demote = fold back and declare the area.

## Start-cwd safety (shipped with this design)

- A project start never falls back to home in silence. A missing project
  root is an error; a home-rooted conversation would index as Loose.
- The project root pick prefers the true root: a conversation run in a
  subfolder can no longer make that subfolder the project root.
- `area` and `cwd` on `/api/project/start` accept only normalized relative
  paths inside the project root.

## API

- `GET /api/area?project=&rel=` — area view payload.
- `POST /api/area/create` `{ project, rel, title?, intent?, firstPrompt? }`.
- `POST /api/area/remove` `{ project, rel }` — registry only; disk stays.
- `POST /api/project/start` gains `{ area?, cwd? }` (both relative).
- `POST /api/project/context` gains `{ area? }` — area docs ride first.
- `GET /api/project?name=` gains `areas: […]`; recent rows gain `area`.
- `GET /api/project/memory/file` and `POST /api/project/memory/regenerate`
  gain `area`.
- `GET /api/project-folds` gains `areas` (canonical project → declared rels)
  for client-side labels and grouping.

## Later, not now

- **Area suggestions**: when N conversations share a stable deep prefix,
  suggest a declaration — the fold-suggestion pattern with a dismiss list and
  a path denylist (`src`, `tmp`, `node_modules`). Precision over recall.
- **Epic ↔ area bridge**: an epic takes a home folder and becomes an area.
- Area grouping inside the project timeline rows.
