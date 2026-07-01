# Phase 2 Implementation: `session.events()` — Per-Session Event Stream

## Prerequisite

Verify `session.events()` exists in SDK v1.17.12 types. Check `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` for a method on `Session2` or `Session3` named `events`.

If absent, skip this phase.

## Step 1: Add `subscribeSessionEvents()` to client.ts

File: `packages/ui/src/lib/opencode/client.ts`

Add after `getSessionMessages()` (line 553):

```typescript
/**
 * Subscribe to events for a single session.
 * Returns an async iterable that yields events until the signal is aborted.
 */
async *subscribeSessionEvents(
  sessionID: string,
  signal?: AbortSignal
): AsyncIterable<Event> {
  const result = await this.client.session.events({
    sessionID,
    ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
    signal,
  });
  for await (const event of result.stream) {
    yield event as unknown as Event;
  }
}
```

Note: need to import `Event` type at top of file:
```typescript
import type { Event } from "@opencode-ai/sdk/v2/client";
```

## Step 2: Use in ChatContainer

File: `packages/ui/src/components/chat/ChatContainer.tsx` (or wherever active session events are consumed)

Add a `useEffect` that subscribes to `session.events()` for the active session:

```typescript
useEffect(() => {
  if (!activeSessionId) return;
  const abort = new AbortController();

  const run = async () => {
    try {
      for await (const event of opencodeClient.subscribeSessionEvents(
        activeSessionId,
        abort.signal
      )) {
        // Apply event to session store directly — no directory routing needed
        applySessionEvent(activeSessionId, event);
      }
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") {
        console.error("[ChatContainer] session events error", error);
      }
    }
  };

  run();
  return () => abort.abort();
}, [activeSessionId]);
```

## Step 3: Keep global pipeline

Do NOT remove `event-pipeline.ts` or `global.event()`. The global pipeline is still needed for:
- Sidebar session status updates
- Notifications for non-active sessions
- Permission/question events for background sessions
- Global events (server.connected, global.disposed)

## Step 4: Validation

```bash
cd packages/ui && bun run type-check
```

Manual:
1. Open a session, send a message
2. Verify events arrive and chat updates
3. Switch to another session
4. Verify old session events stop, new session events start
5. Verify sidebar still updates for non-active sessions (via global pipeline)
