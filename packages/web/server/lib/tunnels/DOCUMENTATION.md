# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

Public tunnels require a UI password on the running server. The shared tunnel start operation enforces this for startup tunnels and HTTP requests; the HTTP route rejects passwordless starts before touching an existing tunnel.

In enterprise mode (`../enterprise-mode.js`) no tunnel starts at all: Cloudflare and ngrok terminate TLS at their edge and see plain text, and Tailscale opens this machine to other devices. The same shared start operation refuses first (so `--tunnel` at startup fails too), the HTTP route answers 403 `enterprise_mode` ahead of the password check, and an inactive status reports `enterpriseMode` so Settings shows why.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.ts`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.ts`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.ts`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.ts`: managed remote tunnel token/preset persistence runtime.
- `packages/web/server/lib/tunnels/install-help.ts`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/routes.ts`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.ts`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/contracts.ts`: controller and provider contracts shared by the registry and service.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/tailscale.js`: Tailscale Serve (tailnet only) and Funnel (public) provider; the process itself lives in `../tailscale-tunnel.js`.
- `packages/web/server/lib/tunnels/tunnel-wiring-runtime.ts`: tunnel service/routes composition runtime and active-port wiring for main server startup.

## Invariants

- Tunnel starts run under one mutex so concurrent starts cannot orphan child
  processes. A failed preset write releases the queue without replaying its
  failure into every later settings save.
- An absent HTTPS port remains undefined for provider defaults. A noninteger
  becomes invalid and reaches the same capability validation as an explicitly
  unsupported port; saved defaults apply only to modes listing that port.
- Request fields remain unchecked until normalization. An explicit own
  `configPath` overrides defaults even when its value is undefined.
- Tunnel-locality checks account for forwarded client addresses even when the Host header says localhost. Tailscale passes Host through, so a remote caller can choose it; forwarded non-loopback addresses can only reduce trust. Login rate-limit buckets use Express's trusted-proxy resolution.

## TypeScript boundaries

The converted files import Node filesystem, path and home-directory APIs and
folder-local normalization and install metadata. External inputs are environment
variables, filesystem stat/access results, request/default fields and registered
provider implementations. Providers own process output parsing; the service
owns the normalized start request and the controller returned by a provider.

`routes.ts` and `tunnel-auth.ts` use the Express and HTTP contracts in
`../shared`. Request body properties and settings fields remain unchecked
until their text, numeric or normalization checks. Managed config reads return
validated entries, so the routes use their token strings directly.
`setActiveTunnel` accepts an optional string-or-null mode and stores
`string | null`, matching both startup and route callers.

The wiring dependencies reuse the route dependency contract. The server's
Node entry registers source resolution before loading the runtime; Electron
loads the server through that entry, and VS Code does not import these runtimes.

### Why request guards remain

HTTP provider, mode, preset, hostname, token, path and TTL fields still need
validation. Header text checks preserve handling of missing or array headers;
cookie and connect-token text checks preserve malformed-input behavior.
Host and IP normalization accept missing values and reject non-text inputs.
The generic doctor checks retain their text predicate because provider-required
field names index a dictionary, including inherited members such as
`constructor`. A non-text truthy value still satisfies the original presence
check.

Internal cookie ages are always numbers, bootstrap expiry is number-or-null,
provider diagnosis is an optional callable, capability keys are strings and
managed-config tokens have already passed file validation. Their redundant
type checks are removed. Bootstrap/session revocation and expiration state
retain explicit nulls.

`managed-config.ts` owns the persisted entry and config contracts. Its injected
filesystem reads JSON as unchecked data; object, array, text and finite timestamp
checks establish the stored entry shape. Invalid input still produces an empty
list, and only ENOENT starts legacy migration. Filesystem errors retain their
existing warning and empty-result behavior.

### Why preset inputs follow the injected normalizer

`../settings/settings-runtime.js` forwards raw presets and token fields from
existing settings. The config runtime preserves that boundary: token fields
remain unchecked until its text guards, and the generic preset input is passed
unchanged to the injected normalizer. The normalizer determines which input it
accepts and returns validated preset fields. The generic links the forwarding
method to that exact input contract without promising that settings are already
validated. The hostname normalizer's type comes from its owning settings module.

Both production callers of `resolveManagedRemoteTunnelToken` build `presetId`
with a request text check and a string fallback. Its internal text recheck is
removed; token upsert and file-entry text checks remain because those fields
still come from unchecked settings or files.

### Why boundary guards remain

Exported normalizers and path validation still accept calls from unconverted
JavaScript. Their text/object guards preserve rejection and default behavior.
Registry guards validate provider ids and required methods at registration,
and ids at lookup. Environment lookup retains its text guard because environment
values are external and an object lookup can also find an inherited member.
These guards are type predicates; they do not assert unchecked domain shapes.

The service no longer rechecks the types of controller mode/provider or an
availability message. Those values belong to the provider contract. Executable
names are string literals at every production caller, and search directories
come from splitting PATH, so their internal text rechecks are removed.

### Why Windows aliases have a launch fallback

Windows app execution aliases can launch even when filesystem stat/access
returns EACCES. The version probe decides availability after the launch fallback.
See https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-extensions.

## HTTPS port
A mode that takes an HTTPS port lists the allowed ones in its capability descriptor (`httpsPorts`). Validation, the Settings select and the CLI all read that list, so it exists once. The saved `tunnelHttpsPort` setting applies only to such modes; an explicit `httpsPort` for any other mode is refused. A start whose port differs from the running tunnel's replaces it.

## Tailscale
Facts below come from Tailscale's documentation and CLI source, not from observation alone.
- OpenChamber runs `tailscale serve|funnel --https=<port> http://127.0.0.1:<port>` in the foreground. Tailscale ties a foreground config to the CLI's session and deletes it when the process ends (`DeleteForegroundSession` in `ipn/ipnlocal`), so killing the child is the whole cleanup on every platform; OpenChamber never resets or edits the user's other Serve config.
- Tailscale routes by TLS SNI and forwards the client's `Host` unchanged from loopback, so a remote client could send `Host: localhost` and pass as a local visitor (password login instead of the connect-link lock). It always overwrites `X-Forwarded-For` with the real client address, so while a tunnel runs, `classifyRequestScope` in `tunnel-auth.js` never treats a loopback request with a non-loopback `X-Forwarded-For` as local. Funnel's lock depends on that rule; it also applies to a reverse proxy on the same machine while a tunnel runs, and to nothing when no tunnel runs.
- Before HTTPS (Serve) or Funnel is turned on for the tailnet, the CLI prints an approval link and waits. The start fails fast with code `approval_required` and the link, which Settings shows as a button.
- The Mac App Store and Standalone apps keep the CLI inside `/Applications/Tailscale.app`, and that binary opens the app window unless `TAILSCALE_BE_CLI=1` is set. Their "CLI integration" adds `/usr/local/bin/tailscale`, a `/bin/sh` wrapper that runs the binary as a child: a signal sent to the wrapper never reaches Tailscale, so Stop would leave the tunnel up. `resolveTailscaleTarget` runs the bundle binary directly whenever the app exists (seen live on 1.104.2).

### Why Serve offers only Funnel's three ports
Serve accepts any port, but one saved port that is valid in both modes means switching modes never loses or silently rewrites the user's choice. The three ports also cover the realistic reason to move off 443: another Serve config already on it.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort, hasUiPassword)`
