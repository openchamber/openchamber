# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation, plain-text normalization, and optional message summarization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables, zen-model helpers, and session text/title enrichment runtime.
- `packages/web/server/lib/notifications/message.js`: helper implementation module.
- `packages/web/server/lib/notifications/message.test.js`: unit tests for notification message helpers.

## Public exports

### Notifications API (re-exported from message.js)
- `truncateNotificationText(text, maxLength)`: Truncates text to specified max length, appending `...` if truncated.
- `prepareNotificationLastMessage({ message, settings, summarize })`: Prepares the last message for notification display, with optional summarization support.

### Route registration API (routes.js)
- `registerNotificationRoutes(app, dependencies)`: Registers notification-owned endpoints:
  - `GET /api/push/vapid-public-key`
  - `POST /api/push/subscribe`
  - `DELETE /api/push/subscribe`
  - `POST /api/push/visibility`
  - `GET /api/push/visibility`
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
  - completion/error/question/permission trigger routing
  - session parent cache for subtask suppression
  - template resolution and fallback behavior
  - native notification fanout and web push payload fanout

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

### Emitter runtime API (emitter-runtime.js)
- `createNotificationEmitterRuntime(dependencies)`: creates runtime for unified notification emission channels.
- Returned API:
  - `writeSseEvent(res, payload)`
  - `emitDesktopNotification(payload)`
  - `broadcastUiNotification(payload)`

### Template runtime API (template-runtime.js)
- `createNotificationTemplateRuntime(dependencies)`: creates shared notification/template runtime and consumes shared text summarization from `packages/web/server/lib/text/summarization.js` in `notification` mode.
- Returned API:
  - `resolveNotificationTemplate(template, variables)`
  - `shouldApplyResolvedTemplateMessage(template, resolved, variables)`
  - `fetchFreeZenModels()`
  - `resolveZenModel(override)`
  - `validateZenModelAtStartup()`
  - `summarizeText(text, targetLength, zenModel)`
  - `extractLastMessageText(payload, maxLength?)`
  - `fetchLastAssistantMessageText(sessionId, messageId, maxLength?)`
  - `maybeCacheSessionInfoFromEvent(payload)`
  - `buildTemplateVariables(payload, sessionId)`
  - `getCachedZenModels()`

## Constants

### Default values
- `DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH`: 250 (default max length for notification text).
- `DEFAULT_NOTIFICATION_SUMMARY_THRESHOLD`: 200 (minimum message length to trigger summarization).
- `DEFAULT_NOTIFICATION_SUMMARY_LENGTH`: 100 (target length for summarized messages).

## Settings object format

The `settings` parameter for `prepareNotificationLastMessage` supports:
- `summarizeLastMessage` (boolean): Whether to enable summarization for long messages.
- `summaryThreshold` (number): Minimum message length to trigger summarization (default: 200).
- `summaryLength` (number): Target length for summarized messages (default: 100).
- `maxLastMessageLength` (number): Maximum length for the final notification text (default: 250).

## Response contracts

### `truncateNotificationText`
- Returns empty string for non-string input.
- Returns original text if under max length.
- Returns `${text.slice(0, maxLength)}...` for truncated text.

### `prepareNotificationLastMessage`
- Returns empty string for empty/null message.
- Returns truncated original message if summarization disabled, message under threshold, or summarization fails.
- Returns truncated summary if summarization succeeds and returns non-empty string.
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
- `prepareNotificationLastMessage` catches summarization errors and falls back to original message.
- Invalid numeric parameters default to safe fallback values.
- Non-string inputs are handled gracefully (return empty string).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Unit tests should cover truncation behavior, summarization success/failure, and edge cases (empty strings, invalid inputs).
