# 20 — Settings: memory model

The settings view picks the Pi model used for all aiconvo memory work:
notes, evidence, epics, timeline titles, and project memory.

This is one job. It does not replace Pi or Claude CLI settings for live
agent sessions.

## Entry

- Header button: `settings`.
- Key: `,`.
- Deep link: `#settings`.
- Esc or `back` returns to the empty right pane.

## Layout

Reuse the project-overview page shape: sticky header, then flat sections.
No modal. No extra tab.

```
❯ settings
memory model · openai-codex/gpt-5.6-sol · 272K · thinking off
[back]

memory model
Notes, evidence, epics, titles, and project memory use this Pi model.
thinking [off ▾]
[use pi default (xai/grok-4.6)]

pi catalog
[search provider or model]  [x] signed-in providers only  [reload catalog]
▸ openai-codex · 8 models · signed in
  gpt-5.6-sol          272K · think · current
```

## Rules

- The catalog is `pi --list-models`. Do not invent models.
- Signed-in providers come from the keys in `~/.pi/agent/auth.json`.
  Do not read credential values.
- `claude-code` is a local Pi extension
  (`~/.pi/agent/extensions/claude-code-fable-5`). It is signed in when
  `~/.claude/.credentials.json` has a `claudeAiOauth` object. Memory jobs
  keep `--no-extensions` and pass that file with `-e`.
- `use pi default` omits `--provider` and `--model` so Pi uses
  `~/.pi/agent/settings.json`.
- Thinking stays `off` unless the user changes it. Models without
  thinking cannot select another level.
- A change writes `~/.config/aiconvo/settings.json` and applies to
  the next model call. Running jobs keep the model they started with
  only for already-started `pi` processes; later steps read the new
  setting.
- Context size follows the selected catalog row and sets the 80%
  split budget.
