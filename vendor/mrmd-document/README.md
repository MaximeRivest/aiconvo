# Vendored: mrmd-document

The light MRMD document editor bundle. It gives chattering the MRMD
markdown writing experience: blur→render / focus→source editing,
tables, images, task lists, math, alerts, syntax-highlighted code
blocks, and MRMD themes.

It excludes: runtimes, terminals, linked tables, AI panels, and MRP
clients. Chattering owns files, saves, Git commits, and provenance; MRMD
owns the editing surface.

## Current artifact

- Version: 0.14.0 (entry `src/document-entry.js`, global `mrmdDocument`)
- 0.14.0: live cell runs. `showCellRun(cell)` puts a panel under a running
  cell: `append(text)` shows output as it streams (carriage returns redraw
  a progress line in place, ANSI styling dropped, links clickable), and
  `ask({prompt, secret})` shows a field for the program's input prompt — a
  password field when `secret` — resolving `{text}`, `{dismissed: true}`
  (Esc: the host stops the run) or `{withdrawn: true}` (`dismissInput()`,
  a newer question, or `dispose()`). The panel is a view decoration, never
  document text: no save, undo step or collaboration traffic while a cell
  runs; the result block the cell already owns is dimmed until the host
  writes the new one (`setCellOutput`) and calls `dispose()`. Chattering
  feeds it from `rat run --events` (runDocCell in app.html). The bundle
  grows by about 5 KB.
- 0.13.0: diagram fences drawn through a host renderer. `createDocumentEditor`
  accepts `diagrams: {languages, render}`; a closed fence in a named language
  is drawn while the cursor is outside it and shown as source inside, like
  display math. The bundle ships no diagram library: chattering lends its
  vendored mermaid (`mermaidDiagramNode` in app.html), so documents draw the
  same diagrams as transcripts and notes, with the same theme. Drawings are
  cached by source; `refreshDiagrams()` redraws after a theme change. The
  `file-link-navigate` event now reports the click's modifier keys
  (`detail.modifiers`), which the file workspace uses for Ctrl/Cmd-click.
  The bundle grows from 1.7 MB to 1.71 MB.
- 0.12.0: collaboration primitives under `mrmdDocument.collab` (`Y`,
  `Awareness`, `WebsocketProvider`, `yCollab`, `yUndoManagerKeymap`), and
  both `createDocumentEditor` and `createCodeEditor` accept `extensions`
  (extra CodeMirror extensions), so a host can make an editor shared with
  `extensions: [collab.yCollab(ytext, provider.awareness)]`. Nothing is
  wired by the bundle: the host owns document identity, the endpoint and
  who is who. Chattering's `collab.js` speaks the y-websocket protocol on the
  server side. The bundle grows from 1.6 MB to 1.7 MB.
- 0.11.0: shared host services for both document and code editors: an opt-in
  Markdown marker gutter, `onLineHover`, version-checked `setLineMarks`,
  `setDiagnostics`, `setLanguageServices`, and `openSearch`. Code editors retain
  native language completions and gain explicit word completion / Tab handling.
  Completion/hover requests are cancelled and stale results rejected after edits
  or disposal. This is an integration boundary, not a bundled language server.
  The bundle grows by only a few KiB; it still uses one CodeMirror instance.
- 0.10.1: cache document scans by immutable document identity (and syntax-tree
  identity for parser-dependent ranges). Cursor movement within a line reuses
  block decorations; scrolling decorates only visible code-block lines.
  Sequential table/admonition scans avoid repeated line lookups. Ordinary
  documents skip linked-table parsing and math-free documents skip math's
  syntax traversal. Source mode retains its existing styling and spacing.
  See [performance and verification](performance-0.10.1.md).
- 0.10.0: `createCodeEditor(target, {doc, filename, theme, readonly,
  onChange, onSave, onMarkClick})` — whole-file code editing on the same
  engine and theme object as the document editor: line numbers, a language
  picked from the file name (`fileLanguage(name)`: js/ts, python, html,
  css, json, sql, yaml, r, shell, rust, go, c/c++, java, xml, toml, lua,
  ruby, dockerfile, diff, markdown), search, and a host-marked gutter
  (`setLineMarks({line: {glyph, title, cls}})` for trust and provenance).
  Both editors gain `selection()` (1-based lines, selected text) and
  `gotoLine(n)`. Chattering's files mode uses this instead of its old textarea
  overlay. The bundle grows from 1.3 MB to 1.6 MB (the compiled-language
  grammars).
- 0.9.4: notebook mechanics. `setCellOutput(cell, text)` writes an
  ```output fence under the cell (whitespace-only-gap ownership rule —
  a rerun replaces only the block it owns; empty output removes it;
  one undo step; stale-cell guard). `listCells()`, `advanceToNextCell()`,
  Shift-Enter → onRunCell(cell, {advance:true}). Code-block line classes
  now carry data-lang so hosts can style ```output blocks as results.
- 0.9.3: a selection overlay layer (drawn ABOVE line fills, color
  `--mrmd-selection-overlay`) so selections stay visible over code-block
  grounds; `onRunCell` option (Mod-Enter in a fenced block → the host
  gets `{lang, code, from, to}`) and `codeBlockAtCursor()` — the editor
  detects cells, the host owns execution and output UI.
- 0.9.2: the renderer adds unstyled line classes so hosts can restyle
  whole rows: `cm-md-heading-line` / `cm-md-h<n>-line` on headings and
  `cm-md-codeblock-line` / `-first` / `-last` on fenced code. Chattering
  uses them to give the editor the conversation `.md` look (rule under
  h1/h2, boxed code blocks).
- 0.9.1: `createDocumentEditor` and `setTheme` accept a theme OBJECT.
  Chattering passes a theme built from its own tokens (`mrmdHostTheme()` in
  app.html); every value is a `var()` reference into tokens.css, so the
  editor follows light, dark, custom, and binary e-ink themes.
- Source: `/home/maxime/Projects/mrmd-packages/mrmd-editor`
- Source commit: `93da1a6` ("document entry 0.14.0").
- SHA-256: `b3116e02aa216318872e3ebd4a8add1a6959c894ea36856acce62305367d1533`
- License: MIT (see `0.13.0/LICENSE`)
- Deployment: restart the server **after active runs finish**, then reload
  clients. Until the new static route is available, the loader falls back to
  0.13.0 (documents open; a running cell's prompt is asked in the run strip
  and its latest output line shown there, instead of the panel under the
  cell). Keep that artifact and route while the fallback exists.

## Features enabled in chattering

- `createDocumentEditor(target, options)` — hosted-mode editor
- `getContent` / `setContent`
- `onChange` (2 s Markdown autosave debounce) / `onSave` (host-owned: focused
  editing saves to disk; the legacy document workspace can create Git revisions)
- `setLineMarks(marks, expectedContent?)`, `onLineHover(line)` and
  `onLineHoverEnd()` for host-owned gutter annotations
- `setLanguageServices({complete, hover, definition})`,
  `setDiagnostics(items, expectedContent)`, `openSearch()`; no LSP processes
  are started by the bundle
- `setTheme` / `getThemeNames` — MRMD themes, applied inline on the host
- `setSourceMode` — raw markdown toggle
- `setReadonly`
- `assetResolver` — relative image paths resolve through chattering's API
- `diagrams` — mermaid fences drawn with chattering's vendored mermaid;
  `refreshDiagrams()` after a theme change
- `file-link-navigate` — links inside the document open in the file
  workspace (filesmode.js `fileWsWireDocLinks`)
- `showCellRun` — a running notebook cell's live output and input prompts
  (app.html `runDocCell`, fed by `rat run --events` through
  `/api/doc/run-cell` with `stream: true` and `/api/doc/run-input`)

## Update procedure

1. In `mrmd-editor`: pull, review, then `npm run build:document`.
2. Run `npm test` and `npm run test:document`; for shared renderer changes,
   also `npm run build && npm run test:render`. `npm run bench:document`
   measures typing/cursor costs (set `MRMD_BUNDLE` to compare an older build).
   On NixOS set `PUPPETEER_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium`.
3. Copy `dist/mrmd-document.iife.min.js` to a NEW versioned folder here
   (`vendor/mrmd-document/<version>/`).
4. Update the SHA-256, commit hash, and version in this README.
5. Add the new static route in `server.js`, point `MRMD_DOC_SRC` in `app.html`
   at it, and retain the previous path as `MRMD_DOC_FALLBACK_SRC` during rollout.
   Run `node --test test/document-bundle.test.js` in chattering.
6. Delete older version folders only after they are no longer referenced by
   the loader/fallback and the new version has run for a few days.

Build command reference:

```bash
cd /home/maxime/Projects/mrmd-packages/mrmd-editor
npm run build:document
sha256sum dist/mrmd-document.iife.min.js
```
