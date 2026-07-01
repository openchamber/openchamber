# Phase 5 Implementation: `session.permission` — Programmatic Endpoints

## Prerequisite

Verify `session.permission.create` and `session.permission.fetch` exist in SDK v1.17.12 types. Check `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` for `Permission2` class (referenced by `Session3` at line 1672).

If absent, skip this phase.

## Step 1: Add wrappers to client.ts

File: `packages/ui/src/lib/opencode/client.ts`

Add after `replyToPermission()` (line 1108):

```typescript
/**
 * Create a permission request for a session.
 * New in SDK v1.17.12.
 */
async createPermission(
  sessionID: string,
  permission: string,
  options?: { message?: string; directory?: string | null }
): Promise<PermissionRequest | null> {
  const requestDirectory = this.normalizeCandidatePath(options?.directory ?? null) ?? this.currentDirectory;
  const response = await this.client.session.permission.create({
    sessionID,
    permission,
    ...(requestDirectory ? { directory: requestDirectory } : {}),
    ...(options?.message ? { message: options.message } : {}),
  });
  return (response.data as PermissionRequest) ?? null;
}

/**
 * Fetch a specific permission request by ID.
 * New in SDK v1.17.12.
 */
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
  return (response.data as PermissionRequest) ?? null;
}
```

## Step 2: Use in auto-accept flow (optional)

File: `packages/ui/src/sync/sync-context.tsx`, line 1118-1143

The auto-accept flow currently iterates `grouped` permissions and calls `respondToPermission()`. The new `fetchPermission()` could be used to verify a permission still exists before auto-accepting:

```typescript
// In auto-accept loop (line 1123-1134)
await Promise.all(autoAcceptingSessionIds.flatMap((sessionId) =>
  (grouped[sessionId] ?? []).map(async (permission) => {
    try {
      // Verify permission still exists before accepting
      const fresh = await opencodeClient.fetchPermission(
        permission.sessionID,
        permission.id
      );
      if (!fresh) return; // Permission already resolved
      await sessionActions.respondToPermission(permission.sessionID, permission.id, "once")
      // ...
    } catch {
      // Keep failed auto-accept permissions in UI state
    }
  }),
))
```

## Step 3: Validation

```bash
cd packages/ui && bun run type-check
```

Manual: trigger a permission request, verify auto-accept flow works.
