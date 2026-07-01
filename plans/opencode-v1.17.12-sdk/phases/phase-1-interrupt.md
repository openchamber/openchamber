# Phase 1: `session.interrupt()` — Server-Side Abort Propagation

## Summary

Replace `session.abort()` with `session.interrupt()` in 3 call sites. `interrupt()` propagates the abort signal to the upstream LLM provider (PR #34467 in OpenCode), cancelling the reader and returning 499 if the client disconnects. This fixes the "Esc abort times out before reaching server" problem (OpenCode #29975).

## Files

| File | Change |
|------|--------|
| `packages/ui/src/sync/session-actions.ts` | Replace 3 `session.abort()` calls |
| `packages/ui/src/sync/session-actions.test.ts` | Add `interrupt` mock |
| `packages/ui/src/lib/opencode/client.ts` | Add `interruptSession()` wrapper (optional) |
| `package.json` (root + 3 packages) | Bump SDK to `^1.17.12` |

## Call sites

### 1. `abortCurrentOperation()` — line 717

```typescript
// BEFORE
await sdk().session.abort({ sessionID: sessionId, directory: dir() })

// AFTER
await sdk().session.interrupt({ sessionID: sessionId, directory: dir() })
```

### 2. `revertToMessage()` — line 910

```typescript
// BEFORE
await sdk().session.abort({ sessionID: sessionId, directory })

// AFTER
await sdk().session.interrupt({ sessionID: sessionId, directory })
```

### 3. `unrevertSession()` — line 1042

```typescript
// BEFORE
await sdk().session.abort({ sessionID: sessionId, directory })

// AFTER
await sdk().session.interrupt({ sessionID: sessionId, directory })
```

## Risk

**Low.** `interrupt()` is a superset of `abort()` — it does everything `abort()` does plus propagates to upstream provider. If the SDK doesn't support it on older OpenCode versions, add a try/catch fallback to `abort()`.

## Validation

```bash
bun run type-check --filter @openchamber/ui
bun test packages/ui/src/sync/session-actions.test.ts
```

Manual: press STOP during active generation, verify session transitions to idle.
