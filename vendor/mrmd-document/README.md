# Vendored: mrmd-document

The light MRMD document editor bundle. It gives aiconvo the MRMD
markdown writing experience: blur→render / focus→source editing,
tables, images, task lists, math, alerts, syntax-highlighted code
blocks, and MRMD themes.

It excludes: Yjs networking, runtimes, terminals, linked tables, AI
panels, collaboration UI, and MRP clients. Aiconvo owns files, saves,
Git commits, and provenance; MRMD owns the editing surface.

## Current artifact

- Version: 0.9.4 (entry `src/document-entry.js`, global `mrmdDocument`)
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
- Git commit: `124d914` ("document entry: host theming, selection
  overlay, notebook cell API"; built by `e2807c4`)
- SHA-256: `3dd51aae07455a1d773ca05a31bf0676053310451c7a9dbadd542f40330dd015`
- License: MIT (see `0.9.4/LICENSE`)

## Features enabled in aiconvo

- `createDocumentEditor(target, options)` — hosted-mode editor
- `getContent` / `setContent`
- `onChange` (2 s autosave debounce) / `onSave` (Mod-S → Git commit)
- `setTheme` / `getThemeNames` — MRMD themes, applied inline on the host
- `setSourceMode` — raw markdown toggle
- `setReadonly`
- `assetResolver` — relative image paths resolve through aiconvo's API

## Update procedure

1. In `mrmd-editor`: pull, review, then `npm run build:document`.
2. Smoke-test the bundle (puppeteer script in the aiconvo conversation
   notes, or open a document in aiconvo against the new file).
3. Copy `dist/mrmd-document.iife.min.js` to a NEW versioned folder here
   (`vendor/mrmd-document/<version>/`).
4. Update the SHA-256, commit hash, and version in this README.
5. Point `MRMD_DOC_SRC` in `app.html` at the new path.
6. Delete the previous version folder after the new one has run for a
   few days.

Build command reference:

```bash
cd /home/maxime/Projects/mrmd-packages/mrmd-editor
npm run build:document
sha256sum dist/mrmd-document.iife.min.js
```
