# aiconvo — Design brief

## 1. What this product is

aiconvo is a personal desktop utility. It runs on localhost as a system service.
The user opens it in a browser tab.

It does four jobs:

1. **Find.** Browse and search all AI-agent conversations on the machine
   (Claude Code, pi, pi-remote).
2. **Read.** Show one conversation in a clean, readable form.
3. **Distill.** Turn one conversation into a structured note (a problem tree).
4. **Connect.** Group conversations into an epic: a cross-session timeline.

## 2. Who uses it

One user: a developer. Power user. Uses the app many times per day, often
while a conversation is still running in another window. Reads fast.
Uses the keyboard. Wants signal, not decoration.

## 3. Design goals

- **Speed of scanning.** The user finds a conversation in under 5 seconds.
- **Reading comfort.** Long conversations must be easy to read for 10+ minutes.
- **Calm background work.** Distillations and epic builds run in the background.
  The UI shows progress without blocking or alarming.
- **One look, three sources.** Claude, pi, and pi-remote conversations look the
  same, but the source is always identifiable at a glance.

## 3b. Aesthetic direction

Chosen with the owner: **terminal-native, with brutalist edges**.
Mono font everywhere. Square corners. No shadows, no blur, no gradients.
ANSI color palette with green as the accent. Inverse-video selection.
Glyph language instead of icons or emoji. Reference tools: Warp, lazygit,
GitHub dark dimmed, sourcehut.

## 4. Design principles

1. **Content first.** Chrome (toolbars, buttons) uses less visual weight than
   conversation text.
2. **Status is always visible, never noisy.** Live sessions, running jobs, and
   saved notes have small, persistent markers. No popups for normal events.
3. **Every empty state teaches.** When a panel is empty, it says what to do next.
4. **Keyboard parity.** Every frequent action has a keyboard shortcut.
5. **Dark only, done well.** The app is dark-theme only. Contrast, hierarchy,
   and focus states are designed for dark, not adapted from light.
6. **Density over air.** The user reads terminals all day. Compact rows and
   tight transcripts beat generous whitespace.

## 5. Current problems to fix

| # | Problem in the current UI | Fix |
|---|---|---|
| 1 | The header has 13 controls in one row. It wraps on small windows. | Group into: search zone, filter zone, action zone. See `03-screens.md`. |
| 2 | Three browse modes (conversations, notes, epics) hide behind buttons that rename themselves. | Use a segmented control at the top of the list pane. |
| 3 | User and assistant messages differ only by a dark background shade. Hard to scan. | Use alignment, role label, and a colored edge. See components. |
| 4 | The jobs tray floats over content and has no close affordance logic. | Make it a proper drawer anchored to the header. |
| 5 | No empty-state guidance. | Every empty state gets one sentence + one action. |
| 6 | No keyboard shortcuts. | Add the set in `04-interactions.md`. |
| 7 | Accent blue is used for links, badges, marks, and buttons alike. | Define semantic color roles. See `01-tokens.md`. |

## 6. Non-goals

- No mobile layout. Minimum supported width: 960 px. The layout must degrade
  acceptably down to that width.
- No theme switcher UI in this iteration. Light mode works automatically
  through `prefers-color-scheme`. Both themes ship from the same tokens.
- No visual redesign of the markdown note format itself (server-generated).
- No new features. This pass covers look, feel, and interaction clarity only.
