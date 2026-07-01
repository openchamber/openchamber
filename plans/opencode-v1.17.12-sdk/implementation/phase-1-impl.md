# Phase 1 Implementation: `session.interrupt()`

## Step 1: Bump SDK version

Update `@opencode-ai/sdk` from `^1.17.9` to `^1.17.12` in:

- `package.json` (root, line 94)
- `packages/web/package.json` (line 28)
- `packages/vscode/package.json` (line 247)
- `packages/ui/package.json` (line 43)

Then run `bun install`.

## Step 2: Update test mock

File: `packages/ui/src/sync/session-actions.test.ts`

Add `interrupt` mock alongside existing `abort` mock (line 50-53):

```typescript
interrupt: mock((params: Record<string, unknown>) => {
  replyCalls.push({ method: "session.interrupt", params })
  return Promise.resolve({ data: true })
}),
```

## Step 3: Replace `abort()` → `interrupt()` in session-actions.ts

### 3a. `abortCurrentOperation()` — line 715-721

```typescript
// BEFORE
export async function abortCurrentOperation(sessionId: string): Promise<void> {
  try {
    await sdk().session.abort({ sessionID: sessionId, directory: dir() })
  } catch (error) {
    console.error("[session-actions] abort failed", error)
  }
}

// AFTER
export async function abortCurrentOperation(sessionId: string): Promise<void> {
  try {
    await sdk().session.interrupt({ sessionID: sessionId, directory: dir() })
  } catch (error) {
    console.error("[session-actions] interrupt failed", error)
  }
}
```

### 3b. `revertToMessage()` — line 908-914

```typescript
// BEFORE
const status = state.session_status[sessionId]
if (status && status.type !== "idle") {
  try {
    await sdk().session.abort({ sessionID: sessionId, directory })
  } catch {
    // ignore abort errors
  }
}

// AFTER
const status = state.session_status[sessionId]
if (status && status.type !== "idle") {
  try {
    await sdk().session.interrupt({ sessionID: sessionId, directory })
  } catch {
    // ignore interrupt errors
  }
}
```

### 3c. `unrevertSession()` — line 1040-1046

```typescript
// BEFORE
const status = state.session_status[sessionId]
if (status && status.type !== "idle") {
  try {
    await sdk().session.abort({ sessionID: sessionId, directory })
  } catch {
    // ignore
  }
}

// AFTER
const status = state.session_status[sessionId]
if (status && status.type !== "idle") {
  try {
    await sdk().session.interrupt({ sessionID: sessionId, directory })
  } catch {
    // ignore
  }
}
```

## Step 4: Update VS Code bridge

File: `packages/vscode/src/bridge-git-special-runtime.ts`

Add `session.interrupt()` before `session.delete()` in cleanup (line 260-266):

```typescript
// AFTER
finally {
  if (sessionId) {
    try {
      await client.session.interrupt({ sessionID: sessionId }, { signal: AbortSignal.timeout(5_000) });
    } catch {
      // ignore
    }
    try {
      await client.session.delete({ sessionID: sessionId }, { signal: AbortSignal.timeout(5_000) });
    } catch {
      // ignore cleanup failures
    }
  }
}
```

## Step 5: Validation

```bash
cd packages/ui && bun run type-check
bun test packages/ui/src/sync/session-actions.test.ts
cd ../vscode && bun run type-check
```

Manual: press STOP during active generation, verify session transitions to idle and provider request is cancelled.
