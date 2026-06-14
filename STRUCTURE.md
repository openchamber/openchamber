# Codebase Structure

## Directory Layout

```
openchamber/
├── packages/
│   ├── web/               # Web server + CLI + UI build
│   ├── ui/                # Shared React UI components and stores
│   ├── electron/          # Desktop Electron shell
│   ├── vscode/            # VS Code extension
│   └── docs/              # Documentation content
├── scripts/               # Build and utility scripts
├── docs/                  # Deployment guides and assets
├── .claude/               # Claude Code skills
├── .agents/               # Agent skills
├── .github/               # GitHub workflows
└── patches/               # Dependency patches
```

## Package Purposes

**packages/web:**
- Purpose: Web server runtime, CLI entry point, UI build output
- Contains: Express server (`server/index.js`), CLI (`bin/cli.js`), React app entry (`src/main.tsx`)
- Key files: `server/lib/opencode/*` (OpenCode integration), `server/lib/tunnels/*` (Cloudflare/ngrok), `server/lib/event-stream/*` (SSE/WS)

**packages/ui:**
- Purpose: Shared React UI consumed by all runtimes
- Contains: Components, Zustand stores, sync layer, runtime API contracts
- Key files: `src/App.tsx` (main app), `src/sync/*` (event pipeline), `src/stores/*` (state), `src/lib/api/types.ts` (API contracts)

**packages/electron:**
- Purpose: Desktop shell for macOS/Windows
- Contains: Electron main process, preload bridge, SSH manager, tray controller
- Key files: `main.mjs` (entry), `preload.mjs` (IPC bridge), `ssh-manager.mjs` (SSH handling)

**packages/vscode:**
- Purpose: VS Code extension for editor-native workflow
- Contains: Extension entry, panel providers, bridge to OpenCode
- Key files: `src/extension.ts` (entry), `src/ChatViewProvider.ts` (webview), `src/bridge.ts` (IPC)

## Directory Purposes

**packages/web/server/lib/:**
- Purpose: Server-side runtime modules
- Contains: Route handlers, runtime controllers, integration logic
- Key modules:
  - `opencode/` — OpenCode server lifecycle, config, session management
  - `event-stream/` — SSE/WS event distribution
  - `fs/` — Filesystem routes and search
  - `git/` — Git operations via simple-git
  - `github/` — GitHub OAuth, PR/issue integration
  - `notifications/` — Push and desktop notifications
  - `terminal/` — PTY management for terminal integration
  - `tunnels/` — Cloudflare/ngrok tunnel providers
  - `quota/` — Provider usage quota tracking
  - `ui-auth/` — UI session authentication

**packages/ui/src/:**
- Purpose: React UI implementation
- Contains: Components, stores, hooks, utilities
- Key directories:
  - `apps/` — App variants (Web, Mobile, Electron, VS Code)
  - `components/` — Reusable UI components
  - `stores/` — Zustand state stores (50+ stores, split by domain)
  - `sync/` — Event pipeline and session sync
  - `lib/` — Utilities, API contracts, runtime bridges

**packages/ui/src/components/:**
- Purpose: React component library
- Contains: Chat UI, file browser, diff viewer, terminal, settings panels
- Key subdirs:
  - `chat/` — Message rendering, input, tool UIs
  - `session/` — Session sidebar, timeline
  - `files/` — File browser, tabs
  - `terminal/` — Ghostty-web terminal integration
  - `sections/settings/` — Settings page sections

## Key File Locations

**Entry Points:**
- Web: `packages/web/index.html` → `packages/web/src/main.tsx`
- Desktop: `packages/electron/main.mjs`
- VS Code: `packages/vscode/src/extension.ts`
- CLI: `packages/web/bin/cli.js`

**Configuration:**
- Root: `package.json` (monorepo config, workspaces)
- Web: `packages/web/package.json`
- UI: `packages/ui/package.json`
- Electron: `packages/electron/package.json`
- VS Code: `packages/vscode/package.json`

**Core Logic:**
- Server runtime: `packages/web/server/index.js`
- OpenCode integration: `packages/web/server/lib/opencode/`
- UI sync: `packages/ui/src/sync/sync-context.tsx`
- Zustand stores: `packages/ui/src/stores/`

**Build Config:**
- Vite: `vite.config.ts`
- TypeScript: `tsconfig.json`
- ESLint: `eslint.config.js`
- Tailwind: `postcss.config.js`, `vite-theme-plugin.ts`

## Naming Conventions

**Files:**
- Components: `PascalCase.tsx` (e.g., `ChatInput.tsx`, `SessionSidebar.tsx`)
- Stores: `camelCase.ts` with `use` prefix (e.g., `useConfigStore.ts`, `useGitStore.ts`)
- Utils: `camelCase.ts` (e.g., `runtime-fetch.ts`, `api-types.ts`)
- Server modules: `camelCase.js` (e.g., `routes.js`, `runtime.js`)
- Tests: `*.test.ts` or `*.spec.ts`

**Directories:**
- Features: `kebab-case/` (e.g., `chat/`, `session/`, `terminal/`)
- Collections: `plural/` (e.g., `stores/`, `components/`, `lib/`)

**Variables/Functions:**
- React components: `PascalCase`
- Hooks: `camelCase` with `use` prefix
- Store actions: `camelCase`
- Server routes: `camelCase`

## Where to Add New Code

**New server route:**
- Location: `packages/web/server/lib/[module]/routes.js`
- Pattern: Register with Express app in `packages/web/server/index.js`

**New OpenCode integration:**
- Location: `packages/web/server/lib/opencode/[feature-name].js`
- Pattern: Create runtime controller, register in startup pipeline

**New UI component:**
- Location: `packages/ui/src/components/[feature]/`
- Pattern: Follow existing component patterns, use Base UI primitives

**New Zustand store:**
- Location: `packages/ui/src/stores/use[Domain]Store.ts`
- Pattern: Split by change frequency; narrow subscriptions; avoid wide store

**New desktop feature:**
- Location: `packages/electron/main.mjs` or new module
- Pattern: Add IPC handler in preload + main; gate in main process

**New VS Code feature:**
- Location: `packages/vscode/src/`
- Pattern: Add command in `extension.ts`, create provider class, update bridge

**New tunnel provider:**
- Location: `packages/web/server/lib/tunnels/providers/[provider].js`
- Pattern: Implement tunnel provider interface, register in registry

**Tests:**
- Location: Co-located with source as `*.test.ts` or `*.spec.ts`
- Pattern: Jest/Playwright for integration; Vitest for unit

## Runtime Variations

**Web:**
- Serves from `packages/web/public/` (built UI)
- Connects to embedded or external OpenCode server

**Desktop (Electron):**
- Runs web server in same Node process
- Loads UI from `http://127.0.0.1:<port>`
- Native features via Electron APIs

**VS Code:**
- Webview-based UI (served from dev server or bundled)
- IPC through VS Code extension API
- Shares UI package with web/desktop
