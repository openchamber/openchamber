# Phase 2: `session.events()` — Per-Session Event Stream

## Summary

Use `session.events()` (new in OpenCode SDK v1.17.12) to subscribe to events for a single session instead of routing all events through the global firehose. Eliminates ~300 lines of directory routing code and fixes session-switch lag.

## Files

| File | Change |
|------|--------|
| `packages/ui/src/lib/opencode/client.ts` | Add `subscribeSessionEvents()` async generator |
| `packages/ui/src/sync/sync-context.tsx` | Use per-session stream in ChatContainer |

## Risk

**Medium.** Must verify `session.events()` exists in SDK v1.17.12 types. If absent, skip this phase.

## Validation

```bash
bun run type-check --filter @openchamber/ui
```

Manual: open a session, send a message, verify events arrive. Switch sessions, verify old session events stop.
