# Server frame

## Ownership

This module owns the frame around the feature runtimes: CLI options and the direct-execution entry, base bootstrap, common request middleware, the status, auth and access routes, static and feature route composition, the startup pipeline, listening and process handlers, and graceful shutdown. `../../runtime.js` composes the server from these pieces (`../../DOCUMENTATION.md`); each feature owns its routes in its own folder.

## Invariants

- Private diagnostic exports check the socket peer and reject relayed requests because forwarding headers do not prove that the caller is on this machine. Pairing redemption rate limits also use the socket peer because that endpoint is unauthenticated and forwarding headers can change a bucket.
- `/health` stays open so the CLI and paired clients can read liveness without a session. Only a direct loopback caller gets the full snapshot (binary paths, launch arguments, WSL paths, the managed-process record, raw errors). Any other caller, including one behind a reverse proxy on this machine (any forwarding header) or the private relay, gets a public answer built from an allowlist in `health-route.ts`: liveness, `serverId`, readiness, the OpenCode port, whether OpenCode is the shared service (the only `opencodeBinarySource` value it passes, which remote clients need to refuse Restart), a fixed summary of the startup error, the health failure class and time, and the restart time and busy-session count. A new snapshot field stays private until the allowlist names it.
- Learned server addresses carry the stable signing-key identity so clients can verify an address before sending it a bearer token. Reachable non-loopback browser origins supplement interface discovery because a reverse-proxy domain may be the only usable direct address.
- UI sessions and the desktop shell's local client can manage all devices; other client tokens are limited to their own record. Push registrations are removed before revoked device rows, while their ownership can still be identified; cleanup failure preserves rows for retry. A revocation already persisted remains successful if its later push cleanup fails.
- The repository credential helper authenticates with its own per-start secret and same-machine restriction. It cannot obtain a UI session, so the common session guard exempts its exact route and leaves authority checking to the helper route. Sandboxed preview and extension reads similarly rely on path grants, and OAuth callbacks rely on issued state.
- Shutdown closes guest admission and stops event subscribers and wait checks in the same tick. Otherwise a healthy service can receive a shutdown refusal through a still-active subscriber and be classified as broken or backed off.
- An HTML document in the dist root, requested by any spelling `express.static` would resolve to it (percent-encoded characters or separators, repeated or `.` segments) or through the SPA fallback, gets a validator derived from its bytes, so the static routes never answer 304 to a copy of a different document. The route decodes and normalizes the path and takes it only when the result is a file directly in the dist root, so the lookup never leaves it. Hashed files under `assets/` stay `immutable`.
- `feature-folder-watches.ts` owns the theme and settings watch lifetimes. Route registration replaces both watches; shutdown stops them. Settings reconciliation completes before notification, the announced changes are the ones reconciliation returns, and a replaced or stopped watch cannot announce its in-flight result.

## Decisions

### Why static assets and service workers use different cache lifetimes

Vite asset filenames identify their content, so immutable caching avoids revalidation round trips for lazy chunks over remote connections. Service workers need short-lived responses so clients, including iOS, can discover updates.

### Why HTML documents are validated by their bytes and not by file stats

An HTML document in the dist root (`index.html`, `mobile.html`, `mini-chat.html`, and `index.html` again as the SPA fallback) names its build's hashed assets, which clients hold as immutable, so one stale document keeps a whole old build running. `express.static` validates by size and mtime. Nix stamps every build output with the same mtime, so two builds whose documents had the same size sent the same ETag, and a new server answered 304 to a browser holding the old document. The static routes decode and normalize the requested path the way `express.static` does, so a spelling such as `/inde%78.html` or `//mobile.html` cannot reach the stat-based validator, then read each document and send it with `res.send`, whose ETag is a hash of the bytes, with `Cache-Control: no-cache` and no `Last-Modified`. `express.static` runs with `index: false` so `/` reaches the SPA fallback and gets the same treatment. Clients revalidate on every load and still get 304 while the build is unchanged. The document is read on every request because a hash taken at startup goes stale when the dist directory is rebuilt in place.

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

### Why `/health` answers remote callers from an allowlist

The endpoint is both a liveness probe for callers without a session and the health source a remote runtime reads to describe its OpenCode. Answering liveness alone left the remote diagnostics export and the onboarding availability poll without the readiness they parse, and answering the snapshot handed the machine's binary paths, launch arguments, PID and stderr to any peer that could reach the port. A deny-list was not enough: the restart record nests the process snapshot and the raw startup error embeds the binary path and captured output, so the public answer is projected field by field and the startup error is reduced to a fixed summary the UI classifier still recognizes. A configured-binary error keeps its reason and env-runtime's fixed install advice without the path, so a remote user still learns what to fix. Errno classes match only at the end of the message, where Node's spawn failure puts the code, so a path that names another code does not decide the class.

The tunnel scope classifies a loopback request as local whenever no built-in tunnel runs, which includes a documented Nginx setup on the same machine, so the local-peer check also refuses any request carrying a forwarding header.

### Why auth exemptions match the routed path and the credential helper the exact URL

The GET exemptions in `api-auth-gate.ts` match one path: `/api` plus Express's mount-relative `req.path`, written in full in each pattern. The gate therefore treats a mixed-case mount (`/API/...`) and an absolute-form request target like the canonical URL, and each route still decides whether it matches: the preview read is a case-sensitive pattern, so its `/API` form passes the gate and finds no handler. Stripping the prefix from `originalUrl` as text would stop the forms that do route before their grant or state check. The mount is the only prefix replaced, so `/api/api/...` matches nothing.

The repository credential helper is compared with `originalUrl` without its query. Its only caller builds that exact URL, and it is exempt for every method, so any other form needs a session.

## Modules

- `cli-options.ts`: CLI and environment option parsing for server startup.
- `cli-entry-runtime.ts`: direct-execution detection, option parsing and server bootstrap.
- `bootstrap-runtime.ts`: base app route wiring.
- `core-routes.ts`: status, auth, access and settings utility routes.
- `free-port-route.ts`: `GET /api/system/free-port`, which hands the UI's dev-server detection an unused loopback port.
- `health-route.ts`: the public health route, the allowlisted answer for non-local callers and the startup error summary.
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
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware, and returns `{ requireApiAuth }`, the gate it mounts on `/api`, so a route registered later can carry the same check instead of relying on mount order. The `/api` mount lets `POST /api/notifications/emit` and `GET /api/system/free-port` through to their routes, which carry this gate themselves, so the request's credentials are read once:
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
   - `app.use('/api', ...)` auth/tunnel guard. It lets through only the repository credential helper, guest/tracker OAuth callbacks, the MCP OAuth callback, html previews and extension frame reads: the helper by its exact URL, the rest by GET and an anchored path pattern (*Why auth exemptions match the routed path and the credential helper the exact URL*); the owning route then checks the grant, secret or state.
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`
  - `POST /api/config/reload` — restarts OpenCode on request. Config edits no longer need it; it stays for the changes that cannot be hot-applied (OpenCode binary, port, managed/external switch) and as a manual recovery. Managed OpenCode restarts and returns `requiresReload: true`. External OpenCode returns `requiresManualRestart: true` (changes are already on disk; the connected server must be restarted outside OpenChamber).
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
  - URL-encoded parser setup
  - request logging middleware
  - `dependencies.skipBodyParsing(req)` names a request both parsers leave alone, so its body reaches its route untouched; the isolated-spaces dispatcher uses it for a request to a space, by the space directory its query or headers name or by the `/api/spaces/<id>/...` prefix, which it streams into a space

## Public exports (free-port-route.js)
- `registerFreePortRoute({ app, requireAuth })`: registers `GET /api/system/free-port`, which binds port 0 on `127.0.0.1`, closes it and answers `{ port }`. `requireAuth` is the `requireApiAuth` that `registerAuthAndAccessRoutes` returns; it is the request's only check, because the `/api` mount skips this path. The UI's static-preview fallback in `packages/ui/src/lib/detectDevServer.ts` is the only caller, reached through the project actions runner that Web and Electron mount; the VS Code and mobile entrypoints don't mount it, though mobile clients still use this server for its other routes. The `/api` mount skips every request Express routes here: GET and HEAD, any letter case, with or without one trailing slash.

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
- Daemon signals, `POST /api/system/shutdown`, and embedded `stop()` share one shutdown promise. Guest admission closes synchronously before any await. Cleanup first kills the process groups of running `/api/fs/exec` commands (`../fs/DOCUMENTATION.md`), which spawn detached and miss the server group's signal, then stops the relay reconciliation timer, guest viewers, realtime proxy, relay host, dictation worker and session runtimes before draining guest services, including pending starts. Each cleanup is best-effort and runs once per shutdown, including after partial startup. A hard kill skips all of this. Guest services it leaves running are stopped by the next host start through the guest service registry (`../guests/DOCUMENTATION.md`, Crash recovery); managed OpenCode has its own registry (`../opencode/DOCUMENTATION.md`).
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
