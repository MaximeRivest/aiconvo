# Conversation reading: paths, answers, comparison, and merging

The transcript is a readable path, not a dump of file-order entries.
Alternatives belong at the point of divergence. Reading never writes a
continuation; only an explicit continue, edit, fork, merge, or send can do that.

## Everyday experience

- One complete, full-width answer and its matching follow-up conversation.
  No default long-answer clipping, nested answer scrollboxes, or dimmed prose.
- Answer selectors and previous/next buttons live after the shared question.
  Changing the answer changes the whole following path, not just its border.
- Other paths show the first differing prompt/reply and a message count. A
  nested divergence remains a decision, not an automatic jump to the newest
  descendant. Previously read routes can be restored.
- The composer carries a persistent destination notice while reading another
  path. **Continue from here** changes continuation; **Return to current**
  changes reading only. Sending is blocked until this difference is resolved.
- **Copy**, **read**, and **more…** are the same message controls everywhere.
  The latter includes editing, regeneration, continuing, and forking. The tree
  is an optional overview; it uses the same editor and merge dialog.
- A fork is visibly a **separate conversation**, with an exact link to its
  origin. It is not a filesystem snapshot or an isolated working directory.
- Exact-entry links and search results project their containing path and open
  the necessary work disclosures. Messages without recorded ancestry remain
  available as explicitly unlinked history, not silently discarded.

## Comparison and merging

**Compare** deliberately opens a two-answer workspace. Desktop uses two
columns; narrow screens and binary/e-ink themes show one full-width pane,
with explicit first/second controls. Comparison does not choose a continuation.
Each preview offers **Read this path and its follow-up**. The boundary below
comparison names the path followed by the rest of the conversation.

**Merge…** is one native, keyboard-accessible dialog from both tree and reader:
choose at least two source answers, a model, and optional instructions. Sources
and the draft survive cancellation/reopening and transcript refreshes. Controls
cannot change while the launch request is pending. Errors keep the draft open.
The generated reply becomes the continuation; originals remain saved.

Merged replies retain a visible source line. Newly recorded merges identify
exact sources. Old merges without that record say so, rather than inventing
which answers were picked.

**Include all** includes answer text without synthesizing it. The bridge is a
snapshot: later regenerated answers are not retroactively included. The reader
checks reconstructed source text against the saved quote; if the source was
edited outside the app, the saved quote wins. Tool histories and images are not
combined into this context, even though original work remains reachable.

New parallel runs require an explicit choice before a follow-up. While workers
run, sending waits rather than attaching to an arbitrary worker. The live reader
uses the same width and message presentation, keeps worker status/failures, and
only retires a live stage when that particular run is represented in history.
An older answer group cannot suppress a newer run. Read/compare choice carries
from the live run into its recorded group.

Workers that own delegated conversations are not disposable fork files: the
existing reintegration safety rule retains those files and their parent links.
Their separate conversation paths remain available; the reader must not claim
that saving/reintegration completed when the server retained them.

## Implementation boundaries

- `conversation-flow.js`: shared pure ancestry, path projection, safe linear
  following, operation recognition, and meaningful divergence descriptions.
  Traversals handle cycles, missing ancestry, and out-of-order entries.
- `conversation-reader.js`: reading state, controls, shared message/work
  fragments, comparison, live presentation, source snapshots, and merge dialog.
- `conversation-reader.css`: full-width reading and responsive controls. All
  colors come from theme tokens; meaning does not depend on color.
- `app.html`: existing message, tool, file, audio, composer, route, and tree
  integration. Reading and sending use separate projections of the same graph.
- `fanout.js`: answer groups only under the same actual question; it will not
  cross a different user prompt. Regeneration is an explicitly marked exception.
  Packages include intermediate work and final text, stopping before the next
  question or ambiguous continuation.
- `server.js` / `fanoutmerge.js`: additive operation provenance, full answer
  responses, source identities, safe continuation changes, and reintegration.

Answer identity is separate from the trailing settings/label used as a native
continuation target. An appended label must not rename an answer or invalidate
its saved source selection. `entryIds` preserve the complete package. Source
message actions and file/media links carry the owning conversation key, never
assume the open conversation's array index or working directory.

New corrections record their original entry and human authorship. New parallel
prompts record their run identity. New merge and include-all records name their
source entries. New regeneration transport records its source entry. Legacy
history is interpreted cautiously, never rewritten for cosmetic consistency.
Only dedicated transport markers in the appropriate role are hidden; ordinary
“Continue.” and code examples containing marker text remain readable.

Reading state (routes, comparison pairs, disclosure choices, merge drafts, and
element-relative scroll positions) is saved locally, not into session files.
Unsent composer drafts stay with their own conversation while navigating;
they are not copied into another fork. Source sessions are fetched on demand
and only retained while needed by the current reading surface.

Explicit continuation changes refuse active writers and check the expected
file leaf, so an intervening change on another screen cannot silently replace
new work. Normal sends also check the snapshot they were composed against;
follow-ups to an already-running single-model turn retain the existing queue
behavior. These actions preserve chat history; they do not undo file edits.

## Trade-offs

1. Full-width reading is primary. Seeing multiple answers at once is an explicit
   comparison choice, limited to two readable columns rather than many narrow ones.
2. Selecting a new continuation costs an explicit action. This avoids reading
   one path and accidentally sending into another.
3. Complete answers can make a longer page. Work remains folded and alternatives
   stay at their divergence, but meaningful prose is not truncated to save space.
4. Old metadata can be incomplete. Neutral labels and the saved quote are better
   than a confident but incorrect explanation of past context.
5. The new parser refreshes derived caches on restart; original session bytes
   are not migrated. Matching frontend/server assets require a restart and reload.

## Verification

`node --test test/*.test.js`

Focused coverage:

- `conversation-flow.test.js`: projection, safe route following, cycles,
  classification, complete answer packages, reintegration provenance/retries.
- `conversation-api.test.js`: real tree/API projection, full text, stable IDs,
  source subsets, fork origin, stale continuation refusal.
- `conversation-reader.test.js`: browser path fidelity, nested choices, exact
  links, complete copy, foreign-source identity, merge drafts, Back, live status,
  settlement selection, included snapshots, and visible merge provenance.
- `conversation-app.test.js`: actual server and complete app against isolated
  session files; assets, path switching, composer notice, native merge dialog,
  phone comparison, no horizontal overflow, no session writes while reading.
- Existing delegation navigation tests retain raw work/card/entry access and
  verify GET-only reading; editing/fork/reintegration tests remain in force.
