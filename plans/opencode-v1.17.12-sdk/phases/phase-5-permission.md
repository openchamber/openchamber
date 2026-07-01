# Phase 5: `session.permission` — Programmatic Permission Endpoints

## Summary

Use new `session.permission.create` and `session.permission.fetch` endpoints for programmatic permission handling. These are new in SDK v1.17.12.

## Current state

OpenChamber handles permissions reactively via SSE events (`permission.asked`) and `permission.reply()`. Auto-accept flow in `sync-context.tsx` (line 1118-1143) iterates pending permissions and calls `respondToPermission()`.

## Target

Add `createPermission()` and `fetchPermission()` wrappers to `client.ts`. Use in auto-accept flow for programmatic permission creation.

## Files

| File | Change |
|------|--------|
| `packages/ui/src/lib/opencode/client.ts` | Add `createPermission()`, `fetchPermission()` wrappers |
| `packages/ui/src/sync/sync-context.tsx` | Use in auto-accept flow (optional) |

## New code

```typescript
// client.ts
async createPermission(
  sessionID: string,
  permission: string,
  directory?: string | null
): Promise<PermissionRequest | null> {
  const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
  const response = await this.client.session.permission.create({
    sessionID,
    permission,
    ...(requestDirectory ? { directory: requestDirectory } : {}),
  });
  return response.data ?? null;
}

async fetchPermission(
  sessionID: string,
  requestID: string,
  directory?: string | null
): Promise<PermissionRequest | null> {
  const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
  const response = await this.client.session.permission.fetch({
    sessionID,
    requestID,
    ...(requestDirectory ? { directory: requestDirectory } : {}),
  });
  return response.data ?? null;
}
```

## Risk

**Low.** Must verify `session.permission` exists in SDK v1.17.12. If absent, skip this phase.

## Validation

```bash
bun run type-check --filter @openchamber/ui
```
