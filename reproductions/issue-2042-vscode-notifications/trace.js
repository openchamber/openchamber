/**
 * Reproduction trace for issue #2042:
 * VS Code extension — no notification when agent task completes
 *
 * This script traces the notification code paths to demonstrate why
 * VS Code notifications don't fire while desktop notifications do.
 *
 * Run with: node trace.js
 */

console.log("=== Issue #2042: VS Code extension notification gap ===\n");

// ---------------------------------------------------------------------------
// 1. Desktop path — works because the web server runs
// ---------------------------------------------------------------------------
console.log("1. DESKTOP (Electron) notification path:");

const desktopPath = `
  OpenCode SSE event: message.updated (role=assistant, finish=stop)
    ↓
  packages/web/server/index.js (onPayload handler at line ~722)
    ↓
  maybeSendPushForTrigger(payload) — packages/web/server/lib/notifications/runtime.js
    ↓  (checks OpenCode settings, NOT UI store settings)
  emitDesktopNotification(payload) — packages/web/server/lib/notifications/emitter-runtime.js
    ↓
  onDesktopNotification callback — injected at startup (electron/main.mjs:1235)
    ↓
  maybeShowNativeNotification(payload) — electron/main.mjs:996
    ↓
  new Notification(title, { body }) — NATIVE OS NOTIFICATION ✓
`;
console.log(desktopPath);
console.log("  → Bypasses UI store nativeNotificationsEnabled (default: false)");
console.log("  → Uses Electron's Notification API directly in main process\n");

// ---------------------------------------------------------------------------
// 2. VS Code path — broken because the web server doesn't run
// ---------------------------------------------------------------------------
console.log("2. VS CODE notification path:");

const vscodeBrokenPath = `
  OpenCode SSE event: message.updated (role=assistant, finish=stop)
    ↓
  SSE Proxy (packages/vscode/src/sseProxy.ts) — raw pipe to webview
    ↓
  Webview reconstructs SSE → OpenCode SDK processes events
    ↓
  Event pipeline (packages/ui/src/sync/event-pipeline.ts)
    ↓
  dispatchVSCodeRuntimeNotificationEvent(...) — sync-context.tsx:577
    ↓
  CustomEvent 'openchamber:vscode-notification-event' dispatched on window
    ↓
  Listener at packages/vscode/webview/main.tsx:1638
    ↓
  Line 1674: if (!settings.nativeNotificationsEnabled) return;
    ↓
  🔴 EARLY RETURN — nativeNotificationsEnabled defaults to FALSE
`;
console.log(vscodeBrokenPath);

// ---------------------------------------------------------------------------
// 3. The dead openchamber:notification path
// ---------------------------------------------------------------------------
console.log("3. The 'openchamber:notification' SSE event path (DEAD in VS Code):");

const deadPath = `
  This path requires the web server to be running:
  
  maybeSendPushForTrigger(payload) — runtime.js
    ↓
  broadcastUiNotification(payload) — emitter-runtime.js
    ↓
  Sends 'openchamber:notification' SSE event
    ↓
  handleUiNotificationEvent(payload) — sync-context.tsx:346
    ↓
  RuntimeAPIs.notifications.notifyAgentCompletion(payload)
    ↓
  createVSCodeNotificationsAPI — packages/vscode/webview/api/notifications.ts:28
    ↓
  new Notification(title, { body }) — if browser API available

  🔴 NEVER EXECUTES — the web server is NOT running in VS Code.
     The OpenChamber server (packages/web/server/index.js) is never started.
     Only the OpenCode server ('opencode serve') is spawned.
`;
console.log(deadPath);

// ---------------------------------------------------------------------------
// 4. Settings default value analysis
// ---------------------------------------------------------------------------
console.log("4. Settings default analysis:");

const settingsAnalysis = `
  packages/ui/src/stores/useUIStore.ts:886
    nativeNotificationsEnabled: false    ← DEFAULT

  packages/vscode/package.json:206-220
    configuration.properties: {
      "openchamber.apiUrl": { ... },        ← only these two
      "openchamber.opencodeBinary": { ... }  ← no notification setting
    }

  packages/vscode/src/bridge-settings-runtime.ts:269
    readSettings() returns:
      { ...persisted, themeVariant, lastDirectory, opencodeBinary }
    ↳ nativeNotificationsEnabled is NOT included unless previously persisted

  Conclusion: On a fresh install of the VS Code extension:
    - nativeNotificationsEnabled defaults to false
    - There is no VS Code configuration UI to change it
    - The only way to enable it is to open the OpenChamber settings panel
      (inside the webview) and toggle it on
`;
console.log(settingsAnalysis);

// ---------------------------------------------------------------------------
// 5. Summary of gaps
// ---------------------------------------------------------------------------
console.log("5. GAP ANALYSIS:");
const gaps = [
  {
    id: "GAP-1",
    title: "No web server → no server-side notification trigger",
    detail: "maybeSendPushForTrigger never runs. The openchamber:notification SSE events are never generated.",
    file: "packages/web/server/lib/notifications/runtime.js",
  },
  {
    id: "GAP-2",
    title: "nativeNotificationsEnabled defaults to false with no VS Code override",
    detail: "The only client-side notification path (browser Notification API in webview) returns early.",
    file: "packages/ui/src/stores/useUIStore.ts:886",
  },
  {
    id: "GAP-3",
    title: "No VS Code configuration property for nativeNotificationsEnabled",
    detail: "Users can't enable notifications via VS Code's standard Settings UI.",
    file: "packages/vscode/package.json:206-220",
  },
  {
    id: "GAP-4",
    title: "No vscode.window.showInformationMessage integration",
    detail: "The extension host never calls the VS Code notification API for task completion.",
    file: "packages/vscode/src/extension.ts",
  },
  {
    id: "GAP-5",
    title: "sessionActivityWatcher doesn't trigger notifications",
    detail: "The watcher tracks idle/busy/cooldown but only posts activity to the webview, never triggers a notification.",
    file: "packages/vscode/src/sessionActivityWatcher.ts",
  },
];

for (const gap of gaps) {
  console.log(`  ${gap.id}: ${gap.title}`);
  console.log(`       ${gap.detail}`);
  console.log(`       → ${gap.file}`);
  console.log();
}

console.log("=== End of trace ===");
