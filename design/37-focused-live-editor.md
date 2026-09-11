# Focused live-file editing

## User surface

**Edit live file** in a checkpoint review now opens a dedicated focused view: back to the review, filename, save state, Save, and the editor. Markdown also has Run, with Run all / source mode / unwrap under a small options menu. There is no repository tree, history drawer, replay track, provenance chip strip or agent composer. Editing from the older file comparison uses the same focused surface. Existing browsing/history routes remain available elsewhere.

`openLiveFile(path, options)` in `live-file.js` owns this frame, while the existing `fileWs` and `docState` own save/draft/run lifecycles. Routes retain a `focus` flag, the return route and optional review reference; a refresh does not revert to the large workspace. Opening does not fetch `/api/project/file-history`, touched-file sessions or reconstructed snapshots. File and editor-bundle loading are parallel.

## Editing engine

- Runnable Markdown uses the actual MRMD document editor, not a preview or a replacement textarea. Cell execution/output still uses the existing rat-backed API and MRMD output-fence mechanics. Runtime information is loaded on Run, not merely because the document opened.
- Code uses MRMD's existing CodeMirror 6 wrapper. It already has language modes, syntax highlighting, history, search, bracket handling and native language completion sources. Explicit Ctrl-Space word completion supplements those sources; Tab accepts an open completion or indents code.
- The 0.11.0 document bundle adds shared host services to both editors. It does not load a second copy of CodeMirror. The artifact is built from `mrmd-packages/mrmd-editor/src/document-entry.js` and the new `src/document-host-services.js`, preserving that repository's existing changes.
- Ctrl-F is scoped to this file, not the app's conversation search. Escape in the editor remains an editor key. The standard document editor outside this focused surface retains its existing behavior.

## Save and conflict policy

Code saves explicitly. Markdown autosaves after a two-second pause; its focused Save/Ctrl-S also writes to disk, **not a Git commit**. A normal save only updates the quiet status label, not a toast. Save errors and external changes get banners.

Incoming disk changes do not replace text or move the cursor. Reload asks before discarding unsaved edits and refuses to replace edits typed during its fetch. SHA checks reject stale saves. Recovered drafts retain their original base SHA, so an old draft cannot silently overwrite a newer disk version. Drafts are kept in sessionStorage after a short pause and during navigation/unload. This is browser-session recovery, not a durable cross-device draft service. The active editor warns before closing with unsaved text and reports recovery-storage failures instead of silently ignoring them. Clipboard copy remains available when a save conflicts; a full conflict-merge UI is not part of this surface.

## Quiet line information

`live-file-marks-worker.js` uses `live-file-marks.js` and the shared line differ:

1. Compare the review's before checkpoint with the live editor text (or compare with the opening text when no review baseline is available).
2. Separately map unchanged editor lines to the last confirmed disk text for attribution. Unsaved insertions/modifications have no disk-line attribution.

The gutter shows additions/modifications and deletion indicators. It does not paint whole-line backgrounds. Markers refresh after a short pause; old markers and hover titles are cleared immediately on edits so they cannot mislabel shifted text while the worker is calculating. Stale worker responses are discarded. Saving advances the attribution baseline but does not erase the review markers.

Hovering the marker gutter lazily requests `/api/file/line-info?path=…&line=…&sha=…`. The server verifies access and the disk SHA, then uses a bounded `git blame -L` against the supplied disk contents. It does not scan/replay conversation history. Committed authors are labelled **Git attribution**; uncommitted authors remain unknown. Local changes say **Edited in this view · not saved**, not necessarily "human" (cell output can also edit the document). Text hover is reserved for language-service information rather than competing blame popups.

## Language-service seam (not an installed LSP system)

`registerLiveFileLanguageService(language, factory)` registers an optional factory for subsequent focused editor opens. The factory receives `{path, project, editor, signal}` and can return:

- `name`
- `complete({text, pos, explicit, filename, signal})` → a CM-compatible completion result with `from`, optional `to`, and `options`
- `hover({text, pos, filename, signal})` → plain text
- `definition({text, pos, filename, signal})` → `{path, line}` (absolute path, one-based line); F12 opens the target in the focused editor
- `dispose()`

The editor exposes `onChange`, `getContent`, `setLanguageServices`, `openSearch`, and `setDiagnostics(items, expectedContent)`. Offsets are JavaScript/CM UTF-16 positions. Diagnostic publication requires matching document contents. Completion and hover responses are cancelled/rejected after document changes, service replacement or destruction. Provider hover text is never inserted as HTML.

A future adapter owns LSP processes, document synchronization, URI/offset conversion, project environment and shutdown. Nothing starts a language server implicitly. Native keyword/local completion is not advertised as cross-file semantic intelligence. Factory removal affects later opens; an attached service is disposed when its editor closes.

## Deliberate scope and limits

- This is a focused editing path, not a replacement for the project browser or a full IDE. No explorer, terminal panel, debugger, replay or task-management UI.
- The shared bundle still includes MRMD's rendering code for code-only opens. Reusing its engine avoids duplicate CodeMirror instances and a second editor stack; first open pays the existing roughly 1.6 MB bundle load (warm-cache prefetch remains in place).
- Attribution is Git-based, not reconstructed agent-by-agent line ownership. SHA mismatch or missing Git history produces an honest unknown/stale result.
- Inline annotation calculation pauses above two million characters or 50,000 lines; editing remains available. Git attribution is limited to text files up to 2 MiB and a five-second Git timeout. Hover requests are delayed/cached and cancelled when obsolete. Binary files are not opened as writable text.
- The server still records the existing file archive on reads/saves. This work does not migrate checkpoint/archive storage or change retention.

## Verification

- `test/live-file.test.js`: marker/origin independence, deletion/undo, size limits, real Git attribution and uncommitted/unknown handling.
- `test/conversation-app.test.js`: actual Edit live navigation, no tree/history requests, background gutter markers, Ctrl-F isolation, native Ctrl-Space completion, cancellation of stale completion responses, diagnostic version checks, saving, focused-route restoration, return to review, runnable MRMD output (with a fixture runtime), and Save without a commit.
- In mrmd-editor, `npm run test:document` now also exercises both editors' gutter updates/hover, invalidation after typing, diagnostics, search, completion, definition hooks and destruction in Chromium.
