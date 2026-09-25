# OpenCode Module Documentation

## Purpose
This module provides OpenCode server integration utilities for the web server runtime, including configuration management and provider authentication.

## Entrypoints and structure
- `packages/web/server/lib/opencode/index.js`: public entrypoint (currently baseline placeholder).
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/cli-entry-runtime.js`: CLI entrypoint runtime that detects direct execution, parses CLI options, and starts server bootstrap.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/v1-migration-topup.js`: re-arms OpenCode's own V1 -> V2 session import for V1 sessions changed by 1.x after the last completed import; runs only before a managed spawn. See "v1-migration-topup.js" below.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). After readiness it warms the most recently used directories (`getWarmupDirectories` dep, sequential and best-effort) because OpenCode initializes each directory lazily on first request and that cost would otherwise be paid by the user's first interactive session open.
- `packages/web/server/lib/opencode/provider-env-aliases.js`: mirrors known provider credential env aliases into the managed OpenCode process environment (for example `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`) so OpenCode connection detection and the upstream AI SDK agree on the same key names. Canonical implementation shared by web lifecycle and the VS Code managed spawn path (`packages/vscode/src/provider-env-aliases.ts` re-exports this module).
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration. OpenCode 2 watches these files, so a write is live as soon as it lands and the route answers plain success.
- `packages/web/server/lib/opencode/websearch-config.js`: writes OpenCode's `websearch` choice (`PUT /api/config/websearch` in `routes.js`; body `{ selection: false | null | "random" | "<provider id>" }`, `null` removes the key, so OpenCode falls back to the answer given in its chat consent form, which it keeps in its own store) to `OPENCODE_CONFIG` when set, else the user config. `GET /api/config/websearch` returns `{ projectPath }`: the project config whose `websearch` overrides that write (OpenCode merges user < project < `OPENCODE_CONFIG`), so Settings disables the choice and names the file instead of letting it snap back; `findWebSearchProjectOverride` in `config-v2.js` holds the rule. The pure transform is `writeWebSearchSelection` in `config-v2.js`, shared with the VS Code bridge (`api:config/websearch`).
- `packages/web/server/lib/opencode/config-mutation-response.js`: shared response builders for applied config mutations and external manual-restart guidance.
- `packages/web/server/lib/opencode/snippets.js`: opencode-snippets-compatible snippet file CRUD, discovery, and hashtag expansion.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/guest-services/terminal/process/server teardown.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/upgrade-capability.js`: authoritative upgrade ownership policy for the active OpenCode runtime. Bundled, external, and unresolved runtimes fail closed; only managed non-bundled runtimes delegate upgrades to OpenCode.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/startup-performance.js`: opt-in startup phase diagnostics with fixed labels and numeric metadata allowlists.
- `packages/web/server/lib/agent-tool/runtime.js`: managed OpenCode custom-tool materialization, environment injection, same-machine authentication (loopback, or the bound address for a concrete bind), and fixed CLI action dispatch.
- `packages/web/server/lib/opencode/managed-plugin-config.js`: the `OPENCODE_CONFIG_CONTENT` merge used only on the fallback path, when the user's own environment owns `OPENCODE_CONFIG`.
- `packages/web/server/lib/opencode/managed-config-file.js`: the managed OpenCode config layer — materializes the enabled OpenChamber plugins (agent tools, system prompt optimizer) and publishes them in a file OpenCode watches.

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
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization).
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.

  `POST /api/config/themes` saves a converted VS Code palette. The runtime validates
  literal colors and required authored roles, assigns a content-derived filename,
  and publishes through a same-directory hard link so partial files and overwrites
  are impossible. Identical retries reuse the existing file; a manually edited
  collision returns 409. Temporary files are ignored by the loader and removed
  after publication or failure. Non-missing-directory read failures propagate to
  the route instead of returning an authoritative empty library.

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
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/opencode/config-v2.js`: the canonical OpenCode 2 shape layer — section-key resolution (v2 first, v1 fallback), permission map -> rule array translation, model `provider/model#variant` split/join, and the agent/command/MCP/provider/plugin entity conversions. Pure functions with no filesystem access; `packages/vscode/src/opencode-config-v2.ts` re-exports it so the web server and the extension host cannot write different files. See "Entity routes (v2 shapes)" below.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Public exports (auth.js)
`auth.js` is read-only. OpenCode 2.x imports `auth.json` once into its own
database and never writes the file again; credentials live behind
`/api/integration` and `/api/credential`, and no HTTP route hands a key back.
OpenChamber needs the raw credential for provider quota lookups, voice keys and
the GitHub and Linear helpers, so `readAuthFile()` answers from the database
OpenCode actually uses (`credential-db.js`, below). A successful database read
is authoritative, `{}` included: OpenCode never clears `auth.json` after the
import and a credential removed in OpenCode vanishes only from the database,
so the file is never merged over a readable database. The legacy file is the
fallback only when the database cannot be read (no sqlite runtime, no file,
unknown schema); a corrupt file then throws, but never blocks a healthy
database. A write here would be invisible to the running OpenCode, so every
write path is gone.

- `readAuthFile()`: The credentials OpenCode uses, keyed by provider id, in the
  legacy `auth.json` entry shape (`{ type: 'api', key }` /
  `{ type: 'oauth', access, refresh, expires, accountId?, enterpriseUrl? }`).
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `AUTH_FILE`: Legacy auth file path constant.
- `OPENCODE_DATA_DIR`: OpenCode data directory path constant.

### credential-db.js

Reads `<data>/opencode.db` (or `OPENCODE_DB`), table `credential`, where
OpenCode 2.x stores every credential as plain JSON. This is OpenCode's private
schema, verified against v2.0.x `packages/core/src/credential/sql.ts`; the
reader opens the file read-only, picks the `active` row per integration (else
the newest), projects `{ type: 'key' }` / `{ type: 'oauth' }` values into the
legacy entry shape, and answers `null` for anything it cannot do (no sqlite
runtime, no file, a changed schema), so the caller can tell "no credentials"
from "could not look" and fall back to the file. `node:sqlite` on Node 22.13+,
`bun:sqlite` on Bun; no dependency is added. `packages/vscode/src/opencodeAuth.ts`
is the extension-host mirror.

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
with the same loader strategy as `credential-db.js` — `node:sqlite` on Node,
`bun:sqlite` on Bun, skip silently on neither. It returns
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
- `upsertProviderConfig(providerId, config, workingDirectory, scope?, options?)`: Validates and writes a custom provider block into the user/project/custom config layer. The payload may use the v2 spelling (`package`, `settings.baseURL`, `headers`) or the v1 spelling (`npm`, `options.baseURL`); what lands on disk is always a v2 `providers` entry with `package: "aisdk:<npm>"` and `settings.baseURL`. The adapter may be OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Existing provider, option, and retained-model fields not managed by the form are preserved; omitted models, headers, and env credentials remain explicit removals. A model's `variants` (reasoning levels) are replaced when the payload carries the array, cleared when it carries an empty one, and kept when the key is absent. Updating an entry still stored under the legacy `provider` key rewrites it under `providers` in the same file, dropping the fields v2 accepts but ignores; unrelated legacy siblings are untouched. Does not store API keys. Requires `config.env` or `options.hasStoredAuth` (auth already written via OpenCode `auth.set`). Edit flows must pass the provider's effective existing layer (`custom` > `project` > `user`) so updates do not create a global user override.
- `validateCustomProviderConfig(providerId, config, options?)`: Structural validation for custom provider payloads (id format, adapter allowlist `@ai-sdk/openai-compatible`/`@ai-sdk/openai`/`@ai-sdk/anthropic`, http(s) base URL, models, credentials via `env` or `hasStoredAuth`). Accepts both spellings and returns the normalized v2 value.
- `removeProviderConfig(providerId, workingDirectory, scope?)`: Removes a provider block from the selected config layer.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`: Path constants rooted at `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is non-empty, otherwise `~/.config/opencode`. These constants are evaluated when the module loads; no files are migrated. `OPENCODE_CONFIG` remains a separate explicit config-file path and is resolved at call time for the custom config layer; it does not replace the global config directory.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom). `readConfigLayers` isolates `INVALID_JSONC` per layer: a broken file is omitted from the merge (`{}` for that layer only), recorded on `layerErrors`, and does not block valid sibling layers. Writes still refuse to overwrite the broken file.
- `readConfigFile(filePath)`: Reads one config file. Missing, whitespace-only, and comment-only files return `{}`; a comment-only file is recognized by `ValueExpected` being the only parse error. A `jsonc-parser` error that produces a partial or non-object tree throws `INVALID_JSONC` — partial parse trees must never be treated as authoritative (avoids rewriting a `$schema`-only stub over a full config). Content that yields no JSON value for any other reason (YAML, plain text) also throws instead of reading as empty.
- `readConfigLayer(filePath)`: Same parse as `readConfigFile`, but isolates `INVALID_JSONC` to `{ config: {}, error }` so plugin/MCP/agent readers can skip one broken layer without aborting valid siblings. Writes still refuse to overwrite the broken file.
- `writeConfig(config, filePath)`: Writes config with automatic backup. Refuses to overwrite an existing non-empty file that fails the same JSONC parse check.
- `getJsonEntrySource(layers, sectionKind, entryName)`: Resolves which config layer provides an entry. `sectionKind` is `agents`, `commands`, `providers`, or `mcp`, and both the v2 and the v1 spelling are searched (v2 wins). The result carries `sectionKey` (the spelling that actually held the entry) and `legacy`, so a writer can rewrite the same file in v2 shape. A failed custom or user layer throws `INVALID_JSONC` instead of treating that file as empty. A failed project layer is skipped so a valid user/custom entry can still be found.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates. Throws `INVALID_JSONC` when the chosen target file is the unparseable layer.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.
- `walkSkillMdFiles(rootDir)`: Recursively finds all SKILL.md files.
- `addSkillFromMdFile(skillsMap, skillMdPath, scope, source)`: Parses and indexes a skill file.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)`, `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management.

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`
  - `POST /api/opencode/upgrade` (enforces the active runtime's upgrade capability, shares concurrent upgrade requests and runs the resolved CLI with `upgrade`; the existing Reload action restarts managed OpenCode afterwards)
  - `GET /api/opencode/upgrade-status` (returns version availability plus the authoritative `upgrade.supported`, `upgrade.manager`, and `upgrade.reason` capability)
  - `POST /api/opencode/directory` (validates and activates an existing project directory; `{ create: true }` explicitly creates the requested project directory before activation, including outside the previously active workspace)
  - `GET /api/provider/:providerId/source`
  - `PUT /api/provider` (create/update custom OpenAI-compatible provider config in OpenCode user/project/custom layers via `scope`; secrets stay in auth via the OpenCode auth API)
  - `DELETE /api/provider/:providerId/auth`
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

## Public exports (session-activity.js)
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
  - `killProcessOnPort(port)`

Managed OpenCode launch also merges the environment returned by the agent-tool
runtime and the opt-in system prompt optimizer, each appending its `file://`
entry to the previous one's config. OpenChamber adds no automatic MCP reconnect
loop; recovery after a failed connection is manual for both local and remote
servers. Previously generated reconnect plugin files are inert because managed
launch no longer registers them. User-configured plugins remain user-owned.
PATH and `OPENCODE_SERVER_PASSWORD` remain lifecycle-owned and cannot
be replaced by injected values. External OpenCode processes receive no
OpenChamber tool injection. Managed launch env strips AppImage `ARGV0` before
spawn so zsh-backed OpenCode tools do not rewrite child argv[0] to the AppImage
path (#2588).

Before spawn, `applyProviderEnvAliases` fills unset Google credential aliases
from any present sibling (`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`,
`GEMINI_API_KEY`) so a shell that only exports `GEMINI_API_KEY` still satisfies
the Generative AI SDK path used at chat time. Existing non-empty values are
never overwritten.

Set `OPENCHAMBER_STARTUP_PERF=1` to emit bounded startup phase records for server listen, managed OpenCode preparation/readiness, and proxy readiness holds. Every OpenCode bootstrap emits one terminal `opencode.bootstrap.ready` or `opencode.bootstrap.error` event, including reused and external server paths. Records contain controlled phase/outcome/route labels and timing values only; they never contain request URLs, runtime keys, directories, session IDs, credentials, or content.

macOS `say` voice enumeration starts concurrently with server composition. The server listener and managed OpenCode startup do not wait for it; `/api/tts/say/status` awaits the same authoritative capability promise when queried before enumeration completes.

Upstream health is probed with `GET /api/info` (OpenCode 2.0.8 removed `/api/health`). A 200 is the whole readiness answer — the payload is `{ version, pid, urls, paths }` and carries no `healthy` field — and its `version` is what the major-version gate reads. OpenChamber's own `/api/opencode/health` keeps answering `{ healthy }` to its clients, derived from that status.

Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

Managed health failures are classified as `timeout`, `connection_refused`, `connection_reset`, `invalid_response`, or `error`. The lifecycle retains the latest counted failure with a bounded detail string and source. Managed process wrappers continue capturing a sanitized, bounded stderr tail after readiness and retain exit code/signal. Before replacing a managed process, lifecycle snapshots the reason, latest health failure, process diagnostics/aliveness, busy-session count, and timestamp into `lastOpenCodeRestartDiagnostics`; successful startup does not clear this snapshot, and `/health` exposes it for post-restart diagnosis without process environment or credentials.

Managed process ownership starts at spawn. The registry and runtime process
handle include children that have not announced readiness yet, so shutdown can
stop an in-flight startup. Readiness timeout, malformed startup output, and
health-probe errors close that child before retrying. Shutdown cancels further
startup attempts. Closing a process is single-flight and unregisters it only
after it exits.

On Windows, managed teardown invokes the existing tree termination command
before terminating the root. Calling `child.kill()` first loses the ancestry
needed to find Git, shell, and MCP descendants. On POSIX, the managed child
starts in its own process group and teardown escalates against that group even
if the root has already exited. A tool ignoring SIGTERM must not survive just
because the server closed its own pipes. The
`lifecycle-process.test.js` regressions launch real parent/child fixtures and
check PID exit plus registry cleanup. macOS results do not validate Windows
ConPTY or Console Window Host behavior.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- OpenCode CLI resolution order is persisted settings, environment overrides, bundled Desktop CLI when available, PATH, known install locations, then platform shell discovery.
- Automatic bundled resolution under `OPENCHAMBER_RUNTIME=desktop` stays in runtime state and is returned to the managed launch function, including on OpenCode restart. It does not populate `process.env.OPENCODE_BINARY`: AppImage updater relaunch inherits that environment and would mistake the previous bundle path for an explicit override. Explicit settings/env selections and non-desktop or non-bundled resolution retain their existing environment behavior. This prevents future inheritance; it does not reinterpret overrides already inherited from older releases.
- The login-shell snapshot (`$SHELL -lic 'env -0'`) is taken synchronously at import time, so it blocks whatever process embeds the server for as long as the user's shell startup files take. An embedding host that already probed the shell hands its result over before importing the server through `login-shell-env.js` (`provideLoginShellEnvSnapshot(snapshot | null)`); the runtime then uses that and never probes, `null` included. Desktop does this on macOS and Linux; on Windows the server keeps its own registry-based snapshot. The handoff is a module slot, never an environment variable: the snapshot is the user's whole shell environment and `process.env` reaches every child.
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
- Persistent permission auto-accept policy is stored under `permissionAutoAccept`; execution ownership lives in `lib/permission-auto-accept/`.
- Queued follow-up messages live in `<data-dir>/message-queue.json`, not in settings; execution ownership lives in `lib/message-queue/`.
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarProjectSortOrder`, and `sidebarShowRecentSection`. Device-local picker selection and sticky-header state do not enter either settings file.
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
| MCP servers | `mcp.servers` | `mcp.<name>` (each layer normalized on its own, then custom > project > user; a raw merge would let a user-file `mcp.servers.<name>` shadow a project-file `mcp.<name>` override) |
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
`{ name, scope, sectionKey, legacy }`.
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
  - `GET /api/system/info`
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
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
  - `dependencies.skipBodyParsing(req)` names a request both parsers leave alone, so its body reaches its route untouched; the isolated-spaces dispatcher uses it for `/api/spaces/<id>/...`, which it streams into a space

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
  - `fetchAgentsSnapshot()`
  - `fetchProvidersSnapshot()`
  - `fetchModelsSnapshot()`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Daemon signals, `POST /api/system/shutdown`, and embedded `stop()` share one shutdown promise. Guest admission closes synchronously before any await. Cleanup stops the relay reconciliation timer, guest viewers, realtime proxy, relay host, dictation worker and session runtimes before draining guest services, including pending starts. Each cleanup is best-effort and runs once per shutdown, including after partial startup. A hard kill still requires the separate crash/SIGKILL recovery work; no persistent registry or boot reaper is provided here.
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
    - Desktop-managed hosts delegate authenticated Web update requests to the Electron main process, which checks, downloads, and applies the update through `electron-updater` before restarting the host.
    - Foreground servers running under a systemd user unit queue installation in
      a separate transient unit and restart the configured service afterwards.
      `OPENCHAMBER_SYSTEMD_UNIT` overrides the default `openchamber.service`.
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
  - `GET /manifest.webmanifest`

## Public exports (project-icon-routes.js)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`

## Public exports (skill-routes.js)
- `registerSkillRoutes(app, dependencies)`: registers skills-related routes:
  - Skills config CRUD and metadata under `/api/config/skills*`
  - Skill rename via `PATCH /api/config/skills/:name` with `{ renameTo }` (directory rename preserves `SKILL.md` body and supporting files; restricted to managed skill roots under `.opencode/skills|skill`, `.claude/skills`, and `.agents/skills`)
  - Skill list responses include authoritative `renamable` derived from the same managed-root policy used by rename
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
    - Both are sanitized to an allowlist of `SessionInfo` fields, then get archive state folded in from `lib/openchamber-sessions/archive-store.js`, because OpenCode 2.x has no archive route, plus any `metadata` entry `lib/openchamber-sessions/session-metadata-store.js` has not migrated from the legacy file yet. An unknown answer from either store leaves the upstream record untouched rather than reporting a session as un-archived or dropping its metadata.
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
creation returns, because preview paths have no bootstrap state.

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

## Storage and configuration
- Provider auth: `~/.local/share/opencode/opencode.db` table `credential` (read-only), with `auth.json` as the legacy fallback; OpenCode 2.x owns credentials.
- Session archive state: `sessions-archive.json` under the OpenChamber data dir.
- Session metadata (goal progress, the assist recap, the obligatory-context cursor, pinned notes) lives on the OpenCode session record, written with `PATCH /api/session/{id}` (OpenCode 2.0.15+, the minimum `compatibility.js` enforces). OpenCode replaces the whole object, so `sessionMetadataStore.setSessionMetadata` reads the record, applies the JSON Merge Patch and writes the result, one write per session at a time; a record that cannot be read stops the write. Every reader and writer (routes, goal loop, session assist, session knowledge, obligatory context, notifications) goes through `sessionMetadataStore.get` / `setSessionMetadata`. Older OpenChamber versions kept this state in `sessions-metadata.json` under the data dir. Its entries are the newest metadata their sessions have: the proxy lays them over OpenCode's records, a session's next write pushes its entry, and a sweep after OpenCode starts pushes the rest (a session OpenCode no longer knows is dropped, any other failure waits for the next write or start). The emptied file is renamed to `sessions-metadata.json.migrated`. Archive mutations still run one transaction at a time in the archive store.
- User config: `<config dir>/opencode.json(c)` where the config dir is `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. The v1 `config.json` is not read.
- Project config: `<workingDirectory>/.opencode/opencode.json(c)` first, else `<workingDirectory>/opencode.json(c)`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.

The behavior `GET /api/behavior/agents-md` response includes `path`, the effective
server-side filename, whether or not the file exists. Settings displays this
path without deriving a directory from the browser environment.

## Managed OpenCode config layer (managed-config-file.js)

OpenChamber injects its own OpenCode plugins through a file it owns rather than
through the process environment, because an environment variable cannot change
under a running child.

- Contract: the managed child gets `OPENCODE_CONFIG=<data-dir>/opencode.managed.json`.
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
  `agentControlToolEnabled`, `agentWebToolEnabled`, `agentMemoryToolEnabled` or
  `agentNotifyToolEnabled`
  changes. Plugin directories are written before the
  file names them, and a disabled plugin is removed from the list. OpenCode
  reloads within a couple of seconds; no restart is involved.
- Fallback: when the user's own environment already sets `OPENCODE_CONFIG`,
  OpenChamber does not take it over. It merges its plugin directories into
  `OPENCODE_CONFIG_CONTENT` instead, and those installs keep the old behavior —
  a managed-tool toggle needs an OpenCode restart to take effect.

The embedded server controller exposes `getManagedOpenCodePreflight()` for
desktop bootstrap. It shares the lifecycle's current CLI validation promise,
including while validation is in flight. It returns false before validation
starts, after failure, during shutdown, or for external OpenCode. Restart clears
the previous result, and readers discard results from a replaced preflight.
This checks CLI compatibility, not server health; the normal startup flow still
owns connection readiness. Explicit user compatibility checks remain fresh.
