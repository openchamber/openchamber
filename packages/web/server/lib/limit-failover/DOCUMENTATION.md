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
2. The plugin's `http.response` hook reads Anthropic's
   `anthropic-ratelimit-unified-*` headers off every 429 and keeps them per
   session. The `retry` report carries them as `captured`, because the error
   body the hook sees has already been rewritten by another plugin and often
   has no `retry-after`.
3. For `provider.quota`, `provider.free-limit` (OpenCode's own free tier, a
   separate type since OpenCode 2.1.2), `provider.budget-limit` and
   `provider.model-budget-limit` (an OpenCode Console spend limit of the
   workspace or of one model, separate types since 2.2), `provider.go-limit`
   and `provider.chatgpt-limit` (OpenCode Go and ChatGPT subscription sharing,
   since 2.2.5) and `provider.rate-limit` the plugin
   posts the error with OpenCode's `retryAfterMs`, the captured headers,
   OpenCode's proposed decision, the provider's stored accounts and the active
   one to `POST /api/openchamber/limit-failover`.
4. `decide` answers `activate-credential`, `switch-model`, `retry`, `fail` or
   `none`. A switch carries a ticket. `fail` is a session pinned to one account
   that asked not to be moved: the turn ends on the error instead of retrying.
5. The plugin calls `credential.activate` or `session.switchModel` and sets the
   decision to retry now. OpenCode repeats the same step, and every attempt
   resolves the active credential and the session's model again
   (`core/src/model-resolver.ts`, `session/runner/llm.ts` in OpenCode), so the
   next attempt runs on the new account or model and no tool call repeats.
   On `wait` the plugin retries after the named reset. On `none` or `fail`,
   or any failure on the way, OpenCode's own decision stands.
6. The plugin reports the ticket's outcome to `POST .../limit-failover/settle`.
   An applied switch is broadcast as `openchamber:limit-failover`; a failed one
   is forgotten, so its account does not count as just switched to.

A session can pin an account (`session-accounts.js`, read and set through the
UI routes). The plugin's `prompt` hook asks which account the turn should
start on and activates it. OpenCode keeps one active credential per provider,
so two sessions pinned to different accounts take turns with it.

The plugin also sweeps each stored Claude account's plan usage and posts it to
`POST .../limit-failover/usage`. `decide` uses it to prefer the account with
the most room in the failing model's window, and the UI shows it.

Verified end to end on OpenCode 2.0.32 with a fake provider: an exhausted
account switched to the next one and the turn finished there; with only a
fallback set the session moved to it; with every account out it switched
accounts first, then moved to the fallback.

## Invariants

- An account switches only when the user opted that provider in, and a
  session moves to the fallback model only when one is set. A limit that
  names when it lifts waits for that time and retries, even with both off,
  up to a day. A further reset stops, as OpenCode would.
- A rate limit counts only when the wait is at least `LONG_WAIT_MS`, from
  OpenCode's proposed delay, the error's `retryAfterMs` or the reset hint in
  the body. Short throttles stay
  OpenCode's backoff.
- An account that hit its limit is skipped until the error's `retryAfterMs`
  runs out, else until the reset the body or the captured headers name, else
  for the wait OpenCode proposed, else for `DEFAULT_EXHAUSTION_MS`. A window
  scoped to one model family marks only that family on the account, so an
  account out of Fable still serves Opus and Sonnet. The marks live in memory,
  so a server restart forgets them and the next failure marks the account again.
- Clients hear about a switch only after the plugin made it.
- With no stored account active (an environment key serves the provider),
  every stored account is a candidate.
- The fallback model is never chosen for a session already on it, so a limit
  on the fallback ends in OpenCode's own error and not in a loop.
- Decisions run one at a time.
- A session pinned to an account starts each turn on it. Pinned `fixed`, a
  limit on that account ends the turn instead of moving it; pinned
  `preferred`, it moves like the global setting and returns to the pin once
  the mark lifts. A pin for another provider does not apply.
- Works only with an OpenCode OpenChamber starts: an external OpenCode
  (`OPENCODE_HOST`, skip-start) and VS Code never load the plugin, the
  Settings hints say so, and VS Code hides both controls.

## Decisions

### Why the plugin asks the server, and not the settings baked into the plugin

The settings could be written into the generated plugin the way the agent
tools are. The account choice also needs state only the server keeps (which
accounts ran out and when they reset), so the decision lives there and the
plugin stays a reporter that executes the answer.

### Why the plugin loads even when both options are off

A limit that names when it lifts, such as Z.ai's "will reset at" in a quota
error, waits for that time and retries. OpenCode treats the quota error as
final, so the wait only happens if the plugin is loaded. The round trip on a
limit error is the cost of not stopping the turn. Both settings stay in
`MANAGED_PLUGIN_SETTINGS_KEYS` (`../opencode/settings-runtime.js`), so turning
one on still rewrites the watched config. Installs where the user's own
environment sets `OPENCODE_CONFIG` need a restart, like the agent tools.

### Why a switch is global, and not per session

An account's limit belongs to the account. OpenCode keeps one active
credential per integration, and leaving any session on the exhausted account
would only fail it again. A session can still pin an account, but the pin is
applied by activating that credential when the session's turn starts, not by
overriding the request: the plugin that signs Anthropic requests overwrites
the `Authorization` header with the active credential, so a per-request
override never reaches Anthropic.

### Why the reset comes from the captured headers, and not the error body

Anthropic names the window that rejected a request in
`anthropic-ratelimit-unified-status`, `-reset` and `-representative-claim`.
The error body is rewritten before OpenCode records it, and the `retry-after`
header is dropped when the reset is far off, which is exactly the weekly
per-model window. The headers survive that rewrite, so the plugin reads them
on the 429 and attaches them to the report. A model-family claim marks only
that family on the account; marking the whole account would take it out of
rotation for models whose limit it still has.

### Why a report on an account switched to a minute ago gets one plain retry

The plugin reads the active account when the hook runs, not the account the
failed request used. Sessions on one account fail together: after the first
report switches A to B, a second session's request that went out with A reports
B as active. Marking B as exhausted then would be wrong, so within
`SWITCH_GRACE_MS` of a switch each session gets one retry on the new account
without a mark. A second failure from that session on that account is real.
