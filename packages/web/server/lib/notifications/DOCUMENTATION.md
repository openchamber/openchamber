# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation and plain-text normalization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/push-seal.js`: end-to-end sealing of native push text. A phone that registers with a `pushKey` (32 bytes, base64; made by the iOS shell in the App Group, by Android's `PushSealKey`) gets each notification as the generic scenario title, an empty body and `data.enc` = `v1.` + base64(nonce || AES-256-GCM ciphertext || tag) of `{ title, body }`. Each such device is its own relay send. The iOS Notification Service Extension and Android's `SealedPushMessagingService` open it; the relay sends a sealed push to Android as a data message (openchamber-website `apps/api/src/lib/fcm.ts`) so that service runs in the background. The sealed text is richer than the clear one: `runtime.js` passes `sealed` = the session name as title and what happened as body (the agent's reply; `Question:`, `Wants to run:` / `Wants to edit:` / `Wants to read:` / `Wants permission:`, `Error:` or the goal title before the detail), capped at 250 characters. When there is no such text, the phone opens the generic text. Phones without a key keep getting the generic text in the clear. Enterprise mode sends no `sealed` text and strips the session name, so the phone shows only the scenario title.
- `packages/web/server/lib/notifications/session-key.js`: the key both push stores group registrations under, a `sha256:` hash of the UI session token, never the token. Files written before the hashing are rewritten with hashed keys on first read. Both stores are written `0600`.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery. Two modes: **relay** (default — sign + POST tokens + generic text to the central Cloudflare relay `https://api.openchamber.dev/v1/push/send`, which holds the single project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`. In enterprise mode (`../enterprise-mode.js`) `fanoutPush` also drops the session name from APNs and sends web push with the scenario title, an empty body and the deep link only, since web push leaves through the browser vendor's push service. Desktop notifications and in-app toasts stay local and keep the full text.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/emit-route.js`: `POST /api/notifications/emit` for OpenCode plugins.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
- `packages/web/server/lib/notifications/template-locales.js`: the notification text OpenChamber writes itself, per interface language. An empty template field means "no custom text", so the notification uses these defaults and the settings page shows them as placeholders. `settings-runtime.js` no longer seeds English template text into an install; it clears the seed older builds wrote. The server keeps its own list because it cannot import `packages/ui`; an unknown tag falls back to English.
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
  - `POST /api/sessions/:id/view` and `POST /api/sessions/:id/message-sent`: only reset the native push badge. Whether a session is unread is OpenCode's own `time.viewed`.

### Trigger runtime API (runtime.js)
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned debounced trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload)`
- Owns:
  - completion/error/question/permission trigger routing (a page an agent shows that waits for the user's answer, `openchamber:page-waiting` from this server, notifies exactly like a form, with the page title as the ask); permission suppression consults the authoritative permission-auto-accept runtime
  - session parent cache for subtask suppression
  - no ready notification on a `session.idle` while a subagent of that session is still running (a background-subagent pause; OpenCode runs the parent again with the result and its next idle announces). The check comes from `../opencode/session-activity.js`; when it cannot be made, the idle announces as before
  - an MCP elicitation form (session id `global`, owned by no session) notifies without a session: no session title lookup, and the deep link opens the app
  - template resolution and fallback behavior: an empty field in `settings.notificationTemplates` resolves to the default for `settings.locale` (`template-locales.js`), so notification text follows the interface language unless the user wrote their own
  - native notification fanout and web push payload fanout
  - push suppression while any fresh UI visibility heartbeat reports a focused client
  - no ready notification for a turn that is a step of an auto-review (`isInAutoReview`, answered by `../auto-review`'s `speaksFor`); `notifyAutoReviewEnded` sends the review's one notification when it ends, under the completion toggle, with `review*` texts from `template-locales.js` and APNs type `review`
  - chats of isolated spaces: `maybeSendPushForTrigger(payload, { spaceId })` reads such a chat's record (title, parent, goal), its last reply and its running subagents inside the space, through `spaceFetchFor(spaceId)`, a `fetch` over the spaces dispatcher (`../spaces/space-fetch.js`), and never asks the host's OpenCode or the host's permission policy about it, since neither knows the chat. What comes back is the space's text, shown as it is shown in the sidebar. A space that cannot be asked gives the generic text, as a host chat whose reads fail does. The host's auto-accept is not consulted for a space's permission request, so such a request notifies after the debounce unless its reply arrives first.

### Push runtime API (push-runtime.js)
- `createPushRuntime(dependencies)`: creates runtime for web push and UI visibility state.
- Returned API:
  - `getOrCreateVapidKeys()`
  - `ensurePushInitialized()`
  - `setPushInitialized(value)`
  - `addOrUpdatePushSubscription(uiSessionToken, subscription, userAgent)`
  - `removePushSubscription(uiSessionToken, endpoint)`
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
  - `buildTemplateVariables(payload, sessionId, source?)`: `source` (`{ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl }`, the host's OpenCode by default) is where the session's title and messages are read; `runtime.js` passes the space's for a chat of an isolated space. `{project_name}`, `{worktree}` and `{branch}` come from the event's `directory`, else the session record's `location.directory`; turn-end events carry no location, so they read the record. `{project_name}` is the label of the project the sidebar files that directory under: a directory registered as a project is that project, else its repository's primary worktree (`resolvePrimaryWorktreeRoot`) names it, so a session in a worktree shows its project; a directory under `chatRoots` is `Chats`, since a chat's folder name is a generated id; anything else is its folder name. The project open in the UI is used only when neither names one, as for a form owned by no session, and for a space's chat, whose directory is a path inside the space and is never matched against host projects or run git in on the host.
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
