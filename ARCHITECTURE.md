# Architecture

## Pattern Overview

**Overall:** Multi-runtime monorepo with embedded OpenCode server and cross-platform UI shells

**Key Characteristics:**
- Monorepo workspace with Bun (packages/web, packages/ui, packages/electron, packages/vscode)
- Express web server embeds and manages OpenCode server lifecycle
- Shared React UI consumed by web, desktop (Electron), and VS Code extension
- Runtime API contracts defined in shared UI package
- SSE/WebSocket event streaming for real-time sync between server and clients

## Layers

**Web Server (Express):**
- Purpose: Serves web UI assets, proxies OpenCode API, manages tunnel/network infrastructure
- Location: `packages/web/server/index.js`
- Contains: Express app, route registration, runtime initialization
- Depends on: OpenCode SDK, Express, tunnel providers (Cloudflare, ngrok)
- Used by: Browser clients, Electron desktop, VS Code webviews

**UI Runtime (React + Zustand):**
- Purpose: Provides visual interface for interacting with OpenCode
- Location: `packages/ui/src/`
- Contains: React components, Zustand stores, sync layer, runtime API contracts
- Depends on: React, Zustand, Base UI, Radix UI, Tailwind v4
- Used by: Web, Electron, VS Code entry points

**Desktop Shell (Electron):**
- Purpose: Native desktop window management, system integration, notifications
- Location: `packages/electron/main.mjs`
- Contains: Electron main process, window management, IPC handlers, SSH manager
- Depends on: Electron 41, electron-log, native modules (node-pty)
- Used by: End users on macOS/Windows

**VS Code Extension:**
- Purpose: Editor-native workflow with session panel, right-click actions, agent manager
- Location: `packages/vscode/src/extension.ts`
- Contains: Extension entry, panel providers, bridge to OpenCode
- Depends on: VS Code extension API, OpenCode SDK
- Used by: VS Code users

**OpenCode Integration:**
- Purpose: Embeds OpenCode server, manages lifecycle, exposes API to UI
- Location: `packages/web/server/lib/opencode/`
- Contains: Server startup, config management, session/runtime management
- Depends on: @opencode-ai/sdk, simple-git
- Used by: Web server, UI clients

## Data Flow

**Client-Server Sync (SSE Pipeline):**

1. OpenCode server emits events (session updates, messages, status) — `packages/web/server/lib/event-stream/runtime.js`
2. Global event hub broadcasts to all connected clients — `packages/web/server/lib/event-stream/global-hub.js`
3. WebSocket bridge maintains persistent connections — `packages/web/server/lib/event-stream/global-ws-bridge.js`
4. UI sync context consumes events and updates Zustand stores — `packages/ui/src/sync/sync-context.tsx`

**Request Flow (API Proxy):**

1. UI client calls `runtimeFetch()` — `packages/ui/src/lib/runtime-fetch.ts`
2. Request routes to OpenChamber server (Express)
3. Server proxies to OpenCode server with auth — `packages/web/server/lib/opencode/proxy.js`
4. Response streams back through proxy to client

**Tunnel Lifecycle:**

1. User requests tunnel start via UI — `packages/web/server/lib/tunnels/`
2. Server creates Cloudflare/ngrok tunnel provider
3. Tunnel provider registers connection and returns public URL
4. UI displays QR code or URL for client connection

## Key Abstractions

**RuntimeAPIs:**
- Purpose: Contract between UI and server for desktop/browser/VS Code interoperability
- Location: `packages/ui/src/lib/api/types.ts`
- Pattern: TypeScript interface defining available runtime capabilities

**runtimeFetch / runtimeUrl / runtimeAuth:**
- Purpose: Transport layer for UI to call server APIs
- Location: `packages/ui/src/lib/runtime-fetch.ts`, `packages/ui/src/lib/runtime-url.ts`, `packages/ui/src/lib/runtime-auth.ts`
- Pattern: Wrapper around fetch with auth token injection

**Zustand Store Split:**
- Purpose: Isolate state by change frequency and subscriber set
- Location: `packages/ui/src/stores/`
- Pattern: Multiple narrow stores (useSessionStore, useConfigStore, useGitStore, etc.) instead of single monolithic store

**Event Pipeline:**
- Purpose: Real-time UI updates from server events
- Location: `packages/ui/src/sync/event-pipeline.ts`
- Pattern: SSE consumer with reconnection logic, coalescing, and queue management

## Entry Points

**Web Entry:**
- Location: `packages/web/index.html` + `packages/web/src/main.tsx`
- Triggers: Browser navigation to OpenChamber URL
- Responsibilities: React app bootstrap, sync provider mounting, router initialization

**Desktop Entry:**
- Location: `packages/electron/main.mjs`
- Triggers: User launches OpenChamber.app / runs openchamber CLI
- Responsibilities: Electron app lifecycle, window creation, web server startup, IPC handling

**VS Code Entry:**
- Location: `packages/vscode/src/extension.ts`
- Triggers: User activates OpenChamber extension in VS Code
- Responsibilities: Register commands, create webview panels, handle workspace events

**CLI Entry:**
- Location: `packages/web/bin/cli.js`
- Triggers: User runs `openchamber` command
- Responsibilities: Parse CLI options, start server, manage tunnel lifecycle

## Error Handling

**Strategy:** Fail-closed with descriptive errors; graceful degradation where possible

- API proxy errors bubble up with status codes and error messages
- SSE disconnection triggers exponential backoff reconnect
- Permission denied errors show clear UI prompts
- Network errors are distinguished from empty-success responses

## Cross-Cutting Concerns

**Logging:** Server uses console.log/warn/error (piped to electron-log in Desktop); client uses browser console

**Caching:** In-memory caches for file content with LRU limits; TTL-based session caching; no persistent caching in UI

**Storage:** 
- Sessions stored as JSONL in OpenCode data directory
- User settings in OpenCode config
- Desktop: electron-store for app preferences
- VS Code: VS Code workspace state

**Notifications:** Server-side notification emitter with template runtime; push notifications via web-push; desktop notifications via Electron Notification API
