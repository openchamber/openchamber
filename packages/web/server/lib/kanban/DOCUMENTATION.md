# Kanban Module Documentation

## Purpose

This module provides persisted, server-authoritative Kanban board operations for Phase 2.

- One board per project directory.
- JSON-file persistence in OpenChamber data dir.
- CRUD + move/reorder for columns/cards.
- No automation runtime behavior in this phase.

## Module Structure

- `packages/web/server/lib/kanban/storage.js`
  - Storage file path resolution
  - Envelope read/write helpers
  - Sanitization of persisted data
  - Serialized mutation lock (`persistKanbanLock`)
- `packages/web/server/lib/kanban/service.js`
  - Domain operations for board/column/card behavior
  - Validation and not-found error types for route mapping
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
      columns: Array<{ id: string; name?: string; title?: string; order: number }>,
      cards: Array<{
        id: string,
        title: string,
        description: string,
        worktreeId: string,
        columnId: string,
        order: number,
        updatedAt: number,
        status?: 'running' | 'done',
        sessionId?: string
      }>,
      updatedAt: number
    }
  }
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
6. Optional `status` and `sessionId` are preserved when valid.

## Concurrency Model

- `runSerializedKanbanMutation(mutator)` serializes writes through `persistKanbanLock`.
- Mutation flow:
  1. Read current envelope
  2. Apply mutator
  3. Sanitize + write envelope
- Concurrency semantics are last-write-wins (Phase 2 scope).

## Public Service API

Exported by `service.js` and re-exported by `index.js`:

- `getOrCreateBoard(projectDirectory)`
- `createColumn(projectDirectory, { name, afterColumnId? })`
- `renameColumn(projectDirectory, columnId, { name })`
- `deleteColumn(projectDirectory, columnId)`
- `createCard(projectDirectory, { columnId, title, description, worktreeId })`
- `updateCard(projectDirectory, cardId, { title?, description?, worktreeId? })`
- `deleteCard(projectDirectory, cardId)`
- `moveCard(projectDirectory, cardId, { toColumnId, toOrder })`

All mutation methods return full updated board payload (`{ board }`).
Board load returns `{ board, projectDirectory }`.

## Route Error Mapping Contract

Service errors are intended for route mapping in `packages/web/server/index.js`:

- `KanbanValidationError` -> `400` with `{ error: string }`
- `KanbanNotFoundError` -> `404` with `{ error: string }`
- Any other error -> `500` with `{ error: string }`

## Phase 3 Hooks

Phase 2 keeps these forward-compatible fields persisted without automation behavior:

- `card.status?: 'running' | 'done'`
- `card.sessionId?: string`

Automation actions (session lifecycle moves, cascade behavior, etc.) remain out of scope.
