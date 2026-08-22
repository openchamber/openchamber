# Session Assist

Server-side watcher that generates a short recap of the agent's last reply
and one suggested user follow-up with the small model
(`lib/small-model`), storing both on the session's metadata under
`metadata.openchamber.assist`.

## Flow

1. `createSessionAssistRuntime` is a consumer of the server's global SSE
   fan-out (`index.js` → `onPayload`), riding the same upstream connection as
   notifications. Purely event-driven — dormant sessions never generate
   anything, there is no backfill and no session scanning.
2. `session.status: idle` arms a 60-second per-session timer; any `busy`/
   `retry` status or a user `message.updated` clears it (the "1 minute of
   quiet" rule).
3. On fire: fetch the session (skip sub-agent sessions with `parentID`).
   A broken last assistant turn (empty or unfinished, see below) takes the
   recovery path instead of a recap. Otherwise take the LAST exchange only —
   the final assistant reply plus the user message it answered (assistant
   `parentID` → user id) — and call
   `generateSmallModelText` with the
   session's own provider/model taken from the last assistant message — so
   the utility call spends the same subscription as the conversation.
   `restrictToPreferredProvider` forbids the resolver's global fallback:
   conversation content never goes to a provider the user didn't pick for
   the session, unless the small model was chosen explicitly (settings
   override or opencode config). A resolver 404 is silently skipped.
4. The requested JSON fields (`recap`, `suggestion`, or both) are clamped and
   PATCHed onto the session metadata together with `forMessageID` (the last
   assistant message id) and `generatedAt`. Before writing, the session tail is
   re-checked (a stale result is dropped) and the metadata is merged from a
   fresh session read so concurrent metadata writes made during generation are
   preserved.

## Settings gate

`sessionRecapEnabled` and `sessionSuggestionEnabled` in OpenChamber settings
(Settings → Chat, default on) are hard generation switches checked at fire
time. When both are off, no small-model calls run and nothing is written. When
one is on, the runtime still makes at most one small-model call and asks only
for that field. The UI also hides disabled payload types immediately.

`sessionAutoRetryEnabled` (default on) is a behavior switch for the
failed-turn recovery below: when off, a broken turn skips retries and
immediately gets the honest recap.

## Empty-completion recovery

When the last assistant turn is BROKEN — it completed with zero output (no
text, no tool calls, no reasoning parts; step-start/step-finish markers do
not count) OR it never completed at all (`time.completed` missing, meaning the
OpenCode serve process died mid-stream and left an unfinished turn; an idle
session cannot legitimately have one) — a normal recap would be meaningless.
A `MessageAbortedError` turn and compaction summaries are excluded. The
runtime instead:

1. Up to `FAILED_TURN_RETRY_MAX` (2) times, re-prompts the session via
   `POST /session/:id/prompt_async` with a short continuation prompt, waiting
   `RETRY_QUIET_MS` (60s) first so provider usage windows ("resets in 2min")
   can recover. Attempts are tracked in
   `metadata.openchamber.assistRetry = { count, lastMessageID, lastAttemptAt }`,
   scoped to the failed message id — any new last assistant turn resets the
   counter, so retries never accumulate across unrelated turns. The retry is
   dropped if the session tail moves during the wait (the user sent a
   message) or if the session is busy again (a race with a live turn must
   never get a duplicate prompt). The provider/model/agent for the retry come
   from the failed turn itself; when they are absent, the recovery goes
   straight to the honest recap.
2. Once retries are exhausted (or disabled), writes an honest assist payload
   whose recap states plainly that the agent's reply came back empty (likely a
   provider limit) and that the user can send "Continue" or switch models.
   The recap/suggestion are generated with the small model in the
   conversation's language, falling back to a fixed English text when the
   small model is unavailable — the failure is never silent.

The retry counter is written BEFORE the prompt (write-first), so a failed
prompt cannot loop forever: the next idle tick sees the recorded count and
escalates.

## Startup recovery scan

OpenCode re-emits no status for sessions whose turn was interrupted by the
previous serve process dying — without extra help they would stay silently
stranded on an unfinished turn forever. `runStartupRecovery` compensates:
it scans the warm directories (the same most-recently-used list the lifecycle
warms, injected as `getStartupDirectories`) and for each idle session updated
within `STARTUP_SESSION_AGE_LIMIT_MS` checks the tail; sessions whose last
assistant turn is broken get the same failed-turn recovery.

Triggers (all debounced to at most one scan per
`STARTUP_RECOVERY_MIN_INTERVAL_MS`):
- the startup timer (`STARTUP_RECOVERY_DELAY_MS` after the runtime is
  created, as a fallback);
- the lifecycle `onOpenCodeReady` hook, which fires after EVERY OpenCode
  serve (re)start — including health-check recovery restarts. So a serve
  crash that does not restart OpenChamber itself is recovered too.

Best-effort: fetch failures are logged, never block startup, and the pass
retries a bounded number of times while upstream is not ready.

## Freshness contract (no clearing writes)

Clients do not need the payload to be deleted: they render it only while
`assist.forMessageID` still equals the session's last assistant message id
(and the session is idle). Any new message invalidates the payload
everywhere instantly and offline; the next idle cycle overwrites it.

## UI consumers (packages/ui)

- `lib/sessionAssistMetadata.ts` — payload parsing.
- `hooks/useSessionAssist.ts` — freshness gating + the 1-minute quiet window
  for the recap (single timeout to the boundary, no polling).
- `components/chat/SessionRecapSpacer.tsx` — renders the recap inside the
  fixed-height reserved gap under the last message (height never changes).
- `components/chat/SessionSuggestionChip.tsx` — one tappable suggestion chip
  near the composer (desktop chips row + above the mobile pill); hidden as
  soon as the composer has any content. Tap fills the input, never sends.

## Limitations

- The watcher lives in the web server, so VS Code (extension-only, no web
  server) does not generate assists and does not run the startup recovery
  scan; it still renders payloads produced by a web/desktop instance of the
  same OpenCode server via `session.updated`.
- The startup recovery scan only covers the warm (most-recently-used)
  directories and sessions updated within the last 30 minutes. A serve crash
  in a cold directory, or one followed by no restart of the OpenChamber
  server, is not recovered until the next server start.
- Metadata payloads ride every `session.updated` event — keep the clamps
  (`RECAP_CHAR_LIMIT`, `SUGGESTION_CHAR_LIMIT`) small.
