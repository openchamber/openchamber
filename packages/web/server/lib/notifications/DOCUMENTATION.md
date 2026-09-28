# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation and plain-text normalization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery. Two modes: **relay** (default — sign + POST tokens + generic text to the central Cloudflare relay `https://api.openchamber.dev/v1/push/send`, which holds the single project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/emit-route.js`: `POST /api/notifications/emit` for OpenCode plugins.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
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
  - `GET /api/sessions/attention`
  - `GET /api/sessions/:id/attention`
  - `POST /api/sessions/:id/view`
  - `POST /api/sessions/:id/unview`
  - `POST /api/sessions/:id/message-sent`

### Trigger runtime API (runtime.js)
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned debounced trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload)`
- Owns:
  - completion/error/question/permission trigger routing; permission suppression consults the authoritative permission-auto-accept runtime
  - session parent cache for subtask suppression
  - no ready notification on a `session.idle` while a subagent of that session is still running (a background-subagent pause; OpenCode runs the parent again with the result and its next idle announces). The check comes from `../opencode/session-activity.js`; when it cannot be made, the idle announces as before
  - template resolution and fallback behavior
  - native notification fanout and web push payload fanout
  - push suppression while any fresh UI visibility heartbeat reports a focused client

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
  - `sendApnsToAllUiSessions(payload)` — signs + sends to all registered tokens (no UI-visibility gate; iOS suppresses the foreground banner). No-ops with a single warning when APNs is unconfigured. Drops tokens on `410` / `BadDeviceToken` / `Unregistered`.
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
- Follows `nativeNotificationsEnabled` (returns `{ delivered: false }`) and `notificationMode` (`requireHidden`); `showWhenFocused: true` sends `requireHidden: false` so the notice shows even while OpenChamber is focused. Live delivery only: no web push or APNs fanout.
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
  - `fetchLastAssistantMessageText(sessionId, messageId, maxLength?)`
  - `maybeCacheSessionInfoFromEvent(payload)`
  - `buildTemplateVariables(payload, sessionId)`
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
synthetic catch-up alerts. Authoritative session attention is owned by sync.

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
