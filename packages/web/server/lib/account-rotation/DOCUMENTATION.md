# Provider account rotation

## Ownership

This module owns opt-in provider settings, exhausted-account cooldowns, and
serialized activation of saved accounts. OpenCode owns credentials, the active
account, execution cancellation, and retrying the failed model request. The goal
loop has no account-switching path.

`GET/PUT /api/provider/:providerID/account-rotation` exposes `{ enabled }` through
the server's UI authentication. The provider registry currently supports OpenAI.
A new provider needs its own usage-limit classifier before it can opt in. The
account adapter reads integration metadata only; credentials stay in OpenCode.

## Invariants

- Rotation starts off independently for each provider. Enabling requires at least
  2 usable saved OAuth sign-ins. All usable sign-ins participate in catalog order;
  API keys and accounts requiring reauthentication are excluded. Disabling works
  even when the catalog is unavailable.
- Activation affects every session using that provider on the OpenCode server.
  The setting and takeover notice describe that shared account change.
- The managed plugin observes primary model-request boundaries and uses OpenCode's
  `session.retry` hook for chat, goal, and subagent requests. Auxiliary title,
  compaction, and transient generation requests do not participate. The plugin is
  independent of the agent-tool toggles, and reads the current server setting on
  each callback.
- OpenCode numbers the first retry decision as attempt 2. Only that decision can
  rotate and request one immediate retry. A subsequent quota failure records the
  new account's cooldown and declines further retries. An exhausted pool also
  declines, preserving the provider error. There is no prompt replay, timer, or
  automatic resumption when a cooldown expires.
- Generic 429s, authentication errors, and unsupported providers retain OpenCode's
  retry policy. Only a confirmed OpenAI usage-limit message or structured
  `usage_limit_reached` code permits rotation.
- Settings and recovery share one process-local sequence. A request started
  before a recorded switch can reuse that account without charging its cooldown.
  Errors have no credential ID; manual switches and other OpenChamber processes
  are outside this sequence.
- `<dataDir>/account-rotation.json` stores provider-keyed configuration and
  cooldowns atomically. Missing data means disabled. Malformed data is preserved
  and reported as a failure. Exhausted accounts wait until the reported reset,
  or 1 hour when no future reset is known.
- Exhaustion is saved before activation. Failed activation preserves that
  cooldown. If activation succeeds but recording the switch fails, the active
  account may already have changed, but recovery reports failure. No account is
  automatically restored during recovery.
- The plugin callback reuses the same-machine, per-child agent-tool authorization
  before UI auth middleware. It adds no listener or external destination. The
  account label travels only over the existing authenticated control stream;
  the UI localizes the short takeover toast. Provider errors and account IDs
  are never logged.
- Successful, failed, interrupted, and deleted executions clear request
  attribution. Plugin disposal aborts the event stream and outstanding callbacks.
  OpenCode owns interrupting the retry; OpenChamber never sends another prompt
  after Stop.

## Decisions

### Why recovery uses the native retry hook

OpenCode's runner refreshes session context for each retry, including provider
credentials. Its execution owns cancellation and the current model and agent.
Goal-only continuations excluded chats and subagents and sent a new prompt after
the original execution had already failed.

### Why managed OpenCode is required

OpenChamber can install the recovery plugin only in the OpenCode process it
launches. External OpenCode and extension-only VS Code return 501 and hide the
setting. Web, Electron, hosted mobile, and Capacitor share the managed server's
settings and recovery, including while clients are disconnected.

### Why existing accounts remain available in enterprise mode

Switching existing accounts adds no provider, credential, or endpoint. OpenCode's
provider policy continues to apply.

The setting lives inside provider details and is not separately indexed by
Settings search, which cannot open a selected provider.

## Validation

Focused tests exercise provider-scoped settings, cooldown persistence, concurrent
failures, activation and write failures, callback authorization, single-retry
decisions, and terminal goal errors. UI tests cover the opt-in toggle, failed
saves, stale directory responses, unsupported runtimes, and save completion after
navigation or unmount.

`plugin.live.test.js` is opt-in through `OPENCHAMBER_ROTATION_TEST_BINARY`. On
OpenCode 2.0.32 and 2.1.4 it verifies a successful native retry with a changed credential
header, bounded exhaustion, and Stop during pending activation. It isolates all
configuration and data and uses a local fake provider with synthetic key
credentials. Its OAuth connection metadata is an adapter test seam; it does not
validate real ChatGPT OAuth sign-ins. Packaged app and mobile interaction remain
untested. The source settings component was exercised with fake settings responses
in desktop dark English and 390px light Arabic RTL previews, including enabling
and saving the toggle.
