# Phase 3 Implementation: `session.message()` — Targeted Message Lookup

## Step 1: Add `getMessage()` wrapper to client.ts

File: `packages/ui/src/lib/opencode/client.ts`

Add after `getSessionMessages()` (line 553):

```typescript
/**
 * Fetch a single message by ID without loading the full session history.
 * Uses Session2.message() — already available in SDK v1.17.9.
 */
async getMessage(
  sessionID: string,
  messageID: string,
  directory?: string | null
): Promise<Message | null> {
  const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
  const response = await this.client.session.message({
    sessionID,
    messageID,
    ...(requestDirectory ? { directory: requestDirectory } : {}),
  });
  return (response.data as Message) ?? null;
}
```

## Step 2: Use in `revertToMessage()` (optional optimization)

File: `packages/ui/src/sync/session-actions.ts`

Current code (line 918-933) reads the target message from the store:

```typescript
const messages = state.message[sessionId] ?? []
const targetMsg = messages.find((m) => m.id === messageId)
```

This is fine when the message is already in the store. The `getMessage()` wrapper is useful when the message isn't cached — e.g., after eviction or for a session loaded from global sidebar.

Add a fallback fetch:

```typescript
let targetMsg = messages.find((m) => m.id === messageId)
if (!targetMsg) {
  // Message not in store — fetch from server
  const fetched = await opencodeClient.getMessage(sessionId, messageId, directory)
  if (fetched) {
    targetMsg = fetched
  }
}
```

## Step 3: Use in `forkFromMessage()` (optional optimization)

File: `packages/ui/src/sync/session-actions.ts`

Same pattern as revert — add fallback fetch when message not in store (line 1081):

```typescript
const parts = state.part[messageId] ?? []
// If parts not in store, fetch the message
if (parts.length === 0) {
  const fetched = await opencodeClient.getMessage(sessionId, messageId, directory)
  // ... extract parts from fetched message
}
```

## Step 4: Validation

```bash
cd packages/ui && bun run type-check
```

Manual: revert a message in a session that was evicted from cache, verify it works.
