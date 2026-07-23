# OpenChamber Agent Guide

## Purpose

OpenChamber provides shared web, desktop, VS Code, hosted-mobile, and native-mobile UI surfaces for OpenCode.

This file contains only always-on repository rules and routing. Detailed workflows belong to project skills and module documentation.

## Instruction Order

Before editing:

1. Follow this root guide.
2. Load every matching project skill.
3. Read the nearest `DOCUMENTATION.md` and package `README.md` when present.
4. Follow local code and test precedent.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, OpenChamber server, managed/external OpenCode lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/vscode`: extension host, webview, and runtime bridge.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing OpenChamber server.
- `packages/docs`: product documentation; not a Bun workspace.

Shared UI calls official OpenCode APIs through `@opencode-ai/sdk/v2`. OpenChamber-owned capabilities use `RuntimeAPIs`, `runtimeFetch`, and shared browser/realtime transport helpers. Server-side upstream integrations may use their owning runtime modules.

Electron starts the OpenChamber backend in-process, never as a sidecar. Development may load loopback/HMR UI; packaged builds load staged assets through `openchamber-ui://` while the loopback server remains the API backend. Keep domain backends in web/runtime modules unless behavior is inherently native.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, VS Code, hosted mobile, and Capacitor mobile.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Do not run git or GitHub commands unless the user explicitly asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Keep changes minimal and preserve unrelated worktree changes.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.
- Keep entrypoints and bridges thin; place domain logic in focused owning modules.
- Update owning documentation when module ownership, contracts, or invariants change.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.
- Runtime-specific differences must be intentional and visible in code.

## Documentation Discovery

Before changing a module, search for the nearest `DOCUMENTATION.md`; before package-level work, read its `README.md`. Discover docs dynamically under `packages/**/DOCUMENTATION.md` rather than relying on a static exhaustive map.

High-value anchors:

- Sync: `packages/ui/src/sync/DOCUMENTATION.md`
- Stores: `packages/ui/src/stores/DOCUMENTATION.md`
- CLI: `packages/web/bin/lib/DOCUMENTATION.md`
- VS Code runtime: `packages/vscode/src/DOCUMENTATION.md`
- Electron: `packages/electron/README.md`
- Mobile: `packages/mobile/README.md`

## Project Skills

Project skills live under `.agents/skills/*/SKILL.md`. Before editing, load every matching skill; multiple skills may apply. Skills are canonical for their detailed workflows and checklists.

| Trigger | Required skill |
|---|---|
| Any source, dependency, export, build-config, generated-asset, package-contract, or module-ownership change | `openchamber-change-discipline` |
| CLI commands, prompts, terminal output, non-TTY, `--quiet`, or `--json` behavior | `clack-cli-patterns` |
| Shared UI data access, OpenCode SDK, `RuntimeAPIs`, runtime fetch/auth/URLs, bridges/proxies, runtime switching, or server API routes | `ui-api-decoupling` |
| Electron main/preload, IPC, native UI, updater, deep links, SSH/tunnels, packaging, or child processes | `desktop-shell` |
| Session sync, bootstrap/reconnect, reducers, polling, optimistic state, queues, live status, reconciliation, or directory-scoped caches | `sync-state-invariants` |
| Render/store/event hot paths, large lists, caching/indexing, high CPU/memory, lag, jank, freezes, or performance regressions | `performance-engineering` |
| WebSocket, SSE, streaming transport, runtime transport internals, or private relay | `relay-transport` |
| Secure Workspaces policy, providers, isolation, egress, credentials, lifecycle, export/review/apply, handoff, plugin pins, runtime images, or release workflows | `secure-workspaces` |
| UI components, styling, colors, buttons, or icons | `theme-system` |
| User-facing or accessible UI text, labels, aria, toasts, dialogs, or navigation copy | `locale-ui-patterns` |
| Settings UI, settings dialogs, configuration surfaces, or settings search | `settings-ui-patterns` |
| Sortable or drag-to-reorder behavior, especially `@dnd-kit` and touch/wrapping layouts | `drag-to-reorder` |
| iOS Simulator build, launch, preview, gestures, or `serve-sim` control | `serve-sim` |

Pure code-reading or explanation does not require implementation skills unless needed to interpret a specialized subsystem.

## Validation

- Use `package.json` scripts as the command source of truth.
- Prefer focused tests and package-scoped type-check/lint for executable source changes.
- Use workspace-wide checks for cross-workspace contracts, root tooling, dependencies, or shared generated assets.
- Run `bun run dead-code` when source files are added/deleted/renamed or exports, types, entrypoints, or import shape change; inspect its report because it is non-blocking.
- Do not assume TypeScript/lint covers server JS, CLI JS, Electron helpers, or native behavior; run focused tests, syntax checks, builds, or runtime validation for the touched surface.
- For docs-only or isolated config changes, run the narrowest relevant validation.
- Report exactly what was and was not validated. Static checks alone do not prove runtime, relay, performance, or platform correctness.
