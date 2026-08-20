# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/google/`: Google-specific auth, API, and transform modules.
- `packages/web/server/lib/quota/providers/claude/`: Claude credential discovery, usage transforms, and rate-limit handling.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.

## Supported provider IDs (dispatcher)

These provider IDs are currently dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`.

| Provider ID | Display name | Module | Auth aliases/keys |
| --- | --- | --- | --- |
| `claude` | Claude | `providers/claude/` | Claude Code Keychain entry, Claude Code credentials file, OpenCode `auth.json` (`anthropic`, `claude`), `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | Codex | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `command-code` | Command Code | `providers/command-code.js` | `command-code` OAuth/API credential in OpenCode `auth.json`, or `COMMAND_CODE_API_KEY` |
| `cursor` | Cursor | `providers/cursor.js` | Environment/token files, OpenChamber-managed credentials, or explicit one-time Cursor import |
| `crof` | CrofAI | `providers/crof.js` | `crof` (API key under `key` or `token`) |
| `deepseek` | DeepSeek | `providers/deepseek.js` | `deepseek` (API key under `key` or `token`) |
| `google` | Google | `providers/google/index.js` | `google`, `google.oauth`, Antigravity accounts file |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | `github-copilot`, `copilot` |
| `github-copilot-addon` | GitHub Copilot Add-on | `providers/copilot.js` | `github-copilot`, `copilot` |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | `kimi-for-coding`, `kimi` |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | `nano-gpt`, `nanogpt`, `nano_gpt` |
| `openrouter` | OpenRouter | `providers/openrouter.js` | `openrouter` |
| `zai-coding-plan` | z.ai | `providers/zai.js` | `zai-coding-plan`, `zai`, `z.ai` |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | `zhipuai-coding-plan`, `zhipuai`, `zhipu` |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` / `providers/minimax-shared.js` | `minimax-coding-plan` |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` / `providers/minimax-shared.js` | `minimax-cn-coding-plan` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | Manual cookie stored under `~/.config/openchamber/quota/` |
| `wafer` | Wafer.ai | `providers/wafer.js` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | `opencode-go` API key from OpenCode `auth.json` |
| `neuralwatt` | NeuralWatt | `providers/neuralwatt.js` | `neuralwatt` (API key under `key` or `token`) |
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

Ollama Cloud and Cursor credentials are explicitly managed through Settings. OpenCode Go usage uses `GET https://opencode.ai/zen/go/v1/usage` with the `opencode-go` API key from OpenCode `auth.json` as a bearer token. The server validates managed credentials before atomic `0600` writes and never returns secrets through its API. OpenChamber never scans browser cookie stores or automatically reads Cursor storage; Cursor import is an explicit one-time user action and never modifies Cursor's database.

Command Code usage resolves account scope through `GET /alpha/whoami`, then reads server-backed credit balances and five-hour/weekly limits from `GET /alpha/billing/credits?orgId=...`. Personal accounts return `org: null` and use `/alpha/billing/credits` without an `orgId`; organization accounts include their organization id. Web/Electron and VS Code read the standard `command-code` OpenCode auth entry (including OAuth `access`) or `COMMAND_CODE_API_KEY`; credentials remain in the owning runtime and are never returned to shared UI.

On the first OpenCode Go usage refresh after upgrading, OpenChamber deletes the obsolete `quota/opencode-go.json` credential file without reading its cookie value.

## Claude credential and limit semantics

Claude quota reports the subscription limits Claude Code itself is bound by, read from `GET https://api.anthropic.com/api/oauth/usage`.

- **Credential sources**, in priority order: the macOS Keychain entry `Claude Code-credentials`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` (the Linux/WSL location), then the OpenCode `auth.json` entry, then `CLAUDE_CODE_OAUTH_TOKEN`. The Keychain wins on macOS because the credentials file there is a leftover Claude Code no longer updates.
- **All sources are read-only.** OpenChamber never writes to Claude Code's credential store and never refreshes the OAuth token, because Anthropic does not support two live refresh tokens for one `client_id` — refreshing here would sign the user out of Claude Code. Credentials are read fresh per request so a Claude Code refresh is picked up immediately; an expired token yields an explicit "open Claude Code to sign in again" error rather than a bare 401.
- **Limits come from the `limits` array**, keyed by `kind`: `session` maps to the `5h` window, `weekly_all` to `7d`, and `weekly_scoped` to a per-model `7d` window named by `scope.model.display_name`. The legacy `five_hour`/`seven_day` fields are only a fallback; `seven_day_sonnet`/`seven_day_opus` are no longer populated by Anthropic. Unrecognized limit kinds and Anthropic's rotating internal code names (`nimbus_quill`, `tangelo`, ...) are ignored rather than guessed at.
- **Extra usage** is reported as the `extra_usage` window from `spend`, only while `spend.enabled` is true, with a money `valueLabel`.
- **Rate limiting**: Anthropic returns 429 aggressively. The last successful usage payload is cached in memory and reserved during a cooldown (`Retry-After`, else five minutes, capped at one hour). The cache is keyed by a hash of the access and refresh tokens, so switching accounts drops it instead of showing the previous account's numbers.
- **Runtime parity**: Web/Electron and VS Code preserve the last successful Claude values during the same bounded 429 cooldown. Quota dispatchers also coalesce concurrent refreshes for the same provider in each runtime, while requests for different providers remain parallel.

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

## Kimi for Coding field semantics

`GET https://api.kimi.com/coding/v1/usages` is inconsistent about which field carries consumption:
- The weekly `usage` block returns `used` (consumed) with no `remaining` field.
- Each `limits[].detail` rate-limit block returns `remaining` (available) with no `used` field.

The provider computes `usedPercent` from whichever of `used`/`remaining` is present (`used` takes precedence when both exist) rather than assuming one field name. Both `packages/web/server/lib/quota/providers/kimi.js` and `packages/vscode/src/quotaProviders.ts` (`fetchKimiQuota`) must stay in sync — the VS Code extension duplicates this parsing logic rather than importing it.

## Notes for contributors
- Keep provider IDs stable; clients use them directly.
- Avoid adding alias-based dispatch in `fetchQuotaForProvider`; dispatch currently expects exact provider IDs.
- Keep Google behavior changes isolated and review `providers/google/*` together.
- Z.ai Coding Plan exposes separate 5-hour and weekly `TOKENS_LIMIT` entries plus a monthly `TIME_LIMIT` for MCP tools; web and VS Code must preserve all three windows.
