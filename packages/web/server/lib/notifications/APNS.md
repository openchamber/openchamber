# APNs remote push — signed relay mode

Native iOS background push (notifications even when the app is **suspended or killed**) is
delivered via APNs through a **central relay**, so no user configures an Apple key. Each server
signs its relay requests with an auto-generated keypair, and tokens are bound to the servers
that registered them — so a leaked device token alone can't be used to push.

## How it works

1. The app registers its APNs device token with **every saved instance**, not only the one it
   is connected to (`useNativePushRegistration`). PWA/desktop never register — only the native
   Capacitor app. A server the phone is paired with for the home network only answers
   `localOnly: true` and neither stores nor binds the token; the other saved servers still do.
2. Each server **binds the token on the relay**: it POSTs `{ token, publicKeyJwk, ts, sig }` to
   `POST /v1/push/register-token`, signed with its auto-generated ECDSA P-256 key
   (`getOrCreateRelayKeypair`, persisted in settings like the VAPID keys). The relay records
   `token → serverId` where `serverId = SHA-256(publicKey)`, one row per `(token, serverId)`
   (`migrations/0012_push_token_servers.sql`), so a registration never takes the token from
   another server. `DELETE /api/push/apns-token` removes this server's row through
   `POST /v1/push/unregister-token`, signed over `unregister.ts.token`, when this server held
   the token and no UI session on it holds it any more; the other servers keep theirs. A token
   the server never stored (a home-network-only phone) never goes to the relay.
3. On a trigger (ready/error/question/permission), the server composes **generic, content-free**
   clear text (a phone with a push key also gets the real text sealed, see *Data confidentiality*) — a fixed scenario title ("Agent response is ready" / "Agent needs your input" / "Agent
   needs permission" / "Agent hit an error") + the **session name** as the body, no model/project/
   message content — plus a **`badge`** count (see below) — and POSTs `{ tokens, title, body,
   badge, env, data:{sessionId, serverId}, publicKeyJwk, ts, sig }` to `POST /v1/push/send`
   (`apns-runtime.js` → `sendViaRelay`). It does **not** gate on UI visibility (see below).
4. The **relay** (`openchamber-website/apps/api`, Cloudflare Worker) verifies the signature +
   `ts` freshness, derives `serverId`, and only delivers to tokens bound to that server. It holds
   the single project APNs `.p8` key, signs an ES256 JWT with `crypto.subtle`, and sends each
   token to APNs over HTTP/2, returning per-token results. A token the provider rejects is
   flagged `drop` and the server drops it locally. On the relay, a token the provider reports
   gone (APNs 410, FCM UNREGISTERED) loses every binding last refreshed before APNs saw it gone;
   any other rejection (BadDeviceToken from a wrong environment, a bad payload) is about the
   sender's request, so only the sender's binding goes. The relay stores no secret — only
   `token → serverId` hashes.
5. Tapping a push reads `data.serverId`, switches to that saved instance, and then opens the
   session named by `data.sessionId`.

## When the relay cannot be reached

Every relay request (send and register-token) gives up after 15 s. The relay answers a send in
0.1-0.4 s, its FCM/APNs call included; before the limit a stalled path held the send for
undici's 300 s and then lost the notification. Sends to different devices run in parallel, so one
send waiting out the limit or a retry does not delay the others.

A request is sent once more, after 5 s, only when it failed before leaving this machine:
connection refused, no DNS answer, no route, or Node's 10 s connect timeout. The 15 s limit sits
above that connect timeout, so a path that never connects is retried. A timeout after the
connection opened, or a reset, is not retried: the relay keeps no record of what it delivered,
and a repeat of a request it already took would alert the phone twice. Such a notification is
lost with a log line that says so. Under Bun, which has no separate connect timeout, a path that
never connects ends at the 15 s limit and is not retried either.

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

It is deliberately **not** derived from the in-app unread marks (OpenCode's `time.viewed`): a
backgrounded client can still be on the session, and the mark changes on a separate event that
races the push trigger. The set self-clears via `clearPendingPushBadge` on any signal that the user is engaging
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

## Clearing handled notifications

When the cause of a notification is handled (the question answered, the session continued or
viewed on another device), the server sends `POST /v1/push/clear` with the notification tags.
The relay turns it into an APNs background push or an FCM data message, which shows nothing; the
app removes the delivered notifications with those tags and sets the badge to the count that
remains. A tag that is cleared also leaves `pendingPushTags`. Later visible pushes repeat the
recently cleared tags in `data.clear`, for a phone that missed the clearing push. The design and
the events that clear each tag are in `DOCUMENTATION.md`, *Clearing handled notifications*.

## Modes

- **Relay (default):** server has no Apple key; `OPENCHAMBER_PUSH_RELAY_URL` defaults to
  `https://api.openchamber.dev/v1/push/send` (register URL is derived as `…/register-token`).
- **Direct (fallback):** set `OPENCHAMBER_PUSH_RELAY_DISABLED=true` + `OPENCHAMBER_APNS_KEY_ID/
  TEAM_ID/P8` to sign+send from the server itself (HTTP/2 + ES256 JWT); no relay binding needed.

## Config

Server (`apns-runtime.js`):
- `OPENCHAMBER_PUSH_RELAY_URL` (default the public relay), `OPENCHAMBER_APNS_ENVIRONMENT`
  (optional override forcing every send to `sandbox` or `production`; normally unset — each
  token is delivered to the environment it registered with: the iOS shell reads the
  `aps-environment` entitlement from the embedded provisioning profile and reports it at
  registration, so Xcode dev builds go to sandbox and TestFlight/App Store to production).
  The signing keypair is auto-generated — nothing to set.
- Direct fallback: `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8`
  (or `_P8_PATH`), `OPENCHAMBER_APNS_BUNDLE_ID`, `OPENCHAMBER_PUSH_RELAY_DISABLED=true`.

Relay (Cloudflare Worker secrets via `wrangler secret put` / GitHub Actions): `APNS_P8`,
`APNS_KEY_ID`, `APNS_TEAM_ID`, optional `APNS_BUNDLE_ID` / `APNS_DEFAULT_ENV`. The binding table
is `push_token_servers`, one row per token and server, created by
`migrations/0012_push_token_servers.sql` with the bindings of the older one-server
`push_tokens` table (`0002`), which stays until a later migration drops it (applied on deploy).

## Apple setup (one-time)

1. Apple **Keys** (not Certificates) → create an **APNs Auth Key** (`.p8`) → Key ID + Team ID;
   enable **Push Notifications** on App ID `com.openchamber.app`.
2. In the **openchamber-website** repo → Actions secrets: `APNS_P8` (PEM), `APNS_KEY_ID`,
   `APNS_TEAM_ID`. Push to `main` → relay deploys, secrets sync, D1 migrations apply.
3. Xcode: confirm the Push Notifications capability; Clean Build Folder; run on device.

## Security posture

- The device token is a per-install secret, but no longer the *only* defence: every relay request
  is signed by the server's private key, and the relay only delivers to a token from a server
  bound to it. A leaked token alone is useless — an attacker has neither the private key nor a
  matching binding.
- `serverId` self-certifies (`SHA-256(publicKey)`), so the relay holds no secret; a D1 leak
  exposes only `token → serverId` hashes. The signed `ts` (±5 min window) blocks replay.
- Residual: any server that knows a token can add its own binding; registering already requires
  possessing the token. A binding only lets that server push; it cannot use, take or remove
  another server's binding. Registering with every saved instance gives each of them one, so
  every saved server can push to this phone. Cloudflare rate limiting is defence-in-depth.

## Data confidentiality (what the relay / Apple / Google can see)

The request **signature is authentication**: the relay verifies it and it hides nothing. What
hides the text is the **push key** (`push-seal.js`). A current iOS or Android app registers a
32-byte key that stays on the server and the phone. For such a phone the server sends the
generic scenario title in the clear, an empty body, and `data.enc`: AES-256-GCM of what the
phone shows. That is the session name as title and what happened as body: the agent's reply,
the question, the command or file a permission is for, the error, the goal outcome
(`runtime.js` → `toApnsGenericPayload` → `sealed`, at most 250 characters). A pull request
notification also seals `url`, the link a tap follows (`openchamber://tracker-item?url=<the pull
request>&dir=<its project folder>`), since it names the repository. The iOS
Notification Service Extension and Android's `SealedPushMessagingService` open it on the device;
the extension writes the link into the notification's `userInfo.url`, the service into the tap
intent's `url` extra, and only a link that starts with `openchamber://` and came out of a blob
this phone's key opened; both drop a `url` that arrived in the clear. A `simctl push` to the
iOS Simulator is added by CoreSimulatorBridge straight to the notification list and never runs
the extension, so the sealed path can only be seen with a real APNs push. The app reads `url` before `sessionId` (`deepLinkNavigation.ts`).

Who can read what:

- **Network hops:** nothing (TLS).
- **The relay (Cloudflare):** the generic title, the device token, `sessionId`, `serverId` and the
  sealed blob. It stores only `token → serverId` hashes (no text, no payload).
- **Apple APNs / Google FCM:** the same as the relay.
- **The device:** opens the blob and shows the real text.

An app that registered without a key gets the generic title and the session name in the clear,
and no message content. Enterprise mode sends no sealed text and drops the session name, so
every phone shows only the scenario title. Neither gets a pull request's link, so a tap on
such a notification opens the app as before.

## Android (FCM)

The relay forwards Android tokens to FCM. A sealed push goes as a data message, so
`SealedPushMessagingService` runs in the background and builds the notification itself. It posts
one notification per tag, so a newer push about the same thing replaces the older one, as the
collapse id does on iOS. A clear-text push carries the tag as its Android notification tag, so a
clearing message can find it.
