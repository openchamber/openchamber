# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

Node server entrypoints apply `../network-defaults.js` before serving requests,
including the daemon launched directly through `server/index.js`. Connection
attempts get 5 seconds without changing address-family selection. The VS Code
extension applies the same policy in its own process at activation.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
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
| `claude` | Claude | `providers/claude/` | Claude Code Keychain entry, Claude Code credentials file, OpenCode `auth.json` (`anthropic`, `claude`), `CLAUDE_CODE_OAUTH_TOKEN` |
| `cline-pass` | ClinePass | `providers/cline-pass.js` | `cline-pass` (API key under `key` or `token`) |
| `codex` | Codex | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `command-code` | Command Code | `providers/command-code.js` | `command-code` OAuth/API credential in OpenCode `auth.json`, or `COMMAND_CODE_API_KEY` |
| `cursor` | Cursor | `providers/cursor.js` | Environment/token files, OpenChamber-managed credentials, or explicit one-time Cursor import |
| `deepinfra` | DeepInfra | `providers/deepinfra.js` | `deepinfra`, `deep-infra`, `deep_infra` (API key under `key` or `token`) |
| `deepseek` | DeepSeek | `providers/deepseek.js` | `deepseek` (API key under `key` or `token`) |
| `exe-dev` | exe.dev | `providers/exe-dev.js` | Usage API token stored under `~/.config/openchamber/quota/` |
| `google` | Google | `providers/google/index.js` | `google`, `google.oauth`, Antigravity accounts file |
| `hyper` | Charm Hyper | `providers/hyper.js` | `hyper` (API key under `key` or `token`) |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | `github-copilot`, `copilot` |
| `github-copilot-addon` | GitHub Copilot Add-on | `providers/copilot.js` | `github-copilot`, `copilot` |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | `kimi-code-plan-cn`, `kimi-for-coding`, `kimi`, `kimi-code-plan-global` (first match wins) |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | `nano-gpt`, `nanogpt`, `nano_gpt` |
| `openrouter` | OpenRouter | `providers/openrouter.js` | `openrouter` |
| `zai-coding-plan` | z.ai | `providers/zai.js` | `zai-coding-plan`, `zai`, `z.ai` |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | `zhipuai-coding-plan`, `zhipuai`, `zhipu`; falls back to `provider.<alias>.options.apiKey` in opencode.json, resolving `{file:...}` (including `~/`) and `{env:...}` with `resolveConfigApiKey` (`utils/auth.js`) |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` / `providers/minimax-shared.js` | `minimax-coding-plan` |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` / `providers/minimax-shared.js` | `minimax-cn-coding-plan` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | `ollama-cloud` / `ollamacloud` API key from OpenCode's credential store |
| `wafer` | Wafer.ai | `providers/wafer.js` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | `opencode-go` API key from OpenCode `auth.json`, or an OpenCode Console OAuth sign-in on the shared `opencode` integration |
| `neuralwatt` | NeuralWatt | `providers/neuralwatt.js` | `neuralwatt` (API key under `key` or `token`) |
| `kilo` | Kilo Code | `providers/kilo.js` | `kilo`, `kilocode`, `kilo-code` (API key under `key`, `token`, or OAuth `access`; organization id under `kilocodeOrganizationId`, `organizationId`, or OAuth `accountId`, else OpenCode `provider.kilo.options.kilocodeOrganizationId`) |
| `zenmux` | ZenMux | `providers/zenmux.js` | Optional Platform API key stored under `~/.config/openchamber/quota/zenmux.json` (`platformApiKey`). The OpenCode chat key is not used. |
| `xai` | xAI | `providers/xai.js` | `xai` OAuth entry in OpenCode `auth.json` |

## Internal-only provider module
- `providers/openai.js` exists for logic parity/reuse but is intentionally not registered for dispatcher ID routing.

## Response contract
All providers should return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional field: `error`
- Unsupported provider requests should return `ok: false`, `configured: false`, `error: Unsupported provider`

Provider modules must export `providerId`, `providerName`, `aliases`, `isConfigured(auth?)`, and `fetchQuota()`.
`fetchQuota()` should return a quota result with `usage.windows` keyed by window name (for example `5h`, `7d`, `daily`) and optional provider-specific `usage.models` data.

exe.dev, Cursor, and ZenMux credentials are explicitly managed through Settings. exe.dev usage uses a separately generated HTTPS API token restricted to `billing credits usage` and aggregates every `exe-*` model provider into one monthly credit window. Generate the token with `ssh exe.dev "ssh-key generate-api-key --label=openchamber --exp=30d --cmds='billing credits usage'"`. ZenMux usage uses an optional Platform API key pasted on the Usage page; the OpenCode chat key is never used, and a missing Platform API key means ZenMux quota is not fetched. The server validates managed credentials before atomic `0600` writes and never returns secrets through its API. OpenChamber never scans browser cookie stores or automatically reads Cursor storage; Cursor import is an explicit one-time user action and never modifies Cursor's database.

Command Code usage resolves account scope through `GET /alpha/whoami`, then reads server-backed credit balances and five-hour/weekly limits from `GET /alpha/billing/credits?orgId=...`. Personal accounts return `org: null` and use `/alpha/billing/credits` without an `orgId`; organization accounts include their organization id. Web/Electron and VS Code read the standard `command-code` OpenCode auth entry (including OAuth `access`) or `COMMAND_CODE_API_KEY`; credentials remain in the owning runtime and are never returned to shared UI.

## OpenCode Go credential and quota semantics

OpenCode Go has two credential shapes and they are not interchangeable. A service-account key stored under the `opencode-go` integration is a bearer token for `GET https://opencode.ai/zen/go/v1/usage` with the stable `x-opencode-session: openchamber-usage` workload id. A Console sign-in lives on the shared `opencode` integration as OAuth; its access token is a user session, not that key, and it is sent to `GET https://opencode.ai/console/api/go/status` with `x-org-id: <selected organization ID>`. That status endpoint is what the current Console Go page itself reads; it is not publicly documented, so re-check it against the live Console page before assuming it is still current.

- **Credential selection**: OpenCode marks exactly one credential active per integration and credentials are global, so the active `opencode` OAuth credential is the selected account and organization. The reader carries only the Console `server` and `orgID` metadata; a credential whose `server` is not `https://opencode.ai/console`, whose `orgID` is missing or malformed, or that is an API key does not count as a Console sign-in. When both exist, the Console sign-in serves Go and the `opencode-go` key is the fallback, both when there is no Console sign-in and when the Console read fails; the Console error surfaces only when there is no key.
- **Read-only and per-call**: the access token is read through `../opencode/auth.js` on every fetch, so switching accounts drops the previous account instead of showing stale numbers. OpenChamber never refreshes the token itself: OpenCode owns that, and an expired access token (local `expires`, or a 401/403) is surfaced as "sign in again" rather than a competing refresh.
- **Meters**: the response's `product` must be `go` or `go-plus`; anything else is an absent subscription. `access.meters.fiveHour` / `week` / `month` map to the existing `5h` / `weekly` / `monthly` windows. `limitMicroCents` and `usedMicroCents` are decimal strings; the percentage is `used / limit`, never a hardcoded plan limit. A missing meter, a non-positive or unparseable limit, or an invalid reset timestamp skips that window alone; no usable window is a failed refresh, not zero usage.
- **Trusted origin**: requests go only to the fixed Console status URL with `redirect: 'error'`, so the bearer token is never forwarded to another origin.
- **Failure classes stay distinct**: not configured (no credential), expired sign-in (expired local token or 401/403), absent subscription (unexpected `product`), malformed response, and temporary request failure each return their own configured flag and message.
- Keep `packages/web/server/lib/quota/providers/opencode-go.js` and `packages/vscode/src/opencodeGoQuota.ts` in sync — the VS Code extension duplicates this logic rather than importing the web provider.

On the first OpenCode Go usage refresh after upgrading, OpenChamber deletes the obsolete `quota/opencode-go.json` credential file without reading its cookie value.

## Codex credit balance semantics

Codex `credits.balance` is an OpenAI credit count, not a dollar amount. Web/Electron and VS Code expose it as a plain numeric `credits_balance.valueLabel` under the UI's localized Credits Balance title, without a currency symbol or two-decimal money rounding. Numeric strings are accepted; zero, unlimited, and unavailable balances retain their existing handling. Keep `providers/codex.js` and `packages/vscode/src/quotaProviders.ts` in sync. The separate business-account `spend_control.individual_limit` window is unchanged.

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

## Ollama Cloud API-key shapes

Ollama Cloud usage comes from `GET https://ollama.com/api/usage` with the same
Ollama Cloud API key OpenCode stores for chat requests, authenticated as
`Authorization: Bearer <key>`. Nothing is pasted into Settings, and the tracker
follows the account OpenCode has active because the key is read per request from
the active credential row. The endpoint is undocumented and its shape has
moved repeatedly: separate `session` and `weekly` buckets, then a single
`monthly` one, then back again. `toUsageWindows` requires `limits` to be a plain
object, maps whichever buckets are present rather than a fixed key, and
validates a bucket on its own, so a shape change costs only the bucket it
changed and cannot silently empty the tracker; `usage` is a 0..1 fraction of the
allowance, accepted as a number or a numeric string and clamped to 100. The
response carries no allowance amount, so there is no money label: a cost-based
plan reads as a percentage. An obsolete
`quota/ollama-cloud.json` (or the per-account directory an unreleased
development build wrote) is deleted on the first refresh without being read,
mirroring the OpenCode Go cleanup. Keep `packages/web/server/lib/quota/providers/ollama-cloud.js`
and `packages/vscode/src/quotaProviders.ts` (`fetchOllamaCloudQuota`) in sync —
the VS Code extension duplicates this parsing logic rather than importing it,
and the two must agree on all of it.

## GitHub Copilot quota semantics

GitHub Copilot usage exposes only the `premium_interactions` snapshot as the
`premium_interactions` window. Shared UI labels that window **AI Credits** and treats it as
the provider's primary usage marker. Legacy chat-request quota and unlimited
completion quota are intentionally omitted. Keep
`packages/web/server/lib/quota/providers/copilot.js` and
`packages/vscode/src/quotaProviders.ts` in sync.

The `/copilot_internal/user` endpoint is undocumented; its quota semantics mirror
what `microsoft/vscode-copilot-chat` consumes (`CopilotUserQuotaInfo`). Each
snapshot carries `entitlement`, `remaining`, `unlimited`, and
`percent_remaining`. Providers must honor these rules:

- `unlimited: true` renders a percent-less window with an "Unlimited" value label.
- Percent math requires a positive `entitlement`; entitlements of `0`, `-1`, or null are unusable.
- When entitlement/remaining are unusable, fall back to `100 - percent_remaining`.
- Snapshots other than `premium_interactions` (legacy annual plans) yield zero windows.

## OpenRouter key semantics

OpenRouter quota reads `GET <base>/key`, where `<base>` is the provider's configured `baseURL` (`settings.baseURL`, legacy `options.baseURL`, or legacy `api`, folded by `toProviderEntity`; the v2 `providers.openrouter` entry wins, and the v1 `provider.openrouter` entry is read when the v2 one sets no address) read from the merged opencode config layers; with nothing configured or a config read failure, `<base>` falls back to `https://openrouter.ai/api/v1`. A gateway user's key is only valid against that gateway, so the usage lookup must ride the same base as chat. The default endpoint `GET https://openrouter.ai/api/v1/key` is documented as callable with any valid API key. `GET /api/v1/credits` is documented as "Management key required" and is not used. Calling `/credits` with a normal inference key has been observed to return HTTP 200 with `{total_credits:0, total_usage:0}` rather than an error; this behavior is not documented and is why the old implementation silently rendered "$0.00 left · $0.00 spent". A `/credits` fallback for unlimited keys would render the same zeros, so unlimited keys report `usage_monthly` instead.

The documented `limit`, `limit_remaining`, and `limit_reset` fields are present and null on unlimited keys; null means unlimited, never missing data. For a limited key, window usage is `limit - limit_remaining`, not `usage`: `usage` is all-time and measures a different axis from the current reset window. Pairing `usage` with the current limit produces a wrong number. `limit_remaining` is server-computed and already honors `include_byok_in_limit`, so `byok_*` fields are ignored.

Unlimited keys report `usage_monthly` in a `monthly` window with no percent. `limit_reset` is a period string (`daily`, `weekly`, `monthly`, or null), not a timestamp; `resetAt` is derived from the documented midnight-UTC boundaries, with weeks starting Monday. A set `limit` with a null `limit_reset` is a lifetime cap and maps to the `credits` window with no reset.

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
