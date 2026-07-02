# OpenChamber Mobile Handoff

Status and process reference for the native iOS/Android apps. Written so work can continue after
merge — either by finishing CI/release automation, or by adding features as follow-up fixes. The
apps are feature-complete for a first public/TestFlight-style test; CI/signing is the main gap.

## What this package is

`packages/mobile` is a Capacitor workspace that wraps the **hosted mobile web UI** (the `MobileApp`
renderer), not the desktop shell. The native app is a WKWebView (iOS) / Android WebView loading a
bundled copy of the web build; native capabilities are added via Capacitor plugins and two iOS app
extensions.

- App id / package: `com.openchamber.app`; app name `OpenChamber`.
- Capacitor config: `capacitor.config.ts` (Keyboard `resize: 'none'`, StatusBar overlay, Push
  `presentationOptions: []`).
- Renderer: the web build's `mobile.html` entry (`MobileApp`), copied into `dist/` and served by
  Capacitor. Mobile-only surfaces (connection onboarding, `Instances`, QR pairing, widgets) exist
  only in the Capacitor shell — hosted `mobile.html` in a plain browser does not expose them.

## Build pipeline (how a native build is produced)

```
bun run --cwd packages/web build          # web/dist
  → scripts/prepare-web-assets.mjs         # copy web/dist → mobile/dist, mobile.html → index.html
    → cap sync                             # copy dist → native, sync plugins/config
      → xcodebuild / gradle assembleDebug  # native binary
```

`sync` (in `packages/mobile/package.json`) runs `bun run build && cap sync` inside the mobile env
wrapper. Everything native-facing goes through `scripts/with-mobile-env.mjs`.

### `with-mobile-env.mjs` (toolchain wrapper — read this before debugging build env issues)

Every build/deploy script runs through it. It sets, with env overrides honored first:

- `DEVELOPER_DIR` — `$DEVELOPER_DIR` → `xcode-select -p` → `/Applications/Xcode.app/...`. It
  intentionally honors `xcode-select` so an Xcode beta / non-default install is used (hardcoding
  the path previously forced builds onto the wrong Xcode / Command Line Tools).
- `JAVA_HOME` — `$JAVA_HOME` → `/opt/homebrew/opt/openjdk@21`.
- `ANDROID_HOME` / `ANDROID_SDK_ROOT` — `$ANDROID_HOME` → `/opt/homebrew/share/android-commandlinetools`.
- `PATH` — prepends `$JAVA_HOME/bin` and `$ANDROID_HOME/platform-tools` (so `adb` resolves).

On another machine, override these env vars rather than editing the script. `xcode-select` may
point at Command Line Tools; the wrapper's `DEVELOPER_DIR` handling covers that for mobile commands.

## Commands

Root aliases (from repo root):

```sh
bun run mobile:build                 # web build + prepare-web-assets
bun run mobile:sync                  # build + cap sync
bun run mobile:build:android:debug   # sync + gradle assembleDebug
bun run mobile:build:ios:simulator   # simulator build (strips MLKit pod, see quirks)
bun run mobile:open:ios              # open in Xcode
bun run mobile:open:android          # open in Android Studio
bun run type-check:mobile
bun run lint:mobile
```

Android physical-device deploy (adb-based, in `scripts/android-device.mjs`) — **not aliased at
root**, run from the package:

```sh
bun run --cwd packages/mobile android:devices   # list adb devices (want `device`, not `unauthorized`)
bun run --cwd packages/mobile android:install    # adb install -r the debug APK
bun run --cwd packages/mobile android:launch     # am start MainActivity
bun run --cwd packages/mobile android:run         # install + launch
bun run --cwd packages/mobile android:logcat      # app logs
```

Typical device iteration: `bun run --cwd packages/mobile build:android:debug` then
`android:run`. APK path: `android/app/build/outputs/apk/debug/app-debug.apk`.

iOS Simulator helpers: `mobile:sim:{boot,install,launch,run,serve,list,kill}` (see
`scripts/ios-sim.mjs`; `serve-sim` for a browser preview of the simulator).

## Native capabilities implemented

- **Connection onboarding** — server URL entry, password unlock for locked servers, client-token
  issuance, saved connections, `Instances` management sheet, auto-connect to the last instance on
  launch. Deleting the active instance resets the runtime to the connect screen.
- **QR pairing** — `@capacitor-mlkit/barcode-scanning`. Android's Google code scanner module is
  downloaded on first scan (needs Play Services + network); `mobileQrScan.ts` installs/awaits it
  and retries. CAMERA permission + `NSCameraUsageDescription` declared.
- **Secure storage** — `@aparajita/capacitor-secure-storage` for connection tokens.
- **Deep links** — `openchamber://` URL scheme; a reusable intent vocabulary (`apps/deepLinks.ts`)
  used by notification taps, widgets, and Control Center. Cold-launch intents are stashed.
- **Push notifications** — iOS APNs + Android FCM (see below). Presence-aware routing suppresses a
  device's push when an interactive (desktop/web) client is visible.
- **iOS widgets + Control Center + Notification Service Extension** — WidgetKit extension
  (`OpenChamberWidget`), a Control Center control, and an NSE (`OpenChamberNotificationService`)
  that refreshes widgets from push. All share the App Group `group.com.openchamber.app`.
- **Native chrome** — status bar (iOS overlay + safe-area; Android inset + themed background),
  keyboard handling (iOS CSS inset; Android native `adjustResize`), edge-swipe session switch,
  back-button handling, app-icon badge.
- **App icons** — iOS `AppIcon`; Android adaptive launcher icon; notification small icon
  (`ic_stat_notify`).

## Push / notifications architecture

- Registration: on launch the app registers a device token — **iOS → APNs, Android → FCM** — and
  sends it to the connected server tagged with `platform` (`ios`/`android`).
- The server forwards notification-worthy events to a signed **relay**; the relay routes each token
  to APNs or FCM by its bound platform. The app itself only needs to obtain and register the token.
- **Presence-aware suppression**: each client reports foreground visibility + its platform; a
  mobile push is skipped while an interactive (desktop/web/vscode) client is visible (it already
  shows the in-app notification). Gated on the desktop's visibility, never the phone's own.
- Foreground behavior: iOS suppresses the banner via `presentationOptions: []`; the web/PWA service
  worker suppresses when a window is focused.

## Platform config specifics

### iOS (`ios/App`)

- Extensions: `OpenChamberWidget` (WidgetKit, deployment 17.0) and `OpenChamberNotificationService`
  (NSE, 15.5), both hand-wired into `App.xcodeproj/project.pbxproj` and embedded via a copy phase.
- App Group `group.com.openchamber.app` in all three targets' entitlements (app + widget + NSE).
- `Info.plist`: `CFBundleURLTypes` scheme `openchamber`, `NSCameraUsageDescription`.
- Push entitlement (aps-environment) required.
- APNs `mutable-content: 1` (set server/relay side) wakes the NSE to refresh widgets.

### Android (`android/app`)

- `google-services.json` (committed; Firebase project `openchamber-8bf7e`). The Google Services
  Gradle plugin is applied conditionally when the file exists; `@capacitor/push-notifications`
  brings `firebase-messaging`.
- Manifest: permissions `INTERNET`, `CAMERA` (+ optional camera feature), `POST_NOTIFICATIONS`
  (Android 13+; older versions allow notifications by default). `windowSoftInputMode=adjustResize`.
  ML Kit `com.google.mlkit.vision.DEPENDENCIES=barcode_ui` meta (preloads the code scanner). FCM
  `default_notification_icon=@drawable/ic_stat_notify`.
- Adaptive launcher icon: full-bleed color background + `ic_launcher_foreground` (sources under
  `packages/mobile/assets/`, regenerable with `@capacitor/assets`).

## Quirks / gotchas

- **iOS Simulator + MLKit**: `GoogleMLKit` barcode has no arm64-simulator slice, so
  `scripts/ios-sim-build.mjs` temporarily strips the `CapacitorMlkitBarcodeScanning` pod, builds,
  then restores it. Device builds include it normally.
- **Android WebView version**: the UI uses `color-mix()` (Tailwind v4 + theme) which needs
  Chromium **111+**. An outdated Android System WebView renders translucency/selection wrong — tell
  testers to keep Android System WebView updated (or use a device with a current one).
- **Capacitor stream transport is locked to SSE** on the native apps (native WebSocket streaming is
  unreliable on Android). The Chat transport setting shows SSE selected and disables the others in
  the Capacitor shell.
- **Android push needs the app rebuilt with `google-services.json`**; without it `register()` used
  to crash ("Default FirebaseApp is not initialized"). Registration is gated to iOS/Android natives.

## Validation

```sh
bun run type-check:mobile
bun run lint:mobile
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
```

Web-inherited build warnings (KaTeX font URLs, `onnxruntime-web` eval, chunk-size) are expected and
non-fatal.

## The gap: CI / release automation (next work)

The apps build and deploy locally; there is no CI/signing/publishing yet. To take them to
TestFlight / Play internal testing:

### iOS

- Apple Developer account; App IDs for the app **and** both extensions
  (`com.openchamber.app`, `.OpenChamberWidget`, `.OpenChamberNotificationService`), each enabled for
  the **App Group** and (app) **Push**.
- Signing certificate + provisioning profiles for all three targets (extensions need their own).
- App Store Connect API key for non-interactive TestFlight upload (`xcodebuild archive` +
  `notarytool`/`altool`, or fastlane `gym`+`pilot`).
- Runner: macOS with the same Xcode as `DEVELOPER_DIR`.

### Android

- Release keystore (kept as a CI secret); build a signed **AAB** (`bundleRelease`) — the debug
  scripts here produce an unsigned debug APK.
- Play Console app + internal testing track; a Play service account for automated upload (fastlane
  `supply` or the Play Developer API).
- `google-services.json` is committed, so FCM builds in CI without extra setup.
- Runner: Linux with the Android SDK + `openjdk@21`.

### Notes for CI

- Reuse `with-mobile-env.mjs`'s env contract (`DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`) — set
  them in the workflow instead of relying on local Homebrew paths.
- Relay/push secrets (APNs key, FCM service account) live in the relay infrastructure, not app CI.
- Version/build-number bumping is not automated yet.

## Store review readiness

Xcode build warnings do not block review; the concrete items are store requirements, not code
quality. Done in-repo vs. to-do at release time:

**Done in-repo (this branch):**

- iOS app **Privacy Manifest** (`ios/App/App/PrivacyInfo.xcprivacy`) — declares no tracking and the
  required-reason UserDefaults API (App Group snapshot). Bundled SDKs ship their own manifests.
- iOS **`ITSAppUsesNonExemptEncryption = false`** in `Info.plist` (skips the per-build export-
  compliance prompt).
- iOS camera + local-network usage strings; Android SDK levels (`target/compile 35`, `min 24`) meet
  Play's current requirements.

**To-do at release (console / infra, not code):**

- **Privacy policy URL** — required by both stores because the app uses camera + notifications.
- iOS **App Privacy nutrition label** (App Store Connect) and Android **Data Safety** form — declare
  what's collected (device push token; the app otherwise talks only to the user's own server).
- **Production APNs** for App Store / TestFlight builds: the app's `aps-environment` must be
  `production` in the release build, and the relay must send to production APNs (not sandbox).
- **Demo instance + credentials** for reviewers — the app connects to a user's server, so review
  needs a reachable test instance (App Store 2.1 / Play).
- **Guideline 4.2 (minimum functionality)** — WebView-wrapper apps can be scrutinized; cite the
  native features (push, widgets, Control Center, QR pairing) in the review notes.
- Signing/upload as covered in the CI section above (all three iOS targets; signed Android AAB).
