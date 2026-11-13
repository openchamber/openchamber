# URL routing

## Ownership

The router parses and serializes app URL state. `useRouter` applies routes to
the session and UI owners. `notificationNavigation` routes browser notification
clicks and service-worker requests through the mounted router. `openBotsFromRoute`
applies the one-shot Bots target for browser, native and mobile callers.
`openNativeSessionLink` parses Electron click events and uses the shared owning-host
navigation helper. The web service worker owns
window focus, acknowledgement deadlines, and document-navigation fallback.

## Invariants

- `?botsProject=<projectId>&botItem=<itemId>` requires both plain identifiers.
  A complete Bots target takes precedence over session, settings and panel
  metadata, and opens without a session read. Native `botTarget` uses the same
  strict project/item contract.
- Web and Electron install `botsPageTarget` and open the main Bots page. Hosted
  and Capacitor mobile supply their shell opener. VS Code ignores Bots targets;
  a mobile caller without its shell opener never opens the desktop page.
- Ordinary app-state serialization drops consumed Bots parameters. Explicit
  target serialization emits only the two Bots parameters.
- Runtime changes clear pending Bots UI targets and retire route continuations.
  Native mobile drops queued Bots intents when leaving a connected runtime;
  a first connection from a transient runtime preserves a cold-launch intent.
- Foreign native Bots targets go through `openSessionInOwningHostWindow` with
  their structured target. A missing bridge never applies them to this runtime.
- Bots navigation supersedes a pending session route immediately. The session
  opener checks its owner's abort signal before committing cold resolution;
  retired routes cannot reselect a session or normalize the Bots entry.
- Native guest-panel continuation belongs to the captured runtime lifetime.
  Switching runtimes retires both its session resolution and panel opening.
- `subscribeMainSurfaceNavigation` retires desktop main pages when selecting a
  session or opening a draft. Draft identity and closed-to-open transitions
  define navigation; background preparation of the same draft preserves Bots.
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
- Windows unread jump-list links require a known session before changing selection.
  They wait for the global list on a cold launch; stale entries leave selection unchanged.

## Decisions

### Why project and item IDs without a session

An item can need attention before a stage session exists. Its project and item
IDs let Bots resolve it, and structured native targets let each host choose its
local route without accepting an arbitrary notification origin.

### Why one-shot Bots targets

Bots consumes a target after loading its project. Ordinary URL synchronization
keeps that lifecycle while initial links, notifications and history can open items.

### Why draft identity controls main-page retirement

Chat preparation replaces a draft object asynchronously. Comparing `draftId`
preserves an initial Bots destination through that background preparation while
still retiring the page when another draft opens.

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
