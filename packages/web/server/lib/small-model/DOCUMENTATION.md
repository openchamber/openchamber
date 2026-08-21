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
- `runtime-providers.js` — provider state that exists only inside the running
  OpenCode process. A plugin registers its provider from the `config` hook and
  supplies the credential from its `auth` loader, so neither reaches
  `opencode.json` nor `auth.json`; `GET /provider` is the only place they
  become visible. The module caches one snapshot (30s TTL, shared in-flight
  request) and answers `null` — never an empty provider list — when OpenCode is
  unreachable, so a momentary outage cannot retract providers. It is wired once
  from `server/index.js` and reset on OpenCode restart, which reloads plugins
  and can move their ports and keys.
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
- Input clamp: the prompt is measured against the resolved model's catalog
  `limit.context` (minus an output reserve, ~4 chars/token estimate;
  conservative default when the model is not in the catalog). `onOverflow`
  decides what an oversized prompt means:
  - `truncate` (default) clips the tail and reports `inputTruncated: true`.
    Correct for callers that degrade gracefully (summaries, commit messages).
  - `error` throws a `413` with `code: 'context-too-small'` plus
    `requiredChars`/`availableChars`. Correct for callers whose output would be
    quietly wrong on a clipped input, so they can ask the user for a roomier
    model instead of returning confident nonsense.
- Structured output: pass `responseSchema` (a JSON Schema) to get
  schema-shaped JSON back as `text`. Wire support differs per format —
  `response_format: {type: 'json_schema'}` for OpenAI-compatible chat,
  `text.format` for the Responses API, a forced single tool call for the
  Anthropic messages API, and `generationConfig.responseSchema` for Google
  (whose OpenAPI-flavored dialect drops unknown JSON Schema keywords). The
  ChatGPT-plan codex backend has no equivalent and rejects a schema request
  with `code: 'structured-output-unsupported'` rather than silently returning
  prose.
- Output budget: `maxOutputTokens` is capped at the catalog's `limit.output` for
  the model, and the **same number** is reserved from the input allowance. The
  two must not drift — a caller that asks for a large answer while the reserve
  stays at the default overruns the context, and the failure looks like a
  truncation bug rather than a budgeting one. `describeSmallModel` takes
  `outputReserveTokens` so readiness checks agree with what generation will do.
  It may be a **function** of `{ contextTokens, outputTokenLimit }` for callers
  that want as much answer room as the resolved model allows — they cannot name
  a number before knowing which model they got. The resolved value comes back as
  `outputTokens`, which is what the caller should then request, so the reserve
  and the request are the same number by construction.
- Reasoning models can spend the entire output budget thinking and return
  nothing. That case (empty content with `finish_reason: 'length'`, or content
  empty while `reasoning_content` is populated) throws with
  `code: 'output-exhausted'` so callers can offer a different model instead of
  showing a transport error.
- `timeoutMs` overrides the 60s default per call; `signal` lets a caller abort
  a request that is no longer wanted. Both apply to every wire format.
- `describeSmallModel()` additionally reports `inputCharBudget`,
  `contextTokens`, `contextKnown`, `structuredOutput`, and `hasLogin`. The last
  is whether the resolved provider has a usable credential (`auth.json` or
  config `provider.<id>.options.apiKey`) — settings/config overrides can name a
  provider with none, and callers such as the walkthrough refuse before the
  request. `structuredOutput` is tri-state: `true`/`false` from the catalog,
  `null` when the catalog omits the field — which it does for roughly half of
  all models, aggregators and proxies especially. Callers must treat `null` as
  "try it", not "unsupported".
- Missing credentials throw with `statusCode: 401` and
  `code: 'no-provider-login'` rather than a bare `Error`, so UI callers can show
  a blocker instead of a raw 500 message.
- `call.js` — wire formats and per-provider auth, replicating OpenCode's
  plugin auth loaders:
  - **GitHub Copilot**: fetches the requested model's authenticated `/models`
    metadata from `https://api.githubcopilot.com` (or
    `copilot-api.<enterprise>`) and honors its advertised endpoint, preferring
    Anthropic-compatible `/v1/messages`, then OpenAI `/responses`, then
    `/chat/completions`. Models without `supported_endpoints` retain the legacy
    Chat Completions default; metadata, missing-model, and unsupported-endpoint
    failures are surfaced instead of guessing. The stored device-OAuth token is
    used as the bearer with no token exchange or expiry.
  - **OpenAI OAuth (ChatGPT plan)**: streaming Responses API on
    `https://chatgpt.com/backend-api/codex/responses` with
    `ChatGPT-Account-Id`; expired tokens are refreshed against
    `auth.openai.com` (single-flight) and written back to `auth.json`.
  - **Anthropic** (`type: api`): `/messages` with `x-api-key`, against
    `provider.anthropic.options.baseURL` when configured (used as-is, matching
    `@ai-sdk/anthropic` — no `/v1` is inserted) or `https://api.anthropic.com/v1`
    otherwise.
  - **Google** (`type: api`): `generateContent` with `x-goog-api-key`; Gemini 3
    uses `thinkingLevel` while older Flash models use `thinkingBudget: 0`.
  - Everything else: OpenAI-compatible `/chat/completions` against the
    provider's base URL, resolved from (1) `provider.<id>.options.baseURL`
    in the OpenCode config, (2) the hardcoded `https://api.openai.com/v1`
     endpoint, (3) the endpoint OpenCode resolved at runtime, or (4) the
    provider's `api` field from the models.dev catalog. The credential follows
    the same shape: config `options.apiKey`, then the runtime credential, then
    the auth.json entry. Configured API keys honor OpenCode's `{env:NAME}` and
    `{file:path}` substitutions; file contents and resolved credentials remain
    server-side.
  - The runtime credential is refused for providers listed in
    `OWN_CREDENTIAL_HANDLING`. Their branches need the stored entry rather than
    a bearer token: the clearest case is the ChatGPT-plan `openai` login, whose
    runtime `options.apiKey` is an OAuth access token that `api.openai.com`
    answers with 401.
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

## Which providers the pickers may offer

`listAuthenticatedProviders()` answers one question for the Small Model and
Changes Walkthrough pickers alike: which providers can this module actually
call. One rule decides it, applied the same way to every provider — **a
credential we are allowed to use, and an endpoint to send it to.** The
auth.json scan as before, plus the credential and endpoint OpenCode resolved
for a plugin provider.

**opencode zen is excluded without a real login.** When the user has no zen
credential, OpenCode substitutes the sentinel `options.apiKey = "public"` and
trims its catalog to the free models. Those run on OpenCode's own subsidised
infrastructure and are meant to be reached through OpenCode, so the sentinel is
never accepted as a credential — see `ZEN_ANONYMOUS_API_KEY`.

### Why there is no capability probe

A plugin may implement its whole integration inside `options.fetch` —
rewriting the path, signing the request, translating the payload — and OpenCode
cannot serialise a function. Such a provider advertises an ordinary base URL
that answers nothing we know how to ask, and no reported field distinguishes it
from a plain one.

Asking the endpoint (`GET /models`) does identify that case correctly. It was
measured against all 166 providers carrying an `api` URL in the models.dev
catalog, and it also denies six of them — `cloudflare-workers-ai`,
`infomaniak`, `iflowcn`, `inference`, `kuae-cloud-coding-plan`,
`thinkingmachines` — which work fine and simply have no `/models` route. At a
3.6% false-negative rate on providers known to work, the probe removes more
working models from the picker than broken ones, and a provider that silently
vanishes explains nothing while one that fails on use says why.

So availability stops at credential and endpoint, and the protocol verdict is
left to the call. A provider whose protocol lives in a plugin's `fetch` stays
selectable and fails when used — which is what it did before this resolution
existed.

Claude Code is refused unconditionally. A plugin can publish an
OpenAI-compatible endpoint for it, but that endpoint is a façade over the
Claude Agent SDK, which spawns the Claude Code CLI per request and spends the
user's Claude subscription rate limit. Paying that for a session title or a
summary is the wrong trade, so an available endpoint does not lift the
refusal — the cost is the reason, not the transport.

The result is served as `authenticatedProviders` on `GET /api/small-model`.
The field name predates the runtime resolution; it now means "callable", which
is a superset of "has an auth.json entry".

## Registration

Mounted lazily from `feature-routes-runtime.js` (same pattern as quota): the
module is imported on first request, not at server startup.

## Known limitations

- OpenCode's free models (`opencode/big-pickle`, `*-free`) work without a
  token only through OpenCode's own server — direct calls are rejected, and
  piggybacking on their subsidized infra is out of bounds by design. Every
  resolution step therefore requires a credential we are allowed to use:
  a session on an unauthenticated `opencode` provider falls through to the
  global scan (or a clean 404 on a vanilla setup with no logins). The runtime
  snapshot does not weaken this — OpenCode reports the sentinel
  `apiKey: "public"` for that state, and this module refuses to read it as a
  credential.

- Anthropic OAuth (Claude Pro/Max) entries are not supported — OpenCode itself
  keeps those outside `auth.json` in this generation; only `type: api` keys
  work for Anthropic.
- Amazon Bedrock, GitLab, Azure and other credential-chain providers are out
  of scope; they need more than a key/token (regions, resource names).
- Responses from the codex backend are collected from the SSE stream; the
  endpoint itself is non-streaming by design (small utility calls).
