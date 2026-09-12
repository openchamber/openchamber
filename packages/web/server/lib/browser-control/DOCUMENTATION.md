# Browser Control Broker

## Purpose

This module carries agent browser actions from the server to the client that
owns the in-app browser view, and the result back. For client-owned tabs the
browser lives in a renderer, not in the server process, so the server can
only ask and wait. When the server browser is enabled, `backend-router.js`
can instead execute the action through the server-hosted Chrome backend
(`../browser/`), so that absolute no longer holds; see Backend routing below.

Every request carries an immutable `target` scope, `{ directory, tabId?,
openCodeSessionId? }`, decided by the control service before anything is
validated. `directory` names the project the action belongs to; `tabId` names
one tab inside it; on the client path a tab-less request means the tab the
window is currently showing for that directory (the server path has no
implicit visible tab; see Backend routing). The scope travels with the
request end to end, so every failure past resolution can name what it acted
on or tried to act on.

## Boundaries

- `broker.js` owns request lifetime: it publishes one action through the
  injected `emitRequest`, holds the pending request, and settles it on a client
  result, a claim-window lapse, a timeout, or an abort signal. It knows nothing
  about transports.
- `delivery.js` decides who a request may reach. `selectEligibleConnections`
  matches the request's target against the inventory each window has posted,
  and `deliverBrowserControlRequest` (the implementation behind `emitRequest`)
  writes the request only to those connections, returning
  `{ delivered, eligibleClientIds }`. Its inventory recorder keeps each
  window's latest report on the connection object.
- `routes.js` exposes the three client callbacks: `POST
  /api/browser-control/claim` (a window asks for the right to act), `POST
  /api/browser-control/result` (the claimant posts the outcome, carrying its
  claim token), and `POST /api/browser-control/inventory` (a window reports
  what it can serve).
- `../../index.js` wires the pieces together and supplies the SSE client set
  and event writer; the connection itself records `browser=1` capability and
  the per-window `clientId` at stream open (in
  `../scheduled-tasks/routes.js`).
- `../openchamber-control/service.js` is the only caller. It maps the
  `browser.*` actions of the `openchamber_web` tool onto `broker.request()`,
  owns their parameter validation, and resolves the request's `target` before
  validating anything else.
- The client half is `packages/ui/src/lib/browser/controlClient.ts`, which
  registers one controller per mounted browser pane, claims requests that
  resolve to it, and posts results naming the tab that served them.

## Invariants

- Capability belongs to the connection, not to configuration. A client declares
  it can drive a page by opening its event stream with `browser=1`, which only
  a Chromium host does; the flag lives and dies with that connection, so there
  is no setting to enable and no restart to remember.
- Identity also belongs to the connection. Each window mints a per-window
  `clientId` and sends it at stream open. A connection without one predates
  the scoped envelope, so the version gate skips it for every targeted
  request: it could never receive a `target` field it understands, and silent
  delivery would look like success that never happens.
- Every identified window periodically posts its inventory: the one
  `openableDirectory` it can open tabs in, its registered controllers
  (`{ directory, tabId }` per browser pane), the `activeTarget` tab it is
  showing, whether it `hasFocus`, and a per-client monotonic `revision`. The
  revision makes publishing reconnect-safe: a delayed or replayed older post
  can never overwrite newer state, so a window that reconnects resumes
  reporting without the server holding stale entries.
- Delivery is by inventory match, not broadcast. `browser.open` without a
  `tabId` matches only on `openableDirectory` and skips the capability check,
  because opening a tab is what creates the view and a web client hosts a
  display-only iframe tab today. `browser.open` with a `tabId` navigates an
  existing tab, so it matches like any rich action: capability plus a
  controller entry for exactly that tab. `browser.tabs` is read-only and
  matches on the controller directory alone. Every other rich action needs a
  controller entry, and when the request names no tab it additionally needs
  `activeTarget.directory` to equal the target directory: a focused window
  whose browser panes sit behind a non-browser tab must not be picked. An
  explicitly named tab prefers the window where that tab is the visible
  active target; only when it is visible nowhere do background registrations
  serve. A multi-match prefers the single focused window; a tie, or no focus
  anywhere, delivers to all matches and lets the claim race decide.
- Exactly one client performs a request. A delivered client claims the request
  over `POST /api/browser-control/claim` and acts only if granted. The grant
  is validated against the eligible set recorded at delivery, so a claim from
  a client that was never delivered the request is refused even while the
  request is unclaimed. The winning claim returns a one-time `claimToken` the
  result must carry back, so a losing race's late post settles nothing.
  Deciding by whose result arrives first would be too late, because by then
  each of them has already clicked. A claim for a settled request is refused
  for the same reason.
- A delivered request nobody claims within three seconds settles as an honest
  503 naming the directory: the window's inventory was stale or its pane
  crashed between report and delivery, and holding the agent to the full
  execution timeout would hide that. Claiming clears the window; the
  post-claim execution timeout is unchanged.
- When a claimed request settles early (the agent aborted, or the execution
  timeout fired) the eligible windows receive a one-off cancel event carrying
  only the request id, so the claimant drops queued work for the target and
  discards the in-flight result it can no longer deliver. The claim token
  never travels over the broadcast.
- Nobody listening is answered immediately with a 503 describing the
  environment, never by blocking for the full timeout. A blocked wait followed
  by a timeout cannot be told apart from a page that hung. One exception: a
  window that connected but has not posted its first inventory yet cannot be
  matched, so a zero-match delivery retries the match on every posted
  inventory until the match arrives, every identified connection has posted,
  or the roughly two-second deadline fires. A reconnecting window must not
  turn into a spurious "not here".
- A client that accepted a request and then disappeared still times out.
  Assuming success would report a page interaction that never happened.
- Every failure past scope resolution names its target. Broker-produced
  failures attach the request's `target`; a client's own failure post may
  report the resolved tab it actually ran against, and the broker merges that
  `{ directory, tabId }` over the request scope (an `openCodeSessionId` on
  the request survives the merge), so a tab-less request that failed while
  running against the visible tab names that tab, not just the project.
- A result for an unknown request id is accepted with `matched: false`, not an
  error: a client answering after the timeout has behaved correctly.
- The result route parses its own body. This server has no global body parser,
  and a missing one silently turns every answer into an agent-visible timeout.
- Request payload limits are sized for a page snapshot (visible text plus every
  interactive element), not for a control message; inventory posts are capped
  per field and per controller count so one window's report stays bounded.

## Backend routing

`backend-router.js` sits between the control service and the two browser
backends: connected client windows (through the broker) and the server-hosted
Chrome backend (`../browser/server-chrome-backend.js`, kind `server-chrome`).
Exactly one backend answers each request; the broker and the server never both
drive one action. The single read-only exception is `browser.tabs`, whose
listing is a merge of both backends' tabs so the agent sees one namespace.

- Routing is by ownership. A request naming an `sc:`-prefixed tab belongs to
  the server session registry; any other tab id belongs to a connected client
  pane. The prefix is the whole rule.
- `browser.open` without a tab keeps the pre-router semantics exactly: a
  client whose inventory `openableDirectory` matches wins, even a web/iframe
  display-only client. The server backend answers only when no client matches,
  so unattended work (scheduled tasks, sessions with no window) can browse.
- A tab-less rich action goes to a client whose inventory shows a matching
  active target for the directory; with no client match, the server backend
  answers. The server has no implicit visible tab, so the backend requires an
  explicit `sc:` tab id for rich actions and fails with a scoped 400 naming
  the target when one is missing; the agent-correctable answer is to pass the
  id returned by `browser.open` or `browser.tabs`.
- `target.preferBackend === 'server-chrome'` forces the server path even when
  a client could serve.
- The request's `options.signal` reaches the selected server backend. An
  already aborted request cannot compose or execute it; cancellation during
  composition rejects promptly and prevents later execution. An aborted
  `browser.tabs` merge rejects instead of returning a partial success.
  Server action cancellation and session cleanup are owned by
  `../browser/`; see its Control lease section.
- The enabled flag is injected (`isServerBackendEnabled`); this module never
  reads settings. While the flag is off, routing is an unconditional
  pass-through to the broker, checked before any rule, and the server backend
  is composed lazily so nothing Chrome-side loads. When the server path is
  selected while disabled, the request fails 503 naming the setting instead of
  silently falling back.
- `hasServingClient` and the broker's delivery share one matching
  implementation (`selectEligibleConnections`), so the route check and actual
  delivery cannot drift.
- A missing Chrome binary arrives from the backend as a 400 carrying the
  actionable `OPENCHAMBER_CHROME_PATH` text; the router escalates it to a 503
  availability failure, preserving the message verbatim.
- The broker's no-client 503 carries `code: 'no-client'`, which lets the tabs
  merge stay silent about the client side when the server answered, while a
  real client failure still surfaces as a client error.
