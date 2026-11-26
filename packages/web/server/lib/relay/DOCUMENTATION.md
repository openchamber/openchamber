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

Paths below use the runtime `.js` import specifiers. All host implementations
directly in this folder are TypeScript.

- `service.js` — thin entrypoint: relay config (enabled flag + relay URL), the management routes (`GET/POST /api/openchamber/relay/{status,enable,disable,reset-identity}`), a `getPairingCandidate()` accessor (the relay transport candidate folded into pairing-v2 links when enabled, consumed by the pairing-session route in `core-routes.js`), and lifecycle wiring. Started from `packages/web/server/index.js` only when the user has explicitly enabled the relay. The relay endpoint defaults to the OpenChamber-hosted relay but can be pinned to a self-hosted relay (`pinnedRelayUrl`: `relayUrl` in the machine policy file, else the `OPENCHAMBER_RELAY_URL` env var; see `../enterprise-mode.js`; must be `ws://`/`wss://`, an invalid value pins nothing); when set it overrides the stored setting for the host connection, the pairing candidate, and status, so paired clients inherit the endpoint automatically. In enterprise mode (`../enterprise-mode.js`) the relay runs only with that pin (`relayBlockedByEnterprise`): `start()` refuses otherwise (every path in passes through it), `enable` answers 403, `getPairingCandidate()` is null, `ensureEnabledForPairing()` throws (the pairing route drops the candidate and direct pairing still works), status carries `blockedByEnterprise`, and `resolvePairingTransports` in `index.js` reports `relayAvailable: false`.
- `identity.js` — the host's stable identity: the long-lived signing keypair (shared with the push relay, defines the routing id) plus a long-lived encryption keypair (the E2EE trust anchor). Reused across restarts; never rotated implicitly. The only rotation is the user's: Settings shows a notice while the host reports `identityConflict` (two `4001` evictions within 10 minutes, so another copy of the data dir, usually on another machine, keeps taking the slot), and its button calls `reset-identity`. That drops both keypairs through `key-store.js`, restarts the host if it was running, and leaves the other copy with the old identity: devices paired through the relay keep reaching it until they are paired here again, and devices paired for the home network only are unaffected. Callers that cache derived keys (this runtime and the push relay's) compare the store's `generation()`, so the reset reaches both without a restart.
- `signing-key.js` — the signing keypair and the routing id derivation, shared with the notifications runtime.
- `key-store.js` — where both keypairs live: `<data-dir>/relay-identity.json` (`0600`), never `settings.json`, so the private keys do not travel with every copy of the settings file. Installs that kept them in `settings.json` (`relaySigningKey` / `relayEncryptionKey`) have them moved on first load, unchanged so `serverId` and the trust anchor survive, then stripped from settings; an older build sharing the data dir then mints its own identity. A key is minted only when neither file holds it, and both are read strictly so a corrupt or unreadable file fails instead of reading as first run. `index.js` builds one store for the push relay and the private relay, so their concurrent first loads mint one key.
- `host-client.js` — the long-lived connection manager: one outbound control connection to the relay, a per-client data connection for each connected device, reconnect/backoff, and the E2EE responder handshake per connection. A control socket the relay closes with `4001: Control replaced` waits 60 s before reconnecting: another host holding the same identity took the slot (a copied data dir, a second machine, a container replica), and the usual 1 s reconnect would evict it in turn, so the pair would trade the slot every second for as long as both run. The relay also answers a host that reconnects its control socket more than 10 times a minute with HTTP 429, which older builds treat as a failed dial and back off from. A control connection dial whose upgrade gets no response within 15 s is terminated and redialed on the usual backoff: such a dial stays connecting without an error or close, and the ping keepalive only watches an open socket, so without the timeout the host stays unregistered until it restarts. The host times the open itself because Bun's `ws` ignores the `handshakeTimeout` option. Both dials go through the proxy the environment names (`HTTPS_PROXY` for `wss:`, `HTTP_PROXY` for `ws:`) unless `NO_PROXY` covers the relay host; loopback (`localhost`, `127.0.0.0/8`, `::1`) is always direct. The host checks the bypass itself with Node's `NO_PROXY` rules (`*`, an exact host or `host:port`, `.domain` for the domain and its subdomains, `*.domain` for its subdomains, an IPv4 range `a.b.c.d-e.f.g.h`), so both runtimes pick the same route. On Node and Electron a proxied dial passes the global agent that `applyOutboundProxyFromEnv` installs, because `ws` always passes `createConnection` and Node never falls back to that agent on its own. Bun's `ws` ignores `agent` and takes a `proxy` URL instead, without reading `NO_PROXY`. A `wss:` relay is tunnelled with `CONNECT` on both runtimes. A `ws:` relay is tunnelled with `CONNECT` on Bun, but Node sends the upgrade to the proxy as a forward request, which a proxy that only tunnels `CONNECT` refuses. A data connection dial that never opens (refused, or no answer within 5 s, doubling to 15 s per failure) is retried after 1 s, doubling to 8 s, for as long as the relay still reports that client and the control connection is up. The relay sends no second `connected` for a waiting client, so without the retry the device waits for the relay's 15 s stuck-control reset or its own 30 s handshake timeout. A data connection that opened and then closed is not retried: the relay closes the client with it, and the client's reconnect arrives as a new `connected`. Every control and data socket close is logged at info level with its close code and lifetime (`[Relay] control socket closed`, `[Relay] data socket closed`), so a host whose devices keep dropping shows the pattern in its log. The control socket also carries the relay's `{ type: 'share-state', shareId }` nudge when a page this host shared was opened or answered; it goes to `onShareState` (`../share-pages/`, which reads the share at once) and never touches the tunnel. Shares themselves are plain signed HTTPS calls with the same signing identity (`../share-pages/relay-client.js`), made whether or not the private relay host runs.
- `host-lock.js` — the host claim shared through the data dir. Every instance using the data dir shares the relay identity (same serverId), so concurrent relay hosts evict each other at the relay worker (`4001: Control replaced`) and paired devices land on whichever process won last. The claim file (`<data-dir>/relay-host.lock`, `{ pid, instance, host, refreshedAt }`) makes this deterministic: `service.js` only starts the host when no LIVE process holds the claim, goes to `standby` otherwise, and a 30s watcher both takes over when the claimant dies and stands down when another process claims; while hosting, the same check refreshes the claim. The holder is named by a random per-process instance id, never by pid alone, because a data dir is not always private to one process table: containers mounting one volume all run as pid 1, and a synced or network folder is shared with processes on other machines. A claimant is live only while its `refreshedAt` is under 90 s old; one on this host must also still answer on its pid, so a holder that exits is replaced without waiting for the claim to age. The pid alone proves nothing: Windows reuses a dead host's pid for unrelated processes (`svchost.exe` in #4953), and a claim judged by pid alone held the relay in `standby` until the user re-enabled it. A claim from an older build has no `refreshedAt` and reads as stale; an older build still hosting sees the newer claim by its pid and stands down. A standby watcher waits a 2-minute grace after the claim frees before taking over, so a cleanly restarting host (app update/relaunch) — which reclaims at boot with no wait — always wins the restart window over a bystander instance. Explicit user intent — creating a pairing link or hitting `/relay/enable` — force-claims; the previous holder's watcher sees the takeover and backs off instead of fighting. Instances created with `allowPassiveHost: false` (dev servers via `OPENCHAMBER_RELAY_HOST=off`, the Electron dev shell via `OPENCHAMBER_ELECTRON_DEV`; `OPENCHAMBER_RELAY_HOST=on` overrides) never start the host passively at all — boot, demand reconcile, and watcher takeover leave them in `standby`; only explicit enable/pairing hosts there. The claim is cooperative (the relay worker still enforces the single host slot); it only decides which process keeps retrying.
- `tunnel-host.js` — the per-connection dispatcher: decrypts tunnel frames and forwards HTTP/SSE/WS to the local server over loopback, then streams responses back. Enforces a path allowlist and never injects credentials. Every forwarded request and WebSocket dial carries `x-openchamber-relay-connection` and the relay proof from `provenance.js`, replacing any value the client sent. It does not follow redirects: a followed redirect would resend the proof to whatever origin the `Location` names, so the device receives the redirect response itself.
- `provenance.js` — the relay proof: a random secret minted per process, never persisted or sent to a client. `hasRelayProvenance` is the only way the server tells a relay-carried request from a direct one where that changes stored state (`../client-auth/`). `consumeRelayProof` runs as the server's first `request` and `upgrade` listener, prepended by `service.js` `registerRoutes`, which `runtime.ts` calls after every other prepended listener (the spaces upgrade handler); a listener prepended later would see the proof: it deletes the header and remembers a matching request, so no proxy (OpenCode, spaces, http-proxy's `Expect` path that skips `proxyReq` hooks) ever sees the proof, and `hasRelayProvenance(req)` reads that memory, not the headers.
- `downstream-scheduler.js` owns end-client delivery credit and round-robin transmission across response streams. It selects plaintext frames before encryption.
- `e2ee.js`, `tunnel-codec.js` are host-side mirrors of the shared crypto and framing. See "Two implementations".

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
- **SSE** — long-lived streamed responses (the event stream and notifications). These are just HTTP responses whose body streams; the tunnel needs no special SSE handling.
- **WebSocket** — the endpoints that use a real socket (the global event stream on platforms that support WS, terminal I/O, dictation, and desktop dev-server previews).

The host dispatcher restricts tunneled traffic to explicit path allowlists (one for HTTP, one for WS).

## Response compression

Encrypted frames do not compress, so the tunnel compresses response bodies
before encryption. The host's loopback `fetch` always asks for `identity`
(it would decode a gzipped body anyway), and the tunnel client marks each
request it can gunzip with `x-openchamber-tunnel-accept-encoding: gzip`
(`TUNNEL_ACCEPT_ENCODING_HEADER` in `protocol.ts`; sent only where
`DecompressionStream` exists). For such a request the host gzips whole-body
text responses (JSON, text, XML, SVG) of 1 KB or more and marks them with
`x-openchamber-tunnel-content-encoding: gzip`; the client strips the marker and
decodes, so callers see an ordinary response. The host compresses through a
Node `zlib` stream pipeline: `CompressionStream` in Node threw an uncaught
"Controller is already closed" whenever a client aborted a compressed request. Event streams, binary types and
WebSocket messages cross as they are: gzip holds bytes back until its window
fills, which would delay live events. The marker is stripped before the
request reaches the server. Negotiation is per request, so a client or host
without it keeps exchanging plain bodies. On a real session page this cuts
the bytes a phone downloads through the relay by about 60%.

Compressing before encrypting lets an observer of ciphertext sizes (the relay)
learn how compressible a response was, the property BREACH exploits. It is the
same exposure as gzip over HTTPS, which direct clients already get from the
server's compression middleware.

Request bodies crossing the tunnel are buffered on the host and forwarded to loopback only once the client's `StreamEnd` frame arrives (bodies above ~512 KB stream live instead). A buffered body that lost all its frames, or whose `StreamEnd` never arrives, therefore never reaches the loopback server as an empty/unfinished chunked body — the host aborts the stream and the client sees an ambiguous transport failure it can retry, instead of the loopback server's bare `400` ("Failed to send message (400)" from the mobile app). Buffering cannot see a body that lost only some of its frames; the encryption layer catches that. Each direction's encrypted messages carry consecutive counters, and the relay WebSocket loses nothing while it is open, so the decryptor (`e2ee.js`, `crypto.ts`) rejects a counter that skips ahead as well as one that repeats or goes back: a message the relay dropped fails the channel when the next message arrives. The receiving side runs this check, so request bodies have it only on a host that includes it and response bodies only on a client that includes it; an older host or client still accepts a gap, and mixed versions remain supported. For a buffered body the channel fails before the loopback request is made, so the loopback server never sees a shortened body. A body above ~512 KB streams live, so the bytes before the gap may already have reached the loopback server when the channel fails: the request is aborted and the client sees the same ambiguous transport failure, unless the loopback server already sent its complete response before the gap showed (then the client keeps that response). Either way the server may have acted on part of the body, so a retry is safe only for a request that can be repeated. If the dropped message was the last one sent, no later counter reveals the gap; a buffered body then never gets its `StreamEnd` and the host's body delivery timeout aborts it.

## Downstream flow control

`hello` and `ready` negotiate `flowControl: true` independently of `batch`.
When either peer omits the flag, the host keeps the legacy transmission path.
This capability controls host-to-client traffic only. Uploads retain their
existing request-body behavior. The Cloudflare broker needs no changes.

The client sends encrypted `DeliveryAck` frames on stream zero. Their payload is
an eight-byte unsigned big-endian cumulative count of received raw tunnel-frame
bytes on nonzero streams, including the five-byte frame header. Batch envelopes,
encryption overhead and stream-zero keepalives are excluded. The count resets
with each handshake. ACKs cover complete frames and include late frames for
cancelled streams, since those frames still consumed credit. The host rejects
duplicate, regressing, partial-frame or beyond-sent acknowledgements.

The client acknowledges after decoding and dispatching transport data, without
waiting for React rendering. It coalesces acknowledgements by byte count with a
short timer for the tail. Keepalives and ACK processing never await downstream
credit, which would deadlock the channel.

The scheduler starts with a small byte window. A backlogged sender can grow its
window when ACK latency stays near the best observed round trip, and reduces it
when delivery delay rises. Sparse traffic cannot inflate the window for a later
bulk burst. The window has a hard upper bound; a sudden bandwidth drop can still
delay bytes already sent, but cannot create an unlimited network backlog.

HTTP bodies and WS messages are sliced into small frames. The scheduler rotates
streams, preserves each stream's order, and batches selected frames before the
serialized encryption step. Producers offer a bounded group of slices and await
transmission before reading more. The legacy timed batcher remains in use only
without negotiated flow control.

HTTP/SSE backpressure reaches the loopback response reader. Node's `ws` pauses
loopback socket reads while output is waiting. Bun's `ws` shim cannot pause, so
the dispatcher instead enforces a connection-wide pending WS byte/message cap
and explicitly aborts the offending substream on overflow. It never silently
discards deltas. WS output messages are serialized through their last fragment,
and the close frame follows pending output. Cancellation releases queued work;
channel teardown releases all producers and acknowledgement state.

Regression coverage lives in `downstream-scheduler.test.js`, `flow-control.test.js`
and `cross-compat.test.js`. The end-to-end fixture uses the real client, host,
crypto and loopback requests with a byte-paced relay leg. It compares delivery
ordering, queue growth and a concurrent small response, including both legacy
fallback directions, unbatched operation, cancellation and fragmented WS output.
It does not replace a physical iOS/LTE check.

## Authentication model

### Self-reported app diagnostics

Host-control, host-data and client upgrades include optional `appId`,
`appVersion` and `platform` query parameters. OpenChamber sends `openchamber`,
the local package version and the local runtime. Client platforms use the
existing presence values: `desktop` for Electron, `vscode`, `ios`, `android`
and `web` for browsers, including hosted mobile. Hosts use
`OPENCHAMBER_RUNTIME`, defaulting to `web`, so SSH hosts report `ssh-remote`.
These labels describe the connecting process, not its remote target.

These fields are diagnostics only, outside the signed auth payload. Older
relays ignore them and older apps remain connectable. The hosted relay groups
missing or invalid fields as `unknown`. Its analytics count host-control and
client connections separately, including reconnects, and show labels as
self-reported, never as verified app identity. Host-data sockets are excluded.
App diagnostics are written on connection, without per-app traffic counters.
No credentials, device names or application contents are added to diagnostics.

### Access checks

- The tunnel is **transport only**. The OpenChamber server still authenticates every tunneled request exactly as it authenticates a direct remote client. The relay path grants reachability, not authorization.
- Clients carry their normal credential. HTTP and SSE requests authenticate with the client's bearer token (a header). **WebSocket upgrades cannot send headers**, so they authenticate with a short-lived URL-scoped token minted beforehand and passed as a query parameter. This asymmetry is important when adding new WebSocket features (see the skill).
- The host authenticates itself to the relay with a signed handshake using its long-lived signing key.
- Enabling the relay is explicit opt-in and disabled by default; disabling it severs all relay reachability immediately.

## End-to-end flow (overview)

1. **Pairing.** The host issues a pairing-v2 link (QR / deep link) carrying a one-time secret and a list of transport candidates. When the relay is enabled, one candidate is the relay transport (its endpoint, routing id, and encryption public key — the E2EE trust anchor). The client redeems the secret over the first reachable candidate; over the relay candidate it opens the E2EE tunnel first, then redeems through it, and stores the connection.
2. **Presence.** When the relay is enabled, the host opens one outbound control connection and waits.
3. **Connect.** The client connects for a given routing id; the relay notifies the host over the control connection; the host opens a matching per-client data connection.
4. **Handshake.** Over that connection pair, client and host run the E2EE handshake and derive a shared encrypted channel the relay cannot read.
5. **Traffic.** All normal app traffic is multiplexed and encrypted through that channel. On the host, decrypted requests are dispatched to the local server over loopback with the actual loopback origin, so normal origin checks still apply without trusting client-supplied origin metadata; responses stream back encrypted. Reconnects re-establish a fresh channel and the app's existing retry machinery recovers.

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

The E2EE and framing logic exists twice, in `packages/ui/src/lib/relay/` and in this module. Both implementations are TypeScript; the client implementation is the normative reference. They must stay byte-compatible. A client encrypted by one must decrypt on the other. `cross-compat.test.js` imports both implementations directly and exercises a full client-to-host exchange. A wire-format, frame-codec, handshake or batching change must update both sides and keep that test green.

## Runtime integration (client)

Client keepalive liveness comes from received frames only. Outbound HTTP retries
cannot suppress a probe of a silent peer. Any valid inbound traffic, including a
Pong, clears the probe deadline. Terminal relay close codes (auth failed,
duplicate client, limit exceeded) never schedule a timed reconnect: subsequent
HTTP requests and WS opens fail immediately instead of waiting. Those codes do
occur transiently in the field (a same-identity dial taking the leg, relay state
left by a host restart), so the client keeps its wake listeners armed and the
next `online` event or return to the foreground clears the error and makes one
fresh attempt. There is still no background loop. Transient failures use the
existing reconnect/backoff path. The client status marks such a parked error
with `terminal: true` and the relay's `closeCode`, so callers can tell it apart
from a pending reconnect, and `retry()` makes the same one fresh attempt on
request.

The relay may ask a peer to close instead of closing the socket itself: a
plaintext `{ "type": "relay-retire", "code", "reason" }` frame
(`parseRelayRetire` in `protocol.ts`, mirrored in `host-client.js`). A close the
relay sends to a peer that is gone, such as a phone asleep or a laptop with its
lid shut, holds the relay's handler until the closing handshake times out,
minutes later, and the relay is billed for the wait; measured on 2026-10-17,
six such closes cost ~900 s of Durable Object time and six retire frames ~1 s.
The tunnel client treats a retire frame exactly like a relay close with that
code, at any stage of the connection; a host data socket drops itself, and the
host control socket closes and takes the frame's code as its close code, so a
retire with `4001: Control replaced` keeps the 60 s hold-off and counts toward
the identity conflict, and any other code reconnects as after any drop. Peers that predate
the frame fail closed on unknown plaintext once the E2EE handshake is done,
which ends in the same reconnect; before the handshake they ignore it and
reconnect on their own handshake timeout.

The limit refusal (4029: more than 16 clients at once, or more than 60 client
connects a minute, per server) gets its own user-facing state, read from
`closeCode` through `isRelayLimitReached`, never from the message text. A probe
that hits it reports `relay-limit` instead of unreachable: the phone's connect
screen and error text, and the desktop instance switcher and Remote Instances
rows, say the relay refused the connection. When the runtime tunnel itself
parks on it, the phone runs its resume re-probe, which hot-switches to a
reachable LAN address or drops to the connect screen with that notice; the
connect screen sends no immediate background retry, since a dial right away
only counts against the same limits. A desktop window shows a toast with a
retry action, because a visible desktop window gets no foreground event to
wake the tunnel. `subscribeActiveRelayTunnelStatus` in `runtime-tunnel.ts`
follows whichever tunnel is the runtime's at the time.

Mobile connect flows (`packages/ui/src/apps/mobileConnections.ts`, helpers in
`mobileRelayFetch.ts`) log the relay failure reason (close message or
`timeout`) in the connect trail. Idempotent probes (`/health`,
`/auth/session`) wait for the tunnel's own reconnect after a dropped socket and
ask again within their budget; pairing redeem and password login are sent once.
Pairing, logging in again, and the session probes of auto-connect and connect
ride the connected runtime tunnel when the phone is already on that server
through the relay, and do not open a second tunnel to the same server: the
relay keeps one client leg per device and server, so a second dial drops the
live session. A probe dials its own tunnel only when the live one gives no
answer.

Relay mode plugs into the existing client transport layer rather than a parallel path: `runtime-switch` activates the tunnel singleton, `runtime-fetch` routes runtime requests through it, `runtime-url`/`runtime-socket` yield tunnel-backed URLs and sockets, and `runtime-auth` mints the URL-scoped token through the tunnel. Direct-URL connections and the Electron realtime-proxy path are unaffected.

A URL the browser loads itself (`<img src>`, `<video src>`, an iframe) never enters the tunnel: in relay mode the runtime base is the page's own origin, so such a URL gets the desktop protocol's 503 or the phone's app shell. `runtimeAssetsNeedFetch` is true in relay mode, so chat images and Files previews read their bytes through `runtimeFetch`. Other browser-owned URLs stay unreachable over the relay, among them chat and document video and HTML previews.

## Design invariants (do not regress)

- The relay never sees plaintext application traffic; it sees only routing metadata (routing id, connection identifiers, timestamps, coarse counts).
- Pairing secrets travel in URL fragments only, never in query strings, never logged.
- Host dial URLs carry the signed relay auth in their query string, and Bun's WebSocket copies the whole URL into its error messages. Relay errors reach logs and the relay status only through `describeRelayError` in `host-client.js`, which strips query strings and userinfo from every URL in the text.
- The host dispatcher never injects credentials; the server authenticates each tunneled request.
- The tunnel is transparent to the app: adding relay support to a feature should not require the feature to know the relay exists — it goes through the shared runtime transport helpers.
- The two implementations stay byte-compatible and the wire format is versioned/negotiated so mixed client/host app versions degrade gracefully rather than break.
- Signing and encryption use separate keypairs because WebCrypto keys have a single purpose. Generating either key emits a warning because changing the signing identity or encryption trust anchor orphans existing pairings; the signing identity also binds push tokens.
- Public signing JWKs use the fixed field order `crv`, `kty`, `x`, `y` before hashing or encoding. The website's relay auth uses the same canonical bytes, and relay signatures use ECDSA-SHA256 with IEEE P1363 raw `r||s` encoding so WebCrypto can verify them.
- Key-store rewrites preserve unknown fields so additions from newer builds survive. Store operations serialize within the process, and creation re-reads the identity file after reading legacy settings so an intervening write can supply the existing key.
- Legacy settings cleanup is best effort after the identity file holds the keys. A failed cleanup leaves the identity valid and retries on the next load; generation-aware caches observe an explicit reset in both relay runtimes.
- Host claims coordinate retry ownership cooperatively. The relay worker remains the authority for the single host slot, so an unwritable claim file permits hosting and worker arbitration. Releasing a claim only removes the current instance's claim.
- Inbound decryption and outbound encryption plus sending serialize independently per direction. Each encrypted WebSocket message consumes 1 consecutive counter, whether it carries 1 frame or a batch; scheduling and reordering happen before encryption.
- A repeated `hello` with the accepted public key re-sends the cached `ready` to tolerate client retries. A different key fails with 1008; unexpected plaintext after establishment, encrypted traffic before establishment, and decryption failures close the channel with 1011. Missing capability flags retain legacy behavior.
- Status and share-state listeners cannot break the transport. Data-channel failure logs contain connection identifiers and reasons only, without application payloads.
- A late socket callback only tears down the entry it still owns. A replacement dial can already hold the same connection id, so callbacks from the old socket must leave it intact.
- Relay management routes precede the generic OpenCode proxy and remain behind the global UI auth gate. Hosting belongs to the web server, including Electron's embedded server; shared UI treats these routes as web-runtime capabilities because VS Code does not host a relay.
- Device and pending-pairing demand drives lifecycle reconciliation, and creating a relay pairing link supplies that demand without a separate toggle. Relay candidates have last-resort priority after direct LAN and tunnel candidates. Enterprise pinning keeps routing metadata and the access path inside the deployment even though traffic is encrypted on either endpoint.
- A request body sink exists before body frames arrive and stops accepting bytes after completion or abort. `StreamEnd` half-closes the request body while the response continues. Synthetic HTTP responses include an explicit reason and `source: 'relay-tunnel-host'` so callers can distinguish a host-generated error from an upstream response.
- Tunneled HTTP requests keep the remote client's headers, `X-Forwarded-For` included, and reach the server from loopback. The host stamps each request with the relay proof (`provenance.ts`), and the sign-in limit (`../security/client-address.ts`) keys every request with relay provenance to one shared relay budget, so forwarding headers from a relay client never pick a bucket. `x-openchamber-relay-connection` is not proof of relay provenance: a same-host reverse proxy can pass it through.

## Decisions

### Host conversion contracts

`host-client.js` and `tunnel-host.js` use the constructors, lifecycle events,
raw-data union and backpressure methods in `../shared/websocket-contracts.js`.
`service.js` uses the application, handler, request and response contracts in
`../shared/http-contracts.js`. The shared package declarations supply the
existing `ws` imports and Express JSON middleware factory.

The socket contract retains the full raw-data union for sockets whose mode is
unspecified. Newly constructed sockets use `nodebuffer` mode, so their message
contract is `Buffer`; the generic mode also constrains `binaryType`. The relay
never changes that mode. The existing Buffer check in the loopback dispatcher
remains unchanged.

`describeRelayError` reads a thrown value's unchecked `message` field and applies
the redactor's existing `String(value || '')` coercion before calling its
string-typed boundary. This preserves primitive, nullish and non-string error
messages without changing the source-control module.

`platform.d.ts` connects server-native streams to the installed Node contracts
for BYOB readers and `pipeThrough`. DOM and Node stream declarations disagree
on BYOB readers and completed read results even though native `fetch` supplies
the same runtime stream that `Readable.fromWeb` accepts. The overloads use the
Node-owned reader, transform and result types without replacing constructors or
declaring another stream implementation. Loopback fetch options retain the existing explicit undefined
`duplex` value. The downstream scheduler preserves each submitted frame's buffer
type through its queue, so ArrayBuffer-backed frames reach WebCrypto without
assertions or copies.

The dispatcher also accepts arbitrary entries in a
wire `protocols` array and lets `ws` validate them. A `string[]` type would claim
validation the dispatcher does not perform; tightening its validator changes
the wire acceptance rules. The shared constructor accepts unchecked protocol
arrays and retains the library's runtime validation.

### Why service inputs retain optional property reads

Settings and HTTP bodies remain unchecked at their read boundaries. Guards for
optional fields exclude only null and undefined, preserving JavaScript's boxed
property access on primitive values and leaving each field unknown until its
own check. Relay URL checks retain their non-string fallback, whitespace
normalization and protocol validation. Thrown values likewise keep an unchecked
`message` field so route errors retain the existing nullish fallback.

Host options include the existing share-state callback, batching controls and
socket factory. The optional legacy local port stays undefined when neither port
source is supplied. Package version data remains unchecked until URL string
coercion. Loggers may omit `info` on the optional close-log paths; idle reaping
retains its existing TypeError when that method is absent.

Wire guards retain their object, string and array checks, including array-valued
header containers and unchecked protocol-array elements. Header names from
`Object.entries` are already strings, but header values and WebSocket close
reasons still require their original primitive-string checks. Node/Bun timer
handles provide `unref`; an internally supplied port accessor is already typed
as a function.

The request-body controller is installed synchronously by `ReadableStream.start`.
A checked accessor expresses that invariant, and a failure accessor exposes
closure writes made while awaiting body completion. Empty scheduler batches and
dispatch before tunnel establishment remain invariant failures. Ignored cleanup
and listener errors stay ignored.

### Why key and handshake types preserve partial input

The identity-file schema requires only each JWK's nonempty `kty`; WebCrypto and
Node crypto validate key material when importing it. Public-point extraction
explicitly supplies `kty`, `crv`, `x` and `y`, including undefined when a field
is absent. The public-point contract preserves those explicit values. Legacy
settings and identity rewrites preserve fields owned by other modules or newer
versions. Schema-derived settings types retain those fields without interpreting
them here.

Handshake guards preserve the existing object and string checks, including
ignored unknown messages, absent capability flags and malformed keys rejected
during import. File and process errors retain their original `code` and
`message` handling. An `EPERM` pid probe keeps a claimant live, and a failed
claim release remains best effort.

### Why occupied entries have checked accessors

Frame-length checks, loop bounds, queued-frame insertion and key creation
establish occupied byte, queue, acknowledgement and key slots. Checked reads
express those invariants under `noUncheckedIndexedAccess` without assertions
or fallback data. The batcher's unchecked empty-frame type byte retains its
existing bitwise-zero behavior.

### Why separate control and data liveness checks and not socket state alone

A silently dead control path can leave the host apparently registered while new clients wait forever, so pings and received traffic establish liveness independently of the open timeout. Idle data sockets expire after 3 client ping intervals because the relay can retain a dead client leg long enough to leak resources and inflate the connected-device count.

### Why retain data sockets and not close them on every control reconnect

Data sockets have independent relay connections, and the relay gives clients a 30 s control-reconnect grace window. Keeping those sockets open preserves active tunnels while control registration recovers.

### Why schedule plaintext fairly and not skip whichever frame lacks credit

Selection waits for a larger queue head when necessary so smaller frames cannot starve it. A microtask lets concurrent producers join the round, while stream-zero keepalives bypass delivery credit to keep the channel live.

### Why adjust credit once per window and not once per acknowledgement

ACK bursts must not multiply window adjustments, and sparse token traffic must not enlarge the window for a later bulk burst. Growth requires a credit-limited sender, while rising delivery delay reduces the window.

### Why release cancelled producers and not await encryption completion

Already-selected frames can still reach the client and remain part of cumulative acknowledgement accounting. Cancelling a stream releases its producers immediately even while encryption is in progress.

### Why reserve envelope space and batch only high-volume frames

The payload budget reserves batch-envelope overhead so a single frame always fits the 64 KiB encrypted plaintext limit. The legacy batcher flushes setup, teardown and keepalive frames immediately to avoid delaying first output, terminal echo and liveness; its 150 ms data window fits within the chat renderer's 100 ms input throttle and roughly 64 ms paced reveal.

### Why rebuild loopback headers and not forward transport framing

Hop-by-hop headers and content lengths describe the original transport, so loopback fetch computes its own framing and the tunnel strips obsolete response framing and encoding headers. The host supplies the actual loopback origin because browser-generated origins are unavailable to the tunnel client, custom-scheme WKWebViews can report empty or `null` origins, and an originless WebSocket upgrade fails the server's origin check; the tunneled client credential still supplies authentication.

### Why settle buffered-body waits and resume paused WebSockets during teardown

A buffered-body timeout settles the waiting task so its chunks and call frame are released; crossing the live-stream threshold transfers ownership to forwarding and clears that deadline. Completed buffered bodies use a single buffer so Bun supplies a content length, and a paused WebSocket resumes before close so it can read the peer's closing handshake.

For the operational rules that keep future changes (new WebSocket endpoints, transport refactors, terminal/voice porting) from breaking this, load the `relay-transport` skill.
