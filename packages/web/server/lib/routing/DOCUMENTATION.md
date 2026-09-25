# Routing

## Purpose

Jev model routing and the permission safety net. With the `openchamber/auto`
model selected, the server asks [Jev](https://docs.typesafe.ai) (TypeSafe's
System One decision model) which task category a message belongs to and sends
it with that category's model, thinking variant and agent. With the safety net
on, the same call decides whether an auto-accepted permission should stay on
screen for the user instead.

Routing needs the OpenChamber server, so it is present wherever that server is
and absent everywhere else: VS Code talks to OpenCode directly and never offers
Auto. There is no env gate — the feature shipped dark behind
`OPENCHAMBER_ROUTING_ENABLE` until Jev stopped needing a key of the user's own
(see "Where a Jev request goes"), which was the reason to hide it.

## Files

- `defaults.js` — the Auto sentinel, both Jev endpoints, built-in categories,
  the question wording for routing and for the safety net, history excerpt
  limits.
- `store.js` — `routing.json` (only deviations from the built-ins) and
  `routing-auth.json` (the Jev key alone, mode 0600) in the OpenChamber data
  dir. `resolveEffectiveConfig` merges built-ins with stored overrides;
  `toStoredConfig` is its inverse. A missing file is the defaults, a malformed
  one throws.
- `jev.js` — request builders, answer parsing, the HTTP call with a timeout,
  and `jevEndpoint`, which picks where one request goes.
- `history.js` — the last three settled turns through session assist's
  `loadAssistContext` (text parts only, attached quotes included, no files or
  tool payloads), each user message cut to its head and each answer to head
  plus tail. The new request is never cut.
- `runtime.js` — `createRoutingRuntime`: `describe`, `noteModelSelection`,
  `isAutoSession`, `resolveAutoSelection`, `applySessionSelection`, `routeSend`,
  `evaluatePermission`, config and token writes, event broadcasts.
- `routes.js` — `/api/routing` (GET, PUT), `/api/routing/token` (PUT, DELETE)
  and `registerRoutingPromptRewrite`.

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
- Every failure keeps the user's own behaviour. A Jev error, timeout, unknown
  category or low confidence routes to the fallback model; the decision carries
  the reason. A safety-net failure accepts the permission exactly as auto-accept
  would have and broadcasts `openchamber:routing.safety-skipped` with the error.
- A category without a model uses the fallback model *and* variant; a variant
  only travels with the model it was chosen for. A category agent replaces the
  composer's agent; an empty one keeps it.
- Auto is offered (`autoReady`) with `enabled`, a fallback model and at least
  two enabled categories. A key is not among them: see the endpoint rule below.
- Held permission decisions are cached for 15 minutes per request id so
  reconnect reconciliation in `permission-auto-accept` does not re-ask Jev;
  `permission.replied` forgets them.
- The send rewrite reads a body only in a session already marked as routed,
  which the URL alone answers; every other send, and anything that is not JSON,
  reaches the proxy as the stream it arrived as.

## Where a Jev request goes

A saved TypeSafe key wins — the user pasted it and it carries their own quota —
and the request goes to `api.typesafe.ai/v1/systemone` as `jev-latest`. Without
a key the same body goes to `opencode.ai/zen/v1/systemone` as `jev-1.13-free`,
which OpenCode Zen answers with no credential at all, tagged
`x-opencode-client: openchamber`. Dax approved this use in Slack on 2026-09-22
on terms the code and the copy keep together: zen can identify and throttle our
calls through that header, and Settings → Routing tells the user in plain words
that the free model is a limited-time OpenCode promotion that will later need a
key. Zen rejects the `jev-latest` alias, so the versioned free id is sent.

Never make the free tier the only path: the zen docs call it "available for a
limited time", and the key field is what users fall back to when it ends.

## Events

Broadcast on the OpenChamber control stream: `openchamber:routing.updated`
(availability), `openchamber:routing.decision` (per send),
`openchamber:routing.permission-held`, `openchamber:routing.safety-skipped`.

## UI

`packages/ui/src/stores/useRoutingStore.ts` projects `/api/routing` and these
events; `hooks/useRoutingSync.ts` keeps it current and shows the skipped-check
toast. `lib/routing/autoModel.ts` owns the sentinel; `useConfigStore` accepts it
as a valid selection while `autoReady`. `ModelPickerList` renders it as the
pinned `leadingEntry`; `ModelControls` hides the agent and thinking controls
while Auto is selected. `PermissionCard` shows the hold reason. Settings →
Routing (`components/sections/routing/RoutingPage.tsx`) edits the config with
debounced saves and manages the key.

## Tests

`store.test.js` (defaults, deviation round-trip, deleted built-ins, malformed
file, token file mode), `runtime.test.js` (request text, excerpts, decisions,
rewrite and fallback paths, safety net hold/skip/off), `routes.http.test.js`
(sentinel dropped from a create and swallowed on the model switch, routed send
ahead of a stand-in proxy, the routes). The queue and auto-accept tests cover
their hooks.
