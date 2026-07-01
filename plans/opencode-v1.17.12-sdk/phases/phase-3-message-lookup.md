# Phase 3: `session.message()` — Targeted Message Lookup

## Summary

Use `Session2.message({ sessionID, messageID })` for single-message lookup instead of `session.messages()` + filter. This method already exists in SDK v1.17.9 (sdk.gen.d.ts:1129) but OpenChamber doesn't use it.

## Current state

`revertToMessage()` and `forkFromMessage()` load all messages via `session.messages()` then filter by `messageID`:

```typescript
// session-actions.ts line 919
const messages = state.message[sessionId] ?? []
const targetMsg = messages.find((m) => m.id === messageId)
```

This works because messages are already in the store. But for cases where the message isn't cached, a targeted fetch is more efficient.

## Target

Add `getMessage()` wrapper to `client.ts` and use it where a single message is needed without loading the full history.

## Files

| File | Change |
|------|--------|
| `packages/ui/src/lib/opencode/client.ts` | Add `getMessage()` wrapper |
| `packages/ui/src/sync/session-actions.ts` | Use in `revertToMessage()`, `forkFromMessage()` (optional) |

## New code

```typescript
// client.ts
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
  return response.data ?? null;
}
```

## Risk

**Low.** This is an additive change — existing `session.messages()` calls remain.

## Validation

```bash
bun run type-check --filter @openchamber/ui
```
