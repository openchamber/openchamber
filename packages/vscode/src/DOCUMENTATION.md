# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`) and shared webview host plumbing.

## Purpose

Keep `bridge.ts` and webview providers as thin orchestration layers that delegate to cohesive domain modules while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution.

- `gitService.ts`
  - Owns VS Code Git and worktree operations.
  - Fast worktree creation reports bootstrap phases explicitly: `directory-created`, then `git-ready` after Git population/upstream work, and `setup-ready` after setup commands. Existing worktrees without tracked bootstrap state fall back to `ready`/`setup-ready`; shared webview consumers also accept legacy responses without `phase`.
  - Worktree removal waits for an active create/bootstrap task for the same directory so background Git and setup work cannot race deletion or restore stale bootstrap state.
  - Worktree population enables Git `core.longpaths` (local repo config plus `-c core.longpaths=true` on `git reset --hard`) so deeply nested checkouts under the managed data-dir worktree root do not fail on Windows MAX_PATH with "Filename too long".

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper

The webview CSP permits `blob:` only for `worker-src` so shared UI parsers can run bounded local decompression off the main thread. Blob scripts remain disallowed by `script-src`.

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - SSE routes are intentionally excluded from the generic proxy and use `sseProxy.ts`, whose upstream-only stall watchdog closes a quiet OpenCode stream so the webview can reconnect instead of trusting an open but silent response.
  - The webview allocates each SSE stream ID and installs its listener before requesting the upstream stream, so immediate OpenCode replay events cannot race the bridge start response.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Owns managed OpenCode upgrade status and mutation handlers, including capability reporting, upgrade serialization, and process restart after a successful upgrade.
  - Provider handlers cover source lookup, disconnect (`DELETE /api/provider/:id/auth`), and custom provider upsert (`PUT /api/provider`; create/update OpenAI-compatible config with explicit `scope` for user/project/custom layers; requires `env` or stored auth; secrets via OpenCode auth API).

- `opencode-upgrade-runtime.ts`
  - Owns managed-versus-external capability decisions, latest-version checks, serialized OpenCode self-upgrades, and restart-after-upgrade behavior.

- `bridge-permission-auto-accept-runtime.ts`
  - Owns the persisted VS Code permission auto-accept policy and its GET/PUT bridge contract.
  - Serializes reads and read-modify-write updates, persists a monotonic policy revision, and broadcasts the exact committed snapshot to every active OpenChamber webview. Permission replies remain foreground UI-owned because VS Code does not run the OpenChamber server runtime.

## Shared webview host modules

- `webviewSseSession.ts`
  - Shared SSE start/stop/abort used by Chat, Agent Manager, and Session Editor providers.
  - Preserves the contract that bridge replies report HTTP status in `data` while `success` stays `true`.
  - Pure stream-id/header helpers live in `webviewSseHelpers.ts` for unit testing without the VS Code host.

- `activeEditorFile.ts`
  - Debounced active-editor file + selection broadcast shared by Chat and Session Editor.

- `webviewHostMessages.ts`
  - Theme, connection status, settings sync, permission-auto-accept, and window-focus fan-out helpers.

- `webviewMessageRetry.ts`
  - Ack-tracked postMessage retries used by the chat sidebar.

- `sidebarPlacement.ts`
  - One-shot secondary-sidebar placement for VS Code hosts (skipped on Cursor-like hosts).

- `openCodeStatusReport.ts`
  - Builds the OpenCode status/debug report for `OpenChamber: Show OpenCode Status`.

## Webview entry modules (`packages/vscode/webview`)

- `main.tsx` — bootstrap only: runtime APIs, theme, loading overlay, fetch interceptor, command/notification registration, app mount.
- `httpHelpers.ts` — URL/header/response helpers for the fetch interceptor.
- `localApiRequest.ts` — OpenChamber-owned `/api/*` route emulation in the webview.
- `fetchInterceptor.ts` — `window.fetch` override (local routes, SSE, session-message, generic OpenCode proxy).
- `loadingOverlay.ts` — splash overlay lifecycle.
- `commandHandlers.ts` — extension → webview command handlers.
- `notifications.ts` — native notification claiming and session event notifications.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

When adding webview host behavior shared by multiple panels, put it in a shared module under `packages/vscode/src/` rather than duplicating it across providers.
