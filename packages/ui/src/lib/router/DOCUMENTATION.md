# URL routing

## Ownership

The router parses and serializes app URL state. `useRouter` applies routes to
the session and UI owners. `notificationNavigation` routes browser notification
clicks and service-worker requests through the mounted router. The web service worker owns
window focus, acknowledgement deadlines, and document-navigation fallback.

## Invariants

- Web and hosted-mobile PWA notifications use the mounted router for same-origin,
  same-path navigation. Native notification adapters retain their own entrypoints.
- Browser-created notifications use the same router even without service-worker
  support. A mounted router registers its callback for its lifetime; unmounting
  releases it. A missing or declining router leaves document fallback available.
- A request is acknowledged only when the router accepts it. Busy initialization,
  an old page without a listener, and an expired request cannot claim acceptance.
- Acceptance does not wait for network-backed session resolution. The existing
  session-link owner resolves the directory and guards against later selection.
- Session-only `/btw` links open the existing parent and expand its panel. Cold
  resolution replaces the intermediate fork history entry; notification routing
  and Back/Forward normalize the URL to the selected parent. Message links keep
  their named transcript, and a missing parent leaves the fork accessible.
- Back/Forward during route loading retains the latest requested route. Only
  its completed application may normalize the current history entry.
- A route without a settings path closes Settings before it waits for its
  session to resolve, never after. Settings the user opens while a cold session
  link is still loading the global list stay open, and the completed route's
  normalization writes them into the URL.
- The worker focuses before messaging and waits at most 1500 ms for acceptance.
  Missing or negative acknowledgement falls back to document navigation; a closed
  client does not prevent trying another client or opening a window.
- Message ports and listeners are released after use. Expired requests cannot
  navigate a page after the worker's fallback deadline.
- Windows unread jump-list links require a known session before changing selection.
  They wait for the global list on a cold launch; stale entries leave selection unchanged.
- A web session link belongs to this instance only when its origin matches the
  page or the connected runtime API server.
- An open mobile web layer keeps a duplicate-URL Back guard at the top of history.
  New routes go underneath it so a buried guard cannot consume a later Back press.
  Route replacements correct the guard URL; the entry beneath resolves to the
  same destination when Back reaches it.
- A native dev-server preview guard belongs to the displayed page's ID. The
  page's navigations sit above it so Back exhausts them before leaving the preview.
- Cold session opens may guess the directory before the global session list
  loads. The loaded list corrects selection only while the initial target remains
  selected. Only synchronous selection notifications during a redirect replace history.
- Message-focus requests accept plain identifier characters because session and
  message IDs pass through URLs into DOM attribute selectors.
- Legacy settings section IDs remain intact during parsing because route
  application owns their mapping. Legacy non-chat `tab` values open context-panel
  surfaces while chat retains the main area.

## Decisions

### Why message focus survives being shown and not just loading

A cold session link can mount a timeline under a guessed directory and then mount
another under the resolved directory. The newest focus request remains available
after either timeline shows the message, until the reader takes the viewport,
another session opens, the message proves missing, or the request expires.

### Why focus progress has separate listeners and not request notifications

Progress updates must not ask timelines to serve the same request again. Separate
status listeners report display and expiry to the initiating control, and a serial
distinguishes repeated clicks on the same link.

### Why Settings close before the session await and not after

The session list can take seconds on a busy machine, and the chat is usable
before it finishes. Closing Settings after the await closed the Settings the
user had opened in that window, before they rendered. Back from Settings to a
chat link still closes them, only sooner.

### Why the router registers the opener and not the session store

The router registers the shared session opener so the session store stays
independent of routing.

### Why VS Code keeps its URL and not serialized route parameters

VS Code webviews carry session identity outside route parameters through
`__VSCODE_CONFIG__`. Rebuilding their URL strips that identity, so browser URL
updates are disabled in this context.

### Why a `/btw` fork opens its parent

A fork is hidden from session lists and rendered inside its parent's panel.
Opening it alone strands the reader outside that panel. Session-only routes,
notifications, toasts, desktop session events in both windows, and native deep
links therefore use `openSession` to resolve the parent and expand its panel.
Message links retain the fork because their message lives in that transcript.

### Why acknowledged app navigation and not unconditional document navigation

Document navigation reloads the running PWA and discards its in-memory state.
A per-click message port lets a mounted router take ownership without reloading,
while a bounded fallback supports older or unresponsive pages during updates.
