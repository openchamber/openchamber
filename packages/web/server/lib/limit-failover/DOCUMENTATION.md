# Limit failover

## Ownership

What happens when a provider's usage limit stops a session: switching the
provider to its next stored account, and moving the session to the fallback
model. Two settings drive it, both off by default:

- `accountSwitchProviders`: provider ids the user opted in on the provider's
  page in Settings → Providers (`ProviderAccountSwitchToggle.tsx`).
- `fallbackModel`: `provider/model`, Settings → Sessions → Session defaults,
  with its thinking level in `fallbackVariant` (the select beside the picker,
  shown when the model has levels; cleared when the model changes).

The module owns the managed OpenCode plugin that reports limit failures
(`runtime.js`, `PLUGIN_SOURCE`), the decision (`decide`), and the
`openchamber:limit-failover` event the clients turn into a toast
(`packages/ui/src/hooks/useLimitFailoverNotices.ts`). The managed config layer
(`../opencode/managed-config-file.js`) lists the plugin; the plugin reaches the
server through the agent tool's callback address and token
(`../agent-tool/DOCUMENTATION.md`, *Runtime flow*), and the route checks the
same token.

## Flow

1. OpenCode calls the plugin's `session.retry` hook on every failed attempt,
   including failures it would not retry (`provider.quota`).
2. For `provider.quota`, `provider.free-limit` (OpenCode's own free tier, a
   separate type since OpenCode 2.1.2), `provider.budget-limit` and
   `provider.model-budget-limit` (an OpenCode Console spend limit of the
   workspace or of one model, separate types since 2.2) and
   `provider.rate-limit` the plugin
   posts the error with OpenCode's `retryAfterMs`,
   OpenCode's proposed decision, the provider's stored accounts and the active
   one to `POST /api/openchamber/limit-failover`.
3. `decide` answers `activate-credential`, `switch-model`, `retry` or `none`.
   A switch carries a ticket.
4. The plugin calls `credential.activate` or `session.switchModel` and sets the
   decision to retry now. OpenCode repeats the same step, and every attempt
   resolves the active credential and the session's model again
   (`core/src/model-resolver.ts`, `session/runner/llm.ts` in OpenCode), so the
   next attempt runs on the new account or model and no tool call repeats.
   On `none`, or any failure on the way, OpenCode's own decision stands.
5. The plugin reports the ticket's outcome to `POST .../limit-failover/settle`.
   An applied switch is broadcast as `openchamber:limit-failover`; a failed one
   is forgotten, so its account does not count as just switched to.

Verified end to end on OpenCode 2.0.32 with a fake provider: an exhausted
account switched to the next one and the turn finished there; with only a
fallback set the session moved to it; with every account out it switched
accounts first, then moved to the fallback.

## Invariants

- Nothing changes unless the user opted in: a provider not in
  `accountSwitchProviders` keeps its account, and an empty `fallbackModel`
  never moves a session.
- A rate limit counts only when the wait is at least `LONG_WAIT_MS`, from
  OpenCode's proposed delay, the error's `retryAfterMs` or the reset hint in
  the body. Short throttles stay
  OpenCode's backoff.
- An account that hit its limit is skipped until the error's `retryAfterMs`
  runs out, else until the reset the body names, else for the wait OpenCode
  proposed, else for
  `DEFAULT_EXHAUSTION_MS`. The marks live in memory, so a server restart
  forgets them and the next failure marks the account again.
- Clients hear about a switch only after the plugin made it.
- With no stored account active (an environment key serves the provider),
  every stored account is a candidate.
- The fallback model is never chosen for a session already on it, so a limit
  on the fallback ends in OpenCode's own error and not in a loop.
- Decisions run one at a time.
- Works only with an OpenCode OpenChamber starts: an external OpenCode
  (`OPENCODE_HOST`, skip-start) and VS Code never load the plugin, the
  Settings hints say so, and VS Code hides both controls.

## Decisions

### Why the plugin asks the server, and not the settings baked into the plugin

The settings could be written into the generated plugin the way the agent
tools are. The account choice also needs state only the server keeps (which
accounts ran out and when they reset), so the decision lives there and the
plugin stays a reporter that executes the answer.

### Why the plugin loads only while an option is on

With both options off every limit error would cost the plugin three OpenCode
reads and a round trip to the server, only to hear `none`. The managed config
lists the plugin only while `isLimitFailoverConfigured` holds, and both
settings are in `MANAGED_PLUGIN_SETTINGS_KEYS` (`../opencode/settings-runtime.js`),
so turning one on rewrites the watched config and OpenCode loads the plugin
without a restart (checked live on 2.0.32). Installs where the user's own
environment sets `OPENCODE_CONFIG` need a restart, like the agent tools.

### Why a switch is global, and not per session

An account's limit belongs to the account. OpenCode keeps one active
credential per integration, and leaving any session on the exhausted account
would only fail it again.

### Why a report on an account switched to a minute ago gets one plain retry

The plugin reads the active account when the hook runs, not the account the
failed request used. Sessions on one account fail together: after the first
report switches A to B, a second session's request that went out with A reports
B as active. Marking B as exhausted then would be wrong, so within
`SWITCH_GRACE_MS` of a switch each session gets one retry on the new account
without a mark. A second failure from that session on that account is real.
