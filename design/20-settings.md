# 20 — Settings

One page for every preference. It is a full view (`#settings=PANE`), never
a modal: a section list on the left, one pane on the right. Each pane is a
short column: a title, one lead sentence, then controls. On a phone the
section list becomes a row of chips above the pane.

## Entry and exit

- Header gear, key `,`, deep link `#settings=sound`.
- Esc, `,`, or browser back return to the view that opened settings.
  Pane switches use `history.replaceState`, so leaving is always one step.
- Opened by URL with no earlier entry: esc goes home.

## Panes

| pane | contents |
|---|---|
| model | pi's default / a fixed model (radio). The fixed row holds one picker button that opens the shared searchable model palette. Thinking select. |
| sound | Five exclusive modes: off, chime, title, summary, voice. Picking a mode saves it and plays a sample. Mute is a timed button that shows "muted until HH:MM · N min left" and an unmute button. |
| search | One switch for meaning-based search. Server URL and namespace appear only when it is on. Status line. "how it works" is a collapsed details block. |
| snippets | Trigger field, the list of snippets, new snippet. |
| appearance | App theme (built-in and custom). pi theme for hosted extension views (`piTheme`, applies after a restart). |
| advanced | pi engine sdk / rpc (`piEngine`, for new sessions). Settings file path with copy. Environment overrides that cap the sound setting. |
| usage and cost → | A link in the section list, not a setting. |

## Control vocabulary

Three shapes only, defined once in CSS:

- `.set-field` — a dim caption above one control (text, select, picker).
- `.set-check` — one checkbox with its text on the same line.
- `.set-options` — an exclusive list: radio, bold name, one-line dim
  description, optional child controls under the chosen row.

Captions and help text are dim and small. The control is the loud thing.
Every action is a bordered button; no ghost buttons for actions.

## Rules

- Every change saves at once through `PUT /api/settings` and shows a toast.
- The catalog is `pi --list-models`. Do not invent models.
- Signed-in providers come from the keys in `~/.pi/agent/auth.json`.
  Do not read credential values.
- `pi's default` omits `--provider` and `--model` so Pi uses
  `~/.pi/agent/settings.json`.
- Thinking stays `off` unless the user changes it. Models without
  thinking cannot select another level.
- A model change writes `~/.config/aiconvo/settings.json` and applies to
  the next memory call. Live agent sessions are not affected.
- Context size follows the picked catalog row and sets the 80% split budget.
- The sound modes are one ordered ladder (`DONE_SOUND_MODES` in
  settings.js). `AICONVO_SPEAK_DONE=0` and `AICONVO_VOICE_REPLY=0` cap the
  setting for a whole deployment.
