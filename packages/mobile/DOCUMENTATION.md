# Mobile

## Product non-goals

- The in-app browser panel and agent browser control stay on desktop and web.
  They are not coming to the phone app or the hosted mobile surface, so mobile
  parity is no reason to shape a browser feature, and browser work needs no
  mobile plan.

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
