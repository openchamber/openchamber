# Goal account rotation

## Ownership

This module owns opt-in OpenAI account rotation settings, exhausted-account
cooldowns, and serialized activation of saved sign-ins. OpenCode owns credentials
and the active account. The session-goal runtime owns continuation, Stop, budgets,
and the per-reply recovery claim.

`GET/PUT /api/provider/account-rotation` exposes only `{ enabled, accountIds }`.
The route uses the server's existing UI authentication. Selection order is the
rotation order. Saving an enabled pool validates at least 2 distinct, available
OAuth connections against the directory's integration catalog. Disabling remains
possible when OpenCode is offline or selected accounts were removed.

## Invariants

- Rotation starts disabled. It changes the active OpenAI account for every
  session on the same OpenCode server. Only selected, saved OAuth accounts
  participate; API keys and connections requiring authentication are excluded.
- Catalog reads use the goal or Settings directory. Activation is global.
  The adapter resolves the upstream URL and authentication at call time and
  reads connection metadata only. Tokens remain in OpenCode.
- Only an OpenAI usage-limit message or structured `usage_limit_reached` code
  permits rotation. Generic 429s, authentication errors, and other providers
  retain their existing error handling.
- Settings and recovery operations share one process-local sequence. A failure
  from a reply started before a recorded switch reuses the current account,
  preventing simultaneous goals from exhausting successive accounts with the
  same old failure. OpenCode's error contains no credential ID; manual switches
  and multiple OpenChamber processes do not participate in this sequence.
- `<dataDir>/account-rotation.json` stores configuration and cooldowns atomically.
  Missing data means disabled; malformed or unreadable data is an error and is
  preserved. Cooldowns survive restart. An exhausted account waits until its
  reported reset, or 1 hour when no future reset is known.
- Exhaustion is persisted before activation. A failed activation reports failure
  and preserves that cooldown. If activation succeeds but recording the switch
  fails, the goal blocks and the active account may already have changed. The
  previous account is never automatically restored during ordinary recovery.
- Exhausting the selected pool blocks the goal. There is no waiting timer or
  automatic resumption when a cooldown expires. Explicit Resume can try again.

## Decisions

### Why terminal goal recovery instead of an in-flight plugin retry

The goal loop can continue the same session after a terminal error while retaining
its budget and turn limits. OpenCode's plugin retry contract does not establish
whether the next attempt rebuilds its credential. Ordinary chats remain unchanged.

### Why existing accounts remain available in enterprise mode

The enterprise boundary allows switching existing accounts. Rotation adds no
provider, credential, or endpoint, and OpenCode's provider policy still applies.

## Runtime coverage

| Runtime | Behavior |
| --- | --- |
| Web | Providers configuration and server-side goal recovery |
| Electron | Same web backend, including while the UI is closed |
| Hosted mobile | Same server configuration and recovery |
| Capacitor mobile | Configuration and recovery on the connected server |
| VS Code extension-only | Explicit 501; the setting is hidden because no goal loop runs |

The setting is inside the selected OpenAI provider's details. Settings search
does not index it because selecting a search result does not open that provider.

## Validation

Focused tests cover selection, persistence, cooldowns, concurrent failures, failed
activation, offline disabling, and route behavior with enterprise mode on and off.
Goal-runtime tests cover continuation claims, hard stops, and pausing during IO.
UI tests cover selection order, minimum pool size, failed reads and saves, stale
responses, and the unsupported runtime.

A live probe against OpenCode 2.0.25 used a real `provider.quota` failure on a
saved OpenAI sign-in. The source goal runtime rotated to a working sign-in and
sent one continuation in the same session on `gpt-6.1-sol`, which succeeded.
The probe used temporary rotation storage and an in-memory goal metadata seam;
it did not enable rotation in the installed app. The original account was restored
and the probe sessions removed. The component was also checked in a browser
preview with 4 placeholder accounts, using desktop dark English and 390px light
Arabic layouts, including selection and save. Packaged/mobile behavior remains
untested.
