# Workstation-local installation

## Upstream and local divergence

- Checkout: `/home/tryinget/ai-society/softwareco/contrib/aiconvo`.
- Origin: `https://github.com/MaximeRivest/aiconvo.git`.
- Upstream branch: `master` (not `main`). Initial baseline:
  `aa023073bb8eee985ebfd404ee4d431cb83ccf6c`.
- Local modifications preserve upstream behavior unless the new environment flags are set.
- No NAS deployment, Pi extension installation, host file-association changes,
  provider inference, or publication was performed for this installation.

## Running installation

- URL: <http://127.0.0.1:7433> (IPv4 loopback only).
- `~/.config/systemd/user/aiconvo.service` links to the adjacent tracked service file.
- `~/.local/share/applications/aiconvo.desktop` links to the adjacent launcher.
- Service enabled at user login; no linger setting was changed. No automatic restart loop.
- Node: `/usr/bin/node`, verified with v26.8.1; upstream requires modern Node with `node:sqlite`.
- Service memory high/max: 768 MiB / 1 GiB. An OOM must be investigated before expanding limits.
- Cache: `~/.cache/aiconvo-compass-pilot`; temporary files: `~/.local/state/aiconvo/tmp`.
- Default upstream durable data paths remain under `~/.local/share/aiconvo` and `~/notes/aiconvo`.
- The full Pi archive measured 13 GiB. Initial source is only the 14 MiB COMPASS-C
  session directory (three conversations), not a copied or edited archive.
- Claude and remote-Pi sources point to dedicated empty directories for this initial scope.

```sh
systemctl --user status aiconvo
systemctl --user stop aiconvo
# Only restart when no manual AIconvo agent run is active:
systemctl --user restart aiconvo
journalctl --user -u aiconvo -n 50 --no-pager
```

The service is not a security sandbox: explicit UI actions can edit files or
transcripts, invoke models, run code, or create Git commits. Keep it local and use
focused-editor Save for ordinary disk saves, not the legacy commit action.
No live agent send, provider login, runnable-cell backend, or terminal integration
was verified. The upstream terminal launcher expects Alacritty. Report viewing
and editing use the browser and do not need it.

## Local controls

`AICONVO_NO_AUTO_MODELS=1` blocks internal automatic model calls before temporary
input writes and launch. It also suppresses background title/memory scheduling,
project-open naming, commit-title generation/amend, and implicit model-catalog
refresh. Manual actions retain their upstream implementation; the catalog requires
an explicit refresh when no saved catalog exists. This is not a universal no-network
or no-model sandbox.

The service also sets upstream controls:

- `AICONVO_DISABLE_DELEGATION_CALLBACKS=1`: no automatic restored delegation callbacks.
- `AICONVO_SPEAK_DONE=0`: no automatic completion rewrite/TTS.
- `AICONVO_NO_WATCH=1`, `AICONVO_NO_LEDGER=1`,
  `AICONVO_NO_FILE_HISTORY=1`, `AICONVO_NO_CHECKPOINTS=1`: no broad repository
  capture/backfill. Session-directory watching remains active. Historical capture
  features are intentionally unavailable; enabling them is a separate decision.
- Semantic search retains the upstream disabled default. External voice/search
  endpoints have not been configured or validated.

New optional source overrides:

- `AICONVO_PI_SESSIONS_DIR`
- `AICONVO_CLAUDE_PROJECTS_DIR`
- `AICONVO_PI_REMOTE_SESSIONS_DIR`

Unset overrides preserve the upstream source paths. Source roots affect session
keys and write destinations as well as discovery. When expanding to a different
root, use a fresh `AICONVO_CACHE_DIR` to avoid old keys/caches referring to the wrong
files. Do not copy old index state blindly. Existing agent credentials/settings
are not rewritten by these overrides.

## Verification (2026-09-12)

- 41 focused Node tests passed, including automatic/manual launch guards and source overrides.
- Upstream complete browser/server fixture passed: conversation reading, MRMD,
  focused save, files/history/review paths and mobile layout. No live model calls.
- Installed-service check passed: HTTP report read, headless Chromium focused MRMD
  mount, exact report content, and unchanged on-disk source.
- Service restart passed; three indexed sessions persisted; listener stayed on
  `127.0.0.1:7433`. Initial observed service memory was roughly 65–125 MiB.
- Browser opener reported opening the report in the existing browser session.
  This alone is not a physical-click verification.

Run from this checkout:

```sh
node --test test/local-auto-models.test.js test/local-sources.test.js \
  test/settings.test.js test/modelhealth.test.js test/modelprocess.test.js \
  test/server-jobs.test.js
AICONVO_NO_AUTO_MODELS=1 AICONVO_DISABLE_DELEGATION_CALLBACKS=1 \
  AICONVO_SPEAK_DONE=0 node --test test/conversation-app.test.js
node scripts/verify-local-editor.js \
  /home/tryinget/ai-society/softwareco/owned/compass-c/evals/dspx-jury/subscription-review.md
```

The full upstream suite was initially omitted. Operator-requested follow-up ran
all 71 test files at `67db96e`, serially in a network-isolated, read-only-host
sandbox with private HOME/TMPDIR: **468 passed, 1 failed, 1 skipped** (exit 1).
The failure is `test/project-create.test.js:64`, which expects rejection of the
configured temporary directory; `isLooseCwd()` does not recognize this custom
home-relative TMPDIR. The NixOS-only sudo-wrapper test skipped. All four browser
integration tests passed. No tests were changed to obtain this result.

An initial full run had four additional Chromium failures because its nested
scratch path exceeded the Unix-socket path limit. Shortening owned scratch fixed
those harness failures; the temporary-directory classification failure remains.
Full logs: `aiconvo-full-suite.AVmDnR.log` (final) and
`aiconvo-full-suite.3dk1sa.log` (initial) under
`/home/tryinget/.local/state/pi-quests/tmp/`; exact sandbox invocation:
`/home/tryinget/.local/state/pi-quests/tmp/a.3ZXctY/invocation.sh`.

Service-file validation emitted an unrelated existing
`school-asr-recorder.service` warning; that unit was not modified.

## Rollback

Stop/disable the service before changing code or removing launch links:

```sh
systemctl --user disable --now aiconvo.service
```

The two installed symlinks can then be removed after checking their exact targets.
Keep caches/durable data until the operator decides their retention. No rollback
requires changing Pi extensions, Obsidian, browser defaults, or NAS configuration.
