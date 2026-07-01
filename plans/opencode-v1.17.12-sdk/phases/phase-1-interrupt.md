# Phase 1: `session.interrupt()` — Server-Side Abort Propagation

## Summary

Replace `session.abort()` with `session.interrupt()` (new in OpenCode SDK v1.17.12) so the STOP button actually cancels the upstream LLM provider request instead of just marking the session idle locally.

## Files

| File | Change |
|------|--------|
| `packages/ui/src/sync/session-actions.ts` | 3 call sites: `abortCurrentOperation()` (L717), `revertToMessage()` (L910), `unrevertSession()` (L1042) |
| `packages/ui/src/sync/session-actions.test.ts` | Add `interrupt` mock |
| `packages/vscode/src/bridge-git-special-runtime.ts` | Add `interrupt()` before `delete()` in cleanup (L260) |
| `package.json` (root + 3 packages) | Bump SDK to `^1.17.12` |

## Risk

**Low.** `interrupt()` is a superset of `abort()` — it does everything `abort()` does plus propagates to upstream provider. If the SDK doesn't support it on older OpenCode versions, add a try/catch fallback to `abort()`.

## Validation

```bash
bun run type-check --filter @openchamber/ui
bun test packages/ui/src/sync/session-actions.test.ts
```

Manual: press STOP during active generation, verify session transitions to idle immediately.
