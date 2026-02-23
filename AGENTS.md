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
- External server support: Set `OPENCODE_PORT` and `OPENCODE_SKIP_START=true` to connect to existing OpenCode instance

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
- Toasts: use custom toast wrapper from `@/components/ui` (backed by `packages/ui/src/components/ui/toast.ts`); do not import `sonner` directly in feature code.
- No new deps unless asked.
- Never add secrets (`.env`, keys) or log sensitive data.

## Theme System (MANDATORY for UI work)

When working on any UI components, styling, or visual changes, agents **MUST** study the theme system skill first.

**Before starting any UI work:**
```
skill({ name: "theme-system" })
```

This skill contains all color tokens, semantic logic, decision tree, and usage patterns. All UI colors must use theme tokens - never hardcoded values or Tailwind color classes.

## Recent changes
- Releases + high-level changes: `CHANGELOG.md`
- Recent commits: `git log --oneline` (latest tags: `v1.4.6`, `v1.4.5`)
