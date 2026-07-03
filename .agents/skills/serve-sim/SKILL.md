---
name: serve-sim
description: Use when working with the OpenChamber iOS Simulator app without opening Xcode - boot/install/launch the Capacitor iOS app, start a browser stream, tap/type/gesture/rotate, inspect accessibility, or hand a simulator URL to the user.
---

# serve-sim

Use `serve-sim` to stream and control a booted Apple Simulator from the terminal. It captures the simulator framebuffer, serves a browser preview, and exposes CLI controls for taps, typing, gestures, hardware buttons, rotation, memory warnings, permissions, camera injection, and accessibility inspection.

## OpenChamber Defaults

- Mobile package: `packages/mobile`
- iOS bundle id: `com.openchamber.app`
- Headless env wrapper: `packages/mobile/scripts/with-mobile-env.mjs`
- iOS simulator helper: `packages/mobile/scripts/ios-sim.mjs`
- Preferred scripts:
  - `bun run mobile:build:ios:simulator`
  - `bun run mobile:sim:run`
  - `bun run mobile:sim:serve`
  - `bun run mobile:sim:list`
  - `bun run mobile:sim:kill`

## Workflow

1. Build the simulator app without opening Xcode:
   ```sh
   bun run mobile:build:ios:simulator
   ```

2. Boot a simulator if needed, install, and launch the app:
   ```sh
   bun run mobile:sim:run
   ```

3. Start the browser stream in detached JSON mode:
   ```sh
   bun run mobile:sim:serve
   ```
   Surface the returned `url` to the user. It normally starts at `http://localhost:3200`.

4. Stop helpers when finished unless the user asks to keep them running:
   ```sh
   bun run mobile:sim:kill
   ```

## Direct CLI Controls

- Tap normalized coordinates: `bunx serve-sim tap 0.5 0.5`
- Type focused text: `bunx serve-sim type "hello"`
- Hardware home: `bunx serve-sim button home`
- Rotate: `bunx serve-sim rotate portrait`
- List streams: `bunx serve-sim --list -q`
- Accessibility tree: `curl http://localhost:3100/ax`

Coordinates are normalized `0..1`, not pixels. Prefer `tap` for simple taps; do not emulate taps using separate `gesture` begin/end commands because that can register as long press.

## Preconditions

- macOS host.
- Xcode installed; use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` if `xcode-select` points at CommandLineTools.
- Node 18+.
- At least one simulator can be booted with `xcrun simctl`.

## Anti-Patterns

- Do not open Xcode just to build/install/launch during agent work; use the scripts above.
- Do not parse human output from `serve-sim`; use `-q` for JSON.
- Do not leave helper streams running unintentionally.
- Do not guess coordinates after accessibility lookup fails; report the missing target instead.
