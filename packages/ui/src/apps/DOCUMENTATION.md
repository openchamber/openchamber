# Application roots

## Ownership

`VSCodeApp` composes the shared runtime, theme and sync contexts for VS Code webviews. The extension host selects the root's `panelType` in its bootstrap document. `VSCodeLayout` owns chat/session navigation; `SettingsView` owns Settings pages and responsive navigation. The native panel lifecycle belongs to `packages/vscode/src`, documented there.

`MobileShell` in `MobileApp` owns the phone and tablet surfaces, Settings among them.

`mobileConnections` owns saved mobile instances and their connect, password and reconnect flows. The welcome screen and Instances are one view (`MobileConnectionsView`) over its controller. Runtime HTTP authentication remains in `lib/runtime-auth` and `lib/runtime-fetch`.

`ElectronMiniChatApp` owns the desktop mini-chat renderer. `AppEffects` coordinates shared application effects. `deepLinks` owns the pure URL vocabulary; `deepLinkNavigation` applies parsed intents and connects native entry points to shell navigation. Native widgets consume snapshots built here; their rendering and persistence belong to `packages/mobile`.

## Invariants

- Mobile custom headers belong to the normalized address entered in the form. They reach that address's health check, password login, session check and runtime HTTP requests. They never follow another direct candidate or the private relay. Authorization remains reserved for the client token.
- HTTP requests with mobile custom headers refuse redirects in both the native connection checks and the fetch transport. The configured address must be the final address, so a redirect cannot forward proxy credentials to another origin or path.
- Native header values live in secure storage. Metadata holds an opaque reference; browser-mode storage holds the parsed header configuration inline. Missing headers preserve old connections. An unreadable native entry fails the connection or edit operation, without replacing the saved headers with an empty set.
- A header edit writes a fresh secure entry before publishing its metadata reference. Failure preserves the old reference and credentials. Replaced and removed references are deleted after the metadata commit. Native bridge calls remain bounded by the existing secure-storage timeout.
- Native mobile with headers uses the existing fetch-based OpenChamber event stream reader and the native WebSocket adapter behind `openRuntimeWebSocket`. Files media previews use bounded runtime HTTP reads and owned object URLs; prepared chat images use the existing validated data-URL loader. HTML previews and inline Markdown video still use browser-owned URLs without proxy headers.
- An empty welcome-form header editor preserves a saved connection's headers. Explicit clearing belongs to the prefilled Instances edit form. Cancelling a password prompt does not erase existing header credentials.

- Chat-side Settings entry points request the native Settings tab through `RuntimeAPIs.vscode`. They preserve chat selection, drafts and the current layout. The source's in-page dialog flag is cleared so it cannot block chat shortcuts.
- Only the Settings root receives page navigation. The bridge parses it before applying it to stores, and the mounted root signals readiness before the host consumes pending navigation.
- The Settings root supplies no selected directory to the shared sync provider. It does not start global session polling, selected-directory session bootstrap or background queue delivery/cleanup, and seeing it never marks a chat as viewed. Settings pages resolve their own project through `useSettingsDirectory`; catalog updates still use the shared sync context.
- Its runtime shortcut hook registers Settings actions only and requires no chat sync context. Chat, model and session shortcuts remain with chat roots, so a key pressed in Settings cannot create an unseen draft or change a session selection there. Escape reaches an input or menu before the tab's close handler.
- On mobile, a request for the Settings dialog opens the fullscreen Settings surface and clears the dialog flag (`mobileSettingsNavigation.ts`). It lands on the requested page when the phone shows that page, otherwise on the page list. Entry points keep calling `setSettingsDialogOpen` and need no mobile branch.
- Mobile Settings exposes Projects in navigation, search and shared Settings links. Project chat defaults use the shared Projects page and its project-scoped save path; the main-window worktrees shortcut remains unavailable on mobile. `MobileSessionsSheet` receives shared Add project requests so its directory picker can open above Settings.
- On mobile web, Back runs the same close ladder as the Android back button, one step per press, and the app is left only when nothing is open. Forward and traversals between routes never run the ladder. Layers closed through the UI leave no empty Back presses (`useMobileWebBackButton`, `lib/router/backGuard.ts`).
- Every route entry written while a layer is open goes through `pushRouteEntry` or `updateBrowserURL`, so it lands under the back guard. A direct `pushState` would bury the guard between two routes. A replacement keeps the guard and changes its URL; the route under it normalizes to the same place when Back reaches it.
- Inside the mobile shell the Settings stages write no history. A `SettingsView` given `registerBackHandler` steps through its stages in state only.
- Settings uses the existing persistence and broadcast protocol. Moving its host changes no stored format, registry key or runtime availability.
- The tablet shell's side panels follow the size class from `useTabletLayout` (`lib/device.ts`), never the device model. Where both fit (`roomyForPanels`, 1000 px wide and landscape) the sessions sidebar and the workspace panel can be open together. Where one fits (`roomyForOnePanel`, from 900 px: an unfolded iPhone Duo, a 13-inch iPad in portrait) both are side panels, but opening one puts the other away and closing it brings the displaced one back. In both classes the sidebar stays open after a session or page is picked. Narrower tablets keep the sidebar as a guest that closes after a pick, and the workspace as a full-cover drawer.
- The workspace drawer's tabs (and the tablet's workspace panel, the same component) are the built-in five (six in the native app, with Browser) plus one per extension that opted its panel into the phone (`phoneGuestPanelModes`, id `plugin:<id>`). One per-device order and hidden set covers both kinds (`lib/mobileWorkspaceTabs.ts`): a new extension tab goes last, one whose extension left the catalog drops out of the strip, the drawer and Settings, and its saved place stays in the stored order for when it comes back. An open extension tab whose extension leaves falls back to the user's first tab.
- Code outside the shell opens a tab through `openMobileWorkspace` (`connectMobileWorkspaceOpener`, connected by `MobileShell`): an extension frame's `openSurface` and `openCommit`, an item handed to an extension panel. The request closes a full-screen extension page first, so the asked-for tab is on screen. Without a mounted shell the call answers false and the caller reports it.
- Extension actions (`useGuestActions`) reach the phone's menus that have a desktop counterpart: the message sheet, the selection sheet, the session row's long-press menu, a long press on a Files row and the diff's line comment field. Every Files row has a long-press menu: Copy path, as the desktop row menu starts, then the extensions' file actions. An open-mode action is listed only for a guest that opted its panel in.
- A tap on a sidebar row's extension mark (`MobileGuestMarks`) does what a desktop click does when the extension opted its panel into the phone: it opens the row, then the extension's workspace tab, with no item. Any other mark toasts its text and opens its link, when it has one.
- The workspace drawer's tab strip scrolls the open tab clear of its edge fades whenever it changes, also when an action, `openSurface` or attach opened it while the drawer was closed (`SortableTabsStrip`, `layoutMode="scrollable"`).
- The workspace Browser tab (native app only, `packages/mobile/DOCUMENTATION.md`) is positioned and clipped below the tab strip; the iframe browser must not use its absolute root against the viewport. Home returns to the running dev servers. Back, the toolbar's and Android's, goes back inside the page first, then through the addresses opened, then to the server list; at the list Android Back closes the drawer.
- Extension pages that opted into the phone open full screen from the sessions list's More menu (`useUIStore.openGuestPageId`); the back ladder closes one before the drawers. `GuestHosts` (attach dialogs full screen, hidden frames for slash commands and background actions) is mounted by the shell as by the desktop layout.
- The tablet composer stays expanded except in the one-panel class, which keeps the phone's pill; a hardware keyboard expands it everywhere.
- The keyboard hold in `readTabletLayout` needs a focused text field. A keyboard class left on the root without one (a foldable switching screens can take the keyboard without the hide event) holds no layout, and a WebView resize with no field focused runs the hide (`mobileNativeChrome.ts`).
- Side safe-area insets (a landscape notch, the status bar column on the right of iPhone Duo) are cleared by `.oc-side-safe-area` on the shell and on every surface that covers the screen from outside it, and by the side paddings of sheets, dialogs and toasts. The Capacitor WebView does not match `display-mode: standalone`, so the PWA's `.main-content-safe-area` padding never applies there.
- iOS reports no inset for a screen's rounded corners. Where a screen gives neither a top nor a left inset (the inner screen of iPhone Duo), `mobile.css` sets `--oc-corner-clearance` (12 px) and `--oc-safe-area-top` takes it, so the top row clears the top-left curve; the iPad-style sidebar footer steps in from the bottom-left one. Elsewhere the clearance is 0.
- The connection heartbeat in the live connection's card on Instances (`MobileConnectionHeartbeat`) asks `/health` through `runtimeFetch` every 4 s, only while it is mounted and the app is in the foreground. On Capacitor the foreground comes from the native app state, since the WebView's page visibility is unreliable there. Going to the background or unmounting clears the pending ping, aborts the one in flight and stops its clock subscription. A ping with no answer within 5 s shows as "No answer", never as the last latency. Its trace steps on the shared clock's beat, four frames a second, like a spinner.
- Keep screen awake (`mobileKeepScreenAwake`, device-local) keeps the display on in the native app always, or while the open session or a subagent below it is active in the global status store (`useKeepScreenAwake`). "While working" also needs `isConnected`, because the store keeps a lost server's last busy state; a dead server therefore releases the screen, and a reconnect holds it again only while the turn still runs. A permission request keeps the turn running, so it keeps the screen on. Android holds a screen wake lock, which the system drops when the app leaves the screen, so the hook asks again on each return. iOS turns off the idle timer through the app-local `KeepAwake` plugin, and every mount writes the current choice so a reloaded page clears what the last one set. The setting renders, and the hook acts, only where `canKeepScreenAwake` holds: the iOS app, or the Android app on a WebView that exposes `navigator.wakeLock`. The hosted mobile page never keeps the screen on.
- Notification commands and initial session tabs in VS Code use the shared session opener, so a `/btw` fork opens its parent and expands the panel mounted in the shared composer. Notification commands also reveal the chat view.
- A sessions-sheet row is never a scroll container of its own: it clips with `oc-row-clip`, and the two-line row's 54 px box ends flush with the 32 px chevron at `top: 22`, so a drag that starts on a row scrolls the list.

### Boot, runtime changes and mini chat

- The mobile surface marker and device classes apply before React paints. Surface identity remains mobile on a wide tablet, and typography starts at its final mobile sizes. Font variables update in a layout effect because embedded pages read them in passive effects.
- The splash waits for appearance initialization and the selected UI font, then allows a paint before revealing content. Its bounded timeout lets an offline font source release the app. Appearance initialization releases its boot gate even on failure.
- Renderer entry points preload Markdown so arriving messages have text when the transcript appears. Mini chat also requests its URL-selected session during boot, overlapping the read with mounting.
- Web, desktop and mobile delegate queued delivery to the server so it continues without a UI. VS Code retains UI delivery. Worktree auto-archive runs only in the main window because mini chat cannot see worktrees open there.
- Mini-chat session shortcuts run beneath `SyncProvider` because stopping a turn reads live activity. Its initial URL selection yields to an existing user selection; subsequent shell session requests switch the focused mini chat in place or open the requested instance's window.
- Mini chat reads the newest session page for its switcher, leaving complete enumeration to the main window. Repository control events refresh only affected projects; failed worktree discovery leaves the draft selector's project-root fallback available.
- A same-device LAN/relay swap preserves the runtime key and mounted sync provider. A fresh SDK prop reconnects its effects in place, retaining pagination, session selection and editor state. A different runtime resets instance-owned stores, including path-keyed data whose project IDs can collide across servers.
- Web and desktop subscribe to runtime switches at the entry point because authentication and compatibility gates can unmount `App`. Same-runtime credential replacement remains with the mounted app so signing in preserves that host's terminal tabs.
- Native bootstrap requires an explicit endpoint. Capacitor's static origin can answer API requests with HTML and create a false successful connection. A persisted `isConnected` value cannot skip cold-launch reachability classification.
- Native connection selection retains one component-tree shape across connect and disconnect. Remounting restarts cold-launch probes and can repeatedly disconnect a slow server. Transient stream drops keep `MobileShell` mounted; only initial connection and actual instance changes show the connecting screen.
- Launch restore opens the remembered session before a complete paged snapshot arrives, provided the user has not selected another session. The automatically opened draft is a boot default. A bounded logo overlay hides that intermediate draft while sync mounts underneath; a failed session read leaves restore eligible to retry.
- Source-control authentication reads wait for a reachable connection so a failed startup probe cannot cache a false disconnected result. Mobile session deletion reconciliation uses complete active and archived snapshots because this root has no layout-level session poller.

### Mobile connection ownership and recovery

- Native metadata contains token presence and transport information; bearer tokens live in secure storage and are persisted before switching endpoints. Browser-hosted mobile stores tokens inline and retains `SessionAuthGate`; native mobile uses its own per-instance login flow.
- A device's secure-token identity prefers relay identity, then server identity, then URL. A URL alone can identify multiple containerized servers. The stable installation ID deduplicates pairing and password login into one server-side device record; unavailable storage degrades that ID to the current session.
- Direct health probes carry no bearer token. An explicit server-identity mismatch rejects the address before pairing or login secrets reach it; legacy health responses without an identity retain their compatibility behavior. Bearer validation excludes cookies so a surviving browser session cannot conceal a revoked token.
- Native and relay connections require a bearer token when authentication is enabled. A connection saved as tokenless remains valid when authentication is disabled. Failure to read an expected secure token is transient during resume and must not force login.
- A connection flow closes only tunnels it opens and does not transfer to the runtime. It borrows a matching live runtime tunnel because a second dial can displace the device's existing relay leg. Successful probes and login transfer their open tunnel before switching endpoints to avoid another handshake.
- Direct health reads run concurrently and their answers retain candidate priority. Relay starts after a short direct head start, or immediately when the device last used relay. Losing probe work is discarded and owned tunnels close; explicit token rejection applies across transports and ends the search.
- Relay probes use the encrypted handshake for host identity and `/auth/session` for liveness and authentication. Idempotent requests may wait for tunnel reconnection within their original budget; pairing redemption runs once because its secret is single-use. A failure on a still-connected channel is final.
- Resume recovery checks higher-priority candidates first, then the live transport, then lower-priority candidates. Network `online` also triggers a debounced probe because an Android Wi-Fi change need not background the app. Sequence guards make overlapping recovery attempts supersede earlier ones.
- Fast cold-launch failure releases the splash and explains the connect screen. One full-budget background retry allows a waking network or relay handshake to finish, while a manual connection wins. Live recovery uses a widening grace ladder; relay-limit refusals bypass immediate retries because the parked tunnel cannot recover on its own.
- Removing the active instance suppresses automatic reconnection for the rest of the run until a manual connect. A fresh launch may auto-connect again. Otherwise resume can retry the most recent saved device after a transient disconnect.
- Candidate refresh runs in the background after bootstrap traffic settles, only for relay-paired devices and only when the response confirms the saved server identity. Fresh HTTP LAN addresses replace stale LAN addresses; HTTPS tunnel addresses and relay survive. An empty LAN answer preserves existing candidates because interface discovery can fail transiently.
- Editing a saved connection retains candidates the form cannot show, especially the relay identity that keys its token. A changed token key moves the stored token. Relay-only entries retain their name when an edit leaves the label empty.
- Connection diagnostics are in-memory, bounded to the current launch and contain already-masked details. Request capture records paths without query strings because queries can contain folder paths. Logs serialize objects for Android logcat; the debug panel snapshots on open so copying is stable.
- Connection forms populate on the initiating tap so list churn cannot overwrite ongoing input. URL, token and password fields disable keyboard correction because it corrupts connection values. Relay-only instances expose name editing without a nonexistent direct address or typed token.

### Navigation, focus and panel lifetime

- Deep-link parsing stays independent of React, stores and Capacitor so native producers share one vocabulary. Unknown routes return null, and both authority and authority-less custom-scheme forms parse. Provider selection belongs only to Usage, including extension provider IDs.
- Native link listeners register before connection completes so cold-launch notification and URL intents survive splash and sync remounts. A module-level holder keeps only the newest intent, consumes it before dispatch and restores it when its shell handler is absent. Legacy notification session IDs remain a fallback when no explicit URL is supplied.
- Shortcuts can carry a first message; URL deep links cannot. A shortcut naming an unknown project leaves that message unsent in the default draft so the user chooses its destination. Session links use the shared opener, including parent-panel resolution for `/btw` forks.
- An agent's file request stages navigation only for the session on screen or its lineage. Unknown subagents resolve from the server; lineage traversal stops at unreadable sessions and cycles because `/btw` metadata is writable. A delayed trust decision cannot stage a path into the previously visible session's Files pane.
- Workspace panes retain their tree position across keyboard resizes and folding so an editor's draft and focus survive size-class changes. Closing retains the pending Changes request because it keys the persistent pane. New diff and commit requests are mutually exclusive and consumed once across remounts.
- Tablet panel opening and closing uses compositor transforms over a width changed once. Width animation repeatedly lays out chat. Closing holds space until the slide ends, except when a size-class change or a displaced panel must release it immediately to avoid squeezing chat between two panels.
- Resize handles render after panel content at the overlays' stacking level so full-cover editors cannot cover their hit targets. Drag widths update imperatively and commit at release; logical panel sides mirror in RTL. Workspace panels allow more width because diffs, editors and terminals need it.
- Shell insets publish the actual chat column for body-portaled overlays. Header popovers anchor in their fixed wrapper's coordinate system because transformed ancestors make that wrapper relative to chat; viewport coordinates would count the sidebar offset twice. Open popovers re-anchor on column resize.
- Fullscreen surfaces mount heavy children after the enter transition, with a fallback for reduced motion or interruption. Settled surfaces and drawers drop transforms so iOS does not retain a compositing layer clipped to the safe-area viewport. Full-cover drawers own page-scroll locking; inline panels leave chat scrollable.
- Focus and key handlers retain the latest close callback without rerunning on each parent render, which would steal input focus and collapse the keyboard. Closing layered pages restores their prior focus before a tap expands and focuses the composer. Escape stays with nested pages, terminals, Vim insert mode and IME candidate windows.
- The sessions drawer stays mounted while hidden to retain its tree and play its exit slide. Its list wakes after the enter slide starts because row rebuilding in the tap frame delays animation. Header and footer hosts use remaining flex height; a full-height child would overflow by the header's height and clip the footer.
- Session lists refresh on opening and on a reconnect edge, then seed cross-directory pending requests using the newly read directory list. Cached rows show immediately; complete snapshots refresh when stale. Reordering is available only for manual project grouping, and display choices share desktop persistence.
- Opening the drawer scrolls to its current row once; live row changes never move the list under the user's finger. A renamed row stays mounted outside the virtual viewport. Filtered or removed rows release swipe and rename state so hidden actions cannot swallow another tap.
- Row swipes expose actions toward the logical end, leaving the opposite gesture for drawer dismissal. A revealed row consumes the next dismissing tap or swipe. Long-press menus suppress the following touch click, while keyboard and mouse context menus leave the next click alone.
- Rows keep an opaque background under their translucent selection shadow so swipe actions cannot show through. Actions remain hidden beneath covered rows during list animations because WebKit can stop painting the moving row over them. Inline control minimums override the mobile stylesheet's global touch-target floor, and rename inputs preserve row height with a stable selection ref.
- Touch edge listeners stay passive to preserve native scrolling and text selection. Any selection cancels the gesture for its lifetime. Horizontally scrollable content owns movement while it can scroll that way; at its end, only a longer, flatter gesture opens the drawer. Android's wider activation strip clears the system Back gesture region.
- Session-family actions resolve all active descendants across directories, rather than only visible rows. Folded descendants contribute waiting requests. Compaction leaves context-gauge fill unknown, and a draft has no measured fill; neither is a measured zero.

### Changes and files

- Changes waits for the requested repository before applying commit scope; a repository outside the folder cannot borrow another repository's commit selection. Explicit commit navigation ends a board-selected PR override, and every repository change clears repository-bound PR selection.
- A changed-file request looks in Last turn first, then in its repository's freshly read working-tree status. Only an answer for the current session settles it; failed reads retain Retry. Manual navigation or leaving the scope ends the request, while repository resolution alone does not replay it.
- Comparison expansion belongs to the exact path, range and retry cache entry. Branch and commit views request full context from Git; PR views reconstruct full contents from GitHub's two file versions. A pure rename has no hunks to draw. New nested-repository answers supersede earlier declined-diff results.
- Hidden workspace panes keep navigation but perform visibility-scoped reads only while shown. Entering a comparison scope reports loading during render to avoid a false empty frame; revisits retain the previous list while refreshing. Failed background folder reloads preserve the listing already on screen.
- Mobile reverts bound concurrency because the server serializes them per repository and excess POSTs occupy connections needed for reads. Local branch creation never implicitly pushes. A failed publish before a dirty switch leaves the user on the committed branch; pull conflicts remain a merge in progress.
- Identity selection uses the repository's bound primary remote and the same configuration answers as add and clone. Trusting system Git is confirmed in repository configuration because selecting a menu item alone cannot authorize that trust.
- Worktree deletion handles sessions in every subfolder while their directory still exists. Archiving rolls back if removal fails; keeping sessions moves them to the project first. Teardown retries reread options at execution time, and failed remote-branch deletion preserves the worktree with its reason.
- Files navigation remains rooted for parent traversal, while an explicit chat tool target can open outside the workspace through the editor's existing outside-workspace read path. Image-preview navigation retains the browsed folder as Back's destination. Upload completion reloads only the folder still on screen.

### Native chrome, notifications and snapshots

- Android OS version comes from native code because hardened WebViews can report a fixed older version. Android's native keyboard resize owns viewport height; iOS with resize disabled uses a manual inset. Applying both would count the keyboard twice. Pre-Android-15 status-bar inset success disables the matching CSS inset only after the native call succeeds.
- Status-bar overlay state is reapplied on startup and activation because scene lifecycle changes can drop it. Theme-class changes update status-bar content immediately; Capacitor's style names describe content color, so dark and light choices follow that API's mapping.
- iOS keyboard motion reserves transcript geometry once and animates movers on the shared keyboard curve through Web Animations. Inline transforms avoid delayed custom-property transitions. Layout and transforms exchange at settle without changing the final scroll geometry; keyboard padding remains until the hide glide lands.
- Keyboard ownership distinguishes shell fields from fields on covering surfaces. A surface keyboard leaves the covered transcript alone; focus transfer on the same side does not apply a second full inset. Terminal proxy inputs receive no added room, editable documents measure the caret, and ordinary covered fields receive scroll room retained while the keyboard is up.
- Native caret painting is hidden through the iOS transition and reposition window because it does not follow CSS transforms. Deferred focusout starts dismissal before the bridge hide event without treating synchronous refocus as dismissal. Composer collapse happens before measurement so keyboard and composer shrink form one movement.
- Native lifecycle combines app-state and visibility signals with one resume per inactive-to-active transition. Heartbeat timestamps reset when its shared clock restarts; each ping has its own abort signal so runtime fetch cannot share another caller's result. Digit clipping uses paint containment because mobile overflow utilities create scrollers and old iOS lacks overflow clipping.
- Native push is the notification channel; in-app notification dispatch is disabled because WebView focus cannot reliably suppress local delivery. Registration follows the connected endpoint and notification preference; disabling notifications unregisters explicitly, while transient disconnects do not. Tap handling remains with the always-registered deep-link source.
- Push registration includes platform and the build's APNs environment, defaulting to production when the injected environment is absent. A native-created sealing key is shared with the notification extension or messaging service; older shells without it retain plain-text compatibility.
- Widgets consume display-only snapshots; network reads remain in the connected app and Android sync runs only with placed widgets. Unloaded stores and failed builders preserve native snapshots. Quota timestamps reflect provider answers, and failed refreshes cannot rewrite old data as fresh. Queued native refresh taps are acknowledged after fetching, including taps arriving during a fetch; bridge failure leaves them queued.
- Widget session ordering, unread state and project ownership match the shared lifecycle and sidebar, including worktrees and isolated spaces. The iOS bridge returns a JSON primitive or null so failed construction cannot overwrite a good App Group snapshot. Widget quotas use the Usage page's selected providers, models, formatting and theme colors without copying credentials.

## Decisions

### Why a visited extension tab keeps its frame and not a fresh load per visit

The drawer keeps every visited pane mounted while hidden, and the desktop rail keeps a panel frame it has shown; an extension tab does the same, so its page keeps its place, a half-filled form and an item it was handed across tab switches and a closed drawer. The memory is one frame per extension the user opened in this run, and a frame unmounts when its extension leaves the catalog. A live screen's picture mounts only while its tab is on screen, so an unwatched surface keeps no socket open.

### Why mobile proxy headers bind to an address and not every transport

A saved device can have LAN addresses and a relay route that do not pass through the user's proxy. Binding headers to the entered address prevents proxy credentials from reaching those alternatives after a reconnect or candidate refresh.

### Why secure header writes use new references and not in-place replacement

The secure store and localStorage cannot commit together. A new reference lets a failed metadata write preserve the previous credentials without a compensating secret write that could also fail.

### Why navigation carries intent and not the source's stores

Each webview owns its own stores. A small parsed request preserves the originating Settings directory, page links, provider-connect action, new-snippet action and selected skill without transferring chat state or overwriting the tab's independently edited settings.

### Why mobile web holds one back guard and not one history entry per layer

Popups, overlay sheets and the Settings stages open and close without passing through the shell, so entries per layer would drift from what is on screen, and each layer closed through the UI would leave an empty Back press. One entry on top of the stack needs only one fact, whether anything can be closed, and `popstate` from it can only be Back, which is how Forward stays out of the ladder. The cost is the browser's own rule for `pushState`: arming the guard drops any Forward entries, so opening a layer after going Back ends the way back to the later route.

### Why one panel at a time and not a full-cover workspace drawer on an unfolded foldable

An unfolded iPhone Duo is 951 px wide: one 320 to 380 px panel leaves a readable chat, two do not. The full-cover drawer hid the chat and the sidebar on a screen that has room for one of them beside it, so the panels swap instead, and the displaced one returns when the other closes. Tablets under 900 px (an iPad mini, Air or 11-inch Pro in portrait) would leave the chat under ~510 px with a panel open, so they keep the drawer.

### Why the heartbeat pings `/health` and not a signal the client already gets

Latency is a round trip, and no event the client receives carries one. The ping runs only while the card is on screen, so it costs one small request every 4 s while someone looks at it. It goes through `runtimeFetch`, so over the relay it measures the relay path the app really uses.

### Why mobile listens for the dialog flag and not a mobile branch at every entry point

About twenty shared entry points open Settings through `setSettingsDialogOpen`. The phone renders no dialog, so each one did nothing there and left the flag set, which blocks chat shortcuts. One bridge in the shell covers every entry point, the same way the VS Code bridge does.

### Why Android uses the Screen Wake Lock API and iOS a native plugin

The Android WebView grants `navigator.wakeLock` without a tap, and the lock shows up as the app's own screen wake lock in `dumpsys power`, so Android needs no native code. WKWebView grants it only inside a tap: Capacitor's web view answers WebKit's permission query with "prompt", so a request made when a run starts or after a relaunch is denied. iOS therefore sets `UIApplication.isIdleTimerDisabled` through `KeepAwake.swift`. An Android WebView without the API gets no setting, so nothing claims to keep the screen on there.

"While working" follows the session's own run and its subagents. Waits on a pull request, an extension or a background command keep a turn open for hours with nothing new on screen, so they do not hold the display.

### Why mobile uses the Projects page and not a separate defaults form

The shared page already supports project selection through mobile split-page navigation. Reusing it keeps the defaults controls, search anchors and persistence in one place.

### Why rows clip with `overflow: clip` and not `overflow: hidden`

`styles/mobile.css` rewrites every `.overflow-hidden` element to `overflow-y: auto !important` on a touch layout, so each phone row became a scroll container with its own scroll layer. The detailed row's chevron hung 2 px past the row's box and gave it something to scroll, and the row then swallowed a drag that started on it. `overflow: clip` clips the same way without a scroll box. Browsers without it (iOS 15) keep the `overflow: hidden` fallback, where the row's box fits its content and has nothing to scroll.

### Why native secure storage uses internal methods and not its lazy JavaScript wrapper

The Capacitor proxy can stall while loading the secure-storage plugin's platform JavaScript. Calls use its native internal methods with locally prefixed keys and bounded waits so a stalled Keychain bridge cannot block connection indefinitely.

### Why Android scanning uses CameraX startScan and not the ready-made activity

`startScan` bundles its barcode model and works without Google Play Services. iOS uses its native scanner. A URL-API-free fallback accepts intact pairing links that older Android WebViews split incorrectly.

### Why the scanner hides top-level siblings and not only the React root

CameraX previews behind the WebView, while independent portal roots can still paint sheets over it. Each top-level sibling becomes transparent as a whole subtree, and an inline important background clears the reduced-transparency theme's important color despite Android CSS minification behavior.

### Why tablet app pages use dialogs and not full-width pages

Settings and Instances contain little content for a tablet-wide page, and a centered card preserves the visible chat context. App-level dialogs center on the window; content opened from chat centers on its column.
