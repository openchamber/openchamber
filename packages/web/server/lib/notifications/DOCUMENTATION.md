# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation and plain-text normalization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/push-seal.js`: end-to-end sealing of native push text. A phone that registers with a `pushKey` (32 bytes, base64; made by the iOS shell in the App Group, by Android's `PushSealKey`) gets each notification as the generic scenario title, an empty body and `data.enc` = `v1.` + base64(nonce || AES-256-GCM ciphertext || tag) of `{ title, body }`. Each such device is its own relay send. The iOS Notification Service Extension and Android's `SealedPushMessagingService` open it; the relay sends a sealed push to Android as a data message (openchamber-website `apps/api/src/lib/fcm.ts`) so that service runs in the background. The sealed text is richer than the clear one: `runtime.js` passes `sealed` = the session name as title and what happened as body (the agent's reply; `Question:`, `Wants to run:` / `Wants to edit:` / `Wants to read:` / `Wants permission:`, `Error:` or the goal title before the detail), capped at 250 characters. When there is no such text, the phone opens the generic text. Phones without a key keep getting the generic text in the clear. Enterprise mode sends no `sealed` text and strips the session name, so the phone shows only the scenario title.
- `packages/web/server/lib/notifications/session-key.js`: the key both push stores group registrations under, a `sha256:` hash of the UI session token, never the token. Files written before the hashing are rewritten with hashed keys on first read. Both stores are written `0600`.
- `packages/web/server/lib/notifications/client-push-access.js`: keeps push away from revoked and expired paired clients, see *Revoked and expired clients* below.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery. Two modes: **relay** (default — sign + POST tokens + generic text to the central Cloudflare relay `https://api.openchamber.dev/v1/push/send`, which holds the single project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`. In enterprise mode (`../enterprise-mode.js`) `fanoutPush` also drops the session name from APNs and sends web push with the scenario title, an empty body and the deep link only, since web push leaves through the browser vendor's push service. Desktop notifications and in-app toasts stay local and keep the full text.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/emit-route.js`: `POST /api/notifications/emit` for OpenCode plugins.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
- `packages/web/server/lib/notifications/template-locales.js`: the notification text OpenChamber writes itself, per interface language. An empty template field means "no custom text", so the notification uses these defaults and the settings page shows them as placeholders. `settings-runtime.js` no longer seeds English template text into an install; it clears the seed older builds wrote. The server keeps its own list because it cannot import `packages/ui`; an unknown tag falls back to English.
- `packages/web/server/lib/notifications/extension-channels.js`: extension notification channels (`provides: ["notifications"]`), see *Extension notification channels* below. `channel-accounts.js` is their account store, `channel-routes.js` the account card's routes.
- `packages/web/server/lib/notifications/message.js`: helper implementation module.
- `packages/web/server/lib/notifications/message.test.js`: unit tests for notification message helpers.

## Public exports

### Notifications API (re-exported from message.js)
- `truncateNotificationText(text, maxLength)`: Truncates text to specified max length, appending `...` if truncated.
- `prepareNotificationLastMessage({ message, settings })`: Prepares the last message for notification display by normalizing and truncating text.

### Route registration API (routes.js)
- `registerNotificationRoutes(app, dependencies)`: Registers notification-owned endpoints:
  - `GET /api/push/vapid-public-key`
  - `POST /api/push/subscribe`
  - `DELETE /api/push/subscribe`
  - `POST /api/push/apns-token` (native iOS APNs device-token registration)
  - `DELETE /api/push/apns-token`
  - `POST /api/push/visibility`
  - `GET /api/push/visibility`
  - `GET /api/notifications/stream`
  - `GET /api/session-activity`
  - `GET /api/sessions/snapshot`
  - `GET /api/sessions/status`
  - `GET /api/sessions/:id/status`
  - `POST /api/sessions/:id/view` and `POST /api/sessions/:id/message-sent`: reset the native push badge and clear the session's pushed notifications (*Clearing handled notifications*). Whether a session is unread is OpenCode's own `time.viewed`.

### Trigger runtime API (runtime.js)

`notifyPullRequest({ item, event })` delivers user merge-follow events through the same native, UI, web-push, APNs and extension-channel fanout. `notifyOnPullRequests` is a profile setting, default on, independent of completion/error notifications. It is checked on the server before every delivery. Fixed event titles follow the interface locale (`pull-request-locales.js`); the body names the repository and PR number. Enterprise-mode push and extension deliveries strip that reference through the existing fanout boundary. Notifications have kind `pull-request`, no session id, and never wake an agent. Existing click routing accepts sessions only, so these notifications currently bring the app forward without selecting a PR.
`notifyShareAnswer({ sessionId, label, title, summary })` announces an answer to a shared page (`../share-pages`) once OpenCode admitted it into its session. It obeys the completion toggle (`notifyOnCompletion`); there is no setting of its own. Answers delivered within 2 s of each other (at most 10 s in all, such as a night's picked up at start) collapse into one notification about the newest session: "<label> answered “<title>”" with the answer's summary, or "N answers to shared pages" with the names; both texts come from `template-locales.js` (`shareAnswerTitle`, `shareAnswersTitle`). Kind and push type `share-answer`, tag `share-<sessionId>`.
- Every open window shows it as a toast, whatever the presence: the UI event always goes out, with `showWhenFocused` and `toastOnly`. `toastOnly` is true while another window is in use (`isAnyUiVisible`, the desktop's focus) or system notifications are off; a window then shows the toast and no system notification of its own (`packages/ui` `sync/share-answer-toast.ts`).
- The desktop notification, web push, APNs and extension channels follow the usual presence and `notificationMode` rules, through `fanoutPush` and `sendToChannels`. The label and the page title are conversation content, like a session name: enterprise mode strips them from push and channels through that same boundary, and the desktop notification and toast keep them.
- The tag clears like `ready-`: on view, a message sent, or a turn start. The answer's own delivery wakes the session, so the first turn start after the delivery is skipped, without comparing clocks (an external OpenCode can run on another machine's clock): an answer still waiting in the batch is marked woken by it, and a claim made before it carries `skipTurnStart` (saved with the open tags), which that turn start removes instead of clearing. The next turn, a view or a message clears the tag. When the session was busy and no new turn starts, the next turn start is the one skipped. A view, a message or a later turn during the collapse wait drops that session's waiting answers, so nothing already handled is announced.
- The toast comes from the control stream, which every client opens whatever carries its main events (`packages/ui` `sync/control-stream-sync.ts`); the main-stream and web notification paths only hold back the system notification for `toastOnly`.
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned debounced trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload)`
- Owns:
  - completion/error/question/permission trigger routing (a page an agent shows that waits for the user's answer, `openchamber:page-waiting` from this server, notifies exactly like a form, with the page title as the ask); permission suppression consults the authoritative permission-auto-accept runtime
  - an interrupted step marked `aborted` after Stop, steering, or question dismissal emits no external error notification. Terminal execution failures through `session.error` still notify, including exhausted auto-resume attempts with error type `aborted`. In-app `SessionErrorNotice` diagnostics and VS Code's separate notification path are unchanged.
  - session parent cache for subtask suppression
  - no ready notification on a `session.idle` while a subagent of that session is still running (a background-subagent pause; OpenCode runs the parent again with the result and its next idle announces). On OpenCode 2.2.6+ the check also reads the job list, which covers nested subagents and background images; background shells do not hold the notification, since a dev server never ends. Running direct child sessions are asked for in any case: OpenChamber's own child sessions (workflow agents) are no OpenCode jobs, an older OpenCode has no job list, and a space reaches only session routes. The check comes from `../opencode/session-activity.js`; when it cannot be made, the idle announces as before
  - an MCP elicitation form (session id `global`, owned by no session) notifies without a session: no session title lookup, and the deep link opens the app
  - template resolution and fallback behavior: an empty field in `settings.notificationTemplates` resolves to the default for `settings.locale` (`template-locales.js`), so notification text follows the interface language unless the user wrote their own
  - native notification fanout and web push payload fanout
  - push suppression while any fresh UI visibility heartbeat reports a focused client
  - the same presence for open windows (`showInOpenClients`): a notification with `requireHidden` goes neither to the desktop shell nor to any connected UI while `isAnyUiVisible()` holds, so a hidden tab, phone browser or second computer stays quiet while the user works in another window. With `notificationMode: 'always'` every window still shows it. See *Why open windows follow the server's presence*
  - no ready notification for a turn that is a step of an auto-review (`isInAutoReview`, answered by `../auto-review`'s `speaksFor`); `notifyAutoReviewEnded` sends the review's one notification when it ends, under the completion toggle, with `review*` texts from `template-locales.js` and APNs type `review`
  - extension notification channels: `deliverToExtensionChannels({ notification, requireHidden })` is called where push is (`sendToChannels`), with the text push gets and the enterprise stripping push applies; see *Extension notification channels* below
  - chats of isolated spaces: `maybeSendPushForTrigger(payload, { spaceId })` reads such a chat's record (title, parent, goal), its last reply and its running subagents inside the space, through `spaceFetchFor(spaceId)`, a `fetch` over the spaces dispatcher (`../spaces/space-fetch.js`), and never asks the host's OpenCode or the host's permission policy about it, since neither knows the chat. What comes back is the space's text, shown as it is shown in the sidebar. A space that cannot be asked gives the generic text, as a host chat whose reads fail does. The host's auto-accept is not consulted for a space's permission request, so such a request notifies after the debounce unless its reply arrives first.

### Clearing handled notifications (runtime.js, apns-runtime.js)

A pushed notification is removed from the phones and browsers once its cause is handled anywhere. Every push has a tag that names its cause, and the same tag is the APNs collapse id, the Android notification tag, the web notification tag and `data.tag` on the phone:

| Tag | Cleared when |
|---|---|
| `ready-<sessionId>`, `error-<sessionId>`, `goal-<sessionId>`, `review-<sessionId>`, `share-<sessionId>` | the session's next turn starts (`session.status` busy with `turnStartedAt`, which only `session.execution.started` carries), or the session is viewed or sent a message from any OpenChamber client (`POST /api/sessions/:id/view`, `/message-sent`) |
| `question-<sessionId>` | the form it shows settles (`form.settled`) or the page it shows stops waiting (`openchamber:page-settled`), or as above |
| `permission-<sessionId>` | the request it shows is replied to (`permission.replied`), or as above |

A `share-` tag survives the turn its own answer woke (`skipTurnStart`, see `notifyShareAnswer`). Pull request notifications have no cause the server can see handled, and stay until dismissed.

The trigger runtime keeps the open tags (`openPushTags`: the session, the request a tag shows, whether it went to the phone apps, the id of its latest push) and the 20 most recently cleared ones, and saves both to `push-open-tags.json` in the data directory on every change, one write at a time, so a notification pushed before a restart is still cleared after it. One tag can show several requests in turn (two permissions of one session), so a reply clears the tag only when it answers the request the tag shows now. Clearing a tag also takes it out of the badge count, and the clearing push carries the new count.

- **Nothing stale is sent.** A notification claims its tag before its text is prepared (`claimPushTag`), and a cause handled meanwhile takes the claim away, so the push is dropped: a form or page that settles inside the 500 ms debounce or while the session name is read, a permission replied to during the auto-accept lookup or later. A notification is also dropped when the session's notifications were cleared (`sessionClearedAt`) after its turn ended or its ask arrived.
- **A late clearing never removes a newer notification.** Every push carries `nid` (in `data` for web push), a time-based id that rises with each push. A clearing names `tag@nid`, the newest push it covers, and the phone or browser keeps a notification under that tag whose `nid` is higher. A clearing push and a later visible push with the same tag can arrive in either order: background pushes and normal-priority FCM messages are delayed on their own schedule.
- **iOS and Android:** `clearApnsNotifications` sends the entries and the remaining badge to every registered device through the relay's `POST /v1/push/clear`, signed over `ts.sortedTokens.clear.tags`. The relay sends an APNs background push (`content-available`, priority 5, no alert), which `AppDelegate` handles, and an FCM data message of type `clear` at normal priority, which `SealedPushMessagingService` handles. Direct mode sends the background push itself. A relay without the route answers 404, logged once.
- **Every later push** carries the recently cleared entries (`clear`, comma-separated in `data` for the phones, an array for web push), minus its own tag. The iOS notification service extension, Android's messaging service and the service worker remove those before showing the new one.
- **This browser:** opening a session closes its web-push notifications on the device that opened it (`markSessionViewed`), next to the desktop's own (`clearDesktopSessionNotifications`).

#### Why a background push and not a visible push the phone hides

iOS shows every alert push; a notification service extension cannot drop one without the filtering entitlement Apple grants by request. A background push shows nothing. It wakes the app unless the user swiped the app away, and iOS may hold or drop it to save power, which is why later pushes repeat the cleared tags.

#### Why the open tags are saved to a file

The desktop app's server stops whenever the app quits, and the phones keep what it pushed. Without the file, a question answered after a restart would stay on the phone until another push with its tag replaced it. The file holds tags and ids only (`ready-<sessionId>`, a request key), at most 500 entries.

#### Why web push has no clearing push

A push that shows no notification costs the subscription: Safari revokes it after a few, Chrome shows its own "updated in the background" notice. So browsers learn of handled notifications from the next push, and from the user opening the session.

#### Why viewing a session clears its question and permission too

The desktop already removes all of a session's notifications when it is viewed (`clearDesktopSessionNotifications`). The user has the request in front of them on that device, so the copy on the phone only duplicates it.

### Extension notification channels (extension-channels.js, channel-accounts.js, channel-routes.js)

An installed extension whose service provides `notifications` (SDK `contributes.notifications`) is a delivery channel next to the desktop and the phone. `createExtensionNotificationChannels` owns which channels exist, their accounts and the delivery; `index.js` builds one, hands its `deliver` to `createNotificationTriggerRuntime` as `deliverToExtensionChannels`, and passes it to `feature-routes-runtime.js`, which registers the routes, reconciles it at start and from the guest activation and deactivation listeners.

- The catalog is the authority (`isNotificationChannelGuest`: enabled, fully approved with an effective `service` grant, the role and a parsed contribution). Approving the extension and connecting an account is the switch; pausing it is the off; nothing on the Notifications page refers to a channel. `reconcile()` runs serialized and revokes the handles of a guest that left.
- Accounts are OpenChamber's: one per channel in `{dataDir}/notification-channels.json` (`0o600`, temp file and rename, writes chained per file; a corrupt file is an error, never a disconnected channel). The token leaves the store only to mint a handle. `connect` probes a typed instance (`auth.probe`), verifies the token through the service (`auth.verify`, the handle carries the candidate token) and stores what the server said the account is; connecting again replaces the account. A `user` instance is an https origin or http on this machine; `fixed` is the contribution's origin. A `basic` username must be one the handle minter can send (`isProviderUsername`), refused as 400 `USERNAME_INVALID` before any call. When an update moves a `fixed` channel's server, `reconcile` writes the account off (`invalidReason: 'instance-changed'`) and `deliver` sends nothing to it: the token was given for the old server, and the card asks the user to connect again.
- Every call to the service carries a fresh handle from `../source-control/outbound-handles.js`, bound to the account's origin and token, served on `/notifications/outbound` by the callback listener; the service never holds a token. A `status: 401` writes the account off only when the proxy saw the server answer 401 through that handle; the card then says the account needs attention, and the channel is skipped until the user connects again.
- `deliver({ notification, requireHidden })` is called by `runtime.js` (`sendToChannels`) beside `fanoutPush`, after the kind's toggle, the debounces and the subagent, goal and auto-review suppressions, with the text push gets: in enterprise mode the kind's generic title (`message.js` `genericNotificationTitle`), no body, no session name, no directory, since the channel's server is outside the boundary. The channel rechecks enterprise mode immediately before forwarding, so a policy enabled during a queued call strips that call's content too. The module applies the visibility gate itself (`isAnyUiVisible`, unless `notificationMode` is `always`): the Electron focus gate the desktop branch reads does not exist on web. Delivery is at most once; a failed `notify` is warned once a minute per channel and never retried. Nothing here logs a notification's text.
- Routes: `GET /api/notifications/channels`, `PUT /api/notifications/channels/:providerId/account` (`{ token, username?, instance? }`), `DELETE /api/notifications/channels/:providerId/account`; failures are `{ error, code }` with the module's status (404 `CHANNEL_UNKNOWN`, 400 `TOKEN_REQUIRED` / `USERNAME_REQUIRED` / `USERNAME_INVALID` / `INSTANCE_REQUIRED` / `UNSUPPORTED_INSTANCE`, 401 `TOKEN_REFUSED`, 409 `CONNECT_SUPERSEDED`, 503 `CHANNEL_UNAVAILABLE` / `CHANNEL_BUSY`, 502 `MALFORMED_PROVIDER_RESPONSE`). No answer carries a token.

#### Why account changes use compare-and-set

A Connect captures a per-channel operation identity before verification. Disconnect invalidates that identity even when no account exists, and the store checks it under its write lock before committing. Each stored connection also has a random revision, so a delayed invalidation compares the original account under the same lock and cannot mark a replacement invalid. Older records without a revision remain readable and acquire one on their next connection.

#### Why calls share a bounded channel queue

The SDK promises one notification-role call at a time, including authentication. Each channel serializes at most 200 outstanding calls; newer notifications are dropped with a rate-limited warning and Connect receives a busy error. Deactivation aborts the channel's active request, drops queued calls and revokes handles. Queued notifications recheck visibility and read the current account when their call starts.

#### Why the channel's accounts have their own store and not the source-control auth store

That store models forge users (an integer `id`, `origin#id` identities, Git transport credentials) in `source-control-auth.json`, and a package providing both roles would share one `ext-<id>` section. A channel's account is a string id with one token; a store of its own keeps the shapes honest and removal independent.

#### Why delivery is gated on `isAnyUiVisible` here and not on the trigger runtime's focus check

The desktop branches read `getIsWindowFocused`, which only the Electron shell sets; on web the gate lives inside `fanoutPush` (`isAnyInteractiveClientVisible`) and inside web push (`requireNoSse`). A channel hooked after `fanoutPush` would therefore deliver on web while the user reads the answer. The module reads the push runtime's visibility itself, so a channel behaves like push on every runtime.

### Revoked and expired clients (client-push-access.js)

A registration made with a paired client's token sits under `clientSessionKeyFor(id)`. Two things keep notifications off a client that is no longer valid:

- Revoking a client, and clearing revoked clients from the list, removes the client's devices from both stores (`removeDevicesOfClients`). A failure while revoking is a log line, because the revocation is already written and the settings page acts on its success. The send check below still skips the client's own key, but a device also registered under another key keeps receiving through it until the client is cleared. Clearing removes the devices before the rows go, so a failure there keeps the rows, answers with an error the settings page shows, and can be retried.
- Every send skips the keys of revoked and expired clients in the list (`invalidSessionKeys`). When the list cannot be read the send fails with a log line and nothing goes out.

A valid client's device, a cookie session's device, and a phone that pairs again after being revoked keep or regain their notifications. The phone app registers again each time it connects with a token the server accepts. A browser subscribes only from the switch on the Notifications page, so a browser removed along with a revoked client gets no web push until that switch is turned off and on.

A registration whose client row is gone cannot be stopped. Its key is a hash of an id that no longer exists, and it looks exactly like a cookie session's key, so the send has to deliver to it. That covers a row an older build cleared, and a row replaced by pairing again when the phone's registration under the new client never reached the server. A client revoked by an older build whose device is also registered under a cookie session keeps delivering through that key until the client is cleared from the list.

A server with no UI password accepts requests without any credential, so a revoked token does not lock the phone out: its next registration succeeds as a new cookie session and notifications resume. Revocation on such a server does not cut the device's API access either, and that is `../ui-auth`'s to change.

#### Why a device leaves every key and not only the client's own

Sends deduplicate by device, so a phone that signed in with a cookie session before it paired would keep receiving through the older key. A key of another valid client stays: that pairing still authenticates, and removing its entry would silence a valid device until its next launch. A cookie session's key cannot be told from a stale one, so it goes; a phone whose cookie session is still valid registers again when it next connects, and a browser through its Notifications switch.

#### Why a send fails when the client list cannot be read

Delivery is at most once already (`APNS.md`, *When the relay cannot be reached*), and an unreadable list must not read as "nobody was revoked". One lost notification with a log line costs less than a revoked phone getting the text.

#### Why nothing is unbound on the relay

The relay has no route for it, and sends only ever start from this server's list, so removing the local record stops delivery. The token stays bound to this server, which is what lets the same phone register again after it pairs.

### Push runtime API (push-runtime.js)
- `createPushRuntime(dependencies)`: creates runtime for web push and UI visibility state.
- Returned API:
  - `getOrCreateVapidKeys()`
  - `ensurePushInitialized()`
  - `setPushInitialized(value)`
  - `addOrUpdatePushSubscription(uiSessionToken, subscription, userAgent)`
  - `removePushSubscription(uiSessionToken, endpoint)`
  - `removePushDevicesOfSessions(sessionKeys, keep)`
  - `sendPushToAllUiSessions(payload, options?)`
  - `updateUiVisibility(token, visible)`
  - `isAnyUiVisible()`
  - `isUiVisible(token)`

### APNs runtime API (apns-runtime.js)
- `createApnsRuntime(dependencies)`: creates runtime for native iOS APNs push and device-token state. Dependencies: `fsPromises`, `path`, `crypto`, `http2`, `APNS_TOKENS_FILE_PATH`, `readSettingsFromDiskMigrated`, `writeSettingsToDisk` (persists the auto-generated relay signing keypair).
- Returned API:
  - `addOrUpdateApnsToken(uiSessionToken, deviceToken, userAgent, platform, environment)` — also binds a newly-seen token on the relay (signed `/v1/push/register-token`). `environment` is the APNs environment the token was minted for (`sandbox` for Xcode/dev-signed installs, `production` otherwise — reported by the client at registration); delivery groups tokens by it.
  - `removeApnsToken(uiSessionToken, deviceToken)`
  - `removeApnsTokenFromAllSessions(deviceToken)`
  - `removeApnsDevicesOfSessions(sessionKeys, keep)`
  - `clearApnsNotifications({ tags, badge })` — removes the notifications with these tags from every registered device with a push that shows nothing; see *Clearing handled notifications*.
  - `sendApnsToAllUiSessions(payload)` — `payload.sealed` (`{ title, body }`, optional) is what a phone with a push key opens; it is never sent in the clear. Signs + sends to all registered tokens (no UI-visibility gate; iOS suppresses the foreground banner). No-ops with a single warning when APNs is unconfigured. Drops tokens on `410` / `BadDeviceToken` / `Unregistered`. Relay sends run in parallel, each limited to 15 s and sent once more only when the request never left this machine, since the relay does not deduplicate (`APNS.md`, *When the relay cannot be reached*).
  - `resolveApnsConfig()`
- Configuration (env first, then `settings.apnsConfig`): `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8` (PEM contents; literal `\n` accepted) or `OPENCHAMBER_APNS_P8_PATH`, `OPENCHAMBER_APNS_BUNDLE_ID` (default `com.openchamber.app`), `OPENCHAMBER_APNS_ENVIRONMENT` (optional override forcing every send to `sandbox` or `production`; when unset, each token is delivered to the environment it registered with, defaulting to `production` for tokens without one).

### Emitter runtime API (emitter-runtime.js)
- `createNotificationEmitterRuntime(dependencies)`: creates runtime for unified notification emission channels.
- Returned API:
   - `writeSseEvent(res, payload, serializedPayload?)`, where broadcast callers may share one JSON encoding across recipients
  - `emitDesktopNotification(payload)`
  - `broadcastUiNotification(payload)`

### Plugin notification route (emit-route.js)
- `createPluginNotificationEmitter(dependencies)` owns validation, the rate window and delivery; one instance is shared by the HTTP route and the `openchamber_notify` agent tool (`notify.send`).
- `registerNotificationEmitRoutes(app, dependencies)` returns `registerPluginRoute()` and `registerApiRoute()`. Bootstrap calls the first before API auth and the second after it.
- Callers: a plugin in the managed OpenCode (agent-tool bearer token, the only reason for the pre-auth registration) or any client that passes regular API auth. No other auth path exists.
- Body `{ title?, body?, tag?, sessionId?, directory?, showWhenFocused? }`, at least one of title/body; title ≤120, body ≤500 chars, 16kb JSON. `kind` is always `plugin` so callers cannot trigger kinds the UI treats specially.
- One shared rate window: 10 notifications per 10s, then 429 with `Retry-After`.
- Follows `nativeNotificationsEnabled` (returns `{ delivered: false }`) and `notificationMode`; focused plugin notices use an in-app info toast, while OS/browser notifications stay hidden until the window is not focused. `showWhenFocused: true` opts into the focused toast. Live delivery only: no web push or APNs fanout.
- Advertised as the `api.notifications.emit.v1` server capability.

### Template runtime API (template-runtime.js)
- `createNotificationTemplateRuntime(dependencies)`: creates shared notification/template runtime. Model-backed summarization was retired after the Zen provider became unavailable.
- Returned API:
  - `resolveNotificationTemplate(template, variables)`
  - `shouldApplyResolvedTemplateMessage(template, resolved, variables)`
  - `fetchFreeZenModels()` compatibility stub returning `[]`
  - `resolveZenModel(override)` compatibility stub preserving stored values without validation
  - `validateZenModelAtStartup()` compatibility no-op
  - `summarizeText(text, targetLength, zenModel)` compatibility stub returning local fallback text
  - `extractLastMessageText(payload, maxLength?)`
  - `fetchLastAssistantMessageText(sessionId, messageId, maxLength?, source?)`
  - `maybeCacheSessionInfoFromEvent(payload, { spaceId }?)`: caches a host session's title; an event of a space (`spaceId` set) is not cached, and a space's chat is never read from these caches, so a session id a space names cannot set a host chat's title.
  - `buildTemplateVariables(payload, sessionId, source?)`: `source` (`{ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl, isSpace? }`, the host's OpenCode by default) is where the session's title and messages are read; `runtime.js` passes the space's, with `isSpace: true`, for a chat of an isolated space. `isSpace` alone tells the two apart: a source without it is the host, whichever object it is, so it uses the title and session caches, matches host projects and runs git on the host. A new kind of source that reads anything but the host's OpenCode must set `isSpace`, or its session ids reach those caches and its paths reach the host filesystem. `{project_name}`, `{worktree}` and `{branch}` come from the event's `directory`, else the session record's `location.directory`; turn-end events carry no location, so they read the record. `{project_name}` is the label of the project the sidebar files that directory under: a directory registered as a project is that project, else its repository's primary worktree (`resolvePrimaryWorktreeRoot`) names it, so a session in a worktree shows its project; a directory under `chatRoots` is `Chats`, since a chat's folder name is a generated id; anything else is its folder name. The project open in the UI is used only when neither names one, as for a form owned by no session, and for a space's chat, whose directory is a path inside the space and is never matched against host projects or run git in on the host.
  - `getCachedZenModels()`

## Constants

### Default values
- `DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH`: 250 (default max length for notification text).
- `NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS`: 20000 (notification SSE comment heartbeat interval).

## Settings object format

The `settings` parameter for `prepareNotificationLastMessage` supports `maxLastMessageLength` (number), the maximum length for the final notification text (default: 250). Legacy summarization settings may still exist in persisted settings but are ignored.

## Response contracts

### `truncateNotificationText`
- Returns empty string for non-string input.
- Returns original text if under max length.
- Returns `${text.slice(0, maxLength)}...` for truncated text.

### `prepareNotificationLastMessage`
- Returns empty string for empty/null message.
- Returns truncated original message. Model-backed notification summarization is retired.
- Normalizes markdown-like formatting to plain text before truncation.
- Always applies `maxLastMessageLength` truncation to final result.

## Notes for contributors

### Why open windows follow the server's presence

Each window decides from its own focus, and a hidden one shows a notification because it is not focused, so every open tab and device used to alert while the user worked in one of them. The server already keeps every UI's visibility for push, so it skips the window broadcast while any UI is visible; old clients still cached on a phone follow it too. The alternative, sending only to the device used last, was rejected: it drops the notification when the user walks away with the phone. A visible client that disappears without saying so keeps the others quiet until its report expires (30 seconds), as it does for push.

### Why interruption suppression is limited to steps

OpenCode uses `aborted` for both interrupted steps and exhausted auto-resume attempts. Only the step event identifies the interruption this filter suppresses; filtering terminal `session.error` events by that type would hide a failure that requires the user's attention.

### Adding new notification helpers
1. Add new helper functions to `packages/web/server/lib/notifications/message.js`.
2. Export functions that are intended for public use.
3. Follow existing patterns for input validation (e.g., type checking for strings).
4. Use `resolvePositiveNumber` for numeric parameters with fallbacks to maintain safe defaults.
5. Add corresponding unit tests in `packages/web/server/lib/notifications/message.test.js`.

### Error handling
- `prepareNotificationLastMessage` does not call model summarization.
- Invalid numeric parameters default to safe fallback values.
- Non-string inputs are handled gracefully (return empty string).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Unit tests should cover truncation behavior and edge cases (empty strings, invalid inputs).

## Browser event delivery

Web notifications subscribe to the shared `/api/openchamber/events` control
stream. The emitter sends each notification there and through the existing
global broadcaster. The broadcaster owns the main WebSocket and the legacy
`/api/notifications/stream` endpoint, which remains available to older clients.
Do not call both global and control broadcasters for one notification: they
share the WebSocket client set and would send each frame twice.

The web hook preserves `tag`, `sessionId`, `kind`, and the remaining notification
fields so the web notification API recognizes duplicate control-SSE and main-WS
delivery. Its existing five-second claim suppresses duplicate native alerts.
Native alerts remain best-effort live events, with no historical replay or
synthetic catch-up alerts. Unread marks are OpenCode session state (`packages/ui/src/sync/session-unread.ts`).

This removes one persistent HTTP connection per browser tab in both main-WS and
main-SSE modes. Two tabs use two control SSE connections, or four connections
when their main event pipelines also use SSE. It does not make HTTP/1.1 support
an unlimited number of tabs. The notification hook retains the app's background
work enablement, settings, focus, and runtime gates; it no longer opens a second
connection or switches sources when the main pipeline changes transport.

The control stream retains its browser-control capability declaration, runtime
switch cleanup, stale-source rejection, heartbeat, and reconnect-ready events.
Electron uses its native notification path; VS Code does not subscribe to this
server-only stream. Mobile shells retain their existing push behavior.
