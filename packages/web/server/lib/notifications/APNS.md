# APNs remote push — signed relay mode

Native iOS background push (notifications even when the app is **suspended or killed**) is
delivered via APNs through a **central relay**, so no user configures an Apple key. Each server
signs its relay requests with an auto-generated keypair, and tokens are bound to the server that
registered them — so a leaked device token alone can't be used to push.

## How it works

1. The app registers its APNs device token with **its own server** (`POST /api/push/apns-token`,
   `useNativePushRegistration`). PWA/desktop never register — only the native Capacitor app.
2. The server **binds the token on the relay**: it POSTs `{ token, publicKeyJwk, ts, sig }` to
   `POST /v1/push/register-token`, signed with its auto-generated ECDSA P-256 key
   (`getOrCreateRelayKeypair`, persisted in settings like the VAPID keys). The relay records
   `token → serverId` where `serverId = SHA-256(publicKey)`.
3. On a trigger (ready/error/question/permission), the server composes **generic, content-free**
   text — a fixed scenario title ("Agent response is ready" / "Agent needs your input" / "Agent
   needs permission" / "Agent hit an error") + the **session name** as the body, no model/project/
   message content — plus a **`badge`** count (see below) — and POSTs `{ tokens, title, body,
   badge, env, data:{sessionId}, publicKeyJwk, ts, sig }` to `POST /v1/push/send`
   (`apns-runtime.js` → `sendViaRelay`). It does **not** gate on UI visibility (see below).
4. The **relay** (`openchamber-website/apps/api`, Cloudflare Worker) verifies the signature +
   `ts` freshness, derives `serverId`, and only delivers to tokens bound to that server. It holds
   the single project APNs `.p8` key, signs an ES256 JWT with `crypto.subtle`, and sends each
   token to APNs over HTTP/2, returning per-token results; the server drops tokens flagged `drop`
   (410 / BadDeviceToken). The relay stores no secret — only `token → serverId` hashes.
5. Tapping a push deep-links to its session via the forwarded `sessionId`.

## Foreground suppression

APNs is **not** gated on UI visibility. A backgrounded WKWebView can't reliably report "hidden"
before iOS suspends it, so a server-side visibility gate dropped background push for short
responses. Instead the server always sends, and **iOS** suppresses the foreground banner
(`PushNotifications.presentationOptions: []` in `capacitor.config`) — so there is no notification
while the app is active, with no race. APNs is the native app's **only** channel; local
notifications were removed (a WKWebView can't tell foreground from background — `document.hasFocus()`
is unreliable — so they leaked while the app was open). Cloudflare is touched only when a native
app with notifications on has a registered token and a trigger fires.

## App-icon badge

Each push carries an **absolute** `aps.badge` = the number of **distinct collapse-ids (`tag`)
pushed since the app was last foregrounded**. It mirrors the lock-screen banner stack.

The count is a `Set<tag>` (`pendingPushTags`) in the trigger runtime (`runtime.js`):
`toApnsGenericPayload` adds the push `tag` and returns the set size as the badge. We key by **`tag`,
not sessionId**, because the tag *is* the banner identity — iOS uses it as `apns-collapse-id`, so
same-tag pushes replace one banner while different tags are distinct banners. One session can raise
several banners (`ready-<id>`, `question-<id>`, `permission-<requestKey>` are different tags), so
counting sessionIds both over- and under-counts the stack; counting tags matches it.

It is deliberately **not** derived from the live attention snapshot (`needsAttention`/`isViewed`):
that machinery drives in-app indicators on *connected* clients, where a backgrounded client stays
"viewing" and `needsAttention` is set by a separate `session.status` event that races the push
trigger. The set self-clears via `clearPendingPushBadge` on any signal that the user is engaging
with the app: the visibility beacon (`updateUiVisibility` wrapper, `visible:true`), **plus** opening
a session (`POST /api/sessions/:id/view`) and sending a message (`POST /api/sessions/:id/
message-sent`). The latter two need no auth and fire reliably on the native app when it foregrounds,
so they are the dependable reset — the visibility beacon alone proved unreliable in WKWebView. This
mirrors the device zeroing its icon badge on `sceneDidBecomeActive` (`AppDelegate.swift`), keeping
server and device in sync.

The value flows `runtime.js` (`toApnsGenericPayload`) → `apns-runtime.js` (`sendViaRelay` body /
direct-mode `aps.badge`) → relay (`pushSendSchema.badge` → `aps.badge`). It is **not** signed (like
`body`/`data`); the relay still only delivers to bound tokens. The set is server-global, so every
device token of a server sees the same badge.

## Modes

- **Relay (default):** server has no Apple key; `OPENCHAMBER_PUSH_RELAY_URL` defaults to
  `https://api.openchamber.dev/v1/push/send` (register URL is derived as `…/register-token`).
- **Direct (fallback):** set `OPENCHAMBER_PUSH_RELAY_DISABLED=true` + `OPENCHAMBER_APNS_KEY_ID/
  TEAM_ID/P8` to sign+send from the server itself (HTTP/2 + ES256 JWT); no relay binding needed.

## Config

Server (`apns-runtime.js`):
- `OPENCHAMBER_PUSH_RELAY_URL` (default the public relay), `OPENCHAMBER_APNS_ENVIRONMENT`
  (`production` default / `sandbox` for development builds). The signing keypair is auto-generated — nothing to set.
- Direct fallback: `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8`
  (or `_P8_PATH`), `OPENCHAMBER_APNS_BUNDLE_ID`, `OPENCHAMBER_PUSH_RELAY_DISABLED=true`.

Relay (Cloudflare Worker secrets via `wrangler secret put` / GitHub Actions): `APNS_P8`,
`APNS_KEY_ID`, `APNS_TEAM_ID`, optional `APNS_BUNDLE_ID` / `APNS_DEFAULT_ENV`. The `push_tokens`
binding table is created by `migrations/0002_push_tokens.sql` (applied on deploy).

## Apple setup (one-time)

1. Apple **Keys** (not Certificates) → create an **APNs Auth Key** (`.p8`) → Key ID + Team ID;
   enable **Push Notifications** on App ID `com.openchamber.app`.
2. In the **openchamber-website** repo → Actions secrets: `APNS_P8` (PEM), `APNS_KEY_ID`,
   `APNS_TEAM_ID`. Push to `main` → relay deploys, secrets sync, D1 migrations apply.
3. Xcode: confirm the Push Notifications capability; Clean Build Folder; run on device.

## Security posture

- The device token is a per-install secret, but no longer the *only* defence: every relay request
  is signed by the server's private key, and the relay only delivers to a token from its bound
  `serverId`. A leaked token alone is useless — an attacker has neither the private key nor a
  matching binding.
- `serverId` self-certifies (`SHA-256(publicKey)`), so the relay holds no secret; a D1 leak
  exposes only `token → serverId` hashes. The signed `ts` (±5 min window) blocks replay.
- Residual: trust-on-first-bind (whoever registers a token first owns it) — acceptable, since
  registering already requires possessing the token. Cloudflare rate limiting is defence-in-depth.

## Data confidentiality (what the relay / Apple can see)

The push payload is **not** application-encrypted, so there is no decryption step. The text is
sent in plaintext, protected only by **TLS in transit** (HTTPS to the relay, TLS from the relay
to APNs). The request **signature is authentication, not encryption** — the relay *verifies* it
(valid / invalid), it does not hide anything.

Who can read the alert text:

- **Network hops:** nothing (TLS).
- **The relay (Cloudflare):** the generic title + body (session name), the device token, and
  `sessionId`. It stores only `token → serverId` hashes (no text, no payload).
- **Apple APNs:** the alert text too — APNs always reads the alert payload of an `alert` push.
- **The device:** displays it.

This is acceptable **because the text is deliberately content-free**: a fixed scenario title +
the session name only — no model, project, or message content (`runtime.js` →
`toApnsGenericPayload`). The session name is the single semi-personal field that crosses the
relay/Apple. To hide even that from Apple would require an end-to-end **encrypted payload**
(`mutable-content` + a Notification Service Extension that decrypts on-device with a key never
sent to the relay) — not implemented, and unnecessary for generic text.

## Android (FCM) note

The Android equivalent is **FCM** (not implemented): the same relay would forward to FCM with a
server key, and the client would register an FCM token (same store/routes + signing).
