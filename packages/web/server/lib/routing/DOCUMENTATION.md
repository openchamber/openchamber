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
  `parseCustomEndpointUrl` (the custom endpoint's request URL).
- `store.js` — `routing.json` (only deviations from the built-ins),
  `routing-auth.json` (the TypeSafe key alone, mode 0600),
  `classification.json` (the classification provider pick),
  `classifier-endpoint.json` (the custom endpoint, mode 0600) and
  `auto-sessions.json` (the sessions on Auto) in the OpenChamber data dir. An unreadable pick file reads as no pick, an
  unreadable endpoint file as no endpoint. `resolveEffectiveConfig` merges built-ins with stored overrides;
  `toStoredConfig` is its inverse. A missing file is the defaults, a malformed
  one throws. The store reads those files through the shared handle-judged bounded reader:
  1 MiB for routing config, 64 KiB for the auth, classifier and endpoint files, and
  32 MiB for auto sessions. Over-cap or non-regular config is an error; the pick,
  endpoint, token and session readers preserve their existing warn-and-empty behavior.
- `jev.js` — request builders, answer parsing, and the HTTP call with a
  timeout and a 1 MiB response cap (`JEV_MAX_RESPONSE_BYTES`: the endpoint
  can be user- or admin-chosen, so its body is untrusted input) to the
  endpoint `classifierEndpoint` chose. A category whose model is
  a pool (`opencode-route/<id>`) gets that pool's `description` and `details`
  appended to its criteria string (see "Pool descriptions" below).
- `history.js` — the last three settled turns through session assist's
  `loadAssistContext` (text parts only, attached quotes included, no files or
  tool payloads), each user message cut to its head and each answer to head
  plus tail. The new request is never cut. Also the model that wrote the last
  settled answer and when it finished (`lastAnswer`), for `cache.js`.
- `cache.js` — "Try to preserve cache usage": which category a send stays on
  while the current model's prompt cache is likely warm (`cacheHoldCategory`),
  and how long that is given OpenCode's `warming` config (`warmWindowMs`).
- `runtime.js` — `createRoutingRuntime`: `describe`, `classifierEndpoint` (the
  endpoint a Jev request goes to now, or null; also used by
  `../session-work` and `../session-goal`), `noteModelSelection`,
  `isAutoSession`, `resolveAutoSelection`, `applySessionSelection`, `routeSend`,
  `evaluatePermission`, `legacySafetyNetEnabled`, config, token, classifier and
  custom endpoint writes, event broadcasts, and `testClassifier` (one probe
  request from Settings' Test button, through the provider answering now or
  through custom endpoint fields as typed; stores nothing, and typed fields are
  refused in enterprise mode like a save). The classifier judges the user's
  text plus one attachment fact for sends with images (`attachmentHint`,
  `routingRequestTextOf`); that fact never reaches OpenCode.
- `routes.js` — `/api/routing` (GET, PUT), `/api/routing/token` (PUT, DELETE),
  `/api/routing/classifier` (PUT), `/api/routing/classifier/custom` (PUT,
  DELETE), `/api/routing/classifier/test` (POST) and
  `registerRoutingPromptRewrite`.

## Plan information

`plans.js` reads and writes OpenCode's `plans.json` and append-only
`plan-notes.jsonl` in the data directory. `readNotes` reads the complete notes
file through `readBoundedFileSync` with an 8 MiB cap. A missing file remains an
empty result; an over-cap file returns 413 `PLAN_NOTES_TOO_LARGE`, and a
non-regular file returns 409 `PLAN_NOTES_NOT_REGULAR`.

`readPlanStore` reads `plans.json` through the same handle-judged reader with
an 8 MiB cap. A missing file remains an empty store; an over-cap or
non-regular file returns the existing 409 `PLAN_STORE_MALFORMED` error, as do
invalid JSON and an invalid store shape. The cap leaves room for OpenCode's
`plan_info` writer while keeping one read bounded.

Filters run before the newest-`limit` slice, and `skipped` counts damaged lines
across the full file. A tail read would return incomplete filter results and
counts, so the reader refuses an over-cap file rather than returning partial
history. `addNote` stays append-only; the read cap is the visible growth bound.

## Learned route choices

`route-overrides-store.js` stores interpreter feedback in
`route-feedback.jsonl`. `readFeedback` reads at most 4 MiB through
`readBoundedFileSync`; a missing file remains `[]`, and damaged lines are
skipped. An over-cap or non-regular file logs a warning and returns no learned
choices for that request. Individual feedback entries are bounded to 3 MiB
(`RETAIN_ROUTE_FEEDBACK_BYTES`). `recordFeedback` throws a `RangeError` if a
serialized entry line exceeds 3 MiB, because a single line larger than the
retention window cannot survive compaction as a complete line. Callers must
keep individual feedback entries within this limit. After an append takes the
log past 4 MiB, the store atomically keeps the newest complete lines within
3 MiB. This also trims an older over-cap log on the next recorded correction
or undo. Before replacing the file via atomic rename, snapshot compaction
re-stats the live file. If a concurrent writer appended entries during
snapshot preparation, compaction discards the snapshot and retries (up to
3 attempts) so the newer append is retained in the compacted tail. If another
process already compacted the log below the cap, the redundant snapshot is
cleanly discarded. An append in the small interval between the final pre-rename
stat check and the filesystem rename can still be overwritten; this residual
loss window is accepted in exchange for atomic log replacement without
cross-process locks. If compaction fails, the store logs the failure and leaves
the log intact; a later append can retry it.

## Sentences about models

`route-interpreter.js` turns one sentence (`/route <sentence>` in the composer,
or the "Prefer previous" button on a model-changed divider, which sends
`prefer <provider/model>`) into overrides in OpenCode's `route-overrides.json`.
OpenCode applies them to every pool, whatever its autonomy level: `avoid`
takes a target out, `prefer` multiplies its weight (3 by default, `2x` and
"less" change it), which ranks it first in an ordered pool, puts it alone in
the top tier of a round-robin pool and makes a weighted draw pick it more
often. The keyword stage reads what the sentence names, most specific first:

- a `provider/model` reference the available catalog does not list: refused
  as unknown, before any smart stage runs, so a model that is gone is never
  widened into a whole provider or family;
- one exact model, as `provider/model` or a bare id (a `#variant` is dropped,
  because an override scopes a model, not its thinking variant); a bare id
  covers every configured provider that serves it;
- a model family the code knows (`opus`, `sonnet`, `haiku`: the newest one per
  provider for `prefer`) or "claude", which asks which Claude is meant;
- a kind of model: a word the sentence shares with the names of the models
  available now, such as `gemini`, `gpt` or `flash`, scoped to the named
  provider when there is one. The rule lists those models exactly, so a model
  added later is not covered until the user says it again;
- a configured provider, by id or alias (`gemini` for `google`). An alias of a
  provider that is not configured names nothing, so "gemini" falls through to
  the gemini models other providers serve.

Kinds that are not words in model names, such as "cheap" or "fast", are not
understood (`unknown`); cost tiers in `plans.json` are not read here. A rule
lasts a day unless the sentence says otherwise ("for 2 hours", "today", "this
week") and applies to every session. A session a round-robin or weighted pool
has already drawn stays on its target (OpenCode's sticky choice), and an
ordered pool keeps a session on the target answering it while that target is
ready, so a preference shows on the next draw: a new session, or after the
current target fails or is benched.

## Pinning a pool member

While a pool is selected, the current-model line above the composer
(`packages/ui/src/components/chat/CurrentModelIndicator.tsx`) opens a menu of
the pool's members, read from the catalog OpenCode compiles for the pool
(`settings.opencodeRoute.targets`; a pool whose members come only from
patterns lists none and offers no menu). Picking a member pins it for the
session with OpenCode's `POST /api/session/:id/route-target` (fork #2671): the
session stays on the pool, the pinned member serves while it is healthy, the
pool fails over to its other members when it is not, and requests return to
the member once it recovers. "Any model in the pool" clears the pin. The line
names the pinned member, read with `GET /api/session/:id/route-target`. When
the pin applies is the user's choice (`packages/ui/src/lib/routing/poolMemberPick.ts`):

- with the next message: set once the running turn finishes (an idle session
  pins now);
- at the next step: set now. OpenCode reads the pin on every model request,
  so a running turn makes its next request on the member;
- now: set now, and a running turn is replayed on the pool, as the "Stop and
  restart this reply" choice for model changes during a reply does.

A session switched to a single member directly (an older pick, or the model
picker) is offered "Return to pool" for each pool listing that model, with the
same timings; that goes through `session.switchModel`, and the composer
follows only when the switch succeeded. VS Code shows the full model-changed
text and the pool-member menu, but not "Prefer previous", which needs the
OpenChamber server's `/api/model-routes/interpret` route that VS Code does not
run.

### Why a pin and not a switch to the member

A switch makes the member the session's model, so the session leaves the pool
and stops failing over until the user returns to it. A pin keeps the pool's
failover. OpenCode holds pins in memory, so a restart clears them and the
session then selects normally; the line reads the pin back from OpenCode
instead of remembering it, so it never shows a pin OpenCode no longer has. The
published `@opencode/client` predates the route, so `lib/opencode/client.ts`
calls it through `runtimeFetch`, like its other SDK gaps. Pool rotation
(`pool-rotation.js`) still moves sessions by switching their model.

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
- The mark is saved in `auto-sessions.json` in the data dir, beside
  `routing.json`. A change is written before the switch answers, and the list
  is read back when the runtime starts, so a restart keeps Auto. Choosing a real
  model removes the mark. A failed write is logged, and the mark holds until the
  next restart.
- Routing failures keep the user's own behaviour: a Jev error, timeout, unknown
  category or low confidence routes to the fallback model, and the decision
  carries the reason.
- The routing question sends `ROUTING_INSTRUCTIONS` as one string, the same
  form as the Test probe. TypeSafe also accepts a list there, but a
  self-hosted System One server may not: Kev answers a list with 400, so Auto
  fell back on every send while Test passed (#4175).
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
- A variant the model's catalog entry does not list is dropped before the
  switch, so the reply runs on the model's default thinking instead of OpenCode
  refusing it (Settings from before #4133 saved list positions like `"2"`).
  An unreadable catalog, or one that does not know the model yet, keeps it.
- A provider's prompt cache belongs to one model, so a model switch makes the
  new model read the whole context uncached. With `preserveCache` on (the
  default; a config without the key reads as on), a send Jev routes to a
  built-in category below the one the session is on runs as that one instead,
  while the cache is likely warm. "Below" is the built-in order trivial <
  research < implement < hard; the session is on the highest enabled built-in
  category whose model wrote the last settled answer. Moving up is never held,
  and neither is a send routed to a user category, a fallback for low
  confidence or an error, or a hold that would change the agent (another
  agent is another system prompt, which misses the cache anyway). Warm means
  within 5 minutes of the last answer finishing; for a session OpenChamber
  keeps warm itself (`../session-warming`, `isSessionWarm`), until its warm
  window ends plus 5 minutes; otherwise, when OpenCode's `warming` is on for the
  directory, within its `duration` (30 minutes for `true`) plus 5 minutes. The
  config is read only after the first 5 minutes, and not for a session
  OpenChamber keeps warm; an unreadable one counts as warming off. The decision event names the category the send
  ran as and carries `cacheHold.requested`, the one Jev chose.
- Auto is offered (`autoReady`) with a usable classification provider
  (`jevAvailable`), `enabled`, a fallback model and at least two enabled
  categories.
- Held permission decisions are cached for 15 minutes per request id so
  reconnect reconciliation in `permission-auto-accept` does not re-ask Jev;
  `permission.replied` forgets them.
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
  never the key. `setCustomEndpoint` stores the request URL exactly as pasted
  (trimmed, without a `#fragment`) and appends nothing: a company proxy can
  serve System One on any path, so only the user knows the full address. Before
  2026-10-05 a `/v1` base or an API root got `/v1/systemone` appended; URLs
  saved then are already full and read back unchanged, but a pin written in
  that short form now needs the full address. Only http(s), no credentials in
  the URL. It does not go through the TTS remote-URL gate: a remote classifier is
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
`openchamber:routing.safety-skipped`. Showing the held request itself is not
routing's job: the permission auto-accept runtime reports every request it
left for the user (`../permission-auto-accept/DOCUMENTATION.md`).

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
`hooks/useRoutingSync.ts` keeps it current and shows the skipped-check toast. `lib/routing/autoModel.ts` owns the sentinel; `useConfigStore` accepts it
as a valid selection while `autoReady`. `ModelPickerList` renders it as the
pinned `leadingEntry`; `ModelControls` hides the agent and thinking controls
while Auto is selected. `PermissionCard` shows the hold reason. Settings →
Routing (`components/sections/routing/RoutingPage.tsx`) edits the config with
debounced saves. Settings → Providers → Classification providers
(`components/sections/classification/ClassificationProvidersPage.tsx`) picks
the source and manages the TypeSafe key and, through `CustomEndpointFields.tsx`,
the custom endpoint; `JevAccessNote` links there from the
features that need Jev.

## Model pool config

`model-routes.js` — `GET`/`PUT /api/model-routes`: OpenCode's
`experimental.model_routes` (the pools), `model_route_tuning` (automatic
review) and `model_route_schedules` (weight changes across pools), written to
the user's global `opencode.json(c)` and refused in enterprise mode. A `PUT`
carries any of `routes`, `tuning` and `schedules`; `null` removes `tuning` or
`schedules`. Every key is checked against OpenCode's schema
(`packages/schema/src/config/model-routes.ts`) before anything is written, and
one bad pool refuses the whole map. A schedule is also refused where OpenCode
would quietly drop it (`packages/core/src/model-route-schedule.ts`,
`routeWeightRules` in `packages/core/src/config/plugin/model-routes.ts`): an
empty day list, an unreadable time or timezone, or neither `factor` nor
`weight`. Two cases OpenCode keeps are refused too, because they do not do what
they say: a start equal to its end (the rule stays and is never active) and
both `factor` and `weight` (the weight applies and the factor is ignored).
A cross-pool schedule's `providers`, `models`, `targets` and `routes` follow
the same list rules as a route schedule's `targets`: a blank entry or an empty
list is refused, because OpenCode reads an empty matcher as "everything".

OpenCode adds up `model_route_schedules` from every config file, while
`mergeConfigs` keeps only the last file's list, and it builds its pools from
every file's `model_routes`, a later file's pool replacing an earlier one of
the same id. So `schedules` and `routes` in a response are the user file's
own, as stored, and the only ones a `PUT` writes; `otherSchedules` lists the
non-empty lists in the other files (`{ path, schedules }`) and `otherRoutes`
the non-empty pool maps (`{ path, routes }`), which Settings shows read-only,
in OpenCode's reading order from `readConfigSources`
(`../opencode/shared.js`): the global files, `OPENCODE_CONFIG`, then every
`opencode.json(c)` and `.opencode/opencode.json(c)` from the outermost
ancestor folder down to the project. The folder files are included only when
the request names the Settings project (`?directory=` or the
`x-opencode-directory` header). Tuning reads and writes the same with or
without it. Settings sends schedule saves one at a time and keeps only the
newest edit's answer.

## Pool descriptions

`model-routes.js` reads and writes OpenCode's `experimental.model_routes` in the
user's `opencode.json(c)`. Besides OpenCode's own route keys it accepts three that
OpenChamber owns: `description` (one line, at most 200 characters),
`details` (at most 2000) and `nestedTimeout` (see "Pool waits and order"). The Routing page reads a value the save would
refuse as absent (`modelRoutesApi.ts`, same limits, checked equal by
`model-routes.test.js`), because every save sends the whole map and one bad
hand-edited value would otherwise block saving any pool. OpenCode decodes its config with
`onExcessProperty: "ignore"` (core `config.ts`, `config/normalize.ts`), so a
route carrying them loads and the two keys are dropped. OpenCode's published
JSON schema sets `additionalProperties: false` on a route, so an editor that
validates the file may flag them. Both were checked against OpenCode on
2026-10-22.

Because OpenCode's own config read drops the keys, the routing runtime reads
the pools from the config files (`readModelPools`, wired in `index.js` to
`readLayeredModelRoutes(readConfigSources(directory))`), not from OpenCode's
config API. `readConfigSources` (`../opencode/shared.js`, shared with Settings ›
MCP) lists the files OpenCode reads, lowest priority first: the global
`opencode.json` and `opencode.jsonc`, `OPENCODE_CONFIG`, then every
`opencode.json(c)` from the outermost ancestor folder down to the project, then
every `.opencode/opencode.json(c)` in the same order. A later file's pool
replaces an earlier one whole, as OpenCode's model-routes config plugin does,
so a description never outlives the pool definition it came with. Not covered:
the system config folder, macOS managed preferences, `.well-known` remote
config and `OPENCODE_CONFIG_CONTENT`; a pool defined only there reaches Jev
without its text. In a routed
send, each enabled category whose own model is a pool gets
`\n\nRuns on the model pool "<id>": <description>\n<details>` appended to its
description; a category without a model of its own, or on a pool with neither
key, keeps its description alone. Each value is held to the save's rules
(`MAX_DESCRIPTION_LENGTH`, `MAX_DETAILS_LENGTH`, no line break in the
description), and a hand-edited value that breaks them is left out. Criteria
stay one string per category. A config that cannot be read means no pool text,
and routing goes on.

The text goes to the same classification provider as the rest of the routing
request, so enterprise mode already covers it. The OpenCode `plan_info` pool
`purpose` is a separate record in OpenCode's plan store and is not read here.

## Pool waits and order

OpenCode applies `health.firstTokenTimeoutMs` (and `attempts`, `hedgeAfterMs`)
only from the pool a session picked; a nested pool's own values are ignored,
and a pool that names no wait gets OpenCode's 10 seconds. A slow model in a
pool inside a pool was therefore cut off by the outer pool's default. Every
`PUT /api/model-routes` passes the map through `normalizePoolTimeouts`
(`pool-timeouts.js`) before writing:

- A pool's own wait without `nestedTimeout` is kept as written, `false` (no
  limit) included.
- A pool that nests other pools (route targets, and pool names in `include`
  or in a `match` term that is not negated) and names no wait gets the longest
  wait of its nested pools, resolved recursively, and `nestedTimeout:
  "longest"`. With `nestedTimeout` set the value is recomputed on every save,
  so a change to a nested pool reaches the pools around it. `"shortest"` takes
  the shortest; `false` counts as the longest and `"shortest"` passes over it.
- Any other pool without a wait gets 30 seconds. A cycle is cut where it
  closes and contributes 30 seconds, so the result is the same on every save
  (`pool-timeouts.test.js` checks idempotence and explicit values over
  generated chains).

Only pools in the user file take part: the validator already refuses a route
reference to a pool that is not in the saved map. `GET` and `PUT` also return
`timeouts`, per pool the wait OpenCode applies now and what longest and
shortest would pick, which the pool page shows. OpenCode cannot give each
nested pool its own wait; that would need a change in OpenCode.

The order of the pools is the key order of the map. `PUT` writes it with
`writeConfig`'s `orderedPaths` (see `../opencode/DOCUMENTATION.md`), since the
writer otherwise ignores key order. OpenCode's catalog, and with it the model
picker, keeps that order with one exception: pools with a `levels` list or a
`#effort` member come after the others, in their own config order (OpenCode
2.0.30, checked 2026-11-22 against a private `opencode serve`). JavaScript
lists keys that look like whole numbers first, so a pool id such as `2` always
sorts before the others.

OpenCode logs `omitted unknown setting` for `nestedTimeout`, as it does for
`description` and `details`, and drops the key; the route loads unchanged.

`route-match.js` restates OpenCode's `match` grammar (terms joined by `and`,
`or`, `not` and parentheses; `re:` patterns compiled with the `i` flag), so the
validator refuses an `include`, `exclude`, `match` or `variantRules` entry
OpenCode would drop with the whole pool. `route-match.test.js` pins the
accepted and refused shapes to OpenCode's examples.

## Model pool telemetry

Separate from Jev/Auto above: read-only views over OpenCode's own
`route_attempt`/`route_decision` tables (`experimental.model_routes` pools,
`model-routes.js`'s concern), not OpenChamber's classifier. Both report
`{ available: false, reason }` instead of an empty result when the database,
its routing tables, or a usable `node:sqlite`/`bun:sqlite` driver are absent.
When OpenCode's base URL is not a loopback address, both routes read no local
file and answer `{ available: false, reason: "remote-opencode" }`, the same
check pool health applies.

- `model-route-stats.js` — `GET /api/model-routes/stats`: aggregate counts,
  latencies, grouped errors and hedge win rates per target over a trailing
  window (`hours`, default 24).
- `message-model-attribution.js` — `GET /api/model-routes/turns?sessionID=`:
  per-assistant-message attribution for one session, keyed by assistant
  message id (`routeID`, the `selection` decision nearest before the attempt
  that answered, and a `failover` block when an earlier attempt for the same
  message failed over to a different target first). Every request OpenCode
  runs writes an attempt row, routed or not, so a direct (non-pool) model gets
  an entry too, with `routeID: null`. This backs the UI's per-message model
  badge, its hover detail, and the transcript's model-changed divider; the
  divider's "does the real model differ from the previous turn" check itself
  needs no telemetry, since it just compares the assistant messages' own
  `providerID`/`modelID`/`variant` (`packages/ui/src/components/chat/lib/turns/modelChange.ts`).

## Pool health

Settings, Routing, Model pools shows how many sessions share each pool target
and how close a target's plan looks to its quota window. Several sessions on
one target lose their prompt cache together when its plan runs out; the panel
makes that visible so the user can spread them.

Staggered rotation (#295) automates that spreading, off by default; the
`pool-rotation.js` entry below describes how it picks and moves sessions.

- `model-routes.js` validates a pool before Settings saves it, key by key
  against OpenCode's `Config.ModelRoute` schema, `schedules` included: a
  schedule carries an optional `id`, `targets` patterns and `note`, a required
  `when` window (weekday names or 0 to 6, days of month or -1, `start`/`end`
  local times read as OpenCode's `minutesOf` reads them: one or two digit
  hours, minutes and optional seconds, all in range, seconds rounded down,
  `timezone`, `from`/`until`), and one of `factor` or `weight`.
  Values OpenCode would drop or silently ignore are refused with the reason:
  a window its parser cannot read, an empty day list, a window whose start
  and end are the same time (OpenCode treats that as an empty window that
  never applies), a non-finite weight or health rate (an overflowing JSON
  number such as `1e999` parses to `Infinity`, which OpenCode requires to
  be finite and which would save as `null`), a target listed twice in one
  route (OpenCode attaches each target once, keyed by its full model
  reference, and silently drops the later entry, including its variant
  settings), a target reference with a padded provider, model or
  `#variant` segment, a segment or variant containing whitespace, an
  empty `/`-joined segment, or a padded or whitespace-containing
  `defaultVariant`/`variants` setting (OpenCode does not trim target
  references or variant names — trimming is specific to schedule
  entries — so the padded, whitespace-containing or empty spelling
  would never match a model;
  model IDs containing `/` stay accepted while every segment is
  non-empty, unpadded and free of whitespace), a concrete target fully covered by an earlier pattern
  target in the same route with the same `#variant` (the pattern
  attaches that model under its own settings, so the later entry and
  its variant settings would never apply; an earlier pattern carrying
  an `until` is left alone, because it shadows only until it expires
  and the concrete target applies after that), a pattern target whose
  whole model set an earlier pattern target in the same route with the
  same `#variant` covers (every model the later pattern would attach is
  already attached by the earlier one, so the later entry would never
  apply; a partly overlapping pattern stays accepted, and the same
  `until` carve-out applies), a target whose `until` is already past (OpenCode drops a
  target whose `until` has passed, so the target would leave the route as
  soon as the config is saved), an `until` on a route-reference target
  (OpenCode includes the referenced route unconditionally and never reads
  `until` on a reference, so the time limit would never apply), a
  `defaultVariant` or `variants` on a route-reference target (OpenCode
  expands the referenced route from its own targets and never reads
  variant settings on a reference, so they would never apply; a
  `#variant` suffix on the reference itself is read and stays accepted), a budgets key that is a `*`
  pattern (OpenCode reads a budget by the concrete model a target expands
  to, so a pattern key would never apply), a budgets key that names a
  route reference (OpenCode looks budgets up only by concrete model, so
  that key would never apply either; a budget key naming a concrete model
  the route reaches through its references does apply, and the set-level
  check accepts it), a weights key that is a `*`
  pattern (OpenCode reads a weight by the concrete key a target attaches
  with, so a pattern key would never apply), a schedule target whose
  pattern shares no model with any target the route expands to (two
  patterns count as sharing when one model matches both, even if each
  covers models the other does not; entries are judged in lower case,
  the way OpenCode's case-insensitive schedule matcher reads them, and
  trimmed before every check, the way OpenCode trims them before
  matching, so padding alone neither refuses an entry that would apply
  nor changes which verdict it gets; the
  set-level check judges entries against the concrete models the route
  reaches through its route references, because OpenCode inherits a
  route's schedule rules into nested groups and matches them against
  each leaf), a schedule target that names a route reference (OpenCode
  matches schedule targets against concrete `provider/model`
  references, so the entry could never match a leaf; a weights key
  naming the reference stays valid, because a nested route attaches
  under that key), a schedule
  target carrying a `#variant` suffix (OpenCode matches schedule
  targets against `provider/model` references without a variant, so
  the entry could never apply), an empty schedule `targets` list
  (OpenCode applies a schedule with no target filter to every target in
  the route, so the key is left out for that), a schedule with neither
  change, and one with both, where
  the weight would win and the factor would be ignored, `weights` or
  `budgets` on a `fixed` route (selection modes, weights and budgets are
  rules-level in OpenCode, so a fixed route replaces every weight with 1
  and never collects its budgets), and — judged against the whole saved
  set, not one route at a time — a target that references a route the set
  does not contain, a target that references its own route (a route is
  always on its own expansion trail, so OpenCode drops a self-reference
  from every entry point, even beside targets that do serve models), a
  reference target that reaches models only back through the referencing
  route (OpenCode will not revisit a route already on its expansion
  trail, so that entry contributes no model to the referencing route,
  even when every route in the set expands to a model some other way), or
  a route whose targets only chase references in a
  cycle that reaches no concrete model target (OpenCode drops both
  silently, and the second would expand to no models). Cross-pool schedules
  (`experimental.model_route_schedules`) go through `validateModelRouteSchedules`,
  which reuses the route schedule window checks; see "Model pool config".
- `pool-plan-links.js` keeps `pool-plan-links.json` in the OpenChamber data
  directory: a map from a target reference (`provider/model`, or a `*`
  pattern) to a plan id from the plan store, read with a 1 MiB cap through
  `readBoundedFileSync`. Two targets linked to one plan
  are siblings sharing one quota. `plans.json` already has
  `models["provider/model"].coveredBy`, but that entry needs a cost tier
  before it can exist and lists every plan whose price covers a model; a pool
  link names the one quota a target draws on and needs no tier, so it lives
  in OpenChamber's own file. A missing file reads as empty; an over-cap,
  non-regular, malformed or schema-invalid file answers 409
  `POOL_LINKS_MALFORMED`. Only `PUT /api/model-routes/plan-links` (`{ target, planID }`,
  `planID: null` clears) exists; it refuses a plan id the plan store does not
  have, and clearing always works. Reads go through the health route.
- `pool-health.js` answers `GET /api/model-routes/health` (`hours`, default 24,
  and `activeMinutes`, default 15). Per pool target it reports the sessions
  whose latest attempt in the last `activeMinutes` went to it (a session that
  failed over or was moved counts where it is now), the linked plan and
  its siblings, and a projection for the plan's tightest window: the recent
  usage of every target linked to the plan, scaled to the window's length.
  OpenCode records an attempt for every request, routed or direct, so direct
  use of the same model counts too. A pattern target counts every concrete
  model its pattern matches, each session once. `requests` and `messages`
  windows count attempts; `tokens` windows count input, output and reasoning
  tokens, as OpenCode's `model-usage.ts` meters plans. `usd`, `percent` and
  `other` windows get no projection. Every projection carries
  `source: 'traffic-estimate'` (a provider reading, if one ever arrives
  through an existing in-repo source, would carry `'provider-reading'`), and
  the plan also lists each unprojectable window in `unprojectedQuotas` with
  its reason (`needs-pricing`, `needs-provider-meter`, `unsupported-unit`),
  which the panel renders instead of silence. The projection is an estimate
  from recent traffic and cannot see usage outside OpenCode; a window of zero
  or negative hours gets none. A weighted or round-robin pool (OpenCode's
  round-robin is smooth weighted round robin, so both draw by weight) with a
  target at 70 percent or more gets a `lower-weight` suggestion while the
  target's weight is above 0.1, which the panel turns into a button that
  halves that weight. Without the routing tables the route still answers, with
  `statsAvailable: false` and no counts. The session and usage queries
  settle separately (`sessionsAvailable`, `usageAvailable`), so one failing
  costs only its own columns. Each telemetry row belongs to the most specific
  link that covers it (an exact reference beats a pattern, a longer pattern a
  shorter one), so it counts once, toward one plan, even when `openai/*` and
  `openai/gpt-x` are both linked. Nested pools (`opencode-route/<id>`) are left
  out of a pool's targets; they are listed as pools of their own. The
  `lower-weight` suggestion also needs another target in the pool on a
  different plan (or none): moving weight between siblings on one quota
  changes nothing. When
  OpenCode's base URL is not a loopback address (`OPENCODE_HOST` on another
  machine), its database is not on this one, so the route reads no local file
  and answers `statsReason: "remote-opencode"`; a local file could be a stale
  one from another install. A damaged `plans.json` or links file
  is reported as `planError` / `linksError` and costs only the plan columns;
  a link to a plan that no longer exists is reported as `missingPlanID` so the
  panel can clear it. The panel reads again whenever the pools change.
- `pool-rotation.js` moves sessions off a target one at a time before its plan
  runs out, so they do not all restart on a cold cache together. Off by
  default; `GET`/`PUT /api/model-routes/rotation` read and write
  `{ enabled, intervalMinutes }` in `pool-rotation.json` in the OpenChamber
  data directory (missing reads as off, malformed answers 409). OpenCode keeps
  a session's pool target in memory and has no route to move one session,
  and route overrides apply to every session, so a move sets the session's
  model to a sibling target through `session.switchModel`. The session leaves
  the pool and no longer fails over inside it; that is why the switch is off
  by default and its description says so. Once a minute, per pool: a source
  is a target whose linked plan projects to `warn` or `over`; a destination
  is another concrete target of the pool not linked to the same plan, not
  near its own limit, not past its `until`, and whose latest request in the
  last 15 minutes did not fail (`queryTargetReliability`), a target with a
  recent success before one with no recent traffic, then the most headroom.
  A pattern source (`openai/*`) counts the sessions whose latest attempt went
  to any model it covers. The target needs two or more live sessions still
  on the pool (the per-route list, not the health count, which includes
  other routes and sessions already moved): the last one stays. One session
  moves: running subagents (a `parentID` and listed by OpenCode's
  `session.active`, so a subagent busy in one long tool call still counts
  and one that just finished does not; when that list cannot be read no
  subagent moves) first, then the one idle longest; finished
  subagents are not moved, Auto sessions never are, and only sessions whose
  model is still the pool count. The destination must also be in the pool as
  the session's own project defines it (a project can override a pool with
  the same id), and the session is read again right before the switch, so a
  model or Auto picked while the others were being read stands. A switch that fails puts that session in a
  30-minute back-off and the next session is tried; a pool where every
  switch failed is not throttled. OpenCode calls time out after 15 seconds.
  `session.switchModel` goes through OpenCode's session location middleware,
  so a move starts the session's location when it is not running. At most
  one move per pool per `intervalMinutes`, measured from the start of the
  tick that moved; a tick that ran long (slow OpenCode calls) also holds the
  next move until `intervalMinutes` less one tick has passed since its switch
  finished, and the move's `at` is that finish time. The pace, the back-off and the last 20 moves are kept in
  memory, so a restart forgets them.

## Tests

`model-routes.test.js` (route validation, pool description and details limits,
the routes), `model-pools-folder-config.test.js` (which files the pool text
comes from and which one wins), `store.test.js` (defaults, deviation round-trip, the cache setting's default,
deleted built-ins, malformed
file, token file mode, classifier pick, custom endpoint file), `runtime.test.js` (request text,
excerpts, decisions, cache holds and the warm window, endpoints, custom URL normalization and setter,
classifier fallback, rewrite and fallback
paths, pool descriptions in the criteria, safety net accept/hold/skip/unavailable), `routes.http.test.js`
(sentinel dropped from a create and swallowed on the model switch, routed send
ahead of a stand-in proxy, the routes). The queue and auto-accept tests cover
their hooks.
