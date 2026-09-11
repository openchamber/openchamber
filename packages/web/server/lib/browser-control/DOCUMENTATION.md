# Browser Control Broker

## Purpose

This module carries agent browser actions from the server to the client that
owns the in-app browser view, and the result back. The browser lives in a
renderer, not in the server process, so the server can never act on a page
itself; it can only ask and wait.

## Boundaries

- `broker.js` owns request lifetime: it publishes one action through the
  injected `emitRequest`, holds the pending request, and settles it on a client
  result, a timeout, or an abort signal. It knows nothing about transports.
- `routes.js` is the result callback (`POST /api/browser-control/result`). It
  validates the envelope and hands the outcome to the broker.
- `../../index.js` supplies `emitRequest`, which writes the request to the
  OpenChamber SSE clients and returns how many were reached.
- `../openchamber-control/service.js` is the only caller. It maps the
  `browser.*` actions of the `openchamber_web` tool onto `broker.request()` and
  owns their parameter validation.
- The client half is `packages/ui/src/lib/browser/controlClient.ts`, which
  registers the mounted browser pane as the one responder.

## Invariants

- Capability belongs to the connection, not to configuration. A client declares
  it can drive a page by opening its event stream with `browser=1`, which only
  a Chromium host does; the flag lives and dies with that connection, so there
  is no setting to enable and no restart to remember.
- `emitRequest` counts only clients that can serve the action. `browser.open`
  needs any client, because opening a tab is what creates a view; every other
  action needs a declared-capable one.
- Exactly one client performs a request. The broadcast reaches everyone who
  could serve it, so a client claims the request over
  `POST /api/browser-control/claim` and acts only if granted; the first claim
  wins and every other client does nothing. Deciding by whose result arrives
  first would be too late, because by then each of them has already clicked.
  A claim for a settled request is refused for the same reason.
- Nobody listening is answered immediately with a 503 describing the
  environment, never by blocking for the full timeout. A blocked wait followed
  by a timeout cannot be told apart from a page that hung.
- A client that accepted a request and then disappeared still times out.
  Assuming success would report a page interaction that never happened.
- A result for an unknown request id is accepted with `matched: false`, not an
  error: a client answering after the timeout has behaved correctly.
- The result route parses its own body. This server has no global body parser,
  and a missing one silently turns every answer into an agent-visible timeout.
- Request payload limits are sized for a page snapshot (visible text plus every
  interactive element), not for a control message.
