# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

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
    - active-directory selection across multi-root workspaces
    - dropped-file parsing and attachment reading
    - models metadata fetch helper
  - Read paths are authorized in the requested workspace path space before symlink resolution, matching the web runtime; directly requested outside-workspace paths remain denied.

The webview CSP permits `blob:` only for `worker-src` so shared UI parsers can run bounded local decompression off the main thread. Blob scripts remain disallowed by `script-src`.

The webview build emits each worker as one self-contained file. VS Code webviews cannot load workers directly from extension resource URLs or load module imports from inside a worker. The shared Shiki client therefore fetches the built worker, starts it from a `blob:` URL, and relies on the worker CSP allowance above.

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.
  - Workspace-contained Markdown gallery images use these local filesystem
    routes without calling the server grant route. Grant requests for OpenCode
    temporary-directory images return an explicit unsupported response instead
    of being forwarded to OpenCode.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - SSE routes are intentionally excluded from the generic proxy and use `sseProxy.ts`, whose upstream-only stall watchdog closes a quiet OpenCode stream so the webview can reconnect instead of trusting an open but silent response.
  - The webview allocates each SSE stream ID and installs its listener before requesting the upstream stream, so immediate OpenCode replay events cannot race the bridge start response.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - OpenCode JSONC reads in `opencodeConfig.ts` fail closed on a partial or non-object `jsonc-parser` tree (`INVALID_JSONC`) so mutations cannot rewrite a `$schema`-only stub over an existing config. Comment-only files read as empty, while other content that yields no JSON value (YAML, plain text) fails closed. A broken layer is omitted from the merge and recorded on `layerErrors`; valid sibling layers still load, including plugin list/read via `getPluginConfigSources`. Writes still refuse to overwrite the broken file.

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

## Shared webview message ordering

Message and part ordering is owned by [`packages/ui/src/sync/DOCUMENTATION.md`](../../ui/src/sync/DOCUMENTATION.md#session-message-loading). The VS Code webview consumes that shared sync implementation; bridge and proxy runtimes pass OpenCode records through without adding runtime-specific ordering.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## VS Code surface reachability map

Verified 2026-08-28 against `8f5eb231b`.

Three webview hosts, all rendering `renderVSCodeApp` → `VSCodeApp`
(`packages/ui/src/apps/VSCodeApp.tsx`):

- `ChatViewProvider.ts` — sidebar view, `panelType: 'chat'`, `viewMode: 'sidebar'`.
- `SessionEditorPanelProvider.ts` — editor tab, `panelType: 'chat'`, `viewMode: 'editor'`.
- `AgentManagerPanelProvider.ts` — editor tab, `panelType: 'agentManager'` → `AgentManagerView`, no `VSCodeLayout`.

`VSCodeLayout` has exactly three views: `sessions`, `chat`, `settings`
(`packages/ui/src/components/layout/VSCodeLayout.tsx:76`). There is no
`MainLayout`, no `ContextPanel`, and no `ContextPanelRail` in this runtime, so
every surface reached only through those is unreachable.

### Surfaces

| Surface | Status | Mount chain / cut-off |
|---|---|---|
| Chat timeline | MOUNTED | `VSCodeLayout` → `ChatView` → `ChatContainer` → `MessageList` |
| Composer | MOUNTED | `ChatContainer` → `ChatInput` (model/agent controls, autocomplete, attachments, dictation, GitHub issue/PR pickers, `ReviewFlowDialog`, `PendingChangesBar`) |
| Work status panel | MOUNTED | `ChatContainer` → `WorkStatusPanel` |
| Permission / question cards | MOUNTED | `ChatContainer` → `PermissionCard`, `QuestionCard` |
| Timeline dialog | MOUNTED | `ChatContainer` → `TimelineDialog` |
| Tool output / inline diff preview | MOUNTED | `MessageList` → `ToolPart`, `ToolOutputDialog` (`DiffViewToggle`, not `DiffView`) |
| Sessions sidebar | MOUNTED | `VSCodeLayout` → `SessionSidebar` with `mobileVariant hideDirectoryControls` |
| Session dialogs | MOUNTED | `VSCodeLayout` → `SessionDialogs` |
| Session switcher | MOUNTED | `VSCodeHeader` → `SessionSwitcherDropdown` |
| MCP dropdown | MOUNTED | `VSCodeHeader` `showMcp` → `McpDropdown` |
| Context usage / rate limits | MOUNTED | `VSCodeHeader` `showContextUsage` / `showRateLimits` → `ContextUsageDisplay`, `UsageProgressBar` |
| Agent manager | MOUNTED | `VSCodeApp` `panelType === 'agentManager'` → `AgentManagerView` |
| Settings | PARTIAL | `VSCodeLayout` → lazy `SettingsView`. `metadata.ts` `isAvailable: (ctx) => !ctx.isVSCode` hides `remote-instances`, `git`, `shortcuts`, `magic-prompts`, `voice`, `tunnel`, `about` |
| Usage / quota page | MOUNTED | `SettingsView` → `UsagePage` (slug `usage`, no VS Code gate) |
| Notifications settings | MOUNTED | `SettingsView` → slug `notifications` (no VS Code gate) |
| MCP settings | MOUNTED | `SettingsView` → `McpSidebar` / `McpPage` |
| Agents / commands / skills / plugins / providers / projects settings | MOUNTED | `SettingsView` page registry |
| Worktrees | PARTIAL | Create/remove reachable via `SessionSidebar` → `NewWorktreeDialog` and `sessionWorktreeMenu`. `WorktreesView` is `MainLayout`-only |
| Git | PARTIAL | Read-only status/branches/log via `useGitStore` in `SessionSidebar`, `ChatInput`, `WorkStatusPrimaryGroup`. Stage/commit/push/history/merge/rebase live in `GitView` + `views/git/*`, cut off with `ContextPanel` |
| Voice / dictation | PARTIAL | `ComposerDictation` renders in `ChatInput`; the `voice` settings page is VS Code-gated |
| Command palette | PARTIAL | `useKeyboardShortcuts` runs from `SyncAppEffects` and `open_command_palette` toggles `isCommandPaletteOpen`, but `CommandPalette` renders only in `MainLayout` — the shortcut opens nothing |
| ContextPanel / project context (notes, todos, plans tabs) | NOT MOUNTED | `ContextPanel`, `ContextPanelRail`, `RightSidebarTabs` imported only by `MainLayout` and `MobileWorkspaceDrawer` |
| Terminal | NOT MOUNTED | `TerminalView` imported only by `ContextPanel` and `MobileWorkspaceDrawer`. `webview/api/index.ts` ships `createStubTerminalAPI()` whose every method throws unsupported |
| Files view | NOT MOUNTED | lazy `FilesView` in `ContextPanel`; `SidebarFilesTree` is `MainLayout`-only |
| Diff view | NOT MOUNTED | lazy `DiffView` in `ContextPanel` |
| Git view | NOT MOUNTED | lazy `GitView` in `ContextPanel` |
| Plan view | NOT MOUNTED | lazy `PlanView` in `ContextPanel`, `ProjectNotesTodoPanel`, `MobileApp` |
| Pull request view | NOT MOUNTED | `PullRequestView` imported only by `ContextPanel` |
| Browser panel | NOT MOUNTED | `BrowserPane` imported only by `ContextPanel`; `RuntimeAPIs` has no browser member in `webview/api/index.ts` |
| Walkthrough | NOT MOUNTED | `WalkthroughView` imported only by `ContextPanel` |
| Archive view | NOT MOUNTED | `ArchiveView` imported only by `MainLayout` |
| Scheduled tasks | NOT MOUNTED | `ScheduledTasksDialog` imported only by `MainLayout` |
| Memory debug panel | NOT MOUNTED | `MemoryDebugPanel` imported only by `App.tsx` (web/desktop root) |
| Mini chat | NOT MOUNTED | `MiniChatLayout` imported only by `ElectronMiniChatApp` |

### Dead bridge surface

Handlers with no reachable caller in the VS Code webview.

| Handler | Why unreachable |
|---|---|
| `api:git/ignore-openchamber` | No reference anywhere in `packages/vscode/webview` |
| `api:git/commit`, `api:git/commit-files`, `api:git/commit-file-diff` | Only `GitView` and `views/git/*` call them |
| `api:git/log` (write paths), `api:git/checkout`, `api:git/checkout-commit`, `api:git/reset-to-commit`, `api:git/revert-commit`, `api:git/cherry-pick` | `views/git/HistoryCommitRow.tsx` only |
| `api:git/merge`, `api:git/merge/abort`, `api:git/merge/continue`, `api:git/rebase`, `api:git/rebase/abort`, `api:git/rebase/continue`, `api:git/conflict-details` | `GitView` only |
| `api:git/push`, `api:git/pull`, `api:git/fetch` | `GitView` and `MobileChangesSurface` only |
| `api:git/diff`, `api:git/file-diff` | `DiffView` only |
| `api:git/pr-description` | `views/git/PullRequestSection.tsx` only |
| `api:git/identity` | `git` settings page is VS Code-gated |
| `api:github/pr:create`, `api:github/pr:merge`, `api:github/pr:ready`, `api:github/pr:update` | `views/git/PullRequestSection.tsx` only. `api:github/pr:status` stays reachable through `useGitHubPrStatusStore` in the sidebar |
| `api:fs:write`, `api:fs:rename`, `api:fs:delete`, `api:fs:reveal`, `api:fs:mkdir` | `FilesView`, `SidebarFilesTree`, `PlanView` only |
| `api:fs:exec` | Terminal API is a throwing stub; no other caller |

Reachable filesystem routes: `api:fs:read` (attachments, config), `api:fs:search`
(`useFileSearchStore` behind composer file mentions), `api:fs:list`, `api:fs:stat`.

Maintenance: reviews, changelog entries, and parity claims consult this map;
whoever mounts or unmounts a surface updates it in the same change.
