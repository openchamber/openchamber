# Issue 1737 / 1556 — Aggregated connection status indicator plan

## Summary

Add a single compact header status dot that summarizes connection health without adding UI weight.

- Always visible: one small dot in shared header UI
- Hover only: 2-3 short lines describing overall state and each hop
- No click-driven diagnostics, no second dot, no new polling loop
- Internally track two distinct hops, but present one aggregated indicator

## Scope

This plan covers:

- issue [#1737](https://github.com/openchamber/openchamber/issues/1737): frontend ↔ OpenChamber runtime status
- related issue [#1556](https://github.com/openchamber/openchamber/issues/1556): OpenChamber runtime ↔ OpenCode status
- a shared UX and state model that supports both while keeping the visible UI to one compact indicator

Out of scope for this PR:

- implementation code
- expanded diagnostics UI
- separate per-hop visible indicators
- new health polling beyond existing reconnect/health signals

## Behavioral contract

### Natural user action

The user glances at a small status indicator in the header. If it is not healthy or they want more detail, they hover to read a short explanation.

### Value source

The value is system-derived, not user-authored:

- frontend ↔ runtime health comes from the existing SSE/WS reconnect pipeline
- runtime ↔ OpenCode health comes from existing OpenCode health checks / health snapshots

### Valid visible states

Normalized visible states:

- Connected
- Reconnecting
- Degraded / Disconnected
- Unknown

Optional short reason text may include:

- Offline
- Runtime unreachable
- OpenCode unavailable
- Auth/config issue
- Unknown

### Existing project pattern

The visible affordance should reuse the compact dot + hover pattern already used in subsystem status UI, especially:

- `packages/ui/src/components/desktop/DesktopHostSwitcher.tsx`
- `packages/ui/src/components/sections/mcp/McpPage.tsx`
- header tooltip/compact status affordances in `packages/ui/src/components/layout/Header.tsx`

### Raw/internal values

Do not expose internal/manual reason codes such as `ws_closed:1006` or `health_check_unhealthy` directly in the normal UI. Map them to short user-facing copy. Raw details may remain available for diagnostics/debug paths.

## Current facts

### Frontend ↔ runtime signals already exist

Relevant files:

- `packages/ui/src/sync/event-pipeline.ts`
- `packages/ui/src/sync/sync-context.tsx`
- `packages/ui/src/stores/useConfigStore.ts`

Current behavior:

- reconnect loop already drives disconnect/reconnect state
- disconnect reasons already exist
- `sync-context.tsx` currently updates `isConnected`, `hasEverConnected`, `connectionPhase`, and `lastDisconnectReason` from pipeline lifecycle callbacks

### Runtime ↔ OpenCode signals already exist

Relevant files:

- `packages/ui/src/lib/opencode/client.ts`
- `packages/ui/src/stores/useConfigStore.ts`
- `packages/web/server/index.js`
- `packages/ui/src/lib/openCodeStatus.ts`

Current behavior:

- `opencodeClient.checkHealth()` calls `/api/opencode/health`
- runtime `/health` snapshot exposes fields including `isOpenCodeReady` and `lastOpenCodeError`
- diagnostics/reporting paths already consume these signals

### Current architectural gap

Today the shared config-store connection fields mix semantics from both hops. That is fine for broad readiness gating but not precise enough for one aggregated user-facing status indicator that must explain which hop is unhealthy.

## Target design

## UX

Add one compact shared indicator in the main header area:

- default UI: dot only
- hover content: 2-3 short lines
- color reflects worst current state
- works across web, desktop, and VS Code shared UI as far as the shared header path is used

Example hover content:

```text
Connection status
Frontend ↔ OpenChamber: connected
OpenChamber ↔ OpenCode: unavailable
```

or:

```text
Connection status
Frontend ↔ OpenChamber: reconnecting
Reason: offline
```

## State model

Internally separate the two hops:

1. Frontend ↔ OpenChamber runtime
2. OpenChamber runtime ↔ OpenCode

Then derive one aggregated presentational model:

- dot color
- overall label
- hover lines

### Recommended aggregation rules

- Green: both hops healthy
- Red: any hop clearly broken/unavailable
- Neutral/amber: reconnecting, transitional, or unknown
- Unknown: when the app cannot reliably determine current status

### Recommended precedence

1. frontend disconnected/offline/reconnecting
2. runtime connected but OpenCode unhealthy
3. both healthy
4. fallback unknown

This keeps the visible indicator focused on the most actionable current failure.

## Implementation plan

### Phase 1 — Separate state ownership

Goal: stop overloading one set of connection fields with two different meanings.

Planned changes:

- introduce explicit normalized state for frontend ↔ runtime transport health
- introduce explicit normalized state for runtime ↔ OpenCode health
- keep existing readiness behavior working during migration
- avoid broad store fanout; use low-frequency narrow selectors only

Candidate files:

- `packages/ui/src/stores/useConfigStore.ts`
- `packages/ui/src/sync/sync-context.tsx`
- `packages/ui/src/sync/event-pipeline.ts`
- `packages/ui/src/hooks/useOpenCodeReadiness.ts`

### Phase 2 — Normalize user-facing reasons

Goal: map internal disconnect/health reasons into compact hover text.

Planned changes:

- add a small mapper from internal reason codes to user-facing labels
- preserve raw values only for debug/diagnostics
- keep tooltip copy short and stable

Candidate files:

- likely a new small helper under `packages/ui/src/lib/` or `packages/ui/src/components/layout/`
- translation/messages files for user-facing strings

### Phase 3 — Shared compact indicator component

Goal: build one reusable header-grade component that consumes only normalized state.

Planned changes:

- create a compact dot indicator with tooltip/hover content
- reuse header tooltip and subsystem status visual patterns
- no click dependency in the primary flow

Candidate files:

- `packages/ui/src/components/layout/Header.tsx`
- likely a new component under `packages/ui/src/components/layout/` or `packages/ui/src/components/ui/`

### Phase 4 — Integrate aggregated status

Goal: compute a single visible status from the two internal hops.

Planned changes:

- add aggregation selector/helper
- feed the component a stable low-frequency view model
- ensure cross-runtime shared rendering parity

### Phase 5 — Validate narrow scenarios

Minimum scenarios to verify:

- fresh connected startup
- runtime restart / temporary reconnect
- browser offline / online recovery
- runtime unreachable
- OpenCode unhealthy while runtime remains reachable
- transport switch / recovery path
- desktop and VS Code shared UI behavior parity where applicable

## Risks and mitigations

### Risk: mixed semantics create misleading status

Mitigation:

- split internal state by hop first
- aggregate only after normalization

### Risk: UI noise or clutter

Mitigation:

- one dot only
- short hover text only
- no second visible indicator

### Risk: exposing raw implementation details

Mitigation:

- map raw reasons to short labels
- reserve raw details for diagnostics only

### Risk: render fanout / hot-path regressions

Mitigation:

- subscribe only to narrow low-frequency fields
- do not attach indicator rendering to session lists or streaming message state

## Rollout recommendation

Recommended order:

1. separate hop-specific internal state
2. add reason normalization
3. add shared compact indicator
4. wire aggregated status into header
5. verify web/desktop/VS Code parity

## Open questions

- Whether the final neutral transitional state should be amber or theme-muted when reconnecting/unknown
- Whether the hover always shows both hop lines, or collapses to a reason line when the second hop is not currently knowable
- Whether VS Code needs any special bridge mapping beyond the shared normalized state
