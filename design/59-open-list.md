# 59 — The side list: what you opened, like a messaging app

## The ask (2026-09-22)

The side column showed every conversation on the machine, split into
Unread, Read (with an All / Project switch) and Working, plus a "Return to
work" button. None of that matched how the column is used. It should behave
like the chat list of a messaging app, with one difference: conversations
are more disposable than people, so a row can be closed.

- The list **starts empty**. A conversation joins it when a person opens it
  (from Home, search, a link, an alert — any way).
- **Order:** newest conversation on top, oldest at the bottom, by the time
  of the conversation's first message. A reply never reorders the list; it
  holds still while it is being read. Pinned rows stay on top, in pin order.
- **Working:** three pulsing dots after the title and, at the end of the
  second line, what the assistant is doing (`tool · bash`, `thinking`,
  `2/3 working`). This is the assistant's "typing" signal. A *person*
  typing in the same conversation is the bouncing avatar bubble beside the
  title (design/46), so the two never look alike.
- **Replied, not yet read:** the title goes bold and a filled green dot
  follows it, as an unread message does. Opening the conversation clears it.
- **✕ closes** the row (hover, keyboard `Delete`, or the ⋯ menu). Nothing is
  deleted; the conversation leaves the list. If the assistant replies again
  it comes back, unread. Opening it again also lists it again.
- No Unread, Read or Working sections. No "Return to work": Back is the way
  home.

## Second pass (same day): the row says more, and nothing is lost

- **Line two is what, line one is who.** The title and the time share the
  first line. The second line is the last thing said (`You:` when it was the
  person), or what the assistant is doing and for how long (`tool · bash ·
  12m`), or why the run stopped. A loose conversation spends no line on
  "No project"; a project name, when there is one, opens the second line.
- **Markers are shapes, not just colours.** After the title: a green dot
  (replied, unread), an amber `?` (the assistant ended with a question and
  nobody has answered — this stays after the reply is read, until the person
  writes), a red `!` (stopped). Bold means unread, whatever else the row is.
  The state is also said for a screen reader.
- **Elapsed time** on a working row counts from the run's start. A terminal
  run records no start, so it counts from the person's last message, which
  is when the turn began. It ticks by the second without a re-render.
- **Stopped runs are rows**, not a block of their own: `!`, the reason on
  hover, Resume on the row. A stopped run is listed even if nobody opened its
  conversation here — it is something to act on, and the alert that
  announced it is gone. Its ✕ also gives up the recovery record, or the row
  would be back at once; that part has no undo, so the toast offers none.
- **Undo.** Closing shows "Closed “…” · Undo" for a few seconds. A close now
  changes nothing but the closing mark — not the read time, not a manual
  unread flag — so the undo (`{ restore: [key] }`) puts the row back exactly,
  on every device.
- **Rows keep their identity.** The list is reconciled by key instead of
  rebuilt: hover, focus and the keyboard cursor survive a refresh, and what
  changed is animated — a row slides to its new place, a new one fades in, a
  closed one folds and the rows below follow it up. No motion on e-ink, on
  a theme without motion, or when the system asks for less.

## State

One new shared mark in `agent-read.json` (`agentread.js`, design/42):
`opened[key] = at`, set the first time a person opens the conversation and
kept forever after. `dismissed[key]` (the ✕) hides a listed conversation
until activity newer than the closing arrives, or a manual "mark unread"
after it; `restore` deletes the mark. `isListed = opened && !dismissed`.
Marking a conversation unread by hand also lists it (the person asked for
it). The browser posts `{ open: [keys] }` once per conversation; opening a
closed one posts again so the closing is lifted.

The index carries `last: { role, text, asks }` per conversation (cache v18):
one plain line of the last message on the active branch, and whether the
assistant ended with a question. The trailing question mark is a plain,
honest signal, not a reading of intent. This adds a little to the sessions
list (gzipped on the wire).

The rail dot, the phone badge and the `a` button count only listed
conversations: work in a conversation nobody opened here is not shown, so
it must not pulse either.

## What stays

Processes and delegated work that no listed row accounts for (a terminal
session nobody opened here, a warm RPC process, a server child) fold under
**Other processes** at the bottom, with the stop button. Clicking one opens
its conversation, which lists it. The recovery settings keep their place
below the list.

## Verification

- `test/agentread.test.js`: opened / closed / restored rules; a close
  touches nothing else.
- `test/open-list.test.js`: the real app — empty start, order by first
  message, the preview and no "No project" line, typing dots and elapsed
  time, the unread dot, the count, close with undo, return on a later reply,
  the `?` and `!` states, the ⋯ menu.
- `test/phone-shell.test.js`: the phone sheet shows the same list.
