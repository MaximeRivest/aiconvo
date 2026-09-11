# Vendored: mrmd-document

The light MRMD document editor bundle. It gives aiconvo the MRMD
markdown writing experience: blur→render / focus→source editing,
tables, images, task lists, math, alerts, syntax-highlighted code
blocks, and MRMD themes.

It excludes: Yjs networking, runtimes, terminals, linked tables, AI
panels, collaboration UI, and MRP clients. Aiconvo owns files, saves,
Git commits, and provenance; MRMD owns the editing surface.

## Current artifact

- Version: 0.11.0 (entry `src/document-entry.js`, global `mrmdDocument`)
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
  `gotoLine(n)`. Aiconvo's files mode uses this instead of its old textarea
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
  `cm-md-codeblock-line` / `-first` / `-last` on fenced code. Aiconvo
  uses them to give the editor the conversation `.md` look (rule under
  h1/h2, boxed code blocks).
- 0.9.1: `createDocumentEditor` and `setTheme` accept a theme OBJECT.
  Aiconvo passes a theme built from its own tokens (`mrmdHostTheme()` in
  app.html); every value is a `var()` reference into tokens.css, so the
  editor follows light, dark, custom, and binary e-ink themes.
- Source: `/home/maxime/Projects/mrmd-packages/mrmd-editor`
- Source base: `1c03f74`, plus the existing performance changes and 0.11.0
  host-service changes in `mrmd-editor` (source, regression tests, and rebuilt
  document dist are in that tree).
- SHA-256: `435bbc86587ba4a7addc9749779b01eb839cf51af6b0fe965d784d259d65255d`
- License: MIT (see `0.11.0/LICENSE`)
- Deployment: restart the server **after active runs finish**, then reload
  clients. Until the new static route is available, the loader falls back to
  0.10.1. Keep that artifact and route while the fallback exists.

## Features enabled in aiconvo

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
- `assetResolver` — relative image paths resolve through aiconvo's API

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
   Run `node --test test/document-bundle.test.js` in aiconvo.
6. Delete older version folders only after they are no longer referenced by
   the loader/fallback and the new version has run for a few days.

Build command reference:

```bash
cd /home/maxime/Projects/mrmd-packages/mrmd-editor
npm run build:document
sha256sum dist/mrmd-document.iife.min.js
```
