# Permission Auto-Accept

## Purpose

This module owns the authoritative per-session permission policy for web, desktop, and mobile runtimes. Policy is persisted in OpenChamber settings so permission handling survives UI disconnects and server restarts.

## Policy

Each session has a mode (`modes.js`):

- `ask`: every request waits for the user.
- `safety`: a request is accepted when the safety net (Jev, `../routing/DOCUMENTATION.md`) says the user need not decide; otherwise it waits. Without a usable classification provider, or when Jev fails, it waits.
- `auto`: every request is accepted.

`permissionAutoAccept.sessions` maps session ids to modes. Inheritance uses the nearest explicit session value, so a child `ask` overrides a parent `auto`; descendants without an explicit value inherit from their nearest configured ancestor.

Policies written before the modes stored booleans. The first read converts them and persists the result once: `false` becomes `ask`, `true` becomes `safety` when the old global safety-net switch in the routing config was on and `auto` otherwise (`resolveLegacyEnabledMode`). The settings sanitizer accepts both shapes so the converting write and older files pass.

## Default mode

`permissionDefaultMode` (Settings → Sessions) is written onto each new top-level session when `session.created` arrives, and only when no policy exists for it yet: a mode the creating flow already set wins, and changing the default never reaches back into older sessions. Subagents inherit instead. `ask` writes nothing. Mode resolution waits for pending writes, so a session's first permission request sees its default.

## Runtime

`createPermissionAutoAcceptRuntime` loads and serializes policy writes, subscribes to the global OpenCode event hub, caches session lineage, retries transient replies, and reconciles pending permissions after startup, reconnect, and when a session moves to `safety` or `auto`. It keeps handling requests without a connected UI.

Unknown lineage and failed policy loads fail closed (`ask`). A failed pending-permission fetch is distinct from an empty successful response and never clears policy state.

## Safety net

`evaluatePermission` (the routing runtime) is consulted in `safety` sessions only, before the reply. Only `accept` replies; anything else counts the request as handled without replying, so it stays on screen. A `permission.replied` event is passed to `onPermissionReplied` so the routing runtime forgets its cached decision.

Each request's outcome (`replied`, `held`, `ignored`, `failed`) is kept for a bounded while. `isPermissionAutoAnswered` lets notifications skip only a request that was actually answered: a held one still notifies.

### Review visibility

The runtime owns permission dispositions. An operation's bounded admission lease covers policy lookup, classification, and automatic reply retries. Concurrent processing shares the operation and its deadline. Accepted verdicts are reused across retries; the routing runtime still owns cached classifications.

Every disposition change increments a runtime-global revision and broadcasts `openchamber:permission-review.updated`. Its `properties` are `{ dispositionVersion: 1, instanceId, revision, permissions: [{ permissionId, remainingMs, phase }] }`. Phase is `admitting`, `reviewing`, `answered`, or `manual`. Instance ID identifies the runtime incarnation; revision is a nonnegative integer. Positive leases last at most 25,000 ms across all automatic phases. Manual entries have zero remaining time and grant permission to show controls, not permission to run a tool. Reads never renew deadlines. State is not persisted.

Pending transports and SDK ingestion carry no disposition metadata. The UI hides an unknown request during a bounded OpenChamber HTTP lookup. Ask can wait for that lookup but does not wait for Jev. The lookup resolves unknown IDs using upstream permission reads and policy resolution, then starts automatic processing without awaiting classification. Missing IDs in a snapshot remain unknown. Explicit manual outcomes survive hold/error-before-pending and reload. The server retains at most 1,000 manual outcomes, removes them when replied, and bounds answered retention by the original lease. An evicted ID requires another authoritative lookup.

The constructor requires `broadcastPermissionReviewEvent`, wired to the OpenChamber control-stream broadcaster in `server/index.js`. Review events reach the control SSE clients consumed by `useRoutingSync`. The existing `broadcastGlobalUiEvent` dependency still sends `openchamber:permission-auto-accept.updated` to notification SSE clients for policy synchronization. Both broadcasters share the WebSocket client set. A missing review broadcaster fails construction rather than silently sending reviews to the notification stream.

Ask, unavailable classification, hold, policy/evaluator failure, exhausted reply retries, cancellation, expiry, and stop release admission. Successful replies and `permission.replied` change the disposition to `answered` within the original deadline, rather than clearing it before raw removal reaches the UI. A manual reply, expiry, or stop prevents late classification from starting an automatic reply. Only a reply endpoint's 404 counts as already answered; a classifier's 404 is a failure. Duplicate deliveries reuse remembered outcomes; explicit mode enablement can retry pending requests.

An authoritative `permission.replied` event settles an in-flight outcome as `replied`, even when it arrives before the automatic POST response. Notifications then skip the answered request. Expiry and stop settle as `held` instead.

Before every automatic POST, the runtime rechecks committed policy, cancellation, and the original monotonic deadline after asynchronous work. An elapsed deadline blocks the reply even before its expiry timer runs. Changing a policy to `ask` cancels in-flight operations whose current inherited mode becomes `ask`; explicit child overrides and unrelated sessions retain their reviews.

If `auto` becomes `safety` during processing, a request without an accepted classifier verdict stays pending. Each operation passes an abort signal through the routing evaluator to Jev. Cancellation aborts that call and prevents late classifier warnings, held events, or cached decisions from restoring a replied request's state.

## Routes

- `GET /api/permission-auto-accept` answers `{ sessions, modes, revision, review }`. `modes` is the policy; `sessions` is its on/off view (`ask` is off) for clients from before the modes. `review` is the same complete snapshot carried by the review event. Older servers omit it.
- `POST /api/permission-auto-accept/dispositions` accepts `{ requests: [{ id, sessionID, directory? }] }`, at most 100 entries, and returns the disposition snapshot. An empty batch reads current state. Unknown requests are read from OpenCode rather than trusting client-supplied permission content. Only an upstream 404 establishes answered state. Other read failures return 503, never a fabricated empty success. This endpoint does not await Jev.
- `PUT /api/permission-auto-accept/sessions/:sessionId` takes `{ mode, directory }`; a body with only `enabled` (older clients, VS Code's bridge shape) means `auto` or `ask`.

These are normal authenticated OpenChamber runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/permissionStore.ts` is a projection of server policy and does not persist an independent policy. The server is the sole responder and the UI renders pending requests until the authoritative `permission.replied` event arrives. The composer's shield button cycles ask → safety → auto, skipping `safety` while no classification provider can run it (a `safety` session then shows as `ask`).

Web, Electron, hosted mobile, and Capacitor share a presentation gate in `usePermissionReviewStore`. Unknown requests are hidden during a lookup with a five-second deadline. Positive admitting/reviewing/answered dispositions remain hidden until raw removal or lease expiry. Manual outcomes show controls. Lookup failure, timeout, unsupported response, and disconnect expose controls permanently for every affected request within the runtime. Reconnect cannot hide them again. Runtime switch resets ownership and invalidates reads. Revision and instance checks reject stale snapshots; repeated snapshots do not extend deadlines. The UI retains at most 10,000 request records per runtime and exposes new requests at capacity rather than evicting sticky fallback records. Raw pending always blocks submission independently of this gate. VS Code and isolated-space permissions bypass the host gate.

Older servers lack the disposition endpoint or version marker. Their controls become usable through failure fallback, but mixed versions cannot guarantee flicker-free presentation. The policy store continues owning policy reads; disposition lookup no longer duplicates its GET request.

Manual visibility is not a transfer of ownership. Client fallback, including disconnect, does not cancel remote classification. The server can still accept while visible controls await a reply. The original server deadline cancels expired classification, and an actual manual reply cancels the in-flight operation when its authoritative reply event arrives.

VS Code retains its foreground-only responder because it does not run the web server runtime. Its extension host persists and broadcasts an on/off policy across webviews, so VS Code has only `ask` and `auto` and no default mode. The active UI handles live events plus startup, reconnect, and enablement reconciliation. With all OpenChamber webviews closed or suspended, permissions are not auto-accepted; this is an intentional VS Code limitation.

## Tests

`runtime.test.js` covers restart persistence, on/off requests, the one-time conversion of pre-modes policies, the default mode on new sessions, nearest explicit subagent inheritance, missing-lineage lookup, retry/deduplication, reconnect reconciliation, the safety net's hold and accept, and which outcomes notifications may skip.

Review tests cover deferred evaluation and reply, hold/unavailable/timeout/error outcomes, reply retry exhaustion, complete concurrent snapshots, decreasing leases, manual-reply races, expiry, and stop cleanup.

Tests exercise the batch HTTP contract, unknown Ask lookup without Jev, held/error/unavailable reload outcomes, and failed versus missing upstream reads. UI render tests independently reorder raw pending/control and answered/raw-reply deliveries while asserting raw pending remains until replied. Store tests cover lookup deduplication, missing IDs, timeout, sticky fallback, disconnect, runtime reset, and VS Code bypass. Transport tests continue exercising generic forwarding without permission-specific enrichment.
