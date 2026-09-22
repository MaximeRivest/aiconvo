# Simpler answers

## Reading experience

After a successful human-facing web SDK run, create one full plain-language
version of its final answer. Same model, lowest supported reasoning level,
never a cheaper substitute. Do not rewrite failed, cancelled, truncated,
tool-only, command-only, or delegated runs. Native RPC/terminal runs are not
covered. Settings → model → conversation answers controls `simplifyAnswers`
(default true). Internal background memory/title calls are unchanged.

The original still streams normally. During the optional pass the activity bar
says “preparing simpler version”. No live text is overwritten. When finished,
the original and simpler version share one answer location. A quiet `original`
or `simpler` action beside copy/read switches versions. It uses the same
hover, keyboard-focus, and tap-to-reveal behavior; there is no separate toolbar.
If the original has already been rendered in this browser, keep it selected.
A fresh visit to an already-completed pair defaults to the simpler answer.
Copy/read/actions belong to the actual selected native message, not a swapped
string. Exact search links can expose either message without hiding their target.
Both messages remain in exports, raw history, and future model context.

Trade-off: there is no second live stream. That avoids moving words, losing a
reading position, and confusing which version was copied. Sending another
message waits until the editing pass finishes, or the person stops it. The
extra call costs time and usage; simpler wording is not a guarantee of
unchanged meaning, so the original must stay available.

## Provider and cache behavior

`pisdk-rewrite.js` captures the final request at the SDK's public
`agent.streamFunction` boundary. It reuses the resolved model, prepared system
prompt, ordered messages, tool schemas, provider callbacks, and session/cache
identity. It appends the original assistant answer and the exact fixed rewrite
prompt. Reassembling prompt modes or changing the tool list would needlessly
change that prefix.

The stream call overrides only its cancellation signal and reasoning level.
It does not call `session.setThinkingLevel`: that API also persists the setting
for future work. Provider-specific handling of reasoning may still affect
cache reuse, particularly when turning thinking off. Neither cache hits nor a
latency improvement are guaranteed. The installed-SDK test checks the input
prefix, not paid-provider cache-hit statistics.

This is a single provider completion, **not an agent loop**. Tool descriptions
are retained for caching, but there is no code that can execute a tool call.
A tool-using, truncated, empty, cancelled, or failed response is not published
as the simpler answer. There is no automatic second editing attempt or
recursive rewrite. Existing provider transport retries can still apply.

The pass does not run prompt-preparation/context hooks again. It uses the
already-prepared context and still passes the existing provider request/header
callbacks through the original SDK stream function. A real extension turn
supersedes the optional pass; the web run continues tracking that real turn
until it settles.

## Durable records

- The editing request is a native `custom_message` with
  `customType: chattering-answer-rewrite`, `display: false`, and source entry ID in
  `details`. It stays in future context as the exact user-role request that was
  sent, but is not attributed to a person in the web transcript.
- A successful rewrite is a native assistant message, with its provider usage
  intact and `message.chatteringRewrite.sourceEntryId` linking the original.
- The parser exposes this link as `rewriteOf`. Pairing is restricted to the
  selected reading path/package and matching model/provider; it cannot reach
  across another user question.
- Failed output is a native `custom` diagnostic record, outside model context.
  Raw provider output/usage is preserved there, including unexecuted tool calls.
  The usage dashboard counts that failed call too. The original answer is never
  edited or deleted.
- Stopping/crashing the app may leave the hidden request without a rewrite.
  There is no replay on startup; the original remains readable.

## Verification

- `test/pisdk-rewrite.test.js`: exact prefix, model, schemas, session identity,
  reasoning isolation, cancellation, failure, stale targets, no tool execution.
- `test/pisdk-rewrite-real.test.js`: installed SDK, isolated credentials and
  fixture provider; native persistence, hidden prompt, and identical request
  prefix in the following normal turn. No paid requests.
- `test/answer-rewrite-ui.test.js`: pairing, defaults, existing-reader protection,
  search targets, branch/model separation, and settings.
- `test/conversation-reader.test.js`: real Chromium desktop/phone switching,
  copy correctness, focus, hidden request, choice retention, and overflow.

Restart the server only after active runs finish, then reload clients. Existing
conversations are not retroactively rewritten.
