# Mobile

## Build and device tooling

### Ownership

`scripts/` owns local native build, device launch and simulator-stream orchestration. The web package owns the web bundle; the native projects own the packaged app.

### Invariants

- The simulator build restores the original Podfile and reinstalls its pods in `finally` so device and TestFlight builds retain the barcode scanner, including after a build failure.

### Why the simulator build omits the scanner and not the device build

The scanner's ML Kit dependency lacks an arm64 simulator slice, and an x86_64-only app cannot install on arm64-only iOS 26+ simulators. Simulator QR scanning has no camera to use, and `mobileQrScan` reports scanning unsupported when the native plugin is absent, so omitting the pod preserves the available simulator functionality.

### Why Capacitor copy and not sync during simulator builds

The simulator build uses `cap copy ios` to update bundled web assets without regenerating pods before the temporary scanner exclusion.

### Why the selected Xcode and not a fixed application path

`with-mobile-env.mjs` respects `DEVELOPER_DIR`, then `xcode-select`, so beta and non-default Xcode installations keep their matching simulator runtimes. A fixed Xcode path can select an installation that cannot find the chosen simulator.

### Why the simulator loop adds the package bin directory to PATH

`ios-sim-dev.mjs` resolves the package-local `serve-sim` executable even when invoked outside `bun run`, where the package bin directory is absent from PATH.

## Dev-server preview

The workspace drawer's Browser tab (id `preview`) shows a dev server running on
the OpenChamber host. It exists only in the native app: hosted mobile cannot
reach the host's `localhost`, so there the tab is not offered, not in the strip
and not in Settings (`lib/mobileWorkspaceTabs.ts`).

- A loopback URL resolves to an app-owned TCP listener on `127.0.0.1`, one per
  remote port. Each accepted connection is carried by the renderer over the
  authenticated `/api/dev-tunnel` WebSocket, through the relay when the
  connection is a relay one. A relay runtime counts as remote whatever base URL
  it names: on the phone it is the shell's own `https://localhost`.
- Native code moves opaque bytes only (Android `MobileDevTunnelPlugin`,
  ServerSocket; iOS `MobileDevTunnel.swift`, NWListener). Nothing rewrites the
  page or its headers, so absolute paths, cookies and HMR sockets keep the
  preview's own origin. The server limits destinations to the discovery
  allowlist.
- Native reads wait for the renderer's credit, one read in flight per
  connection. When the dev server closes a connection, the bytes already queued
  for the native socket are written before it closes.
- A runtime switch stops every listener and connection, also one still being
  opened.
- A listener that dies without a stop (iOS reclaims the listening sockets of a
  suspended app) reports `stopped`; its port leaves the cache, and the next
  navigation or Reload opens a new listener. Reload in the phone preview
  resolves the address again for that reason, and so also retries a tunnel
  that failed.
- The page is opaque to the app, so its own navigations are invisible to the
  toolbar. While a page shows, the preview keeps a guard entry on top of the
  app's history (`pushPreviewFrameGuard`); the page's navigations land above
  it in the WebView's history. Back, the toolbar's and Android's, asks the
  WebView to go back: inside the page while it has history, and off the guard
  once it has none, which takes the preview's own step to the previous address
  or the server list. At the server list Android Back closes the drawer.
- The page is for viewing: annotation and agent page control stay on desktop.
- Only the app's own document reaches native plugins. WebKit exposes
  Capacitor's `bridge` message handler to every frame, so the iOS shell
  replaces it with one that drops messages from other frames
  (`MainFrameBridgeHandler`, `AppDelegate.swift`); without it a previewed page
  or an extension panel could call any plugin. Android's Capacitor accepts
  main-frame messages only through a web message listener; on a WebView
  without one it falls back to a JavaScript interface every frame can call.
  There `isolatesFrames` answers false, the Browser tab shows no pages and
  says to update the WebView, and the native listener refuses to start.
- A chat switch while the preview holds its guard writes the route over it
  (`pushRouteEntry`). Back then takes the preview's own step and skips the
  page's history, because walking back under a route entry would make the app
  apply the older route.

### Why the WebView's history and not a count of the page's navigations

A cross-origin frame reports full loads at most, never `pushState`, so a
count misses every navigation of a single-page app and over-counts a reload.
An over-count walks back into the app's own routes. The WebView's history
holds every navigation, and the guard marks where the page's part of it starts.

# Checking push handling without a device

What the shells do with a push (sealed text, clearing handled notifications, see the server's `packages/web/server/lib/notifications/DOCUMENTATION.md`) can be checked locally, within limits:

- **iOS Simulator.** `xcrun simctl push <udid> com.openchamber.app payload.json` delivers visible pushes, but it refuses a background push ("no user visible content") and does not run the notification service extension. Call the background handler through lldb instead: `[(id)[[UIApplication sharedApplication] delegate] application:... didReceiveRemoteNotification:@{...} fetchCompletionHandler:^(unsigned long r){}]`, and read `getDeliveredNotificationsWithCompletionHandler:` the same way. A simulator build has no `aps-environment`, so the push plugin's own calls fail; the notification permission prompt comes from `PushNotifications.requestPermissions()` evaluated in the WebView. The extension's path needs a device.
- **Android emulator.** `am startservice` cannot hand a message to the messaging service: Firebase takes messages from its own queue, which only Google Play services fills. A temporary `Instrumentation` class (declared in the manifest, run with `am instrument -w`) can build a `RemoteMessage` from a `Bundle` and call `onMessageReceived` on the service in the app's process. `notify` and `cancel` reach the system asynchronously, so wait before reading `getActiveNotifications()`. A debug build cannot replace an installed release build; use a separate AVD.

# Android home-screen widgets

## Ownership

`WidgetRenderer` and the two `AppWidgetProvider`s under `android/app/src/main/java/com/openchamber/app/` draw the Sessions and Usage widgets with `RemoteViews`. They read only snapshots in app-private preferences. `packages/ui/src/apps/useNativeWidgetSync.ts` writes those snapshots through the `WidgetBridge` plugin. Sessions come from `buildMobileWidgetSnapshot` (`mobileWidgetSnapshot.ts`, the snapshot the iOS widgets read too); usage comes from `createWidgetUsageSnapshot` over the quota store.

## Invariants

- The widgets never hold credentials or reach the network. Every fetch runs in the connected app; a refresh tapped on a widget is a counter in preferences that the app picks up, then acknowledges or reports failed. While the app is not connected the footer says so.
- Nothing syncs while no widget is placed (`WidgetBridge.installed`). Placing or removing one notifies the running app.
- A store that has not loaded yet is not written: an empty list before the first load would read as "No sessions yet".
- Colors come from the app's active theme and text from the app's language, both inside each snapshot; English and the default dark theme apply only until the first snapshot.
- The session row matches the iOS widget (unread mark, title, project) plus one live status from the global status channel: running, retrying or error.
- Both widgets are scrolling lists. A Usage row repeats the Usage page's window card: the app formats the value, reset text and bar tone with the page's own helpers (`lib/quota`), so the widget and the page never disagree; the native side only draws the bar.

## Decisions

### Why one layout tinted from code and not a dark and a light copy of each

Every surface is a shape recolored with `setColorFilter` and every text color is set by the renderer, so a theme change needs no new resources and the two copies cannot drift apart, as the earlier light empty state did with white text on a light background.

### Why the app pushes snapshots and not a native pull on background, as on iOS

The Sessions widget shows live activity, which changes while the app sits in the background with its WebView still running. Store subscriptions keep the widget current without polling; the iOS widgets only show unread state, which a pull on background covers.

# Native runtime WebSockets

## Ownership

The app-local `RuntimeWebSocket` plugins own header-bearing direct WebSockets on iOS and Android. Shared selection and socket lifecycle live in `packages/ui/src/lib/relay/native-websocket.ts` and `runtime-socket.ts`. Feature callers use `openRuntimeWebSocket`; SSE remains in the fetch-based event reader.

## Invariants

- Only Capacitor connections with custom headers use the native adapter. Private relay selection happens first. The target must match the active runtime origin and base path before headers cross the bridge.
- Native clients refuse redirects, use platform TLS verification and send their packaged-client Origin. Proxy headers never enter query parameters. OpenChamber authentication continues to use the resolver's short-lived URL token.
- A listener is installed before opening. Text stays text; binary frames cross the JSON bridge as base64 and reach consumers as ArrayBuffer. Sends are ordered and queued payloads are bounded at 16 MiB. Close follows accepted sends; cancellation during open cannot leave an active socket behind.
- Closing removes native socket ownership and the JS listener. Late native callbacks cannot reopen a closed socket. Native failures expose no URL or credential details.
- iOS receives messages up to 4 MiB. Terminal snapshots can expand the server's 512 KiB history sixfold through JSON escaping, so the platform's default 1 MiB limit is insufficient. The task factory sets the bound before resume.

## Decisions

### Why the socket task factory is separate from the Capacitor plugin

The Foundation-only factory lets the native regression test receive large snapshots through the production URLSession task configuration without loading a WebView or building the app. Run `node --test scripts/runtime-websocket.test.mjs` from `packages/mobile` on macOS with Swift installed. This covers Foundation receive behavior; plugin bridge delivery and device reconnect still need an app check.

### Why native sockets and not browser WebSockets

Browser WebSockets cannot attach proxy headers. OkHttp on Android and URLSessionWebSocketTask on iOS can send them without adding a local proxy server or changing feature callers. OkHttp 5.5 requires compile SDK 37, which needs Android Gradle plugin 9.5 or later; the app compiles against 37 and still targets 35.

The Android build leaves the Kotlin standard library to Gradle's resolution. A forced version applies to every configuration: a pin to 1.9 pulled OkHttp and AndroidX below the 2.x stdlib they are compiled against, and crashed AGP 9's lint.

### Why SSE stays in fetch and not a native stream plugin

The existing fetch reader supports headers, streaming and cancellation. It also preserves the event pipeline's reconnect behavior. The proxy must permit browser CORS preflight requests.

# iOS share extension

## Ownership

`ios/App/OpenChamberShare` is the share extension: it reads what another app shares and writes it into the App Group inbox (`ShareInbox.swift`, compiled into the extension and the app). The app-local `SharedFiles` plugin (`ios/App/App/SharedFiles.swift`) hands inbox shares to the page with the same contract as Android's `SharedFilesPlugin`. What happens on the page (a draft of its own, the composer's attachment policy, the refusal toast) belongs to `packages/ui` (`lib/nativeSharedFiles.ts`, composer `DOCUMENTATION.md`).

## Invariants

- The extension never sends anything anywhere and never talks to a server. It copies files with `FileManager.copyItem` from the provider's file representation, so no file is read into the extension's memory.
- Limits are Android's: eight files (items past the eighth are refused without reading them), 10 MB per file, 32 MB per share, 15 s per item and 30 s per share. Every refused item reaches the page with a name and a reason from the page's list (`too-many`, `too-large`, `batch-limit`, `unsupported-type`, `unreadable`, `timed-out`).
- A share is written under `<id>.partial` and renamed into place after its manifest is written, so the app never reads half a share. Abandoned partial shares older than ten minutes are swept when the plugin loads.
- `takePending` returns the oldest share until the page calls `accept` with its id; only then is the share deleted and its notification taken down. A share whose manifest cannot be read is deleted instead of handed over, so it cannot block the ones behind it.
- Logs carry counts and reasons only, never a file name, text or URL.

## Decisions

### Why a notification and not opening the app from the extension

iOS gives share extensions no supported way to open their app: `NSExtensionContext.open` works only for Today and iMessage extensions, and reaching `UIApplication` through the responder chain is unsupported and a review risk (Guideline 2.5.1). The extension posts a local notification ("Tap to open the draft in OpenChamber"), whose tap opens the app on the share's draft. With notifications off it shows a one-button alert, and the share waits in the inbox for the next time the app becomes active, however it is opened.

### Why a confirmation card even when the notification is posted

A Focus holds banners back without telling the extension: on a device in a Work Focus the notification was posted and SpringBoard dropped the banner ("do not disturb: 1"), so the sheet closed and nothing on screen said the share had landed. The extension shows "Saved to OpenChamber" for about a second before it closes, whatever the notification does; the notification stays in Notification Center until the page takes the share.

### Why a queue of shares and not Android's single waiting slot

On Android the system opens the app with every share, so a newer share replacing an untaken one loses nothing the user was promised. On iOS the extension has already told the user the share was saved, and several shares can pile up before the app opens. They are kept and handed over one at a time, oldest first; the share whose notification the user tapped goes last, so its draft is the one left on screen.

### Why the extension's strings live in Swift and not in strings tables

The extension shows at most a notification line or an alert, seven strings in all. A table per language would add a variant group per file to the hand-maintained Xcode project; `ShareStrings.swift` picks the phone's language with `Bundle.preferredLocalizations` and falls back to English, and the Mac test checks that every app language has every line. The page's toast follows the app's own language setting; the extension, running outside the app, follows the phone's.

### Why JPEG when Photos offers both JPEG and HEIC

Photos lists HEIC first. A shared HEIC goes through the composer's decoder, which refuses one it cannot read; the JPEG Photos also offers attaches without a conversion.

Run `node --test scripts/share-inbox.test.mjs` from `packages/mobile` on macOS for the inbox (admission, commit, order, broken shares, sweep) and the strings. Reading real providers, the notification and the plugin bridge need a simulator or device run.
