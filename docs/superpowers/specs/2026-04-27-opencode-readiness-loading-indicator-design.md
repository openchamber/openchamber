# OpenCode Readiness Loading Indicator

## Problem

When creating a new session or during initial app load, if the OpenCode server is still starting up (e.g., updating plugins), the model and agent selectors in the UI show empty states ("Not selected") with no loading indication. Users see blank selectors and assume nothing is available, rather than understanding the server is still starting.

## Goal

Show a loading indicator in model and agent selectors while OpenCode is initializing, so users understand the server is starting up and data will appear shortly.

## Design

### 1. New hook: `useOpenCodeReadiness`

**File:** `packages/ui/src/hooks/useOpenCodeReadiness.ts`

Wraps existing `useConfigStore` state into a focused readiness interface:

```ts
import { useConfigStore } from '@/stores/useConfigStore';

export function useOpenCodeReadiness() {
  const isInitialized = useConfigStore((s) => s.isInitialized);
  const connectionPhase = useConfigStore((s) => s.connectionPhase);

  return {
    isReady: isInitialized,
    connectionPhase, // "connecting" | "connected" | "reconnecting"
  };
}
```

- No new store fields — reads directly from existing state
- Leaf selectors — subscribes to minimal values
- ~15 lines — pure derivation, no side effects

### 2. Selector loading states

Three components consume `useOpenCodeReadiness` and show loading indicators when `!isReady`:

#### `ModelSelector.tsx` (`packages/ui/src/components/sections/agents/ModelSelector.tsx`)

- Import `useOpenCodeReadiness`
- When `!isReady`:
  - **Desktop trigger:** Show `RiLoader4Line` with `animate-spin` + "Loading..." text in `text-muted-foreground`
  - **Mobile trigger:** Same spinner + "Loading..." text
  - **Dropdown:** Disable opening (no point showing empty dropdown)

#### `AgentSelector.tsx` (`packages/ui/src/components/sections/commands/AgentSelector.tsx`)

- Import `useOpenCodeReadiness`
- When `!isReady`:
  - **Desktop trigger:** Show spinner + "Loading..." text
  - **Mobile trigger:** Same
  - **Dropdown:** Disable opening

#### `ModelControls.tsx` (`packages/ui/src/components/chat/ModelControls.tsx`)

- Import `useOpenCodeReadiness`
- When `!isReady`:
  - **Model selector trigger:** Show spinner + "Loading..." instead of model name
  - **Agent selector trigger:** Show spinner + "Loading..." instead of agent name
  - **Dropdowns disabled** while loading

### 3. Visual treatment

- **Spinner icon:** `RiLoader4Line` from `@remixicon/react` with Tailwind `animate-spin` class
- **Size:** `h-3.5 w-3.5` — matches existing selector icons
- **Text:** "Loading..." in `typography-meta` with `text-muted-foreground` — matches existing placeholder style
- **No flash:** `isInitialized` starts `false` and flips to `true` once. No flicker — it's either loading or loaded.

### 4. Edge cases

1. **Fast startup (OpenCode already running):** `isInitialized` becomes `true` almost immediately. Loading state may flash briefly — acceptable.
2. **Slow startup (plugin updates):** `isInitialized` stays `false` for seconds/minutes. Spinner persists, giving clear feedback.
3. **Startup failure (retry exhausted):** `App.tsx` shows `StartupInitializationRecovery` screen with manual retry button. Selectors stay in loading state behind that screen — no conflict.
4. **Reconnection (SSE drops):** `connectionPhase` goes to "reconnecting" but `isInitialized` stays `true` (not reset on disconnect). Selectors don't flash back to loading on temporary disconnects.
5. **Directory switch:** `activateDirectory()` restores cached providers/agents. If directory was previously loaded, data appears immediately. If new directory, existing startup recovery poll handles it.

### 5. What we're NOT doing

- No new store fields
- No new UI components (just inline JSX in existing triggers)
- No changes to startup/retry logic in `App.tsx`
- No toast/banner notifications
- No changes to health check flow

## Files to modify

| File | Change |
|------|--------|
| `packages/ui/src/hooks/useOpenCodeReadiness.ts` | **New file** — hook wrapping readiness state |
| `packages/ui/src/components/sections/agents/ModelSelector.tsx` | Add loading state to trigger buttons |
| `packages/ui/src/components/sections/commands/AgentSelector.tsx` | Add loading state to trigger buttons |
| `packages/ui/src/components/chat/ModelControls.tsx` | Add loading state to model/agent triggers |

## Verification

1. Run `bun run type-check` — no type errors
2. Run `bun run lint` — no lint errors
3. Manual test: start app with OpenCode server stopped → selectors show "Loading..." → start server → selectors populate normally
4. Manual test: start app normally → selectors show data immediately (no flash or delay)
