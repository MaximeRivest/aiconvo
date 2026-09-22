# Focused live-file editing

## User surface

Since 2026-09-11 this is the only file screen: every file link (a markdown link in a conversation, a quoted path, a browser row, a review's Edit live file, a context chip, an old `doc=` link) opens it. One header row: Back (named after where the file was opened from), the file, its state, History, Ask, Run (Markdown), Save, and ⋯. On a phone History, Ask and Run sit under ⋯. **History** swaps the editor for the recorded-version list and one version or a diff of two (the change review's diff component, without comments); the route names the versions. **Ask** (Ctrl+K) docks the ask-for-a-change composer under the file. Files the project cannot edit open read-only in the same screen. There is no repository tree, replay track, who-strip, vouch/dispute or second header row; trust marks belong to the review.

`openLiveFile(path, options)` in `live-file.js` owns this frame, while the existing `fileWs` and `docState` own save/draft/run lifecycles. Routes retain a `focus` flag, the return route and optional review reference; a refresh does not revert to the large workspace. Opening does not fetch `/api/project/file-history`, touched-file sessions or reconstructed snapshots. File and editor-bundle loading are parallel.

### Links and lines (2026-09-21, with tryingET, PRs #6, #9, #10)

A document is one node of a linked set of files, and the screen reads that set: a markdown link inside the open document (`[ADR](../adr/0011-x.md)`, `notes.md#L12`, `notes.md#some-heading`) resolves against the open file the way an image does, is checked on the server, and opens in this same screen with Back returning to the source; a dead target or a folder says so in a toast. `#L12` names a line; any other fragment is a heading, found the way GitHub slugs it. Ctrl/Cmd-click hands the file to the system application, as on every file control; the editor bundle reports the modifier keys with its `file-link-navigate` event (0.13.0). The line a link asked for is part of the route (`line=`), so a reload or a shared URL lands there. A **return** (back, forward) lands on the cursor left behind instead, the way a browser returns to a page's scroll rather than to its anchor; the navigation stack tells the two apart (`restore`). Links in the wild also come as `#/file&path=…` (SPA-style, agent-composed) and may contain a literal `%`: `hashRoute()` normalizes the address before the stack records it, so neither form dies silently.

### Diagrams (2026-09-21)

A ```` ```mermaid ```` fence in the open document draws as a figure while the cursor is outside it and shows its source inside, the rule display math follows. The bundle ships no diagram library; Chattering lends it the mermaid it already carries for transcripts and notes (`mermaidDiagramNode`), so the diagram in a document is the same drawing, in the same theme, as in the conversation that produced it, and a theme switch redraws it. A drawing that fails shows mermaid's message over the source; a library that fails to load says so too, in the editor and in every transcript box, rather than leaving unexplained code.

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
- `test/editor-file-links.test.js`: link targets as markdown wrote them, document-relative resolution that never climbs above the root, heading slugs, the server check, and the modifier keys the bundle reports. `test/file-workspace-navigation.test.js`: the route line, and the cursor-versus-line rule on a return. `test/hash-routing.test.js`: `hashRoute()` and the two places that feed the stack from it.
- In mrmd-editor, `npm run test:document` covers diagram fences: drawn outside, source inside, one draw per distinct source, failures retried, `refreshDiagrams()`, reading and source modes, and misconfiguration failing at creation.
- `test/conversation-app.test.js`: actual Edit live navigation, no tree/history requests, background gutter markers, Ctrl-F isolation, native Ctrl-Space completion, cancellation of stale completion responses, diagnostic version checks, saving, focused-route restoration, return to review, runnable MRMD output (with a fixture runtime), and Save without a commit.
- In mrmd-editor, `npm run test:document` now also exercises both editors' gutter updates/hover, invalidation after typing, diagnostics, search, completion, definition hooks and destruction in Chromium.
