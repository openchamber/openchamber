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
- `provider.js` sits between the control service and the broker. It reads
  the `browserProvider` setting on every action: `builtin` goes to the broker;
  an extension id goes to that extension's service (`contributes.service.provides`
  includes `browser`) as `POST /browser-control` on its loopback through
  `../guests/service.js`, with the open/action timeouts, the response cap, and
  the idle stop from `@openchamber/sdk`. The body also carries `context`
  (`directory`, `sessionId`, each `null` when unknown): the project and chat the
  tool call came from, threaded from the plugin (`contextDirectory`,
  `contextSessionId`) through the control service; the model never types it.
  The answer is parsed with
  `browserProviderResultSchema`; `ok: false` becomes the agent's error, any
  other status or shape is reported as unknown page state. A selected extension
  that cannot serve (`isBrowserProviderGuest`: enabled, fully approved, has the
  role) resets the setting to `builtin`, emits
  `openchamber:browser-provider-reset`, and runs the action in-app. A settings
  or catalog read that fails is not that: the action fails with 503, nothing
  runs anywhere, and the choice stays, because a read error says nothing
  about the extension and an action must never land in a browser the user
  did not pick. `REQUEST_FAILED` (sent, no answer) is reported to the agent
  as "may or may not have run, read the page first", never as unchanged.
  `handleGuestDeactivated` does the same reset when the guest routes pause,
  remove, or withdraw approval from the selected extension.
  When the extension also shows a shared surface (`../guests/surface.js`),
  an action is refused with 409 while the user holds the surface, and every
  action that runs is reported as agent activity so the panel says "Agent is
  working".
- `../openchamber-control/service.js` is the only caller. It maps the
  `browser.*` actions of the `openchamber_web` tool onto the router's
  `request()` (same signature as the broker) and owns their parameter
  validation.
- The client half is `packages/ui/src/lib/browser/controlClient.ts`. Every
  mounted browser tab registers its pane under its context-panel tab id. An
  action with `tabId` runs in that tab; without one it runs in the browser tab
  the user last had in front of them (`setShownBrowserTab`, set by
  `ContextPanel`), never in whichever pane registered last, and never switches
  the user to the tab it acts in. `browser.open` without `tabId` never
  navigates an existing tab: the registered opener (`ContextPanel`,
  `useUIStore.openAgentBrowserTab`) makes a new background tab and the answer
  carries its `tabId`. `browser.snapshot` answers carry `tabs`
  (`id`, `title`, `url`, `active`). A client without the named tab waits
  briefly, so the client that has it claims first, then claims and answers
  "no such tab". `tabId` is validated and passed through by
  `../openchamber-control/service.js` for every action, so an extension
  provider receives it untouched (`BrowserTabTarget` in `@openchamber/sdk`).

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
- The provider path never trusts the setting alone: the extension is
  re-checked against the catalog on every action, and the grant list handed to
  the service proxy is the catalog's effective list, so a version that widened
  its permissions is refused until re-approved.
- The provider's answer shapes are the desktop panel's own
  (`packages/sdk/src/service-providers.ts`); `browser.capture` still returns
  `base64`/`mime` and the control service writes the file, so the agent sees
  the same result whoever took the picture.
