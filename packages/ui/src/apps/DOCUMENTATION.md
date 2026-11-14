# VS Code and mobile application roots

## Ownership

`VSCodeApp` composes the shared runtime, theme and sync contexts for VS Code webviews. The extension host selects the root's `panelType` in its bootstrap document. `VSCodeLayout` owns chat/session navigation; `SettingsView` owns Settings pages and responsive navigation. The native panel lifecycle belongs to `packages/vscode/src`, documented there.

`MobileShell` in `MobileApp` owns the phone and tablet surfaces, Settings among them.

`mobileConnections` owns saved mobile instances and their connect, password and reconnect flows. The welcome screen and Instances are one view (`MobileConnectionsView`) over its controller. Runtime HTTP authentication remains in `lib/runtime-auth` and `lib/runtime-fetch`.

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
- The workspace drawer's tabs (and the tablet's workspace panel, the same component) are the built-in five plus one per extension that opted its panel into the phone (`phoneGuestPanelModes`, id `plugin:<id>`). One per-device order and hidden set covers both kinds (`lib/mobileWorkspaceTabs.ts`): a new extension tab goes last, one whose extension left the catalog drops out of the strip, the drawer and Settings, and its saved place stays in the stored order for when it comes back. An open extension tab whose extension leaves falls back to the user's first tab.
- Code outside the shell opens a tab through `openMobileWorkspace` (`connectMobileWorkspaceOpener`, connected by `MobileShell`): an extension frame's `openSurface` and `openCommit`, an item handed to an extension panel. The request closes a full-screen extension page first, so the asked-for tab is on screen. Without a mounted shell the call answers false and the caller reports it.
- Extension actions (`useGuestActions`) reach the phone's menus that have a desktop counterpart: the message sheet, the selection sheet, the session row's long-press menu, a long press on a Files row and the diff's line comment field. Every Files row has a long-press menu: Copy path, as the desktop row menu starts, then the extensions' file actions. An open-mode action is listed only for a guest that opted its panel in.
- A tap on a sidebar row's extension mark (`MobileGuestMarks`) does what a desktop click does when the extension opted its panel into the phone: it opens the row, then the extension's workspace tab, with no item. Any other mark toasts its text and opens its link, when it has one.
- The workspace drawer's tab strip scrolls the open tab clear of its edge fades whenever it changes, also when an action, `openSurface` or attach opened it while the drawer was closed (`SortableTabsStrip`, `layoutMode="scrollable"`).
- Extension pages that opted into the phone open full screen from the sessions list's More menu (`useUIStore.openGuestPageId`); the back ladder closes one before the drawers. `GuestHosts` (attach dialogs full screen, hidden frames for slash commands and background actions) is mounted by the shell as by the desktop layout.
- The tablet composer stays expanded except in the one-panel class, which keeps the phone's pill; a hardware keyboard expands it everywhere.
- The keyboard hold in `readTabletLayout` needs a focused text field. A keyboard class left on the root without one (a foldable switching screens can take the keyboard without the hide event) holds no layout, and a WebView resize with no field focused runs the hide (`mobileNativeChrome.ts`).
- Side safe-area insets (a landscape notch, the status bar column on the right of iPhone Duo) are cleared by `.oc-side-safe-area` on the shell and on every surface that covers the screen from outside it, and by the side paddings of sheets, dialogs and toasts. The Capacitor WebView does not match `display-mode: standalone`, so the PWA's `.main-content-safe-area` padding never applies there.
- iOS reports no inset for a screen's rounded corners. Where a screen gives neither a top nor a left inset (the inner screen of iPhone Duo), `mobile.css` sets `--oc-corner-clearance` (12 px) and `--oc-safe-area-top` takes it, so the top row clears the top-left curve; the iPad-style sidebar footer steps in from the bottom-left one. Elsewhere the clearance is 0.
- Keep screen awake (`mobileKeepScreenAwake`, device-local) keeps the display on in the native app always, or while the open session or a subagent below it is active in the global status store (`useKeepScreenAwake`). "While working" also needs `isConnected`, because the store keeps a lost server's last busy state. A dead server does not release the screen yet: after a WS → SSE fallback, `onTransportSwitch` in `sync-context.tsx` sets `isConnected` back to true with nothing connected. Android holds a screen wake lock, which the system drops when the app leaves the screen, so the hook asks again on each return. iOS turns off the idle timer through the app-local `KeepAwake` plugin, and every mount writes the current choice so a reloaded page clears what the last one set. The setting renders, and the hook acts, only where `canKeepScreenAwake` holds: the iOS app, or the Android app on a WebView that exposes `navigator.wakeLock`. The hosted mobile page never keeps the screen on.
- Notification commands and initial session tabs in VS Code use the shared session opener, so a `/btw` fork opens its parent and expands the panel mounted in the shared composer. Notification commands also reveal the chat view.

## Decisions

### Why a visited extension tab keeps its frame and not a fresh load per visit

The drawer keeps every visited pane mounted while hidden, and the desktop rail keeps a panel frame it has shown; an extension tab does the same, so its page keeps its place, a half-filled form and an item it was handed across tab switches and a closed drawer. The memory is one frame per extension the user opened in this run, and a frame unmounts when its extension leaves the catalog. A live screen's picture mounts only while its tab is on screen, so an unwatched surface keeps no socket open.

### Why mobile proxy headers bind to an address and not every transport

A saved device can have LAN addresses and a relay route that do not pass through the user's proxy. Binding headers to the entered address prevents proxy credentials from reaching those alternatives after a reconnect or candidate refresh.

### Why secure header writes use new references and not in-place replacement

The secure store and localStorage cannot commit together. A new reference lets a failed metadata write preserve the previous credentials without a compensating secret write that could also fail.

### Why navigation carries intent and not the source's stores

Each webview owns its own stores. A small parsed request preserves the originating Settings directory, page links, provider-connect action and new-snippet action without transferring chat state or overwriting the tab's independently edited settings.

### Why mobile web holds one back guard and not one history entry per layer

Popups, overlay sheets and the Settings stages open and close without passing through the shell, so entries per layer would drift from what is on screen, and each layer closed through the UI would leave an empty Back press. One entry on top of the stack needs only one fact, whether anything can be closed, and `popstate` from it can only be Back, which is how Forward stays out of the ladder. The cost is the browser's own rule for `pushState`: arming the guard drops any Forward entries, so opening a layer after going Back ends the way back to the later route.

### Why one panel at a time and not a full-cover workspace drawer on an unfolded foldable

An unfolded iPhone Duo is 951 px wide: one 320 to 380 px panel leaves a readable chat, two do not. The full-cover drawer hid the chat and the sidebar on a screen that has room for one of them beside it, so the panels swap instead, and the displaced one returns when the other closes. Tablets under 900 px (an iPad mini, Air or 11-inch Pro in portrait) would leave the chat under ~510 px with a panel open, so they keep the drawer.

### Why mobile listens for the dialog flag and not a mobile branch at every entry point

About twenty shared entry points open Settings through `setSettingsDialogOpen`. The phone renders no dialog, so each one did nothing there and left the flag set, which blocks chat shortcuts. One bridge in the shell covers every entry point, the same way the VS Code bridge does.

### Why Android uses the Screen Wake Lock API and iOS a native plugin

The Android WebView grants `navigator.wakeLock` without a tap, and the lock shows up as the app's own screen wake lock in `dumpsys power`, so Android needs no native code. WKWebView grants it only inside a tap: Capacitor's web view answers WebKit's permission query with "prompt", so a request made when a run starts or after a relaunch is denied. iOS therefore sets `UIApplication.isIdleTimerDisabled` through `KeepAwake.swift`. An Android WebView without the API gets no setting, so nothing claims to keep the screen on there.

"While working" follows the session's own run and its subagents. Waits on a pull request, an extension or a background command keep a turn open for hours with nothing new on screen, so they do not hold the display.

### Why mobile uses the Projects page and not a separate defaults form

The shared page already supports project selection through mobile split-page navigation. Reusing it keeps the defaults controls, search anchors and persistence in one place.
