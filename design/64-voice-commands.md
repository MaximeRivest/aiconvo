# 64 · Voice commands: always listening

Status: first version, 2026-09-23. Built on request ("a toggle for an
always-listening mode, the text streaming, a sliding window of a minute or
two, a small overlay of what is transcribed and decided").

## What it does

Alt+L (anywhere), the pill, or Settings → sound switches it on for this
device. The browser's microphone streams to the server; sentences become
actions: "change the model to sonnet", "reasoning off", "open the third
conversation", "open the file called file view menu png", "open the
appearance settings", "go back", "start the microphone" (dictation into the
message box or the ask box until "send" / "stop dictating"), and in a file
"go to line 42", "change X to Y" (a change to review), "make this shorter"
(the AI "Change it"), "fix the grammar" (any Ctrl+J command), "open the ask
box", "accept" / "reject all", "bigger text", "stop listening".

## Pipeline

1. **Audio** (voice-commands.js): getUserMedia (echo cancellation on — the
   app's read-aloud stays out; noise suppression and gain off), resampled to
   16 kHz mono 16-bit, streamed on `/api/voice/listen?window=60`.
2. **Window** (voice-window.js, one per listener): a voice-activity gate
   with an adaptive floor (InkType's). Silence is dropped (≤ 400 ms of each
   pause kept): listening all day costs nothing; the window's length is
   speech. A 300 ms pause transcribes the whole window again (context); an
   800 ms pause ends an utterance — the words since the last one, found by
   aligning the old and new transcriptions from their shared start (LCS,
   earliest matches; letter edits for the words after the last shared one),
   so a revised word never repeats or loses an utterance. Past 1.2 × the target
   the window slides back to ~0.8 × at a pause: the head is transcribed once
   on its own and becomes final. Transcription is the InkType bridge's
   `POST /transcribe` (Parakeet, raw); the bridge itself is unchanged — it is
   shared with the tablet's keyboard and lives outside any repository.
3. **Decision** (voice-actions.js, shared): one TypeSafe request per
   utterance, the function-calling pattern: a Choice over the actions that
   apply on screen now (plus "not a request to the app"), and every argument
   of every such action asked at once over real candidates — conversations
   listed (with their position), models, files (the page's visible ones plus
   the project's, ranked by shared words, ≤ 250), AI commands, settings
   panes, numbers found in the sentence, spans of the sentence (old text: only
   spans present near the cursor; "this" is the selection). Jev selects;
   nothing is generated. Confidence is the least certain part used.
4. **Action** (voice-commands.js): ≥ 0.8 runs (≥ 0.92 for send, replace,
   rewrite, reject, stop listening); below, a suggestion waits 12 s for "yes"
   / "no" or a click; a missing argument asks. Utterances run in order.
5. **Record**: `~/.local/share/chattering/voice-commands.jsonl` (0600) —
   each decision (action, arguments, confidence, alternatives, timings) and
   its outcome (done, asked, confirmed, cancelled, failed, expired). The
   words of non-commands are kept only while the debug overlay is on.

## Measurements (lambda, 2 × RTX 3090, 2026-09-23)

Parakeet, whole-window retranscription (median of 3):

| window | 10 s | 30 s | 60 s | 90 s | 2 min | 3 min | 4 min |
|---|---|---|---|---|---|---|---|
| time | 67 ms | 124 ms | 229 ms | 348 ms | 476 ms | 745 ms | 1.1 s |

Jev (jev-latest, from lambda): 140–330 ms per request of ~10 questions; 18
of 18 test sentences right (including three that are no command), e.g.
"change reasoning to off" → reasoning(off) 1.00; "move to the file called
file view menu png" → design/file-view-menu.png 0.99 of 122 files; "change
their going to they're going" → replace(old "their going" 0.85, new "they're
going" 0.98); "change this to a shorter sentence" → rewrite 1.00.

Default window: 60 s (≈ 0.23 s + Jev ≈ 0.45 s after a pause). 30 s–3 min
in Settings.

## Picking what is on screen (2026-09-23, second pass)

"The top one", "the last file", "the previous one", "the one about air
bills", the files on the right: the first version gave Jev one question over
"1. Title" labels of the left list only, and file names without places.
Measured on a screen of 12 conversations and 8 files, 12 sentences: 4 right.

Now one action, `open`, for everything pickable (voice-commands.js
`voicePicks`: side-panel conversations and projects, right-panel files,
files-browser rows, conversation lists in the main view; plus conversations
and project files that are not on screen, by name). Picking clicks the item,
as the mouse does. Three small judgments instead of one (TypeSafe's advice:
one narrow judgment per question), read by code (voice-actions.js
`readOpen`):

- **number** — while listening, items in view carry a number (stable while
  on screen); "open seven". A lone "one" is not a number ("the r stats one").
- **place** — first…tenth, last, the one before the last, just above / below
  the open one; in the list the words name ("file", "conversation",
  "project", "on the right": an exact lookup, in code), else the list Jev
  heard, else the list with the open item. The page counts.
- **name** — kind and title only (the place and the number have their own
  questions; extra words in labels blurred the match). Its confidence is
  among the items: the "(not said)" share is what the other questions answer.
- A doubtful place loses to a sure name ("the r stats one" sounds like "the
  first one").

The questions point at `said` (without it, the screen description — which
names the open conversation — pulled names toward it).

Result on 18 sentences (the 12 above, "open the conversation about garden
planning" off screen, "open voice window js", "what can I say", "go back",
one aside): 18 right, twice; 15 at ≥ 0.8. Going somewhere now acts from 0.6
("go back" undoes it); sending, replacing and rejecting still need 0.92.

"What can I say" (the overlay's "?", or said) lists the actions that apply on
this screen with example phrasings — the same catalog Jev picks from — and
the lists that can be picked from; while dictating, what steers dictation.

## Keeping everything, and what the first session taught (2026-09-23)

The record now keeps every sentence (v2 lines): what was said, the words
before it, the screen, the speech-to-text time, the actions offered, how
many candidates each list had, Jev's answer to every question (the action's
whole distribution, the five likeliest options of each argument), the
decision and its outcome; a failed call to TypeSafe with what was said; and
the person's note on a sentence ("what did you want?"). Settings → sound →
what you said shows it (all, or not understood: not a command, asked and
not confirmed, failed), takes notes, and forgets on request.
`GET /api/voice/history`, `POST /api/voice/note`, `POST /api/voice/history/clear`.

The first real session (99 sentences, 20 minutes) showed:

- Missing commands, now added: regenerate ("regenerate the last answer",
  "resend last message"), scroll (up, down, a page, top, bottom), start a
  new conversation, put the cursor in the message box ("focus the input
  box", "get into the compose box"), expand a folded message ("click more
  on the last message"), "are you listening", and "open the command panel"
  (the list of commands).
- "Stop dictation" said when not dictating turned listening off (99% sure,
  twice). `stop_dictation` now catches it in command mode, harmlessly;
  `stop_listening` says it is not that.
- Utterances repeated words already handed on (French re-heard with more
  context; "Start dictation." sent again as text). The window aligned the
  new transcription with the old by words; a word rewritten at the boundary
  matched nothing. Now an unsure alignment counts from the last shared word,
  and transcribes the decided audio once to count its words (same audio, same
  context). (A word re-heard as two could still leak one; fixed since, see
  below.)

Replaying the session's missed sentences and a sample of the rest against
Jev with the new catalog: 26 of 26 right.

### Real speech through Parakeet (2026-09-23)

A synthetic voice (Kokoro, two voices) with room noise, fed through
VoiceWindow to the real bridge, twelve commands repeated three times
(177 words, real time, 60 s window): nothing lost or handed on twice;
3.4–4.0% word errors, all Parakeet's own ("42" for "forty two", "Zend").
Transcription: median 160 ms, at most 280 ms for a 72 s window.

That run found two window bugs, both now covered by tests:

- **Repeated phrases re-sent a batch of old words.** The alignment looked
  only at the last 80 words of each transcription; with commands said
  again ("scroll up… scroll up") it matched the earliest copy, a whole
  cycle back, and ~100 words already acted on were handed on again. Both
  transcriptions start at the same audio, so they are now aligned from the
  start (≤ 1000 words, ~7 ms).
- **A merged word swallowed the next sentence's first word** ("Voice
  Window JS" re-heard as "voice window.js" → "can I say?"). After the last
  shared word the count is now the number of new words fewest letter edits
  from the old ones ("window js" = "window.js", "char lie" = "charlie",
  "Sender" = "Send", not "Send Start"); a word count only when the letters
  mostly differ (another language), where the realign pass decides.

Still open: a word the recognizer invents at the end of the window and
drops on the next pass (seen once with synthetic noise at 3× speed, never
in the 99 real sentences) can take the place of the next word. Word
timestamps from Parakeet would settle it and the realign pass with it;
they need its server and the bridge changed (shared with the tablet).

## Acting on what is on screen (2026-09-23, third pass)

Asked for: smooth scrolling that starts and stops, highlighting ("the last
answer"), the message buttons (copy, read, notebook, more…), "review the
turn", moving through the steps, opening the thinking as it streams, the +
menu, moving in the conversation tree, timeline marks by number or name,
the project memory button, find / select / code chunks in a file, opening
a file of any project, handing requests to the coding agent, zen, and "the
latest unread".

Two general pieces carry most of it, so the catalog stays small (43
actions) and new buttons need no code:

- **The voice cursor** (`point`): one highlighted message, group of steps
  or thinking block, by kind (message, answer, mine, steps, thinking) and
  place (last, first, next, previous, the one in view). An outline, not a
  tint (e-ink). It survives a re-render by the entry id or the step
  group's key. Next and previous go from it in page order, else from the
  middle of the view. Steps and thinking open when pointed at; folds above
  a pointed item open too.
- **Buttons by name** (`press`): every control in the window (buttons, menu
  headings, links) with its text, else its title ("−" is "− (Zoom out)"),
  where it is ("in the message box", "in the tree bar"), and the items of
  closed menus as "menu › item" (the + menu, a message's "more…"). A
  transcript item's own buttons come only from the highlighted item, else
  the last answer: forty "copy" buttons would name none. Review buttons in
  view, and the last turn's "Review whole turn" even scrolled away, are
  offered. A menu heading says it opens a menu and what is in it ("open the
  menu: Attachments and conversation options (Context, Snippets,
  Conversation tree, Attach image)"). A timeline mark's open card is
  "open the selected mark". A button whose words are risky (delete,
  abort, send, stop, discard, merge…) needs 92%. Pressing is a click, so
  the app's own handler does what the mouse does; the pressed control
  blinks (a dashed outline).

The rest:

- `fold`: open/close the highlighted item (or the last message's "show
  more"), every group of steps, every thinking block (their groups open
  with them), the live stream of the reply being written (its line in the
  run strip), or everything (close = the `x` key's fold-all).
- `autoscroll` (down/up, slow/normal/fast) and `autoscroll_adjust` (stop,
  faster, slower, reverse; offered only while scrolling). Smooth on a
  screen, **a page every few seconds on a theme without motion (e-ink)**. A
  wheel, touch or key takes the page back. **"Stop" is caught in the live
  words** at the first 300 ms pause, before the sentence ends and before
  Jev: about half a second after the word instead of 1–2 s. The sentence
  "stop" that follows is then marked done locally, without Jev and
  without a question. Stopping never needs confidence.
- `zen` (on, off, toggle), `unread` (the newest unread reply; says how
  many remain), `tree_move` (parent, child, sibling left/right, open: the
  tree's own arrow keys and Enter). "Open it" with nothing named opens
  what is selected: the tree's box, the mark whose card shows.
- Pickable by number, place or name, besides the earlier lists: **timeline
  marks** (home and project; named with both titles and their project, so
  "the parser mark in chattering" finds it; a click shows the card) and
  **the tree's boxes**.
- In a file: `find` (the words said that are in the file, longest first;
  "parse config" finds parse_config, parseConfig, parse-config; next /
  previous with `find_again`), `select` (line, paragraph, sentence, word,
  code chunk, all, lines N to M, from words to words, none; counted from
  where the selection starts, so "find X" then "select the sentence"
  selects X's sentence), `chunk` (next, previous, first, last) and
  `chunk_run` (this, this then the next, all, stop; "all" needs 92%). On a
  touch screen the editor is not focused, so no keyboard rises; the
  selection shows anyway.
- **Anywhere** (`open`): every project by name, and the files of any
  project the sentence names ("the notes file in alpha beta"), not only
  the open project's. A file opens in its own project.
- **The coding agent** (`delegate`): what no command does ("find the
  conversation where we fixed the login", "show me where the parser is
  defined") goes to a quiet agent conversation, as a Ctrl+K ask does (the
  ask box's model, else the project's), with all its tools, told to change
  nothing and to end with one line: `SHOW: file PATH[:LINE]`,
  `conversation ID`, `project NAME` or `nothing WHY`. The server checks the
  target against what this person may see; the page opens it if you are
  still where you asked, else offers it. **The agent never drives the page
  itself**: it finds, the page shows. Its conversation stays, to see how
  it searched.
- Optional arguments (a speed, a direction, where a selection starts…)
  default when not said and their doubt does not hold the action back.
- The history shows what a list argument was called on screen ("copy · on
  the highlighted message"), not its id, and what the agent found.

Measured against the real Jev, on the real app's screens (a conversation
with thinking, two groups of steps and two turns; the tree; a notebook; the
home timeline), 50 sentences: **49 right; 44 sure enough to act at once**.
The miss: "open the attachments" chose the "Open files" button at 53%, so
it asks. "Open the attachments menu", "the conversation options", "the
plus menu" all find the + menu. Unchanged sentences from before (scroll,
settings, go to line, rewrite, not-a-command) stayed right. Along the way
the first run (37 of 42) showed what the labels needed: "step" in the
singular, the menu's contents in its label, the last turn's review off
screen, both titles on marks, "open it" as what is selected.

TypeSafe answered in 0.8–1.5 s during this run, even for the smallest
request, against 0.14–0.33 s in the morning: their load, not the requests.

The hand-off to the agent was run end to end (a quiet conversation starts,
the agent runs, the server waits and reads its answer) with a local model,
which answered nothing; the SHOW line's reading is unit-tested; a real
model's answer turned into a screen is not yet tested.

## Editing a file by voice (2026-09-23, fourth pass)

The session after the third pass (119 sentences) showed editing a
Markdown file was the weak part: no way to move the cursor ("go down
twenty lines", "press down arrow" scrolled the page), no dictation into a
file ("start dictation", "add text" were no command), selections that
reported done but held the wrong text ("select third paragraph", "select
line 10"), "replace line ten with…" replacing the words "Line ten" of the
filler, commands cut by a pause ("go to line" … "eight"), "control find"
sent to the coding agent, "press stop" on a message read aloud taken as
"stop dictation", and no way to close the voice help.

Every sentence still goes through Jev (no local grammar: the person's
choice, and Jev understands loose phrasings better). What changed is what
Jev is asked and what the code does with it:

- `cursor`: up/down N lines, a line by number, next/previous word,
  sentence or paragraph, start/end of line or file, before/after/at words
  of the file, center the view. Counts and line numbers are separate
  questions over the numbers said.
- `select` by unit (word, words named, line, lines N–M, sentence,
  paragraph, chunk, all, from words to words, more, none), which one (this,
  next, previous, first, last, the n-th) and how many. The code reads an
  ordinal ("the third") from the sentence and settles "select the word
  blue" answered as unit=word with named words.
- `replace`: what to replace is the selection, a place at the cursor (word,
  line, sentence, paragraph), a line said by number ("(line 10)", never the
  words "line ten"), or words said that are in the file; "this", "this
  sentence" are never words. The new text: words said, nothing (delete,
  taking one space with it), or what is dictated next (the old text is
  selected and dictation writes over it). Replacements are changes to
  review, so they act from 0.6 instead of 0.92. "Change that to X" with a
  selection means the selection even when the answer leaves it out.
  Overlapping spans ("green plates", "the green plates") add their shares:
  one answer said several ways.
- Dictation into the file at the cursor (spaced, lower case when it
  carries on a sentence), with its own choices: text, new line, new
  paragraph, scratch that, fix that, stop, and "a command to the editor",
  which decides the sentence again as a command and goes on dictating.
- `fix_dictation`: the Fix dictation AI command on the dictated run, as a
  change to review. `undo` / `redo` through the editor's own keys.
- A sentence that is incomplete (asked, or failed with "which…?") and the
  next one within 6 s: the next is decided again joined to it, and the
  joined decision runs when it is sure.
- The audio player of a message read aloud is pressable (stop, pause,
  replay, speed); `help` opens and closes.

**The tree was measured and dropped.** TypeSafe's hierarchical pattern (a
family, then the request in it, all asked at once, the path scored by the
geometric mean) was asked in the same requests as the flat choice, so both
read the very same answers: flat 62 of 67 right, tree 47 of 67 (file 36 vs
42 of 47, conversation 11 vs 20 of 20). The second level spread its
probability over look-alike families ("next word" into AI commands, "copy
it" into dictation). Flat stays; the tree's questions only cost time.

After the fixes, the same sentences (the session's own, new editing ones,
dictation into a file, and the conversation set as a check): **63 of 64
right** (three more got no answer: TypeSafe was overloaded); 60 sure enough
to act at once. The miss: "go to the line a place to try voice" is taken
for dictation. TypeSafe answered in 1.4–2.6 s median this evening.

### Keys, and reviewing voice's own changes

`key` presses any key (Escape, Enter, Tab, arrows, Backspace, Delete, Page
Up/Down, Home, End, F1–F12, letters, digits) with Ctrl, Shift or Alt, N
times: a keydown and keyup sent to the focused element, as the app's
shortcuts and the editor's keymap listen for them. A browser page cannot
type for real, so in a plain text field the key's effect (a letter,
Backspace, arrows) is done by hand. Escape acts at any confidence; Enter,
Delete, Backspace and Ctrl-keys need 92%. A voice replacement leaves the
cursor on its change, so "accept" / "reject" mean it. Against the real
Jev: 19 of 20 ("present" alone, misheard for "press enter", is no command:
too common a word to press Enter on).

## Limits and next steps

- Parakeet and the always-on Qwen service share the GPUs; when the Qwen
  service holds both, speech-to-text is off and the overlay says so.
- The page has one listener per tab; two devices listening at once both act.
- Places count rows on screen, in the list's own order. Files of another
  project are offered when the sentence names the project.
- Not yet: a Qwen fallback when TypeSafe is unreachable, spoken feedback,
  "undo that", calibrating the thresholds from the record, selecting text
  inside a message (the cursor highlights whole messages), an agent that
  may change the screen beyond opening one thing.

## Where the off button lives (2026-09-24)

Off, one tap on a microphone starts listening. Voice is a setting of the
device for the whole app, like the profile, so on wide screens the button
sits in the side column's foot beside You: part of the layout, over nothing.
With the column folded it sits beside the ▸ at the top left; the page heads
keep that corner free (`--corner-l`), as they keep the files square's
(`--corner-r`). On a phone it stays in the message box's row.

It was beside the files square at the top right for a day. That covered
the file editor's Save and ⋯. And when Files opened, the square went away
and the button fell into the message box, next to the dictation microphone
that looks the same and does something else. `test/floating-corners.test.js`
checks every view, with the column shown and folded, for a floating button
over a page's buttons, and the button's home.
