# 41 — Notebooks that just run

## The moment this serves

"Here is a Markdown notebook; run it." From the phone, the tablet, VS Code,
a terminal, or an agent — on this machine or the next one. Before this
note, a cell run from aiconvo could land on the wrong kernel (`py@docs`
because `docs/` carried a `requirements.txt`), on the wrong interpreter
(no `dspy`), or on no rat at all ("the rat CLI is not installed"), and the
only repair was a per-cell `uv pip install` that no other machine would
ever see.

## Model

Three responsibilities, each in one place:

- **The notebook declares what it needs** — in its front matter, under
  `rat:` (`project`, `python.requires`, `python.dependencies` as
  `requirements.txt` lines). PEP 723 blocks in python cells merge in. The
  format is rat's; aiconvo only reads and edits it
  (`notebook-env.js`). A local checkout (`-e .`), a git branch
  (`name @ git+…`) and a published package are each one line, so the
  awkward development layouts are ordinary.
- **rat makes it true** — `rat doctor <notebook> --json` (the plan,
  nothing changes) and `rat ensure <notebook> --json` (venv via uv, install
  only what is missing, restart the kernel only when its binding changed
  or an editable install needs a fresh interpreter). Idempotent: a receipt
  in the venv plus an interpreter check make the second call a no-op.
  `rat run --doc <notebook>` resolves the same kernel every client gets.
- **aiconvo shows and asks** — the strip under the editor carries rat's
  answer (kernel · environment · Python) and, when something is missing,
  one line of ✗ items with **▶ make it run**. Nothing installs without a
  click; destructive steps (`--recreate`) are offered by their real name
  and confirmed. A failed `import` offers **＋ declare → rat ensure →
  rerun**: the requirement goes into the notebook's front matter first
  (one undo step, autosaved), then rat installs it, then the cell reruns.
  The repair leaves a trace the next machine can follow.

## Boundaries kept

- No MCP client, no kernel state, no environment logic in this server: it
  locates rat (`RAT_BIN`, then PATH, then rat's own install dirs — with a
  note when the fallback is used), passes the notebook path through, and
  relays JSON. Project detection lives in rat and is now ranked (a venv,
  then a repository/package manifest, then weak hints), so every client
  agrees on which project a notebook belongs to.
- The focused (checkpoint-review) view stays minimal: a ready notebook
  shows the strip only after the first run; one that needs setup shows
  the setup line at open, before a run can fail.
- The document text is the user's: the only edit aiconvo makes is the
  requirement line the user asked for, through `NotebookEnv.addDependency`,
  which refuses front-matter shapes it does not understand instead of
  guessing (the person is then asked to add the line by hand).

## Handing it to an agent

When the strip shows something rat cannot fix on its own — a header that
names the wrong folder, a cell that fails for a code reason — **ask an
agent to fix it** opens the file's Ask panel with a brief built from the
doctor report: every check with its hint, the prerequisites and whether
they ran, `ensure`'s plan, the `-e` lines the environment actually uses,
and the last failing cell's output. The brief also carries the rules that
keep the fix durable: declare in the header, never pip in a cell, do not
replace what is installed, prove it with `rat play` before claiming
success. Commands are written as the agent will run them, from the
project root. The person reads and edits the text; nothing is sent until
they press send — the same rule as every other prompt in aiconvo.

## A notebook from an answer

The conversation is a trace; a notebook is a document. An answer is never
turned into a notebook in place — a notebook is **derived** from it, lives
on disk as an ordinary file, and points back:

- **Trigger:** the quiet `notebook` action beside copy/read on an assistant
  answer (pi conversations). One click, one model call, nothing runs.
- **Pass:** `pisdk.piDeriveAt` on a **private fork** of the session at that
  answer (`piForkAt` into a staging directory the watcher never sees). The
  snapshot session prepares the request exactly as the real conversation
  would — same system prompt, same tool schemas, history through the answer
  — and the stream function is intercepted before the agent loop can act:
  the captured request is sent once, raw, with the fixed prompt appended
  and the lowest reasoning level. There is no tool runner in this path, so
  nothing can execute; the provider prefix matches the conversation's, so
  the cache can be reused. The snapshot is deleted afterwards; the real
  session file is never written. Usage lands in the internal ledger
  (`aiconvoPurpose: notebook`).
- **File:** `<project>/documents/notebooks/<date>-<slug>.md` (a loose
  conversation uses the folder it ran in; the home folder is refused). The
  model writes `title` and `rat.python`; the server owns `rat.project`
  (relative pin) and `source: {conversation, entry, model, created}`. rat
  validates the header before the file is published. A second derivation
  from the same answer gets a `-2` suffix: a file the person may have
  edited by hand is never overwritten.
- **Chains:** the prompt lists this conversation's earlier notebooks; the
  model may declare `rat.after` for one it truly continues from, and only
  from that list (invented entries are dropped and reported). rat runs the
  chain first, once per kernel (`rat play --prerequisites`), which the
  document view does before the first cell of a dependent notebook.
- **Cards:** under the answer, drawn from the files' own front matter
  (`/api/doc/notebooks` scans the folder) after every transcript render —
  the disk is the index, so a re-render or a fork cannot lose them.

## Not here (deliberately)

- Installing tools for other languages (tmux for shell cells, Rscript,
  julia, node): `doctor` reports them; the Python plan proceeds. The
  tool layer (PATH → nix/brew/winget/download) is a separate step.
- Marking documentation-only cells (a tutorial's `pip install …` line) as
  not runnable. mrmd has no convention for it yet.
- Streaming `ensure` progress. The strip shows elapsed time and the step
  list arrives at the end; long installs are legitimate (30 min cap).
- A whole-conversation export as one notebook. That is a different button
  with a different prompt; keeping them apart keeps each honest.
- Claude conversations: the derivation replays pi's prepared context;
  Claude sessions cannot be replayed this way.
- Packaging aiconvo itself for Mac/Windows/Linux. See the roadmap in the
  conversation that produced this note (aiconvo, 2026-09-18).
