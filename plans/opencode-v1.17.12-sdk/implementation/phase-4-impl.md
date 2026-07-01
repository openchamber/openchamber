# Phase 4 Implementation: `Session3.messages()` — Cursor Pagination

## Prerequisite

Verify `Session3` API compatibility. `Session3` is the V2 API (sdk.gen.d.ts:1585). It has different parameter shapes than `Session2`:

| Parameter | Session2 | Session3 |
|-----------|----------|----------|
| `directory` | Per-call param | Set at client creation |
| `before` | String message ID | Replaced by `cursor` |
| `cursor` | Not supported | String cursor token |
| `order` | Not supported | `"asc"` / `"desc"` |
| `limit` | Number | Number |

## Step 1: Switch `getSessionMessages()` in client.ts

File: `packages/ui/src/lib/opencode/client.ts`, line 546-553

```typescript
// BEFORE
async getSessionMessages(id: string, limit?: number): Promise<{ info: Message; parts: Part[] }[]> {
  const response = await this.client.session.messages({
    sessionID: id,
    ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  });
  return unwrapSdkData(response, 'session.messages');
}

// AFTER — add cursor support
async getSessionMessages(
  id: string,
  options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }
): Promise<{ info: Message; parts: Part[] }[]> {
  const response = await this.client.session.messages({
    sessionID: id,
    ...(typeof options?.limit === 'number' ? { limit: options.limit } : {}),
    ...(options?.cursor ? { cursor: options.cursor } : {}),
    ...(options?.order ? { order: options.order } : {}),
  });
  return unwrapSdkData(response, 'session.messages');
}
```

Note: `Session3` doesn't accept `directory` — it's set at client creation via `getScopedSdkClient(directory)`. Callers must use the scoped client.

## Step 2: Update `fetchMessages()` in use-sync.ts

File: `packages/ui/src/sync/use-sync.ts`, line 323-342

```typescript
// BEFORE (line 326)
const response = await sdk.session.messages({ sessionID, directory, limit, before })

// AFTER — use cursor instead of before
const response = await sdk.session.messages({
  sessionID,
  limit,
  ...(before ? { cursor: before } : {}),  // before IS the cursor
  order: "asc",
})
```

## Step 3: Update `materializeSessionFromServer()` in sync-context.tsx

File: `packages/ui/src/sync/sync-context.tsx`, line 240

```typescript
// BEFORE
const response = await scopedClient.session.messages({ sessionID, limit: SESSION_MATERIALIZATION_MESSAGE_LIMIT })

// AFTER
const response = await scopedClient.session.messages({
  sessionID,
  limit: SESSION_MATERIALIZATION_MESSAGE_LIMIT,
  order: "asc",
})
```

## Step 4: Update `resyncDirectoryAfterReconnect()` in sync-context.tsx

File: `packages/ui/src/sync/sync-context.tsx`, line 1207

```typescript
// BEFORE
const response = await scopedClient.session.messages({ sessionID: sessionId, limit: RECONNECT_MESSAGE_LIMIT })

// AFTER
const response = await scopedClient.session.messages({
  sessionID: sessionId,
  limit: RECONNECT_MESSAGE_LIMIT,
  order: "asc",
})
```

## Step 5: Update `refetchSessionMessages()` in session-actions.ts

File: `packages/ui/src/sync/session-actions.ts`, line 1010

```typescript
// BEFORE
const result = await sdk().session.messages({ sessionID: sessionId, directory, limit: MESSAGE_REFETCH_LIMIT })

// AFTER
const result = await sdk().session.messages({
  sessionID: sessionId,
  limit: MESSAGE_REFETCH_LIMIT,
  order: "asc",
})
```

## Step 6: Update `fetchMessagesForSession()` in session-actions.ts

File: `packages/ui/src/sync/session-actions.ts`, line 1147

```typescript
// BEFORE
const response = await s.session.messages({
  sessionID,
  directory: resolvedDir,
  limit: getFetchPageSize(),
})

// AFTER
const response = await s.session.messages({
  sessionID,
  limit: getFetchPageSize(),
  order: "asc",
})
```

## Step 7: Update `MultiRunFusionDialog.tsx`

File: `packages/ui/src/components/multirun/MultiRunFusionDialog.tsx`, line 44

```typescript
// BEFORE
opencodeClient.getSdkClient().session.messages({ ... })

// AFTER — same pattern, remove directory param if using Session3
```

## Step 8: Validation

```bash
cd packages/ui && bun run type-check
```

Manual:
1. Load a session with 100+ messages
2. Verify initial page loads
3. Scroll up to load older messages — verify cursor pagination works
4. Verify `x-next-cursor` header is read and passed to next request
