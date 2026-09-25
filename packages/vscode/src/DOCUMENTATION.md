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
  - Generation runs through OpenCode's `POST /api/experimental/generate`, which answers with the finished text. There is no throwaway session to create, poll and delete any more.
  - Generation model choice lives in `bridge-git-generation-model.ts`: request model first, then the user's small-model override (`smallModelUseDefault === false` plus `smallModelOverride` as `provider/model`) when the catalog has it, then the zen fallback. The old `gitProviderId`/`gitModelId` pair is no longer read.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution. Both bridge helpers and `gitService.ts` use this executor; the latter passes the Git binary selected by VS Code's Git extension.
  - Reads both output streams and gives commands EOF on stdin. A signal exit is a failure, never exit code zero. File ignore checks pass their deadline to this executor so timeout terminates the child tree rather than abandoning a live command behind `Promise.race`. Other Git commands have no new time limit.
  - Tracks outstanding commands through completion and timeout cleanup. Extension deactivation awaits `stopGitProcesses`, which terminates active work and rejects later launches. Operations delegated to VS Code's built-in Git API remain owned by that extension.

- `owned-process.ts`
  - Owns background child termination shared by Git and managed OpenCode. POSIX children have a separate process group, which receives SIGKILL after the grace period or root exit so a SIGTERM-resistant descendant cannot survive. Windows enumerates and terminates the tree before losing its root, using an asynchronous hidden `taskkill` invocation. Completion waits for stdio closure; failed termination remains an error.

- `managed-opencode-process.ts` and `opencode.ts`
  - The process handle and shared registry entry exist from spawn, before readiness. Startup timeout, malformed output, and cancellation terminate the child before the attempt settles. Registry removal follows confirmed termination. Startup diagnostics retain a bounded output tail; ready processes keep draining both streams.
  - Manager operations run in order. Stop cancels in-flight readiness/health probes and invalidates older queued starts/restarts. A later explicit start can run after stop. Startup passes an explicit cwd to the child without changing the extension host's cwd.
  - Shutdown targets owned processes rather than whichever process happens to listen on a remembered port. External OpenCode receives no spawn or termination request.
  - `bridge-git-process-runtime.test.ts` and `managed-opencode-process.test.ts` use real subprocesses for repeated deadlines, signal exits, stdin EOF, large stderr, deactivation, startup failure, and resistant descendants. The manager was also exercised in an isolated macOS VS Code 1.137.0 extension host with a controlled server fixture. Before the fix, two restarts left two orphaned tool processes beside the active server and its tool. After the fix, only the active pair remained, and stop removed it. The complete fixed scenario created eight processes across startup, restarts, and cancellation, with none surviving. Native Windows process-tree behavior remains unverified on the macOS test host.

- `gitService.ts`
  - Owns VS Code Git and worktree operations.
  - `api:git/diff` and `api:git/file-diff` classify the status path first through `gitPathDiff.ts`, matching the web server's diff routes. The host answers `{ kind: 'diff' | 'file-diff', ..., submodule }` or `{ kind: 'unavailable', reason: 'path_not_found' | 'nested_repository', message }`, and `webview/api/git.ts` parses that into the shared contract, throwing `GitPathUnavailableError` for unavailable paths. A failing `git diff` rejects instead of returning an empty patch. These handlers are currently dead bridge surface (see below), so the contract is covered by `gitPathDiff.test.ts` and `webview/api/git.test.ts` rather than by a reachable screen.
  - Fetches the current tracked source branch once before worktree creation. Fetch failure falls back to the local branch and reports it to the shared UI.
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
  - `/api/fs/directory-stat` returns 501 locally. Directory-availability probes remain unknown in VS Code rather than falling through to OpenCode.
  - Workspace-contained Markdown gallery images use these local filesystem
    routes without calling the server grant route. Grant requests for OpenCode
    temporary-directory images return an explicit unsupported response instead
    of being forwarded to OpenCode.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - The webview forwards the request path unchanged (`/api/<x>` → `/api/<x>`): OpenCode 2.x serves its own routes under `/api`, so nothing strips the prefix.
  - SSE routes are intentionally excluded from the generic proxy and use `sseProxy.ts`, whose upstream-only stall watchdog closes a quiet OpenCode stream so the webview can reconnect instead of trusting an open but silent response.
  - The webview allocates each SSE stream ID and installs its listener before requesting the upstream stream, so immediate OpenCode replay events cannot race the bridge start response.
  - OpenCode 2.x has one global stream, `GET /api/event`. Every frame names its own `location.directory`, so the proxy no longer scopes the request to a directory.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - OpenCode JSONC reads in `opencodeConfig.ts` fail closed on a partial or non-object `jsonc-parser` tree (`INVALID_JSONC`) so mutations cannot rewrite a `$schema`-only stub over an existing config. Comment-only files read as empty, while other content that yields no JSON value (YAML, plain text) fails closed. A broken layer is omitted from the merge and recorded on `layerErrors`; valid sibling layers still load, including plugin list/read via `getPluginConfigSources`. Writes still refuse to overwrite the broken file.

- `bridge-project-setup-runtime.ts`
  - Extension-host side of `GET/PUT /api/projects/:projectId/config` (the webview handles the route locally and bridges `api:project-setup:get` / `api:project-setup:update`). Reads and writes the client-owned keys of `~/.config/openchamber/projects/<projectId>.json` (worktree setup commands, project actions, draft starters) with the rules in `project-setup.ts`, a mirror of the server's `packages/web/server/lib/projects/project-setup.js`; keep the two in sync. The file name follows the server's bounded rule (`projectConfigFileStemOf`, mirrored from `packages/web/server/lib/projects/project-id.js`): an id over 200 characters is stored as `path_sha256_<digest>.json` so a deeply nested checkout does not exceed the file name limit. A file an older build wrote under the long name is still read when the bounded one is missing and is removed once a write has moved its content. Writes to one file are chained; server-owned and unknown keys survive. The read also merges the team's optional `<workspace>/.openchamber/project.json` (checkout path decoded from the `path_<base64url>` id) by the same rules as the server, so the webview sees one view with `shared` / `personal` blocks. The shared UI (`openchamberConfig.ts`) no longer composes that path or reads it through the fs bridge.
- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.
  - Writes are gated by the generated registry snapshot (`settings-registry.json`, via `settings-registry-gate.ts`): keys the registry does not list, or marks `computed`, `local`, or `owner: desktop-shell`, never reach the shared settings files. Regenerate the snapshot with `bun run settings-registry:generate` when the UI registry changes.
  - Shared settings live in two files under `~/.config/openchamber/`, split by `settings-files.ts` (a pure mirror of the server's `settings-files.js`; both write the same bytes): `settings.json` holds instance facts and legacy keys, `preferences.json` (`{ version: 1, fields: { key: { value, updatedAt } } }`) holds every registry `profile` key. `updatedAt` is stamped by the extension host only when a value actually changes. Reads return the merged view (preferences win). A missing `preferences.json` is seeded once from the profile keys still in `settings.json`; every write keeps a copy of the profile's base values in `settings.json` too, so a build from before the split (which reads only that file) still finds the user's preferences; it is ignored by current builds.
  - An existing but unparseable `preferences.json` is a failure, not an empty profile: it is never seeded over or rewritten, one warning is logged per process, reads return `settings.json` only, and writes drop the profile part until a later read succeeds.
  - Both files are written atomically (tmp file + rename). Write failures throw, so `persistSettings` rejects and the webview sees the save fail instead of a silent success.
  - The extension host is always the `vscode` surface kind: per-surface profile keys it changes land under `surfaces.vscode` in `preferences.json` and reads resolve `vscode` first, base otherwise (mirrors the server's header-driven behaviour).

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`, and `/api/sessions/status`, where busy phases become the host status seed the shared UI reads for unopened directories).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Owns managed OpenCode upgrade status handlers and capability reporting.
  - Provider handlers cover source lookup, disconnect (`DELETE /api/provider/:id/auth`), and custom provider upsert (`PUT /api/provider`; create/update OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages config with explicit `scope` for user/project/custom layers; requires `env` or stored auth; secrets via OpenCode auth API). Updates preserve existing provider, option, and retained-model fields that the form does not manage while honoring explicit model, header, and env removal. Legacy `providers` entries migrate to the canonical `provider` key when edited.
  - Quota handlers keep managed exe.dev, Ollama Cloud, and Cursor credentials in the extension data directory with the same private-file contract as the web runtime. exe.dev uses one command-scoped usage token for the aggregate billing shared by every `exe-*` model provider.
  - `ollamaQuota.ts` owns the Ollama settings request and parser shared by credential validation and quota refresh. Both reject redirects, failed HTTP responses, and pages without parsed windows, with a 15-second request timeout. Validation finishes before the bridge writes a replacement cookie. Monthly dollar quotas and legacy session/weekly/premium quotas remain supported; zero extra-credit balances are omitted.

- OpenCode v1 recovery
  - `api:opencode/compatibility` is available even when managed startup rejects v1. The UI checks it before configuration and session bootstrap.
  - `api:opencode/install-v2` runs the shared `v2-install.js` installer on macOS, Linux and Windows through the manager queue. Concurrent webviews share the operation. The extension selects the verified binary in the effective VS Code configuration scope, restarts, and requires connected v2 status before reporting success. Stop invalidates pending restart work.
  - The webview bridge waits without its default 30-second timeout. External URLs use manual installation. Filesystem rollback, standard installation location and cross-process locking follow the web runtime's CLI migration contract.

- `opencode-upgrade-runtime.ts`
  - Owns managed-versus-external capability decisions and latest-version checks.
  - Managed runtimes run the resolved CLI with `upgrade` through the manager's operation queue and the shared `packages/web/server/lib/opencode/cli-upgrade.js` executor. The queued action resolves the CLI with the same fallback as capability reporting; it does not require a live server process just to update the binary. OpenCode chooses its installer. Concurrent webviews share one installation; failures allow another attempt. The existing Reload action restarts the server afterwards. The bridge waits for command completion without its default 30-second timeout. External connections and missing CLIs reject upgrades before spawning. Version checks remain available for external connections.

- `bridge-permission-auto-accept-runtime.ts`
  - Owns the persisted VS Code permission auto-accept policy and its GET/PUT bridge contract.
  - Serializes reads and read-modify-write updates, persists a monotonic policy revision, and broadcasts the exact committed snapshot to every active OpenChamber webview. Permission replies remain foreground UI-owned because VS Code does not run the OpenChamber server runtime.

- `InlineCommentThreads.ts`
  - Owns the `openchamber.inlineComments` comment controller: the gutter `+` range, the thread opened by `openchamber.addLineComment`, and every thread a submitted comment leaves anchored in the editor until the message goes out.
  - A thread never owns a draft. It mints the draft id, hands the payload to a chat webview with the same routing as Add to Context (the active session panel when one exists, else the sidebar, revealed if needed), and follows the webview's whole-draft-list `inlineComments:sync` snapshots: present means show, absent after having been seen means dispose. A snapshot is tagged with the surface that produced it (a panel id or `sidebar`) and only decides that surface's own threads, because every webview runs its own draft store.
  - A comment the composer never confirms holding within 30 s is retracted from every surface's pending hold, its thread disposed, and the user told, so a thread cannot promise a send that will never happen.
  - `inlineCommentSelection.ts` holds the pure pieces (line ranges, the diff-side and real-path resolution for `git:` documents, the pending hold, removal broadcast, thread fate) without the `vscode` import so they are unit-tested directly.
  - Webview side: `webview/inlineCommentTarget.ts` decides where a delivered comment is filed. A session panel stamps its session on every comment it delivers and the webview waits until it shows that session; the sidebar files on its current session or open draft. Filing on the first snapshot with a directory put the draft under `draft` while a fresh panel was still loading its session list, a key that composer never reads. `webview/inlineCommentRemovals.ts` remembers removals that arrive before a delayed delivery lands, so a comment dropped while its panel was still booting does not appear as a chip later. The extension is not activated on startup for this; the right-click command activates it, and the gutter `+` appears from then on.

## Shared webview message ordering

The bridge sends `webview:ready` once per document, before its first outbound
message. Sidebar, session-editor, and agent-manager hosts abort that panel's old
SSE streams before accepting new requests and resend the current connection
state. A VS Code webview reload or cross-window move replaces the document
without disposing its panel; relying only on panel disposal leaked one upstream
stream per reload, including its ongoing idle heartbeat traffic.

Each host also sends `viewerStateChanged` with `{ windowFocused, surfaceVisible }`: on resolve and on `webview:ready`, when the VS Code window gains or loses focus, and when that view or panel is shown or hidden. The webview parses it at the bridge and hands it to `packages/ui/src/lib/surfaceAttention.ts`, which decides whether a finished turn in the selected session counts as seen. The webview document's own `hasFocus()` is not used for this, because focus in the code editor would otherwise mark a visible chat as unread.

Message and part ordering is owned by [`packages/ui/src/sync/DOCUMENTATION.md`](../../ui/src/sync/DOCUMENTATION.md#session-message-loading). The VS Code webview consumes that shared sync implementation; bridge and proxy runtimes pass OpenCode records through without adding runtime-specific ordering.

The OpenChamber control stream (`/api/openchamber/events`) requires the
OpenChamber server, which the extension does not run. `subscribeOpenchamberEvents`
therefore returns a no-op subscription in VS Code before resolving URLs or
opening a connection. Session sync still uses the OpenCode SSE bridge and
global session polling. Sending the control stream to the webview origin caused
repeated `403` responses and URL-token requests to `/auth/url-token`.

Shared lazy imports retry a failed chunk load, but skip browser-navigation
recovery in VS Code. `window.location.reload()` is unsupported inside webviews;
the original import error must reach the UI error boundary instead.

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
| Permission / form cards | MOUNTED | `ChatContainer` → `PermissionCard`, `FormCard` |
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

Reachable filesystem routes: `api:fs:read` (attachments), `api:fs:search`
(`useFileSearchStore` behind composer file mentions), `api:fs:list`, `api:fs:stat`.

Maintenance: reviews, changelog entries, and parity claims consult this map;
whoever mounts or unmounts a surface updates it in the same change.

## Network connections

Extension activation applies `networkDefaults.ts` before registering handlers.
It gives Node connection attempts 5 seconds, matching the web runtime, so quota
requests to distant providers can connect. This is an extension-host process
default, including other Node connections in that host. Address-family selection
stays unchanged; runtimes without the setter retain their existing behavior.

## OpenCode version requirement

The extension requires OpenCode 2.x. `opencode.ts` runs `opencode --version` before
spawning a managed server and refuses to start on anything else
(`opencodeVersion.ts` parses the CLI's `opencode v2.0.2` line). A 1.x binary would
start and serve a different API, leaving the user with a webview that loads and
then fails every request, so the failure is reported up front instead.

Readiness comes from the `server listening on <url>` line on stdout, confirmed
by `GET /api/info` (OpenCode 2.0.8 removed `/api/health`). A 200 is the whole
readiness answer; the payload carries `{ version, pid, urls, paths }` and no
`healthy` field.

## Global OpenCode paths

`opencodeConfigPaths.ts` owns the global config directory for config CRUD,
skill discovery/install, global AGENTS.md, and quota config-file lookup. It
resolves `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode` at extension startup (the same rule OpenCode 2 applies);
only `opencode.json(c)` is a config file, the v1 `config.json` is not read. Project paths, the explicit
`OPENCODE_CONFIG` file layer, and the auth data directory stay separate.
No files are migrated. The behavior GET bridge response includes the effective
`path` for both existing and missing AGENTS.md files; shared Settings uses it
in the warning.

## OpenCode 2 config shapes

`opencodeConfig.ts` is the extension-host mirror of the web server's
`packages/web/server/lib/opencode/*` entity modules. Both must write identical
files, so all the shape logic lives in one place: `opencode-config-v2.ts` is a
thin re-export of `packages/web/server/lib/opencode/config-v2.js`, bundled in by
esbuild the same way `provider-env-aliases.ts` is. Do not reimplement a
conversion here — add it to the web module and it lands in both runtimes.

Ownership and the v1 fallback policy are documented once, in
`packages/web/server/lib/opencode/DOCUMENTATION.md` under "Entity routes
(v2 shapes)". The short version:

- Reads accept the v2 keys (`agents`, `commands`, `providers`, `mcp.servers`,
  `plugins`, `permissions`) and fall back to the v1 keys OpenCode 2 still
  decodes (`agent`, `command`, `provider`, `mcp.<name>`, `plugin`,
  `permission`/`tools`). v2 wins when both exist.
- Writes emit v2 only, into the v2 directory (`.opencode/agents/`,
  `.opencode/commands/`, `.opencode/skills/<id>/`, `.opencode/plugins/`).
- Files are never moved. Updating an entity that lives in a v1 file rewrites it
  at its own path in v2 shape, and a v1 JSON entry moves to the v2 section key
  inside the same file. Every mutation returns the `path` it wrote.

Bridge surface (`bridge-config-runtime.ts`), matching the web routes:

- `api:config/agents` — `GET` answers the `sources` envelope; `GET` with
  `resource: "config"` answers `{ source, scope, path, legacy, config }` and
  with `resource: "permissions"` answers `{ global, agent, effective, source,
  path }`. `POST`/`PATCH` take an `AgentEntity` body (a v1 `permission` map and
  the v1 `prompt` alias are still accepted) and report the written `path`.
- `api:config/commands` — same, with `resource: "config"` and a `CommandEntity`;
  `subtask` is accepted as the v1 name for `subagent`.
- `api:config/mcp` — `McpEntity` bodies; entries carry `sectionKey` and
  `legacy`.
- `api:config/websearch` — `PUT /api/config/websearch`; `{ selection }` is
  `false`, `null` (remove the key), `"random"` or a provider id, written with
  the shared `writeWebSearchSelection` to `OPENCODE_CONFIG` or the user config.
  `{ method: "GET", directory }` returns `{ projectPath }` from the shared
  `findWebSearchProjectOverride`: the project config that overrides that write.
- `api:config/warming` — `PUT /api/config/warming`; `{ enabled }` turns session
  warming on (`true`, keeping a hand-tuned object) or off (removes the key),
  written with the shared `writeWarmingEnabled` to the same file.

## Session archive and metadata

OpenCode 2.x has no route that archives a session, so archive flags are
OpenChamber-owned state. `openchamberSessionState.ts` keeps the same
`sessions-archive.json` the OpenChamber server keeps, in the shared OpenChamber
config directory (`~/.config/openchamber`, `%APPDATA%\openchamber` on
Windows), which is also the web server's default data directory: a session
archived from VS Code is archived in the desktop app on the same machine, and
the other way round. Nothing is cached between calls because two processes can
write the file; every write re-reads first and replaces the file atomically.

Session metadata lives on the OpenCode record (`PATCH /api/session/{id}`,
OpenCode 2.0.15+). OpenCode replaces the whole object, so a write reads the
record, applies the JSON Merge Patch (RFC 7386) and writes the result, and
features sharing the `openchamber` namespace do not erase each other. An entry
an older version left in `sessions-metadata.json` is laid over the record on
reads and pushed to OpenCode on that session's next write, then dropped from
the file; the web server sweeps the rest.

The webview answers `POST /api/openchamber/sessions/archive|unarchive` and
`GET|POST /api/openchamber/sessions/:id/metadata` through the
`api:sessions/*` bridge cases in `bridge-system-runtime.ts`, and
`bridge-proxy-runtime.ts` folds `time.archived` and not-yet-migrated metadata
onto every proxied `GET /api/session` and `GET /api/session/:id` response, the
same overlay the web proxy applies.

## Extension localization

Two bundles carry extension-host text: `package.nls*.json` for the manifest
`%token%` strings and `l10n/bundle.l10n*.json` for the `t(...)` call sites.
Every locale file must cover the full English key set with the same `{0}`
placeholders — VS Code silently falls back to English per missing key, so a
half-translated locale looks like a shipped feature. `localizationBundles.test.ts`
enforces that, and it is the check to run whenever a feature adds a new string.

The pre-bundle loading splash in `webviewHtml.ts` is separate: its strings are
inlined in the generated HTML because the splash renders before the webview
bundle loads. It picks them from OpenChamber's own saved locale
(`openchamber.i18n.v1` in webview localStorage) and, before the user has
chosen one, from VS Code's display language, which the HTML exposes as
`window.__OPENCHAMBER_HOST_LANGUAGE__`. The UI bundle reads the same value as
its default locale (`detectInitialLocale`), so a fresh install in a supported
language starts in that language on both the splash and the app.
