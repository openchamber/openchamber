# Todo — OpenCode v1.17.12 SDK Migration

## Phase 1: `session.interrupt()` — server-side abort propagation

- [ ] Bump `@opencode-ai/sdk` to `^1.17.12` in all `package.json` files
- [ ] Add `session.interrupt()` mock to `session-actions.test.ts`
- [ ] Replace `session.abort()` → `session.interrupt()` in `abortCurrentOperation()` (line 717)
- [ ] Replace `session.abort()` → `session.interrupt()` in `revertToMessage()` (line 910)
- [ ] Replace `session.abort()` → `session.interrupt()` in `unrevertSession()` (line 1042)
- [ ] Add `interruptSession()` wrapper to `client.ts` (optional)
- [ ] Run `bun run type-check` in `packages/ui`
- [ ] Run `bun test packages/ui/src/sync/session-actions.test.ts`
- [ ] Manual: verify STOP button aborts session and propagates to provider

## Phase 2: `session.events()` — per-session event stream

- [ ] Verify `session.events()` exists in SDK v1.17.12 types
- [ ] Add `subscribeSessionEvents()` to `client.ts`
- [ ] Use per-session stream in ChatContainer (reduce global firehose routing)
- [ ] Keep global pipeline as fallback for non-active sessions
- [ ] Run `bun run type-check` in `packages/ui`
- [ ] Manual: verify events arrive for active session only

## Phase 3: `session.message()` — targeted message lookup

- [ ] Add `getMessage()` wrapper to `client.ts`
- [ ] Use in `revertToMessage()` instead of `session.messages()` + filter
- [ ] Use in `forkFromMessage()` instead of `session.messages()` + filter
- [ ] Run `bun run type-check` in `packages/ui`
- [ ] Manual: verify revert/fork still works

## Phase 4: `Session3.messages()` — cursor pagination

- [ ] Switch `session.messages()` calls from `Session2` to `Session3` API
- [ ] Pass `cursor` param in `fetchMessages()` (`use-sync.ts` line 326)
- [ ] Pass `cursor` param in `materializeSessionFromServer()` (`sync-context.tsx` line 240)
- [ ] Pass `cursor` param in `resyncDirectoryAfterReconnect()` (`sync-context.tsx` line 1207)
- [ ] Pass `cursor` param in `refetchSessionMessages()` (`session-actions.ts` line 1010)
- [ ] Pass `cursor` param in `fetchMessagesForSession()` (`session-actions.ts` line 1147)
- [ ] Pass `cursor` param in `getSessionMessages()` (`client.ts` line 547)
- [ ] Run `bun run type-check` in `packages/ui`
- [ ] Manual: verify large session loading with cursor

## Phase 5: `session.permission` — programmatic endpoints

- [ ] Verify `session.permission.create` / `fetch` exist in SDK v1.17.12
- [ ] Add wrappers to `client.ts`
- [ ] Use in permission auto-accept flow (`sync-context.tsx` line 1118-1143)
- [ ] Run `bun run type-check` in `packages/ui`
- [ ] Manual: verify permission create/fetch flow

## Blockers

- SDK v1.17.12 must be published and installable
- `session.events()` and `session.permission` must be confirmed in SDK types
- `Session3` API compatibility with current `Session2` usage must be verified
