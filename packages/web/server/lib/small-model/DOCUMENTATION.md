# Small Model

Server-side direct LLM calls that reuse the user's existing OpenCode provider
logins (`~/.local/share/opencode/auth.json`). OpenCode uses a "small model"
internally (titles, summaries) but does not expose it through the SDK or
plugins — this module replicates that mechanism as an OpenChamber runtime API.

## Security boundary

Credentials never leave the server process. The client sends only a prompt;
auth resolution, OAuth refresh, and provider dispatch all happen server-side.
Routes live under `/api/*` and are gated by the ui-auth middleware like every
other runtime API.

## Files

- `index.js` — orchestration: `generateSmallModelText()` / `describeSmallModel()`.
- `resolve.js` — model selection, mirroring OpenCode's `getSmallModel` chain:
  0. OpenChamber's own settings override (Settings → Sessions → Small Model):
     when `smallModelUseDefault` is `false`, `smallModelOverride`
     (`provider/model`) outranks everything below. Sanitized in
     `settings-helpers.js` (server), `persistence.ts` (client), and
     `bridge-settings-runtime.ts` (VS Code).
  1. `small_model` from the merged OpenCode config layers (`provider/model`).
  2. Family-priority scan (`gemini-flash` → `gpt-nano` → `claude-haiku`)
     **within the session's provider first** (`preferredProviderID`, like
     OpenCode resolves within the current provider), then over the other
     providers with a usable auth entry, newest `release_date` first.
  3. GitHub Copilot hidden utility models (`gpt-*-nano/mini`) — these never
     appear in the catalog, so they participate as the `gpt-nano` family entry
     and as a final utility fallback.
  4. Last resort: the session's own model (`preferredModelID`) when no small
     model resolves anywhere — costlier, but always valid.
- Input clamp: the prompt is truncated to the resolved model's catalog
  `limit.context` (minus an output reserve, ~4 chars/token estimate;
  conservative default when the model is not in the catalog). Truncation is
  reported as `inputTruncated: true` in the response.
- `call.js` — wire formats and per-provider auth, replicating OpenCode's
  plugin auth loaders:
  - **GitHub Copilot**: OpenAI-compatible `/chat/completions` on
    `https://api.githubcopilot.com` (or `copilot-api.<enterprise>`) with the
    stored device-OAuth token as the bearer — no token exchange, no expiry.
  - **OpenAI OAuth (ChatGPT plan)**: streaming Responses API on
    `https://chatgpt.com/backend-api/codex/responses` with
    `ChatGPT-Account-Id`; expired tokens are refreshed against
    `auth.openai.com` (single-flight) and written back to `auth.json`.
  - **Anthropic** (`type: api`): `/v1/messages` with `x-api-key`.
  - **Google** (`type: api`): `generateContent` with `x-goog-api-key`; Gemini 3
    uses `thinkingLevel` while older Flash models use `thinkingBudget: 0`.
  - Everything else: OpenAI-compatible `/chat/completions` against the
    provider's base URL, resolved from (1) `provider.<id>.options.baseURL`
    in the OpenCode config, (2) the hardcoded `https://api.openai.com/v1`
     endpoint, or (3) the provider's `api` field from the models.dev catalog.
    Configured API keys honor OpenCode's `{env:NAME}` and `{file:path}`
    substitutions; file contents and resolved credentials remain server-side.
  - `[small-model:diagnostic]` logs record provider/model, input character
    counts, output budget, thinking toggle, HTTP/finish status, and
    content/reasoning lengths without logging prompts, response text, or
    credentials. Goal audit parsing similarly emits
    `[session-goal:diagnostic]` structural verdict metadata.
- `catalog.js` — models.dev catalog via the shared in-process cache
  (`../opencode/models-metadata.js`, also serving
  `/api/openchamber/models-metadata`).
- `routes.js` — `GET /api/small-model` (resolution preview) and
  `POST /api/small-model/generate` (`{ prompt, system?, maxOutputTokens?,
  model?, directory? }` → `{ text, providerID, modelID, source }`).

## Registration

Mounted lazily from `feature-routes-runtime.js` (same pattern as quota): the
module is imported on first request, not at server startup.

## Known limitations

- OpenCode's free models (`opencode/big-pickle`, `*-free`) work without a
  token only through OpenCode's own server — direct calls are rejected, and
  piggybacking on their subsidized infra is out of bounds by design. Every
  resolution step therefore requires a usable auth entry for the provider:
  a session on an unauthenticated `opencode` provider falls through to the
  global scan (or a clean 404 on a vanilla setup with no logins).

- Anthropic OAuth (Claude Pro/Max) entries are not supported — OpenCode itself
  keeps those outside `auth.json` in this generation; only `type: api` keys
  work for Anthropic.
- Amazon Bedrock, GitLab, Azure and other credential-chain providers are out
  of scope; they need more than a key/token (regions, resource names).
- Responses from the codex backend are collected from the SSE stream; the
  endpoint itself is non-streaming by design (small utility calls).
