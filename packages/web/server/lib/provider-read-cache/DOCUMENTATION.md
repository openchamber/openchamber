# Provider read cache

## Ownership

This module owns the short-lived shared answers for provider reads on the source-control and tracker routes: issue and pull request lists, previews, comments. It answers a repeated `GET` from memory, joins identical reads that are in flight, and serves `POST <prefix>/read-cache/refresh` for a change made on the provider's own site. It holds no provider data and performs no provider call itself. `opencode/feature-routes-runtime.js` registers it before the provider routes and passes its own invalidation callbacks.

The prefixes are built from the two registries: `/api/source-control/<id>` per source-control provider, `/api/tracker/<id>` per tracker, plus the legacy `/api/linear` alias, which is the same provider as `/api/tracker/linear`.

`createProviderReadCache({ sourceControlProviderIds, trackerIds, now, onChange, onItemRefresh })` returns `{ middleware, clear }`. `sourceControlProviderIds` defaults to the registered source-control ids. `trackerIds` is a list, or a function answering the list as it is now, for a registry that changes while the server runs. `onChange(provider)` reports that a provider's answers were forgotten after a change or a refresh without a scope, so the live state the server follows is read again. `onItemRefresh(provider, item)` reports the one item a scoped refresh named.

## Invariants

- The middleware is registered before the provider routes. A request that it does not answer passes to the provider route, which may still be read into the cache.
- A key is `provider|prefix|path?sorted query`. The query carries the bound read context (account, repository, binding revision), so one key is exactly one answer. The key names the provider and the prefix it was read under, so a refresh that matches by subpath slices each kept answer with its own prefix; the legacy alias is shorter than the tracker route.
- Only a status `200` answer that is not `{ connected: false }` is kept. A failure or a disconnected answer is never replayed.
- A response body larger than 2 MiB is served but not kept, which covers a merge request context with its diff. The cache holds at most 300 entries and evicts the oldest first.
- List and status reads live 30 seconds; preview, comment, and single-item reads live 15 seconds. Lists change when something is opened or closed, while previews and comments are read again sooner while someone is looking at one.
- `POST <prefix>/references/across` is a read: its request is too large for a query. It changes nothing, so it neither clears answers nor counts as a change.
- Any other non-`GET` request to a provider route is a change: on a finish with status below 400 it forgets every kept answer of that provider and reports `onChange`. Mutations, sign-in and account switch arrive this way, as does an agent turn finishing through the caller's own invalidation.
- `POST <prefix>/read-cache/refresh` has four shapes. `?scope=item&owner=&repo=&number=` forgets what was read about that one source-control item and reports `onItemRefresh`; `?scope=item&identifier=` does the same for a tracker item; `?scope=lists` forgets the lists and the statuses read for them; without a scope every answer of the provider goes, as for a change.
- A refresh may forget one answer too many. `answerIsAbout` and `trackerAnswerIsAbout` match a status read that asked for the item, a search that looked it up by link or number, and a read without a project by number alone; forgetting an answer that was still relevant only costs one provider read.
- A tracker read about one item is its own `/items/get` or `/issues/get` read, whose body names the item by the provider's id, or a list read whose query is the identifier. A read still in flight has no body, so an item refresh forgets it.
- A request that was already running when its provider changed still answers its own callers, but its result is not kept. `clear` marks those flights stale.
- Identical reads in flight join the first one. A joiner answers from the first result when that result is shareable, and otherwise asks on its own.
- A handler that answered some other way, such as a stream or an error page, shares nothing. The response `close` event settles its flight with no answer.
- Tracker ids are read at call time through `hasTracker`, because an extension's tracker attaches and detaches while the server runs. Source-control prefixes are fixed at start.

## Decisions

### Why over-forget on a scoped refresh

Matching a kept answer to the item a refresh names is a heuristic: a search may carry a link, a number, or an identifier, and a status read names several items at once. The cache prefers to forget a relevant answer it could have kept. A missed forget would show a stale answer after the user asked for a refresh; a needless forget costs one provider call.

### Why in-flight reads are joined and not replayed

Identical reads within a few seconds cost one provider call when the first is still running. The joiner has to survive a first request that produces nothing shareable, such as an error or a stream, so the first answer is nullable and a joiner without one asks the provider itself. Replaying the first request's raw response is not possible without buffering every response, including the large ones the cache deliberately does not keep.
