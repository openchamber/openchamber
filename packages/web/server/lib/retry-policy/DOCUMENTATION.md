# Retry policy

## Ownership

How long OpenCode may wait between provider retry attempts, and whether the
user can end that wait, for a managed OpenCode. Two settings drive it:

- `retryWaitMaxMs`: the longest wait in milliseconds; `0` keeps OpenCode's own
  schedule. Settings → Sessions → Provider retries offers 15 seconds, 30
  seconds, 1 minute and 5 minutes.
- `retryNowEnabled`: show a **Retry now** action on a waiting retry and hold
  the wait so the action can end it. Off by default.

The module owns the managed OpenCode plugin (`runtime.js`, `PLUGIN_SOURCE`) and
the callback route it uses. The managed config layer
(`../opencode/managed-config-file.js`) lists the plugin; the plugin reaches the
server through the agent tool's callback address and token
(`../agent-tool/DOCUMENTATION.md`, *Runtime flow*), and the route checks the
same token.

## Flow

1. OpenCode calls the plugin's `session.retry` hook after a failed attempt that
   it intends to retry.
2. The plugin posts the proposed delay, session, attempt and message to
   `POST /api/openchamber/retry-policy`.
3. The route reads `retryWaitMaxMs` and answers `Math.min(proposed, cap)`, plus
   whether to hold.
4. A held wait is announced on the OpenChamber event stream as a synthetic
   `openchamber:session-status` retry. The plugin then holds the hook for the
   remaining delay instead of returning it. OpenCode therefore does not publish
   its own retry or sleep yet.
5. The plugin registers `openchamber-retry-now`. Calling it — from the retry
   chip or a subagent row in Work status — wakes the held hook, which returns
   `{ retry: true, delay: 0 }`. OpenCode repeats the same step immediately.
6. If nobody calls it, the hold ends at the proposed delay and the plugin
   returns `delay: 0`; the retry happens at the time OpenCode intended.

The hook runs before OpenCode publishes `session.retry.scheduled` and sleeps,
so the shortened or held wait is the one the retry status and countdown show.

## Invariants

- Nothing changes unless the user sets a cap or turns on retry-now. With both
  off the plugin is not materialized and OpenCode's own schedule runs.
- The cap only shortens; a malformed, stale or larger answer leaves the
  proposed delay in place.
- A failed callback leaves OpenCode's delay in place. The plugin never blocks a
  retry on the server.
- The cap is bounded at 15 minutes on the server even if the stored value is
  larger.
- OpenCode's attempt budget is unchanged: after its last attempt the turn
  still fails. The cap and the hold change the wait, not the number of attempts.
- Retry-now never aborts the turn and never sends a user message. A subagent's
  parent `task` call stays running while its child waits and retries.
- Works only with an OpenCode OpenChamber starts. An external OpenCode
  (`OPENCODE_HOST`, skip-start) and VS Code never load the plugin, and VS Code
  hides the settings.

## Decisions

### Why the plugin asks the server instead of baking the settings in

Both settings can change while OpenCode runs. The plugin source is written
once; reading them from the server on each retry applies a new value without
rewriting the plugin directory or restarting OpenCode.

### Why the plugin loads only while a policy is set

With both off every retry would cost a round trip to hear "use OpenCode's own
delay". The managed config lists the plugin only while
`isRetryPolicyConfigured` holds, and both keys are in
`MANAGED_PLUGIN_SETTINGS_KEYS` (`../opencode/settings-runtime.js`), so changing
them rewrites the watched config and OpenCode loads or drops the plugin without
a restart. Installs where the user's own environment sets `OPENCODE_CONFIG`
need a restart, like the other managed plugins.

### Why retry-now holds the hook instead of aborting

OpenCode exposes no way to wake a retry sleep that already started. Aborting
the session is the only cancellation, and for a subagent that cancels the
parent's `task` call — the failure the control exists to avoid. Holding the
hook keeps the same processor step and lets a command finish the wait early.
The cost is that other clients (the TUI) see `busy` rather than `retrying`
during a held wait, which is why the control is opt-in.
