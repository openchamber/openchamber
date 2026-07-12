# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/google/`: Google-specific auth, API, and transform modules.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.

## Supported provider IDs (dispatcher)

These provider IDs are currently dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`.

| Provider ID | Display name | Module | Auth aliases/keys |
| --- | --- | --- | --- |
| `claude` | Claude | `providers/claude.js` | `anthropic`, `claude` |
| `codex` | Codex | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `cursor` | Cursor | `providers/cursor.js` | `CURSOR_TOKEN` / `CURSOR_ACCESS_TOKEN`, `CURSOR_REFRESH_TOKEN`, optional token files, or Cursor desktop SQLite DB |
| `deepseek` | DeepSeek | `providers/deepseek.js` | `deepseek` (API key from `auth.json`) |
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
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | Cookie file at `~/.config/ollama-quota/cookie` (raw session cookie string) |
| `wafer` | Wafer.ai | `providers/wafer.js` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` |

## Internal-only provider module
- `providers/openai.js` exists for logic parity/reuse but is intentionally not registered for dispatcher ID routing.

## Response contract
All providers should return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional field: `error`
- Unsupported provider requests should return `ok: false`, `configured: false`, `error: Unsupported provider`

Provider modules must export `providerId`, `providerName`, `aliases`, `isConfigured(auth?)`, and `fetchQuota()`.
`fetchQuota()` should return a quota result with `usage.windows` keyed by window name (for example `5h`, `7d`, `daily`) and optional provider-specific `usage.models` data.

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

## Notes for contributors
- Keep provider IDs stable; clients use them directly.
- Avoid adding alias-based dispatch in `fetchQuotaForProvider`; dispatch currently expects exact provider IDs.
- Keep Google behavior changes isolated and review `providers/google/*` together.
