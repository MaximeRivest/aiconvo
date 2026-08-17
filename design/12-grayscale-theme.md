# 12 — Grayscale theme

A fifth theme: auto, dark, light, e-ink, **grayscale**. For grey-level
e-ink displays (16 shades) and for anyone who wants a calm,
ink-on-paper screen without the e-ink theme's hard binary rules.

Selected in the filters popover, persisted like the other themes.

## Method

Same construction as the other themes, with chroma removed:

1. **Neutrals:** the light theme's OKLCH lightness ramp with C = 0.
   Pure greys, no tint: `#f5f5f5` background down to `#1f1f1f` text.
2. **Semantic colors become lightness steps.** Hue carries no
   information in grayscale, so meaning moves to *tone*:

   | token | grey | lightness | contrast on bg |
   |---|---|---|---|
   | danger (red) | `#2e2e2e` | L 0.30 | 12.5 |
   | info (cyan) | `#484848` | L 0.40 | 8.4 |
   | accent/success (green) | `#555555` | L 0.45 | 6.8 |
   | epics (magenta) | `#636363` | L 0.50 | 5.5 |
   | warn (yellow) | `#696969` | L 0.52 | 5.1 |

   The rule: **the more urgent the meaning, the darker the tone.**
   Danger is the darkest accent, warning the lightest. Every step passes
   WCAG AA (≥ 4.5:1) for text on the background.
3. **Inverse fills** (selection, primary buttons, active tabs) use
   `#292929` with white text — a soft black, not the e-ink hard black.
4. **The glyphs keep working.** `● ✓ ✗ ⚠ ❯` already carry meaning;
   tone is now a second, redundant channel.

## What grayscale keeps that e-ink drops

- Surface tints (`#ededed`, `#e3e3e3`) separate header, list, and
  popovers without borders everywhere.
- Hover states work: a grey wash instead of nothing.
- Dim text is grey again (`#575757`), so hierarchy has three levels.
- Animations stay on. Grey-level screens refresh greys cleanly.

## Gantt marks

Project colors become grey tones: four fill lightness steps
(L 0.60–0.81) with a darker stroke (fill − 0.30). Projects stay
distinguishable; lane grouping helps as before. Note marks use the
solid mid-grey `--success` tone, clearly darker than conversation
violins.

## Terminal view

The 16 ANSI colors map onto a grey ramp (dark greys for foregrounds,
all ≥ 4.5:1 on the background). The existing light-theme adaptation —
flip lightness by direction, enforce a contrast floor — works on
lightness only, so it transfers to grey unchanged. Truecolor input
keeps its lightness and loses its hue.
