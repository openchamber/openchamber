# Routing

## Purpose

Jev model routing and the permission safety net. With the `openchamber/auto`
model selected, the server asks [Jev](https://docs.typesafe.ai) (TypeSafe's
System One decision model) which task category a message belongs to and sends
it with that category's model, thinking variant and agent. With the safety net
on, the same call decides whether an auto-accepted permission should stay on
screen for the user instead.

Dark by default: `OPENCHAMBER_ROUTING_ENABLE` (`feature-flag.js`, read per call)
gates the routes, the request rewrite, the settings page and the Auto row. VS
Code has no OpenChamber server and never offers Auto.

## Files

- `feature-flag.js` — the env gate.
- `defaults.js` — the Auto sentinel, Jev endpoint, built-in categories, the
  question wording for routing and for the safety net, history excerpt limits.
- `store.js` — `routing.json` (only deviations from the built-ins) and
  `routing-auth.json` (the Jev key alone, mode 0600) in the OpenChamber data
  dir. `resolveEffectiveConfig` merges built-ins with stored overrides;
  `toStoredConfig` is its inverse. A missing file is the defaults, a malformed
  one throws.
- `jev.js` — request builders, answer parsing, the HTTP call with a timeout.
- `history.js` — the last three settled turns through session assist's
  `loadAssistContext` (text parts only, attached quotes included, no files or
  tool payloads), each user message cut to its head and each answer to head
  plus tail. The new request is never cut.
- `runtime.js` — `createRoutingRuntime`: `describe`, `resolvePromptBody`,
  `evaluatePermission`, config and token writes, event broadcasts.
- `routes.js` — `/api/routing` (GET, PUT), `/api/routing/token` (PUT, DELETE)
  and `registerRoutingPromptRewrite`.

## Invariants

- The sentinel never reaches OpenCode. `resolvePromptBody` rewrites
  `body.model` in place for `POST /api/session/:id/{prompt_async,prompt,command}`
  ahead of the generic proxy (which replays a parsed body), inside the
  message queue's `sendItem`, and in the OpenChamber session service's own
  dispatch (`openchamber-sessions/routes.js`), which posts to OpenCode directly
  and can pick Auto up from Session Defaults. Without a fallback model it
  throws 400 rather than forwarding.
- Every failure keeps the user's own behaviour. A Jev error, timeout, unknown
  category or low confidence routes to the fallback model; the decision carries
  the reason. A safety-net failure accepts the permission exactly as auto-accept
  would have and broadcasts `openchamber:routing.safety-skipped` with the error.
- A category without a model uses the fallback model *and* variant; a variant
  only travels with the model it was chosen for. A category agent replaces the
  composer's agent; an empty one keeps it.
- Auto is offered (`autoReady`) only with the flag, `enabled`, a saved key, a
  fallback model and at least two enabled categories.
- Held permission decisions are cached for 15 minutes per request id so
  reconnect reconciliation in `permission-auto-accept` does not re-ask Jev;
  `permission.replied` forgets them.
- The rewrite parses JSON only while the flag is set, so a build without it
  leaves the proxy stream untouched.

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
(rewrite ahead of a stand-in proxy, routes, flag off). The queue and
auto-accept tests cover their hooks.
