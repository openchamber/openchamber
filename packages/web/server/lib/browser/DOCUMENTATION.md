# Server Chrome Browser Backend

## Purpose

This module stack hosts a real Chrome on the OpenChamber server so agents can
browse without any connected client window, and so any paired device can watch
and drive that browser remotely. The whole stack is off by default behind the
`serverBrowserEnabled` setting: while it is off, none of these modules is even
imported, no Chrome is spawned, and every request takes exactly the path it
took before the stack existed. Turning the setting off kills Chrome, closes
every session proxy, and disconnects every viewer immediately, not on next
boot. Graceful server shutdown runs the same teardown.

## Module map

- `server-browser-lifecycle.js` owns the enabled flag the router and surface
  gateway read (never the settings file directly). Enabling only arms lazy
  composition; the first routed request triggers it. It injects the lazy
  `import()` composition, so a disabled flag keeps every other module here out
  of the module graph. `composeWhileEnabled` guarantees a consumer loaded
  during a disable/re-enable flip is disposed instead of half-live.
- `chrome-process.js` owns one Chrome child per server host, launched lazily
  into a generation-owned temporary profile (restrictive permissions, deleted
  on error, supersession, crash, or shutdown; Chrome 136+ ignores
  `--remote-debugging-port` on the default profile). Startup prefers the
  `DevToolsActivePort` file over the stderr announcement, probes
  `Browser.getVersion` against a minimum major version of 109
  (`--headless=new`), and resolves the binary from `OPENCHAMBER_CHROME_PATH`
  or known system paths with an actionable error otherwise. Generation
  ownership covers both the child and its profile, so a kill during startup
  cancels the whole attempt as one cleanup boundary. Every launch sets
  `--webrtc-ip-handling-policy=disable_non_proxied_udp`; new headless Chrome
  reads this Chrome preference switch, not the legacy headless
  `--force-webrtc-ip-handling-policy` switch.
- `runtime-status-route.js` exposes configured and active CDP ports to
  authenticated clients without starting Chrome. Port settings are described
  below; the route never returns the debugger WebSocket identity or profile.
- `cdp.js` is a raw CDP client over the already-present `ws` package. It
  auto-attaches flattened page sessions, correlates responses by command id
  plus session id, and reconciles a registry of EVERY target: created by us,
  by the page via `window.open`, or by an external CDP client, so no tab is
  invisible or stale. Network audit telemetry is an event allowlist that
  builds summaries field by field; raw protocol payloads never reach logs.
- `session-manager.js` owns directory/session-scoped browser contexts, their
  per-session policy proxies, and the control lease. One browser context per
  logical scope (directory plus `openCodeSessionId` for agent work;
  directory-scoped persistent for user-initiated sessions), created with the
  session proxy as its mandatory `proxyServer`, so cookies and storage are
  isolated between sessions.
- `policy-proxy.js` is the per-session loopback egress proxy. See the egress
  section below.
- `surface-gateway.js` is the authenticated WebSocket gateway at
  `/api/browser-surface` for remote viewing and input. See the wire protocol
  section below.
- `surface-viewport.js` validates attachment-scoped viewport messages and
  publishes confirmed changes. `viewport.js` coordinates one physical metrics
  writer per target, viewer Auto ownership, agent choices, and external
  DevTools changes. `viewport-metrics.js` applies explicit mobile mode at DPR 1
  and reads Chrome's CSS layout and visual viewport measurements.
- `selection.js` owns the fixed page expression used to read selected plain
  text from the focused control or document. It follows open shadow roots and
  same-origin frames without accessing the server operating system clipboard.
- `context-menu.js` dispatches a trusted right-button pair and observes the
  resulting page event. It distinguishes a page-owned menu from the viewer's
  navigation and clipboard menu without exposing native Chrome UI.
- `inspector.js` owns per-viewer capture lifetime, shared Runtime enablement,
  evaluation deadlines, and request-detail reads. `inspector-capture.js` keeps
  bounded console batches and network rows with redirect identity.
  `inspector-format.js` formats CDP values and redacts URLs, headers, and
  credential fields in textual bodies. None of these modules persists captured
  data or forwards raw CDP objects to viewers.
- `devtools.js` owns full Chrome DevTools connection lifetime. Its policy,
  chunk transport, asset proxy, and host bridge helpers keep page-scoped CDP
  on the authenticated surface transport without exposing Chrome's loopback
  debugger endpoint to the client. The parent sends the current OpenChamber
  theme through a tagged, fixed-shape bridge message. The bridge applies its
  variant and semantic palette before revealing the frontend, reapplies them
  after Chromium finishes initialization, and keeps them authoritative while
  that frontend stays open. Once Chromium's theme service exists, the bridge
  also updates its registered `ui-theme` setting, clears its computed-color
  cache, and emits its theme-change event so editors and charts use the same
  variant and palette. Theme messages never enter the CDP stream.
  Browser-wide tracing keeps its exclusive
  context admission until Chrome reports `Tracing.tracingComplete` or rejects
  `Tracing.start`. A teardown timeout closes the dedicated socket but does not
  prove tracing stopped; the admission then remains blocked until confirmed
  context disposal or Chrome process death clears it in the session manager.
- `server-chrome-backend.js` implements the `BrowserBackend` contract
  (`getSession`/`listTabs`/`execute`) for kind `server-chrome`. It names every
  failure with its target, requires an explicit `tabId` for tab-less rich
  actions (the server has no implicit visible tab), runs mutating actions
  through the session manager's lease queue, and maps viewports onto CDP
  emulation presets through the shared target viewport coordinator.

## Boundaries

- The Chrome CDP endpoint and every session proxy listen on loopback only
  (`127.0.0.1`). Session proxy ports are ephemeral; the CDP port is automatic
  unless configured below. Nothing in this stack accepts a non-loopback
  connection.
- The surface gateway's auth floor is unconditional: origin validation always
  runs, and the upgrade is rejected 401 unless UI authentication resolves a
  session token. When UI auth is disabled, the gateway uses the controller's
  `resolveAuthContext` and requires a paired client or scoped URL token.
  Password-free UI cookies cannot authorize input. A missing backend rejects 503 instead of hanging. The channel
  carries pointer, key, and text input into a real browser, so it never runs
  unauthenticated.
- Routing into this backend lives in `../browser-control/backend-router.js`;
  the agent-facing `preferBackend` parameter lives in
  `../agent-tool/runtime.js`. Those modules document their own contracts.

### CDP port configuration

`serverBrowserDebugPort` is an integer from 0 through 65535. Its default, 0,
lets Chrome choose a free port. A positive value requests that exact port on
`127.0.0.1`. The process manager checks availability before spawning and accepts
only an endpoint announced by its own child with the requested port. An
occupied port fails startup; it never attaches to the process using that port.
Configured, launching and active CDP ports are excluded from development-server
discovery, including cached scans. These exclusions govern both browser proxy
grants and dev-tunnel eligibility. Discovery waits for an in-progress
automatic launch or teardown to settle before applying that exclusion; a failed
private-port read fails discovery instead of granting an uncertain listener.

Saving a port leaves existing browser sessions running. The next Chrome
launch reads the new value. `GET /api/browser/runtime-status` returns
`configuredPort`, `running`, `activePort` and `restartRequired`. These values
distinguish the saved choice from the current listener. The route is uncached
and accepts an authenticated UI session or paired client; a password-free
cookie or URL token is insufficient. A failed status read returns 503 rather
than claiming Chrome is stopped. VS Code returns an explicit unsupported
response for this server-owned capability.

Settings shows the saved choice and active port, with the server-loopback
HTTP address for an MCP process running on that same machine. Connecting an
external MCP directly does not acquire OpenChamber's control lease or constrain
it to a managed session. Port configuration provides connection information;
session-aware MCP control still needs a separate integration.

## Backpressure discipline

Screencast backpressure has two separate acknowledgment layers that must not
be conflated:

- The CDP `Page.screencastFrameAck` is sent only after the frame has been
  admitted to the gateway's bounded per-viewer queues. Chrome is never held
  hostage to the slowest viewer: admission is a local bookkeeping decision,
  so the browser keeps producing frames even when a viewer stalls.
- Each viewer's own `frameAck` (over the surface socket) bounds in-flight
  frames per viewer at three. When a viewer already has three unacked frames,
  a new frame is NOT queued behind them; it replaces the single held
  `pendingFrame`, so a slow viewer always converges on the latest frame
  instead of replaying a backlog. One viewer's pending slot never blocks
  another viewer.
- `streamGen` is a per-target logical stream generation. Every target stream
  attachment bumps it; frames from a superseded generation are dropped, and a
  stale stop cannot kill a newer stream. A capture refresh on the same target
  retains the generation and uses that generation to reject stale work.

The session keeps one cached latest frame per target; a late joiner gets it
immediately after attach. Each target has one shared startup promise and one
event subscription, so viewers of another tab cannot replace its listener.
A current viewer Auto or fixed viewport result with status `applied` reports
its confirmed device width, height, and mobile mode back to the gateway. A new
physical configuration queues one stop/start pair on the owning screencast CDP
session, after its initial start has settled. The queue serializes capture
commands and rechecks the target and stream generation before restarting, so a
tab switch or teardown cannot revive an old stream. Mode-only changes,
`unchanged` results, and `Page.frameResized` events do not restart capture.
Agent viewports and external DevTools emulation keep their existing behavior.
A stream stops when its last viewer switches tabs or disconnects. Stopping
releases the screencast subscription but keeps the managed CDP page attachment
available to agent operations. The frame cache survives reconnects and is
removed when Chrome destroys the target.

## Control lease

- Identity: the lease names an actor (`agent` with its `openCodeSessionId`, or
  `user` with the owning surface connection's `viewerId`) and a generation.
  Every mutating operation records the generation it started against. A result
  produced after the generation moved is rejected, so stale work cannot report
  success.
- TTL: an agent lease's expiry is fixed at acquisition, 30 seconds out;
  ordinary activity does not renew it. When the timer fires, the lease is
  cleared and queued plus in-flight work is rejected with the expiry reason.
- Exclusion: one holder per session. Mutating agent operations serialize
  through the session queue; a mutating operation from a different agent
  session identity is rejected outright. Only a viewer (user) takeover bumps
  the generation, which invalidates the previous holder's queued and
  in-flight work with an explicit reason.
- Invalidation happens on operation abort (which also ends ephemeral
  sessions), viewer takeover, lease TTL expiry, session close, and Chrome
  process death. Chrome death reconciles through the manager: sessions are
  marked dead, leases cleared, and lifecycle listeners (the gateway) turn
  that into an honest viewer error and close.
- Cancellation reaches resource readiness, the mutation queue, navigation
  waits and individual backend CDP sends. Lease invalidation aborts the
  operation's effective signal and frees the queue without waiting for a
  stuck callback. Subsequent commands and late success are suppressed;
  commands already sent to Chrome cannot be undone. Aborting agent work
  closes its ephemeral context and proxy, including resources that finish
  creation after cancellation, while other sessions keep running. A user
  takeover preserves the user's lease and context against late agent aborts.
  Chrome's shared connection is not closed to cancel one action.
- The gateway calls `viewerDisconnect` when a socket closes or switches
  sessions. Only the matching owner can release a user lease; another
  viewer's disconnect and repeated detach are no-ops. Release advances the
  generation and lets an agent acquire control again. A reconnect has a new
  viewer identity and must take control explicitly. Lease state is broadcast
  with `controlling` calculated separately for each connection.
- The manager checks for idle sessions once a minute. Each check finishes
  before it schedules the next one, and manager shutdown cancels the timer and
  waits for a running check. A check ends ephemeral sessions after five idle
  minutes. Connected viewers and active browser operations protect a session;
  disconnecting the last viewer restarts its idle period. Socket cleanup
  releases control without ending the session or affecting other viewers.
- `getControlState` and `onControlChange` expose copied lease state and its
  generation to viewport and DevTools consumers. `getPageConnection` validates
  page ownership before returning an internal debugger connection descriptor.
  Browser-wide tracing requires `acquireExclusiveBrowserContext`: exactly one
  admitted context, including contexts still being created or cleaned up.
  The returned idempotent release function ends that admission. While held,
  other contexts cannot start. An unconfirmed context disposal keeps tracing
  unavailable until Chrome process death confirms that context is gone.

## Tab identity: the `sc:` namespace

Server tabs are named `sc:<cdp-target-id>`; any other tab id belongs to a
connected client pane. Routing reads the prefix. Ownership is enforced per
session: before an attach, navigation, frame, or input operation runs, the
session manager compares the requested target's `browserContextId` against
the current session's context. CDP's process-wide managed-context set is
defense in depth only; a foreign `sc:` target from another session is
rejected at the session boundary.

## Surface wire protocol

The gateway speaks JSON text messages plus binary JPEG frames at
`/api/browser-surface?directory=...`:

- Handshake: server sends `hello`;
  the client sends `list`, `create`, or
  `attach` (with a `sessionId`). The `list` reply carries `sessions` only;
  `created` and `attached` each carry the `session` identity and its current
  `tabs`. A failed session or tab listing sends `HANDSHAKE_FAILED`; it never
  sends an empty success. Sessions may have no tabs.
- `createTab` creates an `about:blank` page in the attached session and takes
  the user lease. Its `tabs` reply includes the complete `tabs` list and an
  `activeTabId` for the creating viewer, which then sends `attachTab`.
  Other viewers receive the list without an active-tab change. CDP registry
  events also publish `tabs` when an agent or page creates, changes, or closes
  a target. Closing the selected target invalidates pending viewer operations.
- `attachTab { tabId, requestId }` subscribes the viewer to one `sc:` tab. It starts the
  CDP screencast for that target if none is running, sends the cached latest
  frame, and answers with a `state` message carrying `tabId` and
  `attachmentRequestId: requestId`, the session lease, and `controlling`.
  Clients confirm only the current tab and attachment request. Ordinary lease
  updates include the attached `tabId` (or `null` when unattached) without
  `attachmentRequestId`; they never confirm a pending attachment. A supplied
  request ID must be a nonempty string of at most 128 characters. The gateway
  accepts omission for older callers; current clients always send an ID and
  require its matching completion. Reconnect repeats
  `attachTab` on the same session identity. Every attachment request advances
  the connection's generation; late attachment completions or failures and
  input completions cannot overwrite a newer tab selection.
- `navigation { tabId, url, title, canGoBack, canGoForward, isLoading }`
  reports Chrome's current navigation state after attachment and page events.
  URL, title, and history availability come from `Page.getNavigationHistory`.
  Loading starts from document readiness and follows main-frame loading events.
  Link clicks, same-document navigation, title changes, and agent navigation
  update the same state. Refreshes coalesce per target; frame events do not
  trigger history reads. Chrome's transient inactive-page error gets at most
  three read attempts, 25 ms apart, within that coalesced refresh. Removed streams
  cancel the refresh. Failed reads preserve the last valid state and report
  `NAVIGATION_STATE_FAILED`; a later page event retries the authoritative read.
- A frame is a strict two-message pair: a JSON header
  (`{ type: 'frame', frameSeq, streamGen, tabId, width, height, scale }`)
  followed by one binary JPEG payload. `width`/`height` are CSS pixels;
  `scale` is the capture device pixel ratio and sizes the canvas backing
  store but must NOT be applied to pointer coordinates, which already map by
  displayed-to-frame size ratio.
- The client answers consumed frames with `frameAck { frameSeq }`; acking a
  sequence acknowledges every earlier one for that viewer.
- Input messages are `pointer` (`move`/`down`/`up` with CSS-pixel
  coordinates), `wheel` (`x`, `y`, `deltaX`, `deltaY` in CSS pixels and optional
  modifiers), `key` (`keydown`/`keyup` with key and modifiers), and `text`.
  Dispatching input takes the session lease from any agent holder (takeover)
  and forwards through CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`/
  `insertText`. Wheel input uses `Input.dispatchMouseEvent` with `mouseWheel`.
  Nonfinite coordinates or deltas and unknown modifiers are rejected.
  Input brings the target to the foreground before dispatch, because Chrome
  can defer input to hidden tabs after another tab is created. The gateway
  rechecks control and attachment generations after that focus request.
  Merely observing a tab does not change browser focus.
- Ctrl/Cmd+A keydown includes Chrome's `selectAll` editing command. This makes
  selection work across client and server operating systems. Plain-text paste
  uses the existing `text` message and `Input.insertText`, replacing the remote
  selection. Editing and navigation keys include their CDP virtual key code
  and code name, so Backspace, Delete, arrows, Home, End, Page Up, Page Down,
  Tab and Escape run Chrome's normal default action. Enter keydown includes
  a carriage return when unmodified or combined only with Shift. Other
  modifiers retain Chrome's shortcut behavior; text and IME input still use
  `Input.insertText`.
- `copy { tabId, requestId }` reads the attached tab's selected plain text.
  Both identifiers must be nonempty strings of at most 128 characters. Copy
  takes the viewer lease, focuses the target, and checks the lease and attachment
  again before and after reading through CDP. A tab switch, target removal,
  takeover, session end, or disconnect discards pending results.
  The requesting viewer alone receives
  `copyResult { requestId, tabId, ok: true, text }`, or
  `copyResult { requestId, tabId, ok: false, code, message }`.
  Failure codes are `NO_SELECTION`, `COPY_TOO_LARGE`, and `COPY_FAILED`.
  Empty selections, password fields, and unsupported input ranges produce
  `NO_SELECTION`. A focused cross-origin frame produces `COPY_FAILED`, because
  the CDP client owns page sessions only. Copy never substitutes an ancestor's
  selection for an inaccessible frame. Open shadow roots and same-origin frames
  follow their focused input, textarea, contenteditable, or document selection.
  Selected text retains whitespace. The complete encoded response must fit in
  64 KiB; larger results fail without truncation or text in the error. Errors
  contain fixed messages and never echo page exceptions or selected text.
  The gateway does not read or write any operating system clipboard. The client
  owns its clipboard permission and write. Paste remains subject to the socket's
  64 KiB incoming message limit.
- `contextMenu { tabId, attachmentRequestId, requestId, x, y }` requests a
  right-click at viewport CSS coordinates. It follows the same control and
  attachment checks as input. `contextMenuResult` echoes those three identities
  and reports `page-handled`, `menu`, or `unavailable`. The helper temporarily
  observes the actual trusted page event and reads `defaultPrevented` after
  propagation. Page-owned menus keep their own behavior. Only a confirmed
  uncancelled event opens the viewer menu with history, copy/paste and Open
  Chrome DevTools actions; it does not claim to inspect the clicked element.
  While that viewer menu is pending or open, Escape dismisses it without
  closing the enclosing context panel. Tab retains normal focus navigation.
  Missing events, inaccessible cross-origin frames and observation failures
  report unavailable instead of inventing a default menu. Observers are removed
  after completion, including late CDP responses. Tab switches, navigation,
  control changes and disconnects cancel pending client results. If control
  changes after right-button down, cleanup does not inject button up into the
  new owner's input stream.
- `navigate { tabId, url }`, `back { tabId }`, `forward { tabId }`,
  `reload { tabId }`, and `stop { tabId }` require the viewer's attached tab
  and take the user lease. These actions also focus the target before navigation
  so a previously hidden tab produces updated frames. Navigation accepts absolute HTTP(S) URLs or exactly
  `about:blank`; address-bar text normalization belongs to the client. The
  session proxy still enforces destination policy. History commands select
  Chrome's current adjacent entry, and recheck the captured lease and attachment
  generation after asynchronous reads before sending a mutation. Action errors
  return `NAVIGATION_FAILED` while the existing session and tab remain available.
  A failed history refresh after a successful action is reported separately as
  `NAVIGATION_STATE_FAILED`, without misreporting the action as failed.
- Session end (close, abort, or Chrome death) pushes an error plus close code 1001/1011 to every viewer.

### Viewport control

Current clients attach with a request ID before using viewport control. They
send `viewportSet { requestId, tabId, attachmentRequestId, width, height, mode,
mobile, takeover }`. All identifiers are nonempty strings of at most 128
characters; dimensions are integers from 1 through 3840. `mode` is `auto` or
`fixed`; `mobile` and `takeover` are explicit booleans. Hidden or zero-sized
client stages send no resize request.

The reply is `viewportResult` with the same three identifiers, a status of
`applied`, `unchanged`, or `not-owner`, and the confirmed `viewport`. Changes
also publish `viewportState { tabId, attachmentRequestId, viewport }` to every
current viewer of that target. Snapshots contain a revision, configured width
and height, mode (`auto`, `fixed`, or `external`), source (`viewer`, `agent`, or
`external`), mobile mode, DPR, observed CSS layout and visual dimensions and
scale, and `autoAllowed` calculated for that viewer. Managed emulation uses
DPR 1. Unknown external mobile mode and DPR are `null`; observed external
dimensions can be fractional or exceed the configured-size bounds. A failed
initial read never produces an empty or invented valid snapshot.

Configured device dimensions and observed CSS layout dimensions are different
quantities. A device configured to 390 pixels wide can have a 980-pixel mobile
layout when the page lacks a viewport meta tag. Navigation, resize events,
and DevTools changes trigger coalesced measurement reads; JPEG frames do not.
Ordinary observed changes retain the known configuration and its owner.

Passive Auto does not take the session lease. The first eligible viewer owns
Auto for that target, and another viewer or an agent lease blocks it. An
explicit user choice takes the viewer lease and may replace viewport
authority. Agent `browser.resize` and an explicit `browser.open` viewport set
fixed authority for that target; expiry of the agent lease does not restore
Auto. Opening a page without an explicit viewport preserves its current
configuration. Agent snapshot and capture summaries use the target's shared
confirmed configuration rather than a session-wide last choice.

Opening or closing DevTools only registers or unregisters its connection.
An actual DevTools emulation command marks external authority and pauses Auto
until the user selects Auto again. Closing DevTools never restores an older
viewport. Detaching an Auto owner makes the target eligible for another viewer
while preserving its last confirmed size; fixed and external authority remain.

The coordinator keeps one in-flight metrics write and the latest pending
request per target. A five-second request deadline includes queue time.
Replacing a pending request reports `SUPERSEDED`. A timed-out or cancelled
request keeps the physical writer occupied until its sent CDP command
settles, preventing a late command from racing the next write. Attachment,
control, and authority generations are checked before each command and before
commit. Failed writes preserve the last confirmed snapshot and leave physical
uncertainty explicit internally, so a later request cannot incorrectly report
`unchanged`. Errors use fixed messages with `UNAVAILABLE`, `INVALID_REQUEST`,
`STALE_ATTACHMENT`, `SUPERSEDED`, `RESIZE_FAILED`, or `RESIZE_TIMEOUT`.

### Full Chrome DevTools

Full DevTools opens only for the current completed tab attachment and exact
`attachmentRequestId`. Startup takes the viewer lease, creates a dedicated
connection to the owned page, and issues a 192-bit static-asset grant. Stop,
tab or session switch, and disconnect revoke the grant. The asset proxy serves
the frontend belonging to the running Chromium version; it never exposes the
loopback debugger URL. The iframe host validates the sending window, exact
origin, DevTools identity, attachment request, and one transferred MessagePort.
The bridge first imports Chromium's `core/host/host.js` and modifies the fully
constructed `InspectorFrontendHostStub`; this preserves the stub's preference,
metrics, filesystem, and event state. The bridge keeps non-hosted mode for the
page CDP connection and explicitly enables Chromium's software context menus
before loading the app, because the stub has no native menu host.
`openchamber-devtools-ready` means the
MessagePort transport can attach. `openchamber-devtools-loaded` comes from the
official `loadCompleted` callback after the app and toolbars are presented, and
is the signal that the iframe UI finished booting. The parent keeps its loading
cover visible until the exact DevTools and attachment identity has a connected
port plus both `loaded` and `themed` acknowledgements. The theme envelope has a
fixed light/dark variant and exactly 30 semantic OpenChamber colors. The parent
validates that schema before sending it; the bridge independently requires the
complete key set and valid CSS color values before applying it. A change to
`currentTheme` sends the new envelope through the retained MessagePort, so the
same iframe follows live theme changes without reconnecting or reloading. The
bridge maps the semantic palette onto Chromium system and syntax tokens, sets
Chromium's registered `ui-theme` value, clears `ThemeSupport`'s computed-color
cache, and dispatches `ThemeChangeEvent` after the theme service is ready.
The UI allows 60 seconds for worker activation and frontend asset loading;
this is separate from the shorter CDP command and backpressure deadlines.

The embedded frontend loads Chromium's main `devtools_app` entrypoint. The
remote-device `inspector` entrypoint is intentionally excluded because it
autostarts its own page screencast. The policy also returns a fixed nonfatal CDP
error for start, stop, and acknowledgment screencast commands, preserving the
Server Browser gateway as the only owner of the visible page stream.

CDP travels on the authenticated browser-surface socket in 32 KiB base64
chunks. Commands are limited to 16 MiB or 512 chunks, events to 64 MiB or
2048 chunks, with two active messages, an eight-chunk cumulative acknowledgment
window, and a 15-second backpressure deadline. These messages have their own
flow control and do not use screencast frame acknowledgments.

The viewer's command queue admits at most 1,024 logical commands and 24 MiB
of command bytes. The count bound limits per-command metadata; the byte bound
limits retained payloads. Only commands with unacknowledged chunks in flight
own a 15-second deadline. Commands waiting behind the two active messages do
not time out while those messages continue making acknowledgment progress.
Disposal clears both queued commands and active deadlines.

The dedicated CDP connection feeds an object-mode WebSocket stream. Delivery
pauses when two messages await viewer acknowledgments and resumes when one
finishes, so a burst of script or network events waits for the viewer instead
of overflowing the outbound queue. The stream also pauses its underlying
socket; already decoded messages can remain buffered until it resumes.
Cleanup drains that stream through the tracing completion handler before the
connection closes. Decoded ingress and logical outbound messages share a
64 MiB byte budget. The message size and stalled-viewer deadline still apply.
Unexpected DevTools closure writes its code, cause,
queue sizes, unacknowledged chunks, acknowledgment age and socket buffered
byte counts to the server logger. It never logs protocol bodies, page URLs,
asset grants or selected text.

The policy allows page inspection and editing domains, same-context
descendants, safe HTTP(S) or `about:blank` navigation, and context-bound cookie
storage. It rejects browser, process, native, download, and foreign-target
operations. Browser-wide tracing requires exclusive browser-context admission
and releases it only when Chrome rejects the start or reports tracing
completion. DevTools cleanup sends `Tracing.end` and resumes paused root and
child debugger sessions on a best-effort basis. If completion stays uncertain,
the session manager retains admission until confirmed context disposal or
Chrome process death. Lease, attachment, target, session, and socket changes
invalidate stale replies.

This frontend provides Chrome's own panels through the constrained page
connection. Static checks and simulated protocol tests do not establish that
every Chromium panel works in a real client; runtime validation must exercise
the matching Chromium frontend and the applicable direct or relay transport.

### Console and network inspector

The existing authenticated socket carries the console, network capture, and
interactive JavaScript commands. Every command has `tabId` and `requestId`, each
a nonempty string of at most 128 characters. Capture-dependent commands also
carry the opaque `captureId` returned by startup. The gateway checks the current
attachment and the session manager verifies target ownership.

- `inspectorStart` begins a fresh per-viewer capture and replies with
  `inspectorStarted { tabId, requestId, captureId }` before publishing events.
  Capture starts when opened. Historical console events replayed by Chrome with
  timestamps older than startup are ignored. Requests already underway are not
  reconstructed from later response events.
- `inspectorStop { captureId? }` releases capture buffers and subscriptions.
  Omitting the capture ID also cancels pending startup. Tab/session changes,
  disconnects, target destruction, and backend shutdown run the same cleanup.
  Viewers of one target share serialized Runtime enable/disable transitions;
  closing one does not disable another. Network remains enabled by `cdp.js`.
- `inspectorEvents` publishes console and network upserts every 100 ms while
  work is pending, with at most 32 entries and 48 KiB per message. Capture keeps
  at most 300 pending console rows, 200 network rows and their detail metadata,
  and 2 MiB of encoded retained data. Older rows are evicted with visible drop
  counts. Network updates coalesce by row ID. A socket with at least 128 KiB
  buffered pauses inspector publication while bounded capture continues.
  Screencast frames and frame acknowledgments keep their existing path.
- `inspectorClear { scope }` discards that scope's pending rows and resets its
  drop count, then replies `inspectorCleared`. Network clear also invalidates
  pending request-detail reads. Counts accumulate until that scope is cleared
  or the capture closes.
- `inspectorEvaluate { expression }` accepts up to 16,000 characters and takes
  the viewer lease through the same focus and ownership checks as input.
  Evaluation runs in the current main world with promise support and CDP REPL
  mode. Promise handles returned by REPL mode are awaited with `Runtime.awaitPromise`
  before formatting the resolved value or rejection. CDP limits synchronous
  execution to one second; a five-second deadline
  bounds the whole request, including focus. `inspectorEvaluated` returns
  `{ text, isError, truncated }` with at most 8,000 characters and no object IDs.
  Page exceptions appear as results. Protocol failures use fixed messages.
  Object groups are released on completion, cancellation, and timeout, and
  again if a timed-out evaluation completes late. Cleanup acknowledgments do
  not extend the response deadline. Sent JavaScript may already have caused
  page side effects; cancellation never replays or rolls it back.
- Main-frame navigation, same-document navigation, and context reset invalidate
  pending evaluations and details. Captured rows remain. Later evaluations use
  the current main-frame world, and old request bodies may no longer be retained
  by Chrome. Subframe navigation alone does not cancel main-frame evaluation.
- `inspectorRequest { entryId, includeBody }` reads captured headers passively.
  Only an explicit `includeBody: true` fetches textual request or response
  bodies, each reduced to at most 8,000 characters. Binary formats and prior
  redirect hops report `unsupported`; missing, in-flight, or evicted Chrome
  bodies report `unavailable`. Some partial results can retain an available
  request body when the response is unavailable. Header arrays contain at most
  64 entries per direction, with names capped at 256 and values at 1,024
  characters. Credentials, cookies, and sensitive URL query values are redacted.
  The complete encoded detail reply stays below 64 KiB; any additional trimming
  sets `truncated`. Bodies are not cached by the inspector.
- `inspectorError` echoes the request identity with one of `UNAVAILABLE`,
  `INVALID_REQUEST`, `CAPTURE_GONE`, `EVALUATION_FAILED`, `EVALUATION_TIMEOUT`,
  `REQUEST_GONE`, `REQUEST_FAILED`, or `CAPTURE_FAILED`. Messages never echo an
  expression, URL, response body, or protocol exception to server logs.

Network capture uses the owned page CDP session only. Requests, status, cache
hits, completion, failure, encoded size, and duration follow Network events.
Redirect hops keep separate row IDs, and an earlier hop cannot read the final
hop's body. Headers come from request/response events; extra-info events and
worker or out-of-process iframe targets are not captured. Console uses Runtime
console calls and exceptions, without a second Log-domain exception feed.

CDP body methods return the complete Chrome-retained body before the inspector
can reduce it. The 2 MiB capture budget bounds retained rows and metadata, not
that transient CDP response allocation. The inspector does not change the
Network retention settings owned by the CDP manager.

## Egress proxy policy

Each session browser context is created with a mandatory `proxyServer`
pointing at its own loopback listener. Page HTTP(S) and WebSocket traffic,
including redirects, dedicated/shared/service workers and OOPIFs, passes
through classification at connection time. A redirect is a new connection
that gets classified again. Chromium's mandatory WebRTC IP handling policy
separately disables non-proxied UDP; the HTTP proxy alone cannot intercept
STUN or TURN UDP. WebRTC TCP/TLS attempts remain subject to the session
proxy. Real Chromium integration checks exercise STUN, TURN UDP/TCP/TLS,
and granted HTTP/WebSocket controls. The Chrome installation and managed host
policies are trusted deployment configuration. This is not an operating-system
network sandbox or a guarantee for other browser transports.

- `classifyProxyTarget` checks protocol (http/https/ws/wss only), the
  hostname, every DNS answer, and the destination IP before any upstream
  socket opens. Link-local, cloud metadata (`metadata.google.internal`),
  CGNAT, multicast, unspecified, reserved, and IPv4-mapped/transition IPv6
  addresses are always denied. Private and loopback destinations require an
  explicit grant.
- Grants are per host plus port. The default grant set is the host's live
  dev servers, re-discovered on every classification (a stopped port must not
  stay reachable), plus discovered tunnel hosts.
- An exact `localhost` request uses `127.0.0.1` when that IPv4 loopback port
  already has a grant. The original URL and HTTP Host stay intact. This lets
  IPv4-only dev servers work even when system DNS lists `::1` first.
  Literal `::1`, other loopback addresses and other hostnames retain their
  own grant and DNS checks; a revoked IPv4 grant also removes this mapping.
- DNS pinning means the validated literal address and family are passed to
  `http.request`/`net.connect`; forwarding the hostname would re-resolve and
  reopen DNS rebinding.
- Loopback bypass is deliberately not used: Chrome's default proxy bypass
  list is overridden so even loopback traffic from the page crosses the
  proxy, where the grant check applies.
- Managed tunnel hosts resolve through the live listener port, never a
  configured `0`. HTTP (and ws) tunnel-host traffic hairpins to the loopback
  server listener, because plain HTTP to the public hostname would leave the
  machine and come back; HTTPS (and wss) keeps the validated original
  endpoint, because the TLS identity is the public hostname.

### Why a proxy and not CDP Fetch or setBlockedURLs

CDP-level enforcement was tried and falsified against real Chromium during
review. `Network.setBlockedURLs` matches URL strings, so it cannot see
resolved IP addresses at all: a public hostname that resolves into
`169.254.169.254` or a DNS answer flipped between lookup and connect sails
straight through, and the blocklist would have to enumerate every private
hostname form. `Fetch.enable` request interception fires after Chromium has
already resolved and begun connecting, pauses the request rather than the
connection, and empirically misses transports (workers and OOPIF subresource
paths) unless every stage of every target's fetch domain is configured
exactly right; a missed stage is a silent bypass, not an error. Neither
mechanism can answer the only question that matters here: "is THIS connection
to THIS resolved address allowed?" The loopback egress proxy is the sole
enforcement mechanism because it sits at the connect boundary where that
question is decidable, for every transport, with denial proven by zero
upstream connection receipts rather than by interpreting a generated error
page.

## Phase 4 handoff points

Two seams in this stack are designed for the future `chrome-devtools-mcp`
integration, and are explicitly NOT present now:

- The CDP target registry in `cdp.js` already reconciles externally created
  targets, so an MCP-attached client's targets will appear without new
  discovery machinery.
- The control lease in `session-manager.js` is the acquisition point: any
  future MCP consumer must acquire and respect this same lease (same
  identity, TTL, exclusion, and takeover semantics) before mutating a
  session's targets.

There is no MCP integration or WebRTC/video pipeline in this phase;
screencast JPEG frames are the remote page-viewing transport. Full DevTools
may record a performance trace under the exclusive-context rule above.
