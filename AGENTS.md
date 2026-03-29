# OpenChamber - AI Agent Reference (verified)

## Core purpose
OpenChamber provides UI runtimes (web/desktop/VS Code) for interacting with an OpenCode server (local auto-start or remote URL). UI uses HTTP + SSE via `@opencode-ai/sdk`.

## Runtime architecture (IMPORTANT)
- `Desktop` is a thin Tauri shell that starts the web server sidecar and loads the web UI from `http://127.0.0.1:<port>`.
- All backend logic lives in `packages/web/server/*` (and `packages/vscode/*` for the VS Code runtime). Desktop Rust is not a feature backend.
- Tauri is used only for stable native integrations: menu, dialog (open folder), notifications, updater, deep-links.

## Tech stack (source of truth: `package.json`, resolved: `bun.lock`)
- Runtime/tooling: Bun (`package.json` `packageManager`), Node >=20 (`package.json` `engines`)
- UI: React, TypeScript, Vite, Tailwind v4
- State: Zustand (`packages/ui/src/stores/`)
- UI primitives: Radix UI (`package.json` deps), HeroUI (`package.json` deps), Remixicon (`package.json` deps)
- Server: Express (`packages/web/server/index.js`)
- Desktop: Tauri v2 (`packages/desktop/src-tauri/`)
- VS Code: extension + webview (`packages/vscode/`)

## Monorepo layout
Workspaces are `packages/*` (see `package.json`).
- Shared UI: `packages/ui`
- Web app + server + CLI: `packages/web`
- Desktop app (Tauri): `packages/desktop`
- VS Code extension: `packages/vscode`

## Documentation map
Before changing any mapped module, read its module documentation first.

### web
Web runtime and server implementation for OpenChamber.

#### lib
Server-side integration modules used by API routes and runtime services.

##### quota
Quota provider registry, dispatch, and provider integrations for usage endpoints.
- Module docs: `packages/web/server/lib/quota/DOCUMENTATION.md`

##### git
Git repository operations for the web server runtime.
- Module docs: `packages/web/server/lib/git/DOCUMENTATION.md`

##### github
GitHub authentication, OAuth device flow, Octokit client factory, and repository URL parsing.
- Module docs: `packages/web/server/lib/github/DOCUMENTATION.md`

##### opencode
OpenCode server integration utilities including config management, provider authentication, and UI authentication.
- Module docs: `packages/web/server/lib/opencode/DOCUMENTATION.md`

##### notifications
Notification message preparation utilities for system notifications, including text truncation and optional summarization.
- Module docs: `packages/web/server/lib/notifications/DOCUMENTATION.md`

##### terminal
WebSocket protocol utilities for terminal input handling including message normalization, control frame parsing, and rate limiting.
- Module docs: `packages/web/server/lib/terminal/DOCUMENTATION.md`

##### tts
Server-side text-to-speech services and summarization helpers for `/api/tts/*` endpoints.
- Module docs: `packages/web/server/lib/tts/DOCUMENTATION.md`

##### skills-catalog
Skills catalog management including discovery, installation, and configuration of agent skill packages.
- Module docs: `packages/web/server/lib/skills-catalog/DOCUMENTATION.md`

## Build / dev commands (verified)
All scripts are in `package.json`.
- Validate: `bun run type-check`, `bun run lint`
- Build all: `bun run build`
- Desktop build: `bun run desktop:build`
- VS Code build: `bun run vscode:build`
- Release smoke build: `bun run release:test` (shell script: `scripts/test-release-build.sh`)

## Runtime entry points
- Web bootstrap: `packages/web/src/main.tsx`
- Web server: `packages/web/server/index.js`
- Web CLI: `packages/web/bin/cli.js` (package bin: `packages/web/package.json`)
- Desktop: Tauri entry `packages/desktop/src-tauri/src/main.rs` (spawns web server sidecar + loads web UI)
- Tauri backend: `packages/desktop/src-tauri/src/main.rs`
- VS Code extension host: `packages/vscode/src/extension.ts`
- VS Code webview bootstrap: `packages/vscode/webview/main.tsx`

## OpenCode integration
- UI client wrapper: `packages/ui/src/lib/opencode/client.ts` (imports `@opencode-ai/sdk/v2`)
- SSE hookup: `packages/ui/src/hooks/useEventStream.ts`
- Web server embeds/starts OpenCode server: `packages/web/server/index.js` (`createOpencodeServer`)
- Web runtime filesystem endpoints: search `packages/web/server/index.js` for `/api/fs/`
- External server support: Set `OPENCODE_HOST` (full base URL, e.g. `http://hostname:4096`) or `OPENCODE_PORT`, plus `OPENCODE_SKIP_START=true`, to connect to existing OpenCode instance

## Key UI patterns (reference files)
- Settings shell: `packages/ui/src/components/views/SettingsView.tsx`
- Settings shared primitives: `packages/ui/src/components/sections/shared/`
- Settings sections: `packages/ui/src/components/sections/` (incl `skills/`)
- Chat UI: `packages/ui/src/components/chat/` and `packages/ui/src/components/chat/message/`
- Theme + typography: `packages/ui/src/lib/theme/`, `packages/ui/src/lib/typography.ts`
- Terminal UI: `packages/ui/src/components/terminal/` (uses `ghostty-web`)

## External / system integrations (active)
- Git: `packages/ui/src/lib/gitApi.ts`, `packages/web/server/index.js` (`simple-git`)
- Terminal PTY: `packages/web/server/index.js` (`bun-pty`/`node-pty`)
- Skills catalog: `packages/web/server/lib/skills-catalog/`, UI: `packages/ui/src/components/sections/skills/`

## Agent constraints
- Do not modify `../opencode` (separate repo).
- Do not run git/GitHub commands unless explicitly asked.
- Keep baseline green (run `bun run type-check`, `bun run lint`, `bun run build` before finalizing changes).

## Development rules
- Keep diffs tight; avoid drive-by refactors.
- Backend changes: keep web/desktop/vscode runtimes consistent (if relevant).
- Follow local precedent; search nearby code first.
- TypeScript: avoid `any`/blind casts; keep ESLint/TS green.
- React: prefer function components + hooks; class only when needed (e.g. error boundaries).
- Control flow: avoid nested ternaries; prefer early returns + `if/else`/`switch`.
- Styling: Tailwind v4; typography via `packages/ui/src/lib/typography.ts`; theme vars via `packages/ui/src/lib/theme/`.
- Shared UI patterns: for "series of items + divider + series of items" layouts, use shared UI primitives instead of duplicating ad-hoc markup in feature components.
- Toasts: use custom toast wrapper from `@/components/ui` (backed by `packages/ui/src/components/ui/toast.ts`); do not import `sonner` directly in feature code.
- No new deps unless asked.
- Never add secrets (`.env`, keys) or log sensitive data.

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

## Clack CLI Skill (MANDATORY for terminal CLI work)

When working on terminal CLI commands, prompts, or output formatting, agents **MUST** study the Clack CLI skill first.

**Before starting terminal CLI work:**
```
skill({ name: "clack-cli-patterns" })
```

Scope: terminal CLI only (for example `packages/web/bin/*`). Do not apply this requirement to VS Code or web UI work.

## Theme System (MANDATORY for UI work)

When working on any UI components, styling, or visual changes, agents **MUST** study the theme system skill first.

**Before starting any UI work:**
```
skill({ name: "theme-system" })
```

This skill contains all color tokens, semantic logic, decision tree, and usage patterns. All UI colors must use theme tokens - never hardcoded values or Tailwind color classes.

## Performance rules (MANDATORY)

These rules exist because violating them has caused measurable regressions (render cascades, memory bloat, UI jank). They apply to all UI and sync layer work.

### Zustand referential equality

Zustand skips re-renders when a selector returns the same reference (`Object.is`). Every new object/array reference triggers a re-render in every subscriber.

- **Never spread all state fields in an update.** Only create new references for fields that actually changed. A `message.part.delta` event should not clone `session`, `permission`, etc.
- **Select leaf values, not containers.** `useStore((s) => s.permission[sessionID])` is correct. `useStore((s) => s.permission)` subscribes to every permission change across all sessions.
- **Preserve references when merging.** If prepending older messages, keep existing message object references. Only add truly new items. Return the original array if nothing was added.

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

### Optimistic updates

- **Use the shadow Map pattern.** Insert optimistic data into the store for instant UI, AND register it in a separate tracking Map. Cleanup happens deterministically via `mergeOptimisticPage` on the next data fetch — not via heuristics in the event reducer.
- **Pass client-generated IDs to the server.** Use the same ID format as the server (hex-encoded timestamps). Pass `messageID` to `promptAsync` so the server echoes back the same ID. This prevents duplicates and enables in-place replacement.
- **Rollback on error.** Remove the optimistic entry from both the store and the shadow Map.

### Scroll and DOM

- **Never use `await waitForFrames()` for scroll preservation.** Frames of visible scroll jump are unacceptable. Use `useLayoutEffect` to adjust scroll synchronously after React commits DOM — before the browser paints.
- **Capture scroll state before the state change, restore in layout effect.** The pattern: save `scrollHeight`/`scrollTop` into a ref before triggering the update, consume it in `useLayoutEffect` on the rendered output.

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

## Recent changes
- Releases + high-level changes: `CHANGELOG.md`
- Recent commits: `git log --oneline` (latest tags: `v1.4.6`, `v1.4.5`)
