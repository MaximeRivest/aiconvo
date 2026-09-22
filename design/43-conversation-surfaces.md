# 43 — Quieter conversation controls and appearance choices

## Intent

Keep writing and sending obvious. Less-used controls must remain reachable,
not push the microphone/model/send controls off the edge. Prefer a quiet title
line to a floating card. Shape belongs to themes, not hard-coded components.

## Composer

- Always-visible toolbar: **+ options**, microphone (when available), thinking
  level, model, send. The existing buttons for attachments, Context, commands,
  snippets, tree and mode are inside a native details menu.
- The thinking button sits immediately left of the model. Clicking opens all
  levels (off, minimal, low, medium, high, xhigh, max) with the current one
  checked; selecting sends that exact level to the existing endpoint. The
  returned, applied level is what the button shows, since model support varies.
  Shift+Tab remains a cycling shortcut. Drafts use the same picker but persist
  the choice locally until the first send. Escape, arrow keys and focus return
  are supported; navigating away closes the picker.
- Context usage and estimated cost stay outside that menu, in the true center
  of the composer: tools/microphone left, model/Send right. A three-column
  grid with equal outer tracks keeps the center independent of control widths.
  Wide composers keep one toolbar row. Below 540px of composer width, usage
  spans a second centered row so thinking/model/send remain reachable; it
  stays visible in zen mode, and remains a keyboard-accessible button for
  opening the last sent system prompt. Existing estimate/unknown-cost wording
  and near-capacity warnings are unchanged; absent data is not invented.
- Utility actions close the options menu when opening their own surface.
  Mode can be adjusted without leaving it. Escape returns
  focus to the summary; clicking elsewhere closes the menu.
- The model name shrinks/ellipsizes before send or microphone lose room.
  No horizontally scrolling toolbar. Phone focus changes no longer collapse
  the controls into a different layout.
- Side-layout composer is inset 10px from the bottom and 12px horizontally,
  with a theme-controlled contour. The entire dock (including live stream
  and continuation notice), not only the input, is measured for transcript
  clearance. This applies to e-ink too.

## Title and message actions

- The side-layout title is a small left-aligned transparent line **outside the
  transcript scroller**: no overlap, border, blur, card background, or shadow.
  It retains rename/move actions and scroll-direction hiding. Hiding/showing
  compensates the scroll offset for the line’s height, keeping the same prose
  in place. Blank space in the line does not intercept clicks.
- Copy/read/more sit **below** a user bubble, 6px away, outside its tinted
  background. The bubble stays compact. The gap below reserves room for
  these controls, without negative margins or overlap with the next message.
- Assistant actions stay in normal document flow. Actions are hidden at rest
  and appear on message hover, keyboard focus, or touch reveal. An open action
  menu remains visible. Their space stays reserved so nothing jumps; a hover
  bridge across the 6px user-bubble gap keeps buttons reachable.

## Appearance

- `--r`, `--r-sm`, `--r-menu`, `--r-composer` control general controls, small
  actions, menus and composer. Default: 6/4/10/18px. Built-in e-ink sets all
  to zero. The theme template documents the same tokens.
- Appearance offers Theme default, System sans, Humanist sans, Book serif,
  Monospace. System sans is the default. Applies immediately; `chattering.font` persists per browser and is
  restored before paint. These use installed font stacks, not remote assets;
  the exact face can vary by device. Theme default removes the override.
- Code and editor/terminal text retain `--font-mono`; a reading-font change
  does not disturb column alignment.

## Defaults

Sidebar is the desktop default; narrow screens still use the top bar.
`chattering.layout=top` now stores an explicit opt-out, instead of removing the
preference. Existing explicit layout/font choices are kept. System sans and
sidebar apply before paint, including when browser storage is unavailable.

## Verification

`test/side-panel.test.js` exercises menu reachability, closing, long model
names at 760/1000/390px, composer bounds, action spacing, transparent title,
e-ink shape switching, font setting/persistence/reset, and monospace code.
The complete conversation-app test covers the real editor/composer wiring.
