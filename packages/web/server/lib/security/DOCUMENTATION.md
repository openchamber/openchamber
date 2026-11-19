# Request security

## Ownership

This module owns bind-address helpers and browser-origin decisions shared by
HTTP and WebSocket consumers. `../ui-auth` owns credentials and session cookies;
`../enterprise-mode.js` owns administrator policy.

## Invariants

- `Origin: null` is refused even without a UI password. Sandboxed untrusted
  previews and extension frames produce it, and no OpenChamber client needs it.
- Passwordless sockets still validate a supplied browser origin. A browser
  supplies Origin and can send ambient cookies; a non-browser client can omit
  it, so omission and an untrusted browser origin have different meanings.
- Only development servers trust arbitrary loopback UI ports. Released servers
  cannot let another local dev server or preview act with the user's cookie.
- Packaged origins include desktop, iOS `capacitor://localhost` and Android
  `https://localhost`. Omitting one breaks that client's socket upgrades while
  its SSE traffic can continue.
- Session identity uses the same host-port cookie resolver as issuance and
  validation. Extracted notification identity is not a CSRF token.
- Frame ancestors contain the app and packaged shells plus development origins
  only in development. Configured additions must be plain origins or the
  explicit wildcard; untrusted documents supply their own response policy.
- `OPENCHAMBER_LAN_URL` is an HTTP(S) origin override for hosts whose reachable
  LAN address is invisible inside a container. An invalid value is ignored.
- Bind helpers receive strings already resolved by server startup or the CLI.
  HTTP headers and the stored `publicOrigin` retain string validation at use.
- Origin decisions return either a boolean immediately or a promise when
  reading settings. Upgrade consumers must support both forms.
- Forwarded-host and host arrays use their first entry. Empty arrays still fail
  instead of becoming an absent header. Malformed cookie escapes return their
  raw value.
- A failed settings read preserves request-derived origins. Upgrade rejection
  still destroys the socket after a failed write and ignores destruction errors.

## Decisions

### Why origin checks compare the external host and not the upstream protocol

TLS can end at a cloud edge before a plain HTTP reverse-proxy hop. The browser's
HTTPS origin remains valid when its external host matches, even if that hop
does not preserve the original protocol.

### Why stored origins retain runtime validation

The settings reader is an unconverted JavaScript dependency. Its expected
`publicOrigin` contract is optional text, but file contents still need validation
before URL parsing. Invalid or unreadable settings leave request-derived
candidates intact.
