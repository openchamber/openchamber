# Quota Module Documentation

## Purpose

This module fetches quota and usage signals for supported providers in the web server runtime. It also manages provider credentials through a structured registry with validation, storage, legacy import discovery, and a managed Settings UI flow.

## Entrypoints and structure

- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/google/`: Google-specific auth, API, and transform modules.
- `packages/web/server/lib/quota/credentials/`: credential registry, schemas, store, and routes for managed Settings UI.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, formatting, redaction, and fetch helpers.

## Supported provider IDs

25 provider IDs are recognized across the dispatcher and credential registry. 24 are dispatchable via `fetchQuotaForProvider(providerId)`; one (`openai`) is credential-registry-only.

### Dispatcher-registered providers (24)

| Provider ID | Display name | Module | Auth method |
| --- | --- | --- | --- |
| `atlascloud` | AtlasCloud | `providers/atlascloud.js` | Credential registry |
| `byteplus` | BytePlus | `providers/byteplus.js` | Credential registry |
| `claude` | Claude | `providers/claude.js` | OpenCode auth.json (merged) |
| `codex` | Codex | `providers/codex.js` | OpenCode auth.json (single path) |
| `cursor` | Cursor | `providers/cursor.js` | Auto-discovered |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | Auto-discovered |
| `github-copilot-addon` | GitHub Copilot Add-on | `providers/copilot.js` | Auto-discovered |
| `google` | Google | `providers/google/index.js` | Auto-discovered |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | OpenCode auth.json (single path) |
| `longcat` | LongCat | `providers/longcat.js` | Credential registry |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` | OpenCode auth.json (single path) |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` | OpenCode auth.json (single path) |
| `mistral` | Mistral | `providers/mistral.js` | Credential registry |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | OpenCode auth.json + `nanogpt-keys.json` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | Credential registry |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | Credential registry |
| `openrouter` | OpenRouter | `providers/openrouter.js` | OpenCode auth.json (single path) |
| `poe` | Poe | `providers/poe.js` | OpenCode auth.json (merged) + `POE_API_KEY` env |
| `qwencloud` | QwenCloud | `providers/qwencloud.js` | Credential registry |
| `stepfun` | StepFun | `providers/stepfun.js` | Credential registry |
| `wafer` | Wafer.ai | `providers/wafer.js` | OpenCode auth.json (single path) |
| `xai` | xAI | `providers/xai.js` | OpenCode auth.json (merged) + `~/.grok/auth.json` |
| `zai-coding-plan` | z.ai | `providers/zai.js` | OpenCode auth.json (single path) |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | OpenCode auth.json (single path) |

### Credential-registry-only provider (1)

| Provider ID | Notes |
| --- | --- |
| `openai` | Accepted by the credential registry (`VALID_PROVIDER_IDS`) for manual auth storage but intentionally not registered in the dispatcher. `providers/openai.js` exists for logic parity/reuse. |

## Auth models

Providers use one of three auth models.

### Manual-credential providers (9)

These providers require credentials entered manually in Settings (Usage page, Credentials section) or imported from a legacy file. The credential registry stores them encrypted at rest, validates them against provider-specific schemas, and exposes sanitized records to the UI. Raw secrets are never returned to the client.

The 8 manual-credential providers and their required fields (from `credentials/schemas.js`):

| Provider ID | Required fields | Optional fields | Multi-account | Legacy file |
| --- | --- | --- | --- | --- |
| `atlascloud` | `cookie` (must contain `access-token=`) | `accountUuid` | No | `atlas-cookies.json` |
| `byteplus` | `cookie` (must contain `csrfToken=`) | | No | `byteplus-cookies.json` |
| `longcat` | `passportToken` OR `cookie` (must contain `passport_token_key=`) | `region` | No | `longcat-cookies.json` |
| `mistral` | `cookie` (must contain `csrftoken=`) | | Yes (`accounts[]`, each with `cookie`) | `mistral-cookies.json` |
| `ollama-cloud` | `cookie` (must contain `__Secure-session=`) | | No | `ollama-cookies.json` |
| `opencode-go` | `workspaceId` + `authCookie` | | Yes (`accounts[]`, each with `workspaceId` + `authCookie`) | `opencode-go.json` |
| `qwencloud` | `ticket`, `isg` | `aliyunPk`, `esmTicket` | No | `qwencloud-cookies.json` |
| `stepfun` | `oasisToken`, `oasisWebid` | `sessionToken` | No | `stepfun-cookies.json` |

### OAuth providers (auto-discovered from OpenCode auth)

These providers read credentials from OpenCode's auth files. No manual setup in Settings is needed; the provider is configured automatically when the user authenticates through OpenCode.

**`loadAuthMerged()`** reads across all candidate `auth.json` paths (XDG data home, opencode-multi profile dirs, `~/.local/share/opencode/auth.json`), keeping the freshest OAuth `expires` per provider key. Most OAuth providers use this. A few simpler providers use `readAuthFile()` which reads only the single canonical `~/.local/share/opencode/auth.json`.

| Provider ID | Auth keys in auth.json | Notes |
| --- | --- | --- |
| `claude` | `anthropic`, `claude` | Uses `loadAuthMerged()`; refreshes expired tokens via `https://console.anthropic.com/v1/oauth/token` |
| `codex` | `openai`, `codex`, `chatgpt` | Uses `readAuthFile()` |
| `github-copilot` / `github-copilot-addon` | `github-copilot`, `copilot` | Uses `readAuthFile()`; also checks `copilot-quota-token.json` (PAT fallback) |
| `kimi-for-coding` | `kimi-for-coding`, `kimi` | Uses `readAuthFile()` |
| `minimax-coding-plan` | `minimax-coding-plan` | Uses `readAuthFile()` |
| `minimax-cn-coding-plan` | `minimax-cn-coding-plan` | Uses `readAuthFile()` |
| `nano-gpt` | `nano-gpt`, `nanogpt`, `nano_gpt` | Uses `readAuthFile()` + `nanogpt-keys.json` multi-auth file |
| `openrouter` | `openrouter` | Uses `readAuthFile()` |
| `wafer` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` | Uses `readAuthFile()` |
| `xai` | `xai`, `xai-oauth` | Uses `loadAuthMerged()` for dev token; also reads `~/.grok/auth.json` for consumer SuperGrok token; refreshes via `https://auth.x.ai/oauth2/token` |
| `zai-coding-plan` | `zai-coding-plan`, `zai`, `z.ai` | Uses `readAuthFile()` |
| `zhipuai-coding-plan` | `zhipuai-coding-plan`, `zhipuai`, `zhipu` | Uses `readAuthFile()` |

### Auto-discovered providers

These providers discover credentials from well-known local paths without any manual setup.

| Provider ID | Discovery sources |
| --- | --- |
| `cursor` | `CURSOR_TOKEN` / `CURSOR_ACCESS_TOKEN` env vars, token files, or Cursor desktop SQLite DB |
| `google` | `google` / `google.oauth` keys in `readAuthFile()` (Gemini CLI); `antigravity-accounts.json` under `~/.config/opencode/` and `~/.local/share/opencode/` (Antigravity accounts) |

## Real endpoints per provider

| Provider ID | Endpoints / hosts |
| --- | --- |
| `atlascloud` | `https://console.atlascloud.ai/api/v1/current-user`, `/api/v1/codeplan/get`, `/api/v1/codeplan/costs` |
| `byteplus` | `https://console.byteplus.com` (cookie-authenticated API) |
| `claude` | `https://api.anthropic.com/api/oauth/usage`; token refresh: `https://console.anthropic.com/v1/oauth/token` |
| `codex` | `https://chatgpt.com/backend-api/wham/usage` |
| `github-copilot` | `https://api.github.com/copilot_internal/user`; token exchange: `https://api.github.com/copilot_internal/v2/token`; PAT path: `https://api.github.com/users/<username>/settings/billing/premium_request/usage` |
| `google` | `https://cloudcode-pa.googleapis.com` (quota buckets + models) |
| `longcat` | `https://longcat.chat` (API) |
| `minimax-coding-plan` | `https://api.minimax.io/v1/token_plan/remains` (M3, tried first); fallback: `https://api.minimax.io/v1/api/openplatform/coding_plan/remains` |
| `minimax-cn-coding-plan` | `https://api.minimaxi.com/v1/token_plan/remains`; fallback: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` |
| `mistral` | `https://console.mistral.ai` (cookie-authenticated API) |
| `nano-gpt` | `https://nano-gpt.com/api/check-balance` (POST); `https://nano-gpt.com/api/subscription/v1/usage` (GET) |
| `ollama-cloud` | `https://ollama.com/settings` (SSR HTML scrape); `https://ollama.com/settings/billing` (renewal, best-effort) |
| `opencode-go` | `https://opencode.ai/workspace/<workspaceId>/go` (Go quota); `/billing` (Zen balance); `/usage` (Zen per-model spend) |
| `poe` | `https://api.poe.com` (API key auth) |
| `qwencloud` | `https://home.qwencloud.com` (ticket-authenticated API) |
| `stepfun` | `https://platform.stepfun.ai` (oasis token auth) |
| `xai` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits`; `https://cli-chat-proxy.grok.com/v1/billing`; liveness: `https://api.x.ai/v1/models`; token refresh: `https://auth.x.ai/oauth2/token` |
| `zai-coding-plan` | `https://api.z.ai/api/monitor/usage/quota/limit`; `https://api.z.ai/api/biz/subscription/list` |

## Rich-card data model

`fetchQuota()` returns a result with a `usage` object. The `usage` object may carry:

- `windows`: object keyed by window name (e.g. `5h`, `7d`, `daily`, `rolling`, `weekly`, `credits`). Each window is built by `toUsageWindow()`.
- `subtitle`: short account or plan label shown under the provider name.
- `note`: brief plan note (e.g. `Unlimited plan`).
- `header[]`: array of strings shown above the usage bars (account info, plan name, auth status).
- `footer[]`: array of strings shown below the usage bars (subscription expiry, recent costs, payment info).
- `accounts[]`: multi-account usage. Each entry has `accountKey`, `label`, `subtitle`, `windows`, and optionally `header[]` / `footer[]`. Providers that emit `accounts[]`: `mistral`, `opencode-go`, `google` (Antigravity), `nano-gpt` (when multiple keys are configured).
- `models`: per-model quota data (Google provider).

Window-level fields from `toUsageWindow()`:

- `usedPercent`: 0-100 integer.
- `resetAt`: ISO timestamp or epoch ms when the window resets.
- `resetText`: human-readable countdown (e.g. `2d 4h`).
- `suffix`: short window label appended to the bar (e.g. `rolling 5h`, `7-day all models`).
- `detail[]`: lines shown inside the bar card (e.g. `Used: 120 / 300`).
- `extra[]`: additional context lines (e.g. overage count, billing period).
- `valueLabel`: replaces the numeric bar with a text value (e.g. plan name, dollar balance).
- `trendKey`: stable key used by the trend tracker.

## Stale-cache fallback and failure contract

- On retryable failures (429, 5xx after retry exhaustion, network errors, timeouts), providers that maintain an in-memory result cache return the last successful result with `isStale: true`.
- Auth failures (401, 403) and parse errors do **not** trigger cache fallback. A stale snapshot cannot confirm whether the credential is still valid.
- `fetchQuotaForProvider()` catches all provider errors and returns `ok: false` with an error message. It never propagates exceptions to callers.
- `listConfiguredQuotaProviders()` catches per-provider config errors and skips the provider silently.
- `isConfigured()` returns `false` when no credential is stored or required fields are missing. It never throws.
- No provider fabricates data. Every field in a successful result comes from a real API or SSR response.

## Credential redaction

All secrets are redacted before any data leaves the server. `utils/redact.js` provides `redactCookie`, `redactToken`, and `redactApiKey`. Each schema's `redact()` function applies these to its fields. The credential registry calls `redact()` before returning records to the UI or API routes.

## Managed Settings flow (credential registry)

The credential registry powers the Settings UI for manual-auth providers. The flow is:

1. **List**: `GET /api/quota/credentials` returns all stored credentials, sanitized (no raw secrets).
2. **Create**: `POST /api/quota/credentials` validates the credential against the provider schema, stores it, and returns the sanitized record.
3. **Update**: `PATCH /api/quota/credentials/:id` patches label, accountHint, or credential fields; re-validates on credential change.
4. **Delete**: `DELETE /api/quota/credentials/:id` removes the record.
5. **Validate**: `POST /api/quota/credentials/:id/validate` runs structural schema validation and updates `validationStatus` and `lastValidatedAt`.
6. **Discover**: `GET /api/quota/credentials/discover/:providerId` scans legacy cookie/config files and returns sanitized discovery metadata (file path and timestamp only, never raw secrets).
7. **Import**: `POST /api/quota/credentials/import/:providerId` reads a discovered legacy file and creates a credential record from it.

Provider schemas (`credentials/schemas.js`) define required fields, optional fields, a `validate()` function, a `redact()` function, `legacyFiles` for import discovery, and a `multiAccount` flag. Providers without a schema pass basic non-empty-object validation.

## Safe fallback and import behavior

- Legacy import discovery (`discoverCredentials`) reads files from `~/.config/opencode/` and `~/.local/share/opencode/`. It returns sanitized metadata only. If no file is found, it returns `null`. It never throws on missing files.
- Importing a legacy file creates a new credential record. It does not overwrite existing records for the same provider.
- Providers with `legacyFiles: []` in their schema skip discovery entirely and return `null`.

## Response contract

All providers return results via shared helpers to preserve API shape:

- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional field: `error`
- Unsupported provider requests return `ok: false`, `configured: false`, `error: Unsupported provider`

Provider modules must export `providerId`, `providerName`, `aliases`, `isConfigured(auth?)`, and `fetchQuota()`.

## Non-goals

- This module does not manage OpenCode provider configuration (API keys, model selection). That belongs to the OpenCode config system.
- This module does not authenticate users to the OpenChamber UI. That belongs to `packages/web/server/lib/ui-auth/`.
- This module does not expose raw credential secrets to the client at any point. Redaction is enforced in `credentials/registry.js` and `credentials/store.js`.
- This module does not support TUI or CLI quota display. The `mystatus` CLI tool reads quota independently.
- This module does not validate that credentials work against the live provider API. `validationStatus` reflects structural schema validation only.

## Add a new provider (quick steps)

1. Choose module shape based on complexity:
   - Simple providers: create `packages/web/server/lib/quota/providers/<provider>.js`.
   - Complex providers (multi-source auth, multiple API calls, non-trivial transforms): create `packages/web/server/lib/quota/providers/<provider>/` with split modules like Google (`index.js`, `auth.js`, `api.js`, `transforms.js`).
2. Export `providerId`, `providerName`, `aliases`, `isConfigured`, and `fetchQuota`.
3. Use shared helpers from `packages/web/server/lib/quota/utils/index.js` (`buildResult`, `toUsageWindow`, auth/conversion helpers) to keep payload shape consistent.
4. Register the provider in `packages/web/server/lib/quota/providers/index.js`.
5. Add the provider ID to `VALID_PROVIDER_IDS` in `packages/web/server/lib/quota/credentials/registry.js`.
6. If the provider uses manual auth, add a schema to `packages/web/server/lib/quota/credentials/schemas.js` and register it in `PROVIDER_CREDENTIAL_SCHEMAS`.
7. If needed for direct use, export a named fetcher from `packages/web/server/lib/quota/providers/index.js` and `packages/web/server/lib/quota/index.js`.
8. Update this file with the new provider ID, module path, auth method, and alias/auth details.
9. Validate with `bun run type-check`, `bun run lint`, and `bun run build`.

## MiniMax M3 / Token Plan migration

In 2025/2026 MiniMax rebranded "Coding Plan" to "Token Plan" alongside the M3 model release. The API underwent breaking changes:

- **Endpoint fallback**: The provider tries `/v1/token_plan/remains` (M3) first, falling back to legacy `/v1/api/openplatform/coding_plan/remains`.
- **Field semantics**: On the `token_plan/remains` endpoint, `current_interval_usage_count` returns **remaining** quota (not consumed). The provider computes `used = total - remaining` for this endpoint. The legacy `coding_plan/remains` endpoint retains the old semantics (`usage_count = consumed`).
- **Percentage-based plans**: Legacy Coding Plan accounts return `current_interval_total_count: 0` but include `current_interval_remaining_percent`. The provider prefers this field when count fields are absent.
- **model_remains array**: Now contains entries for multiple model categories (chat, speech, video, image). The provider selects the chat-model entry by matching `MiniMax-M*`, then `general`/`chat`/`text` by name, then any entry with a remaining percent.
- **Window status**: The `current_interval_status` and `current_weekly_status` fields indicate whether a window is active. Status `3` means the window is not applicable for the current plan tier (e.g. legacy plans without weekly limits). The provider omits inactive windows.

## Notes for contributors

- Keep provider IDs stable; clients use them directly.
- Avoid adding alias-based dispatch in `fetchQuotaForProvider`; dispatch currently expects exact provider IDs.
- Keep Google behavior changes isolated and review `providers/google/*` together.
- When adding a credential-registry provider, always add schema validation and a test file alongside the provider module.
- Redact all secrets before returning data to the client. Use helpers from `utils/redact.js`.
- OAuth providers (openai, anthropic, google, zai, xai, minimax, etc.) must never be added to `PROVIDER_CREDENTIAL_SCHEMAS` in `credentials/schemas.js`. They authenticate through OpenCode auth.json, not user-supplied credentials.
