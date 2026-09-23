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
   aligning the old and new transcriptions (LCS over the last words), so a
   revised word never repeats or loses an utterance. Past 1.2 × the target
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

## Limits and next steps

- Parakeet and the always-on Qwen service share the GPUs; when the Qwen
  service holds both, speech-to-text is off and the overlay says so.
- The page has one listener per tab; two devices listening at once both act.
- Places count rows on screen, in the list's own order; a file far from the
  project folder must be on screen to be picked. The home timeline's marks
  and the conversation tree are not pickable yet.
- Not yet: a Qwen fallback when TypeSafe is unreachable, spoken feedback,
  "undo that", voice in the conversation tree and the home timeline marks,
  calibrating the thresholds from the record.
