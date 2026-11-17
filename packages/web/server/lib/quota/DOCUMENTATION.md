# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

Node server entrypoints apply `../network-defaults.js` before serving requests,
including the daemon launched directly through `server/index.js`. Connection
attempts get 5 seconds without changing address-family selection. The VS Code
extension applies the same policy in its own process at activation.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- The CLI (`packages/web/bin/lib/commands-quota.js`) imports the same entrypoint for `openchamber quota`. No server is running in that process, so the command wires the credential source itself: the direct local credential-store read (`openCodeLocalCredentialSource`), the single source the aggregator gatherer also uses (code#2490, #2282) — there is no server round-trip and no server-first/store-fallback split, so the CLI cannot diverge from the gatherer about which credentials exist. Every result is stamped `credentialSource: 'local'`; its fetches run with bounded concurrency under a per-provider timeout, and each result carries `elapsedMs` (a timed-out provider answers a `status: 'timeout'` row). Those fields are attached by the CLI, not by the providers. The server endpoint resolves its providers from this same module directly (`routes.js` imports `./index.js`); the `getQuotaProviders` registration option remains only as a test pass-through.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/antigravity/`: Antigravity-specific auth, API, and transform modules.
- `packages/web/server/lib/quota/providers/google/`: Google-specific auth, API, and transform modules.
- `packages/web/server/lib/quota/providers/claude/`: Claude credential discovery, usage transforms, and rate-limit handling.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.

## Supported provider IDs (dispatcher)

These provider IDs are currently dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`.

Where this table says "OpenCode `auth.json`", the credential is the one the
running OpenCode uses (stored, or from an environment variable when
OpenChamber launched OpenCode), read through `../opencode/auth.js` (`GET
/api/credential`, see the opencode module docs); the name is the legacy shape
the entries keep. The provider list reads it once and hands it to every
`isConfigured(auth)`; each `fetchQuota` reads it again. When OpenCode cannot be
asked, `/api/quota/providers` answers 500 instead of an empty list.

| Provider ID | Display name | Module | Auth aliases/keys |
| --- | --- | --- | --- |
| `antigravity` | Antigravity | `providers/antigravity/index.js` | Antigravity accounts file (`~/.config/opencode/antigravity-accounts.json` or the `$OPENCODE_CONFIG_DIR` equivalent), or the active `google` OAuth login in OpenCode's credential store |
| `claude` | Claude | `providers/claude/` | Claude Code Keychain entry, Claude Code credentials file, OpenCode `auth.json` (`anthropic`, `claude`), `CLAUDE_CODE_OAUTH_TOKEN` |
| `cline-pass` | ClinePass | `providers/cline-pass.js` | `cline-pass` (API key under `key` or `token`) |
| `codex` | Codex | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `command-code` | Command Code | `providers/command-code.js` | `command-code` OAuth/API credential in OpenCode `auth.json`, or `COMMAND_CODE_API_KEY` |
| `cursor` | Cursor | `providers/cursor.js` | Environment/token files, OpenChamber-managed credentials, or explicit one-time Cursor import |
| `deepinfra` | DeepInfra | `providers/deepinfra.js` | `deepinfra`, `deep-infra`, `deep_infra` (API key under `key` or `token`) |
| `deepseek` | DeepSeek | `providers/deepseek.js` | `deepseek` (API key under `key` or `token`) |
| `exe-dev` | exe.dev | `providers/exe-dev.js` | Usage API token stored under `~/.config/openchamber/quota/` |
| `google` | Google | `providers/google/index.js` | `google`, `google.oauth` |
| `hyper` | Charm Hyper | `providers/hyper.js` | `hyper` (API key under `key` or `token`) |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | `github-copilot`, `copilot` |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | `kimi-code-plan-cn`, `kimi-for-coding`, `kimi`, `kimi-code-plan-global` (first match wins) |
| `meta` | Meta Model API | `providers/meta.js` | `meta` (OpenCode credential; plan usage also reads the Muse CLI OAuth store, see below) |
| `mistral` | Mistral AI | `providers/mistral.js` | `mistral` (API key under `key` or `token`) — key-validity class: usage/balance are not API-readable on a standard key (#1619) |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | `nano-gpt`, `nanogpt`, `nano_gpt` |
| `openrouter` | OpenRouter | `providers/openrouter.js` | `openrouter` |
| `opendesign` | Open Design | `providers/opendesign.js` | OpenChamber-managed credential stored under `~/.config/openchamber/quota/opendesign.json` (`{ cookie, workspaceId }`) |
| `zai-coding-plan` | z.ai | `providers/zai.js` | `zai-coding-plan`, `zai`, `z.ai` |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | `zhipuai-coding-plan`, `zhipuai`, `zhipu`; falls back to `provider.<alias>.options.apiKey` in opencode.json, resolving `{file:...}` (including `~/`) and `{env:...}` with `resolveConfigApiKey` (`utils/auth.js`) |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` / `providers/minimax-shared.js` | `minimax-coding-plan` |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` / `providers/minimax-shared.js` | `minimax-cn-coding-plan` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | `ollama-cloud` / `ollamacloud` API key from OpenCode's credential store |
| `wafer` | Wafer.ai | `providers/wafer.js` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | API key on the `opencode-go` integration or, without one, on the shared `opencode` integration; or an OpenCode Console OAuth sign-in on `opencode` |
| `neuralwatt` | NeuralWatt | `providers/neuralwatt.js` | `neuralwatt` (API key under `key` or `token`) |
| `kilo` | Kilo Code | `providers/kilo.js` | `kilo`, `kilocode`, `kilo-code` (API key under `key`, `token`, or OAuth `access`; organization id under `kilocodeOrganizationId`, `organizationId`, or OAuth `accountId`, else OpenCode `provider.kilo.options.kilocodeOrganizationId`) |
| `zenmux` | ZenMux | `providers/zenmux.js` | Optional Platform API key stored under `~/.config/openchamber/quota/zenmux.json` (`platformApiKey`). The OpenCode chat key is not used. |
| `xai` | xAI | `providers/xai.js` | `xai` OAuth entry in OpenCode `auth.json` |

## Provider registry contract (design #1808)

The manifest at `provider-manifest.json` (beside this document) is the one
checked-in statement of the quota provider set: every provider id that appears
in any surface list, its display name, and its presence on each surface (web
registry, VS Code dispatch, VS Code configured set, UI catalog, UI type union,
and the dispatcher table above). One conformance test per package (web, VS
Code, UI) asserts that package's lists equal the manifest; a provider that
appears in a list but not the manifest fails, and so does a manifest provider
silently absent from a list. The contract the manifest encodes:

1. **One logical provider set.** Exactly one set of quota provider ids; each
   surface's list is a view of it, stated in the manifest.
2. **Landed only when landed everywhere.** A new provider lands web fetcher +
   registration, VS Code fetcher + dispatch + configured entry, UI catalog +
   type, and the docs row in the same change. A surface that legitimately
   cannot serve a provider records a **named exception with a reason** in the
   manifest - never a silent absence.
3. **Aliases are not providers.** A credential alias (for example `openai` for
   `codex`, per the web registry's `credentialAliases`) is recorded in the
   manifest as an alias and appears in no surface's provider list - including
   the type union, where `openai` currently sits as if it were a provider
   (recorded as the alias row's open note; fixing the union is not phase 1).
4. **Configured and fetch select through one function.** Per provider per
   backend, exactly one credential-selection function serves both the
   configured predicate and the fetch path; two selection expressions for one
   provider in one backend is a defect.
5. **No distinct id for a duplicate fetcher.** A behaviour-identical fetcher's
   id is folded into its provider (alias / folded instance) or registered with
   the distinct data it adds stated.

## Internal-only provider module
- `providers/openai.js` exists for logic parity/reuse but is intentionally not registered for dispatcher ID routing.

## Response contract
All providers should return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional field: `error`
- Optional per-credential fields: `credentialId`, `credentialLabel`, `credentialActive`, and `accountLabel` (see the per-credential section below)
- Unsupported provider requests should return `ok: false`, `configured: false`, `error: Unsupported provider`

Provider modules must export `providerId`, `providerName`, `aliases`, `isConfigured(auth?)`, and `fetchQuota()`.
Every provider fetch carries a 15-second `AbortSignal.timeout` deadline. Every provider response body is also read through the bounded reader in `utils/response-body.js` under the named cap `QUOTA_RESPONSE_MAX_BYTES = 1 MiB` (1 * 1024 * 1024), exported from that module: a deadline bounds time, not memory, and quota payloads are small per-account usage/balance/credits JSON documents (xAI's is a small protobuf body), so 1 MiB — the changelog-index precedent — costs nothing while a fast hostile or misconfigured (sometimes user-configured) endpoint cannot grow server memory arbitrarily inside the deadline window (#1282). An over-cap body fails the provider's result through its normal failure path instead of being buffered and parsed. The VS Code twin (`packages/vscode/src/quotaProviders.ts`) applies the same named cap with its own local helper; the surfaces share no code. A stalled endpoint returns the provider's `ok: false` result (`Request timed out` where the provider names its errors) and releases the dispatcher's `pendingFetches` entry, so the next request fetches fresh.
`fetchQuota()` should return a quota result with `usage.windows` keyed by window name (for example `5h`, `7d`, `daily`) and optional provider-specific `usage.models` data.
A module may also export `fetchQuotaForCredential(credentialRow)` to opt into per-credential quota (below); its row in `providers/index.js` then carries `credentialAliases` (the integration ids its credentials live under) and the dispatcher handles enumeration.

exe.dev, Cursor, and ZenMux credentials are explicitly managed through Settings. exe.dev usage uses a separately generated HTTPS API token restricted to `billing credits usage` and aggregates every `exe-*` model provider into one monthly credit window. Generate the token with `ssh exe.dev "ssh-key generate-api-key --label=openchamber --exp=30d --cmds='billing credits usage'"`. ZenMux usage uses an optional Platform API key pasted on the Usage page; the OpenCode chat key is never used, and a missing Platform API key means ZenMux quota is not fetched. The server validates managed credentials before atomic `0600` writes and never returns secrets through its API. OpenChamber never scans browser cookie stores or automatically reads Cursor storage; Cursor import is an explicit one-time user action and never modifies Cursor's database. The import reads the database through the `sqlite3` CLI with a five-second timeout in both the web provider and the VS Code extension (`quotaCredentials.ts`), so a hung `sqlite3` fails the import with the existing unavailable error instead of blocking the server or the extension host.

Command Code usage resolves account scope through `GET /alpha/whoami`, then reads server-backed credit balances and five-hour/weekly limits from `GET /alpha/billing/credits?orgId=...`. Personal accounts return `org: null` and use `/alpha/billing/credits` without an `orgId`; organization accounts include their organization id. Web/Electron and VS Code read the standard `command-code` OpenCode auth entry (including OAuth `access`) or `COMMAND_CODE_API_KEY`; credentials remain in the owning runtime and are never returned to shared UI.

## Open Design (AMR) quota

Open Design usage lives behind the AMR console session, not the inference API key: the `sk-amr` key authenticates model calls only and the console API rejects it. The `opendesign` provider is a managed credential (`opendesign.json` holding `{ cookie, workspaceId }`): the value of the Better Auth session cookie from a signed-in browser (a bare session token is stored under its `better-auth.session_token` name) plus the workspace id, sent as the `x-vela-workspace-id` header. Sign-in itself is Turnstile-gated and is never scripted; the cookie is captured once from the user's browser and re-imported when it expires.

A fetch checks the session first (`GET /api/auth/get-session`): a missing session, a non-OK answer, or a 401/403 from the usage endpoint returns the re-import error, never zero usage. The windows come from `GET /api/v1/workspaces/{id}/billing/coding-plan-usage`: each `windows[]` entry maps by `durationSeconds` (18000 to `5h`, 604800 to `7d`), with `usedPercent` computed from `remainingCredits / limitCredits` and `resetsAt` carried through. A second, best-effort read of `GET /api/v1/workspaces/{id}/billing/usage` over the trailing 7 days builds the per-model breakdown in `usage.models`: per model, summed input/output/total tokens, the credit multiplier, credits consumed, and `sharePercent`, the model's share of the credits in that span. The CLI prints the breakdown as indented lines under the windows; `--quiet` leaves it out and `--json` carries it as structured fields. The billing/usage field names have not been verified against a live account yet, so the parser accepts the plausible spellings and sums what it recognizes; an unrecognized payload omits the breakdown and the windows still stand. Verify the field names on the first live read after a cookie is imported and tighten the parser then.

## Disabled providers, per-credential quota, and provider instances

**Disabled providers.** `listConfiguredQuotaProviders()` leaves out providers the merged OpenCode config turns off (`disabled_providers`, read through `readConfigLayers()` in `server/lib/opencode/shared.js`, the same merged-config read the OpenRouter provider uses for its base URL). The filter keys on the OpenCode provider ids a quota row answers to: by default the row's own quota id, with one explicit exception, both Copilot rows follow `github-copilot` because they read the same credential. Quota ids and OpenCode provider ids are different namespaces, so alias matching is not used: the Codex row must not disappear because an unrelated `openai-codex` entry is disabled, and OpenCode Go must not disappear because `opencode` is. Passing `{ includeDisabled: true }` (the CLI's `--all`) lists them anyway. The filter governs the listing only: `fetchQuotaForProvider(id)` and `fetchQuotaForProviderInstances(id)` always fetch a provider named explicitly. If the config cannot be read, or a layer fails to parse, the failure is logged (`console.error` / `console.warn`) and the listing proceeds unfiltered; a silent filter would hide providers with no trace. The VS Code twin applies the same listing filter; per-credential and per-instance quota below are web and CLI only for now.

**Per-credential quota.** OpenCode can hold several credentials for one integration (two ChatGPT sign-ins, for example), while the projected credential read keeps only the active one. `listStoredCredentials(integrationID?)` in `server/lib/opencode/auth.js` returns every stored row (id, label, active flag, projected value); the projected read and its consumers are unchanged. `fetchQuotaForProviderInstances(providerId)` in `providers/index.js` returns one result per usable stored credential for providers that export `fetchQuotaForCredential`: Codex and OpenCode Go natively, and ClinePass, DeepInfra, Charm Hyper, and Kilo through an adapter that re-enters their existing fetch with a credential read limited to that row, because those fetchers already accept an injected read. Every other provider, and any provider whose store holds no usable row, answers the single active-credential result, so callers see one shape either way. Results carry `credentialId`, `credentialLabel`, and `credentialActive` from the store row; a provider may add `accountLabel` for the account the credential metered (Codex takes the usage response's `email`, falling back to its `account_id`). Providers are added to per-credential quota by giving their fetcher an injectable credential read, not by special-casing the dispatcher.

**Injected credential reads (tests).** The Codex, Copilot (both rows), DeepSeek, NeuralWatt, OpenRouter, Z.ai, ZhipuAI, and Claude fetchers accept an optional injected credential read (`readAuth`, defaulting to `readOpenCodeCredentials`); Claude credential discovery also accepts injected Keychain-exec and credentials-file readers, and the registry dispatch functions accept `readAuth`/`listCredentials` and thread them to provider fetchers. Tests pass fakes through these seams instead of mocking the `opencode/auth.js` module. On the web, `GET /api/quota/:providerId` returns the dispatcher's results directly: an array when several credentials answered, and the single result object when only one did, so one-credential consumers keep the shape they already parse. The shared UI accepts both shapes, stores one result per credential, and the Usage page renders a labeled block per credential; other surfaces that look a provider up by id read the active credential's result.

**Provider instances.** A provider instance in the merged config (a `providers` or `provider` entry with `instanceOf`, such as `openai.alternate` for a second ChatGPT account) is quota-readable as its own row when a credential is stored under the instance id: its credentials live under the literal instance id in the credential store, and its quota type is the base provider the instance points at, matched through the base provider's `credentialAliases`. The instance lists only when at least one of its stored credentials is usable, and its results carry the config `name` as `providerName` when one is set. An instance whose base provider has no per-credential fetch is not listed and fetches as unsupported. `fetchQuotaForProvider(instanceId)` keeps its one-result contract and answers with the instance's active credential.

**Folded instance credentials (Codex).** A registry entry may set `foldInstanceCredentials` (Codex does, #1555): the base provider's per-credential answer then also folds in its configured instances' rows, labeled as the base provider's own rows, and the base provider lists as configured when one of its instances does. After the provider re-seat the ChatGPT accounts live only under instance integrations, so without the fold the base Codex row read as unconfigured while every account was healthy. The base provider's single-credential fetch — and the VS Code twin's, which keeps its single-result contract — falls back to the first usable instance credential when the bare integration holds none.

**Shared upstream-auth failures (#894).** Every provider that reads credentials through `../opencode/auth.js` fails the same way when the running OpenCode rejects OpenChamber's own credentials (for example after an OpenCode restart rotates its server password): the upstream 401 body is the bare string `Authentication required`, and each provider would otherwise surface that identical string as its own error, inviting per-provider fixes for one shared credential-path failure. The credential read in `opencode/auth.js` is the one place the peer is known to be the running OpenCode, so that is where the failure's origin is recorded: a 401 from the credential source (or its bare 401 body) is rethrown as an `OpenCodeUpstreamAuthError` carrying `origin: 'opencode-credential-source'` (see `opencode/credential-auth-error.js`). The dispatcher in `providers/index.js` classifies by that marker — never by the error text — on every result it returns (single fetch, per-credential rows, provider instances, and the configured-provider listing): the result keeps `ok: false` / `configured: true`, its `error` names the shared OpenCode upstream-auth failure and the check to run, and it carries `errorKind: 'opencode_upstream_auth'` so consumers can group or alert on the one failure. Provider-specific auth errors (a provider's own 401 from its own API, including a z.ai `payload.msg` of `Authentication required`) are not rewritten, however they are worded. One exception in mechanism, not in scope: a provider whose credential wrapper replaces the store-read error with its own text (xAI, #1131) marks its result with a credentialReadFailure flag instead of surfacing the upstream string, and the dispatcher classifies from that marker and drops it, so the marker never reaches consumers.

**Provider catalogue.** `listQuotaProviderCatalogue()` returns every dispatchable provider and configured provider instance as `{ id, name, aliases, disabled }` (instances add `instanceOf`), where `aliases` merges the module's exported aliases with the registry row's `credentialAliases`. Callers that take provider names from a user (the CLI) resolve ids, display names, aliases, and wildcard patterns against this catalogue; the dispatcher itself still takes exact provider ids only, so resolution policy stays with the caller.

## OpenCode Go credential and quota semantics

OpenCode Go has two credential shapes and they are not interchangeable. An API key is a bearer token for `GET https://opencode.ai/zen/go/v1/usage` with the stable `x-opencode-session: openchamber-usage` workload id. A Console sign-in lives on the shared `opencode` integration as OAuth; its access token is a user session, not that key, and it is sent to `GET https://opencode.ai/console/api/go/status` with `x-org-id: <selected organization ID>`. That status endpoint is what the current Console Go page itself reads; it is not publicly documented, so re-check it against the live Console page before assuming it is still current. The credit balance the Go page shows alongside the meters comes from a second Console endpoint, `GET https://opencode.ai/console/api/billing/status`, read with the same token and organization.

- **Credential selection**: OpenCode marks exactly one credential active per integration and credentials are global, so the active `opencode` OAuth credential is the selected account and organization. The reader carries only the Console `server` and `orgID` metadata; a credential whose `server` is not `https://opencode.ai/console`, whose `orgID` is missing or malformed, or that is an API key does not count as a Console sign-in. When both exist, the Console sign-in serves Go and the `opencode-go` key is the fallback, both when there is no Console sign-in and when the Console read fails; the Console error surfaces only when there is no key.
- **API key on `opencode`**: without an `opencode-go` key, an API key on the shared `opencode` integration is used against the same usage API. OpenCode loads the Console workspace's providers with that key and binds OpenCode Go to the `opencode` integration when the workspace has Go, so Providers lists the key under OpenCode Go and Usage must read it too. The usage API accepts any key of a Console workspace and answers 403 when the workspace has no Go subscription; for this key a 403 is reported as the absent subscription, the same message as the Console sign-in path. That 403 meaning comes from the Console's own handler for legacy `sk-` keys; new `oc_sk_` keys and keys of migrated workspaces are proxied to a separate inference service, so re-check its answer there when the endpoint changes. An API key and a Console sign-in never coexist on `opencode`, since OpenCode keeps one active credential per integration.
- **Read-only and per-call**: the access token is read through `../opencode/auth.js` on every fetch, so switching accounts drops the previous account instead of showing stale numbers. OpenChamber never refreshes the token itself: OpenCode owns that, and an expired access token (local `expires`, or a 401/403) is surfaced as "sign in again" rather than a competing refresh.
- **Meters**: the response's `product` must be `go` or `go-plus`; anything else is an absent subscription. `access.meters.fiveHour` / `week` / `month` map to the existing `5h` / `weekly` / `monthly` windows. `limitMicroCents` and `usedMicroCents` are decimal strings; the percentage is `used / limit`, never a hardcoded plan limit. A missing meter, a non-positive or unparseable limit, or an invalid reset timestamp skips that window alone; no usable window is a failed refresh, not zero usage.
- **Credits balance**: the Go status response carries no credit balance. Alongside the Console read (never with a locally expired sign-in), the provider also reads the billing status, so a slow billing endpoint adds no time beyond the slower of the two requests. When the Go read succeeds, it surfaces its `availableMicroCents` (integer micro-cents as a decimal string; the Console counts `1_000_000` micro-cents per cent, so `100_000_000` is one USD) as a `credits_balance` window with a money `valueLabel` and no percent or reset. This read is best-effort: any failure (network, HTTP, malformed, or an absent amount) drops the row rather than failing the refresh or reporting a `$0.00` balance, and it never runs on the API-key path.
- **Trusted origin**: requests go only to the fixed Console status URL with `redirect: 'error'`, so the bearer token is never forwarded to another origin.
- **Failure classes stay distinct**: not configured (no credential), expired sign-in (expired local token or 401/403), absent subscription (unexpected `product`, or a 403 for an `opencode` API key), malformed response, and temporary request failure each return their own configured flag and message.
- **Per-workspace rows (web and CLI only)**: OpenCode Go exports `fetchQuotaForCredential`, registered with `credentialAliases` `opencode-go` + the shared `opencode`. Each usable stored row — one Console sign-in per workspace, or a stored API key — answers its own result through `fetchQuotaForProviderInstances`, replacing the combined row on that path; the combined single fetch remains only as the no-usable-row fallback. A Console row carries its `orgID` as `accountLabel`, so a workspace row is attributable even when the stored credential has no label; the plan label is per row, from that row's own Console read. A failing workspace returns its own error row and does not affect the others. The generic credential-read adapter is not used here: this provider reads two integrations, and the per-row fetch must preserve the within-row Console-first / API-key-fallback order and the `opencode`-key 403 meaning.
- Keep `packages/web/server/lib/quota/providers/opencode-go.js` and `packages/vscode/src/opencodeGoQuota.ts` in sync — the VS Code extension duplicates this logic rather than importing the web provider. The per-workspace dispatch above is the documented web/CLI-only exception: the VS Code twin keeps the single active-credential row, as with the other per-credential providers.

On the first OpenCode Go usage refresh after upgrading, OpenChamber deletes the obsolete `quota/opencode-go.json` credential file without reading its cookie value.

## Codex credit balance semantics

Codex `credits.balance` is an OpenAI credit count, not a dollar amount. Web/Electron and VS Code expose it as a plain numeric `credits_balance.valueLabel` under the UI's localized Credits Balance title, without a currency symbol or two-decimal money rounding. Numeric strings are accepted; zero, unlimited, and unavailable balances retain their existing handling. Keep `providers/codex.js` and `packages/vscode/src/quotaProviders.ts` in sync. The separate business-account `spend_control.individual_limit` window is unchanged.

A Codex usage 401 whose body has `error.type: "rejected_by_access_enforcement"` is OpenCode's `chatgpt-token-sharing` sign-in ("Sign in with ChatGPT"). Its token is minted for `https://api.openai.com/v1` with the `chatgpt.tokens.use.direct` scope, which OpenAI admits only on the Responses route, and OpenAI publishes no usage endpoint for that sign-in: its guidance is to link to `chatgpt.com/settings/usage`. Both runtimes say exactly that and name the legacy Codex sign-ins as the ones that show usage in the app. Any other 401 reads as an expired session. Web and VS Code keep this branch identical.

### Why no `ChatGPT-Account-Id` for the token-sharing sign-in

The token-sharing credential carries `{ clientID, scopes }` and no account id, so the request goes without the `ChatGPT-Account-Id` header the legacy sign-ins send. Adding the header was weighed and dropped: the refusal comes from scope enforcement (`no_matching_rule`) on a route the token is not admitted to, and OpenAI documents the Responses route as the only one this token may use. If OpenAI ships a usage endpoint for this sign-in, it replaces the message.

## Claude credential and limit semantics

Claude quota reports the subscription limits Claude Code itself is bound by, read from `GET https://api.anthropic.com/api/oauth/usage`.

- **Credential sources**, in priority order: the macOS Keychain entry `Claude Code-credentials`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` (the Linux/WSL location), then the OpenCode `auth.json` entry, then `CLAUDE_CODE_OAUTH_TOKEN`. The Keychain wins on macOS because the credentials file there is a leftover Claude Code no longer updates.
- **All sources are read-only.** OpenChamber never writes to Claude Code's credential store and never refreshes the OAuth token, because Anthropic does not support two live refresh tokens for one `client_id` — refreshing here would sign the user out of Claude Code. Credentials are read fresh per request so a Claude Code refresh is picked up immediately; an expired token yields an explicit "open Claude Code to sign in again" error rather than a bare 401.
- **Limits come from the `limits` array**, keyed by `kind`: `session` maps to the `5h` window, `weekly_all` to `7d`, and `weekly_scoped` to a per-model `7d` window named by `scope.model.display_name`. The legacy `five_hour`/`seven_day` fields are only a fallback; `seven_day_sonnet`/`seven_day_opus` are no longer populated by Anthropic. Unrecognized limit kinds and Anthropic's rotating internal code names (`nimbus_quill`, `tangelo`, ...) are ignored rather than guessed at.
- **Extra usage** is reported as the `extra_usage` window from `spend`, only while `spend.enabled` is true, with a money `valueLabel`.
- **Rate limiting**: Anthropic returns 429 aggressively. The last successful usage payload is cached in memory and reserved during a cooldown (`Retry-After`, else five minutes, capped at one hour). The cache is keyed by a hash of the access and refresh tokens, so switching accounts drops it instead of showing the previous account's numbers.
- **Runtime parity**: Web/Electron and VS Code preserve the last successful Claude values during the same bounded 429 cooldown. Quota dispatchers also coalesce concurrent refreshes for the same provider in each runtime, while requests for different providers remain parallel.

## xAI credential and quota semantics

xAI quota reports the SuperGrok billing cycle from `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (gRPC-web, an empty-body request), authenticated with the `xai` OAuth entry's access token read from OpenCode.

- **Credentials are read-only.** OpenChamber never refreshes the xAI OAuth token. xAI rotates (and rejects the previous) refresh token on every exchange, and OpenCode 2.x owns the credential store without exposing a refresh route, so a quota-side refresh would consume the token OpenCode still holds and force the user to re-authorize ("Grok expired every morning"). The provider uses the stored access token while it is valid and returns an explicit expired error (no `auth.x.ai` call) once it is stale, matching the Claude provider's "sign in again" handling; OpenCode's own refresh persists the rotated pair.
- **Skipping the standalone refresh also required OpenCode 2.x**: the pre-2.x `auth.json` write path no longer exists (`packages/web/server/lib/opencode/auth.js` is read-only), so there is nowhere correct to persist a rotated pair.
- Keep `packages/web/server/lib/quota/providers/xai.js` and `packages/vscode/src/quotaProviders.ts` (`fetchXaiQuota`) in sync — the VS Code extension duplicates this logic rather than importing the web provider.

## Meta (Muse Code High Usage) quota semantics

`POST https://api.meta.ai/muse-code/key` (`x-api-version: 1.0.0`, body `{ "onboard": false }`) is the endpoint Meta's own Muse Code CLI reads for `/usage`; Meta publishes no separate usage REST route. The response carries the plan's own view: `subs_usage.window` (a rolling window: `used_percent`, `window_duration_mins`, `resets_at`), `subs_usage.weekly` (`used_percent`, `resets_at`), and `subs_tier_name` (for example "Muse Code High Usage"). The rolling window becomes a duration-labelled window (`window_duration_mins` × 60 → `5h`, …), `weekly` becomes the `weekly` window, and `subs_tier_name` becomes `planLabel`.

**Credential sourcing.** The read authenticates with the Meta *account* OAuth token (the Muse Code device-login token, `dca:…`), not with the subscription's minted inference API key: the key endpoint refuses a minted key with 401, while `/v1/models` and `/v1/chat/completions` accept the minted key and carry no usage signal. The OpenCode `meta` credential is tried first, so an install that stores the account token there works directly. When OpenCode holds the minted inference key (the fleet's case: `META_API_KEY` is the `LLM|…` key the key endpoint mints), that read is rejected and the provider falls back to the account token in the Muse CLI's own OAuth store (`~/.config/muse/auth.json`, `providers.meta.access_token`) — the same login the fleet's muse-proxy uses for this pool. The token is read at fetch time and never logged or returned.

**Post-roll empty state.** After a window rolls unspent, the endpoint answers 200 with `is_subs_active: true` and no `subs_usage` at all (captured live 2026-10-28). That state is a window open with no usage yet: the provider returns `ok: true` with the rolling and weekly windows present and unknown percentages, the same shape an empty window object maps to. A body with no usage windows and no active flag stays a `No quota data in response` failure.

**Failure classes stay distinct.** Not configured (no credential), unauthorized (the credential the read used is not an account token), subscription inactive (`is_subs_active === false`), a 402-class wall or a 429 (an exhausted plan, `require_payment`, or a rate-limited usage read), malformed response, and transport failure each return their own result. The wall is surfaced as `ok: false, configured: true, quotaExhausted: true` with `quotaResetAt` when the body carries one — a consumer that parks work on walls must not read it as a read failure.

Keep `packages/web/server/lib/quota/providers/meta.js` and `packages/vscode/src/quotaProviders.ts` (`fetchMetaQuota`) in sync — the VS Code extension duplicates this logic rather than importing the web provider.

## Add a new provider (quick steps)
1. Choose module shape based on complexity:
   - Simple providers: create `packages/web/server/lib/quota/providers/<provider>.js`.
   - Complex providers (multi-source auth, multiple API calls, non-trivial transforms): create `packages/web/server/lib/quota/providers/<provider>/` with split modules like Google (`index.js`, `auth.js`, `api.js`, `transforms.js`).
2. Export `providerId`, `providerName`, `aliases`, `isConfigured`, and `fetchQuota`.
3. Use shared helpers from `packages/web/server/lib/quota/utils/index.js` (`buildResult`, `toUsageWindow`, auth/conversion helpers) to keep payload shape consistent.
4. Register the provider in `packages/web/server/lib/quota/providers/index.js`.
5. If needed for direct use, export a named fetcher from `packages/web/server/lib/quota/providers/index.js` and `packages/web/server/lib/quota/index.js`.
6. Update this file with the new provider ID, module path, and alias/auth details.
7. Validate with `bun run type-check`, `bun run lint`, and `bun run build`.

## Google OAuth client compatibility

The `google` quota provider reads the active OpenCode login. Gemini CLI and
Antigravity both pack project context into the refresh token with `|`, and a
generic OAuth method with empty metadata does not identify its issuing client.
The provider keeps the Gemini model keys and quota parsing for either login.

Expired or missing access tokens first use the Gemini CLI OAuth client. Only
HTTP 400/401 with the parsed OAuth code `unauthorized_client` permits one attempt
with the Antigravity client. This compatibility probe leaves the selected
credential unchanged. Other authorization errors, bare HTTP failures, malformed
responses, rate limits, and transport failures never trigger the alternate
client. A valid access token requires no exchange.

`providers/google/oauth.js` owns the shared refresh logic and installed-app
client constants for web/Electron and VS Code, including direct Antigravity
refreshes which use only their own client. Exchanges go to the fixed Google token
URL, reject redirects, and have a 15-second deadline each. Failures preserve HTTP
status and an allowlisted OAuth code, or a transport/response category internally.
The panel keeps its existing refresh failure text; raw error bodies and exception
messages never reach the quota result. Failed refreshes
return configured failure without querying quota with expired access.

Refreshes are read-only with respect to OpenCode credentials. Neither a guessed
client nor refreshed tokens are written back. Refresh-token rotation and changes
to quota endpoint semantics are outside this compatibility fix.

### Why a wrong-client store login reads as not configured

The store's `google` entry is shared: a Gemini CLI OAuth sign-in lives in the same entry shape as the Antigravity plugin's login, and the credential carries no reliable marker of its issuing client, so resolution cannot tell them apart. The first distinguishing evidence is the token exchange itself: a foreign login's refresh is rejected with HTTP 400/401 and the OAuth code `unauthorized_client`, permanently. When every candidate came from the store and every refresh ends in that confirmed wrong-client rejection, `fetchQuota` reports the provider as not configured - there is no Antigravity source, so there is no broken Antigravity account to show. An accounts-file candidate is Antigravity-issued by construction and keeps the refresh-failure state, as does any other store failure (`invalid_grant`, transport, malformed responses).

### Why the Antigravity provider reads the credential store, not only the accounts file

The plugin's current versions sign in through OpenCode's credential store (the `google` integration's OAuth credential, written by its `antigravity` auth method) and never write the legacy accounts file. The file also lives in the OpenCode config directory, where a config redeploy can remove it without touching the live login. Reading only the file therefore reports a working login as "not configured" — silently, with no error row. The provider resolves both sources (accounts file first, then the credential store, deduplicated by refresh token) and tries each candidate's refresh in order. Regenerating the accounts file from the store was rejected: a copied refresh token rots when the stored login rotates, and two writers for one login invite divergence.

## Antigravity quota and limit semantics

Antigravity reports dual-layer quota for Google Cloud Code / Antigravity IDE accounts, querying Google's `retrieveUserQuotaSummary` endpoint (falling back to `daily-cloudcode-pa.googleapis.com` and `fetchAvailableModels` flat quotaInfo).

- **Windows**: each model row carries its group's rolling 5-hour (`5h`) and 7-day weekly (`weekly`) limits across Gemini and 3P (Claude/GPT) model groups. The provider card itself exposes no top-level windows (`windows: {}`), matching the Google provider: one overview row could only reflect a single group and would mislead a user whose tighter limit lives in the other group.
- **Bottleneck prioritization**: when a group's weekly limit is exhausted or more constrained than its 5-hour limit, the weekly window is prioritized first in the model's window map.
- **Runtime parity**: `packages/web/server/lib/quota/providers/antigravity/` and `packages/vscode/src/quotaProviders.ts` (`fetchAntigravityQuota`) implement the same summary parsing, fallback chain, and bottleneck ordering — keep them in sync.
- **Client identity**: both runtimes take their request headers from `providers/antigravity/client.js`. The `User-Agent` is `antigravity/<ANTIGRAVITY_CLIENT_VERSION> <os>/<arch>`, with the platform of the machine the request runs on. Google gates the "Gemini Models" group of the daily host's `retrieveUserQuotaSummary` by that version: `antigravity/1.11.5` got the Claude/GPT group alone, answered 200, and the Gemini rows disappeared without an error (#5138). Keep the constant at the version Antigravity's own updater lists (the `version:` line of its `latest-arm64-mac.yml` manifest, URL in the file). A summary that has groups but none for Gemini logs one server-side warning per process that names the constant. The Google provider keeps its own headers.

### Why a pinned client version and not one read from Antigravity's updater

Reading the updater manifest on every start would track releases without a code change, but it adds a request to a Google host the quota card does not otherwise need, and a failed or changed manifest would still need a fallback version in code. A single constant plus the missing-group warning keeps the requests the same and makes the next stale version show up in the server log.

## MiniMax M3 / Token Plan migration

In 2025/2026 MiniMax rebranded "Coding Plan" to "Token Plan" alongside the M3 model release. The API underwent breaking changes:

- **Endpoint fallback**: The provider tries `/v1/token_plan/remains` (M3) first, falling back to legacy `/v1/api/openplatform/coding_plan/remains`.
- **Field semantics**: On the `token_plan/remains` endpoint, `current_interval_usage_count` returns **remaining** quota (not consumed). The provider computes `used = total - remaining` for this endpoint. The legacy `coding_plan/remains` endpoint retains the old semantics (`usage_count = consumed`).
- **Percentage-based plans**: Legacy Coding Plan accounts return `current_interval_total_count: 0` but include `current_interval_remaining_percent`. The provider prefers this field when count fields are absent.
- **model_remains array**: Now contains entries for multiple model categories (chat, speech, video, image). The provider selects the chat-model entry by matching `MiniMax-M*`, then `general`/`chat`/`text` by name, then any entry with a remaining percent.
- **Window status**: The `current_interval_status` and `current_weekly_status` fields indicate whether a window is active. Status `3` means the window is not applicable for the current plan tier (e.g. legacy plans without weekly limits). The provider omits inactive windows.

## ClinePass quota semantics

ClinePass reads `data.limits` from its usage-limits endpoint. Web/Electron and
VS Code accept only known window types with finite numeric or non-empty numeric
string percentages. Invalid windows are skipped independently; no usable windows
is a failed refresh, not zero usage. Both implementations choose a non-empty
`key`, then `token`, and expose auth/fetch dependencies for focused tests.
Saved UI provider-visibility lists remain authoritative; installations without a
saved list include ClinePass through the provider registry.

## DeepInfra balance semantics

DeepInfra reports the spendable credit through `GET https://api.deepinfra.com/v1/me?checklist=true` (bearer API key). The documented `checklist.stripe_balance` is **negative when funds are ready to spend** and **positive when money is owed**, so the provider negates it before rendering the `credits_balance` money label (`-$X.XX` when a balance is owed). The API key is read from the OpenCode `auth.json` entry (`deepinfra`, `deep-infra`, `deep_infra`). Keep `packages/web/server/lib/quota/providers/deepinfra.js` and `packages/vscode/src/quotaProviders.ts` (`fetchDeepinfraQuota`) in sync — the VS Code extension duplicates this parsing logic rather than importing the web provider.

## Charm Hyper balance semantics

`GET https://hyper.charm.land/v1/credits` returns a team's current Hypercredit balance, not a percentage or reset timestamp. The [Hyper FAQ](https://hyper.charm.land/faq) defines one Hypercredit as $0.05. Both runtimes expose `credits_balance` in dollars and `credits` as a numeric label under the UI's localized window title. Keep English unit text out of that numeric label.

Web and VS Code accept finite numeric balances and non-empty numeric strings. Missing, blank, or malformed balances remain explicit failures; zero is valid. Credential lookup uses a non-empty string `key`, then `token`, so malformed or blank keys cannot mark the provider configured or hide a valid fallback token. Hyper fetchers accept `readAuth` and `fetchImpl` dependencies for tests without replacing filesystem or auth modules.

## ZenMux PAYG balance semantics

`GET https://zenmux.ai/api/v1/management/payg/balance` returns prepaid Pay As You Go credits, not a percentage or reset timestamp. The documented payload nests `data.total_credits` in USD (1 credit = $1). Both runtimes expose that as `credits_balance`. Usage is optional and uses a ZenMux Platform API key stored as a managed quota credential (`platformApiKey`). The OpenCode `auth.json` chat key is never sent. If that Platform API key is missing, ZenMux is not configured and the balance endpoint is not called. Missing, blank, or malformed totals remain explicit failures; zero is valid. Keep `packages/web/server/lib/quota/providers/zenmux.js` and `packages/vscode/src/quotaProviders.ts` (`fetchZenmuxQuota`) in sync.

## Kilo Code balance semantics

`GET https://api.kilo.ai/api/profile/balance` returns `{ balance }` in USD. Both runtimes expose that as `credits_balance`. Credentials come from OpenCode `auth.json` (`kilo`, `kilocode`, `kilo-code`): API `key`/`token` or OAuth `access`. The optional `x-kilocode-organizationid` header is sent when an organization id is present on the auth entry (`kilocodeOrganizationId`, `organizationId`, or OAuth `accountId`) or, when that is missing, from OpenCode `provider.kilo.options.kilocodeOrganizationId`. Personal accounts omit the header. Missing, blank, or malformed balances remain explicit failures; zero is valid. Keep `packages/web/server/lib/quota/providers/kilo.js` and `packages/vscode/src/quotaProviders.ts` (`fetchKiloQuota`) in sync.

## Kimi for Coding field semantics

`GET https://api.kimi.com/coding/v1/usages` has two payload shapes and the provider supports both. Which one arrives depends on whether the account's plan has been migrated; in 2026-10 Kimi moved its newer plans from a weekly allowance to a monthly one. The endpoint is not in Kimi's public Open Platform reference. Its contract is defined by Kimi's own CLI, `MoonshotAI/kimi-code`, in `packages/oauth/src/managed-usage.ts` and `apps/kimi-code/src/utils/usage/usage-format.ts`.

**Ratio payload.** A top-level `usages` object keyed by limit name, each entry `{ used_ratio, reset_time }`, where `used_ratio` is a 0-1 fraction and `reset_time` is RFC3339. Kimi documents its client as rendering whichever entries are served, so an absent key means the plan has no such window rather than missing data. An entry with no finite `used_ratio` is skipped instead of shown as an unknown percentage.

| `usages` key | Window | Notes |
| --- | --- | --- |
| `limit_5h` | `5h` | Rolling five-hour frequency window |
| `limit_7d` | `weekly` | Served only by plans that still have a weekly allowance |
| `limit_month_total` | `monthly` | The plan's monthly allowance; `reset_time` is the subscription anchor, not a calendar month boundary |
| `limit_month_code` | not shown | The code-typed share of `limit_month_total`, not a second allowance |

`limit_month_code` is not surfaced. As its own row it would read as a second monthly allowance. As a `valueLabel` on the monthly row it would replace the row's percent with fixed used figures, so the row would ignore the used/remaining display setting that every other row follows.

When `usages` is present the provider does not read `limits[]`. Its 300-minute entry describes the same five-hour window as `limit_5h`, carrying the same ratio rounded to a whole percentage against a fixed `limit` of `100`, and Kimi's own client ignores `limits[]` altogether.

The payload may also carry `boosterWallet`, the pay-as-you-go top-up wallet that Kimi's client reads as `extraUsage`. OpenChamber does not surface it.

**Counted payload.** Plans that have not migrated return a single weekly `usage` block plus `limits[]` rate-limit entries. This shape is inconsistent about which field carries consumption: the `usage` block returns `used` (consumed) with no `remaining` field, while each `limits[].detail` block returns `remaining` (available) with no `used` field. The provider computes `usedPercent` from whichever of the two is present, `used` taking precedence when both exist, rather than assuming one field name. A `limits[]` entry whose window is exactly five hours is labeled `Rate Limit (<raw duration>)` to set it apart from a plain duration.

Credentials resolve in alias order, first match wins. OpenCode's China plan id `kimi-code-plan-cn` (kimi.com) comes before the pre-split `kimi-for-coding` and `kimi` ids, because a leftover pre-split key can hold a dead credential that would otherwise shadow the live China plan key and return 401. The global plan id `kimi-code-plan-global` (kimi.ai) stays last. Kimi's client uses `https://api.kimi.ai/coding/v1/usages` for global accounts, while this provider calls `api.kimi.com` for every alias, so a global-only key gets a 401 here. That gap is known and unfixed.

Many Kimi users hold a pay-as-you-go Moonshot platform key (prepaid vouchers, no Kimi Code subscription) under `KIMI_API_KEY`. The Kimi Code usage address refuses such a key with 401. On a 401 or 403 the provider therefore asks `GET https://api.moonshot.ai/v1/users/me/balance` with the same key and, when that answers with a numeric `data.available_balance`, reports it as a `credits_balance` window (USD, remaining only). If the balance read also fails, the original `API error: <status>` is returned; other HTTP errors never try the balance address.

Both `packages/web/server/lib/quota/providers/kimi.js` and `packages/vscode/src/quotaProviders.ts` (`fetchKimiQuota`) must stay in sync — the VS Code extension duplicates this parsing logic rather than importing it.

## Ollama Cloud balance semantics

`GET https://ollama.com/api/balance` (documented at
https://docs.ollama.com/api/balance, bearer `ollama-cloud` key from OpenCode's
credential store) carries two documented `included` shapes. A credits plan
reports the month's pool: `included.allowance_usd` and `included.balance_usd`
give the `monthly` window at `(allowance - balance) / allowance`, clamped to
100, resetting at `included.period.until`; a pool without a positive allowance
yields no window rather than a guessed percentage. A legacy plan reports
`included.session` and `included.weekly`, each a `remaining_percent` with a
`resets_at`, mapped to the `session` and `weekly` windows at
`100 - remaining_percent`. Whichever shape the account serves is rendered.
`purchased.balance_usd` is a `purchased_credits` money row shown only while
positive. `POST /api/me` gives the plan tier, read best-effort as `planLabel`; a
failure drops the label, never the reading. `/api/usage` is usage analytics with
no allowance, so it is not the quota source; the obsolete
`quota/ollama-cloud.json` is deleted on the first readable-key refresh. Keep
`providers/ollama-cloud.js` and `packages/vscode/src/quotaProviders.ts`
(`fetchOllamaCloudQuota`) in sync.

The balance endpoint allows 10 requests per minute per user, shared across keys
and devices, with `Retry-After` on a 429. A refresh makes two calls here now
(balance and plan tier) on top of the other providers'.

## GitHub Copilot quota semantics

GitHub Copilot usage exposes only the `premium_interactions` snapshot as the
`premium_interactions` window. Shared UI labels that window **AI Credits** and treats it as
the provider's primary usage marker. Legacy chat-request quota and unlimited
completion quota are intentionally omitted. Keep
`packages/web/server/lib/quota/providers/copilot.js` and
`packages/vscode/src/quotaProviders.ts` in sync.

For github.com, the quota request uses `https://api.github.com/copilot_internal/user`.
For GitHub Enterprise, it uses `https://api.<enterprise-host>/copilot_internal/user`,
with the host taken from the `enterpriseUrl` on the active OpenCode Copilot login, so
the request and the login token only ever reach that server. The accepted value is a
bare origin whose hostname is a DNS name: credentials, a port, a path, a query, a
fragment, a non-HTTP scheme, or a hostname that is not a DNS name fail before the
request is made, and the token is never sent.

The `/copilot_internal/user` endpoint is undocumented; its quota semantics mirror
what `microsoft/vscode-copilot-chat` consumes (`CopilotUserQuotaInfo`). Each
snapshot carries `entitlement`, `remaining`, `unlimited`, and
`percent_remaining`. Providers must honor these rules:

- `unlimited: true` renders a percent-less window with an "Unlimited" value label.
- Percent math requires a positive `entitlement`; entitlements of `0`, `-1`, or null are unusable.
- When entitlement/remaining are unusable, fall back to `100 - percent_remaining`.
- Snapshots other than `premium_interactions` (legacy annual plans) yield zero windows.

**The value label reports credits used, not requests, and uses the same axis as
VS Code.** Premium interactions are a fractional credit pool, not an integer
request count: a Business plan mid-cycle reports `entitlement: 60000` with
`percent_remaining: 65.1` and both `remaining: 39078` and `quota_remaining:
39078.5`. `remaining` is the integer twin of `quota_remaining`, so it drops the
half credit the account actually still holds; `quota_remaining` wins when both
are present. The consumed figure is `entitlement - quota_remaining`, the same
derivation GitHub's own Copilot panel uses, which for those live numbers gives
20,921.5 credits spent and a `20,921.5 / 60,000 used` label. An entitlement that is
unusable for the percent also yields no label, since the label and the percent share
one derivation.

Reporting the remaining axis instead (`39078 / 60000 left`) contradicted what the
row's own percent, progress bar, and the used/remaining display toggle reported,
and stated the opposite of VS Code for the same account at the same moment.
`credits_used` (20,910 live) is monotonic consumption since the last reset and is
deliberately not used as the label: it lags `percent_remaining` and would not sum
to the entitlement.

The label is fixed to the used axis, so with the display preference set to
`remaining` the bar and its caption flip to remaining while the number still reads
`… used`. That mismatch is accepted deliberately: the Kimi section of this document
declined a `valueLabel` for exactly this reason, and the label suppressing the
percent is the defect this change removes, so shipping the percent instead would
trade a wrong number for no number.

## OpenRouter key semantics

OpenRouter quota reads `GET <base>/key`, where `<base>` is the provider's configured `baseURL` (`settings.baseURL`, legacy `options.baseURL`, or legacy `api`, folded by `toProviderEntity`; the v2 `providers.openrouter` entry wins, and the v1 `provider.openrouter` entry is read when the v2 one sets no address) read from the merged opencode config layers; with nothing configured or a config read failure, `<base>` falls back to `https://openrouter.ai/api/v1`. A gateway user's key is only valid against that gateway, so the usage lookup must ride the same base as chat. The default endpoint `GET https://openrouter.ai/api/v1/key` is documented as callable with any valid API key. `GET /api/v1/credits` is documented as "Management key required" and is not used. Calling `/credits` with a normal inference key has been observed to return HTTP 200 with `{total_credits:0, total_usage:0}` rather than an error; this behavior is not documented and is why the old implementation silently rendered "$0.00 left · $0.00 spent". A `/credits` fallback for unlimited keys would render the same zeros, so unlimited keys report `usage_monthly` instead.

The documented `limit`, `limit_remaining`, and `limit_reset` fields are present and null on unlimited keys; null means unlimited, never missing data. For a limited key, window usage is `limit - limit_remaining`, not `usage`: `usage` is all-time and measures a different axis from the current reset window. Pairing `usage` with the current limit produces a wrong number. `limit_remaining` is server-computed and already honors `include_byok_in_limit`, so `byok_*` fields are ignored.

Unlimited keys report `usage_monthly` in a `monthly` window with no percent. `limit_reset` is a period string (`daily`, `weekly`, `monthly`, or null), not a timestamp; `resetAt` is derived from the documented midnight-UTC boundaries, with weeks starting Monday. A set `limit` with a null `limit_reset` is a lifetime cap and maps to the `key_limit` window with no reset, which the UI titles Key Limit. `limit` is the spending cap set on the API key, not the account balance; the balance is only readable with a management key through `/credits`, so it is not shown.

Keep `packages/web/server/lib/quota/providers/openrouter.js` and `packages/vscode/src/quotaProviders.ts` in sync, as with the Kimi and Copilot providers; the VS Code extension duplicates this parsing logic rather than importing the web provider.

## Zhipu AI Coding Plan semantics

`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` reports business failures inside HTTP 200 bodies (`{code, msg, success: false}`; an invalid token yields code 401 with `msg` "令牌已过期或验证不正确"). Providers must validate the envelope (`success === false` or a `code` other than 200) and return the failure with `msg` instead of parsing an empty `data.limits`; a missing envelope is treated as legacy success.

The limit type was renamed from `TOKENS_LIMIT` to `CREDIT_LIMIT` with unchanged `unit`/`number` window semantics: unit 3 marks hourly blocks (`5h`), unit 6 weekly. `CREDIT_LIMIT` entries carry `usage` (total), `currentValue` (consumed), and `remaining`, surfaced as a credit `valueLabel`; when `percentage` is absent the used percent is derived from `currentValue/usage`. `data.level` (for example `lite`) becomes `planLabel`. `TIME_LIMIT` stays the monthly `MCP Tools` window. Keep `packages/web/server/lib/quota/providers/zhipuai-coding-plan.js` and `packages/vscode/src/quotaProviders.ts` (`fetchZhipuaiCodingPlanQuota`) in sync.

## Cursor quota semantics

The primary path reads `GetCurrentPeriodUsage` `planUsage` (Pro/Ultra). Enterprise team members get a sparse payload without `planUsage`, and the provider falls back to the endpoints the Cursor dashboard uses:

1. `GET /auth/full_stripe_profile` resolves the member's `teamId`.
2. `GET /auth/usage` provides included request counts. Buckets use legacy names (`gpt-4`, `gpt-4o`, ...); the provider scans them dynamically, skips `startOfMonth`, and picks the bucket with the highest `maxRequestUsage`, mapped to the `billing_cycle` window.
3. `POST GetHardLimit` with `{ teamId }` returns `hardLimitPerUser` (dollars) for the `on_demand` window. Without `teamId` the response omits the per-user cap and only carries the team pool (`hardLimit`), which is not the user's limit.
4. `POST GetMe` resolves the current `userId` from the access token, and `POST GetTeamSpend` with `{ teamId }` returns per-member spend; the member whose `userId` matches supplies the `on_demand` window's used value (`spendCents`). There is no per-user spend endpoint and no email dependency; if either call fails the `on_demand` window is omitted rather than shown as `$0` used.

`GetAggregatedUsageEvents` dollar totals are deliberately not used for the UI; they reflect internal token cost, not the dashboard request/on-demand meters. `spendCents` from `GetTeamSpend` is the member's on-demand spend and matches the dashboard meter; `includedSpendCents` from the same response is the internal included-pool usage and is not shown. `packages/web/server/lib/quota/providers/cursor.js` and `packages/vscode/src/quotaProviders.ts` implement the same fallback chain and verified-meter semantics — keep them in sync.

## Notes for contributors
- Keep provider IDs stable; clients use them directly.
- Avoid adding alias-based dispatch in `fetchQuotaForProvider`; dispatch currently expects exact provider IDs.
- Keep Google behavior changes isolated and review `providers/google/*` together.
- Z.ai Coding Plan exposes separate 5-hour and weekly token/credit limit entries plus a monthly `TIME_LIMIT` for MCP tools. The API renamed the limit type from `TOKENS_LIMIT` to `CREDIT_LIMIT` (same `unit`/`number` window semantics); `CREDIT_LIMIT` entries additionally carry `usage` (total), `currentValue` (consumed), and `remaining`, surfaced as a credit `valueLabel`, and the payload's `data.level` becomes `planLabel`. Web and VS Code must preserve these windows and stay in sync.
- Z.ai gift (bonus) resets come from a supplementary `GET https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL` with the same bearer token, fetched after a successful quota fetch. `expireTime` strings (`YYYY-MM-DD HH:mm:ss`) are parsed as UTC+8. Only `available: true` records with a numeric `recordId` and a parseable, non-expired `expireTime` are considered; the nearest expiry wins and is attached as `giftReset` (`{recordId, expireAt}`) on the window matching `windowSeconds` (`fiveHourResets` → 5h, `weekResets` → weekly). Expired records are never shown. The request is supplementary: any failure, non-ok response, or malformed payload leaves the quota result untouched with no `giftReset`. Activation goes through `POST /api/quota/:providerId/gift-reset/use` (z.ai aliases only), which posts `{targetType: 'PERSONAL', resetType, recordId, requestId: <uuid>}` to `https://api.z.ai/api/biz/customer-package-reset/use` (`resetType` is `'FIVE_HOUR'` for the 5h window and `'WEEK'` for the weekly window — the weekly value was verified live against a real weekly reset). Both runtimes must keep this in sync.

## NanoGPT subscription quota semantics

`GET https://nano-gpt.com/api/subscription/v1/usage` returns `dailyInputTokens`
and `weeklyInputTokens`, with fractional `percentUsed`, millisecond `resetAt`,
and total limits under `limits.dailyInputTokens` / `limits.weeklyInputTokens`.
The daily cap is optional. A null quota is omitted; a degraded quota remains
visible with unknown percentages. Legacy `daily` / `monthly` request windows
remain supported when current fields are absent. Keep the web provider and
`fetchNanoGptQuota` in `packages/vscode/src/quotaProviders.ts` in sync.
