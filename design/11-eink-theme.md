# 11 — E-ink theme

A fourth theme next to auto, dark, and light. For e-ink displays
(reMarkable, BOOX, Dasung). Selected in the filters popover, persisted
in localStorage (`aiconvo.theme`).

## Constraints of the medium

- **Slow refresh.** Every animation is a full-screen repaint. Ghosting
  accumulates between full refreshes.
- **No real grey.** Greys are dithered black/white dots. They look dirty
  and refresh worse than solid pixels.
- **Touch, no hover.** Most e-ink devices have no pointer hover.

## Rules

1. **Binary only.** Every color is `#000` or `#fff`. No greys, no
   opacity, no alpha, no shadows.
2. **No motion.** All animations and transitions off. The blinking live
   cursor becomes a steady `█`. The active pulse is static. Toasts do
   not slide.
3. **Borders replace surfaces.** Every surface is white. Structure comes
   from 1 px black borders, not from background tints.
4. **Meaning moves from color to shape and weight.**
   - Selected or active → inverse video (black fill, white text).
   - Semantic colors (green, cyan, yellow, red, magenta) all map to
     black. The glyphs carry the meaning: `● ✓ ✗ ⚠ ❯`.
   - Search highlight → bold + underline.
   - Code and links → black, links underlined.
   - Gantt: conversation marks are solid black violins. Note marks are
     hollow (white fill, black stroke). Project colors collapse to
     black; lane grouping still shows the projects.
   - Disabled buttons → dashed border, not faded.
5. **Dim text stays black.** Hierarchy comes from font size and weight
   only. Grey small text is the worst offender on e-ink.

## Terminal view

- The 16 ANSI colors collapse to black (foreground) and black/white
  (backgrounds: the dark half of inputs becomes solid black bars).
- Truecolor and 256-cube colors threshold by lightness: foregrounds are
  always black; backgrounds below L 0.55 paint black, the rest paint
  white.
- `dim` is ignored (no grey). `bold` stays bold. Inverse stays inverse.

## Why a manual theme, not a media query

E-ink devices report nothing reliable. `prefers-color-scheme` follows
the device setting, which on e-ink Android is often "light" anyway.
A manual pick in the filters popover is explicit and survives reloads.
