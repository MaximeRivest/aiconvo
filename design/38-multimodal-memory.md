# Multimodal memory with explicit automation boundaries

Status: opt-in implementation and synthetic regression coverage in this branch. Not installed,
not published, and not a claim of visual understanding or model quality.

## Scope and defaults

One upstream feature: supply source-backed images to an explicitly configured internal model
for conversation summaries and memory, with AI-title controls and a durable automation boundary.
The web conversation engine/model remains separate. No speech, CRDT, cache-compression,
delegation, GPU/runtime-lifecycle, package-installation, or deployment changes are included.

| Setting | Default | Opt-in meaning |
| --- | --- | --- |
| `providerExtensions` | `{}` | Provider ID to trusted absolute extension entrypoint paths. These execute code; never derive them from transcript content. |
| `aiTitles` | `true` | Independent naming knob. `false` suppresses standalone naming calls, including conversation/project/epic retitles, automatic labels and commit-title amendments. |
| `memoryImages` | `false` | Supply supported source images with attributed message context. Requires exact internal provider/model selection, not Pi default selection. |
| `automaticMemory` | `legacy` | Independent memory-job knob. Explicit alternatives: `off` and `changes-after-enable`. |

These knobs do not substitute for each other: turning memory automation off must not stop AI titles, and turning titles off must not stop manual memory work. Unattended (`automatic: true`) is not memory consent.

Legacy preserves upstream triggers and historical retry queues; **legacy is not a no-backfill
policy**. `off` prevents automatic memory work without removing manually requested operations.
The new policy is a separate consent boundary, not a freshness/mtime heuristic. Partial settings
updates preserve omitted fields. Exact provider/model IDs and trusted paths can be entered even
when the provider is absent from the cached catalog; invocation still requires exact resolution.

AI-title-off is checked at entrypoints, timers, the common naming-call boundary, and before title
publication. Existing titles are retained; new note paths use deterministic session-specific
suffixes to avoid same-date/same-title collisions. Abstracts and structural headings remain.
Multimodal notes reuse their already generated abstract rather than making another naming call.
An already transmitted naming request cannot be recalled; disabling prevents its title from
being applied at the subsequent guard.

## Modules and input contract

- `memory-images.js`: bounded stable source snapshots, image validation, hydration, ancestry,
  attribution and packing.
- `internal-model.js` / `internal-model-worker.js`: private cold model-only transport;
  `internal-model-supervisor.js` / `model-process-group.js`: anchored group termination and verification.
- `multimodal-memory.js`: one attributed section analysis produces a visible note and memory
  leaf together. It validates the output schema and restores selected user text/ancestry from
  the source rather than trusting model-generated quotes.
- `memory-automation.js`: durable consent epochs, baseline revisions, pending phases and retirement.
- `source-watcher.js` / `memory-observation.js`: live creation observations and conservative origin qualification.
- `memory-intent-evidence.js` / `note-publication.js`: evidence identities and final title-permission publication.
- `memory-feature.js`: serial revision pipeline and server integration hooks.
- `memory-settings.js`: settings controls, activation confirmation, status/errors and explicit discard.

The parser accepts the captured source text, so attachment references and text come from the
same snapshot. Pi direct image blocks and Claude base64 images nested inside tool results are
supported, including image-only users. Each supplied attachment is identified by source entry,
block path, message index, content identity and attachment ordinal. Messages retain role,
parent and off-branch status. Preceding assistant context follows entry ancestry, not file order;
cycles, duplicate entry IDs, missing/ambiguous images and parser-skipped image blocks fail.

The model receives numbered message records plus an ordered attachment manifest and actual
`image` content blocks. Images stay with their message when packing and correcting output.
There is no URL fetching, Markdown-path inference, image argument normalizer or text-only/cloud
fallback. Source files are never modified. A resumed conversation is analyzed as its current
whole revision, including older context and off-branch alternatives; this is **not** delta-only
extraction. Ordinary parsed-text clipping for large tool arguments/results and thinking remains.

### Image support and validation limits

Supports **browser-produced JPEG** (8-bit grayscale/RGB baseline, extended sequential and
progressive framing) and **static PNG**, including grayscale, palette, alpha, supported 1–16-bit
depths and Adam7 interlacing. PNG checks include chunk CRCs, bounded complete zlib output and
scanline layout/filter bytes. JPEG checks bound marker/segment/scan framing, frame dimensions,
table presence and terminal EOI; **they do not decode Huffman/entropy data or certify every
compressed pixel**. Neither path is advertised as a complete codec. Unsupported coding modes,
WebP/GIF, animation, malformed structures and budget violations fail explicitly.

No external decoder or package installation was added. No resize/transcode is performed: source
bytes, hashes and actual provider-received blocks are checked by regressions, including images
created by real Chromium canvas JPEG encoding at the app's quality setting. Provider-side decoding
errors must surface; direct model invocation has no attachment-dropping normalizer or fallback.
These tests establish transport integrity, not exhaustive codec correctness or visual understanding.

Admission limits:

- 128 MiB UTF-8 JSONL source snapshot;
- 8 MiB per decoded image, 32 MiB and 32 images per session;
- 4 images per model request; width/height at most 2048 and roughly 4 million pixels;
- conservative reservation of 16,384 input tokens per image, text-byte estimation, 20% context
  headroom and response/instruction reserve. Actual model context is checked again in the worker.

A single attributed message that cannot fit fails rather than losing attachments. These are
conservative admission estimates, not provider-specific billing or exact token accounting.
Invalid input prevents inference/publication. `memoryImages:false` in the new automation mode
uses attributed text and explicit uninspected-image markers; those markers do not become
verbatim user quotes. Notes report **images supplied**, not a claim that every image was understood.

Multimodal manual distillation, leaf extraction and epic evidence use the same grounding path.
The automatic pipeline saves both outputs from one analysis. Existing project/area/epic rollups
consume already-grounded leaves as text, not a second copy of their images. Default text-only
manual distillation retains its existing upstream pipeline.

Intent rollups preserve force, situation, quote, branch, entry/ancestor IDs and image identities
through weighing and rendering. Both lane hashes and incremental weighing IDs bind all that
evidence: editing a quote or its ancestry/branch forces synthesis instead of reusing old tiers.
An actual server/API regression changes “Never deploy” to “Deploy now” and its branch while
retaining the abstract, then checks new weighing/synthesis calls and the rendered attribution.

Image-bearing fingerprints bind raw source bytes, image mode and internal-model configuration.
Changing image bytes alone invalidates them. Old text caches cannot claim current image-bearing
leaf freshness. A mode/cache re-index alone does not become a source-change eligibility signal.
Historical leaves/documents are retained, not retroactively declared visually grounded.

## Model-only transport boundary

The worker uses installed Pi's `ModelRuntime`, not an `AgentSession`, RPC agent loop or warm web
worker. It was exercised with installed Pi **0.84.4** and a network-free fake provider.

1. Copy only the selected provider's `models.json`/`auth.json` entries into an owner-only temporary
   agent directory under `TMPDIR`; never write credentials/settings back to the configured agent.
2. Canonicalize trusted paths and verify readable regular entrypoints (symlinks to such files
   are allowed). Load only those paths, with ambient extensions, context files, skills, templates
   and themes suppressed. Register only the selected provider's registrations.
3. Reject loader/configuration errors, missing SDK capabilities, fuzzy/unresolved model IDs and
   models that do not declare image input when image mode is enabled. No catalog network refresh.
4. Parent rechecks authorization before invocation. Construct one user message and a fixed
   evidence-only system message, with `tools:[]`; call `streamSimple` once with `maxRetries:0`.
5. Reject provider errors, truncated responses and tool requests. There is no agent continuation,
   compaction or tool executor. Check consent/source again before returning/publishing.
6. A separate supervisor anchors the owned process-group ID even after the model worker exits.
   SIGTERM is followed by bounded group SIGKILL while that anchor still exists. Wait for the
   direct child and verify no live group members in Linux `/proc` before removing temporary state.
   Never signal a retired PGID. Unexpected anchor loss/unverifiable cleanup fails and retains
   temporary state; it is not reported as successful cleanup. Zombies may remain until reaped.

The common routing seam preserves explicit and inherited automatic status/epoch before invocation
and return. Image mode reroutes memory document helpers, not unrelated review/naming/text helpers;
raw multimodal summary/leaf/evidence calls and durable automatic tickets use the model-only worker.
Static `models.json` provider/model IDs need no dummy extension or cached catalog membership;
exact runtime lookup still rejects bad IDs without a fallback.

**Compatibility limits:** extension factories must register usable static model/provider
information without requiring session/input/payload hooks. Such hooks are rejected explicitly;
a provider that only discovers models dynamically must have a usable static definition first.
The implementation consumes both registration queues, but fixture evidence uses the legacy
`registerProvider(name, config)` form. Compatibility with any particular native/custom provider,
its authentication and image support remains unverified. No package was installed to bridge this.

Trusted extension code is not sandboxed application code. It can perform its own side effects;
its implementation must honor the selected endpoint and retry contract. The application does
not select a fallback provider/model, and requests zero provider retries, but cannot certify
arbitrary extension internals. The no-network sandbox is a **test boundary**, not a deployment
sandbox. Factory code executes before post-load hook compatibility checks; those checks cannot
undo factory side effects. Already transmitted requests may still finish remotely after local
cancellation. An operator factory requiring cleanup/health-probe side effects during loading
needs an owner-approved registration-only entrypoint before a canary; ignoring hooks is not a fix.
The worker loads only the trusted absolute paths in `providerExtensions` and still rejects any
extension that registers lifecycle/input/payload handlers.

## Durable automation and recovery

State lives in `~/.config/aiconvo/memory-automation.json`, outside disposable caches. Atomic
replacement fsyncs the state file and directory. Activation scans raw revisions without
inference and acknowledges only after persistence. A fresh upstream install retains legacy
behavior; configured new-policy work with missing, corrupt, inconsistent or externally changed
state fails closed. Manual operations are not converted into consent.

Each enable/disable transition gets a new epoch. The active record contains baseline hashes
and pending records with revision, epoch, status and stage. Non-done records from retired epochs
are retained for audit and never become eligible in a new epoch. In-flight retired work is
marked interrupted. The current state is checked against disk before claims and acknowledgments;
losing state during a call does not silently recreate consent on completion.

Eligibility is intentionally conservative:

- An indexed file already in the baseline must acquire a different observed raw revision.
- An unfamiliar file can qualify immediately when the active controller records its live
  creation (including a live-created directory), the same inode/device/birth time remains, and
  both filesystem birth time and a parseable session-origin timestamp are after activation and
  no later than observation. Its creation event, origin, birth time and observation provenance
  are persisted. This includes genuine new one-shot sessions.
- First discovery after restart/downtime or initial watcher enumeration is not a creation event.
  Old imported logs, missing metadata, future/clock-anomalous timestamps and absent creation
  evidence are baselined. A later actual revision change to those baselined files qualifies.
- A source revision observed by a late stale parse cannot replace the activation baseline.
- Cache version changes, cache deletion and re-indexing do not themselves authorize work.
- Source-format/metadata byte changes count as source revisions; this is not semantic-delta detection.

Creation qualification assumes filesystem birth-time support, observable watch events and producer/
host clock agreement. Pi's session-header timestamp or Claude's first UUID-bearing conversation
record supplies origin time. These are **not cryptographic provenance**: forged/re-written origin
metadata or a recently created imported log satisfying all the bounds can look like live creation.
Missing watch events/roots or conservative clock checks can baseline genuinely new files. We do
not infer creation from mtime/cache recreation alone or relabel restart discovery as live creation.

The existing ten-minute settle interval/two-minute sweep drives a separate serial pipeline:
claim one revision; build summary and leaf; publish both; refresh already-built affected
project/area/epic documents; acknowledge that exact revision. Provider subcalls in concurrent
legacy rollup helpers are serialized within this ticket. Unbuilt memory collections are not
bootstrapped by a hidden backfill. Persisted stages show partial progress and errors.

Queued, unclaimed revisions survive restart. Running records become interrupted, with no
automatic replay. Model/transport failures remain errors rather than joining the old model-health
retry queue. Malformed JSON/schema gets at most one correction with identical attributed input
and attachments, guarded again before the call. There is no automatic health-probe inference.
Discard is explicit and performs no inference; same-revision work is not automatically retried.
A new consent epoch requires a fresh baseline, not adoption of old manual/backfill retries.

Guards run before each subcall, retry, stage and guarded publication. An old completion cannot
acknowledge newer pending work. New-policy notes/leaves/documents use guarded atomic replacements
and fsync before the final state acknowledgment.

### Publication/recovery limitations

- Single AIconvo controller/writer is assumed. There is no cross-process lease or coordination
  with another server writing the same consent or output files.
- Source files are not locked. Guards check revisions at publication boundaries; they are not
  an atomic transaction with external transcript writers.
- The note, leaf, documents and manifest are separate atomic files, **not one transaction**.
  Interruption can leave a published note/leaf or some documents with an interrupted/error phase.
  Already published output is not deleted on disable. Outputs retain source identity; operator
  recovery must inspect partial results rather than silently replaying the whole job.
- Existing leaves and document metadata still use upstream cache locations. Deleting those
  caches does not delete consent or authorize reconstructing historical results with inference.
  Visible note files remain, but cached note links/leaf coverage may need explicit recovery.
- The model-only helper now explicitly requires Linux for whole-group exit verification. It
  does not promise Windows support. Trusted descendants that deliberately create a different
  session/process group are outside the owned-group cleanup contract. Power-cut durability and
  exhaustive filesystem fault injection are not proven by these fixtures.

## Evidence and separate rollout gates

Baseline and final full suites use the same private HOME/TMPDIR sandbox with network/PID/IPC
isolation, read-only source/installed dependencies, hidden host homes and no real credentials or
history. Logs are retained in owned scratch, not in this proposal. No existing test was changed
or skipped to manufacture green output.

Baseline: **452 tests; 450 passed, 1 failed, 1 skipped**. The pre-existing failure is
`project-create.test.js:64`, “explicit setup rejects relative and general folders”; the skip is
the existing NixOS sudo case. After the acceptance repairs below, the full suite reported
**570 tests; 568 passed, 1 baseline failure, 1 existing skip**. This is not a clean-full-suite
claim. Exact logs and source-hash receipts are retained outside the upstream changes.

### Executable Gherkin-style red-green repairs

The original draft was not developed under a retrospectively claimed TDD process. Following
review, four executable Given/When/Then scenarios in `test/memory-acceptance.test.js` were
observed failing before production fixes: two timeline revocation cases, malformed JPEG
admission, and stale image-evidence epic publication. Their original events/assertions remain.

The repair sequence was RED, minimum GREEN by behavior group, then refactor while green.
Additional first-failing scenarios live in `test/memory-jpeg-acceptance.test.js`,
`test/memory-timeline-acceptance.test.js`, and `test/memory-epic-acceptance.test.js`. These use
Node's existing test runner, not an added Cucumber dependency. The final original-four rerun
passed 4/4; expanded acceptance passed 71/71; post-refactor selected regressions passed 87/87.
Failed candidate attempts and fixture-only adjustments were retained in the evidence record;
a mixed-module fixture replay is not represented as the original RED baseline.

The repaired publication paths preserve source/model/automatic guards through intermediate
calls, retries, per-item title changes, guarded atomic writes and in-memory publication.
Earlier individually published files may remain if a later file's guard rejects; this is
explicitly tested partial publication, not a multi-file transaction. JPEG admission checks
marker/table/component/scan structure but still does not claim entropy or pixel decoding.

New coverage includes actual fake-provider image blocks/order/model/tools, no hidden tool
continuation or retry, unsupported hooks/configuration failure, temporary cleanup, direct/nested
attachments, image-only turns, branches, malformed inputs/budgets, source drift, cache/mode
identity, epochs/no-backfill, live-new one-shot provenance and clock anomalies,
restart/interruption/stale completion, serial note+leaf/document work, title revocation during
awaited directory/temp-file writes, real browser controls, actual cached rollup regeneration,
static-provider routing and isolated server API activation/import/cache-rebuild behavior. Injected pipeline tests do not prove every real rollup's model-generated content.

Still required before rollout/publication:

1. Independent adversarial review, especially the conservative coverage and partial-publication
   contract, plus resolution/acceptance of the baseline failure.
2. Separately authorized small local summary/vision canary with the operator's exact configured
   provider/model and trusted extension. Verify actual visual facts, latency, budgets, settings,
   title-off behavior and provider compatibility. Fixture success is not this proof.
3. Only then explicitly choose images on, AI titles off and changes-after-enable for rollout.
   Do not silently start a historical batch or modify the existing running installation.

Rollback disables automatic work, preserves originals and retired pending/interrupted records,
and restores the prior deployment without deleting user data. Deployment/configuration changes,
commits, pushes and publication were not performed by this implementation task.
