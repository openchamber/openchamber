# Mobile

## Dev-server preview

The phone workspace's Preview tab reuses the shared display-only iframe browser.
On Capacitor, a loopback dev-server URL is resolved to an app-owned TCP listener
bound to 127.0.0.1. Each accepted TCP connection is carried by the trusted
renderer over the authenticated `/api/dev-tunnel` WebSocket, including through
the current E2EE relay. Neither native platform rewrites page content or
headers, so absolute paths, cookies and HMR WebSockets use the preview's own
origin. The server limits destinations to the discovery allowlist.

The Android `MobileDevTunnelPlugin` uses a loopback ServerSocket; iOS uses a
loopback Network.framework NWListener. The JS bridge owns remote authentication,
transport and cleanup when a runtime changes. Native reads are credited by
the JS receiver and JS-to-native writes are bounded. Connections and listeners
close when the other end closes or the active server changes.

The preview lives in a positioned, clipped pane below the mobile workspace tab
strip. Its Home action returns to discovered servers without closing the workspace;
the first Back action returns from the initial page to discovery, and Android
system Back follows page history before closing the workspace. Switching tabs
keeps a loaded page mounted.

Hosted web and the VS Code webview still cannot open a dev server on a remote
machine's loopback. Mobile annotation and agent-side page control remain
desktop-only; the phone preview is display-only.

# Checking push handling without a device

What the shells do with a push (sealed text, clearing handled notifications, see the server's `packages/web/server/lib/notifications/DOCUMENTATION.md`) can be checked locally, within limits:

- **iOS Simulator.** `xcrun simctl push <udid> com.openchamber.app payload.json` delivers visible pushes, but it refuses a background push ("no user visible content") and does not run the notification service extension. Call the background handler through lldb instead: `[(id)[[UIApplication sharedApplication] delegate] application:... didReceiveRemoteNotification:@{...} fetchCompletionHandler:^(unsigned long r){}]`, and read `getDeliveredNotificationsWithCompletionHandler:` the same way. A simulator build has no `aps-environment`, so the push plugin's own calls fail; the notification permission prompt comes from `PushNotifications.requestPermissions()` evaluated in the WebView. The extension's path needs a device.
- **Android emulator.** `am startservice` cannot hand a message to the messaging service: Firebase takes messages from its own queue, which only Google Play services fills. A temporary `Instrumentation` class (declared in the manifest, run with `am instrument -w`) can build a `RemoteMessage` from a `Bundle` and call `onMessageReceived` on the service in the app's process. `notify` and `cancel` reach the system asynchronously, so wait before reading `getActiveNotifications()`. A debug build cannot replace an installed release build; use a separate AVD.

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
