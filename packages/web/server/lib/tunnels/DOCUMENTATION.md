# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime, including the per-profile direct-E2EE opt-in flag and serialized flag mutation.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`

## Administrative Controls and Privacy

- **Administrative Controls**: Tunnel mutation routes (start/stop/profile management) require the host desktop or an authenticated browser UI session. Paired clients see a sanitized read-only status and cannot modify tunnel configurations.
- **Managed E2EE Separation**: Managed direct E2EE (pairing v2) is strictly direct-only and fail-closed. It uses the exact active managed Cloudflare tunnel but never substitutes OpenChamber Relay. Tunnels remain a separate, explicitly configured transport for public URL access.

## Managed remote profile contract
- Saved profiles normalize `directE2eeEnabled` strictly: only boolean `true` enables it; legacy or invalid values become `false`.
- Token upserts preserve the current flag when the field is omitted. The config file remains mode `0o600`.
- Managed config reads return an empty config only when both the current and legacy files are absent. Parse, root/schema, permission, I/O, and legacy migration write failures propagate so mutations cannot replace an unreadable authoritative config.
- Managed profile persistence writes an owner-only temporary file, applies mode
  `0o600`, atomically renames it over the destination, repairs the final POSIX mode,
  and removes the temporary file on failure. The serialized mutation lock recovers
  after write failures. Parent mode `0o700` is requested/repaired only when injected
  runtime context identifies the directory as app-owned; arbitrary parents are not
  chmodded. Windows skips POSIX chmod while retaining temp-and-rename replacement.
- `PATCH /api/openchamber/tunnel/managed-remote-profile/:id` mutates only this flag and never returns the connector token.
- Active managed tunnel identity is carried as `managedRemoteTunnelPresetId` in normalized start state and provider metadata. Profile identity is part of tunnel reuse, so switching profiles replaces the connector even when mode, provider, and hostname match.
- Tunnel status exposes profile flags, `activeManagedRemoteProfileId`, and the non-secret `directE2eeConfigured`, `directE2eeSupported`, `directE2eeAvailable`, and `directE2eeActiveSessions` fields.
- Support is true only while the production direct-E2EE runtime is initialized.
  Availability additionally requires the exact enabled active managed-remote profile and a matching canonical HTTPS public URL.
- Route dependencies carry direct-session count, profile disable, tunnel replacement, and stop lifecycle hooks.
  This module invokes those hooks but does not own encrypted sessions or revoke paired-device tokens.
- Managed profile writes await a direct-runtime refresh with an explicit mutation reason and profile ID.
  Failed tunnel startup clears tunnel authority and deactivates direct sessions before returning an error.
- Legacy active tunnels without retained profile metadata use hostname fallback only when exactly one enabled saved profile matches.
