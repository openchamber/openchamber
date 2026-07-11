# OpenChamber - AI Agent Reference

## Core purpose

OpenChamber provides UI runtimes (web and Android) for interacting with an OpenCode server (local auto-start or remote URL). Official OpenCode traffic goes through `@opencode-ai/sdk`; OpenChamber-owned runtime capabilities go through `RuntimeAPIs`, `runtimeFetch`, and browser/realtime URL helpers.

## Runtime architecture (IMPORTANT)

- The **client** (`client/web`, built with Vite) is a static frontend. It does not host an OpenCode server itself; it talks to the **backend** over the backend's public URL (`VITE_API_URL` → `window.__OPENCHAMBER_API_BASE_URL__`).
- The **backend** (`backend/server/*`, Express) is API-only. It orchestrates OpenCode: each chat session spins up an isolated Daytona sandbox running OpenCode, and the backend proxies the client's API/realtime traffic to that sandbox (see `backend/server/lib/daytona/*`).
- The Android app (`client/mobile`) is a Capacitor shell that wraps the built web UI and points at the backend's public URL.
- Do not add OpenCode feature backends to the native shell. Shared UI features should remain server/runtime APIs unless the capability is inherently native.

### Android Shell

- **Android work goes into `client/mobile/`.** The native project is `client/mobile/android` (Capacitor).
- The app bundles the web build via `client/mobile/scripts/prepare-web-assets.mjs`; there is no separate mobile UI codebase — it reuses `client/web`.
- Native plugin config (status bar, keyboard, push notifications) lives in `client/mobile/capacitor.config.ts`.
- Build/release: the Android APK/AAB is the mobile release target (see `.github/workflows/mobile-release.yml`).

## Tech stack (source of truth: `package.json`, resolved: `bun.lock`)

- Runtime/tooling: Bun (`package.json` `packageManager`), Node >=22 (`package.json` `engines`)
- UI: React, TypeScript, Vite, Tailwind v4
- State: Zustand stores and sync layer (`client/ui/src/stores/`, `client/ui/src/sync/`)
- UI primitives: Base UI (`@base-ui/react`, primary source for dropdown/select/dialog/menu/tooltip/etc. — wrappers live in `client/ui/src/components/ui/`), Radix UI (`package.json` deps, legacy usages being migrated), HeroUI (`package.json` deps), Remixicon as SVG sprite source only (use shared `Icon`, never direct `@remixicon/react` imports)
- Server: Express (`backend/server/index.js`)
- Android: Capacitor (`client/mobile/`)

## Repository layout

The repo is split into two **independent** projects plus a docs site:

- **`client/`** — a self-contained Bun workspace (deploys as a static site / Android APK):
  - Web/PWA frontend: `client/web`
  - Shared UI library: `client/ui` (resolved via the `@openchamber/ui` / `@` aliases)
  - Android app (Capacitor): `client/mobile`
  - The client talks to the backend over its public URL, set at build time via
    `VITE_API_URL` (see `client/web/src/apiBase.ts`).
- **`backend/`** — a standalone Express server (deploys to Render):
  - Server: `backend/server`
  - CLI: `backend/bin`
  - API-only; orchestrates per-session Daytona sandboxes running OpenCode.
- **`docs-site/`** — documentation website content.

The two projects have separate `package.json` files, dependency trees, and
lockfiles, and can be built/deployed on their own.

## Documentation map

Before changing any mapped module, read its module documentation first.

### web

Web runtime and server implementation for OpenChamber.

#### lib

Server-side integration modules used by API routes and runtime services.

##### event-stream

OpenChamber-owned event stream helpers for server-sent runtime events.

- Module docs: `backend/server/lib/event-stream/DOCUMENTATION.md`

##### fs

Filesystem routes, raw file access, search helpers, and workspace-scoped file operations.

- Module docs: `backend/server/lib/fs/DOCUMENTATION.md`

##### quota

Quota provider registry, dispatch, and provider integrations for usage endpoints.

- Module docs: `backend/server/lib/quota/DOCUMENTATION.md`

##### git

Git repository operations for the web server runtime.

- Module docs: `backend/server/lib/git/DOCUMENTATION.md`

##### github

GitHub authentication, OAuth device flow, Octokit client factory, and repository URL parsing.

- Module docs: `backend/server/lib/github/DOCUMENTATION.md`

##### opencode

OpenCode server integration utilities including config management, provider authentication, and UI authentication.

- Module docs: `backend/server/lib/opencode/DOCUMENTATION.md`

##### notifications

Notification message preparation utilities for system notifications, including text truncation and optional summarization.

- Module docs: `backend/server/lib/notifications/DOCUMENTATION.md`

##### scheduled-tasks

Scheduled task persistence, execution, and event fanout for recurring sessions.

- Module docs: `backend/server/lib/scheduled-tasks/DOCUMENTATION.md`

##### text

Text processing helpers shared by server-side routes and summarization flows.

- Module docs: `backend/server/lib/text/DOCUMENTATION.md`

##### terminal

WebSocket protocol utilities for terminal input handling including message normalization, control frame parsing, and rate limiting.

- Module docs: `backend/server/lib/terminal/DOCUMENTATION.md`

##### tts

Server-side text-to-speech services and summarization helpers for `/api/tts/*` endpoints.

- Module docs: `backend/server/lib/tts/DOCUMENTATION.md`

##### relay

Host side of the private relay: outbound E2EE tunnel that lets remote clients reach this instance through OpenChamber-hosted relay infrastructure without inbound exposure. Load the `relay-transport` skill before changing it or any WebSocket/streaming endpoint that rides it.

- Module docs: `backend/server/lib/relay/DOCUMENTATION.md`

##### tunnels

Tunnel provider setup and runtime helpers for exposing OpenChamber over remote URLs.

- Module docs: `backend/server/lib/tunnels/DOCUMENTATION.md`

##### ui-auth

UI session auth, client tokens, URL-token scoping, passkey/reset flows, and route-level auth gates.

- Module docs: `backend/server/lib/ui-auth/DOCUMENTATION.md`

##### skills-catalog

Skills catalog management including discovery, installation, and configuration of agent skill packages.

- Module docs: `backend/server/lib/skills-catalog/DOCUMENTATION.md`

### ui

Shared React UI, sync layer, runtime API contracts, and stores.

#### sync

Session synchronization, event pipeline, optimistic updates, caches, and live-state stores.

- Module docs: `client/ui/src/sync/DOCUMENTATION.md`

#### stores

Zustand store ownership, persistence expectations, and store-splitting guidance.

- Module docs: `client/ui/src/stores/DOCUMENTATION.md`

#### session sidebar

Session sidebar grouping, ordering, virtualization-adjacent behavior, and project/worktree display.

- Module docs: `client/ui/src/components/session/sidebar/DOCUMENTATION.md`

#### message parts

Chat message part rendering and message-row performance expectations.

- Module docs: `client/ui/src/components/chat/message/parts/DOCUMENTATION.md`

## Build / dev commands (verified)

All scripts are in `package.json`.

- Validate: `bun run type-check`, `bun run lint`
- Build all: `bun run build`
- Web build: `bun run build:web`
- Android build (debug APK): `bun run mobile:build:android:debug`
- Android sync (build web + copy into native project): `bun run mobile:sync`

## Runtime entry points

- Web bootstrap: `client/web/src/main.tsx`
- Web server: `backend/server/index.js`
- Web CLI: `backend/bin/cli.js` (package bin: `client/web/package.json`)
- Android: `client/mobile/android` (Capacitor shell wrapping the built web UI; config at `client/mobile/capacitor.config.ts`)

## OpenCode integration

- UI client wrapper: `client/ui/src/lib/opencode/client.ts` (imports `@opencode-ai/sdk/v2`)
- Sync/event pipeline: app roots mount `SyncProvider` from `client/ui/src/sync/sync-context.tsx`; OpenCode SSE/WS event handling lives in `client/ui/src/sync/event-pipeline.ts`
- Web server embeds/starts OpenCode server: `backend/server/index.js` (`createOpencodeServer`)
- Web runtime filesystem endpoints: `backend/server/lib/fs/routes.js`, registered by `backend/server/lib/opencode/feature-routes-runtime.js`
- External server support: Set `OPENCODE_HOST` (full base URL, e.g. `http://hostname:4096`) or `OPENCODE_PORT`, plus `OPENCODE_SKIP_START=true`, to connect to existing OpenCode instance

## Key UI patterns (reference files)

- Settings shell: `client/ui/src/components/views/SettingsView.tsx`
- Settings shared primitives: `client/ui/src/components/sections/shared/`
- Settings sections: `client/ui/src/components/sections/` (incl `skills/`)
- Chat UI: `client/ui/src/components/chat/` and `client/ui/src/components/chat/message/`
- Theme + typography: `client/ui/src/lib/theme/`, `client/ui/src/lib/typography.ts`
- Terminal UI: `client/ui/src/components/terminal/` (uses `ghostty-web`)

## External / system integrations (active)

- Runtime API contracts: `client/ui/src/lib/api/types.ts`; React consumption via `client/ui/src/hooks/useRuntimeAPIs.ts`
- Runtime transport/auth: `client/ui/src/lib/runtime-fetch.ts`, `client/ui/src/lib/runtime-url.ts`, `client/ui/src/lib/runtime-auth.ts`
- Git: `client/ui/src/lib/gitApi.ts`, `backend/server/lib/git/service.js` (`simple-git`)
- Terminal PTY: `backend/server/lib/terminal/runtime.js` (`bun-pty`/`node-pty`)
- Skills catalog: `backend/server/lib/skills-catalog/`, UI: `client/ui/src/components/sections/skills/`

## Agent constraints

- Do not modify `../opencode` (separate repo).
- Do not run git/GitHub commands unless explicitly asked.
- Keep baseline green (run `bun run type-check`, `bun run lint` before finalizing changes).

## Agent code of conduct

- Prefer the smallest correct change.
- Preserve working behavior before improving structure.
- Do not add cleverness where a direct implementation is enough.
- Do not infer critical state from weak signals when a stronger source exists.
- Do not encode policy only in UI; enforce it in core logic.
- Do not hide data loss, partial failure, or fallback behavior. Make it explicit in code.
- Finish work end-to-end: implementation, verification, and cleanup.

## Development rules

- Keep diffs tight; avoid drive-by refactors.
- Follow local precedent; inspect nearby code before introducing new patterns.
- Backend changes: keep web and Android behavior consistent when they share contracts.
- TypeScript: avoid `any`, blind casts, and shape guessing.
- React: prefer function components + hooks; use classes only when required.
- Control flow: prefer early returns and explicit branching over nested ternaries.
- Styling: Tailwind v4, typography via `client/ui/src/lib/typography.ts`, theme vars via `client/ui/src/lib/theme/`.
- Shared UI patterns: reuse shared primitives before introducing feature-local markup patterns.
- Toasts: use the wrapper from `@/components/ui`; do not import `sonner` directly in feature code.
- No new deps unless asked.
- Never add secrets or log sensitive data.

## Architecture patterns

### Thin entrypoints, focused modules

- Keep orchestration entrypoints thin: `index.js`, bridge files, bootstrap files, provider roots.
- Move route, domain, and runtime logic into focused modules with clear ownership.
- Prefer dependency injection over hidden module coupling.
- Add or update module documentation when ownership changes.

### Strong source of truth

- Prefer deterministic state over heuristics.
- Use live server/session state for live activity. Do not let historical anomalies masquerade as current execution.
- If a fallback is necessary, scope it narrowly to the active entity and treat it as temporary.
- Restore derived UI state from authoritative records. Example: restore model or agent from the latest user message, not assistant-side guesses.

### Live state vs historical state

- Derive live UI behavior from live state channels, not persisted history.
- Use historical records to restore context, not to infer that work is still in progress.
- If live state is delayed, use the narrowest possible transient fallback and clear it as soon as authoritative state arrives.

### Cross-runtime parity

- If web defines a route or payload contract that shared UI depends on, keep Android parity where applicable.
- Shared behavior differences must be intentional and visible in code.
- Do not ship a web-only assumption into shared UI.

### Partial-failure-safe flows

- Cross-directory and multi-entity operations must tolerate partial failure.
- Prefer per-item results, rollback paths, or resumable cleanup over all-or-nothing assumptions.
- Never leave optimistic state or local caches stranded after failure.

### Distinguish fetch failure from empty success

Client API methods that feed authoritative state (bootstrap, reconnect resync, retry loops) **must signal fetch failure distinctly from a successful-but-empty server response.** A method that swallows errors and returns `[]`/`{}`/`null` lets the caller delete or overwrite legitimate state on a transient network blip, indistinguishable from "the server says nothing here."

- **Decide which methods are authoritative.** A method is authoritative if any caller uses its result to delete, clear, or replace persisted/sync state. UI-display-only methods (autocomplete, dropdowns, settings pages) can keep silent-empty fallback because the user's next action refreshes them.
- **For authoritative methods, pick one of two patterns** — both already exist in the codebase, do not invent a third:
  - **Throw on failure** (e.g. `listPendingPermissions`, `listPendingQuestions`, `listAgents`, the `unwrap()` helper in `client/ui/src/sync/bootstrap.ts`). Use this when the caller has an outer `try/catch` per logical block — the throw skips the block and preserves prior state.
  - **Return `T | null` on failure, where `null` strictly means "fetch failed"** (e.g. `getSessionStatusForDirectory`, the `.catch(() => null)` + early-return-on-null pattern at the per-session reconnect loop in `sync-context.tsx`). Use this when the caller has follow-up work that should still run when one fetch fails.
- **Never swallow inside the method while returning the same type as success.** The SDK's `{data, error}` shape already does this silently — wrap with `if (result.error) throw …` so the failure can't be lost.
- **Verify the caller actually preserves state on failure.** Adding the throw is only half the fix; the consumer must not run the "delete missing" / "overwrite" branch unless it knows the fetch succeeded. The relevant outer `try/catch` is often already there but dormant.
- **Retry loops require a failure signal.** A `for (let attempt = 0; attempt < 3; …)` retry around a method that swallows to `[]` will run exactly once — the loop never sees an error.

This rule is the API-layer counterpart of "Use live server/session state for live activity. Do not let historical anomalies masquerade as current execution." A fetch failure is the same kind of anomaly — don't let it masquerade as authoritative server state.

### Reconnect-loop pacing

The SSE/WebSocket reconnect loop in `client/ui/src/sync/event-pipeline.ts` retries indefinitely. To avoid burning battery and server load on dead/idle connections, the loop's pacing must respect three signals:

- **`navigator.onLine`**: when the browser reports offline, use the long backoff cap (~60s) instead of the short one (~5s). The expected recovery path is the `online` event, not the next probe.
- **`document.visibilityState`**: when hidden, use the long cap too. A backgrounded PWA shouldn't hammer the network at 1/5s; the browser may also throttle our timers, but state the intent in code rather than relying on it.
- **HTTP status of the last failure**: permanent 4xx errors (401, 403, 404, …) don't recover from blind retry. Jump straight to the long cap instead of running the normal exponential path; otherwise a stale-path or expired-token client would put ~12 reqs/min on the server log forever. 408 (Request Timeout) and 429 (Too Many Requests) are retryable in spirit — let them go through normal backoff.
- **Consecutive failures**: real exponential growth (`base * 2^failures`, clamped), not constant 500ms. A hard-down server should see geometrically fewer probes per minute over time.

The inter-attempt wait must be interruptible by `online`, visibility-becomes-visible, and the pipeline's abort signal — otherwise recovery is delayed by however long the current sleep had left to run.

## CLI Parity and Safety Policy (MANDATORY)

### Principle: policy-first, UX-second

All safety and correctness rules MUST be enforced in core command logic, independent of output mode.

Interactive/pretty UX (`@clack/prompts`) is a presentation layer only.
It must never be the only place where validation or restriction is enforced.

### Required parity across modes

The same functional outcome and safety gates MUST hold for all execution modes:

- Interactive TTY (full Clack UX)
- Non-interactive shells (piped/stdin-less automation)
- `--quiet`
- `--json`
- Fully pre-specified flags (no prompts)

In all modes, invalid operations MUST fail with non-zero exit code and deterministic error semantics.

### Non-negotiable rule

Do not rely on prompts to enforce policy.

- Prompts MAY help users choose valid inputs.
- Core validators MUST run even when prompts are unavailable or skipped.
- `--quiet` suppresses non-essential output only; it does not weaken validation.
- `--json` changes output shape only; it does not weaken validation.

Detailed Clack UX patterns (primitives, prompt gating, and implementation checklist)
are defined in the `clack-cli-patterns` skill and should not be duplicated here.

## Project Skills (MANDATORY)

Project skills live under `.agents/skills/*/SKILL.md`. Before editing, agents **MUST** load every skill whose trigger matches the work; if multiple rows apply, load all of them.

| Work being done | Required skill call |
|---|---|
| Terminal CLI commands, prompts, or output formatting, especially `backend/bin/*` | `skill({ name: "clack-cli-patterns" })` |
| Shared UI data access, `RuntimeAPIs`, `runtimeFetch`, `runtime-url`, OpenCode SDK calls, authenticated browser assets, runtime switching, or web server API endpoints | `skill({ name: "ui-api-decoupling" })` |
| UI components, styling, visual elements, colors, buttons, or icons | `skill({ name: "theme-system" })` |
| User-facing UI text: labels, buttons, placeholders, aria labels, empty/error/loading states, toasts, dialogs, settings copy, or navigation labels | `skill({ name: "locale-ui-patterns" })` |
| Settings pages, settings dialogs, configuration UI, or visual/layout changes inside Settings | `skill({ name: "settings-ui-patterns" })` |
| Drag-to-reorder, sortable lists/chips/grids, or `@dnd-kit` behavior including touch/mobile and wrapping variable-width items | `skill({ name: "drag-to-reorder" })` |
| iOS Simulator preview/control for the mobile app, `serve-sim`, simulator taps/typing/gestures/rotation, or headless install/launch workflows outside Xcode | `skill({ name: "serve-sim" })` |
| WebSocket/SSE/streaming endpoints (terminal, dictation/voice, event stream, notifications), opening a WebSocket in shared UI, runtime transport refactors (`runtime-fetch`/`runtime-url`/`runtime-switch`/`runtime-auth`), the private relay tunnel, or anything under `client/ui/src/lib/relay` or `backend/server/lib/relay` | `skill({ name: "relay-transport" })` |

Skill docs are the source of truth for detailed patterns. Do not duplicate their full guidance here; load the skill and follow it before making matching changes.

## Performance rules (MANDATORY)

These rules exist because violating them has caused measurable regressions (render cascades, memory bloat, UI jank). They apply to all UI and sync layer work.

### Shared-store render discipline

- **Treat common stores as render fanout boundaries.** An unnecessary reference change in shared state can re-render large parts of the app.
- **Do not put high-frequency state in broadly consumed stores.** Fast-changing state should live in narrow stores with narrow subscribers.
- **Update only the fields that changed.** Preserve references for untouched state branches.
- **Prefer leaf selectors over container selectors.** Subscribe to the smallest stable value that satisfies the component.
- **Isolate hot consumers.** If a value changes often and only a few components need it, move it to a narrower store or consume it in a memoized child.
- **Do not subscribe shell/layout components to broad live collections.** If a shell only needs one field, entity, or derived flag, subscribe to that instead of the whole collection.
- **Treat provider roots as global hot paths.** A top-level provider must not subscribe to high-frequency data unless the feature is actually enabled and the subscription is essential.

### Zustand referential equality

Zustand skips re-renders when a selector returns the same reference (`Object.is`). Every new object/array reference triggers a re-render in every subscriber.

- **Never spread all state fields in an update.** Only create new references for fields that actually changed. A `message.part.delta` event should not clone `session`, `permission`, etc.
- **Select leaf values, not containers.** `useStore((s) => s.permission[sessionID])` is correct. `useStore((s) => s.permission)` subscribes to every permission change across all sessions.
- **Preserve references when merging.** If prepending older messages, keep existing message object references. Only add truly new items. Return the original array if nothing was added.
- **For derived collections, preserve item identity when presentation-relevant fields are unchanged.** Reuse previous item references for unchanged rows/items and move high-frequency live fields to narrow per-item selectors.

### Store splitting

A single store with N properties means every subscriber re-evaluates on every state change. Split stores by change frequency and subscriber set.

- **Group state by how often it changes.** Streaming state (updated 60/sec) must not live with user preferences (updated on click).
- **Group state by who reads it.** If only 2 components need a value, it belongs in a store that only those 2 subscribe to.
- **Cross-store reads use `.getState()`.** Actions in one store that need another store call `useOtherStore.getState()` — imperative, no subscription.
- **Never add unrelated state to an existing store** just because it's convenient. Create a new store.

### Event pipeline and SSE

- **Gate expensive operations on the hot path.** During streaming, `message.part.delta` and `message.part.updated` fire ~60/sec. Any `findIndex`, `filter`, or iteration added to these handlers multiplies across every event. Gate behind a cheap boolean check first (e.g., check `next[0]` before scanning the array).
- **Skip no-op updates.** If an incoming event doesn't change the state (same role, same finish, same timestamps), return `false` from the reducer to avoid creating new references.
- **Coalesce by key.** Same-entity events (e.g., repeated `session.status` for the same session) should replace earlier ones in the queue, not accumulate.
- **Preserve event ordering semantics.** Reducers and queues must not let stale deltas or out-of-order events corrupt the latest state.
- **Do not widen live-activity fallbacks.** A fallback for delayed status should inspect only the current trailing entity, not arbitrary historical records.

### Polling payload fidelity

- **Do not let lightweight polling erase rich fields.** If light mode omits fields (e.g., `diffStats`), preserve previous rich data until a heavy follow-up fetch lands.
- **Use two-phase polling.** Run cheap change detection first; only run heavy status fetches for directories that actually changed.

### Optimistic updates

- **Use the shadow Map pattern.** Insert optimistic data into the store for instant UI, AND register it in a separate tracking Map. Cleanup happens deterministically via `mergeOptimisticPage` on the next data fetch — not via heuristics in the event reducer.
- **Pass client-generated IDs to the server.** Use the same ID format as the server (hex-encoded timestamps). Pass `messageID` to `promptAsync` so the server echoes back the same ID. This prevents duplicates and enables in-place replacement.
- **Rollback on error.** Remove the optimistic entry from both the store and the shadow Map.
- **Stabilize bridge callbacks.** When wiring hook callbacks into module-level refs, use stable ref wrappers so effects do not loop on changing function identities.

### Session/input consistency

- **Capture send config at queue time.** Queue items must include provider/model/agent/variant snapshot; do not re-resolve from mutable live state at send time.
- **Keep server-selected attachments sendable.** Preserve server-backed file selections in queue/submit flows and convert them to proper `file://` URLs before sending.
- **Do not let text input state repaint unrelated chrome.** Typing should not force unrelated controls, menus, indicators, or toolbars to re-render on every keystroke.
- **Extract slow-changing chrome from hot input paths.** If controls do not depend on the current text value, move them behind memoized boundaries with stable callbacks.

### Bootstrap resilience

- **Treat startup 502/503 as transient.** Retry bootstrap/session-list flows with bounded retries/intervals, since API readiness can lag server startup.
- **Use polling recovery when failures are swallowed.** If an async loader resolves without throwing on failure, recover with interval retries gated by loaded-state checks.

### Scroll and DOM

- **Never use `await waitForFrames()` for scroll preservation.** Frames of visible scroll jump are unacceptable. Use `useLayoutEffect` to adjust scroll synchronously after React commits DOM — before the browser paints.
- **Capture scroll state before the state change, restore in layout effect.** The pattern: save `scrollHeight`/`scrollTop` into a ref before triggering the update, consume it in `useLayoutEffect` on the rendered output.
- **Do not let viewport resizes masquerade as content growth.** Viewport-height changes must not trigger the same scroll compensation logic used for actual content growth.
- **Disable or narrow native/browser scroll anchoring when custom scroll logic exists.** Browser anchoring and app-managed pinning/follow logic will fight and produce jiggle.
- **Autosize textareas without transient collapse on growth.** Avoid `height='auto'` shrink/expand cycles on every character when the content only grew; this creates visible layout bounce.

### List ordering and view consistency

- **Do not sort structural lists directly from high-churn live fields.** If live updates are frequent, sorting directly from them causes reorder thrash and wide rerender cascades.
- **If live recency is required, freeze order during high-frequency updates and apply a one-shot reorder only at an intentional lifecycle edge.** Choose the lifecycle edge explicitly instead of letting every intermediate update reshuffle the UI.
- **Use one ordering source for all views of the same data.** Different views of the same entities must derive from the same ranked list or rank map; do not let each surface re-derive ordering independently.
- **Do not mix global snapshots and local live snapshots without an explicit reconciliation policy.** If multiple data sources feed one view, define which fields win and how they merge.

### Component isolation

- **Extract high-frequency hook consumers into separate components.** If a hook re-evaluates 60/sec (e.g., streaming status), wrap its consumer in a `React.memo` child component so the parent doesn't re-render.
- **Use custom `React.memo` comparators for message rows.** Compare render-relevant fields (role, finish, parts count, part IDs) — not object references.

### Caching and memory

- **Cap in-memory caches with both count and byte limits.** Entry count alone doesn't prevent memory bloat from large files. Use dual-constraint LRU (e.g., 40 entries OR 20MB).
- **Set store session limits to match loaded data.** If bootstrap loads N sessions, set `limit >= N`. Otherwise the next SSE event triggers trimming that silently removes sessions.
- **Invalidate caches on mutations.** File content cache must clear entries on write, delete, rename. Prefetch cache must clear on session eviction.
- **Use TTLs to prevent redundant fetches.** If a session was fetched <15s ago, skip re-fetching — SSE events keep it current.

### Directory context

- **Never cache directory strings in closures.** Directory can change at any time (worktree switch). Read it dynamically from `opencodeClient.getDirectory()` at call time.
- **Pass directory hints when the source of truth isn't available yet.** Newly created sessions aren't in the sync store until SSE delivers them. Pass the known directory as a parameter instead of relying on lookup.

## Regression-prevention checklist

- When adding fallback logic, ask: can stale persisted data keep this path active forever?
- When deriving UI state, ask: is this live state, historical state, or inferred state?
- When adding store fields, ask: who reads this, how often does it change, and should it live elsewhere?
- When touching polling or bootstrap, ask: can a lighter payload erase richer existing data?
- When handling optimistic updates, ask: where is rollback, reconciliation, and duplicate prevention?
- When changing shared routes or state contracts, ask: what breaks in web and Android?
- When fixing a bug with a heuristic, prefer narrowing the heuristic over widening it.

## Validation expectations

- Run type-check/lint validation before finalizing source-code changes that can affect TypeScript, runtime behavior, builds, lint rules, package resolution, or generated assets, and run `bun run dead-code` when the change can add, remove, rename, or reshape files, exports, types, workspace entrypoints, or module imports. Keep validation scoped to the edited workspace by default. Prefer the package-level command for the package you changed (for example the relevant workspace's `type-check`/`lint`) instead of workspace-wide `bun run type-check` / `bun run lint`. Use workspace-wide checks only when the change spans multiple workspaces, shared package contracts, root tooling/config, dependency resolution, generated assets used across packages, or when a narrower command cannot cover the risk. Use a sufficiently long tool timeout for any broad checks (for example 240000ms) so successful package-level results are not lost to a tool timeout. For docs-only or isolated config-only changes, run the narrowest relevant validation instead (for example JSON/schema validation) and do not run full checks unless the change can affect code execution.
- For hot-path changes, verify behavior under streaming or repeated events, not just static render.
- For sync or startup changes, verify fresh load, retry/failure, and restart behavior.
- For session changes, verify create, stream, abort, permission, archive/delete, and revisit flows when relevant.

## Recent changes

- Releases + high-level changes: `CHANGELOG.md`
- Recent commits: `git log --oneline` (latest tags: `v1.11.7`, `v1.11.6`)
