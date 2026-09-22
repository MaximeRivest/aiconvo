# Reply speed: observed answer text, not billed output

## Contract

Measure **delivery to the hosted Pi SDK subscriber**, before IPC and browser batching. This is not a provider-side decoding benchmark. A provider or proxy can buffer chunks; SDK extension handlers can delay delivery. We cannot recover token emission timestamps or hidden reasoning from those observations.

The headline is **answer-text characters per second**, converted to an explicitly approximate token rate (`≈50 tok/s`). Hidden reasoning is never in the numerator. Visible thinking and tool-call arguments have separate counters; tool execution output is not measured.

Per assistant message, not per user turn:

- Each text content part has its own first/last nonempty delta times. Sum the spans, not the gap between separate parts. Visible thinking between text parts is excluded. Undetectable hidden work within an open text part can slow the observed rate; we do not guess how much time to remove.
- The first chunk has no measured interval preceding it. Count its characters, but exclude them from the rate numerator. The numerator and denominator then describe the same arrivals.
- `text_end` and `message_end` can reconcile the final visible character count but do not extend the timed span. Final-only content has no rate.
- Use Unicode code points, correcting surrogate pairs split between chunks. These are not grapheme clusters or provider tokens.
- `waitMs` measures **turn_start → first text delta**. It includes context preparation and waiting; it is not provider-only time-to-first-token or the entire user-submit delay.
- Use a monotonic clock for durations. A separate wall clock dates the saved sample.
- Require at least **1 second and 200 timed characters** for a rate. Too-short and one-chunk replies remain recorded, not assigned zero or infinite speed. Failed/aborted replies retain measurements but do not enter comparative speed/latency distributions.
- Live rate is cumulative over the current reply, refreshed with stream events and the existing server broadcast throttle. It is not an instantaneous token-by-token speedometer.

Min/max/median and the 10th/90th percentiles are across eligible **reply rates**, not across chunks. The median gives each reply one vote; sample counts are displayed. These are observations of the user's workload, not controlled comparisons of models or settings.

## Token estimates and calibration

Fallback: four visible characters per token. Every token rate keeps `≈`, even after calibration. Ratios vary with language, code versus prose, and output formatting.

Learn a provider/model-specific median character/token ratio only from completed, text-only replies of at least 200 characters with an explicit numeric reasoning-token split. Use `output - reasoning`, never billed output alone. Do not treat a requested thinking level of `off`, a missing reasoning field, or absence of streamed thinking as proof there was no hidden reasoning. Do not calibrate on tool calls, thinking summaries, unknown content kinds, inconsistent final text, errors, or aborts.

Ten eligible replies are required before applying a learned ratio. Providers that never report a reasoning split can remain on the default indefinitely; this is preferable to silently counting hidden work. The picker, live status and reply labels use the most recent 30 days. Dashboard distributions/calibration use the selected period and filters, with the ratio and calibration sample count shown alongside them. The same raw character rate can therefore produce a different approximate token rate in a differently filtered view; raw characters/second remain available for comparison.

## Architecture

### `responsespeed.js`

Pure event consumer with injectable monotonic and wall clocks. One current assistant message, counters/timestamps per content index, no retained response text. `observe()` yields a final sample on assistant `message_end`; `live()` supplies a current snapshot. Final counts and timed counts remain distinct.

### `pisdk-runtime.js`

A fresh meter binds to each session. It observes session events before forwarding, and adds `chatteringSpeedAt` to a copy of the forwarded event. The server uses that source timestamp, not arrival time. No SDK event object is mutated.

Pi emits `message_end` before appending its entry. Accumulate samples with message object references, then match those exact objects to saved assistant entries at `agent_end`. Timestamps are not identities: two replies can share a millisecond. Append one versioned `chattering-speed` **custom entry**, not a custom message, per agent run. The entry cannot reach model context. Recording failures emit a notice without failing the response.

Each record has a full measurement UUID and an array of samples, including reply entry IDs, provider/model, completion reason, wait, part counters and usage needed for calibration. Sample identity is measurement UUID + array index, not Pi's short entry ID. Copies retaining the metadata deduplicate without collisions between unrelated sessions.

**Persistence limits:** a crash before the run ends can lose pending measurements, while already saved chat survives. A native fork stopping at an assistant entry before the later metadata entry does not contain that metadata. Full copies retaining it do. We do not edit Pi's message objects or rewrite fork history to attach telemetry retroactively. Unmatched samples can still be aggregated but cannot decorate a specific reply.

### `server.js`

The run forwarder uses the same meter for the live status. SDK events carry the source clock; legacy RPC events use host arrival time and get a live estimate only. The transcript reader attaches compact timing data by reply entry ID. New metadata changes the file size, triggering normal reindexing; old transcript caches need no blanket rebuild.

The usage index is refreshed for a completed hosted run. The model-catalog endpoint and dashboard also start normal background synchronization. A revision-aware, 60-second cache supplies recent model statistics without database queries per delta. The model catalog's existing browser cache can delay new picker figures; its refresh control obtains current figures.

Machine-wide model statistics/calibration are only added to model/session API responses for owner/admin users, avoiding disclosure of other people's usage patterns through otherwise accessible endpoints. Other viewers can still see the timing of replies they are allowed to read, using the default token estimate.

### `usageanalytics.js`

Read speed metadata in the same pass as token usage. Only schema v1 is accepted; invalid counters and nonfinite durations are ignored, never converted into convincing zero-duration samples.

`usage_speed` is derived from transcripts. Its owners use the existing fork-deduplication machinery. Dropping the last owner removes the sample. A schema bump rebuilds the derived database, not source sessions. Per-file updates are serialized so completion refreshes and background scans cannot commit out of order. Revisions invalidate cached model statistics when scans add or remove data.

`/api/usage` returns per-model distributions and calibration, plus per-provider and daily distributions. The latter pool individual reply rates converted with each reply's model ratio, never medians of model medians. Speed follows period, project, provider, model and billing filters. The billing classification comes from the associated usage record. Existing usage/cost totals do not count speed records as extra model calls.

## Presentation

- **Live run status:** `streaming · 1234 chars · ≈50 tok/s`, once sufficient text arrives. Browser pushes remain throttled.
- **Model picker:** quiet median estimate after three eligible replies; tooltip gives range, count, recent period and median first-text wait. No speed-based automatic sorting.
- **Reply actions:** streaming span + approximate rate, revealed with existing hover/focus/tap actions. Click/tap details (also available by keyboard) explain raw character counts, wait and ratio; a tooltip provides the same information.
- **Usage dashboard:** per-model min/median/max, p10/p90, raw median characters/second, first-text wait and calibration details. Expandable provider and daily tables use the same underlying replies. Like existing breakdown tables, the model table shows the first 30 rows; the daily table shows the latest 62 days with measurements, explicitly labelled if truncated. The API returns all matching rows. No new terms in the context/cost meter.

Coverage starts with newly hosted SDK replies, including autonomous extension turns through that runtime. No historical backfill of timing, standalone terminal measurement, detached-worker measurement, legacy RPC persistence, browser-clock measurement, or optional raw-completion rewrite/derivation measurement is claimed.

## Tests

- `test/responsespeed.test.js`: hidden waits, separate text/thinking/tool spans, first-chunk treatment, one-piece answers, thresholds, Unicode boundaries, clock changes, end-event delays and conservative calibration.
- `test/pisdk.test.js`: runtime persistence, reply identity even on timestamp collisions, author entry ordering.
- `test/pisdk-real.test.js` / `test/fixtures/pisdk-probe.*`: real installed SDK in isolated workers, synthetic provider only; source timestamps cross IPC and records refer to saved replies.
- `test/usageanalytics.test.js`: parsing, database rebuild/deduplication, distributions and calibration.
- `test/response-speed-integration.test.js`: transcript association/ancestry, live source-time accounting despite IPC bursts, cache invalidation.
- `test/response-speed-ui.test.js`: actual browser picker, calibrated-but-still-approximate labels, keyboard/touch visibility and dashboard figures.

Run the browser tests with `CHROMIUM_BIN` pointing to an isolated-test-capable Chromium binary, not the shared-profile browser launcher. Tests create temporary profiles and never use the person's live browser.
