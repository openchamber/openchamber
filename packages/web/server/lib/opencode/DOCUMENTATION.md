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
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). After readiness it warms the most recently used directories (`getWarmupDirectories` dep, sequential and best-effort) because OpenCode initializes each directory lazily on first request and that cost would otherwise be paid by the user's first interactive session open.
- `packages/web/server/lib/opencode/provider-env-aliases.js`: mirrors known provider credential env aliases into the managed OpenCode process environment (for example `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`) so OpenCode connection detection and the upstream AI SDK agree on the same key names. Canonical implementation shared by web lifecycle and the VS Code managed spawn path (`packages/vscode/src/provider-env-aliases.ts` re-exports this module).
- `packages/web/server/lib/guardian/process-identity.js`: shared owner/start-time/command-line process identity and authoritative liveness probes used by guardian recovery, credential-lock recovery, and CLI fallbacks. Windows discovery probes treat only `ENOENT` as absence; malformed, oversized, unsafe, permission-denied, and identity-uncertain discovery state rejects as unknown so lifecycle cannot launch a duplicate child.
- `packages/web/server/lib/guardian/file-identity.js`: shared JSON-safe transport/discovery artifact identity snapshots and comparisons; dev/ino are fenced with stable birth-time metadata (ctime fallback) and file type, failing closed when required metadata is unavailable.
- `packages/web/server/lib/guardian/host.js`: shared managed-child connect-host and origin formatting used by guardian health, adoption results, and lifecycle probes.
- `packages/web/server/lib/guardian/pid-marker.js`: ownership-aware, O_EXCL-created guardian PID marker with identity metadata, fail-closed inspection/release helpers, and a cross-process recovery lease held through replacement-marker publication. Transport identity updates use a same-directory fsynced temporary replacement; the live marker is never truncated in place, and uncertain publication retains marker authority.
- `packages/web/server/lib/opencode/managed-opencode-handoff-protocol.js`: standalone signed handoff-record protocol; it owns no process lifecycle, persistence, registry, auth-state, or runtime wiring.
- `packages/web/server/lib/opencode/managed-opencode-handoff-v2/`: isolated v2 foundation for a private master secret, SQLite record fencing, reservation/lease state, and signed owner/incarnation-bound non-idempotent lifecycle operation horizons. The guardian/lifecycle wiring is web-runtime-only; it is not a session-resume, UI, Electron, or VS Code feature. Operation fencing covers lifecycle ambiguity (spawn, stop, prepare, and abort); credential-removal cleanup has its own authenticated idempotent store contract and attention retention. A child incarnation may have several outstanding operations; each operation remains independently discoverable and attention/credentials remain retained until every unresolved operation is authoritatively resolved.
- Guardian exposes a global admission status in addition to owner-scoped operation discovery. Before any direct legacy startup or restart fallback while a guardian is running, lifecycle queries that status without filtering by owner, port, or child identity; any unresolved attention or pending/expired durable operation blocks the launch. Owner-scoped adoption remains a separate exact-identity decision.
- Guardian adoption confirmation is owner-scoped and authenticated. It rechecks the active record, credential, and health state, then uses the v2 protocol's same-record CAS to prove the complete revision/lease/MAC binding at the final decision. Credential material is returned only in the authenticated IPC response and is never persisted or included in public records.
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration with deferred-apply semantics (`restartDeferred` payloads; explicit apply via `POST /api/config/reload`).
- `packages/web/server/lib/opencode/config-mutation-response.js`: shared response builders for deferred OpenCode restarts and external manual-restart guidance.
- `packages/web/server/lib/opencode/snippets.js`: opencode-snippets-compatible snippet file CRUD, discovery, and hashtag expansion.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/terminal/process/server teardown.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/upgrade-capability.js`: authoritative upgrade ownership policy for the active OpenCode runtime. Bundled, external, and unresolved runtimes fail closed; only managed non-bundled runtimes delegate upgrades to OpenCode.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/startup-performance.js`: opt-in startup phase diagnostics with fixed labels and numeric metadata allowlists.
- `packages/web/server/lib/agent-tool/runtime.js`: managed OpenCode custom-tool materialization, environment injection, loopback authentication, and fixed CLI action dispatch.
- `packages/web/server/lib/system-prompt/runtime.js`: opt-in managed OpenCode system-prompt optimizer materialization and plugin injection.
- `packages/web/server/lib/opencode/server-utils-runtime.js`: shared server runtime utilities for OpenCode proxy wiring, OpenCode port/readiness helpers, and snapshot fetchers.
- `packages/web/server/lib/opencode/openchamber-routes.js`: OpenChamber update and models metadata route registration.
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization).
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Public exports (auth.js)
- `readAuthFile()`: Reads and parses `~/.local/share/opencode/auth.json`.
- `writeAuthFile(auth)`: Writes auth file with automatic backup.
- `removeProviderAuth(providerId)`: Removes a provider's auth entry.
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `AUTH_FILE`: Auth file path constant.
- `OPENCODE_DATA_DIR`: OpenCode data directory path constant.

## Public exports (providers.js)
- `getProviderSources(providerId, workingDirectory)`: Resolves which OpenCode config layers define a provider.
- `upsertProviderConfig(providerId, config, workingDirectory, scope?, options?)`: Validates and writes a custom OpenAI-compatible provider block (`npm`, `name`, `options.baseURL`, `models`, optional `env`/`headers`) into the user/project/custom config layer. Does not store API keys. Requires `config.env` or `options.hasStoredAuth` (auth already written via OpenCode `auth.set`). Edit flows must pass the provider's effective existing layer (`custom` > `project` > `user`) so updates do not create a global user override.
- `validateCustomProviderConfig(providerId, config, options?)`: Structural validation for custom provider payloads (id format, http(s) base URL, models, credentials via `env` or `hasStoredAuth`).
- `removeProviderConfig(providerId, workingDirectory, scope?)`: Removes a provider block from the selected config layer.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`: Path constants. `OPENCODE_CONFIG` is resolved at call time for the custom config layer path.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom). `readConfigLayers` isolates `INVALID_JSONC` per layer: a broken file is omitted from the merge (`{}` for that layer only), recorded on `layerErrors`, and does not block valid sibling layers. Writes still refuse to overwrite the broken file.
- `readConfigFile(filePath)`: Reads one config file. Missing, whitespace-only, and comment-only files return `{}`; a comment-only file is recognized by `ValueExpected` being the only parse error. A `jsonc-parser` error that produces a partial or non-object tree throws `INVALID_JSONC` — partial parse trees must never be treated as authoritative (avoids rewriting a `$schema`-only stub over a full config). Content that yields no JSON value for any other reason (YAML, plain text) also throws instead of reading as empty.
- `readConfigLayer(filePath)`: Same parse as `readConfigFile`, but isolates `INVALID_JSONC` to `{ config: {}, error }` so plugin/MCP/agent readers can skip one broken layer without aborting valid siblings. Writes still refuse to overwrite the broken file.
- `writeConfig(config, filePath)`: Writes config with automatic backup. Refuses to overwrite an existing non-empty file that fails the same JSONC parse check.
- `getJsonEntrySource(layers, sectionKey, entryName)`: Resolves which config layer provides an entry. A failed custom or user layer throws `INVALID_JSONC` instead of treating that file as empty. A failed project layer is skipped so a valid user/custom entry can still be found.
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
  - `POST /api/opencode/upgrade` (enforces the active runtime's upgrade capability, serializes supported OpenCode upgrades, then restarts managed OpenCode so the new binary is active)
  - `GET /api/opencode/upgrade-status` (returns version availability plus the authoritative `upgrade.supported`, `upgrade.manager`, and `upgrade.reason` capability)
  - `POST /api/opencode/directory` (validates and activates an existing project directory; `{ create: true }` explicitly creates the requested project directory before activation, including outside the previously active workspace)
  - `GET /api/provider/:providerId/source`
  - `PUT /api/provider` (create/update custom OpenAI-compatible provider config in OpenCode user/project/custom layers via `scope`; secrets stay in auth via the OpenCode auth API)
  - `DELETE /api/provider/:providerId/auth`
- Owns lazy auth library loading for provider auth checks/removal.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.

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
  - `resetForOpenCodeReplacement()` (clears volatile live status/activity/attention state at an OpenCode incarnation boundary; does not touch durable session or message data)
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
runtime. PATH and `OPENCODE_SERVER_PASSWORD` remain lifecycle-owned and cannot
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

Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

Managed health failures are classified as `timeout`, `connection_refused`, `connection_reset`, `invalid_response`, or `error`. The lifecycle retains the latest counted failure with a bounded detail string and source. Managed process wrappers continue capturing a sanitized, bounded stderr tail after readiness and retain exit code/signal. Before replacing a managed process, lifecycle snapshots the reason, latest health failure, process diagnostics/aliveness, busy-session count, and timestamp into `lastOpenCodeRestartDiagnostics`; successful startup does not clear this snapshot, and `/health` exposes it for post-restart diagnosis without process environment or credentials.
OpenChamber tool injection. Bounded startup stdout/stderr diagnostics redact
managed password, token, and Basic-auth material before capture truncation;
both labeled pipes share one bounded, match-aware overlap so a candidate split
across stdout and stderr cannot be reconstructed, and the redactor never emits
a raw candidate prefix that could be completed by a later chunk. Launch
credentials are held in explicit leases while the associated child/output
streams or uncertain cleanup remain possible sources; confirmed child and pipe
cleanup retires the lease so repeated rotation does not accumulate secrets for
the web-runtime lifetime. URL discovery continues to parse only the separately
bounded raw stdout prefix and never logs the launch environment. Malformed URL
diagnostics omit the raw startup line entirely.

## Public exports (managed-opencode-handoff-protocol.js)
- `createManagedOpenCodeHandoffProtocol(dependencies)`: creates the isolated phase-1 handoff protocol.
- `ManagedOpenCodeHandoffState`: state names: `launch-prepared`, `active`, `handoff-prepared`, `claimed`, `stopping`, and terminal `retired`.
- `MANAGED_OPENCODE_HANDOFF_ALLOWED_TRANSITIONS`: the only permitted state edges. `handoff-prepared -> claimed` is available only through `claim()`.
- `canonicalizeManagedOpenCodeHandoffRecord(record)`: fixed-order authority-field encoding used by the record MAC.

### Managed OpenCode handoff protocol scope and invariants
- Records are strict version-1 schemas. Unknown fields, malformed values, MAC failures, mismatched record keys, and expired records fail closed; none are interpreted as an absent or reusable child record. A valid terminal record remains readable/verifiable until expiry, but has no legal outgoing transition.
- The injected binary master secret must come from a dedicated stable master-secret provider, independent of managed OpenCode auth-state/password persistence, and be at least 32 bytes. The module neither generates, persists, logs, returns, nor otherwise exposes that secret or a raw derived child credential.
- Each `prepareLaunch()` call creates a random child incarnation, derives a child credential and a separate record-MAC key with HKDF-SHA-256 domain separation, records only the credential fingerprint, and authenticates every authority-bearing field with a timing-safe verified MAC over fixed-order bytes.
- `claim()` requires both injected process and authenticated-health verifiers to attest to the same signed PID, port, incarnation, and fingerprint before it attempts a compare-and-swap. Verifiers receive only that identity object, never master, child, or claim secrets.
- A claimant supplies a high-entropy raw `claimCapability` to `claim()` and retains it locally. The signed record persists only a separately keyed capability digest; public records and `readRecord()` expose neither the raw capability nor its digest. Claimed-state mutations require the correct claimant, raw capability, current revision, and exact child identity.
- Storage is injected as `store.read({ incarnation })` and an actually cross-process atomic `store.compareAndSwap({ incarnation, expected, next, requireUnexpired })`. At write time the CAS implementation must atomically compare the expected revision/MAC/expiry and evaluate `requireUnexpired.expiresAt` against its authoritative clock. It must return exactly `{ status: 'applied' }`, `{ status: 'conflict' }`, or `{ status: 'expired' }`; any other result fails closed. The store/CAS provider is the fencing and expiry trust boundary—this module intentionally does not treat an in-memory `Map` or promise queue as cross-process atomicity.
- This phase intentionally does **not** wire lifecycle/Electron/VS Code behavior, alter `managed-process-registry.js`, persist or generate auth state, change shutdown/UI behavior, add an admission journal, or implement V2 resume.

## Public exports (managed-opencode-handoff-v2/)
- `createManagedOpenCodeHandoffV2SecretProvider({ rootDir?, platform? })`: owns a v2-only 32-byte local master secret in closure. It exposes record-MAC and domain-separated managed-credential encryption-key derivation, a public credential fingerprint, and opaque one-shot lifecycle credential callbacks; it never accepts JWTs, user passwords, OpenCode server passwords, HMR state, CLI arguments, or environment overrides as secret input. Returned derived key buffers remain caller-owned and must be zeroed after use.
- `createManagedOpenCodeCredentialStore({ rootDir?, secretProvider, platform?, username?, aclInspector?, reparseChecker?, processIdentity?, processLiveness? })`: stores one authenticated-encrypted managed OpenCode username/password record per incarnation under the private v2 root. Its `create()`, `read()`, and `remove()` APIs bind records to the exact incarnation, owner/runtime/launch identity, and v2 credential fingerprint; a per-incarnation cross-process operation fence writes a versioned `{ pid, processStartTicks, identity, token }` owner payload immediately after `O_EXCL` creation, reclaims an existing lock only after authoritative owner death or identity mismatch, and fails closed for malformed, ambiguous, or live locks. Same-store operations queue, while a concurrent cross-store operation fails closed rather than racing the active fence. Lock and credential cleanup use identity-fenced quarantine/removal, retaining recovery artifacts when replacement or cleanup certainty is unavailable. A transient post-link directory-fsync failure retries durability without publishing a second file, then verifies the same target file identity and durable existence before returning `created: true`. A concurrent removal/replacement therefore remains an error. Persistent failure remains recoverable through authenticated idempotent removal. Missing removal is confirmed only after the credential directory's durable absence and recovery-artifact cleanup are rechecked; corrupt, tampered, or failed removal state remains an error. Raw credentials never enter SQLite, JSON, public records, list responses, or logs.
- `createManagedOpenCodeHandoffV2Store({ rootDir?, busyTimeoutMs? })`: opens the separate v2 SQLite database and exposes async `read()`, `list()`, `compareAndSwap()`, signed operation `readOperation()`/`compareAndSwapOperation()`/`listOperations()`, `hasV2Records()`, `cleanup()`, and `close()` operations. Store schema `2421009` adds the private operation table through the record-only `2421007` migration and an in-place `2421008` operation-table rebuild; malformed rows, MAC-corrupt operations, failed table/index creation, or unexpected objects fail closed and migrations roll back transactionally. Pending and expired operation rows remain durable and discoverable until an exact signed resolution succeeds. Resolved operation rows are retained signed tombstones after their confirmation horizon, so pruning a terminal child row cannot turn authoritative resolution into ordinary absence; unresolved operation rows also protect their terminal child row from pruning, so no horizon permits replay. The store uses WAL, FULL synchronous mode, a busy timeout, exact schema validation, POSIX parent-directory fsync, and `BEGIN IMMEDIATE` fencing with SQLite's transaction-time clock. Windows uses the ACL-protected root and skips only the POSIX directory-fsync primitive; shared Windows validation rejects reparse points in the target and every existing ancestor, plus ACLs with unapproved or unsafe access. Its renewal callback form creates a signed next record from that transaction-time clock.
- `createManagedOpenCodeHandoffV2Protocol({ secretProvider, store, now?, defaultLeaseMs? })`: returns `reserveLaunch()`, fenced `beginLaunch({ incarnation, expectedRevision, withCredential })`, `bindSpawnedProcess()`, bounded `renewLease()`, signed `createOperation()`/`readOperation()`/`listOperations()`/`resolveOperation()`/`expireOperation()`/`confirmOperation()`, `prepareHandoff()`, `confirmRecord()` (same-record authoritative CAS, including explicitly permitted terminal recovery reads), read/verify helpers, and explicit interruption/stopping/retirement transitions. Operation MACs cover the operation kind, owner tuple, incarnation, target binding, resolution binding, revision, and confirmation horizon. Expiry only changes a pending row to an expired unresolved state; clearing that state requires guardian-authoritative quiescence plus exact owner/incarnation/revision/lease/MAC-bound signed target or terminal evidence and operation CAS. Resolved operation tombstones remain owner/incarnation/binding-bound and are the only post-pruning proof of resolution; wrong binding, read failure, and ordinary absence remain blocked. Credential-removal cleanup remains governed by the credential store's authenticated idempotent removal/absence contract and retained attention, rather than this lifecycle ambiguity table; no secret material enters the operation table.
- Guardian operation-linked attention distinguishes an absent child row from a read failure and retains either outcome without falling through to missing-record cleanup. Stop, unexpected-exit, and ambiguous-operation paths terminalize the signed child row before releasing encrypted credential-store material; pending/expired operation handles retain both attention and credentials until authoritative quiescence and operation CAS resolution succeeds.
- HMR reconciliation never treats an in-memory fence as a complete discovery result: it always lists the complete owner-scoped pending/expired durable-operation set, merges missing operation IDs into the transferred fence set, and keeps every unresolved operation blocking. Initial-spawn terminal cleanup binds the fence before use and confirms the exact signed terminal operation before releasing its startup-secret lease. Persisted durable terminal fences must match the operation's owner/incarnation and target or resolution revision/lease/MAC binding; stale or replaced bindings remain fenced. Failed begin-stopping, prepare-handoff, or abort-handoff transitions retain their persisted operation in guardian attention so admission remains blocked across restart.
- `ManagedOpenCodeHandoffV2State` and `MANAGED_OPENCODE_HANDOFF_V2_ALLOWED_TRANSITIONS`: v2 state names and the full future graph: `reserved -> launch-delivering -> launching -> active -> handoff-prepared -> claimed -> active`, with explicit `interrupted`, `stopping`, and `retired` rules.

### Managed credential health proof

Before a guardian health probe sends a managed OpenCode `Authorization: Basic`
header, it opens one HTTP connection and sends an unauthenticated
`/global/health` challenge containing the incarnation, owner/runtime identity,
launch fingerprint, and port. A proof-capable managed child must return
`healthy: true` plus an HMAC-SHA-256 proof keyed by its managed password. The
guardian verifies that proof and sends Basic Auth only on the exact same
connection; it never reconnects between proof and credential delivery. A
missing, malformed, rejected, replaced, or non-reusable proof connection fails
closed and never sends Basic Auth. Password-free normal launches keep the
existing health probe without this credential gate.

This is the strongest proof available at the current boundary, but it is not
cryptographic OS process attestation: a stock OpenCode server does not implement
the OpenChamber challenge/proof contract, and loopback HTTP cannot distinguish a
same-user proxy that relays a valid response. Consequently, a stock or custom
managed runtime that does not implement the contract is not eligible for a
credential-bearing guardian health probe; it fails closed before Basic Auth is
sent. `scripts/guardian-test-opencode.js` is the reference password-protected
fixture and enforces the connection-bound contract. Adding native OpenCode
support or a process-bound transport is a separate protocol/runtime change.

### Managed OpenCode handoff v2 Phase-2A scope and invariants
- The v2 root defaults to `~/.local/state/openchamber/managed-opencode-handoff-v2/`; POSIX uses a private (`0700`) root and regular owner-only (`0600`) `master-secret.bin`/evidence files, while Windows uses the per-user ACL trust boundary. Evidence is atomically published before first secret creation, so concurrent initializers converge. A missing/corrupt secret after evidence **or a secret without evidence** fails closed and is never repaired by backfilling evidence. Deleting the root (or both the evidence and secret) destroys that evidence and is the unavoidable fresh-initialization boundary.
- The raw master remains in the provider closure. Derived record-MAC keys and one-shot lifecycle credentials are zeroed after use. `beginLaunch()` arms opaque material before it atomically moves `reserved -> launch-delivering`; only the owner may complete that short-lived fenced state to `launching`. Public terminal transitions are rejected while delivery is fenced, and pre-callback authority checks revoke material on expiry, callback failure, or a lost fence. Raw credentials never appear in public records, SQLite rows, diagnostics, or logs.
- SQLite records hold only version/state, random incarnation, credential fingerprint, optional post-spawn process identity, lease/revision, and MAC fields. Process start ticks use canonical decimal text so Windows `DateTime.Ticks` values remain lossless through SQLite and record-MAC comparisons. The store requires its exact strict table, primary-key/index layout, checks, metadata, and absence of triggers/views; user objects whose names merely resemble SQLite internals are still rejected. Malformed, corrupt, or under-constrained schema blocks use rather than becoming an absent/free record. POSIX parent-directory fsync failure is fatal; Windows skips only that POSIX-only durability operation while retaining ACL enforcement. Cleanup removes only expired terminal (`interrupted`/`retired`) records that have no pending/expired operation and removes operation rows only after resolved confirmation. Expired unresolved operations remain durable and discoverable; guardian recovery can clear them only after authoritative quiescence and exact binding/CAS confirmation. Credential-removal cleanup is separately retained by guardian attention until the credential store confirms authenticated removal/absence. The database is separate from `managed-process-registry.js`, so legacy web/VS Code reapers cannot parse or reap v2 state.
- Phase 2A implements reservation, fenced material delivery, `reserved -> launch-delivering -> launching -> active` identity binding, bounded active lease renewal from SQLite transaction time, interruption, stopping, and retirement. Guardian/lifecycle wiring adds stable owner identity and launch-spec fields without persisting raw environment secrets or session state.

## Phase 2B/3 — Guardian Process Lifecycle Integration

> Phase 2D (`Phase 2D — Cross-platform guardian (Windows support via T2)`) extended the IPC helpers to accept `(socketPath, portPath?)` and dispatched per platform via `createIpcServer` / `createIpcDialer`. This Phase 2C section describes the original cross-cutting helpers; the current per-platform behavior is documented in the Phase 2D section.

### Architecture
- A standalone **guardian process** (`openchamber-guardian.js`) outlives the web server and manages OpenCode child processes via the Phase 2A v2 durable protocol.
- POSIX uses a `0600` Unix-domain socket; Windows uses loopback TCP plus an ACL-protected discovery file. Both transports carry the same authenticated JSON-line protocol.
- Web server integration is owner-scoped. The guardian service may outlive the web server; ordinary shutdown and `SIGTERM` stop only this instance's OpenCode child, while the explicit `openchamber restart` command requests a restart and may hand off to a live guardian child. `openchamber guardian stop` is the administrative service shutdown.

### Detection module (`guardian/detection.js`)
- `isGuardianRunning(socketPath, portPath?)`: Probes the platform-specific guardian transport with a 100ms connect timeout.
- `detectAndAdoptGuardianChild(socketPath, portPath?, { expectedOwner, restoreCredential })`: Authenticates via `GuardianClient`, rejects ownerless, incomplete, unhealthy, ambiguous, or attention-state records, requires complete revision/lease/MAC binding, invokes the guardian's authoritative owner-scoped adoption confirmation (including final credential/health revalidation and v2 CAS), uses a supplied launch fingerprint to disambiguate otherwise identical owner/runtime records, invokes the owning auth-state restore callback, and returns only the matching `{ incarnation, pid, port, url, owner, launchSpec }` or `null` (never raw credentials).
- `getGuardianSocketPath(rootDir?)`: Returns the deterministic socket label; Windows transport selection uses the sibling discovery-file path.
- Custom data-directory, socket, and discovery-file inputs are normalized through `resolveGuardianPaths`; an explicit data root remains authoritative for the IPC auth secret, while a transport-only override derives its secret from that custom transport root rather than the process's default environment paths.

### Lifecycle integration (`lifecycle.js`)

**`bootstrapOpenCodeAtStartup()`**
- After orphan reaping and HMR state check, resolves the OpenCode ownership mode using a single normalized decision (`ownsManagedLocalOpenCode`, derived from `ENV_SKIP_OPENCODE_START`). The branch order is intentional and load-bearing:
   1. Explicit external/skip-start mode (`OPENCODE_SKIP_START` / `OPENCHAMBER_SKIP_OPENCODE_START` with an effective port) wins first. This is an operator decision that this OpenChamber instance does NOT own a managed local OpenCode; the configured external OpenCode is used as requested, no guardian adoption occurs, and the running guardian (possibly a separate service) is NOT shut down.
   2. Auto-detected external OpenCode on the effective port is tried next.
   3. Only when this instance owns managed local OpenCode does guardian adoption run. Requires the stable `OPENCHAMBER_GUARDIAN_OWNER_ID` supplied by the CLI. If a guardian child is found:
    - Sets a closeable guardian proxy, `state.openCodePort`, `state.isOpenCodeReady`, `state.currentIncarnation`, and the exact owner identity.
    - Retrieves the child credential through the exact owner/incarnation guardian RPC and restores it through `auth-state-runtime.js`; the raw value is not returned in adoption records, lists, or logs.
    - Skips spawning a new child process
   - Reordering rationale: a previously-running guardian may still hold a child matching persisted owner metadata even when this instance selected external mode. Adopting it would couple the lifecycle to a process the operator explicitly declined to manage. The skip-start/external branches must decline before `detectAndAdoptGuardianChild` is ever called.
- If the guardian is running but has no child, performs the initial managed spawn through the guardian. If that live guardian launch fails, lifecycle records an explicit error and refuses a legacy spawn; direct startup is allowed only when the guardian probe was false or guardian use was explicitly disabled.
- A rejected guardian-running probe is treated as unknown, not as `false`; startup/restart record the probe failure and refuse a legacy lifecycle spawn beside an uncertain guardian.
- Guardian startup requires a successful recovery-store `list()` before publishing IPC. A list failure aborts startup and leaves no healthy endpoint. Before transport bind, a prior guardian's POSIX socket or Windows discovery lock/temp/final artifacts may be removed only when the O_EXCL PID marker has a complete identity and its recorded process is authoritatively dead; stale-marker recovery holds a cross-process lease until the replacement marker is published, and Windows cleanup revalidates existing ancestors, ACLs, reparse points, and file identity before unlinking explicit transport paths. Strict Windows recovery propagates a replaced or identity-uncertain final discovery artifact, so the stale marker remains the authority and acquisition cannot claim `{ recovered: true }`; normal close remains idempotent and never unlinks a new transport. Legacy, live, PID-reused, or ambiguous markers leave startup blocked. Transport close also removes only the socket inode or discovery port that the current listener published. Administrative stop keeps the authenticated IPC service and durable `stopping` child records available when termination fails, so the operation can be retried instead of hiding a live child. If startup rollback cannot clean the transport, the guardian retains its IPC/store ownership and marker for a later stop retry rather than invoking `onStopped`. Lease expiry never deletes an unresolved `stopping` or `handoff-prepared` record; rehydration verifies those records through the explicit recovery path, retains a live child, or surfaces typed attention until liveness/termination is authoritative. Timeout, connection, 5xx, malformed, and unhealthy responses are recoverable health attention; credential rejection, credential unavailability, identity uncertainty, and confirmed death are distinct recovery conditions. Confirmed-dead active, expired-handoff, and stopping paths durably/idempotently remove credentials before terminal transitions. `reserved`, `launch-delivering`, and `launching` records without a durable process identity become attention records that block conflicting launch rather than being silently discarded. Guardian launch, stop, handoff, abort, reload, and shutdown mutations share one serialized queue; read-only list and health requests remain unqueued.
- Authenticated guardian IPC exposes `credential({ incarnation, owner })` through `GuardianClient.credential()`. It requires the exact owner/runtime/launch tuple and incarnation, never permits an administrative bypass, and returns no credential material from `list()`. External health RPCs require that same complete owner/incarnation identity; only direct internal timer probes may use the narrower `healthCheck({ incarnation })` call. Credential operations serialize per incarnation, fence removal by file identity, and verify durable absence after directory fsync. JSON-line frames are bounded inclusively before parsing and before every client/server write; the client checks the newline-inclusive size before outbound writes and parses coalesced frames independently.

- Startup rollback ownership: when transport/store cleanup succeeds after an initial guardian startup error with no unresolved attention records, `start()` settles the guardian stopped so the standalone entrypoint may release its marker. Live, identity-uncertain, health, and credential attention records are durable ownership blockers even when no child was attached; rollback and normal `stop()` retain the guardian IPC/store authority and marker, return `GUARDIAN_CLEANUP_UNCERTAIN`, and defer `onStopped` until the record is resolved or retired. If recovered child ownership, transport cleanup, or store cleanup remains uncertain, the guardian and marker stay retryable and `onStopped` is deferred.
- Direct lifecycle startup registers a spawned detached child before readiness output is parsed and unregisters it only after confirmed exit. If SIGTERM/SIGKILL or the Windows escalation path cannot prove exit, lifecycle throws `OPENCODE_CHILD_STILL_RUNNING`, destroys stdout/stderr pipes, retains registry recovery state, and does not retry beside the live child.
- A verified-dead pre-ready guardian marker may recover without `transportIdentity` only when both POSIX public/owner paths and their quarantine sidecars are absent. Any artifact without persisted identity retains the marker and fails closed. Marker release and recovery-lease cleanup use identity-fenced quarantine removal, so a replacement pathname or uncertain cleanup is retained.
- If an unannounced helper cleanup returns anything other than proven `removed` or `absent`, the helper reports cleanup uncertainty with its identity/quarantine tracking. The parent retains transport authority and retries the same hidden `.remove` artifacts; it never treats a discarded helper result as successful cleanup.
- POSIX helper callbacks carry a per-listen generation fence. Messages, errors, disconnects, and exits from an old helper cannot mutate a relistened transport; late forwarded sockets are destroyed while closing or when their generation is stale.
- POSIX guardian listen forks `guardian/ipc-listener-helper.js`. The helper applies umask `077`, binds the `0600` Unix socket, validates the bound listener descriptor (`fstat(listener._handle.fd)`) as a socket, and holds a descriptor-backed filesystem identity for the bound pathname (Linux `O_PATH`) before publishing a deterministic same-directory `<socketPath>.owner` hard link with no-clobber (`O_EXCL`-equivalent) semantics. It sends the handle-backed identity for the descriptor, public path, and owner-alias path and forwards accepted `net.Socket` handles to the guardian parent over Node IPC; it receives no auth secret or credential material and emits no diagnostics. The parent resolves listen only after all handle/path identities are present, same-inode, owner-only, and equal through the shared metadata-aware comparator, while `GuardianIpcServer` continues to own authentication, frame limits, request ordering, and socket parsing. A verified POSIX transport identity is same-inode descriptor-fenced onto the guardian PID marker under its current token before startup is considered ready. Close sets a closing fence before stopping the helper, destroys late/queued handles, drains parent IPC messages, waits for helper exit (using the child process handle for a bounded kill fallback), and only then identity-removes both paths. Before ready is announced, a helper shutdown/disconnect performs best-effort identity-fenced cleanup of only its descriptor-backed paths; a replacement is preserved. After ready, the parent owns cleanup and the helper never calls `server.close()` or unlinks either pathname. Helper crash, startup/identity failure, replacement, missing alias/public path, or cleanup uncertainty preserves marker/transport authority; if ready was never verified, close never captures a currently matching pair as ownership. Stale recovery requires the persisted public/owner identities and compares both artifacts against them before removal; old markers, missing identity, and replacement pairs fail closed. The standalone guardian releases its PID marker only from verified startup rollback or the successful `onStopped` callback, never from an unexpected process exit.

- After ready, the POSIX helper retains its Linux `O_PATH` descriptor through shutdown. Its `closed` handoff includes the descriptor-backed identity and is accepted by the parent only when both current pathnames still match that held object and the previously published object identity; a replacement pair is retained for explicit recovery rather than adopted as cleanup authority. Non-Linux POSIX uses the owner pathname and the same actual-listener probe/handle fence because it has no Linux `O_PATH` equivalent.
- POSIX startup readiness uses a two-phase acknowledged handle fence: after publication and an actual-listener probe, the helper transfers one accepted probe socket with a random publication token as a candidate. The parent validates the helper-issued marker on that held handle, corroborates the public/owner pathnames, and sends acceptance. The helper re-probes and sends the final tokened `ready` frame; the parent acknowledges over the held handle, the helper re-probes again, and emits a commit marker. The parent then identity-corrobates the committed proof against both current pathnames, sends a bounded commit acknowledgement, and waits for the helper's post-acknowledgement re-probe confirmation before corroborating the pair once more. Only that final helper-proof/parent-corroboration exchange resolves `listen()`. The token is destroyed deterministically on commit, confirmation, or failure; pathname checks remain identity-safe and are never timing delays or unbounded waits. Pair cleanup and rollback likewise refresh a surviving hard link only after its object identity matches the prior descriptor/proof identity, so ctime-only mutations cannot authorize a different sibling.

**`restartOpenCode()`**
- External/skip-start mode short-circuits before any guardian handoff: if `state.isExternalOpenCode` is true, restart only re-probes the external server's health. A normalized `ownsManagedLocalOpenCode()` guard also blocks the handoff/legacy-spawn section, so an explicit external configuration never performs guardian handoff or managed spawn even if invoked before bootstrap set the external flag. The running guardian is NOT shut down in external mode.
- Before stopping the existing child, checks if the guardian is running on the current platform.
   - If the in-memory incarnation is missing, first queries/adopts the exact stable-owner child. Multiple, ownerless, unhealthy, or unavailable records fail closed rather than selecting a list entry.
   - Restart adoption restores the exact guardian credential before the child is marked ready, so proxy and readiness requests use the adopted auth state.
- If guardian is running:
  1. Connects via `GuardianClient`
  2. Prepares handoff for current incarnation via `client.prepareHandoff()`
  3. Spawns successor via `client.spawn()`
   4. Waits for successor health via the owner-scoped GuardianClient proof check
  5. Stops old child via owner-checked `client.stop()`
  6. Updates `state.openCodeProcess`, `state.openCodePort`, `state.currentIncarnation`, and owner identity
- Dynamic-port handoff starts and health-checks the successor before stopping the old child. Fixed-port handoff stops the old child and waits for port release before spawning the successor.
- Legacy fallback is allowed only when the old child was not stopped, abort/health rollback restores it to active, and the exact owner can be stopped before the legacy spawn. Durable `stopping`, `unknown`, and `attention` records are unresolved blockers until the authenticated guardian retires or otherwise resolves them. Once a guardian has been observed, an authoritative no-exact-owner result never triggers a port-wide kill; lifecycle only uses the legacy port cleanup when the guardian was unavailable. If cleanup or ownership is uncertain, lifecycle fails closed instead of creating a second child.
- An ambiguous `prepareHandoff` or `spawn` response persists an owner/incarnation-scoped outcome-unknown fence containing the public handoff revision/lease/MAC binding and successor owner/launch identity when known. Initial guardian spawn, HMR restoration, bootstrap, restart, and direct lifecycle start all consult the same fence before any stop, spawn, rollback, retry, or legacy fallback. A delayed or absent successor leaves the fence unresolved; only authenticated owner-scoped reconciliation with complete revision, lease, and MAC binding may adopt a successor or return the old child to active. Missing or mismatched binding, owner, or incarnation remains fenced. Guardian MAC and lease validation remains authoritative inside the v2 record protocol.
- Every non-idempotent cleanup RPC in these paths is covered by the same fence, including owner-scoped `stop` and `abort-handoff`. A response that may have been lost after the side effect crossed its boundary persists the target owner/incarnation and operation binding; lifecycle performs no duplicate cleanup, rollback, retry, or legacy fallback until authoritative reconciliation proves the exact terminal or post-transition record. Adoption delegates the final credential/health revalidation and same-record CAS to guardian-side `confirmAdoption()`, while an ambiguous stop queries the signed terminal record through `terminalStatus()` and closes it through owner/binding-checked `confirmTerminal()` even after the child leaves the guardian's live-child map. Missing or mismatched owner, incarnation, revision, lease, or MAC remains fenced.
- A successful owner-scoped stop response followed by a stale, malformed, or failed list verification is also unresolved: lifecycle persists the durable stop operation/fence, retains the startup-secret lease, and never replays stop. The fence clears only through guardian-authoritative terminal/quiescence confirmation (or a fresh authenticated empty result in the legacy client compatibility path); ordinary absence or read failure is not success.
- Terminal `Interrupted`/`Retired` transitions renew the signed record lease from authoritative store time for a bounded confirmation horizon, so expiry/pruning cannot erase the H5 terminal handle immediately after a lost stop response. Cleanup may prune that row only after the retained horizon; lifecycle releases the associated startup-secret redaction lease only after exact terminal confirmation or safe expiry/cleanup of the complete fence binding. A missing row before that horizon remains fail-closed, and no stop/abort RPC is replayed.
- The managed startup-secret lease is associated with the in-memory/HMR ambiguity fence without persisting plaintext secret material. Initial guardian spawn and direct owner-scoped stop retain that lease while the side-effect outcome is unresolved; adoption or exact terminal confirmation transfers/releases it, while an unresolved fence keeps it active for diagnostics redaction.
- Reserved attention that terminalizes before credential removal succeeds retains both the durable attention record and encrypted credential. Its bounded same-process retry is re-armed at the guardian timer boundary and remains scheduled through Interrupted/Retired cleanup failures; restart is not required to make H3 progress.
- For stop, unexpected-exit, and ambiguous-operation recovery, credential cleanup is attempted only after terminal record CAS and durable operation resolution. A failed read or CAS retains the operation-linked attention and encrypted credential for restart/rehydration rather than treating absence as success.
- Lifecycle cleanup and fallback verification treat a present non-array or malformed authenticated child list as `GUARDIAN_CHILD_LIST_INVALID`; only clients that genuinely do not expose `list()` retain the compatibility path that skips list verification.
- If a managed password was rotated while a rollback-capable old child was still running, confirmed rollback restores the previous auth state before the old child is made ready again.
- Failed successor cleanup is verified through the guardian record list when available; a failed guardian disconnect also fails closed. The previous owner/reference is restored when the old child was not confirmed stopped.
- When a non-ambiguous successor spawn fails after the old child is confirmed stopped, lifecycle requires a fresh authenticated empty successor list and no matching pending/expired operation or ambiguity fence before releasing that launch's startup-secret lease. An absent/unreadable successor result remains retained and does not release the lease.

### CLI changes
- `packages/web/bin/lib/cli-args.js`: Added `--handoff` flag parsing.
- `packages/web/bin/lib/commands-lifecycle.js`: `restart` command passes `handoff: options.handoff === true` to `runServe()` so the server knows to prefer guardian handoff.

### State tracking
- `state.currentIncarnation` is tracked in the lifecycle state object when a guardian-managed child is adopted or spawned through handoff. This is optional and additive — existing fields are unchanged.

### Platform constraints
- POSIX and Windows use separate transport backends, but share owner validation, authenticated IPC, durable records, and lifecycle sequencing. POSIX recovery requires revalidation of the persisted process-start and launch identity; an unavailable or mismatched identity is an attention condition rather than a PID-only adoption. Rehydrated children repeat that check before health probes, after a port-based health response and immediately before adoption/healthy state, and immediately before each POSIX signal, while normal live `ChildProcess` instances retain their existing signaling behavior.
- Guardian launch validation accepts direct OpenCode native/node/bun targets and only the resolver's Windows batch-shim shape: `cmd.exe` (or the resolved ComSpec basename) with exactly `/d /s /c call <absolute opencode*.cmd|.bat target>`. The guardian appends `serve --hostname ... --port ...` after that target; arbitrary cmd commands, shell operators, and unrelated batch files are rejected.
- Windows process identity and rehydrated termination share the `process-identity.js` resolver for absolute `%SystemRoot%`-derived system-tool paths (`powershell.exe`, `icacls.exe`, and `whoami.exe`), with the fixed `C:\Windows` root only as a fallback when `SystemRoot` is unavailable or malformed. All PowerShell probes, ACL commands, and current-user queries pass those executables as argv values with shell execution disabled; they never use PATH lookup or current-directory resolution.
- Windows process rehydration uses bounded hidden PowerShell queries for start-time, command-line, and owner identity. Start-time query failures, PID reuse, and unavailable command-line identity are rejected rather than adopted ambiguously. The supported `Win32_Process` query does not provide a reliable working directory, so launch identity intentionally keeps `cwd: null`; guardian recovery validates the available identity fields and does not infer `cwd`. Live children terminate through their Node process handles. Rehydrated children use the hidden PowerShell/.NET handle terminator, which opens and retains one process handle, rechecks the persisted start-time and exact normalized command identity (including `serve`, hostname, and port), and terminates that handle; if the helper is unavailable, guardian termination fails closed and never falls back to PID-only `taskkill.exe`. Helper diagnostics are bounded and sanitized without credential material. Native Windows execution remains a CI evidence requirement.
- Other runtimes do not attach to the web guardian; they continue using their existing runtime boundaries.

## Phase 2C — Launch wiring

### CLI surface
- New subcommand: `openchamber guardian {status | start | stop | reload}` (default: `status`).
  Implemented in `packages/web/bin/lib/commands-guardian.js` and dispatched
  from `packages/web/bin/cli.js` next to `startup`. The subcommand honors
  `--json` / `--quiet` / non-TTY parity via the same `cli-output.js` helpers
  the other subcommands use.
- Two new serve-time flags next to `--handoff` / `--no-handoff`:
  - `--guardian` (default) — auto-start the guardian when `serve` boots.
  - `--no-guardian` — skip the autostart; rely on an out-of-band guardian
    the operator started themselves.
- New environment variable: `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled`
  disables autostart without changing CLI flags (mirrors the
  `OPENCHAMBER_RESTART_HANDOFF` opt-out).
- New `bin` entry: `openchamber-guardian -> ./bin/openchamber-guardian.js`
  in `packages/web/package.json`, so Linux packaging and
  `openchamber guardian` autostart use the same entrypoint.

### Autostart in `serve` (foreground + daemon)
- `commands-serve.js` imports `maybeAutoStartGuardian` from
  `commands-guardian.js` and calls it in both code paths, before the
  foreground server is imported inline and before the daemon-mode
  `spawn(runtimeBin, serverArgs, …)`.
- `maybeAutoStartGuardian` is a no-op when any of these are true:
   - `options.guardian === false` (i.e. `--no-guardian`)
   - `options.handoff === false` (the user has already opted out of the
     entire guardian branch)
   - `process.env.OPENCHAMBER_GUARDIAN_AUTOSTART === 'disabled'`
   - Explicit external/skip-start mode: `OPENCODE_SKIP_START=true` or
     `OPENCHAMBER_SKIP_OPENCODE_START=true`. This is an operator decision
     that this OpenChamber instance does NOT own a managed local OpenCode,
     so the guardian is not autostarted merely for OpenCode ownership. A
     previously-running guardian (possibly a separate service) is left
     untouched. The CLI derives this from the env flags at the CLI boundary
     (`isSkipStartConfigured` in `commands-guardian.js`); the server side
     normalizes the same decision as `ownsManagedLocalOpenCode()` in
     `server/index.js`.
- When the gate passes, the helper probes the platform-specific guardian
  transport via `isGuardianRunning(socketPath, portPath)`. If a guardian
  is already running, it logs `guardian already running (pid N)` and
  continues. Otherwise it spawns `bin/openchamber-guardian.js` with
  `detached: true` + `stdio: ['ignore', logFd, logFd]`, `unref()`s the child,
  and waits up to a bounded readiness timeout for the same platform-specific
  IPC probe to succeed before allowing `serve` to continue. An ambiguous or
  timed-out startup fails closed; `serve` does not start a legacy OpenCode
  beside an unready guardian.
- The new package bin entry, the shared `resolveGuardianPaths()` contract,
  and the authenticated IPC `GuardianClient` are reused by both startup
  and lifecycle handoff paths.

### Reload semantics
- `openchamber guardian reload` first sends an authenticated reload RPC over the
  guardian transport. On POSIX, if IPC is unavailable, it reads the JSON PID
  marker and revalidates the recorded owner/start-time/command-line identity
  and OS liveness before sending `SIGHUP`. On Windows, IPC failure refuses the
  PID fallback entirely to avoid a PID-reuse TOCTOU; retry after the guardian
  endpoint is reachable. Missing, legacy-only, reused, dead, or otherwise
  unresolved identities refuse the POSIX fallback signal.
- The guardian entrypoint owns an O_EXCL-created JSON marker containing its PID,
   process identity, and an in-memory ownership token. Clean IPC shutdown,
   successful signal handling, and startup-error cleanup after verified
   transport teardown remove the marker only when the current process still
   owns that marker; an empty, malformed, or in-progress marker is never
   unlinked by a different process. An uncertain startup rollback retains the
   process and marker for an explicit stop retry.
- The guardian entrypoint restarts its internal timer pair (no config-file
  parsing yet).
- Config reload is **not** wired in Phase 2C. The subcommand reports
  `configReloaded: false` in `--json` and prints an info line in
  human/quiet mode. Adding config reload is a future task.
- If the guardian is not running, the subcommand throws a
  `TunnelCliError` with `EXIT_CODE.GENERAL_ERROR` (the previous
  `client.health()` probe was removed because it silently reported
  success without performing any reload).

### Graceful shutdown sequencing
- The web server never automatically shuts down the guardian service.
- Ordinary `openchamber stop` uses the proxy's owner-scoped
  `stopOwnedOpenCode()` operation; if the guardian is unreachable or the
  owner-scoped stop is not confirmed, shutdown does not kill an arbitrary
  process that may have claimed the same port. The CLI also avoids force-killing
  the web process or removing its owner metadata in that uncertain case, so a
  later retry or startup can recover the same owner-scoped child.
- Restart and update requests send `{ mode: "restart" }` to
  `/api/system/shutdown`. The server calls the guardian proxy's `detach()`
  operation without stopping the child or killing its port, then the CLI starts
  the successor web server with the same persisted
  `OPENCHAMBER_GUARDIAN_OWNER_ID`.
- `openchamber guardian stop` is the explicit administrative operation that
  stops the guardian service and all children it currently owns.
 - Administrative stop waits for authoritative marker removal. If the guardian
   acknowledges shutdown but remains reachable, its transport becomes
   unreachable, or its marker/child state remains unresolved while `guardian.pid`
   is still present, the CLI reports an incomplete/unknown stop and refuses
   direct PID termination so a live guardian cannot be replaced by a reused-PID
   process. Windows also refuses PID signaling after any IPC failure and tells
   the operator to retry through authenticated IPC.

### Windows behavior
- Windows uses loopback TCP with an ephemeral port published only after the discovery file has been ACL-protected for the current user.
- The guardian and web client perform a challenge/response handshake, then MAC every request with an ordered sequence number. A valid sequence is consumed before handler dispatch even when the handler returns an error; the client advances after write acceptance and reconnects after an ambiguous timeout. Missing, stale, replayed, or tampered requests fail closed.
- The lifecycle does not use PID-only `taskkill.exe` for Windows termination. Live children use `child.kill()` through the Node process handle; rehydrated children use the default hidden PowerShell/.NET handle terminator, with an injected seam for tests and alternate native hosts. The low-level `runTaskkillForce` helper remains only for compatibility/tests, and `/T` is intentionally not used.

### Smoke test
- `scripts/guardian-smoke-test.sh` and `scripts/guardian-smoke-test.ps1` are
  authenticated end-to-end runtime checks for Linux and Windows respectively.
- Both start the real `openchamber-guardian.js`, reject unauthenticated,
  bad-MAC, and replayed requests, launch the real
  `scripts/guardian-test-opencode.js` managed-child fixture, check health and
  owner metadata, stop the child, then send authenticated `shutdown` and wait
  for the guardian process to exit and confirm that its PID marker was removed.
- `.github/workflows/guardian-linux-baseline.yml` and
  `.github/workflows/guardian-windows-baseline.yml` hard-gate the corresponding
  smoke tests on `ubuntu-latest` and `windows-latest`.

### Process-boundary runner contract
- `packages/web/server/lib/guardian/process-boundary.test.js` and
  `guardian/ipc-transport.boundary.mjs` are Node-authoritative boundary checks.
  They require Node.js 22+ because the real socket-handle transfer and
  process-boundary teardown are validated through Node child-process IPC; a
  Bun unit run must not be presented as equivalent evidence.
- Run both explicitly with `bun run --cwd packages/web test:node-boundary` (the
  script invokes Node directly). The Linux workflow runs this step separately
  and excludes only `process-boundary.test.js` from the ordinary Bun guardian
  unit job. The remaining Bun tests still run and fail normally; the exclusion
  is limited to this known Node-only boundary.
- The Vitest boundary file also skips when loaded by Bun, with the same reason,
  while the POSIX process-boundary tests remain hard-gated on the Linux Node
  step. Windows uses the separate native Windows workflow and does not claim
  POSIX socket-handle evidence.


## Phase 2D — Cross-platform guardian (Windows support via T2)

The cross-platform guardian keeps the v2 record layer, authenticated JSON-line protocol, secret provider, store, and lifecycle integration shared. Only the IPC transport, filesystem ACL handling, and child-termination primitive are platform-specific.

### Architecture summary
- POSIX path: a dedicated Node child helper calls `net.createServer(<socketPath>.owner)` over a Unix-domain socket at `mode 0600`, then creates the private same-inode `<socketPath>.owner` hard-link proof. Linux publishes the public link from a held `O_PATH` descriptor; darwin/BSD/SunOS/AIX use a checked owner pathname plus an actual-listener probe. Startup transfers one accepted probe socket as a helper-issued publication token and completes only after the two-phase helper proof, parent identity corroboration, bounded commit acknowledgement, and final confirmation fence; clients still dial the public path directly.
- Windows path: `net.createServer({ host: '127.0.0.1', port: 0 })` over loopback TCP. The guardian picks an ephemeral port, writes `127.0.0.1:<port>\n` to a discovery file at `<guardian-root>/port`, and applies an ACL to that file before publishing. Clients read the discovery file and dial `127.0.0.1:<port>`.
- Default Windows discovery-file path: `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port` (resolved from `OPENCHAMBER_DATA_DIR` by the shared path resolver). The directory itself lives at `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\` and is created with `ensurePrivateDirectoryWindows`.
- The factory that selects between the two paths is `createIpcServer` / `createIpcDialer` in `packages/web/server/lib/guardian/ipc-transport.js`. It is the single point that knows about platform-specific paths; everything above it is transport-agnostic.

### Trust boundary — Linux vs Windows
- Linux trust boundary (enforced by the OS): "any local process running under the same UID can connect." Enforced by `0600` mode on the Unix-domain socket, `0700` mode on the v2 root, `0600` mode on the v2 master secret, and the atomic `O_EXCL` PID singleton file.
- Windows trust boundary (enforced by the ACL we apply): "any local process running as the same Windows user can connect." Enforced by the per-user ACL on the discovery file (`/inheritance:r /grant:r <username>:F`) plus loopback-only TCP (`127.0.0.1`; the server never binds `0.0.0.0` or any operator-supplied hostname). ACL commands do not use `/c`; publication fails closed on any ACL error.
- The Windows guarantee is strictly weaker than the Linux one. Windows has no per-process UID; the OS primitive "same Windows user" is the closest analog, and it does not isolate processes within a logon session the way Unix UIDs isolate processes within a host. Any local process owned by the same Windows user — including any future code that account runs — can dial `127.0.0.1:<port>` and speak the JSON-line protocol. The port file is the only attribute gating which user account can find the port; it does not gate which of that account's processes may connect.
- This is the same trade-off `vscode-test`, Electron, and Playwright make on Windows: they bind loopback and rely on the same-Windows-user attribute as the cross-process isolation primitive. We do the same. There is no portable way to get Unix-socket-grade isolation on Windows without a kernel-mode component.
- Windows lock, temp, and discovery artifacts are not removed by a bare path `unlink` after validation. The transport opens and identity-checks the file, performs the shared ancestor ACL/reparse checks, atomically moves it to a private same-directory quarantine name, verifies the identity and original-path absence again, and only then removes the quarantine entry. Discovery reads likewise use a validated file handle and reject an ancestor, path, or file-identity replacement. POSIX close has no listener pathname in the guardian parent: the helper publishes `<socketPath>.owner`, exits without `server.close()`/unlink, then the parent identity-removes the public socket and owner alias only after the helper process is gone and both identities still match. A replacement, missing path, missing alias, or unknown object is preserved and keeps transport authority retryable; stale recovery requires the owner alias proof before cleanup and never falls back to legacy pathname-only removal. Any helper, identity, or cleanup failure retains the live transport or cleanup authority and never falls through to a pathname-based listener close or replacement unlink. The final Windows operation is still implemented through Node's portable filesystem API; native Windows handle-relative delete/process-boundary coverage remains a CI/runtime limitation rather than an assumption of cryptographic isolation.

### Filesystem changes
- The v2 root on Windows uses `ensurePrivateDirectoryWindows` (in `packages/web/server/lib/opencode/managed-opencode-handoff-v2/filesystem.js`). The dispatcher `ensurePrivateDirectory({ platform })` selects the Windows variant on `win32`; the POSIX variant is unchanged. Existing roots and files, plus every existing ancestor on their paths, are lstat-checked for reparse points and their ACLs are inspected fail-closed; only the current user plus supported inherited SYSTEM/Administrators entries are accepted.
- `ensurePrivateDirectoryWindows` creates the directory via `fs.mkdirSync({ recursive: true })` (no POSIX mode bits — Windows ignores them) and then calls `applyDirectoryAcl` from `packages/web/server/lib/guardian/windows-acl.js` to apply the ACL `/grant:r <username>:(OI)(CI)F`. The `(OI)(CI)` flags make the grant inheritable so any file the guardian later writes inside the directory — `master-secret.bin`, `records.sqlite3`, `port`, `guardian.pid` — inherits the same owner-only grant.
- The secret provider, store, protocol, and lifecycle code share the v2 root path through `resolveManagedOpenCodeHandoffV2Root`; the secret/store filesystem checks dispatch durability and permission rules by platform while preserving POSIX mode/fsync guarantees.
- The discovery file is created at `<v2-root>/port` by `writeDiscoveryFileAtomic` (in `packages/web/server/lib/guardian/discovery-file.js`). See "Discovery file lifecycle" below.

### Process termination
- Linux: SIGTERM → SIGKILL escalation via `process.kill(-pid, …)` (process group kill on the spawned child group). Unchanged for normal live children; rehydrated children revalidate their persisted process-start and launch identity immediately before each signal and fail closed on unavailable or mismatched identity.
- Windows: live ChildProcess instances use the process handle exposed by
  `child.kill()`. Rehydrated children use the default hidden PowerShell/.NET
  handle helper, which opens and retains one handle, rechecks persisted
  start/launch identity, and terminates that handle; helper or identity failure
  remains fail-closed and never falls back to PID-only `taskkill`. The
  low-level `runTaskkillForce` helper remains available for compatibility and
  tests but is not used for lifecycle termination. Native Windows runtime
  evidence for this path remains an open CI gate.

### CLI surface (no new flags)
- The Windows path reuses the existing CLI surface. No new subcommands, no new flags, no new environment variables.
- `openchamber serve` — autostarts the guardian on both platforms via `maybeAutoStartGuardian` in `packages/web/bin/lib/commands-guardian.js`. The autostart spawn passes `windowsHide: true` so the detached guardian does not flash a console window.
- `openchamber guardian {status|start|stop|reload}` — works on both platforms. Help text identifies the POSIX Unix-socket and Windows TCP+ACL transports.
- `openchamber-guardian` always resolves the current Windows user for ACLs; the removed `--username` principal override is rejected. Tests inject usernames through the lower-level ACL/filesystem dependency seams.
- `--guardian` / `--no-guardian` — same semantics on both platforms. `--no-guardian` skips autostart on Windows too.
- `--handoff` / `--no-handoff` — same semantics. **Important Windows note:** before T2, `--no-handoff` was redundant on Windows because the handoff branch was unconditionally gated on `process.platform === 'win32'`. With T2 that platform gate is gone, so `--no-handoff` is now the only way to opt Windows users out of the guardian branch and fall back to the legacy lifecycle path.
- `OPENCHAMBER_RESTART_HANDOFF=disabled` — applies to both platforms. Still the recommended opt-out for users who want legacy restart behavior on Windows.
- `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled` — applies to both platforms. Same semantics as `--no-guardian` but settable without touching CLI args.

### Operator runbook — `icacls` failures
The guardian fails closed at startup if it cannot guarantee the per-user ACL on the discovery file. The two common failure modes:

- **`icacls` unavailable at the trusted system path.** Rare on Windows desktop SKUs; possible on stripped Server Core / Nano images. The guardian exits 1 with `Could not locate icacls binary; refusing to start guardian to preserve trust boundary` (the actual error string thrown by `windows-acl.js`; the per-user ACL on the discovery file is what would be lost if we proceeded, so the guardian refuses rather than bind loopback without an ACL on the port file). Fix: install the `Server-Media-Foundation` Windows feature (which ships `icacls.exe`), or run on a full Windows desktop SKU. The command is resolved from `%SystemRoot%\System32` with a fixed `C:\Windows` fallback; PATH and the current directory are never consulted.
- **`icacls` returns non-zero.** The guardian exits 1 with `icacls failed: <stderr>` (the exact `icacls` stderr text is captured). Read the stderr; the common causes are:
  - the parent directory rejects the inheritance reset (a permissions issue with `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\`);
  - a file-system reparse point in the parent path blocks the inheritance propagation;
  - a domain-ACL mismatch (the current user's username is `DOMAIN\user` but the grant target was resolved without the domain prefix).
- **Hard rule:** when the guardian cannot apply the discovery-file ACL, it refuses to start. This is fail-closed by design — better than exposing the IPC port to all local users. The CLI autostart in `commands-serve.js` reports the failure and refuses to continue beside an unready or ambiguous guardian. Operators who intentionally want the legacy lifecycle path must use `--no-guardian`, `--no-handoff`, or `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled`.

### Discovery file lifecycle
- Created on `bin/openchamber-guardian.js` startup via `writeDiscoveryFileAtomic(portPath, port, { username })` (in `packages/web/server/lib/guardian/discovery-file.js`). The sequence is:
  1. `O_EXCL` create `<portPath>.tmp` with restrictive inheritance (the temp filename is not symlink-able);
  2. `writeFileSync` the `127.0.0.1:<port>\n` body;
  3. `fsync` the temp file;
  4. `applyDiscoveryFileAcl(<portPath>.tmp, { username })` — the ACL is applied to the **temp** file, so a half-published file at the final name is never observable;
  5. identity-fenced hard-link publication from `<portPath>.tmp` to `<portPath>` — an existing final path is rejected rather than replaced; the temp entry is then removed through the same identity fence. Artifact identity snapshots normalize dev/ino, stable birth-time metadata (ctime fallback), and file type; the post-link snapshot is refreshed because hard-link publication may update ctime. If validation or temp/lock cleanup fails after the link, the final entry is rolled back by its recorded identity before the publish error is returned; failure to prove that rollback returns a stable cleanup-uncertain error and retains the transport/guardian ownership for retry. A final path that pre-existed outside the publication is never treated as settled cleanup: startup rollback retains transport/guardian authority until that unknown path is gone or otherwise resolved.
- Removed on clean shutdown by `removeDiscoveryFile(portPath)` as the last step in `GuardianIpcServer#stop` (close listener → remove file). The Windows transport retains the published file identity as well as its port; a missing or replaced path is safe for normal idempotent close, and a replacement—including a same-port replacement—is never unlinked. POSIX cleanup treats `guardian.sock` and `guardian.sock.owner` as one retryable pair and restores the public hard link if owner cleanup fails partway through.
- Discovery reads use a validated file handle and recheck the path identity before returning a port. After a crash, the next guardian may remove `port.lock`, `port.tmp`, and the stale final `port` only through `recoverStaleGuardianTransportArtifacts()` after the prior PID marker's complete identity has been revalidated as dead. Recovery invokes strict discovery removal: a final-file replacement or identity uncertainty propagates instead of authorizing stale-marker removal. Explicit Windows paths reuse ancestor ACL/reparse validation and atomically quarantine plus recheck file identity before removal; a live, PID-reused, legacy, malformed, or ambiguous marker leaves all artifacts untouched and startup fails closed. Detection remains read-only and reports an unreachable stale endpoint as not running. Startup rollback also retains transport/marker authority when an unknown POSIX path survives; it settles only after the public/owner pair and hidden quarantine entries are gone.

### Downgrade story (closes F-10)
If the operator downgrades from a Windows-aware guardian build to an older build without uninstalling the Windows guardian state, the orphan files are harmless:

- `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port` — the discovery file. The legacy entrypoint has no factory knowledge and ignores `port`. Nothing in the legacy code path reads it.
- `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\guardian.pid` — the PID file. The legacy code path on Windows has no `O_EXCL` PID singleton; it just runs.
- `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\records.sqlite3` — the v2 SQLite store. The legacy code path does not open it.

If the operator wants to fully remove the orphans (idempotent, optional):

```bat
rmdir /S /Q "%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2"
```

or per-file:

```bat
rm "%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port"
```

No automatic migration is required. Documented in the CHANGELOG entry under `[Unreleased]`.

### Cross-references
- Transport factory: `packages/web/server/lib/guardian/ipc-transport.js` — `createIpcServer` / `createIpcDialer` / `defaultIpcPaths`.
- Transport recovery: `packages/web/server/lib/guardian/ipc-transport.js` — `recoverStaleGuardianTransportArtifacts` validates prior PID identity and the POSIX `<socketPath>.owner` same-inode proof before removing crash leftovers; POSIX close waits for `guardian/ipc-listener-helper.js` to exit and identity-fences both public and owner paths, while Windows cleanup also uses identity-safe artifact removal and Windows close checks the published discovery port before cleanup. The dependency-free `guardian/ipc-transport.boundary.mjs` Node test exercises real IPC handle transfer and process-boundary failures; Bun's unit runner cannot deserialize transferred `net.Socket` handles, so those two cases are skipped there rather than given a non-IPC fallback.
- Discovery-file helpers: `packages/web/server/lib/guardian/discovery-file.js` — `writeDiscoveryFileAtomic`, `readDiscoveryFile`, `removeDiscoveryFile`.
- ACL helpers: `packages/web/server/lib/guardian/windows-acl.js` — `applyDiscoveryFileAcl`, `applyDirectoryAcl`, `resolveCurrentUsername`.
- v2 root dispatcher: `packages/web/server/lib/opencode/managed-opencode-handoff-v2/filesystem.js` — `ensurePrivateDirectory` (POSIX vs `ensurePrivateDirectoryWindows`).
- Process termination: `packages/web/server/lib/guardian/windows-process.js` — `terminateChildWindows`, `runTaskkillForce`.
- Lifecycle integration: `packages/web/server/lib/opencode/lifecycle.js` — `restartOpenCode` (handoff branch) and `bootstrapOpenCodeAtStartup` (adoption branch) both route through the factory.
- CLI wiring: `packages/web/bin/lib/commands-guardian.js` (`guardianCommand`, `maybeAutoStartGuardian`, `startGuardianDetached`), `packages/web/bin/lib/commands-serve.js` (autostart call site), `packages/web/bin/openchamber-guardian.js` (entrypoint).
- Smoke tests: `scripts/guardian-smoke-test.sh` (Linux) and `scripts/guardian-smoke-test.ps1` (Windows). Both spawn the real `openchamber-guardian.js` binary against a temp data dir, list children (expect `[]`), send `shutdown`, and assert clean process exit.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- OpenCode CLI resolution order is persisted settings, environment overrides, bundled Desktop CLI when available, PATH, known install locations, then platform shell discovery.
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
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarProjectSortOrder`, and `sidebarShowRecentSection`. Device-local picker selection and sticky-header state do not enter `settings.json`.

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
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`
  - `resolveProjectDirectory(req)`
  - `resolveOptionalProjectDirectory(req)`

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers configuration entity routes:
  - Agents: `/api/config/agents/:name` and `/api/config/agents/:name/config`
  - Commands: `/api/config/commands/:name`
  - MCP servers: `/api/config/mcp` and `/api/config/mcp/:name`
  - Snippets: `/api/config/snippets`, `/api/config/snippets/:name`, and `/api/config/snippets/expand`
- Agent/command/MCP write routes persist config to disk and return a deferred-restart payload (`requiresReload: false`, `requiresRestart: true`, `restartDeferred: true`) instead of restarting OpenCode immediately. The UI accumulates these changes and applies them with `POST /api/config/reload`.

## Public exports (config-mutation-response.js)
- `buildDeferredRestartResponse(message)`: success payload for config mutations that are saved on disk but waiting for an explicit Apply & Restart (`restartDeferred: true`).
- `buildExternalManualRestartResponse(message)`: success payload when OpenCode is an external process and the operator must restart it manually (`requiresManualRestart: true`).

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`
  - `captureOpenCodeAuthState()`: returns an opaque restore callback for a failed managed handoff rollback.

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`
  - The shutdown route owns its bounded JSON parser because it is registered before the shared `/api` middleware; this keeps restart bodies working without parsing unrelated API requests twice.
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
  - `POST /api/config/reload` — applies accumulated deferred OpenCode config changes. Managed OpenCode restarts and returns `requiresReload: true`. External OpenCode returns `requiresManualRestart: true` (changes are already on disk; the connected server must be restarted outside OpenChamber).
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
  - URL-encoded parser setup
  - request logging middleware

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
- Returned API:
  - `gracefulShutdown(options?)`
  - Owner-scoped guardian stop failures reject shutdown and preserve the process/owner handle for retry or later adoption; they are never converted into a successful teardown.

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
  - `initialize(app, initialPort)`

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

The pipeline binds the OpenChamber listener and publishes its active port
before starting managed OpenCode. The managed custom tool therefore receives
an authoritative loopback callback URL even when OpenChamber binds port `0`.

## Public exports (openchamber-routes.js)
- `registerOpenChamberRoutes(app, dependencies)`: registers OpenChamber endpoints:
  - `GET /api/openchamber/update-check`
  - `POST /api/openchamber/update-install`
    - Foreground servers running under a systemd user unit queue installation in
      a separate transient unit and restart the configured service afterwards.
      `OPENCHAMBER_SYSTEMD_UNIT` overrides the default `openchamber.service`.
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
  - Interactive OAuth forwarder: `POST /api/provider/:providerID/oauth/callback`
    - Upstream blocks inside this call for the whole browser sign-in (device-code polling or a loopback redirect), so it is exempt from the ordinary request deadline and uses a 15-minute proxy timeout instead of `LONG_REQUEST_TIMEOUT_MS`. All other `/api/provider/*` routes, including `oauth/authorize`, keep the ordinary deadline.
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Windows `/session` merge fallback path behavior
  - OpenCode readiness gate for proxied `/api` requests

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/global/event` connection.
  - Can still create its own `/global/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Forwards unwrapped global event payloads into notification/session side effects.

## Storage and configuration
- Provider auth: `~/.local/share/opencode/auth.json`.
- User config: `~/.config/opencode/opencode.json`.
- Project config: `<workingDirectory>/.opencode/opencode.json` or `opencode.json`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.
