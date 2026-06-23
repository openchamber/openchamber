# APNs remote push — implemented but FROZEN

Native iOS APNs remote push (notifications delivered even when the app is **suspended or
killed**) is implemented end‑to‑end but intentionally **dormant**. It is not triggered and
requires no setup to build/run the app. This document explains why, what exists, and exactly
how to reinstate it.

## Why it's frozen

APNs can only be sent by a server holding an APNs key tied to the app's Apple **Team ID** +
bundle id (`com.openchamber.app`). For a self‑hosted product that means:

- **Self‑build users** (own Apple account + own build) can configure their own key — fine.
- **Users of one published App Store app** cannot: they don't own the signing identity, so
  their own server can't push to it. The only way they get push with zero config is a
  **central relay** owned by the publisher that holds the single APNs key.

OpenChamber will gain its own **encrypted relay** (the same relay that will carry the whole
connection between the app and a user's remote machine, removing the need for third‑party
tunnels). When it exists, this APNs path is reused: the relay holds the key and forwards
notification events to APNs (and, for Android, FCM). Until then, the zero‑config path is
**local notifications** (see `nativeNotifications.ts`), which work while the app is alive or in
the brief background window iOS grants — but not once suspended.

## What's built (kept, dormant)

Server (config‑gated — never fires unless APNs env/settings are present):
- `apns-runtime.js` — device‑token store (`apns-tokens.json`) + dependency‑free HTTP/2 APNs
  sender (token‑based ES256 JWT via Node `crypto`). Drops dead tokens on `410`/`BadDeviceToken`.
- `routes.js` — `POST`/`DELETE /api/push/apns-token` (scoped via `uiAuthController.ensureSessionToken`).
- `runtime.js` — `fanoutPush()` already calls `sendApnsToAllUiSessions` next to web‑push.
- `index.js` / `bootstrap-runtime.js` — runtime construction + dependency wiring.

Client (present, **not wired**):
- `packages/ui/src/apps/useNativePushRegistration.ts` — registers the APNs token + tap deep‑link.
- `packages/web/src/api/push.ts` — `registerApnsToken` / `unregisterApnsToken`.
- `@capacitor/push-notifications` is still a dependency, and `AppDelegate.swift` still forwards
  `didRegister*ForRemoteNotifications*` to Capacitor.

## What was removed for the freeze (re‑add to reinstate)

1. The hook call in `MobileApp.tsx`:
   `useNativePushRegistration({ enabled: isNativeMobileApp && isConnected })`.
2. `packages/mobile/ios/App/App/App.entitlements` with `aps-environment` = `development`
   (or `production`), plus `CODE_SIGN_ENTITLEMENTS = App/App.entitlements;` in **both** build
   configs in `project.pbxproj`.
3. `UIBackgroundModes` → `remote-notification` in `Info.plist`.

(These three were removed so the app builds/signs with **no** Apple push setup. The entitlement
in particular requires the App ID to have the Push Notifications capability.)

## Reinstatement checklist

1. Re‑add the three items above; `bun run mobile:sync`.
2. Apple Developer: enable **Push Notifications** for App ID `com.openchamber.app`; create an
   **APNs Auth Key** (`.p8`) → note **Key ID** + **Team ID**.
3. Xcode: confirm Signing & Capabilities shows Push Notifications + Background Modes (Remote
   notifications); Clean Build Folder; run on device.
4. Configure the **sender** (the relay, or your own server) — env first, then `settings.apnsConfig`:
   - `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`
   - `OPENCHAMBER_APNS_P8` (PEM contents; literal `\n` accepted) **or** `OPENCHAMBER_APNS_P8_PATH`
   - `OPENCHAMBER_APNS_BUNDLE_ID` (default `com.openchamber.app`)
   - `OPENCHAMBER_APNS_ENVIRONMENT` (`sandbox` default for dev/side‑load builds; `production` for
     TestFlight/App Store — must match the `aps-environment` entitlement)

## Android (FCM) note

The Android remote‑push equivalent is **FCM** (Firebase). It is **not** implemented; the same
relay would forward to FCM with a server key, and the client would register an FCM token (same
shape as the APNs token store/routes). Local notifications already cover Android with no extra
work.

## Relay reuse plan (future)

Device registers its push token with its server/the relay (route already exists). On a
notification trigger, instead of each user server holding Apple/Google keys, the server forwards
the event to the encrypted relay; the relay holds the **single** APNs/FCM credentials and sends.
`sendApnsToAllUiSessions` becomes the relay's send step (or the server posts to the relay and the
relay calls this). Zero config for end users.
