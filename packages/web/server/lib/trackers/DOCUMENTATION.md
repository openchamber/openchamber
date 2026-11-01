# Trackers

## Ownership

This module owns the provider-neutral contract for work item trackers: the tracker registry, the `/api/tracker/:provider/*` routes, and the extension layer that lets an installed extension serve a tracker beside the built-ins. Each built-in tracker lives in its own module folder (`../linear/`) and owns its auth, storage and API calls; it plugs in through one registry entry, `{ descriptor, load }`. An extension's tracker (`provides: ["tracker"]`, `contributes.tracker`) is served by this module on the extension's behalf: `extension-trackers.js` keeps the registry in step with the extension catalog, `extension-descriptor.js` builds the descriptor from the manifest, `extension-tracker.js` implements the contract over the extension's service, `extension-accounts.js` keeps its accounts in `{dataDir}/tracker-accounts.json`, `extension-oauth.js` runs its browser sign-in, and `session-origin.js` and `session-status-runtime.js` hold the session comment rules every tracker shares. The types are in `tracker-contract.d.ts`; the shared UI mirrors exactly those shapes.

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

- `createTrackerRegistry(entries, { foreignIds })` returns `has`, `descriptor(id)`, `descriptors()`, `list()` and `implementation(id)`, plus `attachExtension({ descriptor, load })` and `detachExtension(id)` for the extension layer. An unknown id is `null` everywhere, never a throw. `list()` and `descriptors()` answer what is registered now, built-ins first, so every consumer that reads them at call time (routes, the session linker, tracked items, the read cache through `trackerIds: () => trackers.list()`, the session-status fan-out) follows an extension that attaches or detaches.
- A descriptor is plain JSON: id, name, auth methods, capabilities, state filter ids in menu order, URL patterns and the identifier pattern. No icon and no translated text; the UI adds presentation per id with a generic fallback. A URL pattern may name a `query` parameter that carries the identifier instead of the path's first group (`?selectedIssue={id}`), checked against the identifier pattern.
- `auth.status({ origin })` may answer `connect` beside the accounts, what an extension tracker's card needs to connect: the instance, whether an OAuth client is saved, the redirect URI for `origin`. An account may carry `status`, `invalidReason` and `method`. A built-in answers none of these.
- An implementation is loaded on first use and kept. A failed load is not cached.
- Implementations are JSON in, JSON out, with every Linear (or other provider) shape mapped to the neutral one inside the provider's module.

## Routes

- `GET /api/tracker/providers` → `{ providers: TrackerDescriptor[] }`.
- `GET :provider/auth/status` (the request origin goes to the implementation, for the redirect URI), `POST :provider/auth/start` `{ origin, instance? }`, `POST :provider/auth/activate` `{ accountId }`, `DELETE :provider/auth`.
- Extension trackers only, 404 `UNSUPPORTED` elsewhere: `POST :provider/auth/token` `{ token, username?, instance? }`, `PUT :provider/auth/oauth-client` `{ clientId, clientSecret?, instance? }`, and the public `GET :provider/oauth/callback` the tracker redirects the browser to (`opencode/core-routes.js` lets it past UI auth). Their failures carry the status and code the extension layer assigned (a `TrackerRouteError`, `route-error.js`): 400 `INSTANCE_REQUIRED` / `UNSUPPORTED_INSTANCE` / `TOKEN_REQUIRED` / `USERNAME_REQUIRED` / `USERNAME_INVALID` / `CLIENT_MISSING` / `STATE_MISMATCH` / `TARGET_CHANGED` / `OAUTH_DENIED`, 401 `TOKEN_REFUSED`, 404 `UNKNOWN_TRACKER` for a tracker detached meanwhile, 409 `CONNECT_SUPERSEDED` / `INSTANCE_MISMATCH`, 502 `MALFORMED_PROVIDER_RESPONSE`, 503 `TRACKER_UNAVAILABLE`.
- `GET :provider/items/list?query=&cursor=&state=&people=&priority=&containerId=`, `GET :provider/items/get?id=`, `POST :provider/items/update` `{ id, stateId }`, `GET :provider/states?containerId=`.
- `GET|PUT :provider/mapping` (`{ defaultProjectPath, containerProjectPaths }`), `GET|PUT :provider/preferences` (`{ sessionComments }`), `POST :provider/session-status` `{ kind, sessionId, identifier?, sessionOrigin? }`.

Status codes copy the legacy Linear routes: disconnected is 200 `{ connected: false }`; a missing or invalid input and a provider's user error (`code: 'INVALID'` or `userError: true`) are 400 `INVALID`; a `TrackerRouteError` (`route-error.js`, thrown by these routes' input checks and the extension layer alone) answers its own status and code: the connect codes above, 503 for a service that could not be reached, 502 for an answer OpenChamber cannot use, and a provider's own status and code when its answer carried both; any other failure is 500 whatever fields the error carries, so a built-in's errors (Linear's token failures carry a status and a code) answer here as they do on `/api/linear`. An unknown tracker is 404 `UNKNOWN_TRACKER`, an action its capabilities leave out (or its implementation lacks) is 404 `UNSUPPORTED`, an unknown account on activate is 404 `ACCOUNT_NOT_FOUND`, and any other path under `/api/tracker` is 404 `NOT_FOUND`. JSON bodies parse on the route with a 16kb limit.

## Invariants

- Tracker ids are open strings `^[a-z][a-z0-9-]{0,31}$` in the namespace they share with source-control provider ids (tracked-item keys, read-cache keys). The registry refuses malformed ids, the reserved ids (`guest`, `link`, `external`, `repository`), ids a source-control provider owns, and duplicates, by throwing at construction. A built-in never takes an `ext-` id; only `attachExtension` does, with `ext-<guestId>`, and the SDK refuses a manifest that provides both `source-control` and `tracker`, since both would be that id.
- Extension trackers follow the catalog, never an event: a guest is a tracker while it is enabled, fully approved with an effective `service` grant, provides `tracker` and has a parsed `contributes.tracker`. Pause, removal, withdrawn approval and a grant whose scope changed detach it; a tracker detached mid-call refuses its account writes (`dispose`). Removal forgets its accounts, client, mapping and session records ("remove means forget"); a pause keeps them.
- An extension tracker's credentials never leave `extension-accounts.js` but to mint a per-call handle, served on `/tracker/outbound`. A read's handle sends `GET` only; `items.updateState` and `comments.create` may write. `hostAccess` is off for every extension tracker. A 401 the service reports writes an account off only when the proxy saw the server answer 401 through that call's handle, and only at the account revision the call read.
- Every write that follows a remote call is a compare-and-set: a connect commits under the identity `beginConnect` handed out, so a Disconnect meanwhile wins; a token refresh and an invalidation commit against the account's revision, so a delayed answer for a replaced credential changes nothing.
- Only host sessions reach the session-status fan-out and the session linker (the hub rule in `../spaces/DOCUMENTATION.md`); `/api/tracker` is host-only in `spaces/dispatcher.js`. Sessions inside isolated spaces get no tracker comments and no tracker reads.
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

Settings draws browser sign-in for a built-in tracker; the token, OAuth client and server address forms exist for extension trackers (`TrackerSettings` with its `extension` prop). Host access for SDK guests also needs the SDK's `IntegrationHostProvider`, which names `linear` only.

The routes bound what the account store keeps before the implementation is asked (`BOUNDS` in `routes.js`: token 4096, username 256, address 2048, client id 512, client secret 4096, project paths 4096, container ids 256, session-status identifier 128), so an over-long value never reaches the service for verification and then fails on the write.

`session-status.js` fans out host events only: `server/index.js` subscribes to the hub without spaces, and an event that still arrives marked with a space id is dropped, because a session inside an isolated space runs its own OpenCode and its own trackers, and a comment with the host's link could never open it.

## Extension trackers

The SDK role (`packages/sdk/GUEST_SERVICES.md`, *Tracker*) and these modules together:

- `extension-trackers.js` runs at start and on every `onGuestActivated` / `onGuestDeactivated`, and again when a tracker's instance is set or cleared (the adapter asks). It builds the descriptor (`extension-descriptor.js`), creates the adapter and attaches both; a guest that stopped being eligible is detached, its session-status runtime forgotten, its handles revoked. A replacement (new version, grant change, the first server connected) disposes nothing: pending sign-ins and connects the old adapter started commit through the store's own identities, whichever adapter finishes them; only the session-status runtime, which closed over the old adapter, is forgotten and rebuilt from the new one. Changes are announced to clients as `openchamber:tracker-providers-changed`, which the UI answers by reading the tracker list and every status again.
- `extension-descriptor.js` compiles the manifest's link templates (`/browse/{id}`, `/{segments+}?selectedIssue={id}`) into bounded patterns against the one instance the accounts live on; the templates, the patterns they compile to and the links each names are pinned in one table with the UI (`packages/ui/src/lib/trackers/extensionLinkCases.fixture.ts`), so the compiler and the two matchers cannot drift; a `user` instance is known only once connected, so until then the descriptor carries no link patterns. The identifier pattern comes from the declared shape (`key-number`, `number`, `short-code`); identifiers are compared upper-cased everywhere, as the contract says.
- `extension-tracker.js` forwards the reads and the two writes to the service with a handle per call, re-reads the guest's catalog row before every call (enterprise policy applies on each read), sets `provider` on every item, answers a `list` whose query is a link its patterns claim or an identifier of the declared shape by `items.get` as a page of one (what `listLinearIssues` does with `parseLinearIssueRef`, so the picker's paste works the same for both; a bare word `items.get` answers null for is searched after all, since a `short-code` shape claims most words), reports every stored account written off as `connected: false` with the accounts listed (the card shows the attention state and can remove them), lets a client saved before any account pin no server (the typed address wins until an account lives there; with accounts, another typed address is `INSTANCE_MISMATCH`), takes the OAuth callback's state before reading its `error` (the callback is public: an answer with no matching state cancels nothing), checks a session-status identifier against the declared shape, refuses a full tracker (32 accounts) before the service or the browser is asked anything (`ACCOUNTS_FULL`), treats a service that does not answer in time as unavailable (the proxy's `REQUEST_FAILED`, `SERVICE_FAILED`, `NO_SERVICE`: nothing is written off, each method's deadline is the SDK's `trackerProviderTimeoutMs`), skips the session record after removal, keeps the project mapping and the session comment preference, and posts session comments with the rules Linear applies (`session-origin.js`: a label and a link to a public origin only, once per kind per session, `started` first).
- `extension-accounts.js` holds one instance per tracker with up to 32 accounts (a pasted token, or OAuth tokens bound to the endpoints they were minted for), the OAuth client bound to those endpoints, the mapping, the preference and up to 500 session records; the last account leaving forgets the server, the client and the mapping. A session record merges its kind flags with the stored ones (two posts in flight each read before the other wrote), and records, mapping and preferences are never written for a tracker without a section, so a post that finishes after removal leaves nothing behind. `cancelConnect(id, expected)` drops a pending connect only while it is still that one.
- `extension-oauth.js` is PKCE S256 with a state only this process knows; the exchange and the refresh use the guest integration's helpers, so the two cannot drift.

## Decisions

### Why the registry lives on the server and descriptors are served, not compiled into the UI

The phone app bundles its UI and talks to servers of other versions, so the server says which trackers exist. The UI keeps a snapshot for first paint and a per-id presentation table (icon, translated nouns), because translated text cannot come from the server.

### Why `/api/linear/*` stays next to `/api/tracker/linear/*`

Older bundled phone UIs call the Linear routes, and the SDK documents `GET /api/linear/issues/get` for host-Linear guests. `/linear/oauth/callback` is the redirect URI registered with Linear. Both route sets call the same Linear functions (auth steps are shared through `../linear/auth-status.js`); removing the alias needs its own decision.

### Why live summaries carry `state.type` as well as `state.category`

Older bundled phone UIs read Linear's `state.type` from tracked-item states. The adapter adds it during the alias window; newer client schemas strip it.

### Why capability-gated routes answer 404 `UNSUPPORTED` instead of not existing

An unregistered path under `/api` falls through to the generic OpenCode proxy. An explicit answer keeps the request here and lets a client tell "this tracker cannot" from "this server is older".

### Why extension trackers attach to the one registry instead of a second one

Every consumer (routes, the read cache, tracked items, the session linker, the session-status fan-out, host access) asks one registry, and the UI draws whatever `GET /api/tracker/providers` lists. A second registry would need every consumer to ask twice and merge. The built-ins stay fixed at construction, so a broken extension can never take a built-in's place or id.

### Why the descriptor's link patterns follow the connected server

A link pattern needs a host, and a `user` instance has none until the user connects one. Publishing a pattern with a placeholder host would match nothing or everything; rebuilding the descriptor on connect and disconnect keeps `matchUrl`, the UI's matcher and the session linker on the same server the accounts live on.

### Why the OAuth client and the tokens are bound to their endpoints

A refresh token and a client secret travel to the token endpoint. A package update that moves the endpoints would otherwise carry them to a new server; binding both to the endpoints they were entered or minted for means a moved package gets no old secret and no refresh, and the grant scope asks the user again.

### Why reads may overlap and the service is told so

The picker, the preview and the board read at once. The notification role promised one call at a time because a channel delivers in order; a tracker's reads have no order to keep, so they go out as they come, and the contract says so. Writes are per call, each with its own handle.
