# Retry policy

## Ownership

How long OpenCode may wait between provider retry attempts, for a managed
OpenCode. One setting drives it:

- `retryWaitMaxMs`: the longest wait in milliseconds; `0` keeps OpenCode's own
  schedule. Settings → Sessions → Provider retries offers 15 seconds, 30
  seconds, 1 minute and 5 minutes.

The module owns the managed OpenCode plugin (`runtime.js`, `PLUGIN_SOURCE`) and
the callback route it uses. The managed config layer
(`../opencode/managed-config-file.js`) lists the plugin; the plugin reaches the
server through the agent tool's callback address and token
(`../agent-tool/DOCUMENTATION.md`, *Runtime flow*), and the route checks the
same token.

## Flow

1. OpenCode calls the plugin's `session.retry` hook after a failed attempt that
   it intends to retry.
2. The plugin posts the proposed delay to
   `POST /api/openchamber/retry-policy`.
3. The route reads `retryWaitMaxMs` and answers `Math.min(proposed, cap)`.
4. The plugin replaces `event.decision.delay` with the answer. OpenCode repeats
   the same step after that wait.

The hook runs before OpenCode publishes `session.retry.scheduled` and sleeps,
so the shortened delay is the one the retry status and the countdown show.

## Invariants

- Nothing changes unless the user sets a cap. With no cap the plugin is not
  materialized and OpenCode's own schedule runs.
- The cap only shortens; a malformed, stale or larger answer leaves the
  proposed delay in place.
- A failed callback leaves OpenCode's delay in place. The plugin never blocks a
  retry on the server.
- The cap is bounded at 15 minutes on the server even if the stored value is
  larger.
- OpenCode's attempt budget is unchanged: after its last attempt the turn
  still fails. The cap changes the wait, not the number of attempts.
- Works only with an OpenCode OpenChamber starts. An external OpenCode
  (`OPENCODE_HOST`, skip-start) and VS Code never load the plugin, and VS Code
  hides the setting.

## Decisions

### Why the plugin asks the server instead of baking the cap in

The cap is a setting the user can change while OpenCode runs. The plugin source
is written once; reading the cap from the server on each retry applies a new
value without rewriting the plugin directory or restarting OpenCode.

### Why the plugin loads only while a cap is set

With no cap every retry would cost a round trip to hear "use OpenCode's own
delay". The managed config lists the plugin only while
`isRetryPolicyConfigured` holds, and `retryWaitMaxMs` is in
`MANAGED_PLUGIN_SETTINGS_KEYS` (`../opencode/settings-runtime.js`), so setting
or clearing it rewrites the watched config and OpenCode loads or drops the
plugin without a restart. Installs where the user's own environment sets
`OPENCODE_CONFIG` need a restart, like the other managed plugins.

### Why cap instead of skipping the wait

Skipping a wait needs a wake-up path that OpenCode does not expose. The plugin
can shorten the delay it is asked for, but it cannot interrupt a sleep that
already started. A cap is the smallest change that removes the 15-minute tail
without aborting the turn, which would cancel the parent task a subagent is
running under.
