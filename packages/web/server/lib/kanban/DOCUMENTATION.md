# Kanban Module Documentation

## Purpose

This module provides persisted, server-authoritative Kanban board operations including Phase 3 automation runtime.

- One board per project directory.
- JSON-file persistence in OpenChamber data dir.
- CRUD + move/reorder for columns/cards.
- Column automation: session dispatch on card entry, cascade moves on session idle.

## Module Structure

- `packages/web/server/lib/kanban/storage.js`
  - Storage file path resolution
  - Envelope read/write helpers
  - Sanitization of persisted data
  - Serialized mutation lock (`persistKanbanLock`)
- `packages/web/server/lib/kanban/service.js`
  - Domain operations for board/column/card behavior
  - Validation and not-found error types for route mapping
  - Restart reconciliation (stale `running` → `failed`)
  - Automation configuration endpoints
- `packages/web/server/lib/kanban/automation.js`
  - Runtime automation orchestration
  - In-memory state tracking (chains, sessions, column visits)
  - Session lifecycle integration (create, prompt, command, idle)
  - Cascade detection (cycles, max steps)
- `packages/web/server/lib/kanban/index.js`
  - Public export surface for route layer imports

## Storage Envelope

- File: `<OPENCHAMBER_DATA_DIR>/kanban-boards.json`
- Default base dir: `~/.config/openchamber`
- Keying: `boardsByProject` keyed by normalized absolute project directory

```js
{
  version: 1,
  boardsByProject: {
    "/abs/project/path": {
      id: string,
      columns: Array<{ id: string; name?: string; title?: string; order: number; automation?: Automation }>,
      cards: Array<{
        id: string,
        title: string,
        description: string,
        worktreeId: string,
        columnId: string,
        order: number,
        updatedAt: number,
        status?: 'running' | 'done' | 'failed',
        sessionId?: string
      }>,
      updatedAt: number
    }
  }
}

type Automation = {
  onEnterText: string,
  agent: string,
  providerID: string,
  modelID: string,
  variant?: string,
  onFinishMoveTo?: string
}
```

Notes:

- `name` is the canonical column field for UI contract.
- `title` is accepted for backward compatibility when sanitizing old persisted entries.
- Corrupted JSON parsing throws explicit read errors (not silently swallowed).

## Sanitization Invariants

On read/write, data is normalized with these rules:

1. Empty/invalid IDs are dropped.
2. Required card fields must be non-empty (`title`, `description`, `worktreeId`, `columnId`).
3. Cards pointing to missing columns are dropped.
4. Column/card ordering is normalized.
5. `updatedAt` is coerced to numeric timestamp fallback.
6. Optional `status` (valid: `'running' | 'done' | 'failed'`) and `sessionId` are preserved when valid.
7. Column `automation` is preserved when fields are non-empty strings.

## Concurrency Model

- `runSerializedKanbanMutation(mutator)` serializes writes through `persistKanbanLock`.
- Mutation flow:
  1. Read current envelope
  2. Apply mutator
  3. Sanitize + write envelope
- Concurrency semantics are last-write-wins (Phase 2 scope).

## Public Service API

Exported by `service.js` and re-exported by `index.js`:

- `getOrCreateBoard(projectDirectory)` - performs restart reconciliation on first read
- `createColumn(projectDirectory, { name, afterColumnId? })`
- `updateColumnAutomation(projectDirectory, columnId, { onEnterText?, agent?, providerID?, modelID?, variant?, onFinishMoveTo? })`
- `renameColumn(projectDirectory, columnId, { name })`
- `deleteColumn(projectDirectory, columnId)`
- `createCard(projectDirectory, { columnId, title, description, worktreeId })`
- `updateCard(projectDirectory, cardId, { title?, description?, worktreeId? })`
- `deleteCard(projectDirectory, cardId)` - throws `KanbanConflictError` if card is running
- `moveCard(projectDirectory, cardId, { toColumnId, toOrder })` - throws `KanbanConflictError` if card is running
- `updateCardRuntimeState(projectDirectory, cardId, { status?, sessionId? })` - for automation runtime updates
- `moveCardByAutomation(projectDirectory, cardId, { toColumnId, toOrder })` - bypasses status check

All mutation methods return full updated board payload (`{ board }`).
Board load returns `{ board, projectDirectory }`.

## Route Error Mapping Contract

Service errors are intended for route mapping in `packages/web/server/index.js`:

- `KanbanValidationError` -> `400` with `{ error: string }`
- `KanbanNotFoundError` -> `404` with `{ error: string }`
- `KanbanConflictError` -> `409` with `{ error: string }`
- Any other error -> `500` with `{ error: string }`

## Phase 3 Automation

### Storage Schema Updates

Column automation configuration:

```js
{
  onEnterText: string,      // Required to enable automation
  agent: string,            // Required when onEnterText is set
  providerID: string,       // Required when onEnterText is set
  modelID: string,          // Required when onEnterText is set
  variant?: string,         // Optional
  onFinishMoveTo?: string   // Optional: column ID to move card to when session idle
}
```

Card status enum (expanded):

- `'running'` - automation session active
- `'done'` - automation completed successfully
- `'failed'` - automation failed or stale on restart

### Restart Reconciliation

On first `getOrCreateBoard()` read after server restart:

- `reconciledProjects` Set tracks which projects have been reconciled
- Cards with `status === 'running'` are changed to `'failed'`, `sessionId` cleared
- `updatedAt` updated if any cards reconciled
- This happens once per project per server lifetime

### New Endpoint Contract

`PATCH /api/kanban/columns/:columnId/automation` (maps to `updateColumnAutomation`):

Request body (all optional, but requires full valid set to enable):

```js
{
  onEnterText?: string,    // Empty string disables automation
  agent?: string,
  providerID?: string,
  modelID?: string,
  variant?: string,
  onFinishMoveTo?: string  // Must reference existing column, cannot be same as current
}
```

Validation rules:
- If `onEnterText` is empty: automation disabled (other automation fields must also be empty)
- If `onEnterText` is non-empty: all required fields must be present
- `onFinishMoveTo` cannot target the same column (prevents self-loop)
- `onFinishMoveTo` must reference an existing column ID

### Runtime Module Responsibilities

`KanbanAutomationRuntime` class (in `automation.js`):

**In-memory state maps:**
- `activeChainByCardKey` → `{ projectDirectory, cardId, visitedColumns, stepCount, sessionId, startedAt }`
- `sessionToCardKey` → card key for reverse lookup
- `cardKeyToSessionId` → current session ID

**Key methods:**
- `startAutomationForCardEntry(projectDirectory, cardId, enteredColumnId)` - trigger on card move/create
- `handleSessionIdle(sessionId)` - cascade when session completes
- `dispose()` - clear all in-memory state

**Automation flow:**
1. Card enters automated column
2. Runtime parses `onEnterText` (command or prompt)
3. Creates session, sets card `status: 'running'`
4. Sends prompt/command with `agent`, `providerID`, `modelID`, `variant`
5. On session idle:
   - Sets card `status: 'done'`
   - If `onFinishMoveTo` exists: moves card to target column
   - If target column has automation: restarts flow
   - Cycle detection: fails if column re-visited
   - Max steps: fails after `MAX_CASCADE_STEPS` (default: 10)

**Error handling:**
- On any error: marks card `status: 'failed'`, clears `sessionId`, calls `onError` callback
- Tracks chain state to prevent infinite loops
