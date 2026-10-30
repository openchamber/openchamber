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

Browser WebSockets cannot attach proxy headers. OkHttp on Android and URLSessionWebSocketTask on iOS can send them without adding a local proxy server or changing feature callers. OkHttp 5.3.2 supports the app's Android compile SDK 35; newer 5.5 releases require SDK 37.

### Why SSE stays in fetch and not a native stream plugin

The existing fetch reader supports headers, streaming and cancellation. It also preserves the event pipeline's reconnect behavior. The proxy must permit browser CORS preflight requests.
