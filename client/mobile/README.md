# OpenChamber Mobile (Android)

Capacitor shell for the dedicated OpenChamber mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `client/mobile/dist` so the native Android app always launches `MobileApp` instead of the hosted surface selector.

## Runtime Model

- The native app bundles the mobile UI only; it does not embed the OpenChamber web server or OpenCode server.
- On first launch in Capacitor, the app shows a connection screen for an existing OpenChamber server.
- Connections are saved locally in the app and can be managed from the mobile overflow menu under `Instances`.
- The connection screen and `Instances` menu item are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected OpenChamber servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.

## Commands

Run these from `client/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `client/web` and prepares mobile web assets.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK without launching an emulator.
- `bun run android:devices`: lists connected Android devices (adb).
- `bun run android:run`: installs and launches the built APK on a connected device.
- `bun run android:logcat`: streams the app's logcat output.
- `bun run open:android`: opens the Android project in Android Studio.

## Headless Quickstart

```sh
bun run build
bun run sync
bun run build:android:debug
```

These commands build and sync the native Android project without launching Android Studio or an emulator.

## Local Tooling

The default scripts assume the local Homebrew paths prepared for this workspace:

- JDK 21: `/opt/homebrew/opt/openjdk@21`
- Android SDK: `/opt/homebrew/share/android-commandlinetools`

Override `JAVA_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` when using a different local setup.

Required local tools:

- JDK 21 for Android Gradle builds.
- Android SDK command-line tools with platform/build-tools 35.

## Troubleshooting

- If Android builds fail with `Unable to locate a Java Runtime` or `source release: 21`, install/use JDK 21 and set `JAVA_HOME` accordingly.
- If Android SDK packages are missing, install `platform-tools`, `platforms;android-35`, and `build-tools;35.0.0`, then accept SDK licenses.
- If connecting to a remote OpenChamber server fails from the app while `/health` works in curl, check that the server build includes the packaged-client CORS allowlist for local dev origins.

## Generated Assets

The native project currently uses Capacitor-generated launcher and splash assets. Replace them before release branding work.
