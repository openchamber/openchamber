# Server frame

## Ownership

This module owns the frame around the feature runtimes: CLI options and the direct-execution entry, base bootstrap, common request middleware, the status, auth and access routes, static and feature route composition, the startup pipeline, listening and process handlers, and graceful shutdown. `../../runtime.js` composes the server from these pieces (`../../DOCUMENTATION.md`); each feature owns its routes in its own folder.

## Invariants

- Private diagnostic exports check the socket peer and reject relayed requests because forwarding headers do not prove that the caller is on this machine. Pairing redemption rate limits also use the socket peer because that endpoint is unauthenticated and forwarding headers can change a bucket.
- Learned server addresses carry the stable signing-key identity so clients can verify an address before sending it a bearer token. Reachable non-loopback browser origins supplement interface discovery because a reverse-proxy domain may be the only usable direct address.
- UI sessions and the desktop shell's local client can manage all devices; other client tokens are limited to their own record. Push registrations are removed before revoked device rows, while their ownership can still be identified; cleanup failure preserves rows for retry. A revocation already persisted remains successful if its later push cleanup fails.
- The repository credential helper authenticates with its own per-start secret and same-machine restriction. It cannot obtain a UI session, so the common session guard exempts its exact route and leaves authority checking to the helper route. Sandboxed preview and extension reads similarly rely on path grants, and OAuth callbacks rely on issued state.
- Shutdown closes guest admission and stops event subscribers and wait checks in the same tick. Otherwise a healthy service can receive a shutdown refusal through a still-active subscriber and be classified as broken or backed off.

## Decisions

### Why static assets and service workers use different cache lifetimes

Vite asset filenames identify their content, so immutable caching avoids revalidation round trips for lazy chunks over remote connections. Service workers need short-lived responses so clients, including iOS, can discover updates.

### Why isolated exceptions keep serving and not always stop the host

A server embedded in Desktop or launched manually may have no supervisor to restart it after a stray socket exception. It logs isolated exceptions and keeps serving; a sustained exception storm triggers shutdown because continued operation is no longer reliable.

### Why route inputs remain unchecked fields

The core routes forward client and pairing inputs to their owning validators.
The body accessor checks only presence and keeps each field unknown, including
properties inherited from non-null values. URL, header, query, boolean and
error-status checks still establish the specific values used here.

### Why absent passkey handlers still fail

The password-free auth controller has no passkey rename handler. Calling that
route still forwards a TypeError through the existing error path. A null or
undefined configuration-refresh rejection likewise retains its property-access
TypeError after setting status 500.

### Why a missing diagnostic port is omitted

The server port getter returns null before a port is known. The local-file
collector accepts an optional number and selects a web log only for a positive
integer, so omitting the null port preserves its source selection.

## Modules

- `cli-options.ts`: CLI and environment option parsing for server startup.
- `cli-entry-runtime.ts`: direct-execution detection, option parsing and server bootstrap.
- `bootstrap-runtime.ts`: base app route wiring.
- `core-routes.ts`: status, auth, access and settings utility routes.
- `server-utils-runtime.ts`: OpenCode proxy wiring, readiness, path and snapshot helpers.
- `static-routes-runtime.ts`: static assets, SPA fallback and manifest route wiring.
- `packages/web/server/lib/server-frame/feature-routes-runtime.ts`: feature route composition runtime for dynamic import-backed config/skill/provider route registration. Source-control provider registration is delegated to `lib/source-control/routes.js`. One exact persisted-credential resolver, including optional revision pinning, is shared by transport binding, clone planning, contributor transfer, execution, and safe HTTPS binding-read presentation. The managed SSH inventory supplies the matching verified-fingerprint projection without exposing its key record or path. Server composition supplies one durable worktree-bootstrap store to both Git and OpenChamber-session routes; the runtime exposes a lazy bound-checkout hydration adapter so session-created worktrees use the same local inspection and exact parent authority rules as Git-route worktrees.
- `startup-pipeline-runtime.ts`: startup orchestration for terminal, proxy, static routes and listener.
- `server-startup-runtime.ts`: listener startup, tunnel startup and process handlers.
- `shutdown-runtime.ts`: graceful teardown. It stops [chat-directory cleanup](../chat-directories/DOCUMENTATION.md) before the watcher and OpenCode so pending checks cannot start a removal during teardown.

## Public exports (bootstrap-runtime.js)
- `createBootstrapRuntime(dependencies)`: creates runtime for base app route bootstrap and UI auth controller initialization.
- Returned API:
  - `setupBaseRoutes(app, options)`

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`: open before login, because the CLI matches `pid` against its pid file to recognise its own server. `port` and `tunnelUrl` are included only for a caller `isRequestAuthorized` accepts.
- `isRequestAuthorized(req, res, { tunnelAuthController, uiAuthController })`: whether a request carries credentials `/api` would accept, without refusing it. Routes open before login use it to leave private details out.
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
   - `PATCH /api/passkeys/:id`
   - `DELETE /api/passkeys/:id`
   - `POST /api/auth/reset`
   - `GET /connect`
   - `POST /api/system/probe-url`
   - `app.use('/api', ...)` auth/tunnel guard. It lets through only the repository credential helper, guest/tracker OAuth callbacks, the MCP OAuth callback, html previews and extension frame reads, each by its exact GET path; the owning route then checks the grant, secret or state.
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`
  - `POST /api/config/reload` — restarts OpenCode on request. Config edits no longer need it; it stays for the changes that cannot be hot-applied (OpenCode binary, port, managed/external switch) and as a manual recovery. Managed OpenCode restarts and returns `requiresReload: true`. External OpenCode returns `requiresManualRestart: true` (changes are already on disk; the connected server must be restarted outside OpenChamber).
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
  - URL-encoded parser setup
  - request logging middleware
  - `dependencies.skipBodyParsing(req)` names a request both parsers leave alone, so its body reaches its route untouched; the isolated-spaces dispatcher uses it for a request to a space, by the space directory its query or headers name or by the `/api/spaces/<id>/...` prefix, which it streams into a space

## Public exports (cli-options.js)
- `parseServeCliOptions(options)`: parses serve CLI flags and environment-derived defaults:
  - Port/host/ui-password
  - Tunnel provider/mode/config/token/hostname
  - Legacy `--tunnel` shorthand normalization

## Public exports (cli-entry-runtime.js)
- `runCliEntryIfMain(dependencies)`: detects direct CLI execution and runs server startup with parsed CLI options.

## Public exports (server-utils-runtime.js)
- `createServerUtilsRuntime(dependencies)`: creates server utility runtime for OpenCode orchestration helpers.
- Returned API:
  - `setOpenCodePort(port)`
  - `waitForOpenCodePort(timeoutMs?)`
  - `buildAugmentedPath()`
  - `parseSseDataPayload(block)`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Daemon signals, `POST /api/system/shutdown`, and embedded `stop()` share one shutdown promise. Guest admission closes synchronously before any await. Cleanup stops the relay reconciliation timer, guest viewers, realtime proxy, relay host, dictation worker and session runtimes before draining guest services, including pending starts. Each cleanup is best-effort and runs once per shutdown, including after partial startup. A hard kill skips all of this. Guest services it leaves running are stopped by the next host start through the guest service registry (`../guests/DOCUMENTATION.md`, Crash recovery); managed OpenCode has its own registry (`../opencode/DOCUMENTATION.md`).
- Register TCP connection tracking before the HTTP server starts listening. After stopping owned runtimes and OpenCode, HTTP shutdown closes the listener and all remaining sockets, including WebSocket upgrades and unanswered upgrade requests accepted during cleanup. This prevents client reconnects from holding Desktop open until the HTTP close deadline. Each runtime still owns its protocol cleanup; socket teardown runs afterwards and preserves the existing terminal and process grace periods.
- Returned API:
  - `gracefulShutdown(options?)`
  - `trackServerConnections(server)`: call once before listening; closed sockets leave the tracking set, and the server close event removes the connection listener.

## Public exports (server-startup-runtime.js)
- `createServerStartupRuntime(dependencies)`: creates runtime for server bind/startup tunnel and process handler wiring.
- Returned API:
  - `resolveBindHost(host)`
  - `startListeningAndMaybeTunnel(options)`
  - `attachProcessHandlers(options)`

## Public exports (static-routes-runtime.js)
- `createStaticRoutesRuntime(dependencies)`: creates runtime for static dist resolution and static route registration.
- Returned API:
  - `registerStaticRoutes(app)`

## Public exports (feature-routes-runtime.ts)
- `createFeatureRoutesRuntime(dependencies)`: creates runtime for main feature route registration orchestration.
- Returned API:
  - `registerRoutes(app, routeDependencies)`
  - `hydrateBoundCheckout({ directory, parentDirectory, parentRemoteName })`: resolves the parent repository's current binding authority at call time, then delegates local inspection and any explicit hydration to the runtime's existing Git network-operation service.

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

The pipeline binds the OpenChamber listener and publishes its active port
before starting managed OpenCode. The managed custom tool therefore receives
an authoritative loopback callback URL even when OpenChamber binds port `0`.
