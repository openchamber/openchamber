# Phase 4: `Session3.messages()` — Cursor-Based Pagination

## Summary

Switch `session.messages()` calls from `Session2` API (no cursor) to `Session3` V2 API (cursor-based pagination). The `Session3` API already exists in SDK v1.17.9 (sdk.gen.d.ts:1665) but OpenChamber uses `Session2`.

## Current state

OpenChamber uses `Session2.messages({ sessionID, directory, limit, before })` — no cursor support. Cursor is read from response headers (`x-next-cursor`) but never passed as a request parameter.

## Target

Use `Session3.messages({ sessionID, limit, order, cursor })` with proper cursor-based pagination.

## Files

| File | Line | Change |
|------|------|--------|
| `packages/ui/src/sync/use-sync.ts` | 326 | Pass `cursor` param |
| `packages/ui/src/sync/sync-context.tsx` | 240 | Pass `cursor` in `materializeSessionFromServer()` |
| `packages/ui/src/sync/sync-context.tsx` | 1207 | Pass `cursor` in `resyncDirectoryAfterReconnect()` |
| `packages/ui/src/sync/session-actions.ts` | 1010 | Pass `cursor` in `refetchSessionMessages()` |
| `packages/ui/src/sync/session-actions.ts` | 1147 | Pass `cursor` in `fetchMessagesForSession()` |
| `packages/ui/src/lib/opencode/client.ts` | 547 | Pass `cursor` in `getSessionMessages()` |

## API difference

```typescript
// Session2 (current)
session.messages({ sessionID, directory, limit, before })

// Session3 (target)
session.messages({ sessionID, limit, order: "asc", cursor })
```

Note: `Session3` doesn't accept `directory` — it uses the client's scoped directory. `Session3` also doesn't accept `before` — uses `cursor` instead.

## Risk

**Medium.** `Session3` API has different parameter shape. Must verify compatibility:
- `directory` is set at client creation, not per-call
- `before` is replaced by `cursor`
- Response shape may differ

## Validation

```bash
bun run type-check --filter @openchamber/ui
```

Manual: load a session with 100+ messages, verify pagination works with cursor.
