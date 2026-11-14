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
- Capacitor config: `capacitor.config.json`. It is JSON because the Capacitor CLI reads a
  `capacitor.config.ts` through the TypeScript JS API (`transpileModule`), which TypeScript 7 no
  longer ships. Why its values are what they are:
  - `android.allowMixedContent: true`: the Android WebView serves the app from an `https://`
    origin, so fetch and WebSocket calls to plain-http LAN servers (`http://192.168.x.x`) are
    blocked as mixed content even with cleartext allowed in the manifest. LAN transport is a core
    feature; iOS (`capacitor://`) has no such issue, and relay and tunnel traffic is TLS anyway.
  - Keyboard `resize: 'none'`: the WebView keeps its full height and the UI follows the keyboard
    itself from `keyboardWillShow` (`apps/mobileNativeChrome.ts`): layouts take the keyboard once,
    where the change is invisible, and what sits above it rides it on a compositor transform
    (performance-engineering skill, `references/ios-webkit.md`). The built-in `native` resize
    lands only after the keyboard animation ends, which looked like a ~1.5s lag.
  - StatusBar `overlaysWebView: true`.
  - PushNotifications `presentationOptions: []`: iOS never shows an alert while the app is in
    the foreground. The server always sends (no racy visibility gate); background pushes show as
    usual.
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
- **QR pairing** — `@capacitor-mlkit/barcode-scanning`. Android uses the CameraX-backed
  `startScan()` flow with the barcode model bundled in the app, so scanning works offline and
  without Google Play Services. iOS uses the plugin's native scanner. CAMERA permission +
  `NSCameraUsageDescription` declared.
- **Secure storage** — `@aparajita/capacitor-secure-storage` for connection tokens.
- **Deep links** — `openchamber://` URL scheme; a reusable intent vocabulary (`apps/deepLinks.ts`)
  used by notification taps, widgets, and Control Center. Cold-launch intents are stashed.
- **Share intake (text, links, files)** — iOS: the `OpenChamberShare` extension accepts text, links, files, images and movies from the share sheet, stages them in the App Group inbox and opens the app. Android: `ACTION_SEND`/`ACTION_SEND_MULTIPLE` start `MainActivity`, which reads the intent off the UI thread (`SharedIntentReader`) into `SharedPayloadStore`; a share that arrives while the app runs goes through `onNewIntent`. The app's `SharedFiles` plugin hands the payload to the page, which opens a new session draft with the files attached and unsent and the text typed into the composer. More than eight files, a file over 24 MB, a batch over 32 MB, or a file the provider cannot open is reported by name instead of attached. Text or a link shared on its own is not an attachment: a provider that carries only text or a URL becomes composer text, and a provider that offers both is read as its link so a shared article arrives as one line.
- **Native tests** — `OpenChamberShareTests` (a unit-test target with no host app) runs the real
  `FileManager`/`NSItemProvider` paths of `Shared/ShareInbox.swift` and `Shared/ShareStaging.swift`
  in the simulator: the copy inside the load callback, the manifest round-trip, the three
  limits, the take-once claim. `xcodebuild test -project ios/App/App.xcodeproj -scheme
  OpenChamberShareTests -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO`.
  The tests pass a temporary container instead of the App Group, because the test runner has no
  entitlement for it.
- **Android device tests** — `SharedIntentReaderTest` runs on an emulator (`./gradlew
  :app:connectedDebugAndroidTest`): the reader is handed intents shaped the way another app builds
  one, and a real provider serves the `content://` URI — a display name, a declared size or none,
  a MIME type and the bytes, from a file or a pipe. It covers text, text with a file, file order,
  the eight-file cap, a 26 MB stream refused before it is stored, an empty file, and that the
  package manager really lists the app for `SEND` and `SEND_MULTIPLE`. The fixture provider lives
  in `app/src/debug` with a debug-only manifest entry, so no release APK carries it.
- **Share-sheet end-to-end** — `OpenChamberShareUITests` drives the real panel (Photos → share →
  OpenChamber) and then asserts the app came forward and the draft carries an image attachment,
  with screenshots attached to the result bundle. It needs a server
  (`node packages/web/bin/cli.js serve --foreground --port 4123 --host 127.0.0.1`) and a photo in
  the simulator (`xcrun simctl addmedia <udid> photo.png`). It must run against the MLKit-less
  simulator Pods, so build once with `IOS_SIM_BUILD_KEEP_PODS=1 bun run
  mobile:build:ios:simulator`, then `xcodebuild test -workspace ios/App/App.xcworkspace -scheme
  OpenChamberE2E -destination 'id=<udid>' CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`.
  **The ad-hoc identity is required**: without it nothing is signed, no entitlements are embedded,
  `containerURL(forSecurityApplicationGroupIdentifier:)` returns nil, and the extension refuses the
  file before staging it (`[ShareInbox] failed`). No developer account or provisioning profile is
  involved; the simulator does not verify entitlements, it only needs them present. `codesign -d
  --entitlements - App.app` and `simctl get_app_container <udid> com.openchamber.app groups` are the
  two commands that tell whether the hand-off can work at all.
- **Push notifications** — iOS APNs + Android FCM (see below). Presence-aware routing suppresses a
  device's push when an interactive (desktop/web) client is visible.
- **iOS widgets + Control Center + Notification Service Extension** — WidgetKit extension
  (`OpenChamberWidget`), a Control Center control, and an NSE (`OpenChamberNotificationService`)
  that refreshes widgets from push. All share the App Group `group.com.openchamber.app`.
- **Native chrome** — status bar (iOS overlay + safe-area; Android inset + themed background),
  keyboard handling (iOS CSS inset; Android native `adjustResize`), edge-swipe session switch,
  back-button handling, app-icon badge.
- **App icons** — iOS `AppIcon`; Android adaptive and themed launcher icon; notification small icon
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

- Extensions: `OpenChamberWidget` (WidgetKit, deployment 17.0), `OpenChamberNotificationService`
  (NSE, 15.5) and `OpenChamberShare` (share services, 15.5), all hand-wired into
  `App.xcodeproj/project.pbxproj` and embedded via a copy phase.
- App Group `group.com.openchamber.app` in all four targets' entitlements (app + widget + NSE +
  share extension).
- `Info.plist`: `CFBundleURLTypes` scheme `openchamber`, `NSCameraUsageDescription`.
- Push entitlement (aps-environment) required.
- APNs `mutable-content: 1` (set server/relay side) wakes the NSE to refresh widgets.

### Android (`android/app`)

- `google-services.json` (committed; Firebase project `openchamber-8bf7e`). The Google Services
  Gradle plugin is applied conditionally when the file exists; `@capacitor/push-notifications`
  brings `firebase-messaging`.
- Manifest: permissions `INTERNET`, `CAMERA` (+ optional camera feature), `POST_NOTIFICATIONS`
  (Android 13+; older versions allow notifications by default). `windowSoftInputMode=adjustResize`.
  `MainActivity` also declares `ACTION_SEND` and `ACTION_SEND_MULTIPLE` with `mimeType="*/*"`, so
  the app appears in the system share sheet for any type; the page's attachment rules decide what
  can actually be attached. FCM `default_notification_icon=@drawable/ic_stat_notify`.
- Adaptive and themed launcher icon: full-bleed color background + `ic_launcher_foreground`, plus the
  `<monochrome>` layer (`ic_launcher_monochrome.png`). All of them, and `assets/icon-*.png`, are written
  by `bun run brand:generate` (`scripts/brand`); `@capacitor/assets` would rewrite `ic_launcher.xml`
  without the monochrome layer, so do not use it for icons.

## Quirks / gotchas

- **iOS Simulator + MLKit**: `GoogleMLKit` barcode has no arm64-simulator slice, so
  `scripts/ios-sim-build.mjs` temporarily strips the `CapacitorMlkitBarcodeScanning` pod, builds,
  then restores it. Device builds include it normally.
- **Android WebView version**: the UI uses `color-mix()` (Tailwind v4 + theme) which needs
  Chromium **111+**. An outdated Android System WebView renders translucency/selection wrong — tell
  testers to keep Android System WebView updated (or use a device with a current one).
- **Android top inset comes from one place per OS version.** On Android 14 and older,
  `StatusBar.setOverlaysWebView({ overlay: false })` moves the WebView below the status bar, yet
  Capacitor still injects the bar height as `--safe-area-inset-top` once the WebView is 140 or
  newer. Once that call succeeds on those versions (reported by the app-local `WindowLayout`
  plugin; the WebView user agent is unreliable because GrapheneOS's Vanadium always says
  `Android 10`), `useNativeMobileChrome` adds `oc-android-below-status-bar` and `mobile.css` zeroes that inset; Android 15+
  is edge-to-edge and keeps the injected value. Without it the app showed an empty strip under
  the status bar (#4803). The Android 14 emulator image ships WebView 113, so reproducing it
  needs a newer `com.android.webview` installed and selected.
- **Capacitor stream transport is locked to SSE** on the native apps (native WebSocket streaming is
  unreliable on Android). The Chat transport setting shows SSE selected and disables the others in
  the Capacitor shell.
- **Android push needs the app rebuilt with `google-services.json`**; without it `register()` used
  to crash ("Default FirebaseApp is not initialized"). Registration is gated to iOS/Android natives.
- **User scripts go in `capacitorDidLoad()`.** Capacitor replaces the `userContentController` after
  `webViewConfiguration(for:)`, silently dropping scripts added there (`BridgeViewController` in
  `AppDelegate.swift`).
- **A shared item lands one commit later than its draft.** `newSessionDraft.draftId` reaches the
  store before the chat column shows the draft: `ChatInput`'s `currentSessionId` comes from
  `chatColumnSession` and trails by a frame. Anything a native share hands to the draft (files and
  text alike, `pendingDraftContent`) must wait until `currentSessionId` is null, otherwise it is
  filed under the session the user is leaving, and the draft's own restore — an empty draft — wipes
  it when the column switches. Symptom: the share opens a new session with nothing in it, but only
  when the share started from an existing session. Confirmed on device with a 43 ms gap between the
  two store updates.
- **A share extension cannot reliably open its host app.** `UIApplication.shared` is unavailable
  there and `extensionContext.open` only works for the Today extension point, so
  `ShareViewController` tries `extensionContext.open` first and then walks the responder chain
  for a `UIApplication` (the same fallback AFFiNE and others ship). On the simulator with ad-hoc
  signing the app does come forward, but do not rely on it on a device: when both fail the staged
  file stays in the App Group inbox and the plugin takes it the next time the app becomes active.
- **`embedded.mobileprovision` decodes as `.isoLatin1`.** It is a binary CMS envelope around a plist;
  `.ascii`/`.utf8` return nil and the APNs environment silently falls back. APNs delivery is grouped
  per token by the environment it registered with (Xcode build → sandbox, TestFlight/App Store →
  production); `OPENCHAMBER_APNS_ENVIRONMENT` is only a global override. For "no push on the phone",
  check `~/.config/openchamber/apns-tokens.json` and remember the phone talks to the installed
  desktop app's server, which runs its own (possibly older) code.
- **Native HTTP always sends the WebView's cookies**, whatever `credentials` says, so a leftover
  `oc_ui_session` rides along with every request. That is why `/auth/session` lets an explicit
  `Authorization: Bearer` decide alone: a revoked bearer must answer 401 even with a valid cookie.
  curl never reproduces this; an on-screen log of the cold-start decisions on the device did.
- **Touch-target floors in `mobile.css` beat Tailwind sizes.** `button`, `[role=button]` and inputs
  get `min-height: 36px` under `:root.mobile-pointer:not(.desktop-runtime)`, more specific than any
  utility. Size mobile rows with an explicit `h-*` (`h-9` is exactly the floor); go below it only with
  an inline `minHeight: 0`.
- **A custom Control Center icon** must be a custom SF Symbol (`swiftdraw --format sfsymbol`, default
  Small variants) built from an SVG that keeps its `transform` attributes, drawn with bold strokes,
  referenced as `Label("…", image: "OCLogoSymbol")`. `bun run brand:generate` builds `OCLogoSymbol` this
  way on a Mac with `swiftdraw` (`brew install swiftdraw`). Control Center caches icons system-wide:
  after changing one, reboot the device.

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

- Apple Developer account; App IDs for the app **and** all three extensions
  (`com.openchamber.app`, `.OpenChamberWidget`, `.OpenChamberNotificationService`,
  `.OpenChamberShare`), each enabled for the **App Group** and (app) **Push**.
- Signing certificate + provisioning profiles for all four targets (extensions need their own).
  `mobile-release.yml` installs them as `IOS_APP_PROFILE_*`, `IOS_WIDGET_PROFILE_*`,
  `IOS_NSE_PROFILE_*` and `IOS_SHARE_PROFILE_*` (`_BASE64` + `_NAME` pairs); the archive fails
  when one target's profile is missing.
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
