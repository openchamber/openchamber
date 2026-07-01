# Phase 4: `session.permission` — Programmatic Endpoints

## Summary

Use `session.permission.create` and `session.permission.fetch` (new in OpenCode SDK v1.17.12) for programmatic permission handling — verify a permission is still relevant before auto-accepting it.

## Files

| File | Change |
|------|--------|
| `packages/ui/src/lib/opencode/client.ts` | Add `createPermission()`, `fetchPermission()` wrappers |
| `packages/ui/src/sync/sync-context.tsx` | Use in auto-accept flow (L1118-1143) |

## Risk

**Low.** Must verify `session.permission` exists in SDK v1.17.12. If absent, skip this phase.

## Validation

```bash
bun run type-check --filter @openchamber/ui
```

Manual: trigger a permission request, verify auto-accept flow works.
