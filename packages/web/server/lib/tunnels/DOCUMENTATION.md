# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

Public tunnels require a UI password on the running server. The shared tunnel start operation enforces this for startup tunnels and HTTP requests; the HTTP route rejects passwordless starts before touching an existing tunnel.

In enterprise mode (`../enterprise-mode.js`) no tunnel starts at all: Cloudflare and ngrok terminate TLS at their edge and see plain text, and Tailscale opens this machine to other devices. The same shared start operation refuses first (so `--tunnel` at startup fails too), the HTTP route answers 403 `enterprise_mode` ahead of the password check, and an inactive status reports `enterpriseMode` so Settings shows why.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/tailscale.js`: Tailscale Serve (tailnet only) and Funnel (public) provider; the process itself lives in `../tailscale-tunnel.js`.

## HTTPS port
A mode that takes an HTTPS port lists the allowed ones in its capability descriptor (`httpsPorts`). Validation, the Settings select and the CLI all read that list, so it exists once. The saved `tunnelHttpsPort` setting applies only to such modes; an explicit `httpsPort` for any other mode is refused. A start whose port differs from the running tunnel's replaces it.

## Tailscale
Facts below come from Tailscale's documentation and CLI source, not from observation alone.
- OpenChamber runs `tailscale serve|funnel --https=<port> http://127.0.0.1:<port>` in the foreground. Tailscale ties a foreground config to the CLI's session and deletes it when the process ends (`DeleteForegroundSession` in `ipn/ipnlocal`), so killing the child is the whole cleanup on every platform; OpenChamber never resets or edits the user's other Serve config.
- Tailscale routes by TLS SNI and forwards the client's `Host` unchanged from loopback, so a remote client could send `Host: localhost` and pass as a local visitor (password login instead of the connect-link lock). It always overwrites `X-Forwarded-For` with the real client address, so while a tunnel runs, `classifyRequestScope` in `../opencode/tunnel-auth.js` never treats a loopback request with a non-loopback `X-Forwarded-For` as local. Funnel's lock depends on that rule; it also applies to a reverse proxy on the same machine while a tunnel runs, and to nothing when no tunnel runs.
- Before HTTPS (Serve) or Funnel is turned on for the tailnet, the CLI prints an approval link and waits. The start fails fast with code `approval_required` and the link, which Settings shows as a button.
- The Mac App Store and Standalone apps keep the CLI inside `/Applications/Tailscale.app`, and that binary opens the app window unless `TAILSCALE_BE_CLI=1` is set. Their "CLI integration" adds `/usr/local/bin/tailscale`, a `/bin/sh` wrapper that runs the binary as a child: a signal sent to the wrapper never reaches Tailscale, so Stop would leave the tunnel up. `resolveTailscaleTarget` runs the bundle binary directly whenever the app exists (seen live on 1.104.2).

### Why Serve offers only Funnel's three ports
Serve accepts any port, but one saved port that is valid in both modes means switching modes never loses or silently rewrites the user's choice. The three ports also cover the realistic reason to move off 443: another Serve config already on it.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
