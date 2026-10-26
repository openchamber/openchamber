# Trackers

## Ownership

This module owns the provider-neutral contract for work item trackers (Linear today): the tracker registry and the `/api/tracker/:provider/*` routes. Each tracker lives in its own module folder (`../linear/`) and owns its auth, storage and API calls; it plugs in through one registry entry, `{ descriptor, load }`. The types are in `tracker-contract.d.ts`; the shared UI mirrors exactly those shapes.

Repository issues (GitHub, GitLab, Gitea) are not trackers. They belong to the source-control registry (`../source-control/`), because they are read through a project's binding and share lists, caches, live state and mutations with pull requests. A tracker item belongs to a server-wide account and has no directory.

`server/index.js` builds the one registry (with the source-control ids as `foreignIds`, so an overlap fails at startup) and hands every session event to `session-status.js`, which creates one session-status runtime per tracker whose implementation has `sessionStatus.createRuntime`. The first event loads the tracker and creates its runtime; events that arrive during the load are kept and handed over, and a failed load is retried on a later event (no sooner than 30 s after the failure), so a transient import failure never silences a tracker's session comments until restart. `opencode/feature-routes-runtime.js` hands the registry to:

- these routes, registered before the legacy `registerLinearRoutes`;
- the read cache (`provider-read-cache`), which keys `/api/tracker/<id>/` and the `/api/linear` alias as the same provider and answers `POST /api/tracker/<id>/read-cache/refresh`;
- tracked items, whose `workItems` reader calls `liveSummaries` and answers `disconnected` for an id the registry does not know;
- guest routes, where a host-auth guest borrows a tracker's `hostAccess` when its descriptor allows it (`guests/host-session.js`).

`openchamber-sessions/session-link.js` gets it from `index.js` and turns an item link a tracker's `matchUrl` claims into a linked entry `{ id: '<provider>:<IDENTIFIER>', kind, provider, identifier }`. `/api/tracker` is host-only in `spaces/dispatcher.js`.

### Why a Linear link is stored as `kind: 'linear'` and not `kind: 'tracker'`

Older bundled UIs know only `kind: 'linear'`. They leave every other kind out of the list they show and rebuild that list when they write a link, so a Linear entry stored as `tracker` would disappear from session metadata the next time such a client links something. While the `/api/linear` alias serves those UIs, a Linear entry is written as `kind: 'linear'` with `provider: 'linear'` beside it, and only other trackers, which older UIs cannot show anyway, are written as `kind: 'tracker'`. Readers (`session-linked-issues.js`, the UI) accept both kinds. Drop this rule together with the alias.

## Contract

- `createTrackerRegistry(entries, { foreignIds })` returns `has`, `descriptor(id)`, `descriptors()`, `list()` and `implementation(id)`. An unknown id is `null` everywhere, never a throw.
- A descriptor is plain JSON: id, name, auth methods, capabilities, state filter ids in menu order, URL patterns and the identifier pattern. No icon and no translated text; the UI adds presentation per id with a generic fallback.
- An implementation is loaded on first use and kept. A failed load is not cached.
- Implementations are JSON in, JSON out, with every Linear (or other provider) shape mapped to the neutral one inside the provider's module.

## Routes

- `GET /api/tracker/providers` → `{ providers: TrackerDescriptor[] }`.
- `GET :provider/auth/status`, `POST :provider/auth/start` `{ origin }`, `POST :provider/auth/activate` `{ accountId }`, `DELETE :provider/auth`.
- `GET :provider/items/list?query=&cursor=&state=&people=&priority=&containerId=`, `GET :provider/items/get?id=`, `POST :provider/items/update` `{ id, stateId }`, `GET :provider/states?containerId=`.
- `GET|PUT :provider/mapping` (`{ defaultProjectPath, containerProjectPaths }`), `GET|PUT :provider/preferences` (`{ sessionComments }`), `POST :provider/session-status` `{ kind, sessionId, identifier?, sessionOrigin? }`.

Status codes copy the legacy Linear routes: disconnected is 200 `{ connected: false }`; a missing or invalid input and a provider's user error (`code: 'INVALID'` or `userError: true`) are 400 `INVALID`; any other failure is 500. An unknown tracker is 404 `UNKNOWN_TRACKER`, an action its capabilities leave out (or its implementation lacks) is 404 `UNSUPPORTED`, an unknown account on activate is 404 `ACCOUNT_NOT_FOUND`, and any other path under `/api/tracker` is 404 `NOT_FOUND`. JSON bodies parse on the route with a 16kb limit.

## Invariants

- Tracker ids are open strings `^[a-z][a-z0-9-]{0,31}$` in the namespace they share with source-control provider ids (tracked-item keys, read-cache keys). The registry refuses malformed ids, the reserved ids (`guest`, `link`, `external`, `repository`), ids a source-control provider owns, and duplicates, by throwing at construction.
- Persisted identity strings do not change: tracked-items key `${provider}|${IDENTIFIER}`, tab key `${provider}:${IDENTIFIER}`, linked id `${provider}:${IDENTIFIER}`. The UI characterisation tests (`packages/ui/src/lib/trackers/linearIdentity.characterization.test.ts`) pin the Linear values.
- A list `state` must be one of the descriptor's `stateFilters`; a people or priority filter the descriptor does not offer is 400, never ignored.
- Tokens never leave the server. `hostAccess.accessToken()` is for the guest proxy, which keeps it on `hostAccess.apiOrigin`.
- `/api/tracker` is host-only in `spaces/dispatcher.js`; a route added here is covered by that prefix.

## Adding a tracker

A tracker is one module folder under `server/lib/<id>/` plus one registry line. `../linear/` is the reference.

- `tracker.js` exports the registry entry `{ descriptor, load }`. The descriptor is the plain JSON of `TrackerDescriptor`; `load()` imports the tracker's libraries on first use and returns a `TrackerImplementation`.
- The implementation maps the tracker's own shapes to the neutral contract inside its module: state categories, priorities, container, children, people and accounts. `matchUrl` follows the descriptor's `urlPatterns`, and a URL table fixture shared with the UI pins both sides.
- Optional parts follow the capabilities: `mapping` for `projectMapping`, `preferences` and `sessionStatus` for `sessionComments`, `hostAccess` for `hostAccess`. A route whose part is missing answers 404 `UNSUPPORTED`.
- Auth, storage and API calls stay in the folder, with tests beside each file and a `DOCUMENTATION.md`.
- One entry in `BUILT_IN_TRACKERS` (`registry.js`). The id must not be a source-control id or a reserved id; the registry throws at startup otherwise.

On the server nothing else changes: the routes, read cache, tracked items, session links and the session-status runtime (`sessionStatus.createRuntime`) pick the tracker up from the registry, and `/api/tracker` is already host-only in spaces.

The UI draws a served tracker from its descriptor: a board tab, a picker row, the Settings card with mapping and session comments where the capabilities allow, links it claims, and state colours by category.

Translated text cannot come from the server, so `packages/ui/src/lib/trackers/presentation.ts` holds per id the mark, the sentences that name the tracker, its branch prefix and its Settings search words. Without an entry a tracker gets a generic mark and Linear's sentences until the generic `{provider}` keys exist, so a real tracker adds its entry and translations.

Settings offers browser sign-in only; a tracker with `authMethods: ['token']` needs a token form first. Host access for SDK guests also needs the SDK's `IntegrationHostProvider`, which names `linear` only.

## Decisions

### Why the registry lives on the server and descriptors are served, not compiled into the UI

The phone app bundles its UI and talks to servers of other versions, so the server says which trackers exist. The UI keeps a snapshot for first paint and a per-id presentation table (icon, translated nouns), because translated text cannot come from the server.

### Why `/api/linear/*` stays next to `/api/tracker/linear/*`

Older bundled phone UIs call the Linear routes, and the SDK documents `GET /api/linear/issues/get` for host-Linear guests. `/linear/oauth/callback` is the redirect URI registered with Linear. Both route sets call the same Linear functions (auth steps are shared through `../linear/auth-status.js`); removing the alias needs its own decision.

### Why live summaries carry `state.type` as well as `state.category`

Older bundled phone UIs read Linear's `state.type` from tracked-item states. The adapter adds it during the alias window; newer client schemas strip it.

### Why capability-gated routes answer 404 `UNSUPPORTED` instead of not existing

An unregistered path under `/api` falls through to the generic OpenCode proxy. An explicit answer keeps the request here and lets a client tell "this tracker cannot" from "this server is older".
