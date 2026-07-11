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
                   SSE/HTTP Proxy (proxy.js)
                   WebSocket Proxy (proxy.js attachDaytonaWsProxy)
                   InactivityMonitor
                   SandboxRegistry
```

The Express server acts as the intermediary between the frontend client and the
OpenCode instances running inside Daytona sandboxes. Communication uses:
- **SSE** for streaming events from OpenCode to the frontend
- **HTTP POST** for sending messages to OpenCode
- **WebSocket** for bidirectional real-time communication
- **Generic HTTP proxy** for all other OpenCode API calls

## Entrypoints and Structure

- `packages/web/server/lib/daytona/config.js`: Environment variable configuration resolution.
- `packages/web/server/lib/daytona/sandbox-registry.js`: In-memory registry tracking active sandboxes per session.
- `packages/web/server/lib/daytona/lifecycle.js`: Sandbox creation and destruction via the @daytona/sdk.
- `packages/web/server/lib/daytona/inactivity-monitor.js`: Periodic check for inactive sandboxes with auto-destroy.
- `packages/web/server/lib/daytona/proxy.js`: SSE, HTTP, and WebSocket proxy to OpenCode in sandboxes.
- `packages/web/server/lib/daytona/routes.js`: REST endpoints for sandbox lifecycle management.
- `packages/web/server/lib/daytona/service.js`: Composition entrypoint that wires all components together.

## Public Exports

### config.js
- `resolveDaytonaConfig()`: Reads environment variables and returns the resolved configuration object.
  - Returns `{ enabled, apiKey, apiUrl, sandboxImage, timeoutMs, openCodePort }`

### sandbox-registry.js
- `createSandboxRegistry()`: Creates an in-memory sandbox registry instance.
  - Returns `{ register, unregister, get, updateActivity, listActive, getAll }`

### lifecycle.js
- `createDaytonaSandboxLifecycle({ config, registry, logger })`: Creates the sandbox lifecycle manager.
  - Returns `{ createSandbox, destroySandbox, destroyAllSandboxes }`

### inactivity-monitor.js
- `createInactivityMonitor({ registry, lifecycle, config, logger, onTimeout })`: Creates the inactivity monitor.
  - Returns `{ start, stop, resetTimer, dispose }`

### proxy.js
- `registerDaytonaProxyRoutes(app, { daytonaService, uiAuthController, logger })`: Registers SSE, message, and generic proxy routes.
- `attachDaytonaWsProxy(server, { daytonaService, logger })`: Attaches WebSocket upgrade handler for proxying WS connections to sandbox OpenCode instances.
  - Returns `{ shutdown }`

### routes.js
- `registerDaytonaRoutes(app, { daytonaService, uiAuthController, logger })`: Registers REST endpoints for sandbox management.

### service.js
- `createDaytonaService({ logger, onSandboxTimeout })`: Main entrypoint that composes all modules.
  - Returns `{ config, registry, lifecycle, monitor, isEnabled, dispose }`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAYTONA_API_KEY` | Yes (for service to be enabled) | - | Daytona API authentication key |
| `DAYTONA_API_URL` | No | `https://app.daytona.io` | Daytona API base URL |
| `DAYTONA_SANDBOX_IMAGE` | No | `daytonaio/ai-opencode:latest` | Docker image for sandboxes |
| `DAYTONA_SANDBOX_TIMEOUT_MS` | No | `600000` (10 min) | Inactivity timeout in milliseconds |
| `DAYTONA_OPENCODE_PORT` | No | `4096` | Port where OpenCode listens inside the sandbox |

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

  // Reset inactivity timer on user activity
  daytona.monitor.resetTimer('session-123');

  // Destroy sandbox when user exits
  await daytona.lifecycle.destroySandbox('session-123');
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
  status: string,         // Internal status: "active" (mapped to "running" in API responses)
}
```

## Status Mapping

The registry stores `status: 'active'` internally. API responses normalize this
to `'running'` for consistency with the frontend status enum:

| Internal (registry) | External (API response) |
|---------------------|------------------------|
| `active`            | `running`              |

## Notes for Contributors

- This module follows the `createXxxService()` factory pattern used by `packages/web/server/lib/relay/service.js`.
- All server code is plain JS ESM (import/export syntax, no transpilation).
- The service is disabled (no-op) when `DAYTONA_API_KEY` is not set.
- The inactivity monitor checks every 30 seconds and destroys sandboxes idle for longer than the configured timeout.
- Sandbox images should have OpenCode pre-installed and configured to serve on the port specified by `DAYTONA_OPENCODE_PORT` (default 4096).
- The generic proxy middleware in `proxy.js` caches `http-proxy-middleware` instances per target URL to avoid per-request allocation overhead.
