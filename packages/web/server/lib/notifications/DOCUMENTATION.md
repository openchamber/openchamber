# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation and plain-text normalization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/push-seal.js`: end-to-end sealing of native push text. A phone that registers with a `pushKey` (32 bytes, base64; made by the iOS shell in the App Group, by Android's `PushSealKey`) gets each notification as the generic scenario title, an empty body and `data.enc` = `v1.` + base64(nonce || AES-256-GCM ciphertext || tag) of `{ title, body }`. Each such device is its own relay send. The iOS Notification Service Extension and Android's `SealedPushMessagingService` open it; the relay sends a sealed push to Android as a data message (openchamber-website `apps/api/src/lib/fcm.ts`) so that service runs in the background. The sealed text is richer than the clear one: `runtime.js` passes `sealed` = the session name as title and what happened as body (the agent's reply; `Question:`, `Wants to run:` / `Wants to edit:` / `Wants to read:` / `Wants permission:`, `Error:` or the goal title before the detail), capped at 250 characters. When there is no such text, the phone opens the generic text. Phones without a key keep getting the generic text in the clear. Enterprise mode sends no `sealed` text and strips the session name, so the phone shows only the scenario title.
- `packages/web/server/lib/notifications/session-key.js`: the key both push stores group registrations under, a `sha256:` hash of the UI session token, never the token. Files written before the hashing are rewritten with hashed keys on first read. Both stores are written `0600`.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery. Two modes: **relay** (default — sign + POST tokens + generic text to the central Cloudflare relay `https://api.openchamber.dev/v1/push/send`, which holds the single project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`. In enterprise mode (`../enterprise-mode.js`) `fanoutPush` also drops the session name from APNs and sends web push with the scenario title, an empty body and the deep link only, since web push leaves through the browser vendor's push service. Desktop notifications and in-app toasts stay local and keep the full text.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/emit-route.js`: `POST /api/notifications/emit` for OpenCode plugins.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
- `packages/web/server/lib/notifications/center.js`: the notification center store (`createNotificationCenterRuntime`, `createNotificationCenterPersistence`); see "Notification center" below.
- `packages/web/server/lib/notifications/center-routes.js`: `GET /api/notification-center`, `POST /api/notification-center/read`, `POST /api/notification-center/remove` (`{ ids }`), `DELETE /api/notification-center`, registered by `routes.js` when a center is passed in.
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
  - `sendGoalSettlePush({ sessionId, directory, status, title, body })`
  - `notifyGoalSettle({ sessionId, directory, status, title, body })`: owns the
    center entry, desktop/UI alert and push for goal settlement. Goal callers
    use this operation without recording or alerting beforehand.
  - `sendBrowserHelpPush({ sessionId, guestId, title, body })` — the browser-help
    fanout (see "browser.requestHelp notification" below); `data.url` adds
    `&panel=<guestId>` to the session deep link so the client opens that
    guest's shared surface alongside the session.
- Owns:
  - completion/error/question/permission trigger routing (a page an agent shows that waits for the user's answer, `openchamber:page-waiting` from this server, notifies exactly like a form, with the page title as the ask); permission suppression consults the authoritative permission-auto-accept runtime
  - session parent cache for subtask suppression
  - no ready notification on a `session.idle` while a subagent of that session is still running (a background-subagent pause; OpenCode runs the parent again with the result and its next idle announces). The check comes from `../opencode/session-activity.js`; when it cannot be made, the idle announces as before
  - an MCP elicitation form (session id `global`, owned by no session) notifies without a session: no session title lookup, and the deep link opens the app
  - template resolution and fallback behavior
  - native notification fanout and web push payload fanout
  - push suppression while any fresh UI visibility heartbeat reports a focused client
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
  - `sendApnsToAllUiSessions(payload)` — `payload.sealed` (`{ title, body }`, optional) is what a phone with a push key opens; it is never sent in the clear. Signs + sends to all registered tokens (no UI-visibility gate; iOS suppresses the foreground banner). No-ops with a single warning when APNs is unconfigured. Drops tokens on `410` / `BadDeviceToken` / `Unregistered`.
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

## Notification center

Bot attention uses `upsertBot({ projectId, itemId, title, body, botState,
sessionId?, directory? })` and `resolveBot({ projectId, itemId })`. Upsert returns
`{ entry, changed }`; resolution returns changed center IDs. Both await an atomic
snapshot write and throw on failure. Pending `bot` entries are high priority,
keyed by project and item, and pinned independently of the 200-entry, 7-day
history. Reading, removing and clearing do not resolve or delete a pending bot.
Resolved bots return to ordinary retention. `requestId` is the item ID and
`action` is `{ type: 'bots', projectId, itemId }`, including before a session exists.
Changes preserve the center ID and publish `removed` then `added`; clients replace
that entry. `botState` distinguishes a question from a needs-you transition with
unchanged wording. A failed center load prevents writes from replacing unread data.

### Why pending bot requests are pinned

The item runtime owns their resolution and can wait longer than center history.
Keeping pending records in the same atomic snapshot preserves requests across
restart without a second file's ordering protocol. History retains its existing
limit and TTL independently of pinned requests.

### Bot alert destinations

`notifyBotAttention` delivers the already-recorded item without inserting another
center entry. Desktop and UI alerts carry `botTarget: { projectId, itemId }`;
`sessionId` and `directory` remain optional stage context, not the click destination.
Both UI stream parsers preserve this target and reject malformed or extra target
properties. Web notification data uses the local
`/?botsProject=<projectId>&botItem=<itemId>` route, including with a stage session.
Browser delivery omits navigation data for a foreign runtime or a runtime changed
while awaiting registration. Foreground clicks also retire navigation when their
captured runtime no longer matches. Service-worker notifications retain the existing
same-origin click path.
Electron routes foreign targets through saved-host resolution, never an arbitrary URL.

Native delivery still obeys `nativeNotificationsEnabled`, question/error toggles,
and hidden-only focus suppression. Web push and native-mobile push retain their
existing link encoding and redaction. The router owns target application; see
`packages/ui/src/lib/router/DOCUMENTATION.md`.

### Why native item targets instead of stage session links

An item can need attention before a stage session exists, and a later stage session
is not the item page. Structured project/item IDs preserve the same destination
in both cases without accepting a navigation URL across the desktop bridge.

Every notification this server raises is also kept as an entry, so a client
can list what it missed. Advertised as the `api.notification-center.v1`
server capability.

- Who records: the trigger runtime (ready, error, question, permission), the
  goal settle and browser-help paths in `index.js`, the plugin emitter
  (`emit-route.js`), and, in `index.js`, an OpenCode restart that cut off
  running turns (`restart`), a fix loop that settled or waits for push
  approval (`fix-loop`), a restack paused on a conflict in `pause` mode
  (`restack`, once per conflicting branch), the update check of this
  server's own OpenChamber finding a version and a start on a new version
  (`update`), OpenCode's `installation.update-available` (`opencode-update`)
  and a scheduled run that failed (`scheduled-task`). These last ones record
  only; they raise no alert they did not raise before. Every one is recorded
  where it starts on the server, so it reaches every client and is kept
  with all of them closed. An entry is recorded once the per-event toggle, subtask,
  goal, auto-accept and cooldown checks have passed, whether or not an alert
  goes out. `nativeNotificationsEnabled` gates the alert only, so the center
  still fills with alerts turned off (the plugin and browser-help paths stop
  before recording when it is off, as before).
- Entry: `{ id, createdAt, kind, priority, delivery, verdict, title, body,
  sessionId, directory, sessionName, requestId, action, readAt }`. `kind` is
  the trigger (`ready`, `error`, `question`, `permission`, `goal`,
  `browser-help`, `plugin`, and the v2 kinds `restart`, `fix-loop`,
  `restack`, `update`, `opencode-update`, `scheduled-task`). `directory` is
  the event's, else the one the trigger runtime saw for the session in a
  `session.created`/`session.updated`, else the session record's
  `location.directory`: OpenCode 2's execution events carry no location, so
  a finished or failed turn names only its session. A failed read records
  null and the notification goes out as before; a session of an isolated
  space keeps what its event said. `requestId` names what the entry waits
  on (form, page or permission request id, fix loop id, restack run id,
  update version); null otherwise and on older entries. `action` is what a
  click opens besides the session: `sessions` (every chat a restart cut
  off), `openchamber-update`, `opencode-update`, `scheduled-tasks`; null
  otherwise, and a malformed one is dropped. `recordOnce` skips an entry
  whose kind and `requestId` are already kept, so a repeated update check
  adds nothing. `priority`: questions, permissions, errors, browser help and a
  blocked goal are `high`; a turn Jev ranked low is `low`; the rest `normal`.
  `delivery`: `delivered` (went out on the channels the user has on),
  `focused` (none, the app was in front and `notificationMode` is
  `hidden-only`), `quiet` (none, Jev ranked the finished turn low). The
  title and body are the same templated text the desktop alert shows; they
  never leave this machine.
- Storage: `notification-center.json` in the data directory, mode `0600`,
  written through a temp file and rename, one second after a change. At most
  200 history entries and 7 days, resolved ones included; pending bot requests
  remain pinned separately. A start trims a larger
  file. A missing file is an empty center; an unreadable
   or malformed one is logged and displays empty without permitting writes to
   replace the unread snapshot; single entries that do not
  parse are dropped.
- Resolution: the center lists what is still open; an entry with
  `resolvedAt` is in the history. A finished turn resolves when it is read
  (viewing its session, a click, mark all read; turns read before this
  existed resolve on load). `resolve({ sessionId, kinds, requestId })`,
  called from `index.js`, resolves a session's finished turns and errors
  when a user message arrives there (`message.updated`, role user), a
  question when its form or waiting page settles (`form.settled`,
  `openchamber:page-settled`) and a permission when it is replied
  (`permission.replied`), narrowed to that request when the entry names one.
  A question a restart cut off ("Interrupted question waiting for you")
  resolves when the session's `pendingQuestion` is cleared.
  Resolving also marks read. Every other kind stays until it is read, removed
  or ages out. `remove(ids)` deletes entries.
- Read state lives on the server, so every client sees the same. Changes are
  broadcast on the control stream as `openchamber:notification-center.changed`
  (`{ change: 'added', entry }`, `{ change: 'read', ids, readAt }`,
  `{ change: 'resolved', ids, resolvedAt }`, `{ change: 'removed', ids }`,
  `{ change: 'cleared' }`); a client lists again after each
  `event-stream-ready`. Clients before v2 ignore `resolved` and `removed`;
  a resolution also sends `read` for the entries it read, and their list
  leaves resolved entries out.
- Compatibility: clients before v2.4.3 parse `kind` as the original seven
  and reject the whole list on any other. `GET /api/notification-center`
  lists only those kinds unless the client asks with `?version=2`
  (capability `api.notification-center.v2`); such clients parse entries one
  by one and drop one they cannot read. An `added` event with a new kind is
  ignored by older clients, which parse events with `safeParse`.
- A start on a new OpenChamber version records `OpenChamber updated to X`
  once (`createAppVersionMarker`, `notification-center-version.json` in the
  data directory, mode `0600`). The first start of a data directory has
  nothing to compare with and records nothing.
- An update is recorded only when the check is about this server's own app:
  `appType` `web` on a web server, `desktop` or `web` on the desktop's
  in-process server. A desktop app connected to a remote server asks about
  its own build, which that server does not install, so it records nothing
  there. The check runs only when a client asks; with every client closed,
  nothing is recorded until the next one does.
- Runtimes: web, desktop, hosted and native mobile read it over HTTP and the
  control stream (relayed on mobile). VS Code has no OpenChamber server and
  shows no center.

### Jev ranking of finished turns

Automation records may set `openchamber.automation.notify` to `attention`.
Their finished turns and completed goals record `low` and `quiet`, including
while focused, and emit no desktop alert, UI alert, web push or APNs. Missing,
invalid or `finish` policies retain existing delivery. Questions, permissions,
errors, blocked goals and exhausted budgets retain high priority and their
existing settings, focus and auto-accept gates.

The trigger caches the policy beside `parentID` for the same session,
directory and isolated-space identity, with the existing 60-second TTL.
Successful session reads populate both fields. Partial session updates preserve
the policy; an explicit metadata replacement updates or clears it. A failed
read remains unknown and is retried on a later notification, never cached as
an authoritative `finish`. There is no background refresh or directory fan-out.

`sendGoalSettlePush` also suppresses attention-only completed-goal pushes, but
cannot undo alerts a caller already emitted. Server composition must delegate
the whole goal settlement to `notifyGoalSettle` for quiet center delivery.

### Why automation policy shares the parent cache

The subtask check already reads the session record. Keeping the policy with
that result avoids a second metadata lookup and preserves directory and space
isolation. Failed reads leave both decisions unknown.

### Jev verdicts

Before a `ready` notification goes out, the trigger runtime asks
`awaitTurnVerdict` (session-work) for Jev's reading of the turn and waits up
to 8 seconds. `looks-done` and `trivial` make the entry `low` and `quiet`:
no desktop alert, no toast, no web push and no APNs. `review`,
`stopped-midway`, no answer, a failure or a timeout announce as before. A
wait that times out logs `[session-work] no Jev verdict for <session> within
8000 ms`. While the classification provider is rate limiting (a 429 with
`Retry-After`, see `../routing/DOCUMENTATION.md`), the turn is announced
unranked at once.
Errors, questions, permissions, goals, browser help and plugin notices never
wait for Jev. The setting is `notificationClassifierEnabled` (default on),
which only matters with a classification provider and completion
notifications on.

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

## `browser.requestHelp` notification

`notifyBrowserHelp` (built in `packages/web/server/index.js`, injected into
`browser-control/provider.js`) tells the person a `browser.requestHelp`
action needs them: a live in-app notification (`kind: 'plugin'`,
`requireHidden: false` so it shows even while OpenChamber is focused — this
one cannot wait) built the same way `createPluginNotificationEmitter` builds
one, plus a web-push/APNs fanout through
`notificationTriggerRuntime.sendBrowserHelpPush`, the same `fanoutPush` every
other trigger (ready, error, question, permission, goal-settle) uses. Both
halves are skipped when `nativeNotificationsEnabled === false`; there is no
separate rate window, unlike `POST /api/notifications/emit`, because the
browser-control router calls this at most once per `browser.requestHelp`
action, not on every agent tool call.

It is deliberately **not** gated by `agentNotifyToolEnabled` (`notify.send`'s
toggle): the user already opted into this by picking an extension as their
browser provider in Settings → OpenChamber Tools. A provider that answers
`browser.requestHelp` cannot make progress without the person seeing the
prompt — unlike `notify.send`, which pages the user about routine progress
they can choose to hear about or not. Gating it the same way would mean an
agent could reach a login wall with a provider selected and no way for
anyone to learn a person is needed, silently, from server logs alone.

The push payload's `data` carries `type: 'browser-help'` and a deep link
`/?session=<id>&panel=<guestId>` — `panel` is `ROUTE_PARAMS.PANEL` in
`packages/ui/src/lib/router`, parsed into `RouteState.guestPanelId` and
applied by `useRouter` through `openGuestPanelFromRoute`, which opens that
guest's context-panel surface once its directory is known. An unknown,
disabled, or unapproved guest id is ignored silently, and VS Code and mobile
never open it (guest panels do not exist on those runtimes).
