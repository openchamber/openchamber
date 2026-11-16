# Relay client

## Ownership

This folder is the client half of the OpenChamber private relay. The host half, the relay worker, and the normative description of the three protocol layers live in `packages/web/server/lib/relay/DOCUMENTATION.md`; this folder follows that document and does not restate its wire format.

- `protocol.ts` is the shared contract: constants, frame types, message shapes, close codes. The host's plain-JS modules mirror it, so a wire change updates both sides and keeps `cross-compat.test.js` green.
- `crypto.ts` and `handshake.ts` own the E2EE primitives and both handshake state machines.
- `tunnel-codec.ts` owns Layer 3 framing, fragmentation, the batch envelope, outbound batching, and stream-id allocation.
- `tunnel-client.ts` owns the client tunnel: the relay socket, the initiator handshake, muxed HTTP/SSE/WS streams, keepalive, status, and reconnect policy.
- `tunnel-payloads.ts` normalizes a fetch-style request into tunnel payloads.
- `runtime-tunnel.ts` holds the active tunnel for the running page; `runtime-socket.ts` is the one entry every runtime WebSocket consumer uses, and `native-websocket.ts` is the Capacitor bridge behind it.
- `transport-error.ts` owns the ambiguous-versus-definite transport failure tag.
- The tunnel is transport only. The server authenticates every tunneled request exactly as it authenticates a direct one; nothing here grants access.

## Invariants

- These modules are WebCrypto-only and isomorphic: a browser, Node, WKWebView, and a Worker load them unchanged.
- Each direction of a session has its own AES-256-GCM key; the client encrypts with `clientToHost`, the host with `hostToClient`.
- An encrypted frame's IV is a 4-byte random per-direction prefix followed by an 8-byte big-endian counter that starts at 1. The decryptor requires strictly consecutive counters: a repeat or regression means tampering, a gap means a lost frame, and both fail the channel with 1011.
- The host's encryption public key reaches the client only through the pairing offer, never through the relay. It is the trust anchor: only the real host derives the same session keys.
- A repeated identical `hello` re-sends `ready`. A `hello` with a different client key after establishment is a rekey attempt: close 1008 and never rekey in place. After establishment only a duplicate `ready` is legal plaintext; anything else closes 1011. Before establishment, unknown plaintext is ignored so a recoverable connection is not torn down.
- `replyText` is delivered to the peer before any encrypted frame.
- The `hello` nonce is 16 random bytes encoded as base64url; `deriveSessionKeys` rejects any other length.
- `batch` and `flowControl` are negotiated capabilities: enabled only when both peers advertise them, and a missing flag means legacy one-frame-per-message behavior.
- At most 64 KiB of plaintext travels in one encrypted frame. `MAX_TUNNEL_PAYLOAD_BYTES` subtracts the tunnel header and the worst-case batch envelope so a payload at its limit still fits once wrapped, and a reassembled fragmented message is capped at 16 MiB.
- Client-initiated streams use odd ids from 1; even ids are reserved.
- Encrypt and send are serialized so IV counters reach the wire in encryption order; decrypt is serialized so the counter check sees wire order. One `encrypt()` call is one encrypted message and one counter tick, whether it carries a batch or a lone frame.
- A request with any body source sets `hasBody`, and a body source that yields no bytes still sends one empty body frame so the host can tell it from body frames lost in transit.
- Once a request head has been written to the channel, a lost stream is an ambiguous transport failure: the response was lost, not the request. Transports tag that state and callers read the tag; message text is never matched.
- Delivery acknowledgements count cumulative raw frame bytes on nonzero streams, including frames of cancelled streams, and are sent after decoding.
- Only received frames prove peer liveness. Outbound retries never suppress the probe, and the pong deadline runs independently of the ping cadence.
- Relay close codes `4010`, `4002`, and `4029` never schedule a timed reconnect: the tunnel parks in `error` with `terminal` and `closeCode`, and only an `online` or foreground wake, or `retry()`, makes one fresh attempt.
- Every runtime WebSocket is opened through `openRuntimeWebSocket`. A raw `new WebSocket` to a relay-mode URL fails, because the resolver yields a tunnel-virtual URL the platform rejects.
- A WebSocket stream killed by a tunnel reset closes with 1012, which callers' reconnect machinery treats as "host went away, retry".
- `subscribeActiveRelayTunnelStatus` follows whichever tunnel is the runtime's at the time and delivers changes only; the current value comes from `getActiveRelayTunnel()?.getStatus()`.
- Views handed to `DecompressionStream` or `WebSocket.send` are backed by a plain `ArrayBuffer`; a view over shared memory is copied first.
- Status and stream listeners are isolated: a listener or teardown handler that throws cannot break the tunnel or the remaining streams.

## Decisions

### Why the exported public JWK is narrowed to four fields

`exportPublicKeyJwk` keeps only `kty`, `crv`, `x`, and `y`. Other fields (`key_ops`, `ext`) differ between implementations and runs, and the fingerprint that detects a rekey attempt must compare stable serializations.

### Why the active tunnel singleton lives in its own module

`runtime-switch`, `runtime-fetch`, `runtime-url`, and the event pipeline all need to read it, and `runtime-switch` and `runtime-url` already import each other. A separate module lets every caller read the tunnel without closing that cycle.

### Why an equal descriptor reuses the running tunnel instead of reconnecting

A redundant runtime switch would otherwise tear down a live tunnel and pay a new connect plus handshake for the same server.

### Why the connect flow adopts its probe tunnel

The probe has already paid for a WebSocket connect and the E2EE handshake, so the immediately following activation adopts it. Re-adopting the live runtime tunnel (a pairing redeemed through it) only records the new descriptor so the next activation matches.

### Why status is a plain listener set and not a shared store

The tunnel is imported by runtime plumbing that stores import; routing status through a store would add the dependency and an import cycle. Listener exceptions are swallowed for the same reason: status delivery must not break the connection.

### Why a terminal relay rejection keeps wake listeners instead of parking silently

Auth failures, a duplicate-client eviction, and the limit refusal also occur transiently in the field (relay-side stale state, a same-identity probe dial). Parking with listeners armed lets the next foreground or `online` event start one fresh attempt, where a background retry loop would hammer the limits; before this, the field remedy was a full app restart.

### Why offline or hidden reconnects back off to a long cap

While the page is offline or hidden, recovery arrives through the `online` and `visibilitychange` events, so probing a dead network on the normal schedule only burns attempts. The longer cap holds the timed retry until that wake.

### Why the pong deadline is a separate one-shot timer

A pong wait that shares the ping interval is only noticed on the next cycle. A dedicated deadline catches a dead socket roughly `pingTimeoutMs` after an unanswered ping, and any received frame clears it.

### Why the tunnel tags dispatched failures instead of matching message text

A renamed abort reason would silently reclassify a send. `prompt_async` is the case that matters: treating an ambiguous failure as definite rolls back the user message, and the queue then re-sends a prompt the engine is already answering, producing two responses. `fail()` creates a fresh tagged error so the tag cannot leak to waiters whose request never reached the wire.

### Why outbound encryption is serialized

The per-direction IV counter must hit the wire in encryption order or the receiver fails closed, so `sendEncryptedPlaintext` chains every encrypt-and-send, batched or single.

### Why batching is leading-edge with a 150 ms window

The chat render pipeline already gates visible updates well below this: a 100 ms input throttle feeds a ~64 ms paced reveal that smooths arrival bursts, and the app tolerates 200 ms under backpressure. A 150 ms window is invisible to users while cutting Durable Object messages about a third more than 100 ms. The leading edge keeps time-to-first-token and terminal echo instant, and non-body frame types flush any pending buffer first so per-stream ordering survives.

### Why only body and WebSocket frames are batched

Setup, teardown, and keepalive frames decide latency and liveness, so they ship immediately; buffering them would delay time-to-first-token, terminal echo, and dead-peer detection for no bandwidth gain.

### Why the tunnel's WebSocket open payload carries no Origin

The host sets the Origin itself to the loopback origin it dials. The client's `window.location.origin` is unreliable in WKWebView, so sending it would replace a correct host-side value with a wrong one.

### Why Blob, FormData, and URLSearchParams bodies go through `Response`

Serializing them with `Response` produces exactly the bytes and content type a native fetch would, including the multipart boundary FormData derives.

### Why relative URLs are parsed against `http://tunnel.invalid`

Runtime paths arrive origin-relative, and only `pathname` and `search` are read; the host is discarded. One shared constant keeps the relay modules from each inventing their own parse base, and the `.invalid` base is never fetched.

### Why the native bridge base64-encodes in 8 KiB slices and copies exact byte ranges

The bridge carries binary frames as base64 and consumers expect the same `ArrayBuffer` shape the relay delivers. Slicing keeps `String.fromCharCode` spread arguments bounded, and a view is copied by `byteOffset`/`byteLength` so it never reads its neighbours.

### Why the native bridge chains open before close and sends

The plugin bridge can resolve slowly. Seeding `writes` with the open promise keeps open, then close and sends, in that order on the bridge.

### Why a phone's relay WebSocket connects through the native bridge

Capacitor's WebSocket cannot carry the proxy headers the runtime needs, so `openRuntimeWebSocket` picks the bridge only for same-origin URLs and falls back to a browser socket otherwise.
