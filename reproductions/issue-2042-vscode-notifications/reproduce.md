# Reproduction Guide: VS Code Extension Task Completion Notifications

## Issue

When an AI agent completes a task in the VS Code extension, no notification is
shown to the user. On the desktop app, a native OS notification appears.

## Prerequisites

- VS Code with the OpenChamber extension installed
- An OpenCode server connected (or auto-started)
- A task that takes at least 30-60 seconds to complete

## Steps to Reproduce

1. Open VS Code
2. Open the OpenChamber panel (click the OpenChamber icon in the activity bar)
3. Start a long-running task (e.g., "Refactor this file to use TypeScript
   generics" in a large file)
4. Switch to another editor tab and start editing another file
5. Wait for the agent to complete the task (you may hear the agent's response
   being streamed but there's no visible notification)
6. Observe: No VS Code notification, no OS notification, no indication that
   the task is complete

## Expected Behavior

A notification should appear when the agent completes the task, consistent with
the desktop app behavior. This could be either:
- A VS Code native notification (`showInformationMessage`)
- An in-extension alert or toast
- An OS notification via the browser Notification API

## Debugging

To verify that events ARE flowing through the pipeline:

1. Open VS Code's Developer Tools for the webview (Developer: Toggle Developer
   Tools → Console)
2. Add a listener to see if `openchamber:vscode-notification-event` is firing:
   ```js
   window.addEventListener('openchamber:vscode-notification-event', (e) => {
     console.log('NOTIFICATION EVENT:', e.detail.payload.type);
   });
   ```
3. Start a task and wait for completion
4. Check if events appear in the console
5. If `message.updated` events appear with `role=assistant` and `finish=stop`,
   the event pipeline is working but the notification display path is blocked

## Root Cause (Brief)

See `README.md` for full analysis. Key blockers:

1. `nativeNotificationsEnabled` defaults to `false` — the webview listener at
   `packages/vscode/webview/main.tsx:1674` returns early
2. The server-side `maybeSendPushForTrigger` never runs — the OpenChamber web
   server is not started in VS Code
3. No VS Code configuration property exists for notification settings
4. No `vscode.window.showInformationMessage()` integration in the extension host
