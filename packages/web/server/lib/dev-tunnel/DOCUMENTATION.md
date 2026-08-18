# Dev Server Tunnel

## Purpose

This module carries raw TCP bytes between a desktop client and a dev server
running on the OpenChamber host, so a remote dev server can be opened in the
browser panel without anything being rewritten.

The page is served from a real origin at the root of its own host. That is the
whole design: absolute URLs resolve, cookies scope correctly, HMR sockets
connect, and developer tools behave as they do locally. No HTML, header, or
URL is inspected or modified, which is what the previous rewriting proxy did
and what made it fragile per framework.

## Boundaries

- `runtime.js` is the host end: it accepts the WebSocket upgrade at
  `/api/dev-tunnel`, authenticates it, opens a TCP socket to the requested
  local port, and pipes the two together.
- `client.js` is the local end: it binds a loopback listener on the user's
  machine and pipes each accepted connection through one WebSocket. It lives in
  this package because it needs a WebSocket client the package already depends
  on; the desktop shell drives it over IPC.
- Port discovery is not owned here. `runtime.js` is given the reachable set by
  the same dev-server discovery the user's own list is built from.
- The browser panel decides when to tunnel; this module never chooses a target.
  `packages/ui/src/lib/browser/devTunnel.ts` owns that decision, including for
  navigations the page starts itself: a tunnelled page that sends the view to
  another loopback port means a port on the host, not on the user's machine.

## Invariants

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
  - With no `Origin` the request must carry client-token auth. A browser cannot
    reach this path — the WebSocket API always sends an origin and never lets a
    page set an `Authorization` header — so this case is the desktop shell.
- Concurrency is capped per host, not per page, because one page load opens
  many sockets.
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
