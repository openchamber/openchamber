# Routing

## Purpose

Jev model routing, the permission safety net, and the classification provider
that answers both. With the `openchamber/auto` model selected, the server asks
[Jev](https://docs.typesafe.ai) (TypeSafe's System One decision model) which
task category a message belongs to and sends it with that category's model,
thinking variant and agent. In a session whose permission mode is `safety`
(`../permission-auto-accept/DOCUMENTATION.md`), the same kind of call decides
whether a permission is accepted or stays on screen for the user.

Routing needs the OpenChamber server, so it is present wherever that server is
and absent everywhere else: VS Code talks to OpenCode directly and never offers
Auto. There is no env gate — the feature shipped dark behind
`OPENCHAMBER_ROUTING_ENABLE` until Jev stopped needing a key of the user's own
(see "Where a Jev request goes"), which was the reason to hide it.

## Files

- `defaults.js` — the Auto sentinel, the Jev endpoints and models, the
  `ZEN_JEV_PROMOTION_ACTIVE` switch, built-in categories, the question wording
  for routing and for the safety net, history excerpt limits.
- `classifier.js` — the classification providers: `resolveClassifier` (the
  user's pick, what is usable, and the source that actually answers) and
  `classifierEndpoint` (where a request for a source goes),
  `legacyClassifier` (the view older clients parse) and
  `normalizeCustomEndpointUrl` (the custom endpoint's request URL).
- `store.js` — `routing.json` (only deviations from the built-ins),
  `routing-auth.json` (the TypeSafe key alone, mode 0600),
  `classification.json` (the classification provider pick) and
  `classifier-endpoint.json` (the custom endpoint, mode 0600) in the
  OpenChamber data dir. An unreadable pick file reads as no pick, an
  unreadable endpoint file as no endpoint. `resolveEffectiveConfig` merges built-ins with stored overrides;
  `toStoredConfig` is its inverse. A missing file is the defaults, a malformed
  one throws.
- `jev.js` — request builders, answer parsing, and the HTTP call with a
  timeout to the endpoint `classifierEndpoint` chose.
- `history.js` — the last three settled turns through session assist's
  `loadAssistContext` (text parts only, attached quotes included, no files or
  tool payloads), each user message cut to its head and each answer to head
  plus tail. The new request is never cut.
- `runtime.js` — `createRoutingRuntime`: `describe`, `classifierEndpoint` (the
  endpoint a Jev request goes to now, or null; also used by
  `../session-work` and `../session-goal`), `noteModelSelection`,
  `isAutoSession`, `resolveAutoSelection`, `applySessionSelection`, `routeSend`,
  `evaluatePermission`, `legacySafetyNetEnabled`, config, token, classifier and
  custom endpoint writes, event broadcasts.
- `routes.js` — `/api/routing` (GET, PUT), `/api/routing/token` (PUT, DELETE),
  `/api/routing/classifier` (PUT), `/api/routing/classifier/custom` (PUT,
  DELETE) and `registerRoutingPromptRewrite`.

## Invariants

- The sentinel never reaches OpenCode. OpenCode 2.x holds the model and agent
  on the session and a prompt body carries only the user's text, so Auto is
  per-session state: `POST /api/session` drops the sentinel from the create
  body (the session starts on OpenCode's default; the first send switches it),
  `POST /api/session/:id/model` with the sentinel is
  swallowed and marks the session (`noteModelSelection`), and every
  `POST /api/session/:id/{prompt,command}` in a marked session is routed
  (`routeSend`) and switches the session onto the answer before the send is
  forwarded. Both sit ahead of the generic proxy, which replays a parsed body.
  The message queue calls `resolveAutoSelection` itself and applies the answer
  with the model/agent switches it already makes. Without a fallback model the
  runtime throws 400 rather than forwarding. The OpenChamber session service
  (`openchamber-sessions/routes.js`) talks to OpenCode through the SDK and can
  pick Auto up from Session Defaults, so it calls `resolveAutoSelection` itself
  before switching the session.
- The mark lives in process memory. A server restart between the model switch
  and the next send drops it (see the TODO in `runtime.js`).
- Routing failures keep the user's own behaviour: a Jev error, timeout, unknown
  category or low confidence routes to the fallback model, and the decision
  carries the reason.
- The safety net accepts only on a verdict from Jev. With no usable
  classification provider it holds quietly (the session behaves like `ask`);
  when Jev fails it holds, broadcasts `openchamber:routing.safety-skipped` with
  the error, and does not remember the failure, so reconnect reconciliation asks
  again. It runs whether or not Auto routing is enabled: the routing config's
  `safetyNet.enabled` is no longer read except once, by
  `legacySafetyNetEnabled`, when the permission policy converts pre-modes
  entries. `safetyNet.threshold` still applies.
- A category without a model uses the fallback model *and* variant; a variant
  only travels with the model it was chosen for. A category agent replaces the
  composer's agent; an empty one keeps it.
- Auto is offered (`autoReady`) with a usable classification provider
  (`jevAvailable`), `enabled`, a fallback model and at least two enabled
  categories.
- Held permission decisions are cached for 15 minutes per request id so
  reconnect reconciliation in `permission-auto-accept` does not re-ask Jev;
  `permission.replied` forgets them.
- `evaluatePermission` accepts an optional third `AbortSignal` from the
  permission operation. Cancellation stops classifier HTTP and suppresses late
  held/skipped events and cache writes, including when a classifier ignores the
  signal. Access resolution and classifier completion both check cancellation.
  Jev's own timeout still reports a skipped check; caller cancellation does not.
- The send rewrite reads a body only in a session already marked as routed,
  which the URL alone answers; every other send, and anything that is not JSON,
  reaches the proxy as the stream it arrived as.

## Where a Jev request goes

The user picks a classification provider in Settings → Providers →
Classification providers:

- `off`: no Jev at all. Every Jev feature takes its no-provider path.
- `zen-promo`: `opencode.ai/zen/v1/systemone` as `jev-1.13-free`, which OpenCode
  Zen answers with no credential at all. Usable while
  `ZEN_JEV_PROMOTION_ACTIVE` is true; flip it when OpenCode ends the promotion.
- `zen-key`: the same endpoint as `jev-1.13` with a Zen API key read from
  OpenCode's credentials (`opencode/auth.js`, entry `opencode`, type `api`).
  An OpenCode account sign-in is an OAuth credential, and zen rejects it as a
  key ("Invalid API key", checked 2026-09-27), so it does not count. The paid
  call itself is not verified live yet.
- `openrouter`: `openrouter.ai/api/v1/systemone` as `jev-latest` (OpenRouter's
  `~typesafe/jev-latest` alias) with the OpenRouter API key saved in OpenCode
  (entry `openrouter`, type `api`), billed to that OpenRouter account.
- `vercel`: `ai-gateway.vercel.sh/typesafe/v1/systemone` as `typesafe-ai/jev`
  with the Vercel AI Gateway API key saved in OpenCode (entry `vercel`, type
  `api`). Both gateways implement TypeSafe's request and response shapes, so
  `jev.js` is the same for every source. Both answer 401 without a key
  (checked 2026-09-27); a paid call is not verified live yet.
- `typesafe`: `api.typesafe.ai/v1/systemone` as `jev-latest` with the key saved
  in `routing-auth.json`. Saving a key also picks it.
- `custom`: any endpoint that speaks the System One API, with the URL, model
  and optional key the user saved (`classifier-endpoint.json`, mode 0600, its
  own file so a token write never rewrites it). The key goes as a bearer when
  present; `describe` returns `customEndpoint` as URL, model and `keyPresent`,
  never the key. `setCustomEndpoint` accepts the full `.../systemone` URL, an
  OpenAI-style base ending in `/v1` (what "base URL" means to most users), or
  an API root the way TypeSafe's SDKs take `baseURL`, and stores the resolved
  request URL, which the page shows back. Only http(s), no credentials in the
  URL. It does not go through the TTS remote-URL gate: a remote classifier is
  the user's explicit choice, the same as the hosted sources. Saving picks it;
  a missing `key` keeps the saved one, null removes it without changing the
  pick.
  An administrator can pin the endpoint (`readPinnedCustomEndpoint`): `jev` in
  the machine policy file, else `OPENCHAMBER_JEV_URL`, `OPENCHAMBER_JEV_MODEL`
  defaulting to `jev-latest`, optional `OPENCHAMBER_JEV_API_KEY` (source rules
  in `../enterprise-mode.js`). The pin
  replaces the saved endpoint, `customEndpoint.pinned` tells the page to show
  it read-only, and `setCustomEndpoint` / `clearCustomEndpoint` answer 409.

In enterprise mode (policy file or `OPENCHAMBER_ENTERPRISE_MODE`, `../enterprise-mode.js`)
`resolveAccess` treats the pick as `off` whatever is stored (the stored pick is
kept for when the mode is lifted), `setClassifierSource` refuses anything but
`off` and `setToken` and `setCustomEndpoint` refuse every write with 403, and `describe` reports
`enterpriseMode` so the page shows why only Off is offered. With a pinned
endpoint it is the administrator's own infrastructure, so it becomes the
default (`custom` unless the stored pick is `off`) and `custom` is the one
other pick allowed.

Jev reads conversation excerpts, so it is opt-in. Without a stored pick the
default is `typesafe` when a key is saved (saving a key is choosing it, and it
always won before the pick existed) and `off` otherwise. Until v2.0.3 the
default was `zen-promo`, which sent every message of users who never opened
this page to zen (#4109); an install without a stored pick now reads as `off`
with no conversion. A pick that cannot be used falls back to the first usable
key (`typesafe`, `custom`, `openrouter`, `vercel`, `zen-key`: what the user set
up in OpenChamber for Jev before keys borrowed from OpenCode); none usable
means no Jev.
`zen-promo` needs no credential, so it is never a fallback: only an explicit
pick sends anything there, and `off` never falls back.
The OpenCode keys are read on every request, so a key added or removed in
OpenCode counts from the next request on.

OpenRouter and Vercel also count a key in `OPENROUTER_API_KEY` /
`AI_GATEWAY_API_KEY` (`readOpenCodeKeys`), because OpenCode connects those
providers from the variable live and never stores it (v2 `integration.ts`
`resolveConnections`). A key saved in OpenCode wins. The server's
`process.env` already carries the login-shell snapshot and a managed OpenCode
is spawned from it, so both see the same variable; an external OpenCode
started elsewhere may not, and then the variable simply is not seen. Zen has
no variable.

Every zen call is tagged `x-opencode-client: openchamber`. Dax approved the
free use in Slack on 2026-09-22 on terms the code and the copy keep together:
zen can identify and throttle our calls through that header, and the
Classification providers page tells the user in plain words that the free model
is a limited-time OpenCode promotion. Zen rejects the `jev-latest` alias, so
versioned ids are sent.

Never make the free tier the only path: the zen docs call it "available for a
limited time", and the keys are what users fall back to when it ends.

## Events

Broadcast on the OpenChamber control stream: `openchamber:routing.updated`
(availability, including `jevAvailable`), `openchamber:routing.decision` (per
send), `openchamber:routing.permission-held`,
`openchamber:routing.safety-skipped`. The last two carry the request's
directory so the UI can raise the permission toast for a held request.

`/api/routing` keeps `jevSource` (`typesafe` or `zen-free`) for clients from
before the classifier pick and adds `jevAvailable`, `classifier` and
`classification` (both `selected`, `effective`, `sources`). `classification`
is the full picture. `classifier` is what v2.0.2 clients parse: their schema
knows only `zen-promo`, `zen-key` and `typesafe` and rejects the whole state
on any other id, so it lists only those and is null while OpenRouter,
Vercel or a custom endpoint is picked or answering (`legacyClassifier`). Current clients read
`classification` and drop source ids they do not know.

## UI

`packages/ui/src/stores/useRoutingStore.ts` projects `/api/routing` and these
events (`selectSafetyNetAvailable` gates the safety-net mode everywhere);
`hooks/useRoutingSync.ts` keeps it current, shows the skipped-check toast and
raises the permission toast for a held request (`notifyHeldPermission`). `lib/routing/autoModel.ts` owns the sentinel; `useConfigStore` accepts it
as a valid selection while `autoReady`. `ModelPickerList` renders it as the
pinned `leadingEntry`; `ModelControls` hides the agent and thinking controls
while Auto is selected. `PermissionCard` shows the hold reason. Settings →
Routing (`components/sections/routing/RoutingPage.tsx`) edits the config with
debounced saves. Settings → Providers → Classification providers
(`components/sections/classification/ClassificationProvidersPage.tsx`) picks
the source and manages the TypeSafe key and, through `CustomEndpointFields.tsx`,
the custom endpoint; `JevAccessNote` links there from the
features that need Jev.

## Tests

`store.test.js` (defaults, deviation round-trip, deleted built-ins, malformed
file, token file mode, classifier pick, custom endpoint file), `runtime.test.js` (request text,
excerpts, decisions, endpoints, custom URL normalization and setter,
classifier fallback, rewrite and fallback
paths, safety net accept/hold/skip/unavailable), `routes.http.test.js`
(sentinel dropped from a create and swallowed on the model switch, routed send
ahead of a stand-in proxy, the routes). The queue and auto-accept tests cover
their hooks.
