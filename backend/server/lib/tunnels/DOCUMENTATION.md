# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `backend/server/lib/tunnels/index.js`: tunnel service orchestration.
- `backend/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `backend/server/lib/tunnels/registry.js`: provider registry.
- `backend/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `backend/server/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `backend/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `backend/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `backend/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `backend/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
