# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

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
- `packages/web/server/lib/tunnels/providers/tailscale.js`: Tailscale Serve/Funnel provider implementation.
- `packages/web/server/lib/tailscale-tunnel.js`: Tailscale CLI discovery, status checks, foreground startup, URL readiness, and cleanup.

## Tailscale behavior

Tailscale `private-network` mode runs foreground `tailscale serve --https=<frontend> <backend>` and accepts any integer HTTPS frontend port from 1 through 65535. Its `quick` mode runs foreground `tailscale funnel --https=<frontend> <backend>` and accepts only ports 443, 8443, or 10000; the default for both modes is 443. The provider treats quick access as ephemeral public access, checks `tailscale status --json` for a running authenticated daemon, reports install/login/permission blockers, parses the emitted `https://*.ts.net` URL, and only sends SIGINT to its launched foreground child during idempotent cleanup. It never stops `tailscaled` or resets Serve/Funnel state.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
