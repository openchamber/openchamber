# Daytona Sandbox Orchestration Module

## Purpose

This module provides Daytona sandbox lifecycle management for the OpenChamber backend server. Each chat session creates an isolated Daytona sandbox with OpenCode pre-installed. The frontend Android client communicates with OpenCode instances running inside these temporary sandboxes, enabling code generation, modification, and git operations in a fully isolated environment.

Sandboxes are automatically destroyed when:
- The user sends an explicit exit command
- The chat session is inactive for 10+ minutes (configurable)
- The server shuts down gracefully

## Architecture

```
Android Client <-> Express Server <-> Daytona Sandbox (OpenCode)
                        |
                   WsBridge (relay)
                   InactivityMonitor
                   SandboxRegistry
```

## Entrypoints and Structure

- `packages/web/server/lib/daytona/config.js`: Environment variable configuration resolution.
- `packages/web/server/lib/daytona/sandbox-registry.js`: In-memory registry tracking active sandboxes per session.
- `packages/web/server/lib/daytona/lifecycle.js`: Sandbox creation and destruction via the @daytona/sdk.
- `packages/web/server/lib/daytona/inactivity-monitor.js`: Periodic check for inactive sandboxes with auto-destroy.
- `packages/web/server/lib/daytona/ws-bridge.js`: WebSocket bridge between Express server and OpenCode in sandboxes.
- `packages/web/server/lib/daytona/service.js`: Composition entrypoint that wires all components together.

## Public Exports

### config.js
- `resolveDaytonaConfig()`: Reads environment variables and returns the resolved configuration object.
  - Returns `{ enabled, apiKey, apiUrl, sandboxImage, timeoutMs }`

### sandbox-registry.js
- `createSandboxRegistry()`: Creates an in-memory sandbox registry instance.
  - Returns `{ register, unregister, get, updateActivity, listActive, getAll }`

### lifecycle.js
- `createDaytonaSandboxLifecycle({ config, registry, logger })`: Creates the sandbox lifecycle manager.
  - Returns `{ createSandbox, destroySandbox, destroyAllSandboxes }`

### inactivity-monitor.js
- `createInactivityMonitor({ registry, lifecycle, config, logger, onTimeout })`: Creates the inactivity monitor.
  - Returns `{ start, stop, resetTimer, dispose }`

### ws-bridge.js
- `createWsBridge({ logger })`: Creates the WebSocket bridge manager.
  - Returns `{ connect, disconnect, relay, isConnected }`

### service.js
- `createDaytonaService({ logger, onSandboxTimeout })`: Main entrypoint that composes all modules.
  - Returns `{ config, registry, lifecycle, monitor, bridge, isEnabled, dispose }`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAYTONA_API_KEY` | Yes (for service to be enabled) | - | Daytona API authentication key |
| `DAYTONA_API_URL` | No | `https://app.daytona.io` | Daytona API base URL |
| `DAYTONA_SANDBOX_IMAGE` | No | `daytonaio/ai-opencode:latest` | Docker image for sandboxes |
| `DAYTONA_SANDBOX_TIMEOUT_MS` | No | `600000` (10 min) | Inactivity timeout in milliseconds |

## Usage Example

```javascript
import { createDaytonaService } from './service.js';

const daytona = createDaytonaService({
  onSandboxTimeout: (sessionId, sandboxId) => {
    console.log(`Sandbox ${sandboxId} timed out for session ${sessionId}`);
    // Notify frontend that the session sandbox was destroyed
  },
});

if (daytona.isEnabled()) {
  // Start the inactivity monitor
  daytona.monitor.start();

  // Create a sandbox for a new chat session
  const { sandboxId, openCodeUrl } = await daytona.lifecycle.createSandbox('session-123');

  // Connect the WebSocket bridge
  await daytona.bridge.connect('session-123', openCodeUrl);

  // Relay messages from frontend to OpenCode in the sandbox
  daytona.bridge.relay('session-123', { type: 'message', content: '...' });

  // Reset inactivity timer on user activity
  daytona.monitor.resetTimer('session-123');

  // Destroy sandbox when user exits
  await daytona.lifecycle.destroySandbox('session-123');
  daytona.bridge.disconnect('session-123');
}

// On server shutdown
await daytona.dispose();
```

## Registry Entry Schema

Each entry in the sandbox registry contains:

```javascript
{
  sandboxId: string,      // Daytona sandbox identifier
  sessionId: string,      // Chat session identifier
  openCodeUrl: string,    // URL to reach OpenCode in the sandbox
  createdAt: number,      // Unix timestamp (ms) when created
  lastActivityAt: number, // Unix timestamp (ms) of last activity
  status: string,         // "active" or other lifecycle states
}
```

## Notes for Contributors

- This module follows the `createXxxService()` factory pattern used by `packages/web/server/lib/relay/service.js`.
- All server code is plain JS ESM (import/export syntax, no transpilation).
- The service is disabled (no-op) when `DAYTONA_API_KEY` is not set.
- The inactivity monitor checks every 30 seconds and destroys sandboxes idle for longer than the configured timeout.
- The WebSocket bridge handles reconnection automatically (up to 5 attempts with exponential backoff).
- Sandbox images should have OpenCode pre-installed and configured to serve on port 4096.
