# Expand local sessions and provider catalog

Operator approved expanding beyond the initial COMPASS-C source and loading all
locally available Pi providers. Removed the three deployment source overrides,
used a fresh `~/.cache/aiconvo-all-sessions` index, and retained the pilot cache.
Other service restrictions, credentials, Pi configuration, NAS and browser settings
were unchanged. Default model remains Pi's default (observed ZAI/GLM-5.3).

## Observed defects and repairs

1. Full indexing hit ENAMETOOLONG for long session-key-derived cache filenames.
   The shared cache-path helper retains short names and hashes long UTF-8 keys;
   scans rebuild missing caches. The fingerprint repair utility now shares that
   naming contract. No source transcript rewrite is part of this change.
2. Pi's model-list process exited before piped stdout drained. The first refresh
   returned 188 parsed models, missing providers near the alphabetical tail.
   Diagnostic blocking stdout returned 535. AIconvo now captures this CLI's output
   through a private regular file. Errors/timeouts/cleanup remain explicit; a
   scratch-setup failure calls back asynchronously so future refreshes can retry.
   The output-size limit rejects oversized results after exit, not live disk growth.

Independent review reproduced scratch-failure retry poisoning and the standalone
repair utility's legacy-cache lookup. Both were corrected and regression-tested.

## Verification

- Final complete suite: 483 tests across 74 files; 481 pass, 1 fail, 1 skip.
- Remaining failure: existing custom-TMPDIR classification in project creation.
  This is still a failing full gate, not a fully validated upstream installation.
- Network-isolated invocation and logs are linked in `deploy/workstation/README.md`.
- Live after restart: 4,072 indexed sessions (4,048 Pi / 24 Claude), 535 catalog
  models across 13 provider IDs, 224/224 hashed caches readable.
- Full scan stayed inside the unchanged 1 GiB service cap. Derived cache about 9 GiB.
- Real report HTTP read, focused MRMD mount and source-unchanged assertion passed.
- No inference calls were used for verification. Catalog availability is not proof
  of live authentication or provider efficacy.

Lesson: successful CLI exit is not proof that a pipe captured complete stdout.
Validate record coverage and output transport separately from parser correctness.
