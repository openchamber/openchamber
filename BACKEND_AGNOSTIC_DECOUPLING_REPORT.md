# Backend-Agnostic Decoupling Report

Status: working baseline achieved (Codex chat path functional), decoupling in progress.

## 1) What is done

### 1.1 Backend abstraction layer exists on server

Implemented:
- Backend registry + descriptors + availability/capabilities.
- Dedicated backend runtimes (`opencode`, `codex`) with adapter boundaries.
- Session-to-backend binding persistence so routing survives restart.

How it helps decoupling:
- Session execution no longer has to assume OpenCode by default.
- Backend-specific behavior can be isolated behind runtime adapters.

Files involved:
- `packages/web/server/lib/harness/backends.js`
- `packages/web/server/lib/harness/opencode-backend.js`
- `packages/web/server/lib/harness/codex-backend.js`
- `packages/web/server/lib/harness/session-bindings.js`
- `packages/web/server/index.js`


### 1.2 Backend control-surface contract added

Implemented:
- Shared backend control-surface types (`modeSelector`, `modelSelector`, `effortSelector`, `commandSelector`).
- API route to fetch effective control surface for backend/session context.

How it helps decoupling:
- UI can render controls from backend-provided schema instead of hardcoding OpenCode primitives.

Files involved:
- `packages/ui/src/lib/api/types.ts`
- `packages/ui/src/lib/opencode/client.ts`
- `packages/web/server/lib/opencode/openchamber-routes.js`


### 1.3 UI surfaces are backend-aware in core areas

Implemented:
- Backend selection integrated in model controls/composer flows.
- Settings sidebars (agents, commands, MCP, skills, providers) support backend switch + unsupported states.
- Backend identity visible in header/session list.
- New shared backend UI primitives (`BackendIcon`, `BackendSwitcher`, `BackendUnsupported`).

How it helps decoupling:
- Users interact with backend capabilities, not implicit OpenCode-only UI assumptions.

Files involved:
- `packages/ui/src/components/chat/ModelControls.tsx`
- `packages/ui/src/components/layout/Header.tsx`
- `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`
- `packages/ui/src/components/sections/shared/BackendSwitcher.tsx`
- `packages/ui/src/components/sections/shared/BackendUnsupported.tsx`
- `packages/ui/src/components/sections/*/*Sidebar.tsx` (agents/commands/mcp/skills/providers)


### 1.4 Codex backend integration path is present end-to-end (baseline)

Implemented:
- Codex app-server adapter over JSON-RPC subprocess.
- Codex session/message/abort/update/fork/revert paths.
- Codex-specific commands/prompts/MCP/skills settings routes.
- Session status/event merge with OpenCode proxy event streams.

How it helps decoupling:
- Adds a second real backend path, proving architecture is not OpenCode-only.

Files involved:
- `packages/web/server/lib/harness/codex-appserver.js`
- `packages/web/server/lib/harness/codex-backend.js`
- `packages/web/server/lib/opencode/proxy.js`
- `packages/web/server/lib/opencode/openchamber-routes.js`


### 1.5 Backend metadata/state propagated through stores

Implemented:
- Backend selection persisted per session and draft.
- Multi-run carries backend id.
- Defaults/settings include backend default and backend CLI paths.

How it helps decoupling:
- Backend choice becomes first-class state, not incidental derived behavior.

Files involved:
- `packages/ui/src/sync/selection-store.ts`
- `packages/ui/src/sync/session-ui-store.ts`
- `packages/ui/src/stores/useMultiRunStore.ts`
- `packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx`
- `packages/ui/src/components/sections/openchamber/BackendCliSettings.tsx`


## 2) What is partially done / still coupled

### 2.1 Runtime parity is incomplete

Observed:
- Web and VS Code backend capability behavior is not fully aligned.
- Some VS Code bridge logic rewrites metadata instead of fully routing by backend runtime semantics.

Impact:
- Same UI action may differ by runtime (web vs VS Code).
- Weakens backend-agnostic guarantee.

Key files:
- `packages/vscode/src/bridge-proxy-runtime.ts`
- `packages/web/server/lib/harness/backends.js`


### 2.2 Some UI logic still depends on OpenCode-shaped assumptions

Observed:
- Control-surface adoption is broad but not yet absolute.
- A few paths still infer behavior from OpenCode-era model/provider/session assumptions.

Impact:
- Edge cases can drift when backend contracts differ.

Key files:
- `packages/ui/src/components/chat/ModelControls.tsx`
- `packages/ui/src/components/chat/ChatInput.tsx`
- `packages/ui/src/stores/useConfigStore.ts`


### 2.3 Codex flow is working but not fully hardened

Observed:
- Core chat path works.
- Complex lifecycle edges (interrupt/revert/replay/restore under mixed states) need broader validation.

Impact:
- Higher regression risk under non-happy paths.

Key files:
- `packages/web/server/lib/harness/codex-appserver.js`
- `packages/web/server/lib/harness/codex-backend.js`
- `packages/web/server/lib/opencode/proxy.js`


## 3) What is not done yet

### 3.1 Full cross-runtime parity contract

Needed:
- One authoritative capability matrix used by web/desktop/vscode.
- Same backend routing semantics in all runtimes.

Completion criteria:
- Same backend selected + same user action => same behavior across runtimes.


### 3.2 Remove remaining OpenCode-specific assumptions from shared UI

Needed:
- Ensure shared UI consumes only backend control-surface and backend-neutral session contracts.
- Minimize fallback logic that presumes OpenCode provider/model layout.

Completion criteria:
- No shared UI path requires OpenCode-only semantics to function.


### 3.3 Coverage and validation matrix for backend/runtimes

Needed:
- Integration tests covering create/send/abort/command/revert/settings by backend.
- Validation for event streams, permission/question lifecycle, and restore after restart.

Completion criteria:
- CI checks prove baseline behavior for all supported backends and runtimes.


### 3.4 Naming and UX consistency cleanup

Needed:
- Final pass to remove residual OpenCode wording where behavior is now backend-generic.

Completion criteria:
- User-visible language consistently refers to backend/harness where appropriate.


## 4) How decoupling was implemented (technical approach)

### 4.1 Adapter boundary

Pattern used:
- Route layer delegates to backend runtime (`opencode`/`codex`) rather than embedding backend specifics in shared paths.

Strength:
- Backend-specific transport/SDK logic can evolve independently.

Current caveat:
- Some proxy/bridge edges still blur adapter boundaries.


### 4.2 Session binding as source of backend truth

Pattern used:
- Persist `sessionId -> backendId` mapping.
- Resolve backend first, then route operations.

Strength:
- Prevents accidental cross-backend execution.

Current caveat:
- Fallback behavior still needs strict parity in all runtimes.


### 4.3 Capability-driven UI rendering

Pattern used:
- Backend descriptors + control surface decide which selectors/features are visible/available.

Strength:
- UI can support multiple backends without feature forks per component.

Current caveat:
- Capability values must be unified across runtime implementations.


### 4.4 Store/state evolution to include backend identity

Pattern used:
- Add backend fields in selection/session/draft/default flows.

Strength:
- Backend choice is explicit and serializable.

Current caveat:
- Some read paths still snapshot/derive non-reactively and need tightening.


## 5) Practical status summary

Current maturity:
- **Functional baseline achieved**: Codex backend can be used for chat in-app.
- **Architecture direction is correct**: backend abstraction + control-surface + session bindings are in place.
- **Not finished**: parity + hardening + final UI decoupling cleanup remain.

Recommended next sequence:
1) Fix runtime parity mismatches (web vs VS Code).
2) Remove remaining OpenCode assumptions in shared UI decision points.
3) Add backend/runtimes validation matrix in CI.
4) Do naming/UX consistency pass.
