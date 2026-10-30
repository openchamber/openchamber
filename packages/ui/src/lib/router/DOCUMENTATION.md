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
- The worker focuses before messaging and waits at most 1500 ms for acceptance.
  Missing or negative acknowledgement falls back to document navigation; a closed
  client does not prevent trying another client or opening a window.
- Message ports and listeners are released after use. Expired requests cannot
  navigate a page after the worker's fallback deadline.

## Decisions

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
