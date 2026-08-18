---
name: serve-sim
description: Use when working with the OpenChamber iOS Simulator app without opening Xcode - boot/install/launch the Capacitor iOS app, start a browser stream, tap/type/gesture/rotate, inspect accessibility, or hand a simulator URL to the user.
---

# serve-sim

Use `serve-sim` to stream and control a booted Apple Simulator from the terminal. It captures the simulator framebuffer, serves a browser preview, and exposes CLI controls for taps, typing, gestures, hardware buttons, rotation, memory warnings, permissions, camera injection, and accessibility inspection.

## Scripted Workflow

Run the discrete scripts from the repository root so each step has an observable completion boundary:

1. Build the simulator app:
   ```sh
   bun run mobile:build:ios:simulator
   ```

2. Boot if needed, install, and launch:
   ```sh
   bun run mobile:sim:run
   ```

3. Start the detached browser stream:
   ```sh
   bun run mobile:sim:serve
   ```
   Surface the returned JSON `url`; it is the only authoritative stream address.

4. Stop helpers when finished unless the user asks to keep them running:
   ```sh
   bun run mobile:sim:kill
   ```

Completion means the app launched, the returned stream URL was surfaced, requested interactions were verified, and helpers were stopped or intentionally left running.

## Manual Controls

- Tap normalized coordinates: `bunx serve-sim tap 0.5 0.5`
- Type focused text: `bunx serve-sim type "hello"`
- Hardware home: `bunx serve-sim button home`
- Rotate: `bunx serve-sim rotate portrait`
- List streams: `bunx serve-sim --list -q`
- Accessibility tree: `curl http://localhost:3100/ax`

Run direct CLI commands from `packages/mobile` (the binary lives in that package; plain `serve-sim` inside `with-mobile-env.mjs` from elsewhere fails with command not found).

Coordinates are normalized `0..1`, not pixels. Prefer `tap` for simple taps; do not emulate taps using separate `gesture` begin/end commands because that can register as long press.

## Preconditions

- macOS host.
- Xcode installed; use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if `xcode-select` points at CommandLineTools.
- Node 18+.
- At least one simulator can be booted with `xcrun simctl`.

Use the scripts above instead of opening Xcode for build/install/launch. Consume JSON output rather than parsing human output. If accessibility lookup cannot identify a target, report the missing target instead of guessing coordinates.
