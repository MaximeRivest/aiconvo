# Claude routines: portability experiment

Date: 2026-09-21. Status: observed experiment and proposed architecture, **not an implemented importer or scheduler**.

**Product distinction:** the initial CLI experiment and the final `/code/routines` browser experiment concern **Claude Code Routines**. The intervening `/scheduled-task` browser experiment concerns the general Claude scheduled-task surface (`cowork_task`). Shared API storage does not make those the same product or runtime. In particular, the 66,876-character saved custom system prompt was observed on the general scheduled task, not on either Code routine. See the two separately labeled browser follow-ups below.

## Outcome

Created one repository-free diagnostic routine through Claude Code 2.1.278, manually fired it exactly once, and left it disabled. It used Bash to report its location, wrote a two-line marker file, read it back, and finished successfully. No recurring cron schedule, webhook, API token, repository change, or application restart was introduced.

The CLI creation instructions required a schedule, so the experiment used a **disabled one-off timestamp**, 2026-09-22T18:00:00Z. A manual run worked while `enabled:false`; no temporary enabling was needed. The future `next_run_at` remained populated even when disabled. Do not infer enabled state from that field alone.

We recovered the routine definition, session metadata, run history, and all 25 events returned for the completed run. A small offline conversion let the existing Chattering parser read the prompt, three tool calls, three results, and final answer. This proves a narrow reading path, not production import, browser rendering, or Pi continuation.

## Private evidence

The experiment's account-specific records and scripts are retained outside Git:

```
~/.local/share/chattering/research/claude-routines/2026-09-21/
```

Directory permissions: 0700; files: 0600. No authentication tokens were copied there. The read-only retrieval script reads the existing Claude credential at execution time and sends it only to the first-party API, refusing redirects. Do not publish the raw files: records can contain account identifiers, prompt contents, tool output, and signed thinking blocks.

Important files:

- `routine-raw.json`: saved definition, disabled state, last-run outcome.
- `session-raw.json`: session configuration, including the appended routine instructions.
- `runs-raw.json`: actual sessions created by this routine.
- `events-page-001.json`: 25 raw events, sequence numbers 1–25.
- `events-page-002.json`: empty page confirming the end of this snapshot.
- `cloud-event-envelopes.jsonl`: the same events, one envelope per line.
- `create-result.json`, `run-result.json`, `inspect-run-result.json`: CLI management evidence.
- `before.json`, `after-files.json`: local filesystem metadata comparison.
- `file-endpoint-checks.json`: limits encountered when requesting remote files.
- `fetch-records.py`: read-only exporter for this particular diagnostic.
- `check-chattering-parser.cjs`: offline experiment using the real parser extracted from `server.js` without starting the server.
- `chattering-display-projection.jsonl`: **display-only experiment**, not a resumable native transcript.
- `parser-check.json`: checked results.
- `SHA256SUMS.json`: hashes of the retained evidence files.

These scripts are deliberately specific to the experiment, not supported production clients. They do not handle token refresh, arbitrary account configuration, general run pagination, or every possible event/session shape.

## What is on disk, and where

### On Lambda

The management conversations are ordinary Claude transcripts:

```
~/.claude/projects/-tmp-claude-routines-probe/<local-session-uuid>.jsonl
```

Those record requests to create/run/inspect a routine and their responses. They are **not the cloud execution's own transcript**. Chattering can discover these local management conversations today.

The observed filesystem comparison found no separate local routine-definition file and no native transcript named for the cloud execution's inner session UUID. The marker file did not appear on Lambda. This is a result for CLI management in this experiment, not a claim about every Desktop client, attachment, cache, or teleport workflow.

### In the cloud

The run reported:

- Working directory: `/home/user`.
- Hostname: `vm`.
- Native Claude version: 2.1.278.
- `$HOME/.claude/projects` exists.
- Marker artifact: `/tmp/chattering-routine-probe-20260921.txt`.

The exact native transcript filename **was not verified on the remote filesystem**. A predicted native path and the known marker path were both rejected by the read-only file endpoint: that endpoint permits only `/mnt/user-data/outputs` and `/mnt/user-data/working`. Do not mistake our downloaded API event export for a byte-for-byte copy of the native cloud JSONL. No attempt was made to bypass that restriction.

The artifact contents are evidenced by both the Write arguments and successful Read result. Artifact bytes were not separately downloaded. A future diagnostic should deliberately write deliverables under a supported output directory if artifact download is part of the test.

## Three identities, not one

Keep these distinct:

1. Routine/trigger ID: `trig_…` — the persistent task definition.
2. Cloud execution ID: `cse_…` — the session listed under a routine; its web URL uses `session_…`.
3. Native inner Claude session ID: a UUID in the run's init/message events.

The local CLI management sessions have still other UUIDs. Do not deduplicate these different objects using only a title or treat their working directories as interchangeable.

## Retrieval and format observations

The installed CLI's `RemoteTrigger` tool exposes:

- `list`, `get`, `create`, `update`, `run`.
- `create_webhook_trigger`.
- `list_runs`, `get_run_log`.

Its management calls use the first-party `/v1/code/triggers` and `/v1/code/sessions` API paths with the installed CLI's routine beta header. We successfully made authenticated read-only GETs to those same endpoints for the account's test objects. **This demonstrates current behavior; it is not a stable public API compatibility guarantee.** Isolate this transport behind a provider adapter rather than embedding it throughout Chattering.

`get_run_log` is insufficient for faithful import: it displayed 19 of 25 events, omitted lifecycle events, shortened long text, flattened tool results, and reduced thinking to a marker.

The raw event response is different:

```
{
  "data": [
    {
      "event_id": "…",
      "sequence_num": "1",
      "created_at": "…",
      "event_type": "…",
      "payload": { "type": "user", "message": { "…": "…" } }
    }
  ],
  "resume_cursor": "25"
}
```

We followed `resume_cursor` with `cursor=25`, ascending order, and reached an empty page. The raw run listing returned `resume_token`, not the condensed tool's `next_cursor`. Do not write a general exporter based on the CLI summary's paging keys. Sequence numbers were strings; preserve them losslessly.

The event stream includes provisioning logs, init, prompt, tool calls/results, model metadata, lifecycle events, and final result. Two thinking blocks had **empty text** and nonempty signatures: raw access does not imply reasoning text is available.

The session endpoint returned a `response_shape` wrapper in this account/version. Preserve the raw response and validate versioned shapes instead of assuming the direct session object.

## Chattering parser experiment

Relevant existing code:

- `server.js`: `SOURCES`, `parseFile`, `toolEventsOf`, `indexFile`.
- `usageanalytics.js`: `parseUsageFile`.
- `pisdk.js`: existing worker/session execution boundary.

Observed offline results:

| Input | Result |
| --- | --- |
| Raw event envelopes as JSONL | Zero transcript messages: the parser expects message records, not envelopes. |
| Unwrapped `payload` objects | Eight rows, all off-branch; no working directory. |
| Display projection with timestamps, `sessionId`, cwd, and explicit chronological parent links | Eight correctly linked rows: one prompt, three tool calls, three results, one final answer. |

Call/result identifiers were preserved and checked. No thinking rows were fabricated for the empty thinking blocks.

**Do not copy the projection into `~/.claude/projects`.** Its parent links are an explicitly synthetic chronological reading order, not recovered native branch ancestry. It still carries remote paths, and the existing local-source path logic could incorrectly treat them as Lambda files. The proof only handles root-level messages; subagents, branches, compaction, attachments, and reconnect duplicates need dedicated handling.

Usage also needs separate normalization: multiple streamed assistant events shared a model message ID and repeated usage fields. The current local Claude usage reader keys on event UUIDs, so ingesting all these fragments unchanged risks overcounting. Preserve per-run totals separately, and reconcile request-level usage without counting repeated fragments or summing totals on top of requests. Report subscription-equivalent cost as an estimate, not an invoice.

## Behavior not captured by the task prompt alone

1. **Connector defaults:** despite omitting `mcp_connections`, creation attached two account-default connectors. A follow-up `clear_mcp_connections:true` removed them before firing; the saved record and run init confirmed none remained. The CLI-generated explanation that omission meant no connectors was wrong for this account. Verify the saved object.
2. **Tool exposure:** configured `allowed_tools:[Bash,Read,Write]` did not restrict the advertised runtime tool inventory to those three. The run exposed many other built-ins, though it only used the requested three. Do not treat this field or prompt instructions as a sandbox boundary.
3. **Routine-specific instructions:** session configuration included an appended prompt directing the agent to notify the person on actionable findings or failures and remain quiet when nothing needs attention. It referenced Claude's `PushNotification` tool. A Pi migration needs an explicit replacement notification policy/tool, not that prompt copied verbatim.
4. **Completion:** the routine reported `ROUTINE_RUN_STATUS_SUCCEEDED`, with a successful final `result`. Meanwhile its conversation remained `status:active`, `worker_status:idle`. A still-open conversation is not necessarily a still-running job.
5. **Files and dependencies:** a definition's cloud environment reference is not a portable runtime. Local folder mappings, dependencies, network restrictions, credentials, integrations, and notification delivery need review.
6. **Fresh versus persistent context:** this routine saved `persist_session:false`. Do not assume every migrated definition should continue one long conversation; preserve and explicitly interpret that setting.

## Proposed integration: two independent capabilities

### A. Read cloud routines and their runs in Chattering

Keep the execution on Claude while adding visibility:

- Store original provider definitions and raw events in a dedicated cloud-source area, outside native local session folders.
- Stable identity: account + provider + routine ID + cloud session ID + event ID.
- A small adapter supplies normalized, read-only transcript rows, run status, tool activity, and provenance to existing views.
- Incremental cursor synchronization, idempotent event upserts, explicit incomplete/stale status, atomic publishing.
- Remote paths remain remote; only explicitly downloaded/mapped artifacts become locally openable.
- Routine results join the existing attention flow, with a reviewed notification policy rather than flooding unread results.
- Keep account ownership, project mapping, and collaborator visibility explicit. A remote `/home/user` directory must not automatically become a new local project or confer access.

Trade-off: cloud execution remains dependent on Anthropic, but this is the lower-risk first step and preserves historical truth.

### B. Adopt a routine as a Pi-run Chattering task

Create a **new local task**, retaining an origin link:

- Copy editable task instructions and trigger intent into an engine-neutral task definition.
- Ask the person to choose execution host, working directory/project, model, mode, permitted capabilities, and integrations.
- Keep imported tasks disabled until those choices are reviewed.
- Start fresh native Pi sessions through the existing execution path; attach prior cloud history as clearly labeled reference only when desired.
- Preserve cloud runs as historical Claude records. Do not relabel them as Pi runs or replay foreign thinking signatures/tool calls as native Pi history.
- Supply a Chattering notification mechanism consistent with the routine's intended quiet/actionable behavior.
- Build a durable scheduler with timezone semantics, restart recovery, missed-run policy, concurrency limits, cancellation, and deduplication. API and event triggers need authenticated handlers and duplicate-event protection.
- Make source disabling and destination activation an explicit handover to avoid running the same automation twice.

Trade-off: tasks can use local compute and the user's chosen models, but Chattering must own scheduling, safety, integrations, and notification delivery. Copying a prompt does not preserve the original environment or guarantee equivalent behavior.

This proposal does not assume a validated native Claude-to-Pi session conversion. The current experiment did not create or run a Pi routine.

## Website follow-up: verified on the laptop

Later on 2026-09-21, used the existing Chromium session on XPSwhite through `agent-browser` with `AGENT_BROWSER_HOST=xps`. All creation, confirmation, pause, and run actions were performed through visible website controls, not API mutation calls.

Flow: **Scheduled → New task → Create with Claude**. Answered Claude's setup question with a harmless exact two-line-output task, a one-off date, notifications off, and a request to save paused if possible. Claude presented a confirmation showing the exact task instructions and notification setting. Confirmed it once.

The resulting record was immediately discoverable through the **same authenticated `/v1/code/triggers` API used in the CLI experiment**:

- Name: `Chattering website portability probe 2026-09-21`.
- `created_via: meta_mcp`, `created_kind: cowork_task`.
- Model: `claude-fable-5`.
- Exact user task text matched both `derived_state.prompt` and the saved kickoff event, character for character.
- Requested September 22 at 3 PM America/Toronto became `2026-09-22T19:00:00Z`.
- Push and email notifications were both false.
- `persist_session:false`.

The creation flow could not save paused. It created the future one-off enabled; we then clicked **Pause** in the website and verified `enabled:false` through the API. The website initially showed a stale empty list and a not-found detail page until a full page refresh; after refreshing, the task and its controls were available. This was a client-side observation, not an API creation failure.

Clicked **Run now** exactly once while paused. The task succeeded and remained disabled. The displayed answer and exported final result both were:

```
CHATTERING_WEB_ROUTINE_PROBE_20260921
17 + 25 = 42
```

Fetched 19 raw events followed by an empty page. Checked contiguous event sequence numbers, unique IDs, one successful final result, one run total, and **zero model tool calls**. The two account-default connectors were present in the saved website-created task but were not called; unlike the CLI experiment, this run did not require any tools.

### More saved instructions than the first test revealed

The website-created record also contained:

```
job_config.ccr.session_context.custom_system_prompt
```

It held **66,876 characters** of saved additional instructions. This materially narrows the previous uncertainty: we can retrieve the saved custom system prompt for this website-created task, not just its user-facing instruction or notification wrapper. Keep that material private; it can include account-specific context. It is not proof that every runtime instruction, dynamically loaded tool definition, environment setting, or provider-internal behavior is present in that field. The separate session metadata endpoint did not expose that full field in its returned `config`.

We explicitly requested exact task wording, and it was preserved. This does **not** test whether Claude rewrites underspecified requests during other setup conversations or whether any such drafts are retained in the task record. The setup chat is a separate web conversation.

### Website identities and retained evidence

This route adds another presentation identity: following the run-history link `/cowork/cse_…` opened a `/chat/<uuid>` page. Preserve the cloud run ID and browser conversation ID separately; they are not the native inner session UUID or the setup conversation's ID.

Private evidence, four screenshots, a read-only re-export script, and checked facts are under:

```
~/.local/share/chattering/research/claude-routines/2026-09-21-web/
```

Start with `verification.json`, `routine-raw.json`, `result-page.json`, and `04-completed-run.png`. The setup chat, task, and result identifiers are retained there, outside Git. The laptop browser was left showing the successful result. No Pi/Chattering production import was installed, no service was restarted, and both experimental routines remain disabled.

**Confirmed conclusion:** at least this website-created scheduled task is accessible through the same cloud routine API and can be exported without reconstructing its prompt from screenshots. This is stronger than the earlier expectation, but it is still one controlled task, not validation of every task type or account configuration.

## Correct Code Routines web surface: explored and tested

At the user's direction, returned to the laptop's `/code/routines/new` page on 2026-09-21. This is a distinct experience from the preceding `/scheduled-task` test. The Code **Yours** list showed the original CLI-created routine but did not show the general scheduled task; the account API listed both.

### What the product offers

These controls were inspected directly in the browser, without saving exploratory settings:

| Area | Observed control or behavior |
| --- | --- |
| Assignment | A name, plain instruction textarea, and model selector; no prompt-optimization step in this manual creation flow. |
| Repositories | GitHub repository selector. This account showed no repositories and later explicitly requested reconnection. |
| Execution environment | Named environment with network controls, environment variables, protected API credentials, and setup script. Changes apply to new sessions. |
| Network policy | None, Trusted, Full, or Custom allowed domains. |
| Schedule trigger | Once, Hourly, Daily, Weekdays, Weekly, and a Custom cron editor. The 9 AM local default appeared as `0 13 * * *` in the editor. The UI warns of a few minutes of stagger. |
| API trigger | Can coexist with the schedule. UI says the token is generated on save. No API token was created during this exploration. |
| GitHub trigger | The release-notes template seeded `Pull request: Closed`; expanding it required reconnecting GitHub. No authorization flow was started. |
| Behavior | **Auto-fix pull requests**: watch CI and review comments on PRs the routine opens, and let Claude push fixes. Default was off. |
| Notifications | Master switch, plus push, email, and Slack direct-message channels. Text distinguishes completion summaries from conditional watchers that notify only on noteworthy findings. |
| Run management | Active/paused switch, Run now, run history, and full Code sessions with expandable tool activity, file-change summaries, and a reply composer. Manual run worked while paused. |

The GitHub feature was blocked by **“Reconnect your GitHub account to set up GitHub-triggered routines.”** We did not reconnect the account, install the GitHub App, grant repository access, register a webhook, or run an actual PR workflow.

The environment editor warns that ordinary environment variables are visible to users of the environment, while its API credentials feature attaches credentials without exposing their values to the session. The account had no saved API credentials in that editor. We did not change the environment or reveal credentials.

### Templates explain the intended work

The Code templates were: Briefing, Email triage, System health check, Issue triage, PR review digest, Dependency update check, Release notes drafter, and Flaky test tracker. This shows overlap with general task automation; it does not reduce Code routines to reminders.

Opened **Release notes drafter** without saving it. Its actual prompt tells Claude to read a merged PR's title, description, and diff; skip internal-only changes; otherwise draft a short user-facing entry classified as New/Improved/Fixed/Breaking; give migration instructions for breaking changes; and post the draft as a PR comment. The task is an event-to-repository-action workflow, not simply a scheduled chat message.

### Documentation cross-check, not live GitHub testing

Fetched current official Markdown documentation and retained it privately:

- `https://code.claude.com/docs/en/routines.md`
- `https://code.claude.com/docs/en/claude-code-on-the-web.md`

The documentation describes fresh repository clones, `claude/`-prefixed work branches, combinations of triggers, scoped bearer tokens for API firing, and PR/release GitHub events. PR filters cover author, title, body, base/head branches, labels, draft state, and merged state. Events spawn independent sessions; webhook delivery requires the Claude GitHub App, not just cloning access.

The Code-on-web auto-fix section describes a **per-PR watcher**. CI failures and reviewer comments can cause additional investigation and pushes; ambiguous requests are surfaced to the person. Base-branch changes that create merge conflicts do not themselves emit the required webhook, so conflict resolution may need a manual request. This is not a promise to automatically merge PRs. Comments made by the agent can also activate a repository's other automation, so the permissions and integration consequences matter.

These GitHub details are documented capabilities, not behavior verified against this account's repositories. The source says the product is in research preview. Also, its text suggested setting custom cron through the CLI, while the inspected form already exposed a Custom editor: keep live observations distinct from documentation assumptions.

### Harmless coding run through this exact form

Created **Chattering Code routine web probe 2026-09-21** through the Code UI, not through a mutation script:

- No repositories and **zero connectors**, removed explicitly before saving.
- One-off timestamp tomorrow, then paused immediately after creation and before firing.
- Push, email, and Slack notifications all off; auto-fix off.
- No API trigger/token, GitHub subscription, package installation, or repository action.
- Prompt: create a standard-library Python `sum_even` function and exactly three unit tests inside `/tmp/chattering-code-routine-web-probe`, then run them.

Clicked **Run now** exactly once while paused. The raw transcript proves two shell calls (create directory, run Python) and one Write call. The three tests covered an empty list, mixed odd/even numbers, and negative numbers/zero. Python's output named all three tests, reported each as `ok`, and ended in `OK`. The final answer correctly said all three passed. One successful run was recorded; the routine remained disabled.

The Code session showed the commands, a created-file summary (`+20 -0`), the final answer, and run history. Opening the separate changes pane for this repository-free `/tmp` file produced **“No changes to show”**; do not claim a reviewed repository diff or PR from this diagnostic. The written source itself is available in the raw Write event.

### Exported shape and earlier-claim correction

The same read-only account API returned this Code routine and its 25 raw execution events. Task text matched exactly. Saved fields included:

- `created_via: http_api`, with `created_kind` and `created_surface` unspecified.
- `job_config.ccr.session_context.allowed_tools` and `autofix_on_pr_create:false`.
- Environment reference, schedule, empty connectors, disabled state, notification channels, and `persist_session:false`.
- **No `custom_system_prompt` field in the saved Code session context**, unlike the general scheduled-task experiment.

The model selector initially displayed Opus 5, but this draft did not save an explicit model override; the detail page said Default model. The actual run's init and the fully loaded session UI identified **Sonnet 5**. Treat configured/default/effective model as separate facts; do not infer a historical run's model from a placeholder label in the creation form.

The earlier broad statement about recovering a 67,000-character extra instruction block must therefore stay scoped to the general scheduled task. For these Code routines we recovered the explicit task, configuration, runtime events, and the separately recorded routine wrapper—not a demonstrated complete base system prompt.

### Implication for Chattering

The likely development use case is **delegating a recurring or event-driven development responsibility**: detect work, prepare a workspace, inspect/edit/test code, produce a reviewable result, and possibly follow the PR through CI and review. The candidate user's particular dependency on these pieces has not been established.

A convincing Code-routine equivalent needs more than a prompt timer or transcript importer:

1. Persistent editable task definitions and multiple independent triggers.
2. Prepared, isolated repository workspaces with deliberate credentials and network permissions.
3. Unattended execution with bounded authority and restart-safe run management.
4. Readable run history, tool evidence, changes, and a place to take over manually.
5. GitHub/webhook integration if users rely on event-driven work.
6. Separate per-PR follow-up state and event handling if users rely on auto-fix.
7. Actionable notifications and explicit account/project ownership.

Importing history is still useful, but it is not feature parity with the work execution and follow-up they may depend on. Prioritize parity around the user's actual workflow rather than promising that sharing a backend record makes migration complete.

Private records, UI screenshots, task text, official-doc snapshots, exporter, and checked results are under:

```
~/.local/share/chattering/research/claude-routines/2026-09-21-code-web/
```

Start with `verification.json`, `routine-raw.json`, and `06-completed-run.png`. No production application code was changed or restarted during this investigation.

## Still untested

- Browser presentation of imported runs and end-to-end live synchronization.
- Long/multipage run history, reconnects, concurrent or repeated fires, and webhook triggers.
- Repository checkout/branch settings, setup scripts, secrets, connector permissions, or organization policies.
- Artifact download from supported output directories.
- Native remote transcript export/teleport and full branch/subagent fidelity.
- Subscription token refresh/expiry and provider API evolution.
- Pi execution and scheduling of the migrated task.

The cloud test routine remains disabled and available for inspection. No production importer or scheduler was installed, no service was restarted, and no unrelated working-tree edits were changed.
