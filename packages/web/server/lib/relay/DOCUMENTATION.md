# Relay Module Documentation

## Purpose

The private relay lets an OpenChamber client (mobile app, browser, or another desktop) reach a user's OpenChamber instance through OpenChamber-hosted infrastructure when the instance is not directly reachable (behind NAT, no public URL, no tunnel). The instance dials **outbound** to the relay; nothing needs to be exposed inbound.

Traffic is **end-to-end encrypted between the two endpoints** (client and host instance). The relay infrastructure forwards opaque ciphertext and cannot read application traffic — it is an untrusted transport, not a trusted middlebox.

This module (`packages/web/server/lib/relay/`) is the **host side**: it runs inside the OpenChamber web server (so it works for Electron desktop, headless server, and CLI installs alike). The **client side** lives in `packages/ui/src/lib/relay/`. The **relay service itself** is a separate Cloudflare Worker in the `openchamber-website` repo and only brokers connections.

## The three layers

Traffic is modeled as three stacked layers. The relay understands only Layer 1; Layers 2–3 exist solely between the client and the host.

1. **Relay routing (Layer 1)** — outbound WebSocket connections to the relay, connection brokering, and host authentication to the relay. The relay routes each client to the correct host and forwards frames verbatim.
2. **End-to-end encryption (Layer 2)** — an authenticated encrypted channel established directly between client and host, keyed so the relay cannot participate. Built on standard WebCrypto primitives (ECDH key agreement + AEAD framing). The host's encryption public key is distributed to the client out-of-band via the pairing payload and is the client's trust anchor.
3. **Tunnel multiplexing (Layer 3)** — because an OpenChamber client speaks many concurrent HTTP requests, an event stream (SSE), and WebSockets to one origin, the encrypted channel carries a small multiplexing protocol. It frames HTTP request/response (including streamed bodies) and WebSocket sub-streams so the whole app works over one encrypted connection.

## Entrypoints and structure

Host side (`packages/web/server/lib/relay/`):
- `service.js` — thin entrypoint: relay config (enabled flag + relay URL), the management routes (`GET/POST /api/openchamber/relay/{status,enable,disable}`), a `getPairingCandidate()` accessor (the relay transport candidate folded into pairing-v2 links when enabled, consumed by the pairing-session route in `core-routes.js`), and lifecycle wiring. Started from `packages/web/server/index.js` only when the user has explicitly enabled the relay. The relay endpoint defaults to the OpenChamber-hosted relay but can be pinned to a self-hosted relay via the `OPENCHAMBER_RELAY_URL` env var (must be `ws://`/`wss://`); when set it overrides the stored setting for the host connection, the pairing candidate, and status, so paired clients inherit the endpoint automatically.
- `identity.js` — the host's stable identity: the long-lived signing keypair (shared with the push relay, defines the routing id) plus a long-lived encryption keypair (the E2EE trust anchor).
  The valid persisted private encryption JWK is authoritative: startup validates its P-256 point,
  derives the emitted `{kty, crv, x, y}` public representation from it,
  and repairs missing, mismatched, or over-specified public copies without rotating valid private material.
  Invalid private material is replaced, and candidates never emit `d` or stored public-JWK extras.
- `signing-key.js` — storage/derivation of the signing keypair and the routing id, shared with the notifications runtime.
- `host-client.js` — the hosted-relay connection manager: one outbound control connection, signed broker URLs, per-client data-socket lifecycle, reconnect/backoff, idle reaping, and status.
- `encrypted-session.js` — the transport-neutral per-outer-socket E2EE responder session: handshake, serialized decrypt/encrypt counters, negotiated batching, and ownership of one tunnel dispatcher. It does not own broker reconnect or admission policy.
- `host-lock.js` — the per-machine host claim. Every local instance sharing the data dir shares the relay identity (same serverId), so concurrent relay hosts evict each other at the relay worker (`4001: Control replaced`) and paired devices land on whichever local process won last. The claim file (`<data-dir>/relay-host.lock`, `{ pid }`) makes this deterministic: `service.js` only starts the host when no LIVE process holds the claim (stale claims from dead pids are ignored), goes to `standby` otherwise, and a 30s watcher both takes over when the claimant dies and stands down when another process claims. Explicit user intent — creating a pairing link or hitting `/relay/enable` — force-claims; the previous holder's watcher sees the takeover and backs off instead of fighting. The claim is cooperative (the relay worker still enforces the single host slot); it only decides which process keeps retrying.
- `tunnel-host.js` — the per-connection dispatcher: forwards decrypted HTTP/SSE/WS to the local server over loopback, then streams responses back. Enforces path allowlists, strips untrusted forwarding/Cloudflare/internal headers, and supports optional transport context, policy hooks, and bounded per-session limits. Omitted options retain hosted-relay behavior; it never injects credentials.
- `e2ee.js`, `tunnel-codec.js` — host-side (JS) mirrors of the shared crypto and framing (see "Two implementations" below).

Client side (`packages/ui/src/lib/relay/`):
- `protocol.ts` — the shared contract: constants, frame types, message shapes. The normative source both implementations follow.
- `crypto.ts`, `handshake.ts` — the E2EE primitives and handshake state machines (initiator + responder).
- `tunnel-codec.ts` — Layer 3 frame codec, fragmentation, and outbound frame batching.
- `tunnel-client.ts` — the client tunnel: exposes a `fetch()`-compatible and a WebSocket-compatible surface backed by the encrypted tunnel.
- `tunnel-payloads.ts`, `runtime-tunnel.ts`, `runtime-socket.ts` — payload helpers, the active-tunnel singleton, and the shared "open a runtime WebSocket the right way" helper.

Relay is not a separate link format: it is one transport candidate inside the unified **pairing v2** payload (`packages/ui/src/lib/connectionPayload.ts`). A relay candidate is `{ type: 'relay', relayUrl, serverId, hostEncPubJwk }` — no embedded token; the client redeems the one-time pairing secret over the tunnel like any other candidate.

## What travels the tunnel

Everything a client normally sends to the single OpenChamber origin:
- **HTTP** — REST endpoints and proxied OpenCode SDK calls under `/api/*`, plus `/auth/*` and `/health`.
- **SSE** — long-lived streamed responses (the event stream, notifications, terminal output fallback). These are just HTTP responses whose body streams; the tunnel needs no special SSE handling.
- **WebSocket** — the endpoints that use a real socket (the global event stream on platforms that support WS, terminal I/O, dictation).

The host dispatcher restricts tunneled traffic to explicit path allowlists (one for HTTP, one for WS).
It canonicalizes each request target before allowlist checks and uses that same
target for loopback dispatch. Fragment assembly is limited to open nested
WebSockets, supports aggregate byte budgets, and is cleared on stream/session
teardown. Outbound fragments for each nested WebSocket are serialized through
backpressure waits so upstream messages cannot interleave; send-chain failure is
terminal and drops the affected stream. Direct E2EE supplies a live fragment-byte
budget that changes on authenticated promotion and enables
terminal fail-closed policy; hosted-relay stream-local rejection remains compatible.

### Completed HTTP stream tombstones

When a loopback HTTP response completes before the client finishes uploading its
request body, the host retains a bounded tombstone for the completed stream ID.
The default lifetime is 5 seconds, with at most 256 tombstones per outer session;
expired entries are pruned and the oldest entry is evicted when the capacity is
full. A body-capable tombstone accepts at most 32 expected late body frames totaling
at most 1 MiB, and a matching `StreamEnd` consumes it. Body frames for bodyless
requests, frames beyond either bound, unknown IDs, and reuse of a tombstoned stream
ID are fatal protocol errors. These bounds tolerate only expected in-flight late
frames and do not permit a completed stream to be reopened or used indefinitely.

## Authentication and Administrative Controls

- The tunnel is **transport only**. The OpenChamber server still authenticates every tunneled request exactly as it authenticates a direct remote client. The relay path grants reachability, not authorization.
- Clients carry their normal credential. HTTP and SSE requests authenticate with the client's bearer token (a header). **WebSocket upgrades cannot send headers**, so they authenticate with a short-lived URL-scoped token minted beforehand and passed as a query parameter.
- **Administrative Controls**: Mutation routes (`/enable`, `/disable`) are restricted to the host desktop or an authenticated browser UI session. Paired clients (e.g., mobile apps) receive a sanitized status including `canAdminister: false` and cannot change relay state.
- **Managed E2EE Separation**: Managed direct E2EE (pairing v2) is strictly direct-only. It advertises only the exact direct-E2EE candidate over the user's managed Cloudflare tunnel: no plaintext LAN/tunnel candidate, no `apiUrl`, and no OpenChamber Relay candidate/fallback. Relay remains a separate, explicitly user-selected transport.

## End-to-end flow (overview)

1. **Pairing.** The host issues a pairing-v2 link (QR / deep link) carrying a one-time secret and a list of transport candidates. When the relay is enabled, one candidate is the relay transport (its endpoint, routing id, and encryption public key — the E2EE trust anchor). The client redeems the secret over the first reachable candidate; over the relay candidate it opens the E2EE tunnel first, then redeems through it, and stores the connection.
2. **Presence.** When the relay is enabled, the host opens one outbound control connection and waits.
3. **Connect.** The client connects for a given routing id; the relay notifies the host over the control connection; the host opens a matching per-client data connection.
4. **Handshake.** Over that connection pair, client and host run the E2EE handshake and derive a shared encrypted channel the relay cannot read.
5. **Readiness and traffic.** Hosted relay channels retain their existing behavior. A direct-E2EE runtime channel is kept private after every initial handshake and reconnect while the client verifies strict OpenChamber `/health` identity, then promotes that exact encrypted session with bearer-authenticated `GET /auth/session`. Only after both checks succeed does the client publish `connected`, release queued HTTP/WS work, mint URL tokens, or start keepalive. Invalid/revoked bearer credentials and protocol/identity failures are terminal; readiness/network failures retry with backoff. Normal traffic is then multiplexed and encrypted through the promoted channel.

## Candidate refresh (staying off the relay when direct works)

Pairing-payload transport candidates are a snapshot: when DHCP hands the host
machine a new LAN address, a device's saved direct candidate goes stale and the
device silently degrades to relay-only. To recover, an already-paired client can
call `GET /api/client-auth/connection/candidates` (UI session or client bearer;
registered with the auth/access routes) over any live transport — including
through the tunnel — to learn the server's **current** LAN URLs plus the relay
candidate, and update its saved candidate set (mobile: `mobileConnections.ts`;
desktop: `desktopRelayRestore.ts`).

Identity gating: the response carries the stable `serverId` (base64url SHA-256 of
the public signing JWK — the same identity the relay routes by, exposed by the
relay service's `getServerId()` and echoed unauthenticated on `/health` and
`/api/version`). Clients ignore a refresh whose `serverId` does not match their
pinned relay identity, and verify `/health`'s `serverId` on a learned address
**before** sending their bearer token to it — a re-assigned LAN address may now
belong to a different machine.

## Two implementations, kept in sync

The E2EE and framing logic exists twice: TypeScript in `packages/ui/src/lib/relay/` (shared by the client and the normative reference) and a JavaScript mirror in this module (the host, which is plain JS ESM). They **must stay byte-compatible** — a client encrypted by one must decrypt on the other. A cross-compatibility test (`cross-compat.test.js`) imports the TS modules directly and exercises a full TS-client ↔ JS-host exchange. Any change to the wire format, frame codec, handshake, or batching must update both sides and keep that test green.

## Runtime integration (client)

Relay mode plugs into the existing client transport layer rather than a parallel path: `runtime-switch` activates the tunnel singleton, `runtime-fetch` routes runtime requests through it, `runtime-url`/`runtime-socket` yield tunnel-backed URLs and sockets, and `runtime-auth` mints the URL-scoped token through the tunnel. Direct-E2EE activation passes the bearer token separately from its public descriptor so credentials never enter candidate metadata or URLs. Direct-URL connections and the Electron realtime-proxy path are unaffected.

## Design invariants (do not regress)

- The relay never sees plaintext application traffic; it sees only routing metadata (routing id, connection identifiers, timestamps, coarse counts).
- Pairing secrets travel in URL fragments only, never in query strings, never logged.
- The host dispatcher never injects credentials; the server authenticates each tunneled request.
- The tunnel is transparent to the app: adding relay support to a feature should not require the feature to know the relay exists — it goes through the shared runtime transport helpers.
- The two implementations stay byte-compatible and the wire format is versioned/negotiated so mixed client/host app versions degrade gracefully rather than break.
- Hosted relay keeps the shared handshake's legacy pre-establishment ignore behavior.
  Direct E2EE enables an encrypted-session policy seam that terminal-fails ignored
  pre-establishment text without changing handshake bytes or hosted-relay behavior.

For the operational rules that keep future changes (new WebSocket endpoints, transport refactors, terminal/voice porting) from breaking this, load the `relay-transport` skill.
