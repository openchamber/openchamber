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
- `uploads.js` decides which files `browser.upload` may send and holds them
  under a short-lived token for the client that attaches them
  (`GET /api/browser-control/uploads/:token/:index`).
- `../../index.js` supplies `emitRequest`, which writes the request to the
  OpenChamber SSE clients and returns how many were reached. The event carries
  the same `context` (`directory`, `sessionId`, each `null` when unknown) the
  extension provider receives, so the in-app browser knows which session asked.
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
  mounted browser tab registers its pane under its context-panel tab id, with
  its project and the session whose agent opened it (`ownerSessionId` on the
  tab, null for the user's own). An action with `tabId` runs in that tab,
  whoever opened it. Without one it runs in the calling session's tab: the
  shown tab if it is the session's, else the one the session last opened or
  worked in, else its newest. A session with no tab of its own gets the browser
  tab the user last had in front of them (`setShownBrowserTab`, set by
  `ContextPanel` with the project on screen) only when that tab is the user's
  and in the session's project, and claims it only after a short delay, so a
  client that holds the session's own tab wins the claim; otherwise the agent
  is told so, with the tabs it could name. A request with no session keeps the
  earlier rule within the project on screen: the shown tab, else that
  project's newest tab. An action
  never switches the user to the tab it acts in. `browser.open` without `tabId`
  never navigates an existing tab: the registered opener (`ContextPanel`,
  `useUIStore.openAgentBrowserTab`) makes a new background tab in the calling
  session's project, owned by that session, and the answer carries its `tabId`.
  `browser.close` removes a tab the calling session opened. Closing is panel
  state rather than a page action, so the panel registers a closer the way it
  registers the opener; without `tabId` the session closes its own most recent
  tab, and a tab the user or another session opened is refused, never closed,
  even when an action without `tabId` would otherwise have used it. A close
  with no calling session, which the `POST /api/openchamber/control` route can
  produce, owns no tab and is refused outright: a null session must not match
  an unowned (the user's) tab. When the named tab is gone, a client with the
  panel mounted answers "no such tab" after the claim delay rather than leaving
  the agent to time out.
  `ContextPanel` keeps agent tabs of every project mounted (or registered as
  sleeping), so a session keeps working its page while the user looks at
  another project. An agent tab with no agent action and not on screen for
  30 minutes (`AGENT_TAB_IDLE_MS`) sleeps: agent tabs run unthrottled, and a
  finished session would otherwise hold a busy Chromium process until the tab
  closes. Its next action wakes it at the last address, so page state that
  lives only in memory (a half-filled form) is gone by then. The user's own tabs, across every project together, keep
  their page while among the `liveBrowserTabLimit` most recently used (a
  General setting, 5 by default, `lib/browser/liveTabs.ts`); the rest sleep, and
  those of other projects are not offered to agents. `browser.snapshot` answers carry `tabs` (`id`, `title`, `url`,
  `owner`: `you`, `user`, or `another session`, `active`: the tab an action
  without `tabId` would use); a session sees its own tabs and the other tabs of
  its project, never another project's. `ContextPanel` renders loaded tabs
  sorted by directory and tab id, so neither a project switch nor the store
  reordering directories moves a live webview, which would reload its page.
  A client without the named tab waits
  briefly, so the client that has it claims first, then claims and answers
  "no such tab". A tab restored from a previous run has no pane until it is
  shown or used, so `ContextPanel` registers it as sleeping
  (`registerSleepingBrowserTab`): it is listed in `tabs` without being loaded,
  and an action that lands on it wakes it after the claim and waits for its
  pane. `browser.capture` never opens the panel or switches its tab: a hidden
  pane is drawn at zero opacity inside the window for the screenshot, because
  Chromium composites a transparent webview but not a hidden or clipped one.
  A Wayland compositor sends no frame callbacks to a window it is not showing
  (minimized, on a hidden workspace or tab, the screen locked or off). Such a
  window has no frame to put the stage in and no surface to copy, so the
  capture waits for two frames and answers with an error that names the cause
  and points to `browser.snapshot` once 1 s passes without one. A wait that
  saw a frame, or whose timer ran late behind a busy thread, starts over.
  Without that limit it waited out the broker's 20 s timeout, and agents
  retried it. Forcing a frame
  by capturing the host window with `stayHidden` and retrying was tried and
  rejected: the first capture came back, every later one hung until the
  timeout.
  A hidden page also gets no animation frames, so `browser.scroll` waits for
  two frames at most 100 ms (`pageActions.ts`) and then answers anyway.
  `browser.open` reports `settled` only once the page has loaded and then gone
  quiet: no new resource and no DOM tree or text change for 500 ms
  (`buildQuietScript`), waited at most 5 s. The load event alone came while an
  app was still fetching its lazy chunks behind its splash screen, so a capture
  right after it showed the splash. An open without `tabId` on a driving host
  waits for the new tab's view and asks it the same through the pane-only
  `browser.settle`; the tab is open either way, so a failed wait answers
  `settled: false`, never an error. `browser.capture` waits the same way for at
  most 3 s, then shoots what is there. Attribute changes do not count, because
  a finished page changes classes and styles on hover all the time; a running
  animation that will end does count, and one that loops forever or follows
  scrolling does not. A
  background tab gets no animation frames while `visibilityState` still says
  `visible`, so an app's splash that fades out by style starts fading only
  when a capture shows the page: without the animation check the capture shot
  the first frame of that fade (seen on `/mobile.html`). A page can
  report a resource only once it has arrived, so a single chunk slower than
  500 ms behind an unchanging splash still ends the wait early; the next
  snapshot shows the splash, and nothing in the page can see a request in
  flight.
  Agent work never takes keyboard focus from the user
  (`useWebviewFocusGuard` beside `BrowserPane`): a page may take focus only
  while the user can see it and no agent action is driving it, otherwise focus
  goes straight back to where it was. A press inside the page moves focus to
  the view with no `focusin` in the app, only a window `blur`, so the guard
  checks after that blur too; and when an action ends, focus it moved anywhere
  (a Tab out of the page's last field lands in the app, as in a browser) goes
  back to the element the user had. Before every input action the pane asks
  the desktop shell (`desktop_browser_keep_page_focused`) to emulate focus for
  that page: the page then behaves as focused, so pickers stay open and its
  clipboard calls work. The emulation stays for the page's lifetime. When it
  is unavailable (the debugger could not attach; an open DevTools does not
  stop it), the action gives the page real focus (`holdPageFocus`) and
  returns it before waiting out any load the action started.
  A tab an agent opened browses in a profile of its own,
  `persist:openchamber-browser-agent`, without the user's logins: a page can
  steer the agent, and with the user's sessions it would act as the user on
  every site. What is signed in to there stays for later agent tabs. The
  setting `agentBrowserSharesLogins` (Settings, OpenChamber Web) puts agent
  tabs in the user's profile instead; an open agent tab remounts at its
  current address when it changes, since a view keeps the partition it was
  created with. A link an agent's page opens in a new tab becomes another tab
  of the same agent. The user's own tabs stay in the user's profile while the
  agent drives them. The shell hardens, keeps and flushes both profiles alike.
  A guest view is transparent, so a page with no background of its own used
  to show the app behind it and capture as black. Every panel page gets a
  white base background through its debugger session before its first paint
  (`Emulation.setDefaultBackgroundColorOverride`), as a browser draws it; a
  page that asks for `color-scheme: dark` still gets Chromium's dark canvas.
  A CSS background on the view was rejected: it painted those dark pages white
  too, and a capture copies only the guest, so it stayed black.
  Page actions run through the desktop driver
  (`packages/electron/browser-panel-driver.mjs`, composed in
  `packages/ui/src/lib/browser/pageDriver.ts`). Scripts run in an isolated
  world of every frame, cross-origin frames included, so `browser.snapshot`
  lists the controls of iframes and open shadow roots, and file inputs even
  when hidden. Each entry gets a ref (`e1`, `e2`, ...) that names it until the
  next snapshot of the tab; a ref whose element or frame left the page asks
  for a new snapshot. A ref also carries the document it came from: a frame
  keeps its id across a navigation while its new document numbers its
  elements from 1 again, so a number alone would reach an unrelated element. A selector names an element of the top document only, so
  entries in frames and shadow roots carry no selector, and frame entries
  carry `frame` (its address) and bounds on the page. Clicks, hovers, keys,
  typing and pointer drags are real input over the page's debugger session, so
  the page gets trusted events, CSS `:hover`, its own hit testing and focus
  rules. A press goes to the session that holds the element's frame, at that
  frame's coordinates: sent to the top page instead, a press meant for a
  cross-origin frame landed on the page around it whenever the panel was
  hidden, because the view of a hidden tab has `pointer-events: none` above
  it. Real input reaches only a page Chromium draws: a hidden tab takes none
  and the call hangs, so for each input action the stage is drawn at zero
  opacity inside the window, under the app's content (`revealStage` in
  `BrowserPane`), and an action that gets no answer in 12 s fails. An element
  with something drawn over its centre is refused with what covers it, since a
  real click would land on the cover. `browser.type` selects the field's
  content and inserts the text, so it replaces what was there, then reads the
  value back. An HTML drag (the source or an ancestor `draggable`, as links and
  images are by default) runs as the page's own drag events with one
  `DataTransfer`: a real one starts the system's drag session in the app's
  window, which Electron does not let a guest's debugger intercept, and the
  process hung in testing. Any other drag is a real press, move and release.
  A JavaScript dialog holds the page until it is answered, scripts and input
  included, and Electron shows it as a sheet on the app's window while it is
  open. A tab an agent opened answers its own dialogs: the driver answers
  each as it opens, no unless the running action passed `dialog: "accept"`,
  and the action's result lists them (`dialogs`, with a note when one was
  answered no). The sheet then only flashes; otherwise it held the user's
  whole window until the agent's next step, seconds later. Hiding the sheet
  and keeping the dialog for the agent is not possible: Electron's only switch
  (`disableDialogs`) answers no at once, before the debugger can answer. In
  the user's own tabs the driver tracks the open dialog instead; an action
  that opens one answers with it at once, a snapshot reports it instead of
  reading the page, and every other action refuses until `browser.dialog`
  answers it. `browser.wait` checks every quarter second for text in any
  frame or an element, or with `gone` for its absence, at most 15 s.
  `browser.upload` takes paths the server checks (`uploads.js`): real paths in
  the session's folder or OpenCode's temp folder (`$TMPDIR/opencode`) only,
  at most 10 files and 25 MB. The server reads the files when it checks the
  paths and holds those bytes under a token for two minutes, so a file
  swapped or grown afterwards changes nothing; the client may be on another machine, so it fetches them from
  `/api/browser-control/uploads/:token/:index`, the shell writes each to a folder of its own in its
  temp folder (kept a day; two files may share a name) and attaches only files it wrote there. Actions
  beyond `BROWSER_CONTROL_ACTIONS` of `@openchamber/sdk` are refused when an
  extension provider answers browser actions: its contract does not have them.
  `browser.select` changes a native single-value HTML select by exact label or
  value, dispatches `input` and `change`, and verifies the selected option
  before returning.
  `browser.snapshot` exposes native select metadata on the corresponding
  element: `multiple`, plus an `options` list in DOM order containing each
  option's `label`, `value`, `selected`, and `disabled` state. Text-content
  labels collapse whitespace and trim like `browser.select`; an explicit
  `label` attribute is used verbatim. The list is capped at 32 entries and
  each label/value at 80 characters; `optionsTruncated: true` reports either
  cap. A selected option outside the cap is not promoted into the result.
  `tabId` is validated and passed through by
  `../openchamber-control/service.js` for every action, so an extension
  provider receives it untouched (`BrowserTabTarget` in `@openchamber/sdk`).

## Running the panel's code

The agent tool reaches the panel of the app the agent works from, so a change
to `BrowserPane`, `controlClient`, `pageActions`, `pageDriver` or the desktop
driver shows there only after that
app is rebuilt. Run it in `electron:dev` instead and send the actions to that
instance's API port, the one its log prints after `OpenChamber server
listening on`; the route has no session, so name the tab after the open:

```sh
curl -s -X POST http://127.0.0.1:<api-port>/api/openchamber/control \
  -H 'content-type: application/json' \
  -d '{"action":"browser.open","input":{"url":"http://localhost:<ui-port>/mobile.html","viewport":"mobile"},"contextDirectory":"<repo>"}'
```

`browser.capture`, `browser.snapshot` and the rest take `{"tabId": "<tabId from the open>"}`
in `input`. The tab stays in the background, as an agent's does, and the page
inside it is a `webview` target on the instance's debugging port for reading
what the actions alone do not show (frame rate, animations).

## Invariants

- Capability belongs to the connection, not to configuration. A client declares
  it can drive a page by opening its event stream with `browser=1`, which only
  a Chromium host does; the flag lives and dies with that connection, so there
  is no setting to enable and no restart to remember.
- A successful `browser.open` result states `drivable`: whether the client that
  opened the page can also drive it. The client knows its own host and the
  server cannot identify the claimer, so the answer is per-claimer and never
  inferred from configuration.
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
- Clipboard contents never cross this broker. A page writes directly to the host
  clipboard and native paste reads from it, so neither request nor result payloads
  contain the copied value.
