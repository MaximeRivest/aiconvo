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

## State

One new shared mark in `agent-read.json` (`agentread.js`, design/42):
`opened[key] = at`, set the first time a person opens the conversation and
kept forever after. `dismissed[key]` (the ✕) hides a listed conversation
until activity newer than the closing arrives — the same rule as before,
now with a clearer meaning. `isListed = opened && !dismissed`. Marking a
conversation unread by hand also lists it (the person asked for it). The
browser posts `{ open: [keys] }` once per conversation; opening a closed one
posts again so the closing is lifted.

The rail dot, the phone badge and the `a` button count only listed
conversations: work in a conversation nobody opened here is not shown, so
it must not pulse either.

## What stays

Processes and delegated work that no listed row accounts for (a terminal
session nobody opened here, a warm RPC process, a server child) fold under
**Other processes** at the bottom, with the stop button. Clicking one opens
its conversation, which lists it. Interrupted runs and the recovery
settings keep their place above and below the list.

## Verification

- `test/agentread.test.js`: opened / closed / re-listed rules.
- `test/open-list.test.js`: the real app — empty start, order by first
  message, typing dots vs. the unread dot, the count, close, return on a
  later reply, the ⋯ menu.
- `test/phone-shell.test.js`: the phone sheet shows the same list.
