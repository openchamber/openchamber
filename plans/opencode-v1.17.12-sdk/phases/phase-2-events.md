# Phase 2: `session.events()` — Per-Session Event Stream

## Summary

Use `session.events({ sessionID })` for the active session in ChatContainer instead of routing events from the global firehose through `resolveDirectoryFromRoutingIndex()`. This eliminates ~300 lines of directory routing complexity in `sync-context.tsx`.

## Current state

`event-pipeline.ts` subscribes to `global.event()` and routes every event to the correct child store via:
- `resolveEventDirectory()` — extract directory from event payload
- `resolveDirectoryFromRoutingIndex()` — 300+ lines of session→directory mapping
- `EventRoutingIndex` — `sessionDirectoryById`, `messageSessionById`, `sessionMessageIdsById` maps

## Target

ChatContainer subscribes to `session.events({ sessionID })` for the active session only. Global pipeline remains for sidebar status, notifications, and non-active sessions.

## Files

| File | Change |
|------|--------|
| `packages/ui/src/lib/opencode/client.ts` | Add `subscribeSessionEvents()` async generator |
| `packages/ui/src/sync/sync-context.tsx` | Use per-session stream in ChatContainer |
| `packages/ui/src/sync/event-pipeline.ts` | No change — keep global pipeline |

## New code

```typescript
// client.ts — new method
async *subscribeSessionEvents(
  sessionID: string,
  signal?: AbortSignal
): AsyncIterable<Event> {
  const result = await this.client.session.events({ sessionID, signal });
  for await (const event of result.stream) {
    yield event;
  }
}
```

## Risk

**Medium.** Must verify `session.events()` exists in SDK v1.17.12 types. If absent, skip this phase.

## Validation

```bash
bun run type-check --filter @openchamber/ui
```

Manual: open a session, send a message, verify events arrive. Switch sessions, verify old session events stop.
