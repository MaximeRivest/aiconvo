# Ship readiness: feature flags and dead code

Date: 2026-09-07. Commit studied: `9f26f90`. The original study below used static inspection.

## Cleanup result (2026-09-07)

Implemented the verified frontend and backend clusters in separate commits, through `f23530f`.
Tests ran after each cluster. Final independent check: 341 tests passed, zero failures or skips.
Command: `node --test --test-concurrency=1 test/*.test.js`.
Parallel runs sometimes hit process timing limits. Serial testing avoided that load.

Review caught two shared CSS rules damaged by selector removal. Both now have regression tests.
Saved `#q=` links still work through the current search dialog. A router test checks this.
The hidden terminal dialog no longer polls the server.

Corrections to the original audit:
- No local caller does not prove a public route is unused.
- Kept `/api/project/model`: it is the only writer of project model defaults.
  `/api/project/context` is a preview, not its replacement.
- Kept `/api/here`, `/api/modes/delete`, `/api/conversation/diffs`,
  `/api/project/memory`, and `/api/memory/leaf`. Each provides a distinct operation.
- Kept terminal slash-key support, both Pi engines, migrations, and live evidence builders.
- Removed legacy routes can still affect unknown outside scripts. No general API compatibility claim applies.
- Old project-distill notification handling remains compatible with an older running server.
- Vendor files, platform setup, security changes, and feature flags were not part of this cleanup.

This is not proof of zero dead code or release readiness. The original estimates and proposals below are historical.
Companion reports with line numbers: `/tmp/aiconvo-audit-app.md`, `/tmp/aiconvo-audit-server.md`
(copies live in the delegation output folders under `~/.local/share/aiconvo/delegations/`).
The platform and security audit of 2026-09-06 (`/tmp/aiconvo-distribution-audit.md`) is not repeated here.

## 1. What ships as-is, what needs a flag, what is personal

Three tiers. "Ships" means: works on a stranger's Linux or WSL machine with Node 22 and pi installed, no other gear.

### Tier A — core, ships today

| Feature | Depends on | Note |
|---|---|---|
| Index, browse, export conversations | Node, JSONL folders | Source folders are fixed paths (`~/.pi`, `~/.claude`); fine as defaults. |
| Word search (FTS5) | `node:sqlite` | Already degrades if SQLite is missing. |
| Home Gantt, project pages, areas, epics, project memory | pi + a provider | Memory builds need a model; already paused with backoff when the model fails. |
| Web sends via pi SDK, branching, fan-out, merge, tree | pi | Core value. |
| Delegation | pi, Linux process identity | systemd scopes are optional; falls back. |
| Documents (mrmd), code view, diffs, git history | git | Nothing external. |
| Themes, snippets, usage analytics, trust/vouch | — | |
| Search modal (Ctrl+F) | FTS | Semantic stage is a separate flag (see B). |

### Tier B — optional, needs a real flag

Today these are gated by *accident*: browser capability, a hardcoded URL, or nothing. Each one needs one explicit switch.

| Feature | Current gate | Failure on a stranger's machine | Needs |
|---|---|---|---|
| **Dictation (mic)** | `navigator.mediaDevices` exists → button shows (`app.html:13130`) | Button appears, click, silent failure: audio goes to `SPEECH_URL` = `192.168.2.24:8078` (`server.js:10157`). | Flag `speech`, on only when a speech URL is set. |
| **Read aloud / done-sound `title`,`summary`,`voice`** | `doneSound` setting; default is `'voice'` (`settings.js:41`) | First run tries Kokoro + Qwen rewrite on the LAN IP; sound never comes. | Flag `tts`. Default `doneSound` for new installs: `'chime'` (no network). |
| **Semantic search** | Already a real flag (`semanticSearch: false`) | Fine. Only the default URL is personal. | Keep. Blank the default URL. |
| **Pen / ink on file pages** | None: `ffInk` button always renders (`app.html:5184`) | Harmless but confusing on a laptop. | Flag `ink`, default off; auto-on when a `pen` pointer is seen or user enables. |
| **Terminal launch (Alacritty + bridge)** | `alacrittyBin()` probes fixed paths | "Alacritty did not open" errors; xdotool fallback silently no-ops. | Flag `terminal`, on only when the binary is found at startup. Hide "shift+enter → terminal" hint when off. |
| **Claude continuation** | `claude` on PATH | Same as terminal (it goes through Alacritty). | Part of `terminal`. |
| **Code cells in documents (rat)** | None; run button always shown | "rat CLI is not installed" on click. | Flag `codeCells`, on when `rat` is on PATH. |
| **Android native ink / mic bridges** | `window.AiconvoInk`, `window.AiconvoSpeech` | Fine (present only in the APK). | Leave; but APK hardcodes two LAN IPs. |
| **E-ink theme/gestures** | theme = `binary` | Fine, user-chosen. | Leave. |

### Tier C — personal, do not ship

| Item | Why |
|---|---|
| `tray.sh` + `/api/rescan` | needs `yad`; broken even here (not installed). Delete or move to `contrib/`. |
| `open.sh` snap paths, `server.js:5726` snap alacritty | Ubuntu leftovers. |
| `semantic/` service unit + README | GPU host paths and hostnames. Keep the python server; move unit + README to a `contrib/semantic/` with placeholders. |
| `android/` hardcoded `192.168.2.253:7433` and `192.168.2.24:8078` | Must come from the first-launch form. |
| `/run/current-system/sw/bin/du` (`server.js:6821`) | Breaks size probe on every non-NixOS box; returns a false 0. |
| `~/.nvm/versions/node/v22.23.1/bin/pi` (`server.js:5777`), `agentpath.js` NixOS paths | Keep as *fallbacks* only; already are. |
| `themeimport.js` Omarchy source | Fine as an opt-in importer. |
| `test/settings.test.js:92` user path | Fix the test. |

## 2. Feature-flag design

One expert rule: **the UI must never show a control whose backend is not configured.** Gating by browser capability (mic) or by nothing (ink, cells) is how strangers hit dead buttons.

### Server: one `capabilities` block in `GET /api/settings`

```js
capabilities: {
  speech:    { enabled, configured, reason },   // settings.speechUrl set
  tts:       { enabled, configured, reason },   // settings.ttsUrl set
  semantic:  { enabled, configured, reason },   // existing flag + url
  terminal:  { enabled, configured, reason },   // alacritty binary found
  codeCells: { enabled, configured, reason },   // rat on PATH
  ink:       { enabled },                       // user toggle only
}
```

- `enabled` = the user's switch in settings. `configured` = the server found what it needs (URL set, binary on PATH). `reason` is a short human string ("no speech URL", "alacritty not found") shown in settings.
- Probes run **once at startup** and when the user saves settings, not on every request. Reachability of a URL is *not* probed for gating (flaky); it is shown as a status line in settings after a manual "test" button.
- Move `KOKORO_URL`, `SPEECH_URL`, `REWRITE_URL`, `KOKORO_VOICE`, `REWRITE_MODEL` from env-only constants into `settings.json` keys (`speechUrl`, `ttsUrl`, `ttsVoice`, `rewriteUrl`, `rewriteModel`), with env as override. Defaults: **empty**. Your current values go into your own `~/.config/aiconvo/settings.json` by a one-time migration that reads the env if set.

### Frontend: one gate function

```js
const feat = name => { const c = settingsState?.capabilities?.[name]; return !!(c && c.enabled && c.configured !== false); };
```

- Composer: render the mic button only if `feat('speech')`; render the read-aloud action only if `feat('tts')`; render `ffInk`/`ffErase` only if `feat('ink')`; render the cell run button only if `feat('codeCells')`; show the "shift+enter → terminal" path and `sendToAlacritty` only if `feat('terminal')`.
- Keyboard help already derives from element visibility (`app.html:17552,17632`), so hidden buttons drop out of `?` automatically. Keep that pattern; do not add a second list.
- Settings modal: one **"Optional features"** group. Each row: switch, URL/path field (if any), status (`configured` / `reason`), and a "test" button. When a switch turns on and `configured` is true, the control appears on the next render without a reload.
- `doneSound` options that need `tts` are disabled with the reason inline when `feat('tts')` is false.

### Defaults for a fresh install

`speech`, `tts`, `ink`, `semantic`: off. `terminal`, `codeCells`: auto (on iff found). `doneSound: 'chime'`.

**Trade-off stated:** this changes the *defaults* only. Your saved `settings.json` keeps `voice` and your URLs after the migration. New installs are quiet and network-free until the user opts in.

## 3. Dead code (verified by two audits, spot-checked)

Cleaner than expected. No herdr, no window switcher, no chat-only mode remain. What is left:

### `app.html` (~1 100–1 250 lines, 6–7 %)

| Cluster | Lines | Note |
|---|---|---|
| Hidden terminal-mirror overlay `#agentOverlay` + pane code | ~260 | **Live cost:** every open composer polls `GET /api/conversation/pane` every 1.5 s into a hidden `<pre>` (`app.html:12684–12692, 12849–12853`; server runs `captureConversation` each time). Its only opener button is never created. Keep `agentLiveKeys` / `_agentLiveOn` (live slash path). |
| Top-bar search field `#qwrap` + list search + `n/N` match nav | ~370 | Hidden by `!important` in both body states (`app.html:179, 319`). Ctrl+F modal replaced it. Only reachable by a hand-typed `#q=` URL. |
| Old project file tree `renderProjectTree` | ~150 | Superseded by focused-file view. |
| Whole-file inspector card | ~90 | Superseded by `ff-*` layout. |
| Transcript view modes (`uniqcmd`/`files`), `keepInMode`, `pairTools`, `derive` | ~95 | `mode` is `const 'all'`. |
| `routeSegs` crumb builders (write-only) | ~100 | Touches 36 call sites; do last. |
| Loose singles (`continueInAlacritty`, `nudgeBranch`, `distillAction`, `themeNumber`, …) | ~75 | |
| Unused CSS (20 rules) | ~45 | |

### Backend (~320 lines in `server.js` + ~35 in pi modules)

16 routes with zero callers (`/api/here`, `/api/project/distill`, `/api/distill`, `/api/distill-running`, `/api/project/tree`, `/api/project/model`, `/api/conversation/model`, `/api/modes/delete`, four `*/file-history/file|snapshots` compare routes, three small reads) and their 12 private helpers. `piSetModel` becomes dead in `pirpc.js`, `pisdk-runtime.js`, `pisdk.js`, `pisdk-worker.js` once `/api/conversation/model` goes.

Not dead, but flagged for a decision:
- xdotool/xclip fallback in the Alacritty path (~75 lines): dead on Wayland, alive in code. Under the `terminal` flag, delete it and make the bridge mandatory.
- Old evidence/epic pipeline (`distill`, `buildEpic`, `/api/evidence/*`) **and** the new leaf/memory pipeline are both driven from the UI. Duplicate, not dead. Product decision, not a cleanup.
- Two one-shot migrations (`migrateDiffCacheFile`, `seedLeavesFromSnapshots`): remove after every install has booted once.
- `vendor/mrmd-document/0.9.0–0.9.3`: 5.2 MB unused; only `0.9.4` is served.

## 4. Order of work

1. Dead-code removal, one commit per cluster, `node --test test/*.test.js` after each. Start with the overlay (removes the 1.5 s poll), then singles, tree, inspector, view modes, CSS, top-bar search, crumbs; then the 16 backend routes.
2. Settings keys for speech/TTS URLs with empty defaults + env migration; `capabilities` in `/api/settings`; `feat()` in the frontend; gate mic, read-aloud, ink, cells, terminal.
3. Settings "Optional features" group with status and test buttons; `doneSound` default `chime`.
4. Tier C cleanup: `du` path, snap paths, tray, semantic unit/README to `contrib/`, Android IPs to the first-launch form, test path.
5. Then the 2026-09-06 audit's P0 items (origin/host guard, Android WebView) before any public link.
