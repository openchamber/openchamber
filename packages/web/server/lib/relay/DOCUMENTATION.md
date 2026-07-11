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
- `identity.js` — the host's stable identity: the long-lived signing keypair (shared with the push relay, defines the routing id) plus a long-lived encryption keypair (the E2EE trust anchor). Reused across restarts; never rotated implicitly.
- `signing-key.js` — storage/derivation of the signing keypair and the routing id, shared with the notifications runtime.
- `host-client.js` — the long-lived connection manager: one outbound control connection to the relay, a per-client data connection for each connected device, reconnect/backoff, and the E2EE responder handshake per connection.
- `tunnel-host.js` — the per-connection dispatcher: decrypts tunnel frames and forwards HTTP/SSE/WS to the local server over loopback, then streams responses back. Enforces a path allowlist and never injects credentials.
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

## Authentication model

- The tunnel is **transport only**. The OpenChamber server still authenticates every tunneled request exactly as it authenticates a direct remote client. The relay path grants reachability, not authorization.
- Clients carry their normal credential. HTTP and SSE requests authenticate with the client's bearer token (a header). **WebSocket upgrades cannot send headers**, so they authenticate with a short-lived URL-scoped token minted beforehand and passed as a query parameter. This asymmetry is important when adding new WebSocket features (see the skill).
- The host authenticates itself to the relay with a signed handshake using its long-lived signing key.
- Enabling the relay is explicit opt-in and disabled by default; disabling it severs all relay reachability immediately.

## End-to-end flow (overview)

1. **Pairing.** The host issues a pairing-v2 link (QR / deep link) carrying a one-time secret and a list of transport candidates. When the relay is enabled, one candidate is the relay transport (its endpoint, routing id, and encryption public key — the E2EE trust anchor). The client redeems the secret over the first reachable candidate; over the relay candidate it opens the E2EE tunnel first, then redeems through it, and stores the connection.
2. **Presence.** When the relay is enabled, the host opens one outbound control connection and waits.
3. **Connect.** The client connects for a given routing id; the relay notifies the host over the control connection; the host opens a matching per-client data connection.
4. **Handshake.** Over that connection pair, client and host run the E2EE handshake and derive a shared encrypted channel the relay cannot read.
5. **Traffic.** All normal app traffic is multiplexed and encrypted through that channel. On the host, decrypted requests are dispatched to the local server over loopback; responses stream back encrypted. Reconnects re-establish a fresh channel and the app's existing retry machinery recovers.

## Two implementations, kept in sync

The E2EE and framing logic exists twice: TypeScript in `packages/ui/src/lib/relay/` (shared by the client and the normative reference) and a JavaScript mirror in this module (the host, which is plain JS ESM). They **must stay byte-compatible** — a client encrypted by one must decrypt on the other. A cross-compatibility test (`cross-compat.test.js`) imports the TS modules directly and exercises a full TS-client ↔ JS-host exchange. Any change to the wire format, frame codec, handshake, or batching must update both sides and keep that test green.

## Runtime integration (client)

Relay mode plugs into the existing client transport layer rather than a parallel path: `runtime-switch` activates the tunnel singleton, `runtime-fetch` routes runtime requests through it, `runtime-url`/`runtime-socket` yield tunnel-backed URLs and sockets, and `runtime-auth` mints the URL-scoped token through the tunnel. Direct-URL connections and the Electron realtime-proxy path are unaffected.

## Design invariants (do not regress)

- The relay never sees plaintext application traffic; it sees only routing metadata (routing id, connection identifiers, timestamps, coarse counts).
- Pairing secrets travel in URL fragments only, never in query strings, never logged.
- The host dispatcher never injects credentials; the server authenticates each tunneled request.
- The tunnel is transparent to the app: adding relay support to a feature should not require the feature to know the relay exists — it goes through the shared runtime transport helpers.
- The two implementations stay byte-compatible and the wire format is versioned/negotiated so mixed client/host app versions degrade gracefully rather than break.

For the operational rules that keep future changes (new WebSocket endpoints, transport refactors, terminal/voice porting) from breaking this, load the `relay-transport` skill.
