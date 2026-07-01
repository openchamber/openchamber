# Phase 3: Migrate all message operations to Session3 API

## Summary

Switch `session.messages()` calls from `Session2` API (no cursor) to `Session3` V2 API (cursor-based pagination), and add `session.message()` for targeted single-message lookup. The `Session3` API already exists in SDK v1.17.9 — we just use the older `Session2`.

## Files

### Pagination (cursor)

| File | Line | Change |
|------|------|--------|
| `packages/ui/src/sync/use-sync.ts` | 326 | Pass `cursor` param in `fetchMessages()` |
| `packages/ui/src/sync/sync-context.tsx` | 240 | Pass `cursor` in `materializeSessionFromServer()` |
| `packages/ui/src/sync/sync-context.tsx` | 1207 | Pass `cursor` in `resyncDirectoryAfterReconnect()` |
| `packages/ui/src/sync/session-actions.ts` | 1010 | Pass `cursor` in `refetchSessionMessages()` |
| `packages/ui/src/sync/session-actions.ts` | 1147 | Pass `cursor` in `fetchMessagesForSession()` |
| `packages/ui/src/lib/opencode/client.ts` | 547 | Pass `cursor` in `getSessionMessages()` |

### Message lookup

| File | Change |
|------|--------|
| `packages/ui/src/lib/opencode/client.ts` | Add `getMessage()` wrapper using `Session3.message()` |
| `packages/ui/src/sync/session-actions.ts` | Fallback in `revertToMessage()` (L918), `forkFromMessage()` (L1081) |

## API difference

| Parameter | Session2 (current) | Session3 (target) |
|-----------|-------------------|-------------------|
| `directory` | Per-call param | Set at client creation via scoped client |
| `before` | String message ID | Replaced by `cursor` |
| `cursor` | Not supported | String cursor token |
| `order` | Not supported | `"asc"` / `"desc"` |
| `message()` | Exists (L1129) | Also exists on Session3 |

## Risk

**Medium.** `Session3` API has different parameter shape. Must verify compatibility:
- `directory` is set at client creation, not per-call
- `before` is replaced by `cursor`
- Response shape may differ

## Validation

```bash
bun run type-check --filter @openchamber/ui
```

Manual: load a session with 100+ messages, scroll up — verify cursor pagination works without jank. Revert an evicted session — verify it works without loading full history.
