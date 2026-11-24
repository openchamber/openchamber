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
- **Share intake (text, links, files)** — Android: `ACTION_SEND`/`ACTION_SEND_MULTIPLE` start
  `MainActivity`, which reads the intent off the UI thread (`SharedIntentReader`) into
  `SharedPayloadStore`; a share that arrives while the app runs comes through `onNewIntent`.
  Every intent the activity receives is its own delivery (an id stamped on the intent), so the
  same link or photo shared twice is two shares; `SharedIntentReader.signature` identifies a
  delivery. A restored activity reads only the share it last received, under the same
  delivery, and a launch from recents reads nothing. `SharedFilesPlugin.takePending` hands a
  share over until the page calls `accept`, which it does once the share's draft holds it; a
  page recreated before that takes it again. A share is done when the page accepts it, or when
  a newer share replaces it first; one that is merely queued, read or taken is not. The done
  signatures (the last 16) go into the activity's saved state, so a restored activity reads its
  share again when the page never accepted it (process death before the handoff loses nothing)
  and never when it did. While a read of a share runs, or its payload waits for the page, a
  recreation starts no second read of it. On the page the share waits for the app to be ready
  in a slot of its own, so a notification tap or link opened meanwhile cannot replace it. One reader serves the whole process with at most one share
  waiting behind it; a newer share replaces the waiting one.
  The page opens a new session draft of its own for every share, in the last-used project (the
  active project), so it shows in the sidebar under that project like any project draft; it opens
  in Chat only when the app has no project. With no cached project list the share waits for the
  server's list (or its failure) before choosing Chat. A draft the user was writing, a chat draft included,
  keeps its text and attachments, and nothing from the share lands there.
  The share's files, text and citations stay together in that draft even when the user opens
  something else while the files are read. Files go through the composer's own policy, are
  attached unsent, and nothing is written where OpenCode runs before Send (the draft itself is
  kept in OpenChamber's draft store like any draft, so it can be reopened): a HEIC the decoder
  cannot read is refused by name instead of being saved where OpenCode runs, and Office
  documents get the usual "Attach as is" / "Convert to text" choice, where "as is" keeps the
  original in the draft and writes it where OpenCode runs only when the message is sent (a user
  who leaves the draft before choosing keeps the originals there). Every refusal is reported by
  name in the app's language: more than eight files, a file over 10 MB (the composer inlines
  nothing larger), a batch over 32 MB, a type the composer refuses, an empty file, a stream that
  ends before its declared size, a URI that is not another app's `content://` URI or that the
  sender did not grant read access to (checked before any provider call), or a provider
  that stops responding. A stalled provider is cut off (15 s per file, 30 s per share) and named,
  a timed-out stream never hands over the bytes it had, and at most three per-file reads may be
  stuck in a provider at once; past that a file is refused without asking its provider. Items
  past the eight-file cap cost no provider call. Logcat carries counts and reasons, never a
  file name or URI.
  iOS: the `OpenChamberShare` share extension is offered for text, a link, and images or files
  (up to 32; past the eighth each is refused by name, like Android). It has no screen: it copies
  the share into the App Group inbox (`OpenChamberShare/ShareInbox.swift`) under the same limits
  and reasons as Android (15 s per item, 30 s per share, no file read into memory), then posts a
  local notification "Tap to open the draft in OpenChamber" in the phone's language and shows
  "Saved to OpenChamber" for a second (a Focus can hold the banner back). iOS gives a share
  extension no supported way to open its app, so the tap is what brings the app forward; with
  notifications off the extension shows a short "Saved to OpenChamber" alert with an OK button. The
  share waits in the inbox until the page takes it, however the app becomes active next (the
  notification, the icon, the app switcher, a cold launch). The app-local `SharedFiles` plugin
  (`App/SharedFiles.swift`) hands shares to the same page code as Android, oldest first, one at a
  time; the one whose notification was tapped goes last so its draft is the one on screen. A
  share is deleted, and its notification taken down, only when the page accepts it. The page
  side is identical: a draft of its own per share, nothing sent or written to a server before
  Send, the Office choice, one localized toast naming every refused item. See
  `DOCUMENTATION.md` ("iOS share extension") for the reasons.
- **Android share-intake tests** — `SharedPayloadTest` (JVM, `./gradlew :app:testDebugUnitTest`)
  covers the accept/refuse decision and the handoff lifecycle: a queued share is neither read
  twice nor done, a share taken but not accepted is handed over again, a share the process
  lost before the page accepted it is read again, an accepted or replaced one is never
  replayed, two deliveries of the same content are two shares, a restored activity picks the
  right delivery, and the remembered set is bounded. `SharedIntentReaderTest`
  runs on a device (`./gradlew :app:connectedDebugAndroidTest`) against a real `ContentResolver`
  and a real provider serving `content://` URIs from files and pipes: text, text with a file,
  order, the eight-file cap with no provider call for the ninth, declared and undeclared
  oversize streams, a truncated stream, a stalled stream, a stream that stalls after some bytes,
  a provider stuck in `openFile` (no reader pile-up, and a valid share still accepted after it),
  a `file://` URI, this app's own FileProvider and a URI without a read grant refused, an empty
  file, a non-share intent, hand-over until accepted, the recreation handoff and a second
  delivery of the same photo with a real intent, and the package manager listing the app
  for `SEND`/`SEND_MULTIPLE`. The fixture provider lives in `app/src/debug` with a debug-only
  manifest entry, so no release APK carries it. iOS: `scripts/share-inbox.test.mjs` runs the
  inbox and the extension's strings on the Mac (`node --test`, needs Swift); reading real
  providers and the notification need a simulator or device run. The page side is covered by
  `nativeSharedFiles.test.ts` (Android and iOS with the plugin only), `deepLinkNavigation.share.test.ts`
  (own draft), `useComposerFileIntake.test.tsx` and `input-store.test.ts`.
- **Push notifications** — iOS APNs + Android FCM (see below). Presence-aware routing suppresses a
  device's push when an interactive (desktop/web) client is visible.
- **iOS widgets + Control Center + Notification Service Extension** — WidgetKit extension
  (`OpenChamberWidget`), a Control Center control, and an NSE (`OpenChamberNotificationService`)
  that refreshes widgets from push. All share the App Group `group.com.openchamber.app`, as does
  the share extension (`OpenChamberShare`).
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
  (NSE, 15.5) and `OpenChamberShare` (share extension, 16.0), all hand-wired into
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
  can actually be attached and report the rest by name. FCM `default_notification_icon=@drawable/ic_stat_notify`.
- Adaptive and themed launcher icon: full-bleed color background + `ic_launcher_foreground`, plus the
  `<monochrome>` layer (`ic_launcher_monochrome.png`). All of them, and `assets/icon-*.png`, are written
  by `bun run brand:generate` (`scripts/brand`); `@capacitor/assets` would rewrite `ic_launcher.xml`
  without the monochrome layer, so do not use it for icons.

## Quirks / gotchas

- **A shared item lands one commit later than its draft.** `newSessionDraft.draftId` reaches the
  store before the chat column shows the draft: `ChatInput`'s `currentSessionId` comes from
  `chatColumnSession` and trails by a frame. A share must wait until `currentSessionId` is null,
  otherwise it is filed under the session the user is leaving, and the draft's own restore (an
  empty draft) wipes it. Symptom: the share opens a new session with nothing in it, but only when
  the share started from an existing session. `usePendingSharedDraftContent` holds the content
  until then. That wait is not covered by a test; a device run from an open session checks it.
- **Driving shares on a phone needs one passcode entry.** An XCUITest runner that drives Photos,
  Files or Safari asks for the iPhone passcode ("Enable UI Automation") the first time after
  each reboot. The simulator asks nothing, so share runs iterate there; it has no Notes app.
  The test phone is a personal one: match banners by their app (the label starts with
  `OPENCHAMBER`), never the first `NotificationShortLookView`, which once opened a chat that
  arrived mid-run, and keep screenshots of share sheets (contacts) and Notification Center out
  of anything saved.
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

- Apple Developer account; App IDs for the app **and** the three extensions
  (`com.openchamber.app`, `.OpenChamberWidget`, `.OpenChamberNotificationService`,
  `.OpenChamberShare`), each enabled for the **App Group** and (app) **Push**. Development signing
  registered `.OpenChamberShare` with the App Group already; distribution needs its own App Store
  profile, which `mobile-release.yml` reads from the `IOS_SHARE_PROFILE_BASE64` and
  `IOS_SHARE_PROFILE_NAME` secrets, like the widget's and the NSE's.
- Signing certificate + provisioning profiles for all four targets (extensions need their own).
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
- Signing/upload as covered in the CI section above (all four iOS targets; signed Android AAB).
- **Share extension review note**: the extension opens nothing by itself; the app comes forward
  from the user's tap on its notification. Mention share-to-draft in the review notes with the
  other native features.
