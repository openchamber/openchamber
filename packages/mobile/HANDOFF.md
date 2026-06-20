# OpenChamber Mobile Handoff

This handoff summarizes the mobile app work completed in this worktree and the current local machine state for continuing native iOS/Android iteration.

## What Is In Place

- `packages/mobile` is now a Capacitor workspace package.
- The mobile package packages the existing hosted mobile web entry, not the desktop app root.
- `packages/mobile/scripts/prepare-web-assets.mjs` copies `packages/web/dist` into `packages/mobile/dist` and rewrites `mobile.html` to `index.html`, so Capacitor launches `MobileApp` directly.
- Native Capacitor projects have been generated under:
  - `packages/mobile/ios`
  - `packages/mobile/android`
- Generated native ignores exclude copied web assets, Pods, Gradle outputs, APKs, and local SDK paths.
- Root package scripts expose mobile build/sync/simulator commands.

## Key Commands

From the repo root:

```sh
bun run mobile:build
bun run mobile:sync
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
```

iOS simulator helpers:

```sh
bun run mobile:sim:boot
bun run mobile:sim:install
bun run mobile:sim:launch
bun run mobile:sim:run
bun run mobile:sim:serve
bun run mobile:sim:list
bun run mobile:sim:kill
```

`packages/mobile/scripts/with-mobile-env.mjs` sets local defaults for:

- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
- `JAVA_HOME=/opt/homebrew/opt/openjdk@21`
- `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`
- `ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools`

Override these env vars if continuing on another machine.

## Local Machine Tooling State

The Mac has:

- Xcode 26.5 at `/Applications/Xcode.app`.
- Homebrew installed.
- `openjdk@17` installed.
- `openjdk@21` installed and used for Android Gradle builds.
- CocoaPods installed.
- Android command-line tools installed at `/opt/homebrew/share/android-commandlinetools`.
- Android SDK licenses accepted.
- Android SDK packages installed: `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`; Gradle also installed `build-tools;34.0.0` during build.

System `xcode-select` still points at Command Line Tools. The project scripts avoid this by setting `DEVELOPER_DIR` for mobile commands.

## Verified Builds

These commands were verified successfully:

```sh
bun run mobile:sync
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
bun run type-check:mobile
bun run lint:mobile
```

Known build warnings are inherited from the web build: KaTeX font URL resolution warnings, `onnxruntime-web` eval warning, dynamic/static import chunk warnings, and large chunk warnings. They did not fail the build.

## serve-sim Status

`serve-sim` was cloned locally to:

```txt
/Users/btriapitsyn/projects/serve-sim
```

`serve-sim` was added as a dev dependency of `packages/mobile` and is currently at npm latest verified during the session:

```txt
0.1.43
```

OpenChamber-specific agent guidance was added at:

```txt
.agents/skills/serve-sim/SKILL.md
```

`AGENTS.md` now maps iOS Simulator / `serve-sim` work to that skill.

The simulator preview was tested with:

```sh
bun run mobile:sim:run
serve-sim --host 0.0.0.0 -p 3200
```

The app launched in the iOS Simulator and raw MJPEG stream produced bytes from:

```txt
http://127.0.0.1:3100/stream.mjpeg
```

However, the browser preview UI on the phone showed:

```txt
Stream is not producing frames. The simulator may have stopped — try reconnecting.
```

After testing, all `serve-sim` helper/preview processes were stopped with `bun run mobile:sim:kill` and direct port checks confirmed `127.0.0.1:3100` and `127.0.0.1:3200` were no longer serving.

Likely follow-up: investigate `serve-sim` preview behavior on macOS 27 beta / Xcode 26.5. The raw stream working suggests the issue may be preview UI reconnect/state handling or beta OS compatibility rather than app build/install.

## Simulator Device Note

The available iOS simulator set is iOS 26.5. The default simulator helper uses:

```txt
iPhone 17 Pro
```

The earlier default `iPhone 16 Pro` was not available on this machine.

## Product/Architecture State

This work does not implement mobile pairing/auth, push notifications, secure storage, biometrics, deep links, or native lifecycle handling yet. It only prepares the native packaging and local simulator workflow around the already-existing `MobileApp` web surface.

Next useful product step after simulator streaming is stable:

- Add a first-class mobile connection/pairing screen.
- Define the remote packaged-client auth token model.
- Add native lifecycle/back-button/status-bar/keyboard handling.
- Keep inspecting the mobile import graph and bundle size; current mobile graph still includes heavy shared chunks.
