# Phase 2B — Linux Guardian Process

## Goal

Implement a Linux/POSIX guardian process that manages OpenCode child lifecycle and enables restart handoff using the Phase 2A v2 durable protocol.

## Scope

### In scope
1. **Guardian entrypoint** (`packages/web/bin/openchamber-guardian.js` or `packages/web/server/lib/guardian/`)
   - Standalone Node.js process that outlives web server restarts
   - Owns v2 SQLite store and master secret
   - Manages OpenCode child spawn, health monitoring, and graceful stop
   - Communicates via Unix domain socket (JSON-RPC or simple line protocol)
   - Handles SIGTERM/SIGINT for graceful shutdown, SIGHUP for config reload

2. **Guardian core module** (`guardian.js`)
   - Process spawn: uses existing `spawn()` logic but through v2 protocol
   - Health monitoring: periodic HTTP health checks to OpenCode child
   - Lease renewal: periodically renews v2 lease for active children
   - Handoff preparation: transitions record to `HandoffPrepared` state
   - Cleanup: periodically removes expired v2 records
   - PID file for singleton enforcement

3. **Guardian client module** (`guardian-client.js`)
   - IPC client for web server to communicate with guardian
   - Operations: spawn, stop, prepare-handoff, health, list
   - Auto-detects running guardian via PID file
   - Graceful fallback when guardian unavailable

4. **Lifecycle integration (minimal)**
   - `bootstrapOpenCodeAtStartup()`: detect existing guardian + active child
   - `restartOpenCode()`: if guardian active, request handoff preparation
   - Fallback to legacy behavior when guardian not available

### Out of scope (Phase 3+)
- Full CLI `restart --handoff` command wiring
- VS Code/Electron/mobile integration
- Session resume and agent loop restoration
- Cross-runtime handoff (web ↔ desktop)
- Automatic prompt replay or tool re-execution
- Changes to v1 protocol or legacy registry

## Architecture

### Guardian process

```
┌─────────────────────────────────────────────┐
│  openchamber-guardian (Node.js process)     │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │  Guardian Core                      │    │
│  │  - spawnManagedOpenCode()           │    │
│  │  - healthCheck(child)               │    │
│  │  - renewLease(incarnation)          │    │
│  │  - prepareHandoff(incarnation)      │    │
│  │  - stopChild(incarnation)           │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │  v2 Protocol (from Phase 2A)        │    │
│  │  - reserveLaunch()                  │    │
│  │  - beginLaunch()                    │    │
│  │  - bindSpawnedProcess()             │    │
│  │  - renewLease()                     │    │
│  │  - cleanup()                        │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │  Unix Socket IPC Server             │    │
│  │  - spawn, stop, health, list        │    │
│  │  - prepare-handoff, adopt           │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
         │                                     │
         │ spawn                               │ health
         ▼                                     │
┌─────────────────────────────────────────────┐
│  OpenCode Server (child process)              │
└─────────────────────────────────────────────┘
```

### IPC Protocol (Unix socket)

Socket path: `~/.local/state/openchamber/managed-opencode-handoff-v2/guardian.sock`

Request/response format: JSON lines (ndjson)

```json
{"id":"1","method":"spawn","params":{"port":8080,"binary":"opencode"}}
{"id":"1","result":{"incarnation":"...","pid":12345,"port":8080}}

{"id":"2","method":"prepare-handoff","params":{"incarnation":"..."}}
{"id":"2","result":{"status":"prepared"}}

{"id":"3","method":"stop","params":{"incarnation":"..."}}
{"id":"3","result":{"status":"stopped"}}

{"id":"4","method":"health","params":{"incarnation":"..."}}
{"id":"4","result":{"healthy":true,"pid":12345}}

{"id":"5","method":"list"}
{"id":"5","result":{"children":[{"incarnation":"...","pid":12345,"port":8080,"state":"active"}]}}
```

### Web server integration

```
bootstrapOpenCodeAtStartup()
  → detectGuardian()
    → if running: connect via guardian-client, query active children
      → if active child found: adopt (bind to existing port)
      → if no active child: proceed to start new
    → if not running: proceed with legacy path

restartOpenCode()
  → if guardian active:
    → guardian.prepareHandoff(currentIncarnation)
    → guardian.spawn(newPort)  // spawns successor
    → wait for successor health
    → guardian.stop(currentIncarnation)
    → adopt successor
  → else: legacy stop-then-start
```

## Acceptance criteria

- Guardian can spawn and stop OpenCode children
- Guardian survives web server restart (outlives parent)
- Web server can detect running guardian and adopt its children
- Web server can request handoff preparation through guardian
- Guardian renews v2 leases and cleans up expired records
- SIGTERM/SIGINT triggers graceful shutdown (stop all children)
- SIGHUP reloads config
- PID file prevents duplicate guardians
- All v2 security invariants from Phase 2A are maintained
- Tests use fake/mock children only (no real OpenCode processes)
- Legacy behavior preserved when guardian unavailable

## Risks

- Guardian process itself is a new failure surface
- IPC adds complexity and potential deadlock
- Singleton enforcement via PID file has edge cases
- Lease renewal must not fail silently
- Orphaned guardian processes need cleanup mechanism

## Implementation order

1. Guardian core module (spawn, stop, health, lease renewal)
2. IPC server (Unix socket, JSON protocol)
3. Guardian client (web server side)
4. Lifecycle integration (bootstrap, restart)
5. Entrypoint/CLI (`openchamber guardian` command)
6. Tests and validation
