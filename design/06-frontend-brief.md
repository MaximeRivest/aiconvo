# Frontend handoff brief

## What you get

| File | What it is |
|---|---|
| `00-brief.md` | Product context, goals, what to fix. Read first. |
| `01-tokens.md` + `tokens.css` | All colors, type, spacing, motion. `tokens.css` is drop-in. |
| `02-components.md` | Component-by-component spec with states and measurements. |
| `03-screens.md` | The four view states and layout skeleton. |
| `04-interactions.md` | Keyboard, selection, live updates, focus, edge cases. |
| `05-copy.md` | Exact UI text. Use it verbatim. |
| `styleguide.html` | Visual reference. Open it in a browser next to your build. |

## Constraints

- Keep the zero-dependency approach. Plain HTML/CSS/JS in `app.html`.
  No framework, no build step.
- The server API does not change. All endpoints in `server.js` stay as-is.
- Keep the existing behaviors that work: live updates via `/api/events`,
  scroll preservation, deep links (`#<key>`, `#note=...`), background jobs.
- No icon font, no SVG sprite, no emoji. Use the glyph set from
  `01-tokens.md` (`❯ ● █ ░ ✓ ✗ ∅ ▸ ▾ ←`). They are plain text.

## Order of work

1. **Tokens.** Replace the `:root` block with `tokens.css`. Rename usages.
2. **Header.** Three-zone layout, filter popover, overflow menu.
3. **List pane.** Mode tabs, new row design, selection bar.
4. **Conversation view.** Sticky header, new message styles, collapsible
   tool results.
5. **Jobs drawer.** Replace the floating tray.
6. **Toasts + dialogs.** Remove all `alert()` and `prompt()` calls.
7. **Keyboard + a11y.** Shortcuts, focus rings, aria labels, live regions.
8. **Empty states + copy.** Apply `05-copy.md` everywhere.

Each step shippable on its own, in this order.

## Acceptance checklist

Visual:
- [ ] No hardcoded hex values outside the token block.
- [ ] Header never wraps at 1100 px width.
- [ ] Message column never exceeds 780 px.
- [ ] No emoji, no border-radius above 2 px, no box-shadow anywhere.
- [ ] Active list rows use inverse video (`--accent-strong` + `--accent-ink`).
- [ ] App is fully usable in light mode (`prefers-color-scheme: light` and
  `<html data-theme="light">`).
- [ ] Focus visible on every control.

Behavior:
- [ ] All shortcuts in `04-interactions.md` work and ignore focused inputs.
- [ ] Selection survives search, filter, and tab switches.
- [ ] Zero `alert()` / `prompt()` calls remain.
- [ ] Open conversation never scrolls or reloads without a user action.
- [ ] `prefers-reduced-motion` disables pulses and slides.

Content:
- [ ] All copy matches `05-copy.md`.
- [ ] Every empty pane has a next action.

## Out of scope (do not build)

- Theme switcher UI, mobile layout, settings page.
  (Light theme itself is included: it comes free from the tokens.)
- Server-side changes.
- Changes to the note markdown format.
