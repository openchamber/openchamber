# Small Model

Background LLM calls for OpenChamber's own features — session titles, goal
distillation, session assist, the changes walkthrough. Every call goes to the
running OpenCode through `POST /api/experimental/generate`; OpenChamber never talks to a
provider directly and never handles a provider credential.

## Security boundary

The client sends a prompt. This server forwards it to OpenCode, which owns the
credentials, the provider dispatch and the token refresh. Routes live under
`/api/*` and are gated by the ui-auth middleware like every other runtime API.

## Files

- `client.js` — the connection to the running OpenCode. `server/index.js` wires
  it once with `buildOpenCodeUrl` and `getOpenCodeAuthHeaders`; the client is
  built per call because the port and the server password both change across an
  OpenCode restart. Scoping is the `x-opencode-directory` header, URI-encoded.
  Also caches the model list for 30 seconds — a generation needs the model's
  context and output limits, and a round trip per session title is the wrong
  trade. An unreachable OpenCode keeps the previous answer rather than
  retracting it.
- `index.js` — `generateSmallModelText()`, `describeSmallModel()`,
  `listAuthenticatedProviders()`.
- `routes.js` — `GET /api/small-model` (resolution preview) and
  `POST /api/small-model/generate` (`{ prompt, system?, maxOutputTokens?,
  model?, directory? }` → `{ text, providerID, modelID, source }`).
- `runtime-providers.js` — compatibility re-export so `server/index.js` keeps
  resolving its import. Delete it once that import points at `client.js`.

## Free tier and the session fallback

OpenCode's free zen models are listed as enabled without a login, but
`/api/experimental/generate` refuses them ("free tier can only be used in OpenCode") and
`/api/model/default` answers nothing, so on a fresh install with no provider
login `generateSmallModelText` throws `404`. What happens next is per feature:

- Commit message and PR description (`packages/ui/src/lib/gitApi.ts`) fall back
  to `POST /api/session/:id/generate`, which runs on the open session's own
  model with the session as context and does not touch its history. Verified
  on OpenCode 2.0.2: the reply comes back and the message count stays at zero.
- Session renaming, the session goal and the walkthrough do NOT fall back —
  feeding a whole session into a model to write a title or audit a goal is the
  wrong cost. Their entry points read `available` from `GET /api/small-model`
  (`packages/ui/src/stores/useSmallModelStore.ts`) and show a disabled control
  with the reason; the walkthrough uses its own readiness (`no-model`).
- Session assist is server-side and simply does nothing when
  `describeSmallModel` answers null.
- Notes summarization and spoken summaries keep the original text and silence
  the 404.

## Model resolution

Four things are decided here, in order:

1. An explicit `model` on the request (`provider/model`) — `source: 'request'`.
2. OpenChamber's settings override (Settings → Sessions → Small Model): when
   `smallModelUseDefault` is `false`, `smallModelOverride` wins —
   `source: 'settings'`.
3. The small model of the session's provider (`preferredProviderID`) —
   `source: 'session-provider-small'` — found by `pickSmallModelInProvider`:
   the newest enabled, active, text-in text-out model of the first family in
   `SMALL_MODEL_FAMILY_PRIORITY` (`gpt-luna`, `gemini-flash-lite`,
   `gemini-flash`, `claude-haiku`, then `gpt-nano`, `gpt-mini`) that the
   provider has. The first four are OpenCode's own list for its session
   titles (`Catalog.model.small`), repeated here because OpenCode does not
   expose it over HTTP; the last two are v1's additions so a provider with
   only utility models (Copilot) still gets a cheap one. Families are
   models.dev `family` values, not model ids (`gpt-luna` is the family of
   `gpt-5.6-luna`); a model without one — a custom provider, a subscription
   outside the catalog — gets its family read from its id (`familyOf`:
   luna / flash-lite / flash / haiku / nano / mini). A caller that passes `restrictToPreferredProvider`
   (session titles, the session goal, session assist, notes from a selection)
   and finds none then takes the session's own model — `source:
   'session-model'`: costlier than a small model elsewhere, but never another
   provider's subscription.
4. The small model of any provider OpenCode can call, same family order,
   newest first — `source: 'small'`. Where callers without a session (commit
   messages, spoken summaries) usually land.
5. Otherwise `GET /api/model/default` — `source: 'default'`. This is
   OpenCode's default chat model, not a small one; it is the last resort.

Claude Code is refused unconditionally (`422`,
`code: 'small-model-provider-unsupported'`). A plugin can publish an
OpenAI-compatible endpoint for it, but that endpoint is a façade over the
Claude Agent SDK, which spawns the Claude Code CLI per request and spends the
user's Claude subscription rate limit. An available endpoint does not lift the
refusal — the cost is the reason, not the transport.

## Prompt shape

`/api/experimental/generate` takes one prompt and no system message, so `system` leads the
prompt, separated by a blank line.

Input clamp: the prompt is measured against the resolved model's `limit.context`
as OpenCode reports it, minus an output reserve, at ~4 chars/token. A model
OpenCode does not list gets a conservative 64k default. `onOverflow` decides
what an oversized prompt means:

- `truncate` (default) clips the tail and reports `inputTruncated: true`.
  Correct for callers that degrade gracefully (summaries, commit messages).
- `error` throws a `413` with `code: 'context-too-small'` plus
  `requiredChars`/`availableChars`. Correct for callers whose output would be
  quietly wrong on a clipped input, so they can ask the user for a roomier
  model instead of returning confident nonsense.

Output budget: `maxOutputTokens` is capped at the model's `limit.output`, and
the **same number** is reserved from the input allowance. `/api/experimental/generate` takes
no output budget of its own, so this number only shapes the reserve — but the
two sides must stay equal or a caller that asks for a large answer overruns the
context and the failure looks like a truncation bug.
`describeSmallModel` takes `outputReserveTokens` so readiness checks agree with
what generation will do. It may be a **function** of
`{ contextTokens, outputTokenLimit }` for callers that want as much answer room
as the resolved model allows — they cannot name a number before knowing which
model they got. The resolved value comes back as `outputTokens`.

`timeoutMs` overrides the 60s default; `signal` aborts a request that is no
longer wanted. The timeout covers generation, retry waits and structured-output
retries together.

OpenCode 2 can reject an explicit model before its cold catalog finishes loading.
An `InvalidRequestError` whose message exactly names the selected model as
`Model unavailable: provider/model` gets one retry after 500 ms, with the same
model and prompt. Cancellation also stops the wait. Other errors are not retried.
If the model remains unavailable, the route returns 503 with
`code: 'small-model-unavailable'` and the model-specific reason. Commit and PR
generation own their error toast and suppress the shared request toast.

## Structured output

`/api/experimental/generate` has no structured-output mode. `responseSchema` is therefore
emulated: the schema is appended to the prompt as "Reply with JSON matching this
schema and nothing else: …", and the reply is parsed here. A ```json fence is
stripped. An unparseable reply is retried **once** — a model that ignored the
shape often honours it on a second pass, and the alternative is failing a
walkthrough over a stray sentence of preamble. A second failure throws with
`code: 'structured-output-unsupported'` (`422`).

`describeSmallModel` reports `structuredOutput: null`, never `false`. The
capability is not knowable before the call, and callers must read `null` as
"try it".

## Which providers the pickers may offer

`listAuthenticatedProviders()` answers one question for the Small Model and
Changes Walkthrough pickers: which providers OpenCode can call right now. A
provider counts when it has at least one enabled model in `GET /api/model` —
the same test OpenCode applies before letting a chat turn use it.

`GET /api/provider` only contributes names. It comes back empty on setups where
models are perfectly usable, so an empty provider list is never read as "no
providers". Claude Code is removed from the result for the reason above.

The field is served as `authenticatedProviders` on `GET /api/small-model`. The
name predates this resolution; it now means "callable".

## describeSmallModel

Reports which model would be used without calling it: `providerID`, `modelID`,
`source`, plus `inputCharBudget`, `contextTokens`, `contextKnown`,
`outputTokens`, `outputTokenLimit`, `structuredOutput` and `hasLogin`.

`hasLogin` is `false` when OpenCode lists the model as disabled — a settings
override can name a model there is no credential for, and the walkthrough
refuses before the user pays for a failed request. A model OpenCode does not
list at all is not evidence either way, so it counts as usable.

Returns `null` when OpenCode is not reachable.

## Registration

Mounted lazily from `feature-routes-runtime.js` (same pattern as quota): the
module is imported on first request, not at server startup.
