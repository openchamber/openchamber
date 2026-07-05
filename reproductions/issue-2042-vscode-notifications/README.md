# Reproduction: VS Code extension — no notification when agent task completes

Issue: https://github.com/openchamber/openchamber/issues/2042

## Summary

The VS Code extension does not show any notification when an AI agent completes a
task (code generation, file modifications, etc.). On the desktop app, the same
completion pops a native OS notification. In VS Code, users must manually switch
back to the OpenChamber panel to check progress.

## Root Cause

### Architecture difference

The notification system has two independent paths:

**Desktop (Electron) notification path** — works correctly:

1. OpenCode server sends `message.updated` with `role=assistant` / `finish=stop`
   via SSE
2. The **OpenChamber web server** (`packages/web/server/index.js`) runs
   `maybeSendPushForTrigger` in
   `packages/web/server/lib/notifications/runtime.js`
3. That calls `emitDesktopNotification` → Electron's `maybeShowNativeNotification`
   → native OS `Notification` popup
4. **This path bypasses the UI store's `nativeNotificationsEnabled` setting** —
   it reads its own settings from the OpenCode server config

**VS Code notification path** — broken:

1. The VS Code extension **does NOT start the OpenChamber web server**. It spawns
   `opencode serve` directly and connects via a raw SSE proxy
   (`packages/vscode/src/sseProxy.ts`).
2. Without the web server, `maybeSendPushForTrigger` never runs, and the
   `openchamber:notification` SSE events it generates are never produced.
3. The fallback path uses the browser `Notification` API inside the webview
   (`packages/vscode/webview/main.tsx`), but this is gated behind
   `settings.nativeNotificationsEnabled` which **defaults to `false`**
   (`packages/ui/src/stores/useUIStore.ts`, line 886).
4. There is **no VS Code extension configuration property** for
   `nativeNotificationsEnabled` in `packages/vscode/package.json` — the only
   VS Code configuration properties are `openchamber.apiUrl` and
   `openchamber.opencodeBinary`.

### Specific code gaps

| Area | File | Issue |
|------|------|-------|
| Default setting | `packages/ui/src/stores/useUIStore.ts:886` | `nativeNotificationsEnabled: false` — no VS Code override to true |
| VS Code config | `packages/vscode/package.json:206-220` | No `openchamber.nativeNotificationsEnabled` property defined |
| Server notification trigger | `packages/web/server/lib/notifications/runtime.js` | `maybeSendPushForTrigger` never runs in VS Code (no web server) |
| SSE notification events | `packages/web/server/lib/notifications/emitter-runtime.js` | `openchamber:notification` events never generated in VS Code |
| Webview notification listener | `packages/vscode/webview/main.tsx:1674` | Early return when `nativeNotificationsEnabled` is false (the default) |
| VS Code native notification | `packages/vscode/src/extension.ts` | No `vscode.window.showInformationMessage()` call for task completion |
| Settings bridge sync | `packages/vscode/src/bridge-settings-runtime.ts` | No mapping of VS Code config to `nativeNotificationsEnabled` |
| UI notification path | `packages/ui/src/sync/sync-context.tsx:346` | `handleUiNotificationEvent` only fires for `openchamber:notification` events (never generated) |

## Reproduction steps

### Step 1: Verify the event pipeline dispatches events

The `dispatchVSCodeRuntimeNotificationEvent` function in
`packages/ui/src/sync/sync-context.tsx` (line 577) dispatches a custom DOM event
for every SSE event from the pipeline. This function is called at line 1900.

However, `SHOULD_DISPATCH_VSCODE_NOTIFICATIONS` (line 575) is set at module
scope via `isVSCodeRuntime()`, which checks
`getRegisteredRuntimeAPIs()?.runtime?.isVSCode`. This check depends on the
runtime APIs being registered before the module is first loaded.

### Step 2: Verify the webview listener processes events

The listener at `packages/vscode/webview/main.tsx:1638` processes
`openchamber:vscode-notification-event` and checks for `message.updated` with
`role=assistant` / `finish=stop`.

At line 1674, it returns early:

```typescript
if (!settings.nativeNotificationsEnabled) {
  return;
}
```

Since the default value is `false`, **no notification is ever shown** unless the
user manually opens the OpenChamber settings panel and toggles notification
enforcement on. There is no VS Code settings UI that surfaces this toggle.

### Step 3: Verify the `openchamber:notification` path is dead

The `handleUiNotificationEvent` function at
`packages/ui/src/sync/sync-context.tsx:346` only processes events with
`type === "openchamber:notification"`. These events are generated exclusively
by `broadcastUiNotification` in
`packages/web/server/lib/notifications/emitter-runtime.js`, which is only called
by `maybeSendPushForTrigger` in `runtime.js`. Since the web server is not
running in VS Code, these events are never produced.

## To fix

A proper fix would likely involve one or more of:

1. **Add a VS Code configuration property** for `openchamber.nativeNotificationsEnabled`
   with a default of `true`, and wire it into the settings sync bridge.

2. **Add a VS Code native notification path** using
   `vscode.window.showInformationMessage()` in the extension host, triggered by
   `session.idle` events from the global event watcher in
   `sessionActivityWatcher.ts`.

3. **Remove the `nativeNotificationsEnabled` gate** from the VS Code webview
   notification handler, since the browser `Notification` API is the only
   available path and should be tried unconditionally.

4. **Ensure the `nativeNotificationsEnabled` default is `true` for VS Code**
   (or set it during VS Code initialization).
