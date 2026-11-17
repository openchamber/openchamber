# OpenCode Module Documentation

## Purpose
This module provides OpenCode server integration utilities for the web server runtime, including configuration management and provider authentication.

Diagnostic logging for the timeline export (`proxy.js` error lines, the lifecycle journal, the local diagnostics route in `core-routes.js`) is described in `../diagnostics/DOCUMENTATION.md`.

## Entrypoints and structure
- `packages/web/server/lib/opencode/index.js`: public entrypoint (currently baseline placeholder).
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/project-start-command.js`: the project's start command (`commands.start`) that the web server and the VS Code extension host run in every worktree they create. OpenCode 2.x keeps it on its project record, so the reader asks the running OpenCode in the directory the worktree is requested from (the contributor trust prompt asks in the primary checkout, never inside the fork's checkout): `GET /api/location` names the project, whose ID 2.x derives from the origin remote and so differs from OpenChamber's root-commit worktree ID, and `GET /api/project` holds the record. Reads carry an 8-second deadline, so a stalled OpenCode lands in the same path as a failed read: no command runs, a warning is logged, and the worktree is still created. Wired once per runtime with `configureProjectStartCommandSource`, the way `auth.js` is.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/cli-entry-runtime.js`: CLI entrypoint runtime that detects direct execution, parses CLI options, and starts server bootstrap.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/v1-migration-topup.js`: re-arms OpenCode's own V1 -> V2 session import for V1 sessions changed by 1.x after the last completed import; runs only before a managed spawn. See "v1-migration-topup.js" below.
- `packages/web/server/lib/opencode/managed-opencode-state.js`: state file, launch fingerprint, adopt-or-replace decision, and log-file cursor helpers for the managed OpenCode process (see "Managed OpenCode across OpenChamber restarts" below).
- `packages/web/server/lib/opencode/managed-servers.js`: the `GET /api/managed-servers` read for external tooling (design #612 phase 2, #525). It builds the versioned response from the managed-process registry and draining records through the validated readers in `lifecycle.js`, completes the hosting instance's own entry from lifecycle state (directory, version last reported in the health payload, ready/starting/draining status, live session count from the session runtime), and leaves every field it cannot verify null with status `unknown` for other instances' servers. Entries whose pid is gone leave the list. The projection is an explicit allowlist of seven keys per server; the managed password, agent-tool token, launch fingerprint, args, binary, and owner pid in the source records never reach the response, and a test pins the key set.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). It records each lifecycle transition (launch, ready, exit, restart, health failure and recovery, external connect) as a fixed action in the process-local diagnostic journal (`../diagnostics/server-journal.js`), which the diagnostic timeline exports; the journal never holds stderr, paths or error text. After readiness it warms the last-used directory only (first entry of the `getWarmupDirectories` dep, best-effort) because OpenCode initializes each directory lazily on first request and that cost would otherwise be paid by the user's first interactive session open. It warms no other projects: on OpenCode 2 the first directory-scoped read boots that location's whole MCP fleet. The warmed directory is also `getDefaultOpenCodeDirectory()`, the scope for server-side reads that have no directory of their own (integrations in `auth.js`, the small model's model and provider lists, the agent check after a restart): v2 answers a location read without one for its own working directory, the user's home for a managed OpenCode, and would start an MCP fleet there. While no warmed directory is usable (no project open), the getter answers the `noProjectDirectory` dep instead, the managed chats root, which the UI also works in then. Once the UI saves the directory it moved to (`lastDirectory`, reported by the settings runtime's `onLastDirectoryChanged`), `noteCurrentDirectory` makes that directory the default: the UI runs it anyway, and the one used last at startup may be a chat the user left, whose location the UI stops; a read there, such as the quota's integration list every 3 minutes, started it again. The getter revalidates that directory on every read: once it is no longer a readable directory (deleted, moved, replaced by a file, or stripped of read/execute permission) it is never sent, and the lifecycle advances to another directory the warm pass validated or re-reads `getWarmupDirectories` (coalesced, with a short cooldown) so a currently-valid `lastDirectory` replaces the stale one. A stale cached path would otherwise make every directory-scoped read answer `500 FileSystem.realPath ... ENOENT` — the failure that took the quota credential read down with it.
- The managed OpenCode's environment also carries the user's variables from Settings and from `opencode service set env` (`getUserEnvironment`, see `../environment`), over the inherited environment and under everything OpenChamber sets for OpenCode itself; enterprise mode passes none. `getManagedOpenCodeProcessEnv()` therefore includes them, so a provider key given this way is visible to the credential reader like any other variable OpenCode reports.
- `packages/web/server/lib/opencode/provider-env-aliases.js`: mirrors known provider credential env aliases into the managed OpenCode process environment (for example `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`) so OpenCode connection detection and the upstream AI SDK agree on the same key names. Canonical implementation shared by web lifecycle and the VS Code managed spawn path (`packages/vscode/src/provider-env-aliases.ts` re-exports this module).
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration. OpenCode 2 watches these files, so a write is live as soon as it lands and the route answers plain success.
- `packages/web/server/lib/opencode/websearch-config.js`: writes OpenCode's `websearch` choice (`PUT /api/config/websearch` in `routes.js`; body `{ selection: false | null | "random" | "<provider id>" }`, `null` removes the key, so OpenCode falls back to the answer given in its chat consent form, which it keeps in its own store) to `OPENCODE_CONFIG` when set, else the user config. `GET /api/config/websearch` returns `{ projectPath }`, the discovered config whose `websearch` overrides that write. OpenCode loads user config, then `OPENCODE_CONFIG`, then discovered direct files, then discovered `.opencode` files. Discovery reaches the filesystem root, including ancestors above the worktree. Settings locks the choice and names the winning file unless that file is itself the write target; `findWebSearchProjectOverride` in `config-v2.js` holds the rule. The pure transform is `writeWebSearchSelection` in `config-v2.js`, shared with the VS Code bridge (`api:config/websearch`).
- `packages/web/server/lib/opencode/messaging-config.js`: reads and writes OpenCode's `messaging` section for Settings → Messaging, in the same file as the web search choice. OpenCode applies a changed section without a restart, so nothing restarts. `GET /api/config/messaging` returns `{ messaging, path, projectPath }`: the raw section from that file or `null`, the file path, and the project config whose `messaging` overrides it, found by the same rule as `websearch` through `findProjectConfigOverride` in `config-v2.js`. Global JSON and JSONC files are excluded from project attribution even when the selected directory is below the global config directory. `PUT /api/config/messaging` takes `{ messaging: <object> | null }`, where `null` removes the key, and returns `{ messaging, path, changed }`. A zod schema that mirrors OpenCode's refuses unknown keys and wrong values with a 400 that names the path. A value equal to the stored one leaves the file untouched. Enterprise mode refuses the write with a 403, because the section can name a remote embedding endpoint. The VS Code bridge has no handler, since Settings hides the page there.
- `packages/web/server/lib/opencode/config-mutation-response.js`: shared response builders for applied config mutations and external manual-restart guidance.
- `packages/web/server/lib/opencode/snippets.js`: opencode-snippets-compatible snippet file CRUD, discovery, and hashtag expansion.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/managed-process-stop.js`: how the lifecycle stops its managed OpenCode on Windows: closes the `serve --stdio` lease, waits a bounded grace period, then force-kills the tree (see the teardown paragraph below). Also owns `hasChildProcessExited` and `waitForChildProcessClose`.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/guest-services/terminal/process/server teardown.
- `packages/web/server/lib/opencode/npm-registry-config.js`: resolves npm package metadata requests from inherited npm registry settings or the user's `.npmrc`, including scoped registries and matching bearer/basic HTTP authentication.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration. Source-control provider registration is delegated to `lib/source-control/routes.js`. One exact persisted-credential resolver, including optional revision pinning, is shared by transport binding, clone planning, contributor transfer, execution, and safe HTTPS binding-read presentation. The managed SSH inventory supplies the matching verified-fingerprint projection without exposing its key record or path. Server composition supplies one durable worktree-bootstrap store to both Git and OpenChamber-session routes; the runtime exposes a lazy bound-checkout hydration adapter so session-created worktrees use the same local inspection and exact parent authority rules as Git-route worktrees.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/upgrade-capability.js`: authoritative upgrade ownership policy for the active OpenCode runtime. Bundled, external, and unresolved runtimes fail closed; only managed non-bundled runtimes delegate upgrades to OpenCode.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/startup-performance.js`: opt-in startup phase diagnostics with fixed labels and numeric metadata allowlists.
- `packages/web/server/lib/agent-tool/runtime.js`: managed OpenCode custom-tool materialization, environment injection, same-machine authentication (loopback, or the bound address for a concrete bind), and fixed CLI action dispatch.
- `packages/web/server/lib/opencode/managed-plugin-config.js`: the `OPENCODE_CONFIG_CONTENT` merge used only on the fallback path, when the user's own environment owns `OPENCODE_CONFIG`.
- `packages/web/server/lib/opencode/managed-config-file.js`: the managed OpenCode config layer — materializes the enabled OpenChamber plugins (agent tools, system prompt optimizer) and publishes them in a file OpenCode watches.
- `packages/web/server/lib/opencode/instance-dir.js`: this server's own folder under `<data-dir>/run/instances/<pid>/` for the files its managed OpenCode reads, and removal of folders whose owner is gone. A server that adopts a running managed OpenCode (a self-handoff successor, or a restart) takes over the folder saved with the managed state (`instanceDir` in `state.json`) when its owner is gone or is the predecessor handing off; the new owner's pid goes in the folder's `owner` file, which removal reads before the folder name. Otherwise the adopting server's `OPENCODE_CONFIG` path, and with it the launch fingerprint, would differ and it would start a second OpenCode, and the adopted one's config folder would be removed. A second live server on the same data dir keeps its own folder.

### Snippet loading

`snippets.js` reads Markdown files from the global and project snippet directories during each list, get, and expansion call. Before reading a file, it checks the byte size against `SNIPPET_FILE_MAX_BYTES` (4 MiB). A larger file produces the existing load warning and is skipped; siblings continue to load. Files exactly at the limit are accepted. This is a per-file limit, not a combined registry limit.

#### Why snippets use a per-file cap

A per-file cap lets the registry skip one oversized snippet while keeping valid siblings available. Total memory can still grow with the number of snippets under the cap.

### Managed plugins on OpenCode 2.x
A configured plugin must be a DIRECTORY holding a `package.json` that resolves an
entrypoint; a path to a `.js` file is skipped with "configured plugin path must
be a directory". The config key is `plugins` (an array of absolute directory
paths), not `plugin`.

The generated entrypoint has no imports. OpenCode loads it with a plain dynamic
`import()`, and resolution happens from the plugin's own directory, where nothing
is installed — `import { Plugin } from "@opencode/plugin"` fails there. None of
it is needed: a plugin only has to default-export `{ id, setup }`, and a tool's
`input` accepts plain JSON Schema.

Two v1 affordances are gone and the generated tools work around them: a tool
result has no `title` (it travels in `metadata`) and must not carry `output`
unless an output schema is declared; and a tool call no longer receives
`context.directory` or `context.abort`, so the callback sends `context.sessionID`
and OpenChamber resolves the directory itself.
- `packages/web/server/lib/opencode/server-utils-runtime.js`: shared server runtime utilities for OpenCode proxy wiring, OpenCode port/readiness helpers, and snapshot fetchers.
- `packages/web/server/lib/opencode/openchamber-routes.js`: OpenChamber update and models metadata route registration.
- `packages/web/server/lib/opencode/mcpx-routes.js`: the mcpx daemon proxy under `/api/mcpx/*`, including the secret prompt routes in "mcpx secret routes" below. `mcpx-daemon.js` holds the daemon client, and `mcpx-secrets.js` the secret operations that these routes and the VS Code host share.
- `packages/web/server/lib/opencode/model-discovery.js`: bounded custom-provider `/models` discovery and optional models.dev enrichment. It accepts only http(s), does not follow redirects, filters transport headers, never returns credentials, and treats models.dev failure as unenriched success. Edit requests may name the provider so the host can fall back to a stored credential when the form leaves the key blank — the key from OpenCode's credential store or, failing that, the provider's stored config entry (`settings.apiKey`, else the first `env` variable name that is set in the server environment) — but only while the form's base URL still matches the saved one, so a changed URL never receives the stored credential; an explicitly entered replacement key wins.
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization). Writes run one at a time through `runExclusive`; a failed write fails only its own call and the next write still runs. `persistSettings(changes)` writes given changes; `updateSettings(compute)` reads the migrated settings — the same view `readSettingsFromDiskMigrated` gives every other reader, so ids looked up elsewhere (the canonical path-derived project ids, the legacy `lastDirectory` project) resolve inside `compute` even on a settings file no migrated read has persisted yet — calls `compute` for the changes (or `null` for none) and writes them under the same lock, for edits derived from the current value, such as a list changed by id. With no project stored, the legacy migration turns a stored `lastDirectory` into the first project, except a folder inside the chats roots (`chatRoots` dep, compared lexically and by realpath): with no project open the UI's last directory is usually a chat's, and a chat belongs to no project.
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep. `lastDirectory: ''` is kept as written: the UI sends it when the last project is removed, and every reader (the warm-up, the legacy last-directory-to-project migration, request directory resolution) treats it as unset.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.

  `POST /api/config/themes` saves a converted VS Code palette. The runtime validates
  literal colors and required authored roles, assigns a content-derived filename,
  and publishes through a same-directory hard link so partial files and overwrites
  are impossible. Identical retries reuse the existing file; a manually edited
  collision returns 409. Temporary files are ignored by the loader and removed
  after publication or failure. `readThemeFileBounded` opens with `O_NONBLOCK` on
  POSIX before checking the opened file type, so a FIFO, including one behind a
  supported theme symlink, is rejected promptly. The reader follows symlinks to
  regular theme files; `O_NOFOLLOW` would break that behavior. Non-missing-directory
  read failures propagate to the route instead of returning an authoritative empty
  library.

  The common request middleware parses theme POST bodies before these routes;
  integration tests must use that middleware rather than an unrestricted test parser.
  `DELETE /api/config/themes/:id` finds a valid regular JSON file by its metadata ID
  inside the custom themes directory. IDs are never used as filenames. Hand-added
  themes are supported; symlinks and bundled themes are outside deletion ownership.
  Duplicate matching IDs fail explicitly. Missing themes are an idempotent success;
  filesystem failures remain errors.
  `theme-catalog.js` owns POST catalog search/package routes under
  `/api/config/themes/catalog/`. It fetches only Open VSX and its Eclipse CDN over
  HTTPS, validates redirects and checksums, and verifies packaged identity.
  `theme-archive.js` reads selected JSON entries in memory with bounded decompression.
  JSON includes and token references stay inside the package. Each failed variant
  is reported separately so valid siblings remain available. No extension code runs.

### Project icon discovery

The discover route opens the selected favicon once, checks its size through that handle, reads at most 5 MiB + 1 byte, and closes the handle before storing the icon. A file that grows after the size check is rejected with the existing over-limit response without being buffered past the cap. Empty files and files already over the cap keep their existing 400 responses.

#### Why discovery reads through one handle

Stat and read on a path resolve it independently, so replacing or growing the favicon between those calls can bypass the size gate and buffer the whole file. The open handle fixes the file identity, and the extra byte detects growth beyond 5 MiB while bounding the read.
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration. An SSE stream (`/api/event`, `/api/global/event`) forwards whole blocks with their `id:` lines and keeps a cursor (`../event-stream/sse-cursor.js`) of the last id it forwarded. When OpenCode closes its stream between blocks, or the connection fails, the browser response stays open and the proxy reconnects with `Last-Event-ID` set to that cursor, backing off up to 2 s and giving up after `SSE_RESUME_WINDOW_MS` (30 s) without a forwarded block. A `server.resync` frame (OpenCode sends it when a cursor belongs to another instance, is malformed, is from the future, or has aged out of its replay window) passes through unchanged, and the cursor restarts from the head id it carries. A stall still ends the stream, and a cut in the middle of a block ends it too, since those bytes already reached the browser and EventSource discards the fragment on end-of-stream; the browser then reconnects with its own last id. An upstream that answers the event route with a non-SSE content type is streamed through chunk by chunk with backpressure under the same stall window, so a large or never-ending body cannot buffer whole in the proxy (#759).
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/opencode/atomic-write.js`: `writeFileAtomic(filePath, content)`, the one atomic file replace for files OpenCode watches (same-directory temp file, fsync, rename; mode of an existing file kept; a symlink, dangling or not, is followed to its file; a read-only file is refused like an in-place write; on Windows a rename refused with EPERM/EACCES/EBUSY falls back to a direct write). Used by `shared.js` and the VS Code extension host's `opencodeConfig.ts`.
- `packages/web/server/lib/opencode/config-v2.js`: the canonical OpenCode 2 shape layer — section-key resolution (v2 first, v1 fallback), permission map -> rule array translation, model `provider/model#variant` split/join, and the agent/command/MCP/provider/plugin entity conversions. Pure functions with no filesystem access; `packages/vscode/src/opencode-config-v2.ts` re-exports it so the web server and the extension host cannot write different files. See "Entity routes (v2 shapes)" below.
- `packages/web/server/lib/opencode/worktree-directory.js`: resolves OpenCode's `worktree.directory` into the absolute parent directory for new worktrees — relative paths start at the canonical checkout, absolute paths are used as-is, and a leading `~` means home. Pure; `shared.js` reads the merged config on the canonical checkout and the VS Code extension host re-exports the module through `packages/vscode/src/worktree-directory.ts`, so both runtimes put worktrees in the same place. Null when unset, so `packages/web/server/lib/git/service.js` keeps the data-dir default.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Public exports (auth.js)
`auth.js` is read-only. OpenCode 2.x owns every credential and, since 2.0.20,
hands them back over `GET /api/credential`, secrets included. OpenChamber needs
the raw credential for provider quota lookups, voice keys and routing, so
`readOpenCodeCredentials()` asks the running OpenCode, through the connection
`server/index.js` wires with `configureOpenCodeCredentials()`. Concurrent
callers share one request; nothing is cached between calls. A failed read
throws, so an unreachable OpenCode never reads as "no keys".

Clients never get that list. `GET /api/credential` (any spelling OpenCode
routes the same way, matched by `isCredentialListRequest` in
`../enterprise-mode.js`) answers 403 `credential_list_refused` before the
generic proxy, in and out of enterprise mode: anyone signed in to the UI,
over a tunnel or a paired phone too, would otherwise read every key. Renaming,
switching and removing an account still reach OpenCode.

`POST /api/vcs/init` (OpenCode 2.0.23, runs `git init`) answers 400 with an
`InvalidRequestError` body when it would create a repository in the home
directory, at a disk root, or in OpenCode's own working directory because no
directory was named (`vcsInitRefusal` in `../git/repository-root.js`). Git
surfaces ignore a repository there, so the user would get a repository that
covers every file and a Git tab that still says "not a repository". The UI
hides its Initialize Git button in the same places.

Keys OpenCode takes from environment variables (`ZAI_API_KEY`, ...) are never
stored and `/api/credential` does not list them; `GET /api/integration` names
the variable behind each such connection, but not its value. For a managed
OpenCode the lifecycle keeps the exact environment it launched the process
with (`getManagedOpenCodeProcessEnv()`), and the reader takes the value from
there, only for variables OpenCode itself reports. A stored credential wins
over a variable, as in OpenCode. An external OpenCode runs with its own
environment, so its variable keys stay unknown and are left out.
`getProviderAuth()` answers stored credentials only: it asks whether a login
exists in OpenCode's store.

- `configureOpenCodeCredentials(source | null)`: wires the reader to a `{ list }` credential source; reads throw until it is wired.
- `openCodeCredentialSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders, getLaunchEnvironment? })`: the running OpenCode as that source, URL and headers read per call; `getLaunchEnvironment` returns the managed launch environment or null.
- `openCodeLocalCredentialSource({ env?, dbPath? })`: OpenCode's credential store read straight from its database file (`OPENCODE_DB`, else `opencode.db` under the XDG data directory), in the same row shape and order the server lists — selection sorts each integration's chosen row last and that row is marked active. Read-only, no launch environment. It exists for readers on the same machine when no server is listening (the quota CLI's fallback); the server and VS Code keep the running OpenCode as their only source.
- `readOpenCodeCredentials()`: each integration's active credential, keyed by
  integration id (the provider id for providers), in the legacy `auth.json`
  entry shape (`{ type: 'api', key }` /
  `{ type: 'oauth', access, refresh, expires, accountId?, enterpriseUrl?, server?, orgID? }`).
  The OAuth projection keeps only `server` and `orgID` from OpenCode Console
  credential metadata, so quota providers can identify a Console sign-in
  without carrying account names or emails.
- `getProviderAuth(providerId)`: that map's entry for one provider, or null.
- `projectCredentialEntries(entries)`: the wire-to-legacy projection.
- `projectEnvironmentKeys(integrations, environment)`: variable values for the env connections OpenCode reports, by integration id.

The VS Code extension host uses this same module through
`packages/vscode/src/opencodeAuth.ts`, which only builds the source from its
OpenCode manager (`getManagedLaunchEnvironment()` there).

### v1-migration-topup.js

OpenCode 2.x imports the legacy `session`/`message`/`part` tables into
`session_v2`/`session_message` once and then records `{"phase":"completed"}`
under `migration.v1-v2` in the `kv` table. Anyone who kept using a bundled
OpenCode 1.x beside a v2 install created V1 sessions after that point, and
OpenCode never looks at them again — they are simply missing from the session
list. `topUpV1Migration()` hands OpenCode a resume cursor so its own migration
picks them up. OpenChamber never writes session rows itself.

It runs from `lifecycle.js` immediately before the MANAGED OpenCode is spawned:
never for an external, user-started OpenCode, and never while a managed one is
running, because the write would race OpenCode's own loop. Failure is never
fatal to startup. It opens `<data>/opencode.db` (or `OPENCODE_DB`) read-write
through `node:sqlite` on Node or `bun:sqlite` on Bun, and skips silently on
neither. It returns
`{ status: 'skipped' | 'scheduled' | 'unsafe' | 'unavailable', missing, revisited, reason? }`
and logs one line; there is no HTTP route and no UI.

What it does: when the migration row says `completed` and some `session` rows
have no `session_v2` twin AND were changed by 1.x after the last completed
import (`session.time_updated` past the row's `time_updated`, which OpenCode
stamps on completion), it sets the row to `{"phase":"sessions","cursor":…}`.
The time test matters because a v2 delete leaves the legacy row behind
(`Session.remove` publishes `session.deleted`, `bus.remove` then wipes that
session's durable events, `session_v2` cascades), and only OpenCode 1.x writes
the legacy table: when nobody ran 1.x since the last import, nothing qualifies
and the top-up skips, so sessions deleted in v2 stay deleted.
The cursor is the largest missing id plus `U+FFFF`, because OpenCode's loop
walks `id < cursor` in descending id order and ids are fixed width, so nothing
real can fall between an id and that cursor. Ids are compared the way SQLite
does (BINARY/memcmp; neither id column declares a collation). Session ids
encode time descending in a field that wraps, so id order is **not** time
order — an August session can sort far below a newer one, and the code never
assumes otherwise.

Hard rules, verified against v2.0.8 (the completion stamp against v2.0.16)
`packages/core/src/database/v1-migration.bun.ts`:

- **Never clear or delete the `migration.v1-v2` row.** With no row at all
  OpenCode treats the database as pre-migration and DELETEs the whole `event`
  table, v2's durable event log.
- **Never make OpenCode revisit a session that has v2 activity.** Every session
  the loop visits gets its `session_message` rows deleted and replaced by the
  V1 transform. Before writing a cursor, the top-up lists the already-migrated
  sessions below it and looks for a message created after the migration
  completed, a `session_v2.time_updated` after it, or a message `type` the V1
  transform never emits (it only produces `user`, `assistant`, `synthetic`,
  `compaction`). Any hit and nothing is written: the outcome is `unsafe`
  (`revisited-sessions-have-v2-activity`) and a single warning names how many
  sessions stay missing.
- **Only 1.x activity triggers an import** (maintainer, 2026-09-24). When 1.x
  was used again, OpenCode's loop still walks every legacy row under the
  cursor, so a deleted session sorting below a fresh one comes back with it;
  avoiding that needs an upstream import route that takes explicit ids.

## Public exports (providers.js)
- `getProviderSources(providerId, workingDirectory)`: Resolves which OpenCode config layers define a provider.
- `listProviderConfigs(workingDirectory)`: Every provider a config layer defines, projected into the canonical v2 `ProviderEntity` shape, with `legacy` marking entries still stored under the v1 `provider` key.
- `upsertProviderConfig(providerId, config, workingDirectory, scope?, options?)`: Validates and writes a custom provider block into the user/project/custom config layer. The payload may use the v2 spelling (`package`, `settings.baseURL`, `headers`) or the v1 spelling (`npm`, `options.baseURL`); what lands on disk is always a v2 `providers` entry with `package: "aisdk:<npm>"` and `settings.baseURL`. The adapter may be OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Existing provider, option, and retained-model fields not managed by the form are preserved; omitted models, headers, and env credentials remain explicit removals. A model's `variants` (reasoning levels) are replaced when the payload carries the array, cleared when it carries an empty one, and kept when the key is absent. Updating an entry still stored under the legacy `provider` key rewrites it under `providers` in the same file, dropping the fields v2 accepts but ignores; unrelated legacy siblings are untouched. Does not store API keys. Requires `config.env` or `options.hasStoredAuth`. OpenCode 2 keeps credentials in its own store, so `PUT /api/provider` sets `hasStoredAuth` from the request's `hasCredential` (the form is about to store a key, or the edited provider keeps its credential) as well as a credential OpenCode already stores for the provider. The key itself goes through `integration.connect.key` after this write, because OpenCode registers a custom provider's key method only once the provider is in config. Edit flows must pass the provider's effective existing layer (`custom` > `project` > `user`) so updates do not create a global user override.
- `validateCustomProviderConfig(providerId, config, options?)`: Structural validation for custom provider payloads (id format, adapter allowlist `@ai-sdk/openai-compatible`/`@ai-sdk/openai`/`@ai-sdk/anthropic`, http(s) base URL, models, credentials via `env` or `hasStoredAuth`). Accepts both spellings and returns the normalized v2 value.
- `removeProviderConfig(providerId, workingDirectory, scope?)`: Removes a provider block from the selected config layer.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`: Path constants rooted at `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is non-empty, otherwise `~/.config/opencode`. These constants are evaluated when the module loads; no files are migrated. `OPENCODE_CONFIG` remains a separate explicit config-file path and is resolved at call time for the custom config layer; it does not replace the global config directory.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `parseMdFileAsync(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter. A rewrite goes through `writeFileAtomic`; `flag: 'wx'` creates the file directly and passes EEXIST on.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom). `readConfigLayers` isolates `INVALID_JSONC` per layer: a broken file is omitted from the merge (`{}` for that layer only), recorded on `layerErrors`, and does not block valid sibling layers. Writes still refuse to overwrite the broken file.
- `readConfigFile(filePath)`: Reads one config file. Missing, whitespace-only, and comment-only files return `{}`; a comment-only file is recognized by `ValueExpected` being the only parse error. A `jsonc-parser` error that produces a partial or non-object tree throws `INVALID_JSONC` — partial parse trees must never be treated as authoritative (avoids rewriting a `$schema`-only stub over a full config). Content that yields no JSON value for any other reason (YAML, plain text) also throws instead of reading as empty.
- `readConfigLayer(filePath)`: Same parse as `readConfigFile`, but isolates `INVALID_JSONC` to `{ config: {}, error }` so plugin/MCP/agent readers can skip one broken layer without aborting valid siblings. Writes still refuse to overwrite the broken file.
- `writeConfig(config, filePath)`: Writes config with automatic backup, replacing the file atomically through `writeFileAtomic` so a watcher or a crash never sees a partial config. Refuses to overwrite an existing non-empty file that fails the same JSONC parse check. Existing files are edited structurally instead of being re-serialized whole, so comments, formatting, and line endings outside the changed values survive; changed arrays are replaced whole, comment-only files keep their comments with the serialized config appended below, and the edited text must re-parse to exactly the intended config or the write falls back to a normalized rewrite (never an invalid file).
- `getJsonEntrySource(layers, sectionKind, entryName)`: Resolves which config layer provides an entry. `sectionKind` is `agents`, `commands`, `providers`, or `mcp`, and both the v2 and the v1 spelling are searched (v2 wins). The result carries `sectionKey` (the spelling that actually held the entry) and `legacy`, so a writer can rewrite the same file in v2 shape. A failed custom or user layer throws `INVALID_JSONC` instead of treating that file as empty. A failed project layer is skipped so a valid user/custom entry can still be found.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates. Throws `INVALID_JSONC` when the chosen target file is the unparseable layer.
- `getFolderConfigPaths(workingDirectory)`: Every `opencode.json(c)` and `.opencode/opencode.json(c)` OpenCode 2 finds walking up from the project folder to the filesystem root, lowest priority first in OpenCode's order (`core/src/config/discovery.ts`): plain files outermost folder first, `.jsonc` after `.json`, then the `.opencode/` files the same way. Global config files are left out. Internal to `shared.js`; callers use `readConfigSources`.
- `readConfigSources(workingDirectory)`: Every config file OpenCode 2 reads with its parsed content, lowest priority first: the global files, `OPENCODE_CONFIG`, then the `getFolderConfigPaths` files. Each entry is `{ path, config, error, required }`; `required` marks the global and `OPENCODE_CONFIG` files, and a broken file reads as `{}` with its `error`. Used by MCP reads and by the model pool text Jev reads (`../routing/model-routes.js` `readLayeredModelRoutes`); agents, commands and providers still read the single project file.
- `getProjectConfigCandidates(workingDirectory)`: The project folder's own config files. `getLayerError(layers, filePath)`, internal to `shared.js`, finds the parse error `readConfigLayers` recorded for one file.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.
- `walkSkillMdFiles(rootDir)`: Async. Recursively finds all SKILL.md files at any depth, following links and skipping a link back to its own ancestor. Directories are visited one at a time in depth-first readdir order, so the result order is deterministic: discovery lets a later file win a duplicate name, so the order is part of the contract, and the directory cap is allocated to the same directories on every scan of an unchanged tree. One walk visits at most `SKILL_WALK_MAX_DIRS` (5000) directories per root, the root included; past the cap it opens no new directories and returns the paths found so far, so a link to a large external tree cannot expand a scan past the cap. The VS Code twin in `opencodeConfig.ts` uses the same cap.
- `addSkillFromMdFile(skillsMap, skillMdPath, parsed, scope, source)`: Indexes an already parsed skill file; `parsed` null (unreadable file) adds nothing.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)` (async), `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management. `listSkillSupportingFiles` resolves to `{ files, truncated }`: the walk visits at most `SKILL_SUPPORTING_FILES_MAX_DIRECTORIES` (5000) directories, the skill root included, and returns at most `SKILL_SUPPORTING_FILES_MAX_FILES` (5000) files; past either cap it stops walking, keeps the files found so far in traversal order, and sets `truncated`, which `getSkillSources` exposes as `sources.md.supportingFilesTruncated` so the UI never presents a partial list as complete. The VS Code twin `listSupportingFiles` in `opencodeConfig.ts` uses the same caps and shape. `readSkillSupportingFile` accepts regular files up to `SKILL_SUPPORTING_FILE_MAX_BYTES` (1 MiB), checks the opened file descriptor, and reads at most one byte over the cap. An oversized file throws code `skill_supporting_file_too_large` and the skill-files GET route maps it to 413 `File too large to read`; a missing file still returns null (404).

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`
  - `POST /api/opencode/upgrade` (enforces the active runtime's upgrade capability, shares concurrent upgrade requests and runs the resolved CLI with `upgrade`; the existing Reload action restarts managed OpenCode afterwards)
  - `GET /api/opencode/upgrade-status` (returns version availability plus the authoritative `upgrade.supported`, `upgrade.manager`, and `upgrade.reason` capability)
  - `GET /api/provider/:providerId/source`
  - `PUT /api/provider` (create/update custom OpenAI-compatible provider config in OpenCode user/project/custom layers via `scope`; secrets stay in auth via the OpenCode auth API)
  - `POST /api/provider/discover-models` (user-initiated custom-provider model discovery; fetches the configured `/models` path server-side and optionally enriches exact model matches from the shared models.dev cache)
  - `DELETE /api/provider/:providerId/auth`
  - Enterprise mode (`../enterprise-mode.js`): `PUT /api/provider` and the OpenCode writes that would otherwise pass the generic proxy — every `POST` under `/api/integration/:id/connect` (key, OAuth start and complete, command), `POST /api/credential` (stores a key, OpenCode 2.0.20) and `POST /api/experimental/integration/wellknown`, matched by `isProviderConnectRequest` — answer 403 `enterprise_mode`. The matcher mirrors how OpenCode 2.0.18 to 2.0.20 route a path (any letter case, doubled slashes, `\` for `/`, percent escapes, anything after `;`), refuses a dot segment or a bad escape, and needs rechecking when OpenCode changes its router. Signing in to a remote MCP server (`POST /api/integration/mcp_<16 hex>/connect/oauth` and its `/:attempt/complete`) passes: it reaches a tool server from the OpenCode config, not a model provider. The VS Code extension host refuses the same requests with the same matcher. Removing, activating or renaming an existing credential still reaches OpenCode. This closes the way in through the app; OpenCode's `provider.use` policy is the real lock.
- Owns lazy auth library loading for provider auth checks/removal.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.

## CLI upgrades

`cli-upgrade.js` runs the host-resolved executable and wrapper arguments with
`upgrade`, without a shell or client-supplied arguments. OpenCode chooses the
installer. Web, hosted mobile, Capacitor, and Desktop with a separately installed
CLI use this server path. VS Code uses the same executor from its extension host.
Bundled Desktop, external URL connections, and unavailable CLIs remain
unsupported at the host boundary.

An upgrade leaves the current server running. The toast's Reload action restarts
it using the installed version. Failed installations return an error and can be
retried; installer output is not returned or logged because it can contain registry
credentials. Requests from multiple clients share the in-flight operation. The
executor supplies EOF and bounds captured output; installation has no fixed time
limit, and the VS Code bridge does not apply its usual 30-second request timeout.

### Migrating an installed v1 CLI

`GET /api/opencode/compatibility` reads the local CLI version without starting
its server, or probes an external server's JSON version contract (`/api/info`,
then v1's `/global/health` even when the first probe fails or hangs). When
`OPENCODE_HOST`/`OPENCODE_PORT` points at a server that identifies as v1 or a
2.x below the minimum, startup attaches to it as external and not ready rather
than spawning a managed instance, so this check reports its version. A confirmed
managed v1 CLI on macOS, Linux or Windows (x64/arm64) advertises `canInstall`;
bundled binaries and external connections do not.

`POST /api/opencode/install-v2` rechecks that capability and shares one operation
across concurrent clients. `v2-install.js` resolves a validated stable v2
release from npm. On macOS/Linux it downloads the official
`https://opencode.ai/v2/install` script and runs it with that release and
`--no-modify-path`. That script is bash, so on Windows it downloads the npm
platform package the script would fetch (`@opencode/cli-windows-arm64` on
arm64, `@opencode/cli-windows-x64-baseline` on x64, like the desktop bundle), checks it against the `sha512` integrity
npm publishes, and unpacks `opencode.exe` with the system `tar.exe`. Both
paths then verify the resulting executable.
It installs into the host user's standard `~/.opencode/bin`. Existing npm/Bun
packages remain installed; the host selects the new binary through
`opencodeBinary`, restarts OpenCode, and waits for v2 readiness before replying.

A filesystem lock prevents separate hosts sharing a home from installing at
the same time. The installer has a five-minute deadline and owns its subprocess
group. Existing executable/shim files are restored after an installation or
verification failure. If rollback fails, backups and the lock remain under
`.opencode/bin/.openchamber-install` for manual recovery. A successful install
followed by a settings/restart failure keeps v2 on disk; Check again can retry
the restart. A host crash may also leave the lock for manual recovery.
Installer output is discarded, not forwarded to clients or logs.

## Public exports (response-envelope.js)
- `unwrapOpenCodeResponse(body)`: strips OpenCode 2.x's response envelope. A single record (`GET /api/session/:id`, one message) arrives as `{ data }`, some routes as `{ location, data }`, pages as `{ data, cursor }`. Records and plain lists are unwrapped; pages keep the envelope for their cursor. Every server-side OpenCode read goes through it: unwrapping only on `location` left record envelopes in place, so `parentID` and message ids read as missing.

## Public exports (prompt-response.js)

`prompt-response.js` rejects a successful HTML app-shell response at server-owned dispatch boundaries. Raw prompt, context-restoration, and queue sends call `assertPromptResponse`; the session-route and scheduled-task SDK factories call `assertOpenCodeApiResponse` before the SDK decodes the body. The SDK still owns declared error statuses and their bodies. A rejected dispatch must not remove a queued item.

## Public exports (session-activity.js)
- `hasWorkingDescendants(id, statuses)` is the queue delivery check returned by the probe. It follows the running sessions' parent links through every ancestor, with no depth cap. OpenCode's `experimental.subagent_depth` has no upper bound, and the UI ancestor walk counts chains of any length the same way. Reads share one timeout and each session record is read once per check. Failed or malformed records and cycles return `null` unless another chain proves a running descendant. Parent links are refreshed on the next check. The direct-child check used by other consumers keeps its existing behavior.
- `createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs })`: whether a session's turn really ended. A parent goes idle while a background subagent works and runs again when OpenCode hands the result back. `fetchActiveSessionStatuses()` reads `/api/session/active`, `fetchChildSessionIds(id)` pages `GET /api/session?parentID=`, `hasWorkingChildren(id, statuses)` combines them. Every read answers `null` when OpenCode could not be asked. Used by the goal loop (waits) and the notification runtime (stays silent on the pause).

## Public exports (session-runtime.js)
- `createSessionRuntime({ writeSseEvent, getNotificationClients, broadcastEvent? })`: creates runtime-owned state machine and APIs for session status.
- Returned API:
  - `processOpenCodeSsePayload(payload)`
  - `getSessionActivitySnapshot()`
  - `getActiveSessionCount()`
  - `getSessionStateSnapshot()`
  - `getSessionAttentionSnapshot()`
  - `getSessionState(sessionId)`
  - `getSessionAttentionState(sessionId)`
  - `markSessionViewed(sessionId, clientId)`
  - `markSessionUnviewed(sessionId, clientId)`
  - `markUserMessageSent(sessionId)`
  - `resetAllSessionActivityToIdle()`
  - `interruptBusySessionsAfterRestart()`: settles every session whose authoritative status is `busy`/`retry` or whose activity phase is still busy, broadcasts `openchamber:session-status` idle plus an OpenCode-shaped `session.error`, resets leftover activity/cooldowns, and returns the interrupted session IDs in stable order.
  - `dispose()`

The runtime maintains active-session count incrementally from idempotent activity phase transitions. Upstream stall-timeout and lifecycle health checks read it in O(1); the hourly cleanup removes activity phases older than 24 hours without broadcasting synthetic state transitions. Snapshot generation remains reserved for the session-activity API.

### Why the session-activity snapshot is a versioned envelope and not the bare phase map

`getSessionActivitySnapshot()` returns the external observability contract v1 (design #612, phase 1 - #524): `{ version: 1, serverTime, watcherReady, sessions }`, where each session entry keeps the frozen `{ type }` phase and adds `lastActivityAt` (the phase map's recorded `updatedAt`), `status` (session-state map), `model` (the observed `{ modelID, providerID }` pair remembered by the notifications runtime from the session's latest assistant message, or null), `toolInFlight` (null — the settled contract: no in-process source tracks it, and it stays null until the upstream event model changes; follow-up #1441, decided 2026-11-13/16), and `queue` (the session's queue binding `{ taskId, issueNumber, queue, lane }` from the binding source the launch side registered with the runtime, or null when no binding is known for the session). Unknowns are explicit nulls, never fabricated values, and `watcherReady` is owned by both signals together (follow-up #1441, decided 2026-11-13/16): it stays false until the watcher stream is connected AND has delivered its first payload in the process, and drops back to false when the stream disconnects, so an empty read is distinguishable from a watcher that has not started or has dropped. The bare `{ [sessionId]: { type } }` map was rejected for the envelope because external consumers cannot version, timestamp, or readiness-mark a bare map without colliding with session IDs.

### Why the queue binding comes from a registered source and not a ledger read

The binding of a session to its queue task lives in the repo-queue task ledger, which this server does not own and has no client for, and the snapshot builder is synchronous and in-process. So the runtime takes the binding from a getter the launch side registers (`getSessionQueueBinding`, wired in `index.js` through a ref, the same pattern as the model/provider read), and the projection normalizes whatever it returns through the four-key allowlist. The rejected alternative — the server querying the ledger itself — would couple every OpenChamber surface (desktop, VS Code, mobile hosts) to the fleet's queue database for one observability field. Until a source registers, entries report `queue: null`: no known binding is an explicit unknown under rule 2, never an inference from the process table.

## External observability contract v1 (design #612)

Two read-only endpoints expose this OpenChamber instance's state to external consumers — the babysitter poller is the first, and any paired client can build on the same shapes. Both responses are versioned envelopes built from explicit allowlist projections, and a conformance fixture (`observability-contract.test.js`, beside the server tests in this directory) pins the shapes described here: it runs the same builders the routes serve and asserts the key sets, the empty-but-ready state, secret-field absence, an identity-unverified recorded pid never being listed, and a stopped server leaving the registry read. A paired client running against a live server applies the same assertions to the HTTP JSON.

### The five contract rules

1. **Additive-only, versioned.** Every response carries a top-level `version` (currently `1`) and `serverTime`. A future breaking change ships as a new version; within v1, fields are only added, never renamed or removed, and consumers must ignore keys they do not know.
2. **Explicit unknowns.** A value the server cannot verify is `null`, never a fabricated default — no invented `0`, empty string, or guessed status stands in for an unknown. Consumers must treat `null` as "unknown", not as "none".
3. **Empty is not unknown.** An empty collection with its readiness marker set is a real answer ("nothing to report"); a not-ready read says so instead of looking empty. The markers are `watcherReady` for session activity and `status: "unknown"` per registry entry (below).
4. **Allowlist projection, no auth material.** Responses are built by projecting source records onto a fixed key set, never by serializing the records. The managed state file and registry entries hold a managed password, an agent-tool token, a launch fingerprint, launch args, a binary path, and an owner pid; none of those keys — nor any password/token/secret/fingerprint/credential-shaped key — ever appears in either response, at any nesting depth.
5. **Authoritative sources only.** Every field comes from the record that owns it: session phases and their timestamps from the watcher-fed activity map, session status from the session-state map, the model pair from the notifications runtime's observation of the session's latest assistant message, registry facts from the managed-process registry, queue bindings from the binding source the launch side registered with the session runtime (the task ledger row bound to that session id), and the hosting instance's own entry from lifecycle state. Nothing is inferred from the process table or from another field.

### `GET /api/session-activity`

The envelope:

| Key | Type | Meaning |
| --- | --- | --- |
| `version` | number | Contract version, always `1`. |
| `serverTime` | number | The server's clock when the snapshot was built, epoch milliseconds. |
| `watcherReady` | boolean | `false` until the OpenCode watcher stream is connected AND has delivered its first payload in this process; `false` again once the stream disconnects. An empty `sessions` map with `watcherReady: false` means "the watcher is not live", not "no sessions exist"; with `watcherReady: true` it means no session has reported activity. |
| `sessions` | object | Map of session ID to activity entry (below). Entries are pruned after 24 hours without a phase change. |

Each entry in `sessions` has exactly these six keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `type` | string | The session's current activity phase (for example `busy` or `idle`), frozen from the phase-1 contract. |
| `lastActivityAt` | number | When the phase last changed, epoch milliseconds. |
| `status` | string \| null | The session-state map's status for this session, or `null` when no state has been recorded for it. |
| `model` | object \| null | The **observed** model pair `{ modelID, providerID }` (each a string or `null` when unreported) from the session's latest assistant message — observed, not the configured model — or `null` when no assistant message has been observed for the session. There is no separate `provider` key. |
| `toolInFlight` | null | Pinned `null` in v1, and settled as the long-term contract (follow-up #1441, decided 2026-11-13/16): no in-process source tracks a per-session in-flight tool, rule 2 forbids fabricating one, and real tracking stays out of scope until the upstream event model changes. The key exists so that future source can fill it without a version break. |
| `queue` | object \| null | The session's queue binding, or `null` when no binding is known for the session (interactive/dispatcher sessions, or no source registered in this process). When bound, exactly `{ taskId, issueNumber, queue, lane }`: the repo-queue task id and issue number (numbers, or `null` when the source cannot verify them), the queue name and the lane id (strings, or `null` likewise). The source is the binding the launch side registered with the session runtime — the task ledger row bound to that session id at launch (code#1656 step 3) — projected through this allowlist, never inferred from the process table (rule 5) and never carrying auth material (rule 4). |

This read is a pollable snapshot, not a stream guarantee: phases are the latest recorded state at `serverTime`, and a phase that starts and ends between two polls may never appear.

### `GET /api/managed-servers`

The envelope is `{ version: 1, serverTime, servers }`, with the same `version` and `serverTime` (epoch milliseconds) meanings as above. `servers` is an array sorted by `pid` ascending. Each entry has exactly these seven keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `pid` | number | The recorded pid of a managed OpenCode server. |
| `port` | number \| null | The port the server was recorded on, or `null` when no valid port was recorded. |
| `directory` | string \| null | The hosting instance's validated default directory. Only the hosting instance's own entry carries it; other instances' entries are `null`. |
| `version` | string \| null | That server's reported OpenCode version (from its health payload), or `null` when unverifiable. This is **not** the contract version: the envelope's top-level `version` is the contract's, this per-entry `version` is the server's. |
| `status` | string | `ready` (the hosting instance's own server, healthy), `starting` (its own server, not yet ready), `draining` (a replaced server still finishing its sessions), or `unknown` (another instance's server: listed because its identity verified, but its details are not visible to this instance). |
| `startedAt` | string \| null | When the server started (ISO 8601, from its registry record), or `null` when unrecorded. |
| `sessionCount` | number \| null | Live session count for the hosting instance's own server, or `null` for other instances' servers (and for an own server that has not reported one). |

Discovery comes from the managed-process registry alone; no process table is scanned for servers nobody recorded. The hosting instance completes its own entry from lifecycle state (directory, version, readiness, session count). Every other instance's entry reports only registry facts — `pid`, `port`, `startedAt` — with the remaining fields `null` under `status: "unknown"`.

Liveness as landed: a recorded entry appears only while two checks pass for its recorded pid at read time — a signal-0 probe (`process.kill(pid, 0)`, with `EPERM` counting as alive) succeeds, and the pid's identity is verified: the live command at that pid must be an `opencode serve` for the recorded port, the same identity check the orphan reaper uses, wired into this read by lifecycle (#638). Signal-0 alone proves only that *some* process lives at the recorded pid, and the OS can recycle a dead server's pid onto an unrelated process, so where identity cannot be verified — including a platform with no command read — a recorded entry is not listed at all. A stopped server is therefore absent from the very next poll rather than lingering as a zombie, and so is a live but unrelated process that inherited its pid. The hosting instance's own entry is the one exemption: it comes from live lifecycle state for a process this instance is running, not from a record, so it does not go through the recorded-pid check.

### Building a poller from this contract

- Poll both endpoints, require `version: 1`, and key timing decisions on `serverTime`, not the local clock.
- Treat `watcherReady: false` as "activity unknown yet" and keep polling; treat an empty `sessions` map with `watcherReady: true` as "no active sessions".
- A managed server disappearing between polls means it stopped, its pid died, or the pid's identity could no longer be verified as the recorded server (for example, the pid was recycled onto another process). A server sitting at `status: "unknown"` is another instance's identity-verified server whose details this instance cannot see — it is not evidence the server is down.
- Read every `null` as "unknown" per rule 2; in particular a `null` entry `version` or `sessionCount` is not a zero value.


## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: creates lifecycle runtime for managed/external OpenCode process orchestration. The optional `onOpenCodeRestarted` dependency (default `null`) is fired after a successful managed restart. `index.js` rebinds event-stream readers to the possibly-new port (#2638), then calls `interruptBusySessionsAfterRestart()` and broadcasts one `opencode-restart-interrupted` UI notification when interrupted turns exist (#2943).
- Returned API:
  - `startOpenCode()`
  - `restartOpenCode()`
  - `waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `waitForAgentPresence(agentName, timeoutMs?, intervalMs?)`
  - `refreshOpenCodeAfterConfigChange(reason, options?)`
  - `bootstrapOpenCodeAtStartup()`
  - `startHealthMonitoring(healthCheckIntervalMs)`
  - `waitForPortRelease(port, timeoutMs, hostname?)`
  - `reloadOpenCode()`: resolves `false` unless a managed OpenCode is running and its saved launch fingerprint differs from the current one. Then it restarts OpenCode, or returns `false` and logs a deferral while sessions are busy; a later reload re-evaluates.

## Managed OpenCode across OpenChamber restarts
- The managed OpenCode child is spawned detached with stdout and stderr appended to `<dataDir>/managed-opencode/opencode.log` (a file, not a pipe, so it cannot hit EPIPE once OpenChamber exits). Readiness and the stderr tail are read from that file. The log is bounded: at spawn, before the new child's fd opens, a log over 5 MiB is renamed to `opencode.log.1` (one retained generation, replaced each rotation), so the spawn's read offset starts from the fresh file. Rotation is best-effort — a still-running adopted OpenCode holding the old fd keeps writing to the renamed file on POSIX, and on Windows the rename of an open file fails and rotation retries at the next spawn.
- `<dataDir>/managed-opencode/state.json` (0600, written tmp+rename) records `{version, pid, port, binary, fingerprint, password, agentToolToken, startedAt}`. The password and agent-tool token are reused on each start so an adopted OpenCode keeps authenticating. The file holds secrets; it is never logged.
- `state.json` also records `args` (the launch arguments without the port). A state file without `args` from before this field was added is read as matching, so it is adopted rather than replaced.
- The state and draining readers use the shared handle-bounded synchronous reader, with a 64 KiB cap for each file. Missing, malformed, non-regular, unreadable, and oversized files keep the readers' existing `null` or empty-list answers; the cap covers the small records, long paths, and credential fields without allowing unbounded reads on lifecycle supervision paths.
- `fingerprint` is a SHA-256 of the canonical launch config: binary, args, cwd, hostname, port, a hash of the password, and the managed and user environments with secret keys removed. A user-environment change therefore forces a handoff at the next start.
- On startup `decideManagedOpenCodeLaunch` runs: no state → start; recorded pid not verified as OpenCode (via `ps`) → start without signalling; health check failed → kill the recorded process, wait for the port, start; binary, args, port or fingerprint changed → handoff (below); all match → adopt (no spawn). Ownership is checked against the process command before any signal is sent, since pids are reused. Windows cannot verify ownership, so it never adopts and never kills by pid.
- `state.json` and `draining.json` live in the data dir, so two OpenChamber servers on one data dir (the desktop app next to `openchamber serve`) read each other's records. Before any decision the recorded pid's owner is read from the managed-process registry (`readManagedProcessOwner`): an OpenCode owned by another live server, one that is neither this process nor the predecessor handing off to it, is treated as no state (logged as `managed state names OpenCode … of another OpenChamber server`) and is never adopted, handed off from, drained or stopped; draining records owned by another live server are skipped the same way. Without this each server took the other's OpenCode for its own predecessor (`handoff (binary-changed)`) and retired it, interrupting every session of the other server in turn. Adopting re-registers the OpenCode under this server's pid, so a second server never sees the old, gone owner and claims it.
- With two servers on one data dir, more follows from that shared file: an OpenCode whose owner the registry does not record (the registry write is best effort) is not treated as this server's either, since leaving a process running costs less than stopping another server's sessions; each server keeps the record it last wrote in memory and uses it for its own reload and restart when the file names someone else's; the readiness scan of the shared `opencode.log` accepts only a `listening on` URL on the port its child was given; and when another live server's OpenCode holds a pinned port (`OPENCODE_PORT`), the start fails with that explanation instead of a bind error.
- An OpenCode whose registered owner is gone is claimed before it is adopted or drained (`claimManagedProcess`): the claim file, `<pid>.claim-from-<owner>` in the registry, is created exclusively, so of two servers finding the same orphan at once only one takes it. A server writing `draining.json` keeps the records another live server still owns, and a server that inherits draining children (a handoff successor) or adopts an OpenCode registers them under its own pid.
- Port-holder cleanup is gone: a stray process that holds the port but is not the recorded child makes the spawn fail with EADDRINUSE rather than being killed.
- Orphan reaping keeps the adopted pid (`reapOrphanedProcesses({ keepPids })`).
- `SIGHUP` reloads (`controller.reload()` / `reloadOpenCodeConfiguration`): it re-reads the OpenCode binary setting and restarts OpenCode only when the binary or the argument list changed, and then through a handoff. Other launch settings (environment, password, working directory) are read at the next start and do not interrupt running sessions. The process never exits on SIGHUP.

### Handoff and drain
- A binary or argument change starts the new OpenCode on its own port (a fresh one when the current port is in use), waits for its health, then switches new requests to it. If the new process fails to become healthy it is closed, `state.json` is restored to the running predecessor, and the predecessor keeps serving.
- The replaced process is recorded in `<dataDir>/managed-opencode/draining.json` (version 1, 0600, removed when empty) and stays up. It serves requests already in flight to its port and the event streams of sessions that were busy when it was replaced. OpenChamber follows its `/api/event` stream and injects it into the global event hub until that stream closes.
- A draining process is closed when none of the sessions that were busy at the handoff is still busy and no proxied request still uses its port, or when the grace period ends. A handoff at startup has an unknown busy set, so it waits for the grace period.
- `OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS` sets the longest a replaced process may stay up. The default is 30 minutes (1800000). `0` closes it at the next one-second check. An invalid value falls back to the default.
- POSIX launches run through `/bin/sh -c 'exec 3>&-; exec "$0" "$@"'`, so the OpenCode child does not inherit fd 3 when OpenChamber was socket-activated. Other children OpenChamber starts (terminals, git) may still inherit fd 3; this is not verified.

## Shutdown and socket activation
- `SIGTERM` (the supervisor's stop and the daemon's stop) drains HTTP, then exits, and leaves the managed OpenCode and `draining.json` running for the next start to adopt (`gracefulShutdown({ keepOpenCode: true })`).
- `openchamber stop` sends `SIGINT`, a full stop: it closes the current OpenCode and every draining one and clears `state.json`, so no OpenCode is left running without state. `SIGQUIT`, `SIGUSR2`, the embedded `stop()` default and the uncaught-exception path also stop OpenCode. `openchamber update` still sends `SIGTERM`, so it keeps OpenCode for adoption.
- `openchamber rotate-credentials` is the explicit credential rotation: it stops through the same SIGINT path, then starts with `OPENCHAMBER_ROTATE_MANAGED_CREDENTIALS=true`. The server reads that flag once at boot and deletes it from its environment, and the lifecycle's first start then passes no reuse values, so the saved password and agent tool token are discarded, fresh ones are generated, and the new pair is written to `state.json`. A state file that survived the stop cannot be adopted with the old pair: the fresh password changes the launch fingerprint, so a still-running recorded OpenCode is handed off from. Later starts in the same process, and every normal start, reuse the saved pair as usual. A user-provided `OPENCODE_SERVER_PASSWORD` still wins over rotation; rotation never overrides it, and credential values are never printed or logged.
- Caveat: `openchamber stop` escalates to SIGKILL after 2.5 s. If OpenChamber is killed, the detached OpenCode keeps running with `state.json` still present, so the next start adopts or replaces it. It is recoverable, not an orphan without state.
- Drain: the listener stops accepting connections. Idle keep-alive sockets and WebSocket upgrades are destroyed within about 100 ms, since they are not in-flight requests (a handoff leaves idle keep-alive sockets for one second first, see above). HTTP requests still in flight are waited on up to the existing shutdown grace (`SHUTDOWN_TIMEOUT`); a long-lived SSE response counts as in flight. After the grace the server logs `Server close timeout reached, forcing shutdown` and destroys the remaining sockets. Cut after grace: any HTTP response or SSE stream still open is severed, and the client must reconnect. WebSocket clients (terminal, message stream) are cut at drain start, not after grace. Runtime cleanup (terminals, watchers, guest services) still runs as before.
- When `LISTEN_FDS` and `LISTEN_PID` name this process, the server listens on inherited fd 3 instead of binding, so a socket-activated unit can hold the port across restarts. `serveCommand` (`bin/lib/commands-serve.js`) skips its port probes in that case: the held port is busy by design, and probing it refused the start before the listener was used.
- The NixOS unit (`home/common/default.nix`) holds the listener with `openchamber.socket` (`127.0.0.1:3000`) and runs `serve --foreground` with `KillMode=process`. A plain `systemctl restart` still stops the old service before it starts the new one: requests in between wait in the kernel's accept backlog (`listener-handoff.test.js` checks this with a holder that never accepts). `openchamber handoff` avoids that gap.
- Self-handoff (`self-handoff.js`): `openchamber handoff`, or `SIGURG` sent to the process, starts a successor on the same listening socket. The successor is the same CLI in foreground mode; the socket is passed as fd 3 with `LISTEN_FDS=1` and `LISTEN_PID` set to the successor's own pid, the convention socket activation uses. The successor adopts the managed OpenCode child from `state.json` (same pid and port; OpenCode is restarted only when its binary or arguments changed, as for any start). It reports ready on IPC (`openchamber:handoff-ready`) only once its listener is open in its own process and OpenCode is ready. Then the predecessor closes its listener (the socket stays open for the successor), answers the requests on its open connections with `Connection: close`, closes idle keep-alive sockets after a one-second grace, drains in-flight requests, and exits without stopping OpenCode.
- The predecessor's listener is not closed until the successor is ready. Under systemd the successor first sends `READY=1` and `MAINPID=<successor>` to `$NOTIFY_SOCKET` through `systemd-notify`, and the predecessor waits 500 ms before it stops. If the successor is not ready within `OPENCHAMBER_HANDOFF_TIMEOUT_MS` (default 30000) or exits first, the predecessor kills it and keeps serving; `openchamber handoff` reports `not-handed-off` and the pid file is unchanged. `OPENCHAMBER_SELF_HANDOFF=0` turns off the signal handler and the command; `SIGUSR2` keeps its daemon meaning (a full stop), so the handoff signal is `SIGURG`, which the kernel ignores by default.
- Unit requirements for a systemd user service: `NotifyAccess=all` (the successor notifies while it is not the main pid) and `KillMode=process` (already set). The handoff is verified with a fake notify socket (`self-handoff-process.test.js`), not with a live user session; confirm `systemctl --user show -p MainPID openchamber` after a handoff before relying on it.
- Scope: POSIX only. The successor runs under Node, so a foreground server must run under Node: the daemon runs under Bun whenever Bun is installed, and Bun does not expose the listening socket's descriptor, so that handoff is refused and logged. A handoff runs the entry the process was started from, so it does not pick up a newer install; an upgrade still needs a restart.
- Known gaps: children other than OpenCode may inherit fd 3 in the successor; if a successor changes the OpenCode launch (binary or arguments) and then fails, `state.json` may name its OpenCode; `openchamber restart` still stops OpenCode with SIGINT. Scheduled tasks claim each occurrence in shared config, so the overlap window does not double-run them (read, not tested).
- Without socket activation, the listener is released on every restart and clients see a short outage.
- Known gaps: the v2 versioned store (`store.json`, `managed-opencode-state.js`: generations, write-ahead handoff record, v1 migration, store-only reaper) is wired into `lifecycle.js` as a dual-write with the v1 `state.json` + `draining.json` pair, kept for one release: the store is the ownership record for action paths, and retiring the v1 pair is the remaining step: retirement first has to move the readers still on the pair (`isOwnedOpenCodePid` v1 ownership/draining checks, startup adoption from the saved `state.json` record, orphan and drain recovery reading `draining.json`), not just delete the files; upgrade handoff (a newer install taking over) is not done (see `TODO.md`).

Managed OpenCode launch also merges the environment returned by the agent-tool
runtime and the opt-in system prompt optimizer, each appending its `file://`
entry to the previous one's config. OpenChamber adds no automatic MCP reconnect
loop; recovery after a failed connection is manual for both local and remote
servers. Previously generated reconnect plugin files are inert because managed
launch no longer registers them. User-configured plugins remain user-owned.
PATH, `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` remain lifecycle-owned
and cannot be replaced by injected or inherited values; OpenCode 2 prefers
`OPENCODE_PASSWORD`, so both carry the managed password. A user-provided
password is read with the same precedence, and Basic auth always uses the
`opencode` username because OpenCode 2 accepts no other. External OpenCode processes receive no
OpenChamber tool injection. Managed launch env strips AppImage `ARGV0` before
spawn so zsh-backed OpenCode tools do not rewrite child argv[0] to the AppImage
path (#2588).

Everything the lifecycle and `auth-state-runtime.js` set for OpenCode goes
through `assignInjectedEnv` (`../injected-env.js`), which records the names of
the variables it changed in `OPENCHAMBER_INJECTED_ENV`. The agent's shell
inherits that record, so `openchamber startup enable` run there leaves the
managed config and password out of the service while the user's own
`OPENCODE_*` exports carry over (#4604). A value the environment already had is
not recorded: a user-provided password passed through stays the user's.

Before spawn, `applyProviderEnvAliases` fills unset Google credential aliases
from any present sibling (`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`,
`GEMINI_API_KEY`) so a shell that only exports `GEMINI_API_KEY` still satisfies
the Generative AI SDK path used at chat time. Existing non-empty values are
never overwritten.

Set `OPENCHAMBER_STARTUP_PERF=1` to emit bounded startup phase records for server listen, managed OpenCode preparation/readiness, and proxy readiness holds. Every OpenCode bootstrap emits one terminal `opencode.bootstrap.ready` or `opencode.bootstrap.error` event, including reused and external server paths. Records contain controlled phase/outcome/route labels and timing values only; they never contain request URLs, runtime keys, directories, session IDs, credentials, or content.

macOS `say` voice enumeration starts concurrently with server composition. The server listener and managed OpenCode startup do not wait for it; `/api/tts/say/status` awaits the same authoritative capability promise when queried before enumeration completes.

Upstream health is probed with `GET /api/info` (OpenCode 2.0.8 removed `/api/health`). A 200 is the whole readiness answer — the payload is `{ version, pid, urls, paths }` and carries no `healthy` field — and its `version` is what the major-version gate reads. OpenChamber's own `/api/opencode/health` keeps answering `{ healthy }` to its clients, derived from that status. With `?wait=<ms>` (capped at 8 s, `health-wait.js`) it holds an unhealthy answer and re-probes every 100 ms until OpenCode is ready, the wait ends, or the client disconnects, so a starting client learns of readiness within about 100 ms instead of on its next poll. Concurrent waiters share probes (`createSharedHealthProbe`): a probe started less than 100 ms ago answers them all, so several starting windows cost one probe per interval. An OpenCode that answers with an unsupported version is a final answer and returns at once. `GET /api/openchamber/models-metadata` sends the models.dev catalog projected to the provider ids and model fields the UI reads (`toClientModelsMetadata`); the small-model resolver and model discovery keep the full catalog.

Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

External OpenCode uses the same periodic monitor. A failed probe marks it not ready and records `lastOpenCodeHealthFailure`; a successful probe restores readiness and leaves the last failure available for diagnosis. Health checks never restart an external process.

Managed health failures are classified as `timeout`, `connection_refused`, `connection_reset`, `invalid_response`, or `error`. The lifecycle retains the latest counted failure with a bounded detail string and source. Managed process wrappers continue capturing a sanitized, bounded stderr tail after readiness and retain exit code/signal. Before replacing a managed process, lifecycle snapshots the reason, latest health failure, process diagnostics/aliveness, busy-session count, and timestamp into `lastOpenCodeRestartDiagnostics`; successful startup does not clear this snapshot, and `/health` exposes it for post-restart diagnosis without process environment or credentials.

Managed process ownership starts at spawn. The registry and runtime process
handle include children that have not announced readiness yet, so shutdown can
stop an in-flight startup. Readiness timeout, malformed startup output, and
health-probe errors close that child before retrying. Shutdown cancels further
startup attempts. Closing a process is single-flight and unregisters it only
after it exits.

On Windows, the managed OpenCode runs as `opencode serve --stdio` with a piped
stdin, and teardown first closes that stdin (`managed-process-stop.js`).
OpenCode reads EOF as the end of its ownership lease and shuts down the way
SIGTERM makes it on POSIX: running turns end as cancelled, so a chat waiting on
a question does not reopen as still working (#4988), and OpenCode stops its MCP
servers with their process trees. If OpenCode has not exited within 5 seconds,
teardown falls back to the tree termination command, which runs before the root
is terminated: calling `child.kill()` first loses the ancestry needed to find
Git, shell, and MCP descendants. `--stdio` prints its readiness line as
`{"url":"..."}`; the lifecycle accepts it next to `server listening on` in the
managed log file, where its output still goes: only stdin is a pipe. A Windows
OpenCode is never adopted across OpenChamber restarts (`isOwnedOpenCodePid`
answers false there), so the lease ending with OpenChamber loses nothing. On
POSIX, the managed child
starts in its own process group and teardown escalates against that group even
if the root has already exited. A tool ignoring SIGTERM must not survive just
because the server closed its own pipes. The
`lifecycle-process.test.js` regressions launch real parent/child fixtures and
check PID exit plus registry cleanup. macOS results do not validate Windows
ConPTY or Console Window Host behavior.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- OpenCode CLI resolution order is persisted settings, environment overrides, bundled Desktop CLI when available, PATH, known install locations, then platform shell discovery. A path pinned by the administrator (`opencodeBinary` in the machine policy file, `../enterprise-mode.js`) comes before all of them and has no fallback: `applyOpencodeBinaryFromSettings()` and `ensureOpencodeCliEnv()` resolve only that path (source `policy`), an unusable pin fails strict start with `OPENCODE_BINARY_INVALID`, and a removed pin hands resolution back to the order above. While pinned, the install-v2 and upgrade capabilities report unsupported (`reason: 'policy'`) and upgrade status never announces a newer version.
- Automatic bundled resolution under `OPENCHAMBER_RUNTIME=desktop` stays in runtime state and is returned to the managed launch function, including on OpenCode restart. It does not populate `process.env.OPENCODE_BINARY`: AppImage updater relaunch inherits that environment and would mistake the previous bundle path for an explicit override. Explicit settings/env selections and non-desktop or non-bundled resolution retain their existing environment behavior. This prevents future inheritance; it does not reinterpret overrides already inherited from older releases.
- The login-shell snapshot (`$SHELL -lic 'echo __OPENCHAMBER_ENV__; env -0'`, parsed from after the last marker line so text an rc file prints to stdout never fuses with the first variable) is taken synchronously at import time, so it blocks whatever process embeds the server for as long as the user's shell startup files take. An embedding host that already probed the shell hands its result over before importing the server through `login-shell-env.js` (`provideLoginShellEnvSnapshot(snapshot | null)`); the runtime then uses that and never probes, `null` included. Desktop does this on macOS and Linux; on Windows the server keeps its own registry-based snapshot. The handoff is a module slot, never an environment variable: the snapshot is the user's whole shell environment and `process.env` reaches every child.
- Returned API:
  - `applyLoginShellEnvSnapshot()`
  - `getLoginShellEnvSnapshot()`
  - `ensureOpencodeCliEnv()`
  - `applyOpencodeBinaryFromSettings()`
  - `resolveOpencodeCliPath()`
  - `resolveManagedOpenCodeLaunchSpec(opencodePath)`: resolves the effective managed OpenCode launch target, unwrapping Windows package-manager shims to a direct native binary or explicit runtime+script when possible.
  - `resolveGitBinaryForSpawn()`
  - `resolveWslExecutablePath()`
  - `buildWslExecArgs(execArgs, distroOverride?)`
  - `isExecutable(filePath)`
  - `searchPathFor(binaryName, searchPath?)`: resolves an executable from the supplied PATH value, defaulting to the process PATH.
  - `clearResolvedOpenCodeBinary()`

## Public exports (env-config.js)
- `resolveOpenCodeEnvConfig(options?)`: resolves and validates OpenCode host/port/hostname environment configuration.
- Returned object fields:
  - `configuredOpenCodePort`
  - `configuredOpenCodeHost`
  - `effectivePort`
  - `configuredOpenCodeHostname`

## Public exports (hmr-state-runtime.js)
- `createHmrStateRuntime(dependencies)`: creates runtime for HMR state container initialization and runtime<->HMR state synchronization.
- Returned API:
  - `getOrCreateHmrState()`
  - `ensureUserProvidedOpenCodePassword(hmrState)`
  - `getUserProvidedOpenCodePassword(hmrState)`
  - `resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword })`
  - `syncStateFromRuntime(hmrState, runtime)`
  - `restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword })`

## Public exports (bootstrap-runtime.js)
- `createBootstrapRuntime(dependencies)`: creates runtime for base app route bootstrap and UI auth controller initialization.
- Returned API:
  - `setupBaseRoutes(app, options)`

## Public exports (network-runtime.js)
- `createOpenCodeNetworkRuntime(dependencies)`: creates runtime for OpenCode network and URL concerns.
- Returned API:
  - `waitForReady(url, timeoutMs?)`
  - `normalizeApiPrefix(prefix)`
  - `setDetectedOpenCodeApiPrefix()`
  - `buildOpenCodeUrl(path, prefixOverride?)`
  - `ensureOpenCodeApiPrefix()`
  - `scheduleOpenCodeApiDetection()`

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`
- Persistent per-session permission modes are stored under `permissionAutoAccept`, and the mode for new sessions under `permissionDefaultMode`; execution ownership lives in `lib/permission-auto-accept/`.
- Queued follow-up messages live in `<data-dir>/message-queue.json`, not in settings; execution ownership lives in `lib/message-queue/`.
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarListSessionGrouping`, `sidebarProjectSortOrder`, `sidebarShowChatsSection`, `sidebarShowWorkSection`, `sidebarShowPinnedSection`, `sidebarSessionRowDisplay`, and `sidebarLayout` (objects checked for shape and size only; the client parses each choice and falls back to its default for values it does not know). Device-local picker selection and sticky-header state do not enter either settings file.
- Two files (`settings-files.js`): `settings.json` holds instance facts and any legacy or unknown keys; `preferences.json` beside it holds every key the generated registry snapshot (`settings-registry.json`) marks `profile`, as `{ version: 1, fields: { key: { value, updatedAt, surfaces? } } }`. Keys the snapshot marks `perSurface` are stored per surface kind: `GET`/`PUT /api/config/settings` read the client's kind from the `surface` query parameter (`settingsSurfaceOf`; the legacy `x-openchamber-surface` header is still honoured, but a header forces a CORS preflight that cross-origin shells and older instances refuse, so clients must not send one) (`web`, `desktop`, `vscode`, `mobile`; anything else means base), `persistSettings(changes, { surface })` writes a changed per-surface key under `surfaces[surface]` and never touches its base, and `readSettingsFromDisk({ surface })` resolves that kind's value first, the base otherwise. Callers without a surface (migrations, the seed, server-side feature writers) read and write the base. `readSettingsFromDisk()` returns the merged document and seeds `preferences.json` once from an existing `settings.json` (which it leaves intact). An existing `preferences.json` that fails to parse is a failure, not an empty profile: it is never seeded or overwritten, the merged read serves the instance part, and `persistSettings` drops profile keys with a warning until the file is fixed or removed. `writeSettingsToDisk(document)` splits by scope and writes `settings.json` as the instance part plus a copy of the profile's base values (`legacySettingsDocumentOf`): a build from before the split reads only that file, so a rollback keeps the user's preferences, while current builds ignore the copy because `preferences.json` wins in the merge; device keys are dropped from writes. Modules that read one profile key off the disk on a hot path use `readMergedSettingsSync`.

## Public exports (settings-files.js)
- `parsePreferencesDocument(raw)`, `serializePreferencesDocument(fields)`, `flattenPreferences(fields)`, `buildPreferencesFields(previousFields, document, now)`, `instancePartOf(document)`, `seedPreferencesFrom(document, now)`, `readMergedSettingsSync({ fs, path, settingsFilePath })`, `getSettingsScope(key)`, `isProfileSettingsKey(key)`, `isDeviceSettingsKey(key)`, `preferencesFilePathFor(settingsFilePath, path)`.
- The VS Code extension host writes the same two files with the same shape (`packages/vscode/src/settings-files.ts`); format changes go to both.

## Public exports (settings-helpers.js)
- `createSettingsHelpers(dependencies)`: creates settings helper runtime for settings request/response shaping.
- Returned API:
  - `normalizePwaAppName(value, fallback?)`
  - `sanitizeSettingsUpdate(payload)`
  - `mergePersistedSettings(current, changes)`
  - `formatSettingsResponse(settings)`

## Public exports (settings-normalization-runtime.js)
- `createSettingsNormalizationRuntime(dependencies)`: creates normalization/sanitization runtime for shared settings and tunnel helper logic.
- Returned API:
  - `normalizeDirectoryPath(value)`
  - `normalizePathForPersistence(value)`
  - `normalizeSettingsPaths(input)`
  - `normalizeTunnelBootstrapTtlMs(value)`
  - `normalizeTunnelSessionTtlMs(value)`
  - `normalizeManagedRemoteTunnelHostname(value)`
  - `normalizeManagedRemoteTunnelPresets(value)`
  - `normalizeManagedRemoteTunnelPresetTokens(value)`
  - `isUnsafeSkillRelativePath(value)`
  - `sanitizeTypographySizesPartial(input)`
  - `normalizeStringArray(input)`
  - `sanitizeModelRefs(input, limit)`
  - `sanitizeSkillCatalogs(input)`
  - `sanitizeProjects(input)`

Persistence path normalization (`normalizePathForPersistence` / `normalizeSettingsPaths` / `sanitizeProjects`, reached via the `readSettingsFromDiskMigrated` migration and `persistSettings`) resolves symlinks with `realpathSync` and, on case-insensitive filesystems (`win32`, `darwin`), also recovers the on-disk casing of each path component via `readdirSync` (exact-name match preferred so case-sensitive volumes are never rewritten). `realpathSync` alone does not report on-disk casing on these volumes, so without the readdir step a project stored with the wrong case would never match the real-case `directory` opencode reports for its sessions (issue #1913). A corrected path is flagged `changed` and written back to `settings.json`. A path `realpathSync` cannot resolve (missing, no permission) is kept exactly as stored, so case recovery can never swap in a different existing sibling. On macOS only `/` separates components; a backslash is a legal name character.

## Public exports (theme-runtime.js)
- `createThemeRuntime(dependencies)`: creates custom theme runtime for on-disk theme discovery and JSON normalization/validation.
- Returned API:
  - `normalizeThemeJson(raw)`
  - `readCustomThemesFromDisk()`

## Public exports (project-directory-runtime.js)
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation. `dependencies.refuseDirectory(candidate)` answers the reason a resolved directory may not be used on this host, or null; `validateDirectoryPath` asks it before it looks at the disk, so a refused directory is never touched and never falls back to another one. The isolated-spaces host refuses `/spaces/...` through it while its switch is on.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`
  - `resolveProjectDirectory(req)`
  - `resolveOptionalProjectDirectory(req)`

## Entity routes (v2 shapes)

Everything OpenChamber persists into OpenCode config now speaks OpenCode 2.
This section is the contract the Settings UI builds on.

### Ownership: which directory is written

OpenCode 2 still discovers the v1 directories, so OpenChamber READS all of them
and WRITES only the v2 one:

| Entity | Read from | Written to |
|---|---|---|
| Agents | `.opencode/{agent,agents,mode,modes}/**/*.md` | `.opencode/agents/<name>.md` |
| Commands | `.opencode/{command,commands}/**/*.md` | `.opencode/commands/<name>.md` |
| Skills | `.opencode/{skill,skills}/<id>/SKILL.md`, plus `.claude/skills` and `.agents/skills` | `.opencode/skills/<id>/SKILL.md` |
| Plugin files | `.opencode/{plugin,plugins}/` — `.ts`/`.js` files and plugin package directories | `.opencode/plugins/<file>` |

The same holds for the global config directory. Like OpenCode 2, agents,
commands and skills are looked up in every `.opencode` from the working
directory up to the worktree root, so a definition in a parent directory of a
monorepo package counts; a nested id (`team/reviewer`) maps onto the path.
Only files in the v2 `plugins/` directory are editable through the plugins
page; a package directory or a v1 `plugin/` file is listed as a package that
OpenCode loads and OpenChamber does not touch.

Disabled-agent listing and user-agent path indexing walk synchronously. Each
agent-directory root has its own `AGENT_WALK_MAX_DIRS` budget of 5000 visits,
including the root. A capped root returns agents found in visited directories;
later roots still receive their own budget. The visit order within each root
stays unchanged.

#### Why agent walks return partial results at the visit cap

The disabled-agent Settings request runs these walks synchronously, so the cap
bounds work for each root without changing discovery in smaller layouts. The
partial result retains agents from directories already visited.

The plugins page reads editable files through `GET /api/config/plugins/file/:id`
and reads the existing file before `PUT /api/config/plugins/file/:id`. Both
paths stat the file before reading and reject files larger than 1 MiB
(`MAX_PLUGIN_FILE_BYTES`) with HTTP 413 and code `PLUGIN_FILE_TOO_LARGE`. Files
at the limit keep the `{ fileName, scope, content }` response and update
behavior. Missing files keep the existing 404 response.

The global config directory is what OpenCode 2 uses: `OPENCODE_CONFIG_DIR`
when set, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. Config
files are `opencode.json(c)` only: OpenCode 2 no longer discovers the v1-era
`config.json`, so OpenChamber neither reads nor writes it. In a project both
`<project>/opencode.json(c)` and `<project>/.opencode/opencode.json(c)` are
discovered by OpenCode, `.opencode/` winning; OpenChamber reads and writes the
highest-priority existing one (`.opencode/opencode.json` for a new file), so
an entry that lives only in a lower file is visible through the resolved
catalog but not editable here.

### v1 read fallback policy

Readers accept the v2 spelling first and fall back to the v1 spelling, because
v2 itself still decodes the legacy keys and users will have mixed files for a
while. When both exist for the same name, v2 wins — the precedence OpenCode's
normalizer applies.

| Entity | v2 | v1 still read |
|---|---|---|
| Agents | `agents` | `agent` |
| Commands | `commands` | `command` |
| Providers | `providers` | `provider` |
| MCP servers | `mcp.servers` | `mcp.<name>` (each file normalized on its own, then OpenCode's order: folder files from `getFolderConfigPaths` > custom > user; a raw merge would let a user-file `mcp.servers.<name>` shadow a project-file `mcp.<name>` override) |
| Plugins | `plugins` | `plugin` (including `[spec, options]` tuples) |
| Permissions | `permissions` rule array | `permission` map, `tools` map |

Writers emit v2 only. **Files are never moved.** Updating an entity that lives
in a v1 file rewrites it at its own path in v2 shape, and a v1 JSON entry moves
to the v2 section key inside the same file — unrelated v1 siblings are left
alone. Every mutation response reports the `path` that changed.

Two consequences worth knowing:

- An agent markdown file may not mix native and legacy frontmatter keys. One
  legacy key routes the whole file through OpenCode's v1 decoder
  (`config/plugin/agent.ts`), which would silently drop a `permissions` array.
  `fromAgentEntity` therefore emits native keys only.
- Migrating a v1 provider entry drops the fields v2 accepts but ignores
  (model `reasoning`, `attachment`, non-`deprecated` `status`, and unknown
  custom keys). That is the documented native conversion, not data loss through
  a bug. v1 model `interleaved` becomes `compatibility.reasoningField` the way
  OpenCode's own migration does; the v2-only provider `canonical` and model
  `compatibility` fields pass through every edit untouched.
- A v1 agent `color` may be a theme name (`primary`); v2 decodes only
  `#rrggbb` and OpenCode's migration maps anything else to `#aaaaaa`.
  `toAgentEntity` applies the same mapping so a rewritten file stays decodable.

### Plugin specs written by the plugins page

A plugin entry is written only when OpenCode 2 can load its spec
(`loadable-plugin-spec.js`, used by `plugins.js` and the VS Code bridge's
`opencodeConfig.ts`). The accepted forms follow OpenCode's own install check
(`Npm.isInstallablePackage` in `packages/util/src/npm.ts`): an npm name with
an optional version, tag or range, a Git spec (`github:owner/repo`,
`git+https://…`, `git+ssh://…#ref`, `git@host:owner/repo.git`, `owner/repo`),
or a local path. Anything else is refused with `UNLOADABLE_SPEC`, which the route
answers as 400 with `code`, and the add dialog shows under the field. An
existing entry keeps its spec when only its options change, so a config that
already holds an unloadable spec stays editable.

#### Why rewrite a plain `https://` repository address and not refuse it

npm reads `https://github.com/owner/repo.git` as a Git repository, but
OpenCode 2.0.32 resolves it as a folder named after the URL and fails on every
start (measured: "Cannot find module '<cwd>/https:/github.com/…/server'").
The same repository as `git+https://…` installs and loads. The rewrite only
adds `git+`, and only for an address that names a repository without doubt: a
repository on GitHub, GitLab or Bitbucket, or any address ending in `.git`. A
page inside a repository (`/tree/main`) is refused, since the branch in its
path would be lost.

### Canonical entity shapes

One shape per entity, shared by the web routes and the VS Code bridge. The
conversions live in `config-v2.js`; `packages/vscode/src/opencode-config-v2.ts`
re-exports that module so both runtimes write identical files.

```jsonc
// PermissionRule — ordered array, last match wins.
// Actions: shell, subagent, edit, read, grep, glob, patch, webfetch, websearch,
// skill, question, external_directory, provider.use, "*"
{ "action": "shell", "resource": "git push *", "effect": "ask" }  // effect: allow | deny | ask

// AgentEntity
{
  "system": "Review for correctness.",   // markdown body for .md agents
  "description": "Reviewer",
  "model": "anthropic/claude-sonnet-4-5#high",
  "mode": "primary",                     // primary | subagent | all
  "hidden": false,
  "color": "#aabbcc",
  "steps": 12,
  "disabled": false,
  "request": { "headers": {}, "body": { "temperature": 0.4, "top_p": 0.9 } },
  "permissions": [ /* PermissionRule */ ]
}

// CommandEntity
{
  "template": "Review the current changes.",  // markdown body for .md commands
  "description": "Review",
  "agent": "reviewer",
  "model": "anthropic/claude-sonnet-4-5#high",
  "subagent": true
}

// McpEntity — `type` is required; v2 drops a v1 entry that only had `enabled`
{ "type": "local", "command": ["npx", "@playwright/mcp"], "cwd": "…",
  "environment": {}, "disabled": false, "codemode": true,
  "timeout": { "startup": 0, "catalog": 30000, "execution": 30000 } }
{ "type": "remote", "url": "https://mcp.example.com", "headers": {},
  "oauth": { "client_id": "…", "client_secret": "…", "scope": "…",
             "callback_port": 4242, "redirect_uri": "…" },
  "disabled": false, "timeout": { "catalog": 30000, "execution": 30000 } }

// ProviderEntity
{
  "canonical": "openai",                 // v2-only: built-in provider this entry inherits from
  "name": "Campus LLM",
  "package": "aisdk:@ai-sdk/openai-compatible",
  "env": ["CAMPUS_KEY"],
  "settings": { "baseURL": "https://llm.example.edu/v1" },
  "headers": {}, "body": {},
  "models": {
    "fast-model": {
      "modelID": "fast-model", "name": "Fast", "family": "…", "package": "aisdk:…",
      "compatibility": { "reasoningField": "reasoning_content", "requireReasoning": true, "maxTokensField": "max_tokens" },
      "settings": {}, "headers": {}, "body": {},
      "capabilities": { "tools": true, "input": ["text","image"], "output": ["text"] },
      "variants": [{ "id": "high", "settings": { "reasoningEffort": "high" } }],
      "cost": { "input": 1, "output": 2, "cache": { "read": 0.1, "write": 0.2 } },
      "limit": { "context": 200000, "output": 32000 },
      "disabled": false
    }
  }
}

// PluginEntity — serialized as a bare string when there are no options
{ "package": "./plugin/local.ts", "options": { "enabled": true } }
```

`model` is always the joined string `providerID/modelID#variant`. Split it with
`parseModelSelection(model)` → `{ providerID, modelID, variant? }` and join it
back with `formatModelSelection(selection)`. Both are exported from
`config-v2.js`.

### Request and response JSON per route

`GET /api/config/agents/:name` — metadata about where the agent is defined.
```jsonc
{
  "name": "reviewer",
  "scope": "project",              // project | user | null
  "isBuiltIn": false,
  "sources": {
    "md":   { "exists": true, "path": "…/.opencode/agent/reviewer.md", "scope": "project",
              "legacy": true,      // file uses v1-only frontmatter
              "fields": ["description", "model", "permissions"] },
    "json": { "exists": false, "path": "…/opencode.json", "scope": null,
              "sectionKey": null,  // "agents" or "agent" when the entry exists
              "legacy": false, "fields": [] },
    "projectMd": { "exists": true,  "path": "…" },
    "userMd":    { "exists": false, "path": "…" }
  }
}
```

`GET /api/config/agents/:name/config` — the canonical entity.
```jsonc
{
  "source": "md",                  // md | json | none
  "scope": "project",
  "path": "…/.opencode/agent/reviewer.md",
  "legacy": true,
  "config": { /* AgentEntity */ }
}
```

`GET /api/config/agents/:name/permissions` — what applies to this agent.
```jsonc
{
  "global":    [ /* PermissionRule, from config `tools` + `permission` + `permissions` */ ],
  "agent":     [ /* PermissionRule, the agent's own rules */ ],
  "effective": [ { "action": "edit", "resource": "*", "effect": "allow", "source": "global" },
                 { "action": "edit", "resource": "*", "effect": "deny",  "source": "agent" } ],
  "source": "md",
  "path": "…"
}
```
`effective` is in evaluation order: global rules first, agent rules last. Last
match wins, so a later rule overrides an earlier one.

`POST /api/config/agents/:name` — body is an `AgentEntity` plus
`scope: "user" | "project"`. Answers
`{ success: true, message, scope, path }`.

`PATCH /api/config/agents/:name` — body is a partial `AgentEntity`. `null`
removes a field, an omitted field is left alone. `permission` (a v1 map) and
`prompt` (the v1 name for `system`) are still accepted and translated. Answers
`{ success: true, message, source, scope, path }`.

`DELETE /api/config/agents/:name` — optional body `{ scope }`. Answers
`{ success: true, message }`.

`GET /api/config/commands/:name` — same `sources` envelope as agents.
`GET /api/config/commands/:name/config` — `{ source, scope, path, legacy, config }`
with a `CommandEntity`.
`POST` / `PATCH` / `DELETE /api/config/commands/:name` mirror the agent routes;
`subtask` is accepted as the v1 name for `subagent`.

`GET /api/config/mcp` — array of `McpEntity` extended with
`{ name, scope, sectionKey, legacy }`. Servers come from the global files,
`OPENCODE_CONFIG`, and every folder file OpenCode reads for the project,
parent folders included. `scope` is `project` only for the project folder's
own files; a parent folder's server reads as `user`. `PATCH` and `DELETE`
write the file whose definition OpenCode uses, a parent folder's file
included; a broken folder file is skipped, a broken global or custom file
fails the request.
`GET /api/config/mcp/:name` — one such entry, or 404.
`POST` / `PATCH` / `DELETE /api/config/mcp/:name` — body is an `McpEntity`
(plus `scope` on create). Answers `{ success: true, message, path }`.

`PUT /api/provider` — body accepts either spelling: v2 `{ package, settings,
headers }` or v1 `{ npm, options }`. The stored entry is always a
`ProviderEntity` under `providers`. Answers `{ providerId, path, config }`.
`GET /api/provider/:providerId/source` reports which layers define it.

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers configuration entity routes:
  - Agents: `/api/config/agents/:name`, `/api/config/agents/:name/config`, `/api/config/agents/:name/permissions`
  - Commands: `/api/config/commands/:name` and `/api/config/commands/:name/config`
  - MCP servers: `/api/config/mcp` and `/api/config/mcp/:name`
  - Snippets: `/api/config/snippets`, `/api/config/snippets/:name`, and `/api/config/snippets/expand`
- Agent/command/MCP write routes persist config to disk and return plain success. OpenCode 2 watches those files and rebuilds the affected entity itself, so there is nothing left to apply.

## Public exports (config-mutation-response.js)
- `buildAppliedResponse(message, details?)`: success payload for a config mutation that is already live (`{ success: true, message }`, no restart flags). `details` carries the file the write landed in (`{ path, scope, source }`) so the caller can name the config file that changed, including a v1 file rewritten in place in v2 shape.
- `buildExternalManualRestartResponse(message)`: success payload when OpenCode is an external process and the operator must restart it manually (`requiresManualRestart: true`).

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`: open before login, because the CLI matches `pid` against its pid file to recognise its own server. `port` and `tunnelUrl` are included only for a caller `isRequestAuthorized` accepts.
- `isRequestAuthorized(req, res, { tunnelAuthController, uiAuthController })`: whether a request carries credentials `/api` would accept, without refusing it. Routes open before login use it to leave private details out.
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
   - `PATCH /api/passkeys/:id`
   - `DELETE /api/passkeys/:id`
   - `POST /api/auth/reset`
   - `GET /connect`
   - `POST /api/system/probe-url`
   - `app.use('/api', ...)` auth/tunnel guard
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`
  - `POST /api/config/reload` — restarts OpenCode on request. Config edits no longer need it; it stays for the changes that cannot be hot-applied (OpenCode binary, port, managed/external switch) and as a manual recovery. Managed OpenCode restarts and returns `requiresReload: true`. External OpenCode returns `requiresManualRestart: true` (changes are already on disk; the connected server must be restarted outside OpenChamber).
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
  - URL-encoded parser setup
  - request logging middleware
  - `dependencies.skipBodyParsing(req)` names a request both parsers leave alone, so its body reaches its route untouched; the isolated-spaces dispatcher uses it for a request to a space, by the space directory its query or headers name or by the `/api/spaces/<id>/...` prefix, which it streams into a space

## Public exports (cli-options.js)
- `parseServeCliOptions(options)`: parses serve CLI flags and environment-derived defaults:
  - Port/host/ui-password
  - Tunnel provider/mode/config/token/hostname
  - Legacy `--tunnel` shorthand normalization

## Public exports (cli-entry-runtime.js)
- `runCliEntryIfMain(dependencies)`: detects direct CLI execution and runs server startup with parsed CLI options.

## Public exports (server-utils-runtime.js)
- `createServerUtilsRuntime(dependencies)`: creates server utility runtime for OpenCode orchestration helpers.
- Returned API:
  - `setOpenCodePort(port)`
  - `waitForOpenCodePort(timeoutMs?)`
  - `buildAugmentedPath()`
  - `parseSseDataPayload(block)`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Daemon signals, `POST /api/system/shutdown`, and embedded `stop()` share one shutdown promise. `gracefulShutdown({ keepOpenCode: true })` (SIGTERM) leaves the managed OpenCode running and skips the port wait. Guest admission closes synchronously before any await. Cleanup stops the relay reconciliation timer, guest viewers, realtime proxy, relay host, dictation worker and session runtimes before draining guest services, including pending starts. Each cleanup is best-effort and runs once per shutdown, including after partial startup. A hard kill skips all of this. Guest services it leaves running are stopped by the next host start through the guest service registry (`../guests/DOCUMENTATION.md`, Crash recovery); managed OpenCode has its own registry above.
- Register TCP connection tracking before the HTTP server starts listening. After stopping owned runtimes and OpenCode, HTTP shutdown closes the listener and all remaining sockets, including WebSocket upgrades and unanswered upgrade requests accepted during cleanup. This prevents client reconnects from holding Desktop open until the HTTP close deadline. Each runtime still owns its protocol cleanup; socket teardown runs afterwards and preserves the existing terminal and process grace periods.
- Returned API:
  - `gracefulShutdown(options?)`
  - `trackServerConnections(server)`: call once before listening; closed sockets leave the tracking set, and the server close event removes the connection listener.

## Public exports (server-startup-runtime.js)
- `createServerStartupRuntime(dependencies)`: creates runtime for server bind/startup tunnel and process handler wiring.
- Returned API:
  - `resolveBindHost(host)`
  - `startListeningAndMaybeTunnel(options)`
  - `attachProcessHandlers(options)`

## Public exports (static-routes-runtime.js)
- `createStaticRoutesRuntime(dependencies)`: creates runtime for static dist resolution and static route registration.
- Returned API:
  - `registerStaticRoutes(app)`

## Public exports (feature-routes-runtime.js)
- `createFeatureRoutesRuntime(dependencies)`: creates runtime for main feature route registration orchestration.
- Returned API:
  - `registerRoutes(app, routeDependencies)`
  - `hydrateBoundCheckout({ directory, parentDirectory, parentRemoteName })`: resolves the parent repository's current binding authority at call time, then delegates local inspection and any explicit hydration to the runtime's existing Git network-operation service.

## Public exports (opencode-resolution-runtime.js)
- `createOpenCodeResolutionRuntime(dependencies)`: creates runtime for OpenCode binary/source snapshot resolution.
- Returned API:
  - `getOpenCodeResolutionSnapshot(settings)`: returns configured/resolved OpenCode binary details plus effective managed-launch fields (`launchBinary`, `launchArgs`, `launchWrapperType`) when applicable.

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort, hasUiPassword)`

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

The pipeline binds the OpenChamber listener and publishes its active port
before starting managed OpenCode. The managed custom tool therefore receives
an authoritative loopback callback URL even when OpenChamber binds port `0`.

## Public exports (openchamber-routes.js)
Browser completion checks use `appType=web&updateStatus=true` to stay on the
Desktop Host's native updater. A rejected native restart is retained in the
server process and returned to these polls as `DESKTOP_UPDATE_RESTART_FAILED`;
ordinary availability checks remain usable so a browser reload can offer a
retry. Starting another installation clears the previous restart error.
The shared UI's `lib/web-update.ts` parses install/check responses and waits
for the installed native target version, rather than treating absence of a
newer release as installation success. Poll requests have individual deadlines
within a ten-minute overall deadline.

- `registerOpenChamberRoutes(app, dependencies)`: registers OpenChamber endpoints:
  - `GET /api/openchamber/update-check`
  - `POST /api/openchamber/update-install`
    - A copy no package manager installed answers 409 before any command
      runs: a global install would add a second copy and leave the running
      one as it is. Detection reports such a copy as `unmanaged-install` when
      no package manager claims it and its path is outside any `node_modules`
      folder: an unpacked tarball, the Docker image, a source checkout. A copy
      inside `node_modules` that no check attributes keeps `default-fallback`
      and the npm install, since a version manager's npm may still own it.
      The update check marks an
      unmanaged copy's update `installBlocked: 'manual-install'`, and a
      foreground server without a service manager `installBlocked:
      'service-manager'`, so clients show manual steps in place of an Update
      button.
    - Desktop-managed hosts delegate authenticated Web update requests to the Electron main process, which checks, downloads, and applies the update through `electron-updater` before restarting the host. A host installed from a Linux `.deb` or `.rpm` asks for the administrator password on its own screen, so its check reports `installBlocked: 'desktop-host'` and the install route answers 409 `DESKTOP_UPDATE_LOCAL_ONLY` before anything stops; clients say to update on that computer.
    - Foreground servers running under a systemd user unit queue installation in
      a separate transient unit and restart the configured service afterwards.
      `OPENCHAMBER_SYSTEMD_UNIT` overrides the default `openchamber.service`.
    - Foreground servers running under a macOS launchd User LaunchAgent update the
      package and trigger a `launchctl kickstart` (with a `launchctl bootstrap`
      fallback, as `openchamber startup enable` uses) against
      `~/Library/LaunchAgents/dev.openchamber.web.plist`. The server counts as the
      LaunchAgent only when the plist exists and launchd set `XPC_SERVICE_NAME` to
      its label, so a manual `serve --foreground` keeps the 409.
    - On Windows the install-and-restart script is written to
      `<data dir>/update-install.cmd` before the response and run with
      `cmd.exe /c <file>`. A newline ends a `cmd.exe /c` command line, so the
      same script passed as an argument ran nothing and exited 0; the batch
      file keeps every line. The package-manager line is `call`ed because
      npm, pnpm and yarn are `.cmd` shims that would otherwise end the script,
      the pre-install pause is a loopback `ping` because `timeout` rejects a
      detached child's stdin, and the file deletes itself on its last line
      because the restart command carries the server's flags. If the file
      cannot be written the route answers 500 and the server keeps running.
      The listener is closed before the batch is spawned: on Windows the
      detached child inherits the listening socket and would hold the port
      for the whole batch, so the restart inside it failed with "port already
      in use" and the update ended with no server.
  - `GET /api/openchamber/models-metadata`
  - `GET /api/zen/models`

## Public exports (pwa-manifest-routes.js)
- `registerPwaManifestRoute(app, dependencies)`: registers PWA manifest endpoint with dynamic app-name resolution and recent-session shortcuts:
  - `GET /manifest.webmanifest`: served without API auth (the browser fetches it with cookies, `crossorigin="use-credentials"`). Session shortcuts, which carry session titles, are added only for an authorized caller, and their directory is the one the UI last used, never one named in the request.

## Public exports (project-icon-routes.js)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`

## Public exports (skill-routes.js)
- `registerSkillRoutes(app, dependencies)`: registers skills-related routes:
  - Skills config CRUD and metadata under `/api/config/skills*`
  - `DELETE /api/config/skills/:name` removes every copy of the name, in the project and the user's skill folders. With `scope` (`user`|`project`) and `source` (`opencode`|`claude`|`agents`) in the query it removes only the copy there and fails when that copy is missing; the integrations catalog uninstalls this way so it never removes a same-named skill the user keeps elsewhere
  - Skill rename via `PATCH /api/config/skills/:name` with `{ renameTo }` (directory rename preserves `SKILL.md` body and supporting files; restricted to managed skill roots under `.opencode/skills|skill`, `.claude/skills`, and `.agents/skills`)
  - Skill list responses include authoritative `renamable` derived from the same managed-root policy used by rename
  - `GET /api/config/skills` leaves `sources.md.supportingFiles` out: listing every file of every skill cost seconds when a skill bundles a `.venv` or `node_modules`, and no list consumer reads it. `GET /api/config/skills/:name` still returns it
  - Discovery and skill reads are async (`fs.promises`), and the list enriches one skill at a time, so a large skills tree no longer stalls other requests on the server's event loop
  - Create, edit and rename run one at a time per process, so an existence check cannot go stale before its own write; create also writes `SKILL.md` with `wx` and reports an existing file as "already exists" instead of overwriting it
  - `disableModelInvocation` (detail `sources.md`, create/update body) is "run only when called": it writes both `disable-model-invocation: true` and `metadata.opencode/autoinvoke: false` so every supported OpenCode 2.x and Claude Code honour it, reads back the way OpenCode resolves the pair (`opencode/autoinvoke` wins), and clearing it removes both keys while keeping other `metadata`. The VS Code runtime mirrors this in `opencodeConfig.ts`
  - Skills catalog listing/source pagination, scan, and install routes
  - Supporting skill file read/write/delete routes
  - Directory resolution prefers an explicit request directory, then soft-falls
    back to the active project / `lastDirectory` so repository-local
    `.agents/skills` and `.opencode/skills` remain discoverable when the client
    omits `directory`. Requests without any project still list user-scoped skills.

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
    - Downstream heartbeats keep clients and intermediaries alive, while a separate upstream-only stall watchdog closes the downstream response when OpenCode stops producing bytes so clients reconnect instead of trusting synthetic heartbeats indefinitely. Each watchdog reset uses the current load-aware timeout, matching the shared event transport.
  - Session message forwarder: `POST /api/session/:sessionId/message`
  - Session list and detail: `GET /api/session`, `GET /api/session/:sessionID`
    - Both routes and the shelled message page read the upstream body through `fetchSessionListPayload`, which caps the read at `SESSION_LIST_PAYLOAD_MAX_BYTES` (16 MiB) while it streams in, through the bounded reader in `../guests/response-body.js`. The cap matches the event-stream protocol's in-memory bound for the same session/message data; UI pages stay far below it (message pages ask for 10-50 messages, session lists for at most 200 records). An answer over the cap is cancelled upstream and the route answers 502 `OpenCode response too large`; a truncated body is never served as complete.
    - Both are sanitized to an allowlist of `SessionInfo` fields, then get archive state folded in from `lib/openchamber-sessions/archive-store.js`, because OpenCode 2.x has no archive route, plus any `metadata` entry `lib/openchamber-sessions/session-metadata-store.js` has not migrated from the legacy file yet. An unknown answer from either store leaves the upstream record untouched rather than reporting a session as un-archived or dropping its metadata.
  - Shelled message pages: `GET /api/session/:sessionID/message` with `x-openchamber-part-shells: v1[,<tool>…]` returns the page with finished tool results replaced by an `openchamberContentShell` metadata marker and with fields no client reads dropped (`message-shells.js`); without the header the request reaches OpenCode untouched. `GET /api/session/:sessionID/message/:messageID` is never shelled, so clients complete a call from it. `/health` and `/api/version` list `api.message-part-shells.v1` so clients send the header only to servers that honour it.
  - Upstream paths are the request paths. OpenCode 2.x serves everything under `/api/*` itself, so the mount prefix Express strips is put back instead of being rewritten away.
  - There is no interactive OAuth forwarder any more: v2 connects providers through `/api/integration/*`, whose OAuth steps return immediately and are polled, so no route needs a longer deadline than the ordinary one.
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Session list forwarding on every platform, preserving V2 query filters and pagination cursors. Global reads use OpenCode's cross-directory list rather than merging per-project pages on Windows.
  - OpenCode readiness gate for proxied `/api` requests
  - Worktree checkout gate before directory-scoped upstream reads and writes

Git bootstrap must reach `git-ready` before OpenCode can cache a new worktree's
project identity or config. Setup scripts may still be running; the optional UI
setup wait remains separate. Failed or timed-out checkout returns 503 without
forwarding. The shared draft creator keeps the project directory selected until
creation returns, because preview paths have no bootstrap state. A directory with
no bootstrap state was never populated by this server and passes at once. The gate
reads the in-memory state only: the durable bootstrap store takes a cross-process
file lock per read, which must not sit on every proxied request.

This server gate covers web, Electron, hosted mobile, and Capacitor connections.
The VS Code extension owns its separate Git and proxy implementation.

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/api/event` connection.
  - Can still create its own `/api/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Translates each v2 wire event through `lib/event-stream/translate-v2.js` before handing it to notification/session side effects, so those consumers keep speaking the server's own event vocabulary.
  - Calls `onPayload(payload, { spaceId })`: `spaceId` is the isolated space an event came from, `null` for the host's own. A space's session exists only in the OpenCode inside that space, so a consumer that reads a session must read it there.

## mcpx secret routes

The mcpx daemon holds secret values in memory. A server call that needs a missing one waits, and the OpenChamber prompt answers that wait:

- `GET /api/mcpx/secret-requests` and `GET /api/mcpx/secrets` proxy the daemon's list routes. The secret list carries names and states only.
- `PUT /api/mcpx/secrets/:name` relays `{ value }` to the daemon. The name must be an environment variable name. The value must be a non-empty string of at most 16384 characters.
- `DELETE /api/mcpx/secret-requests/:id` declines a request.

In enterprise mode all four answer 403 with `code: 'enterprise_mode'`, before the PUT body is read, so a value is never parsed there. The routes and the VS Code host share the operations in `mcpx-secrets.js`; the daemon client is in `mcpx-daemon.js`.

The PUT reply is `{ name, set, source }` only, so a value cannot come back even when the daemon echoes it. A parse error on the PUT body is answered in `mcpx-routes.js` and never passed to the framework, because the framework logs the error message, and a JSON parse error message can quote part of the body. Every secret route sends `Cache-Control: no-store`. A daemon failure on the PUT returns a fixed 502 message, since the daemon's error text could repeat the value. Nothing on these routes logs a request body or a value.

The prompt is `components/mcp/McpxSecretRequestPrompt.tsx`, mounted in `App.tsx`, `VSCodeApp.tsx`, `ElectronMiniChatApp.tsx` and `MobileApp.tsx`, and its polling is in `hooks/useMcpxSecretRequests.ts`. In enterprise mode the prompt renders nothing and does not poll. It polls `GET /api/mcpx/secret-requests` every 2 s while the app is visible. When the daemon is unreachable it backs off, doubling up to 30 s, and keeps the last list it read. It shows the oldest pending request, one at a time. A runtime switch drops the list, so a secret goes only to the runtime that asked for it. Closing the dialog hides that request until the next list read. The daemon still lists it as pending, so the next read, within 2 s, shows it again. Only Decline (`DELETE`) ends the request. In the VS Code extension, `webview/main.tsx` answers these routes through the bridge in `bridge-mcpx-runtime.ts`, since `/api` requests there otherwise go to OpenCode.

## Storage and configuration
- Provider auth: read from the running OpenCode over `GET /api/credential` (2.0.20+); OpenCode 2.x owns credentials.
- Session archive state: `sessions-archive.json` under the OpenChamber data dir.
- Session metadata (goal progress, the assist recap, the obligatory-context cursor, pinned notes) lives on the OpenCode session record, written with `PATCH /api/session/{id}` (OpenCode 2.0.15+, the minimum `compatibility.js` enforces). OpenCode replaces the whole object, so `sessionMetadataStore.setSessionMetadata` reads the record, applies the JSON Merge Patch and writes the result, one write per session at a time; a record that cannot be read stops the write. Every reader and writer (routes, goal loop, session assist, session knowledge, obligatory context, notifications) goes through `sessionMetadataStore.get` / `setSessionMetadata`. Older OpenChamber versions kept this state in `sessions-metadata.json` under the data dir. Its entries are the newest metadata their sessions have: the proxy lays them over OpenCode's records, a session's next write pushes its entry, and a sweep after OpenCode starts pushes the rest (a session OpenCode no longer knows is dropped, any other failure waits for the next write or start). The emptied file is renamed to `sessions-metadata.json.migrated`. Archive mutations still run one transaction at a time in the archive store.
- User config: `<config dir>/opencode.json(c)` where the config dir is `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. The v1 `config.json` is not read.
- Project config: `<workingDirectory>/.opencode/opencode.json(c)` first, else `<workingDirectory>/opencode.json(c)`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Origins (`../security/request-security.js`): CORS with credentials and socket upgrades trust the request's own host, `publicOrigin`, and the packaged clients (`openchamber-ui://app`, `capacitor://localhost`, `https://localhost`). Any other loopback port is trusted only on a development server (`OPENCHAMBER_ELECTRON_DEV=1` or `OPENCHAMBER_ALLOW_DEV_ORIGINS=1`, which the dev scripts set). Without a UI password a socket that names an `Origin` must still come from one of these (`isPasswordlessSocketOriginAllowed`): nothing else would stop a website open in the user's browser from reaching the terminal on the loopback port. Clients that send no `Origin` are not pages and pass.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars. Login and tunnel-connect limits key on `req.ip`. `server/index.js` sets `trust proxy` to loopback and private ranges, so `X-Forwarded-For` counts only when a proxy on this machine or a private network sent it; from anyone else it is ignored and cannot open a fresh bucket per attempt.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.

The behavior `GET /api/behavior/agents-md` response includes `path`, the effective
server-side filename, whether or not the file exists. Settings displays this
path without deriving a directory from the browser environment. A `PUT` may send
`expectedContent` (the content the editor loaded, `null` for no file); when the
file on disk no longer matches, the write is refused with `409` and code
`AGENTS_MD_CONFLICT` instead of overwriting an edit made elsewhere.

## Managed OpenCode config layer (managed-config-file.js)

OpenChamber injects its own OpenCode plugins through a file it owns rather than
through the process environment, because an environment variable cannot change
under a running child.

- Contract: the managed child gets `OPENCODE_CONFIG=<data-dir>/run/instances/<server-pid>/opencode.managed.json`.
  Each server writes the file and the agent-tool plugin in its own folder
  (`instance-dir.js`): several servers can share one data dir, and with shared
  paths each overwrote the other's files, so an agent saw tools from one server
  while its calls went to another (#4470). On start a server removes the
  folders of servers whose pid is gone; a live server's folder is never touched.
  The pid check assumes every server on the data dir runs in one PID
  namespace: two containers sharing a data dir through a bind mount see each
  other's pids as gone, so a starting server can remove a live peer's folder,
  and that peer's OpenCode loses its managed tools until the next settings
  write or restart.
  The old shared `<data-dir>/agent-tool/` and `<data-dir>/opencode.managed.json`
  stay on disk on purpose: an older OpenChamber running on the same data dir
  still reads and writes them, so deleting them as stale breaks that server's
  agent tools.
  The file contains only `plugins`: `-opencode.browser` first, then the absolute
  directory of every OpenChamber plugin currently switched on. OpenCode's
  built-in browser tools need OpenCode's own desktop app to attach a browser;
  OpenChamber does not, so they would always fail with `browser.disconnected`
  and steer agents away from `openchamber_web`. A project config listing
  `opencode.browser` re-enables it. The fallback path merges the same entry. Its layer sits above the user's
  global `opencode.json` and below their project config.
- `OPENCODE_CONFIG_CONTENT` is passed through untouched, so whatever the user
  put there still applies.
- `OPENCHAMBER_AGENT_TOOL_URL` and a fresh `OPENCHAMBER_AGENT_TOOL_TOKEN` are
  always in the child environment, including while every managed tool is off —
  a tool switched on later then reaches a process that can already call back.
- `persistSettings` rewrites the file (temp + rename) whenever
  `agentControlToolEnabled`, `agentScheduleToolEnabled`, `agentWebToolEnabled`, `agentMemoryToolEnabled`,
  `agentKnowledgeToolEnabled`, `agentNotifyToolEnabled`, `agentRenderToolEnabled` or `agentToolsCodeMode` changes. Plugin directories are written before the
  file names them, and a disabled plugin is removed from the list. OpenCode
  reloads within a couple of seconds; no restart is involved.
- Fallback: when the user's own environment already sets `OPENCODE_CONFIG`,
  OpenChamber does not take it over. It merges its plugin directories into
  `OPENCODE_CONFIG_CONTENT` instead, and those installs keep the old behavior —
  a managed-tool toggle needs an OpenCode restart to take effect.
- `appliesLive()` is true when OpenChamber launched the running OpenCode
  (`isManagedOpenCode`: not external, not skip-start) and owns the config file.
  `formatSettingsResponse` reports it as the computed, read-only
  `managedToolsApplyLive`, so the Tools settings page shows its prompt cache
  note only when a switch reaches the running process. No process or CLI call.

The embedded server controller exposes `getManagedOpenCodePreflight()` for
desktop bootstrap. It shares the lifecycle's current CLI validation promise,
including while validation is in flight. It returns false before validation
starts, after failure, during shutdown, or for external OpenCode. Restart clears
the previous result, and readers discard results from a replaced preflight.
This checks CLI compatibility, not server health; the normal startup flow still
owns connection readiness. Explicit user compatibility checks remain fresh.
