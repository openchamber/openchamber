# Direct E2EE service

`service.js` owns the direct-E2EE outer WebSocket endpoint.
It is a `WebSocketServer({ noServer: true, perMessageDeflate: false })` with explicit attach/detach lifecycle.
`runtime.js` owns production dependency injection, exact active-profile resolution, canonical candidate construction,
and listener cleanup.
`server/index.js` initializes that runtime and does not implement endpoint policy itself.
Runtime refreshes are generation-fenced and publish unavailable state while authoritative profile reads are pending or failed.
Legacy controllers without a retained profile ID may resolve only one enabled saved profile matching the canonical live hostname;
an explicit unknown ID or ambiguous hostname never falls back.

The service validates the exact path, active enabled managed-remote profile,
and canonical public authority before allocating a WebSocket. It reuses the
relay identity, encrypted session, crypto, codec, and tunnel host unchanged on
the wire. A random process-local marker is injected only after tunnel-host has
removed client forwarding, Cloudflare, Origin, and `x-openchamber-*` headers.
`tunnel-auth.js` recognizes only the exact marker as `remote-client`; the marker
is routing context, never a credential.

The outer upgrade owns only the exact raw origin-form target
`/api/openchamber/direct-e2ee/ws`. Query, fragment, trailing-slash, absolute-form,
dot-segment, and encoded aliases are rejected without normalization; unrelated
upgrade paths remain available to coexisting listeners.

Browser and WebView clients necessarily send `Origin`. The outer endpoint accepts
one syntactically valid Origin value as untrusted metadata and never uses it for
authority, authentication, profile selection, or admission identity. It is stripped
before loopback dispatch. Conventional CSWSH ambient-auth reasoning does not apply:
the outer socket accepts no cookie or query credential, and authorization occurs
only through a bearer token inside ciphertext authenticated to the pinned host key.
Admission and handshake deadlines bound unsolicited browser handshakes.

Admission defaults are 16 pending handshakes, 16 ordinary pre-authenticated
sessions, 4 reconnect-reserve pre-authenticated sessions, and 64 authenticated
sessions. Handshake timeout is 15 seconds; ordinary authentication has 20
seconds. Reserve sessions have 2 seconds and permit health plus bearer session
confirmation, but not pairing redemption. This keeps short-lived reconnect
capacity available under ordinary pre-auth saturation without letting Ping or
health extend either deadline. Per session: 24 streams, 4 nested WebSockets, 8
fragment assemblies, and 40 opens per 10 seconds.

Incomplete fragments are admitted only for an already-open nested WebSocket and
share a 256 KiB pre-authenticated byte budget, in addition to the existing count
and per-message limits. The live budget switches to 16 MiB only after bearer
promotion. All fragment state is discarded with its stream or outer session.

Before promotion only encrypted `GET /health`, pairing redemption, and
bearer-authenticated `GET /auth/session` are dispatched. Pairing alone never
promotes. A successful session response binds the authenticated client ID.
After promotion, `/auth` traffic has an exact no-query allowlist: `GET /auth/session`,
`POST /auth/url-token`, and `GET /auth/passkey/status`. The status response exposes
only passkey enablement, relying-party metadata, and credential count; browser
passkey ceremonies remain unavailable. The exact `/auth` path and every other
`/auth/*` target, method, query, subpath, unknown route, or case variant fail closed
by terminating the outer session before loopback dispatch. Non-authenticated-route
policy is unchanged.
Unlike hosted relay sessions, direct sessions treat every ignored textual frame
before establishment (malformed JSON, unsupported version, non-hello type, or empty
text) as terminal. An identical valid hello retry still receives the same ready
response; established rekey mismatch behavior is unchanged.
Runtime clients therefore gate each newly handshaken channel, including every
automatic reconnect: they require the strict health identity
`{ status: "ok", openchamberVersion: string }`, then HTTP 200 with
`{ authenticated: true }` from bearer-authenticated `GET /auth/session`, before
publishing connected state or permitting ordinary HTTP/SSE/WebSocket traffic.
Bearer tokens are activation-only transport state and are never stored in the
direct candidate descriptor or URL. A rejected/revoked token is terminal;
readiness 408/429/5xx and transport failures retry with backoff, while malformed
identity/session responses fail closed as protocol errors.
Pre-auth policy violations and malformed, unsolicited, replayed, oversized, or
otherwise undecodable tunnel traffic fail closed by terminating the outer session.
Request targets are canonicalized before policy and loopback dispatch; ambiguous
slashes, traversal, encoded separators, controls, and path/query confusion are
rejected. Authentication bookkeeping uses a unique request generation so numeric
stream-ID reuse cannot promote a stale result.

Outer upgrades carrying a browser `Origin` are accepted as untrusted metadata and
stripped before loopback dispatch. Pending, ordinary pre-authenticated, and reserved
handshakes are bounded per source. A syntactically valid `CF-Connecting-IP` is
accepted only when the TCP peer is loopback (the local cloudflared connector);
otherwise the validated socket peer address is authoritative.
Oldest same-source probation is evicted at a source cap, the oldest pending entry
is evicted at the global pending cap, and a full reserve turns over its oldest
entry for the newest short-lived probation. Source values are never logged.
Reconnect reserve entries must complete the exact encrypted `GET /health`
generation with status 200 before bearer session confirmation and remain subject
to their two-second deadline.
Profile disable/stop/switch and client revocation hooks close outer sessions;
the tunnel host then aborts all inner HTTP/SSE/WebSocket work. Logs contain only
fixed reason categories and opaque connection IDs.

The endpoint is supported only while the production runtime is initialized.
It is available only for the exact active `managed-remote` profile when that saved profile has
`directE2eeEnabled === true` and its canonical HTTPS hostname matches the live tunnel URL.
Pairing emits the canonical `wss://<hostname>/api/openchamber/direct-e2ee/ws` candidate only on explicit request.
The authoritative runtime publishes the same-origin suppression authority separately from identity construction,
so an unavailable identity cannot expose the plaintext managed-tunnel candidate for an active E2EE profile.
Stopping, switching, or disabling closes affected direct outer sessions without revoking paired-device tokens.
