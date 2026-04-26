# Backend-Agnostic Decoupling Plan

Status: working plan for finishing backend-neutral UI/contracts before broader backend expansion.

## Goal

Finish the shared UI and state decoupling so OpenChamber can add more harness backends without accumulating OpenCode-specific special cases.

This plan prioritizes:

1. shared UI/contracts correctness
2. shared state model cleanup
3. runtime parity
4. Codex hardening
5. next backend readiness

## Current assessment

What is already good enough:

- Server-side harness routing exists.
- Session-to-backend binding exists.
- Backend control-surface contract exists.
- Codex proves a second backend path can work.

What is not finished:

- Shared UI still contains OpenCode-shaped assumptions.
- Shared stores still treat providers/agents as universal truth.
- VS Code backend metadata/capabilities are not sourced from the same authority as web.
- A few flows still bypass harness abstractions and call raw SDK behavior directly.

## Guiding rules

- Preserve one shared UX where possible.
- Abstract by UX role, not OpenCode terminology.
- Treat `agent` and `mode` as backend-specific variants of one primary selector slot.
- Do not add new backend-specific branches in shared UI unless the control-surface contract cannot express the need.
- Prefer moving logic behind canonical harness routes/contracts instead of teaching more UI code about backend details.

## Target architecture

Shared UI should only need to know:

- active `backendId`
- backend descriptor/capabilities
- backend control surface
- canonical session/message/event contract

Shared UI should not require OpenCode-specific assumptions such as:

- every backend has providers
- every backend has agents
- every backend has model variants
- every slash command is config-backed
- every runtime exposes backend state differently

## Work plan

### Phase 1. Lock the shared UI contract

Objective:

Make the control surface the authoritative source for composer controls.

Tasks:

1. Audit `ModelControls.tsx` and identify all fallback paths that still assume OpenCode agents/providers are the default model.
2. Define a stricter internal mapping for the composer:
   - primary selector
   - model selector
   - effort selector
   - command selector
3. Reduce the places where `currentAgentName` is treated as universally meaning an OpenCode agent.
4. Ensure `modeSelector.kind = 'agent' | 'mode'` fully drives the primary selector UX.
5. Make fallback behavior backend-neutral:
   - prefer control-surface defaults
   - then session-saved selection
   - then backend default
   - not hardcoded OpenCode-oriented fallback choices unless explicitly for the OpenCode backend

Primary files:

- `packages/ui/src/components/chat/ModelControls.tsx`
- `packages/ui/src/lib/api/types.ts`
- `packages/web/server/lib/harness/opencode-backend.js`
- `packages/web/server/lib/harness/codex-backend.js`

Acceptance criteria:

- Shared composer renders from control surface first.
- `plan/build` style backends fit the same primary selector UX slot without pretending to be true OpenCode agents internally.
- Adding a new backend with `modeSelector.kind = 'mode'` does not require large new composer branches.

### Phase 2. Decouple shared state from OpenCode-first config assumptions

Objective:

Stop treating OpenCode provider/agent data as the universal shared state model.

Tasks:

1. Audit `useConfigStore` responsibilities and separate:
   - OpenCode-specific provider/agent loading
   - shared composer selection state
   - backend-neutral defaults
2. Introduce or refactor toward backend-neutral selection concepts where needed:
   - selected primary mode/item
   - selected model option
   - selected effort option
3. Restrict OpenCode-only loading paths to cases where the active backend actually uses them.
4. Remove hardcoded universal fallbacks like `opencode/big-pickle` from shared logic.
5. Keep OpenCode-specific defaults, but scope them explicitly to OpenCode.

Primary files:

- `packages/ui/src/stores/useConfigStore.ts`
- `packages/ui/src/sync/selection-store.ts`
- `packages/ui/src/sync/session-ui-store.ts`

Acceptance criteria:

- Shared state can represent a backend with no provider list and no OpenCode-style agent list.
- OpenCode-specific defaults remain supported without leaking into all backends.
- Backend-neutral state names/flows exist where shared UI depends on them.

### Phase 3. Remove raw SDK bypasses from shared flows

Objective:

Make shared UI actions go through canonical harness behavior instead of scattered raw SDK calls.

Tasks:

1. Find shared UI/session flows still calling raw SDK session methods directly.
2. For each, decide whether it should be:
   - a harness route
   - a backend capability
   - an OpenCode-only action gated clearly in UI
3. Replace direct bypasses where they break backend neutrality.
4. Keep unavoidable OpenCode-only behavior explicitly scoped and labeled.

Known hotspots:

- `packages/ui/src/components/chat/ChatInput.tsx`
- `packages/ui/src/sync/submit.ts`
- `packages/ui/src/sync/session-ui-store.ts`
- `packages/ui/src/App.tsx`
- `packages/ui/src/sync/sync-context.tsx`

Acceptance criteria:

- Shared send/command/summary flows do not accidentally assume the OpenCode backend.
- Backend-specific behavior is routed deliberately, not by leftover direct SDK usage.

### Phase 4. Unify backend metadata/capabilities across runtimes

Objective:

Make web, desktop, and VS Code derive backend descriptors and capabilities from the same authority.

Tasks:

1. Remove or minimize hardcoded backend capability duplication in VS Code bridge code.
2. Make `/openchamber/backends` semantics match across runtimes.
3. Ensure capability flags for Codex and future backends do not drift between runtimes.
4. Verify the same backend selection yields equivalent UI affordances in web and VS Code.

Primary files:

- `packages/vscode/src/bridge-proxy-runtime.ts`
- `packages/web/server/lib/harness/backends.js`
- `packages/ui/src/stores/useBackendsStore.ts`

Acceptance criteria:

- Backend capability state has one effective source of truth.
- No runtime-specific stale capability matrix remains.

### Phase 5. Harden Codex on the cleaned abstraction

Objective:

Finish Codex parity and lifecycle hardening after the shared abstraction is cleaner.

Tasks:

1. Validate create/send/abort/revert/restore flows.
2. Validate permission/question lifecycle.
3. Validate startup restore and revisit flows.
4. Validate slash commands and structured generation paths.
5. Fix remaining Codex-specific regressions without reintroducing shared UI coupling.

Primary files:

- `packages/web/server/lib/harness/codex-backend.js`
- `packages/web/server/lib/harness/codex-appserver.js`
- `packages/web/server/lib/opencode/proxy.js`

Acceptance criteria:

- Codex works as a first-class backend on top of the cleaned shared contract.
- Codex fixes do not require widening OpenCode assumptions in shared UI.

### Phase 6. Prepare for the next backend

Objective:

Reach a point where adding another backend is mostly adapter work, not shared UI surgery.

Tasks:

1. Document the minimal backend adapter/control-surface requirements.
2. Add validation checks for a backend with:
   - no providers
   - no agents, only modes
   - backend-native command catalog
3. Add targeted tests or smoke checks around these assumptions.

Acceptance criteria:

- A third backend can be introduced with mostly server adapter work plus a capability/control-surface definition.

## Execution order

Recommended implementation order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

## First concrete edits

Start here:

1. `ModelControls.tsx`
   - reduce agent-specific fallback logic
   - make primary selector behavior fully control-surface-first
2. `useConfigStore.ts`
   - separate shared selection state from OpenCode provider/agent loading assumptions
3. `ChatInput.tsx`
   - remove direct raw SDK-only behavior that bypasses harness intent
4. `bridge-proxy-runtime.ts`
   - stop capability drift between VS Code and web

## Validation checklist

For each phase:

1. run `bun run type-check`
2. run `bun run lint`
3. run `bun run build`
4. verify web composer behavior
5. verify VS Code behavior when the phase touches shared contracts/runtime parity

Functional checks to repeat after major milestones:

1. create OpenCode session
2. create Codex session
3. send normal message in both
4. use slash command in both where supported
5. switch primary selector in both
6. reload app and reopen session
7. verify backend badge/identity stays correct

## Non-goals for this pass

- Perfect final terminology cleanup everywhere.
- Fully generic replacement of every OpenCode-specific settings page.
- Full CI matrix for every hypothetical future backend before abstraction cleanup lands.

## Risks

1. Over-refactoring shared stores too early could destabilize working flows.
2. Keeping old OpenCode fallbacks while adding more backends will create exponential special cases.
3. VS Code parity drift can hide backend bugs until later because web may appear correct first.

## Definition of done for this plan

This plan is complete when all of the following are true:

1. Shared composer logic is control-surface-first.
2. Shared state no longer assumes every backend has OpenCode-style providers/agents.
3. Canonical harness routes cover the shared flows that must be backend-neutral.
4. Web and VS Code present the same backend capability model.
5. Codex works on top of those abstractions without backend-specific hacks leaking into shared UI.
6. Adding the next backend looks mostly like adapter/control-surface work.

## Unresolved questions

1. Keep shared sync protocol OpenCode-shaped long-term, or later define a stricter OpenChamber-native client contract?
2. Should OpenCode-specific settings stay under shared settings shell, or move behind backend-specific subsections over time?
