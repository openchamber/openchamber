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
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring).
- `packages/web/server/lib/guardian/process-identity.js`: shared owner/start-time/command-line process identity and authoritative liveness probes used by guardian recovery and CLI fallbacks.
- `packages/web/server/lib/guardian/pid-marker.js`: ownership-aware, O_EXCL-created guardian PID marker with identity metadata and fail-closed inspection/release helpers.
- `packages/web/server/lib/opencode/managed-opencode-handoff-protocol.js`: standalone signed handoff-record protocol; it owns no process lifecycle, persistence, registry, auth-state, or runtime wiring.
- `packages/web/server/lib/opencode/managed-opencode-handoff-v2/`: isolated v2 foundation for a private master secret, SQLite record fencing, and reservation/lease state. The guardian/lifecycle wiring is web-runtime-only; it is not a session-resume, UI, Electron, or VS Code feature.
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration and reload semantics.
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

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`, `CUSTOM_CONFIG_FILE`: Path constants.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom).
- `writeConfig(config, filePath)`: Writes config with automatic backup.
- `getJsonEntrySource(layers, sectionKey, entryName)`: Resolves which config layer provides an entry.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates.
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
  - `POST /api/opencode/directory`
  - `GET /api/provider/:providerId/source`
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
  - `resetForOpenCodeReplacement()` (clears volatile live status/activity/attention state at an OpenCode incarnation boundary; does not touch durable session or message data)
  - `dispose()`

The runtime maintains active-session count incrementally from idempotent activity phase transitions. Upstream stall-timeout and lifecycle health checks read it in O(1); the hourly cleanup removes activity phases older than 24 hours without broadcasting synthetic state transitions. Snapshot generation remains reserved for the session-activity API.

## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: creates lifecycle runtime for managed/external OpenCode process orchestration.
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
OpenChamber tool injection.

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
- `createManagedOpenCodeHandoffV2SecretProvider({ rootDir?, platform? })`: owns a v2-only 32-byte local master secret in closure. It exposes record-MAC derivation, a public credential fingerprint, and opaque one-shot lifecycle credential callbacks; it never accepts JWTs, user passwords, OpenCode server passwords, HMR state, CLI arguments, or environment overrides as secret input.
- `createManagedOpenCodeHandoffV2Store({ rootDir?, busyTimeoutMs? })`: opens the separate v2 SQLite database and exposes async `read()`, `list()`, `compareAndSwap()`, `hasV2Records()`, `cleanup()`, and `close()` operations. The store uses WAL, FULL synchronous mode, a busy timeout, exact schema validation, POSIX parent-directory fsync, and `BEGIN IMMEDIATE` fencing with SQLite's transaction-time clock. Windows uses the ACL-protected root and skips only the POSIX directory-fsync primitive; shared Windows validation rejects reparse points in the target and every existing ancestor, plus ACLs with unapproved or unsafe access. Its renewal callback form creates a signed next record from that transaction-time clock.
- `createManagedOpenCodeHandoffV2Protocol({ secretProvider, store, now?, defaultLeaseMs? })`: returns `reserveLaunch()`, fenced `beginLaunch({ incarnation, expectedRevision, withCredential })`, `bindSpawnedProcess()`, bounded `renewLease()`, read/verify helpers, and explicit interruption/stopping/retirement transitions.
- `ManagedOpenCodeHandoffV2State` and `MANAGED_OPENCODE_HANDOFF_V2_ALLOWED_TRANSITIONS`: v2 state names and the full future graph: `reserved -> launch-delivering -> launching -> active -> handoff-prepared -> claimed -> active`, with explicit `interrupted`, `stopping`, and `retired` rules.

### Managed OpenCode handoff v2 Phase-2A scope and invariants
- The v2 root defaults to `~/.local/state/openchamber/managed-opencode-handoff-v2/`; POSIX uses a private (`0700`) root and regular owner-only (`0600`) `master-secret.bin`/evidence files, while Windows uses the per-user ACL trust boundary. Evidence is atomically published before first secret creation, so concurrent initializers converge. A missing/corrupt secret after evidence **or a secret without evidence** fails closed and is never repaired by backfilling evidence. Deleting the root (or both the evidence and secret) destroys that evidence and is the unavoidable fresh-initialization boundary.
- The raw master remains in the provider closure. Derived record-MAC keys and one-shot lifecycle credentials are zeroed after use. `beginLaunch()` arms opaque material before it atomically moves `reserved -> launch-delivering`; only the owner may complete that short-lived fenced state to `launching`. Public terminal transitions are rejected while delivery is fenced, and pre-callback authority checks revoke material on expiry, callback failure, or a lost fence. Raw credentials never appear in public records, SQLite rows, diagnostics, or logs.
- SQLite records hold only version/state, random incarnation, credential fingerprint, optional post-spawn process identity, lease/revision, and MAC fields. Process start ticks use canonical decimal text so Windows `DateTime.Ticks` values remain lossless through SQLite and record-MAC comparisons. The store requires its exact strict table, primary-key/index layout, checks, metadata, and absence of triggers/views; user objects whose names merely resemble SQLite internals are still rejected. Malformed, corrupt, or under-constrained schema blocks use rather than becoming an absent/free record. POSIX parent-directory fsync failure is fatal; Windows skips only that POSIX-only durability operation while retaining ACL enforcement. Cleanup removes expired terminal (`interrupted`/`retired`) records only. Expired unresolved records, including `stopping` and `handoff-prepared`, remain durable; guardian recovery can verify them through an explicit expired-state path and retire or re-establish ownership only after authoritative liveness/termination checks. The database is separate from `managed-process-registry.js`, so legacy web/VS Code reapers cannot parse or reap v2 state.
- Phase 2A implements reservation, fenced material delivery, `reserved -> launch-delivering -> launching -> active` identity binding, bounded active lease renewal from SQLite transaction time, interruption, stopping, and retirement. Guardian/lifecycle wiring adds stable owner identity and launch-spec fields without persisting raw environment secrets or session state.

## Phase 2B/3 — Guardian Process Lifecycle Integration

> Phase 2D (`Phase 2D — Cross-platform guardian (Windows support via T2)`) extended the IPC helpers to accept `(socketPath, portPath?)` and dispatched per platform via `createIpcServer` / `createIpcDialer`. This Phase 2C section describes the original cross-cutting helpers; the current per-platform behavior is documented in the Phase 2D section.

### Architecture
- A standalone **guardian process** (`openchamber-guardian.js`) outlives the web server and manages OpenCode child processes via the Phase 2A v2 durable protocol.
- POSIX uses a `0600` Unix-domain socket; Windows uses loopback TCP plus an ACL-protected discovery file. Both transports carry the same authenticated JSON-line protocol.
- Web server integration is owner-scoped. The guardian service may outlive the web server; ordinary shutdown stops only this instance's OpenCode child, while restart detaches from a live guardian child and explicit `openchamber guardian stop` is the administrative service shutdown.

### Detection module (`guardian/detection.js`)
- `isGuardianRunning(socketPath, portPath?)`: Probes the platform-specific guardian transport with a 100ms connect timeout.
- `detectAndAdoptGuardianChild(socketPath, portPath?, { expectedOwner })`: Authenticates via `GuardianClient`, rejects ownerless, incomplete, unhealthy, ambiguous, or attention-state records, and returns only the exact matching `{ incarnation, pid, port, url, owner, launchSpec }` or `null`.
- `getGuardianSocketPath(rootDir?)`: Returns the deterministic socket label; Windows transport selection uses the sibling discovery-file path.
- Custom data-directory, socket, and discovery-file inputs are normalized through `resolveGuardianPaths`; an explicit data root remains authoritative for the IPC auth secret, while a transport-only override derives its secret from that custom transport root rather than the process's default environment paths.

### Lifecycle integration (`lifecycle.js`)

**`bootstrapOpenCodeAtStartup()`**
- After orphan reaping and HMR state check, attempts to detect a guardian-managed child on every supported platform.
  - Requires the stable `OPENCHAMBER_GUARDIAN_OWNER_ID` supplied by the CLI. If a guardian child is found:
  - Sets a closeable guardian proxy, `state.openCodePort`, `state.isOpenCodeReady`, `state.currentIncarnation`, and the exact owner identity.
  - Skips spawning a new child process
- If the guardian is running but has no child, performs the initial managed spawn through the guardian. If that live guardian launch fails, lifecycle records an explicit error and refuses a legacy spawn; direct startup is allowed only when the guardian probe was false or guardian use was explicitly disabled.
- A rejected guardian-running probe is treated as unknown, not as `false`; startup/restart record the probe failure and refuse a legacy lifecycle spawn beside an uncertain guardian.
- Guardian startup requires a successful recovery-store `list()` before publishing IPC. A list failure aborts startup and leaves no healthy endpoint. Administrative stop keeps the authenticated IPC service and durable `stopping` child records available when termination fails, so the operation can be retried instead of hiding a live child. Lease expiry never deletes an unresolved `stopping` or `handoff-prepared` record; rehydration verifies those records through the explicit recovery path, retains a live child, or surfaces attention until liveness/termination is authoritative. `reserved`, `launch-delivering`, and `launching` records without a durable process identity become attention records that block conflicting launch rather than being silently discarded. Guardian launch, stop, handoff, abort, reload, and shutdown mutations share one serialized queue; read-only list and health requests remain unqueued.

**`restartOpenCode()`**
- Before stopping the existing child, checks if the guardian is running on the current platform.
  - If the in-memory incarnation is missing, first queries/adopts the exact stable-owner child. Multiple, ownerless, unhealthy, or unavailable records fail closed rather than selecting a list entry.
- If guardian is running:
  1. Connects via `GuardianClient`
  2. Prepares handoff for current incarnation via `client.prepareHandoff()`
  3. Spawns successor via `client.spawn()`
  4. Waits for successor health via `waitForReady()`
  5. Stops old child via owner-checked `client.stop()`
  6. Updates `state.openCodeProcess`, `state.openCodePort`, `state.currentIncarnation`, and owner identity
- Dynamic-port handoff starts and health-checks the successor before stopping the old child. Fixed-port handoff stops the old child and waits for port release before spawning the successor.
- Legacy fallback is allowed only when the old child was not stopped, abort/health rollback restores it to active, and the exact owner can be stopped before the legacy spawn. Durable `stopping`, `unknown`, and `attention` records are unresolved blockers until the authenticated guardian retires or otherwise resolves them. Once a guardian has been observed, an authoritative no-exact-owner result never triggers a port-wide kill; lifecycle only uses the legacy port cleanup when the guardian was unavailable. If cleanup or ownership is uncertain, lifecycle fails closed instead of creating a second child.
- If a managed password was rotated while a rollback-capable old child was still running, confirmed rollback restores the previous auth state before the old child is made ready again.
- Failed successor cleanup is verified through the guardian record list when available; a failed guardian disconnect also fails closed. The previous owner/reference is restored when the old child was not confirmed stopped.

### CLI changes
- `packages/web/bin/lib/cli-args.js`: Added `--handoff` flag parsing.
- `packages/web/bin/lib/commands-lifecycle.js`: `restart` command passes `handoff: options.handoff === true` to `runServe()` so the server knows to prefer guardian handoff.

### State tracking
- `state.currentIncarnation` is tracked in the lifecycle state object when a guardian-managed child is adopted or spawned through handoff. This is optional and additive — existing fields are unchanged.

### Platform constraints
- POSIX and Windows use separate transport backends, but share owner validation, authenticated IPC, durable records, and lifecycle sequencing. POSIX recovery requires revalidation of the persisted process-start and launch identity; an unavailable or mismatched identity is an attention condition rather than a PID-only adoption. Rehydrated children repeat that check before health probes and immediately before each POSIX signal, while normal live `ChildProcess` instances retain their existing signaling behavior.
- Windows process rehydration uses bounded hidden PowerShell queries for start-time and command-line identity. Start-time query failures, PID reuse, and unavailable command-line identity are rejected rather than adopted ambiguously. The supported `Win32_Process` query does not provide a reliable working directory, so launch identity intentionally keeps `cwd: null`; guardian recovery validates the available identity fields and does not infer `cwd`. Destructive Windows termination revalidates the process identity immediately before `taskkill.exe` for the same fail-closed behavior.
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
  guardian transport. If IPC is unavailable, it reads the JSON PID marker and
  revalidates the recorded owner/start-time/command-line identity and OS
  liveness before sending `SIGHUP` (or `SIGBREAK` on Windows). Missing,
  legacy-only, reused, dead, or otherwise unresolved identities refuse the
  fallback signal.
- The guardian entrypoint owns an O_EXCL-created JSON marker containing its PID,
  process identity, and an in-memory ownership token. Clean IPC shutdown,
  signal handling, and startup-error cleanup remove the marker only when the
  current process still owns that marker; an empty, malformed, or in-progress
  marker is never unlinked by a different process.
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
   process.

### Windows behavior
- Windows uses loopback TCP with an ephemeral port published only after the discovery file has been ACL-protected for the current user.
- The guardian and web client perform a challenge/response handshake, then MAC every request with an ordered sequence number. A valid sequence is consumed before handler dispatch even when the handler returns an error; the client advances after write acceptance and reconnects after an ambiguous timeout. Missing, stale, replayed, or tampered requests fail closed.
- `taskkill.exe /F /PID <pid>` is the Windows termination primitive; `/T` is intentionally not used.

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


## Phase 2D — Cross-platform guardian (Windows support via T2)

The cross-platform guardian keeps the v2 record layer, authenticated JSON-line protocol, secret provider, store, and lifecycle integration shared. Only the IPC transport, filesystem ACL handling, and child-termination primitive are platform-specific.

### Architecture summary
- Linux/POSIX path: `net.createServer(path)` over a Unix-domain socket at `mode 0600`. The guardian writes the socket path; clients dial it directly.
- Windows path: `net.createServer({ host: '127.0.0.1', port: 0 })` over loopback TCP. The guardian picks an ephemeral port, writes `127.0.0.1:<port>\n` to a discovery file at `<guardian-root>/port`, and applies an ACL to that file before publishing. Clients read the discovery file and dial `127.0.0.1:<port>`.
- Default Windows discovery-file path: `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port` (resolved from `OPENCHAMBER_DATA_DIR` by the shared path resolver). The directory itself lives at `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\` and is created with `ensurePrivateDirectoryWindows`.
- The factory that selects between the two paths is `createIpcServer` / `createIpcDialer` in `packages/web/server/lib/guardian/ipc-transport.js`. It is the single point that knows about platform-specific paths; everything above it is transport-agnostic.

### Trust boundary — Linux vs Windows
- Linux trust boundary (enforced by the OS): "any local process running under the same UID can connect." Enforced by `0600` mode on the Unix-domain socket, `0700` mode on the v2 root, `0600` mode on the v2 master secret, and the atomic `O_EXCL` PID singleton file.
- Windows trust boundary (enforced by the ACL we apply): "any local process running as the same Windows user can connect." Enforced by the per-user ACL on the discovery file (`/inheritance:r /grant:r <username>:F`) plus loopback-only TCP (`127.0.0.1`; the server never binds `0.0.0.0` or any operator-supplied hostname). ACL commands do not use `/c`; publication fails closed on any ACL error.
- The Windows guarantee is strictly weaker than the Linux one. Windows has no per-process UID; the OS primitive "same Windows user" is the closest analog, and it does not isolate processes within a logon session the way Unix UIDs isolate processes within a host. Any local process owned by the same Windows user — including any future code that account runs — can dial `127.0.0.1:<port>` and speak the JSON-line protocol. The port file is the only attribute gating which user account can find the port; it does not gate which of that account's processes may connect.
- This is the same trade-off `vscode-test`, Electron, and Playwright make on Windows: they bind loopback and rely on the same-Windows-user attribute as the cross-process isolation primitive. We do the same. There is no portable way to get Unix-socket-grade isolation on Windows without a kernel-mode component.

### Filesystem changes
- The v2 root on Windows uses `ensurePrivateDirectoryWindows` (in `packages/web/server/lib/opencode/managed-opencode-handoff-v2/filesystem.js`). The dispatcher `ensurePrivateDirectory({ platform })` selects the Windows variant on `win32`; the POSIX variant is unchanged. Existing roots and files, plus every existing ancestor on their paths, are lstat-checked for reparse points and their ACLs are inspected fail-closed; only the current user plus supported inherited SYSTEM/Administrators entries are accepted.
- `ensurePrivateDirectoryWindows` creates the directory via `fs.mkdirSync({ recursive: true })` (no POSIX mode bits — Windows ignores them) and then calls `applyDirectoryAcl` from `packages/web/server/lib/guardian/windows-acl.js` to apply the ACL `/grant:r <username>:(OI)(CI)F`. The `(OI)(CI)` flags make the grant inheritable so any file the guardian later writes inside the directory — `master-secret.bin`, `records.sqlite3`, `port`, `guardian.pid` — inherits the same owner-only grant.
- The secret provider, store, protocol, and lifecycle code share the v2 root path through `resolveManagedOpenCodeHandoffV2Root`; the secret/store filesystem checks dispatch durability and permission rules by platform while preserving POSIX mode/fsync guarantees.
- The discovery file is created at `<v2-root>/port` by `writeDiscoveryFileAtomic` (in `packages/web/server/lib/guardian/discovery-file.js`). See "Discovery file lifecycle" below.

### Process termination
- Linux: SIGTERM → SIGKILL escalation via `process.kill(-pid, …)` (process group kill on the spawned child group). Unchanged for normal live children; rehydrated children revalidate their persisted process-start and launch identity immediately before each signal and fail closed on unavailable or mismatched identity.
- Windows: `taskkill.exe /F /PID <pid>` (no `/T`). We only target the OpenCode child PID we spawned — never the entire tree — because `/T` would risk killing our own guardian process group. See `packages/web/server/lib/guardian/windows-process.js` (`terminateChildWindows` / `runTaskkillForce`). On `ESRCH` or `taskkill` exit code 128 ("process not found"), we treat the child as already-gone; `EPERM` remains an ambiguous termination failure.

### CLI surface (no new flags)
- The Windows path reuses the existing CLI surface. No new subcommands, no new flags, no new environment variables.
- `openchamber serve` — autostarts the guardian on both platforms via `maybeAutoStartGuardian` in `packages/web/bin/lib/commands-guardian.js`. The autostart spawn passes `windowsHide: true` so the detached guardian does not flash a console window.
- `openchamber guardian {status|start|stop|reload}` — works on both platforms. Help text identifies the POSIX Unix-socket and Windows TCP+ACL transports.
- `--guardian` / `--no-guardian` — same semantics on both platforms. `--no-guardian` skips autostart on Windows too.
- `--handoff` / `--no-handoff` — same semantics. **Important Windows note:** before T2, `--no-handoff` was redundant on Windows because the handoff branch was unconditionally gated on `process.platform === 'win32'`. With T2 that platform gate is gone, so `--no-handoff` is now the only way to opt Windows users out of the guardian branch and fall back to the legacy lifecycle path.
- `OPENCHAMBER_RESTART_HANDOFF=disabled` — applies to both platforms. Still the recommended opt-out for users who want legacy restart behavior on Windows.
- `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled` — applies to both platforms. Same semantics as `--no-guardian` but settable without touching CLI args.

### Operator runbook — `icacls` failures
The guardian fails closed at startup if it cannot guarantee the per-user ACL on the discovery file. The two common failure modes:

- **`icacls` not on PATH.** Rare on Windows desktop SKUs; possible on stripped Server Core / Nano images. The guardian exits 1 with `Could not locate icacls binary; refusing to start guardian to preserve trust boundary` (the actual error string thrown by `windows-acl.js`; the per-user ACL on the discovery file is what would be lost if we proceeded, so the guardian refuses rather than bind loopback without an ACL on the port file). Fix: install the `Server-Media-Foundation` Windows feature (which ships `icacls.exe`), or run on a full Windows desktop SKU.
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
  5. `renameSync(<portPath>.tmp, <portPath>)` — atomic on Windows via `MoveFileEx`.
- Removed on clean shutdown by `removeDiscoveryFile(portPath)` as the last step in `GuardianIpcServer#stop` (close listener → remove file).
- A stale `port` file after a crash is harmless: clients get a TCP connection refused when they try to dial. The `GuardianClient.connect` error path already treats any TCP failure as "guardian not running", so the next lifecycle call falls through to the legacy restart path without manual cleanup.

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
- Discovery-file helpers: `packages/web/server/lib/guardian/discovery-file.js` — `writeDiscoveryFileAtomic`, `readDiscoveryFile`, `removeDiscoveryFile`.
- ACL helpers: `packages/web/server/lib/guardian/windows-acl.js` — `applyDiscoveryFileAcl`, `applyDirectoryAcl`, `resolveCurrentUsername`.
- v2 root dispatcher: `packages/web/server/lib/opencode/managed-opencode-handoff-v2/filesystem.js` — `ensurePrivateDirectory` (POSIX vs `ensurePrivateDirectoryWindows`).
- Process termination: `packages/web/server/lib/guardian/windows-process.js` — `terminateChildWindows`, `runTaskkillForce`.
- Lifecycle integration: `packages/web/server/lib/opencode/lifecycle.js` — `restartOpenCode` (handoff branch) and `bootstrapOpenCodeAtStartup` (adoption branch) both route through the factory.
- CLI wiring: `packages/web/bin/lib/commands-guardian.js` (`guardianCommand`, `maybeAutoStartGuardian`, `startGuardianDetached`), `packages/web/bin/lib/commands-serve.js` (autostart call site), `packages/web/bin/openchamber-guardian.js` (entrypoint).
- Smoke tests: `scripts/guardian-smoke-test.sh` (Linux) and `scripts/guardian-smoke-test.ps1` (Windows). Both spawn the real `openchamber-guardian.js` binary against a temp data dir, list children (expect `[]`), send `shutdown`, and assert clean process exit.
Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

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
  - `POST /api/config/reload`
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
  - Skills catalog listing/source pagination, scan, and install routes
  - Supporting skill file read/write/delete routes

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
    - Downstream heartbeats keep clients and intermediaries alive, while a separate upstream-only stall watchdog closes the downstream response when OpenCode stops producing bytes so clients reconnect instead of trusting synthetic heartbeats indefinitely. Each watchdog reset uses the current load-aware timeout, matching the shared event transport.
  - Session message forwarder: `POST /api/session/:sessionId/message`
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
