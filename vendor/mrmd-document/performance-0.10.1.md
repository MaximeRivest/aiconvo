# Markdown editing performance — 0.10.1

Investigated and measured on 2026-09-10. Source changes are in
`../mrmd-packages/mrmd-editor` relative to the aiconvo repository.

## Cause and changes

The block StateField scanned the document again on every explicit selection,
even moving one column. The inline renderer also scanned the whole document
for code ranges, reference definitions, details and admonitions. Table and
admonition scanners repeatedly called `doc.line(n)` instead of traversing
CodeMirror's text tree sequentially. Linked-table discovery built a line table
even in documents without linked-table headers.

- Weak caches key off immutable CodeMirror Text, not sampled hashes. Separate
  syntax-aware caches also check tree identity: parsing can advance without
  an edit. Edits cannot reuse stale positions. Weak keys avoid retaining closed
  documents solely because of these caches.
- Block rendering reuses decorations on same-anchor-line selections; changing
  explicit reveals, configuration, document or syntax tree still rebuilds.
  Head-only selections that expire a details reveal are handled separately.
- Code-block decorations are limited to viewport lines while retaining the
  intersecting fence's full bounds and language. Details line exclusion sets
  are bounded to the viewport too.
- Table/admonition fallback scans use sequential line iterators. Math scans
  skip syntax traversal only if neither supported opening delimiter exists.
  Linked-table scans skip parsing only if the parser's exact header is absent.
- Reference lookups use document-specific maps; legacy global lookup APIs
  remain updated. Equal-length edits no longer collide with sampled hashes.

## Deliberate limits

This is not an incremental Markdown parser rewrite. Text edits still run full
structure scans where required, then rebuild block widgets through the existing
rendering path. Markdown changes can affect blocks far from the edit (fences,
math pairing, reference definitions); limiting that work to the changed line
would risk stale or missing content. Source mode retains rendering extensions
and their existing styling/height reservations. No save, provenance, execution,
file format, or undo behavior was intentionally changed.

## Measurements

`npm run bench:document` uses Chromium and the host's external-scroll-container
layout. It inserts 30 characters and then performs 30 cursor moves, allowing
an animation frame between operations. Fixtures repeat formatted paragraphs;
only 31 lines are in the DOM. Times below are synchronous dispatch medians,
**not** full input-to-screen latency. Hardware load and document contents matter.

Final comparison, milliseconds:

| Lines | Markdown edit 0.10.0 → 0.10.1 | Cursor 0.10.0 → 0.10.1 |
|---:|---:|---:|
| 401 | 4.4 → 3.6 | 1.8 → 1.5 |
| 4,001 | 13.2 → 6.7 | 8.2 → 1.6 |
| 20,001 | 30.9 → 11.8 | 28.8 → 1.0 |

At 20,001 lines, source-mode edit medians were 31.9 → 11.3 ms, cursor
27.6 → 1.4 ms. Earlier runs varied, but showed the same scaling improvement.
Set `MRMD_BUNDLE=/path/to/0.10.0/mrmd-document.iife.min.js` to run the baseline.

## Verification

- `npm test`: existing math/frontmatter/linked-table tests plus cache identity,
  equal-length edits, independent documents, parser reconfiguration, legacy
  reference lookup, block-decoration reuse, table offsets/structural edits,
  both math delimiters, fenced-code exclusions, and source/readonly transitions.
- `npm run test:document`: real Chromium tests of the lightweight minified
  artifact: table reveal/type/undo, details reveal and head-only exit, source
  and readonly switching, bracket math, scrolling inside long fences, fence
  endpoint/language styling, and offscreen admonition headers.
- `npm run build && npm run test:render`: existing full-editor browser suite,
  including stable block heights while typing, click-to-edit, comments,
  drag-selection across output widgets and reading mode.
- Aiconvo: `node --test test/document-bundle.test.js` checks route/artifact
  consistency, concurrent loading, fallback on old servers and retry after
  failure; `node --check server.js` checks syntax.
- Live-host browser smoke (read-only test): opened Aiconvo's README with the
  current server/fallback, then with the new bundle supplied by request
  interception to simulate the upgraded route. Both rendered 26 visible lines
  at the same content height, source toggles worked, the file stayed clean,
  and no page errors occurred. This did not restart or modify the live server.

Timing checks are a benchmark, not brittle CI thresholds. Cache reuse and
invalidation have deterministic assertions.

## Rollout

0.10.0 is untouched. The new immutable URL is allowlisted in `server.js`.
The frontend falls back to 0.10.0 if the running server does not serve 0.10.1
yet. **No live server restart was performed:** wait for active runs to finish,
restart `aiconvo`, and reload the client to use the optimized editor.
