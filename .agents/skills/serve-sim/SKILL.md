---
name: serve-sim
description: Use when working with the OpenChamber iOS Simulator app without opening Xcode - boot/install/launch the Capacitor iOS app, start a browser stream, tap/type/gesture/rotate, inspect accessibility, or hand a simulator URL to the user.
---

# serve-sim

## Scripted Workflow

Run the discrete scripts from the repository root:

1. Build the simulator app:
   ```sh
   bun run mobile:build:ios:simulator
   ```

   The script runs `pod install` twice and can re-resolve pods, which changes `ios/App/Podfile.lock` (GoogleUtilities 8.1.4 → 8.1.5 once). Restore that file unless the change is about pods.

2. Boot if needed, install, and launch:
   ```sh
   bun run mobile:sim:run
   ```
   It needs a simulator named `iPhone 17 Pro`. A fresh Xcode has no runtime and no devices: `xcodebuild -downloadPlatform iOS`, then `xcrun simctl create "iPhone 17 Pro" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2`.

3. Start the detached browser stream:
   ```sh
   bun run mobile:sim:serve
   ```
   Surface the returned JSON `url`; it is the only authoritative stream address.

4. Stop helpers when finished unless the user asks to keep them running:
   ```sh
   bun run mobile:sim:kill
   ```

Completion means the app launched, the returned stream URL was surfaced, and requested interactions were verified.

## Manual Controls

- Tap normalized coordinates: `bunx serve-sim tap 0.5 0.5`
- Type focused text: `bunx serve-sim type "hello"`
- Hardware home: `bunx serve-sim button home`
- Rotate: `bunx serve-sim rotate portrait`
- List streams: `bunx serve-sim --list -q`
- Accessibility tree: `curl http://localhost:3100/ax`

Run direct CLI commands from `packages/mobile`. `serve-sim` is installed in that package and is absent from the root `node_modules/.bin`.

Coordinates are normalized `0..1`, not pixels. Prefer `tap` for simple taps; do not emulate taps using separate `gesture` begin/end commands because that can register as long press.

If accessibility lookup cannot identify a target, report the missing target instead of guessing coordinates.

## iPhone Duo (foldable)

- Runtime: the Duo-specific one (`xcodebuild -downloadPlatform iOS -buildVersion 27.2` gives `SimRuntime.iOS-27-2-iPhone19-4`). On the generic iOS 27.1 runtime AccessibilityUIServer crash-loops at launch and macOS shows endless crash dialogs.
- Xcode 27 has no Simulator.app; `DeviceHub.app` in `Xcode.app/Contents/Applications` replaces it.
- `bunx serve-sim fold <0..180>` sets the hinge; the stream shows the inner display. `simctl io <udid> screenshot --display=1` shoots the outer screen, `--display=3` the inner.
- `tap` and `type` reach the app only when folded. Unfolded, no touches arrive, so drive the WebView through lldb: attach to the app pid, `expr -l objc -- @import WebKit`, take the WKWebView at `[[[[[UIApplication sharedApplication] connectedScenes] anyObject] keyWindow] rootViewController] view]`, `evaluateJavaScript` a script that writes its result into `document.title`, then `po [webView title]`. The same route works on every simulator. `evaluateJavaScript` runs as a user gesture, so to see how an API behaves without a tap (`navigator.wakeLock` is refused then), make the call 12 seconds later from a timer.
- Geometry: safe-area insets top 0, right 84 (the status bar column), bottom 34; window 466×678 folded, 951×669 unfolded, which is the tablet layout (short side ≥ 600).

## Preconditions

- macOS host.
- Xcode installed; use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if `xcode-select` points at CommandLineTools.
- Node 18+.
- At least one simulator can be booted with `xcrun simctl`.
