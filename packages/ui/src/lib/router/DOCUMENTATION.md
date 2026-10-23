# URL routing

## Ownership

This module parses and serializes browser query routes and applies session,
guest-panel and Bots destinations. `subscribeMainSurfaceNavigation` owns main-page
retirement when desktop navigation selects a session or opens a draft.
`useRouter` owns initial browser navigation
and popstate. `openNativeSessionLink` parses Electron click events before applying
a destination or handing a foreign owner to desktop IPC. Native mobile parses links in `apps/deepLinks.ts` and shares
Bots target application through `openBotsFromRoute`.

## Invariants

- `?botsProject=<projectId>&botItem=<itemId>` requires both plain identifiers.
  A complete Bots target takes precedence over a session, settings or legacy
  panel target and opens without a session read.
- Web and Electron set the one-shot `botsPageTarget` and open Bots using the
  main-page store action. Hosted and Capacitor mobile provide their shell's
  `openBots` action. VS Code ignores Bots targets; mobile never falls through
  to the desktop page when its shell opener is absent.
- Ordinary app-state URL synchronization drops consumed Bots parameters.
  Explicit target serialization emits only the two Bots parameters.
- Runtime changes clear pending UI targets and retire route continuations.
  Native mobile drops a queued Bots intent when leaving a connected runtime.
  First connection from a transient runtime preserves a cold-launch intent.
- A newer browser navigation retires an older route's asynchronous continuation.
- Selecting a session or opening a draft closes the desktop main page. Draft
  navigation follows `draftId` and the closed-to-open transition. Background
  preparation of the same draft preserves an already opened deep-link destination.
- Native `botTarget: { projectId, itemId }` uses the same plain-ID contract as
  the query route, rejects extra target properties, and wins over session metadata.
  A foreign `runtimeKey` goes through saved-host resolution; missing bridges or
  unresolved owners never apply the target to the active runtime.

## Decisions

### Why draft identity controls main-page retirement

Chat directory preparation replaces the draft object asynchronously, including
after an initial Bots link opens. Comparing that object treated bootstrap work
as navigation and closed Bots. The draft's `draftId` changes when another draft
opens, so navigation still retires the page without reacting to background updates.

### Why project and item IDs without a session

An item can need attention before any stage session exists. Its project and
item IDs are sufficient for the Bots page to resolve it. Depending on a session
would make those notification links unusable.

### Why one-shot navigation rather than a persisted Bots URL

The feature already consumes navigation targets after loading the project.
Keeping its ordinary page state out of URL synchronization preserves that
contract while allowing initial links and browser history entries to open items.

### Why structured native targets rather than navigation URLs

Native notification payloads cross process and stream boundaries. Carrying only
project and item IDs lets each owner serialize its own local route without
allowing a notification to choose an arbitrary origin. The native event parser
keeps this trust boundary out of `App` and preserves ordinary session links.
