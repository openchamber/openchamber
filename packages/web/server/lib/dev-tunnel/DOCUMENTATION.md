# Dev Server Tunnel

## Purpose

This module carries raw TCP bytes between a desktop or native mobile client and a dev server
running on the OpenChamber host, so a remote dev server can be opened in the
browser panel without anything being rewritten.

The page is served from a real origin at the root of its own host. That is the
whole design: absolute URLs resolve, cookies scope correctly, HMR sockets
connect, and developer tools behave as they do locally. No HTML, header, or
URL is inspected or modified, which is what the previous rewriting proxy did
and what made it fragile per framework.

## Boundaries

- `runtime.ts` is the host end: it accepts the WebSocket upgrade at
  `/api/dev-tunnel`, authenticates it, opens a TCP socket to the requested
  local port, and pipes the two together.
- `client.ts` is the local end: it binds a loopback listener on the user's
  machine and pipes each accepted connection through one WebSocket. It lives in
  this package because it needs a WebSocket client the package already depends
  on; the desktop shell drives it over IPC for directly reachable HTTP(S)
  runtimes.
- Relay-only runtimes use `packages/electron/relay-dev-tunnel.mjs` for the local
  listener. Each accepted connection gets an Electron `MessagePort`; the trusted
  renderer carries its bytes through the active E2EE relay. This keeps relay
  credentials and encryption in their existing renderer owner instead of
  duplicating them in Electron main.
- Capacitor mobile uses loopback listeners in `packages/mobile` (Android
  ServerSocket and iOS NWListener). The shared renderer owns their authenticated
  tunnel WebSockets through `packages/ui/src/lib/browser/mobileDevTunnel.ts`;
  the native plugins receive only opaque bytes and have no relay credentials.
- Port discovery is not owned here. `runtime.ts` is given the reachable set by
  the same dev-server discovery the user's own list is built from.
- The browser panel decides when to tunnel; this module never chooses a target.
  `packages/ui/src/lib/browser/devTunnel.ts` owns that decision, including for
  navigations the page starts itself: a tunnelled page that sends the view to
  another loopback port means a port on the host, not on the user's machine.
  The desktop SSH manager marks ready forwarded API endpoints. A different
  loopback API port without that mark stays local and does not open a tunnel.

## Invariants

- A connection failure, including a synchronous WebSocket constructor error,
  closes only that connection. It cannot escape the connection handler and
  terminate the process or an otherwise usable listener.
- Socket reads pause while the other end drains. Pre-handshake bytes remain
  bounded and ordered so the first HTTP request survives without buffering a
  stalled request or a fast response without limit. Refusal logs omit URLs
  because a URL can carry an authentication token.
- The reachable set is exactly what dev-server discovery offers the user, never
  "any loopback port". Without that restriction an authenticated client could
  dial arbitrary local services on the host — databases, admin panels, the
  OpenCode API — through this socket.
- Authentication depends on whether the caller is a browser, and this is
  deliberate rather than a relaxation:
  - With an `Origin` header the request came from a browser context, and the
    usual origin allowlist applies unchanged. That check is a CSRF defence: a
    hostile page can make a browser open a WebSocket carrying ambient cookies,
    and the origin is what exposes it.
  - With no `Origin` the request must carry client-token auth or a short-lived
    URL token. The bearer case is the desktop main process. The URL-token case
    is the trusted renderer carrying the socket through the E2EE relay.
  - Through the E2EE relay, the trusted renderer mints a short-lived URL token
    and includes it in the virtual WebSocket URL. The relay host and URL-token
    allowlists accept exactly `/api/dev-tunnel`, not subpaths.
- The host dials `127.0.0.1` and falls back to `::1` when nothing answers
  there. Discovery offers ports bound to either loopback family, and a dev
  server started with `localhost` defaults often listens on IPv6 only.
- Every refused upgrade and every failed dial is logged on the host with its
  reason. The desktop only sees its local connection close, which the panel
  cannot tell apart from a dev server that is still starting.
- Concurrency is capped per host, not per page, because one page load opens
  many sockets.
- Native mobile forwards previews through an ephemeral `127.0.0.1` listener,
  one per remote dev-server port. Each TCP connection uses one authenticated
  tunnel WebSocket. The iframe keeps its own origin and can use HMR WebSockets.
  Switching runtimes stops the phone listeners and their streams; hosted web
  stays blocked from remote loopback addresses.
- Desktop forwards previews through `openchamber-preview.localhost`, bypassing
  proxies for that exact hostname. Listeners still bind `127.0.0.1`, and only
  that API host keeps the bundled connection-limit exemption. Address bars and
  saved tabs retain the original URL; cookies and storage use the new origin.
- A connection that cannot be established fails the socket rather than holding
  it open; a stalled connect is bounded by an explicit timeout, and so is the
  WebSocket handshake. While it is pending the local socket is paused and its
  buffered bytes are capped, so a local process writing into a stalled
  handshake cannot grow the desktop app's memory.
- A tunnel that cannot be opened is reported to the panel, never replaced by the
  plain loopback URL. On a remote instance that substitution would change which
  machine answers and show local content under a remote address.
- Closing either end closes the other. A half-open pipe would leave the page
  waiting on bytes that will never arrive.
- A dev server inside an isolated space is reached the same way, with a space
  id: the client dials `/api/spaces/<id>/dev-tunnel`, which the host forwards
  to the server inside the space, and that server dials the port on its own
  loopback against its own discovery. A space's tunnel is keyed apart from the
  host's on the same port. What the desktop does with the page it gets, a
  session of the space's own behind a proxy that reaches only its tunnel ports,
  is in `packages/electron/space-preview.mjs` and the "Preview" section of
  `packages/web/server/lib/spaces/DOCUMENTATION.md`.

## TypeScript contracts

Both implementations import `ws`. The shared package declaration connects its
constructors, upgrade callbacks, socket events and raw-data types to
`../shared/websocket-contracts.js`. The client constructor supplies
`WebSocket<Buffer>`. The server selects `WebSocketServer<Buffer>` because it
retains the default `nodebuffer` mode. Neither end changes frame mode after
registering its message listener.

`contracts.ts` owns tunnel options, listener state and public results. Discovery,
authentication, origin checking and upgrade refusal reuse their owners' types.
The runtime assigns its TCP socket synchronously in `dial(0)` before any socket
event can read it. Teardown keeps optional destruction for that initialization
boundary.

### Why frames stay unmodified

Both ends forward the bytes supplied by `ws` directly. Adding frame conversion
or validation would change the existing implementation. The shared server
contract carries a frame-type parameter through connection events, clients and
upgrade callbacks. Its default remains the full `RawData` union, preserving
existing consumers and other frame modes.

### Why the client checks the URL scheme

WHATWG URL protocol assignment cannot cross from a non-special app scheme to
`ws`. Rejecting non-HTTP(S) base URLs before binding a listener preserves the
existing error instead of deferring it to the first TCP connection.

The runtime also imports Node's TCP API and the request-security helpers. Its
external inputs are the HTTP upgrade URL and headers, authentication and discovery
results, WebSocket frames, TCP bytes and socket errors. The client imports Node's
TCP API and accepts the remote base URL, port, optional headers and space id from
Electron main. Its defaults remain an empty header object, a null space id, a
15-second handshake timeout and a 256-KiB pending-byte limit. Neither end reads
files or environment variables directly.

The client keeps the string-address check on `server.address()`, whose API can
return a pipe name. The runtime keeps the string check on the request's origin
header before trimming it. These checks validate runtime boundary values.
Catch handlers read the optional message on any non-null thrown value, preserving
logging for errors, plain objects and primitives.
