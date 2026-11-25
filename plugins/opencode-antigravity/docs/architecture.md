# opencode-antigravity architecture

Read this first. It maps the final `src/`, shows how the install/auth part and the sessions/runtime part connect, follows one request end to end, merges the configuration, and splits the work into packages two people can build at once.

Detail lives in two design docs. This file points into them by section and repeats only what is needed to find the way:

| Doc | Covers |
| --- | --- |
| `docs/decisions.md` | The user's locked decisions and the settled follow-ups |
| `docs/design-install-auth.md` | Managed `agy` download and verification, isolated auth, Google sign-in and sign-out, auth status, the proxy credential gate |
| `docs/design-sessions-runtime.md` | Shared `agy acp` process, OpenCode session to ACP session mapping, stalls and retries, system prompt, tool guard, HTTP routes |

Constraints for every package: changes stay inside `plugins/opencode-antigravity`; Bun and Node built-ins only, no new npm dependencies; nothing logs tokens, MCP secrets, prompt text, tool arguments or tool results unless `debugContent: true`.

## 1. Module map

Every file in the final `src/`. "IA" is `design-install-auth.md`, "SR" is `design-sessions-runtime.md`.

### 1.1 Shared contracts

| File | Job | Exports | Spec |
| --- | --- | --- | --- |
| `contracts.ts` | Types both halves compile against, no logic | `InstallAuthBridge`, `BinaryStatus`, `RuntimeControl`, `Lease`, `RunDir`, `RunDirKind`, `CreateRunDir`, `RequestPlan`, `FreshReason`, `BindingRecord`, `SessionStoreApi`, `SessionAppend`, `ProviderFailure` | IA 15.1, 15.2; SR 3.1, 3.6, 4.3, 4.8, 6.6, 9 |
| `index.ts` | Plugin entry: builds configs and singletons, registers provider and integration, `model.request` hook, pool sharing with async shutdown, event loops, wiring of the bridge and `attachRuntime` | default plugin | IA 10.1, 11.1, 16; SR 8.3, 8.4 |
| `constants.ts` | Runtime constants and ids (provider id, headers, pool key, runtime timeouts) | constants | SR 10 |

### 1.2 Install (IA)

| File | Job | Exports |
| --- | --- | --- |
| `install/config.ts` | Install and auth options, env overrides, validation issues | `InstallAuthOptions`, `InstallAuthConfig`, `resolveInstallAuthConfig(options, env)` |
| `install/paths.ts` | Data dir, gemini dir, managed dirs, profile marker | `resolveDataDir(env)`, `resolveGeminiDir(config, env)`, `managedDirs(dataDir, target)`, `PROFILE_MARKER` |
| `install/platform.ts` | Target key, musl detection, Linux CA bundle | `AgyTarget`, `agyTarget`, `detectMusl`, `linuxCaBundle` |
| `install/manifest.ts` | Fetch, parse and cache Google's manifest | `MANIFEST_BASE`, `AgyManifest`, `parseManifest`, `fetchManifest`, `readManifestCache`, `writeManifestCache` |
| `install/download.ts` | Streamed, size-capped, SHA-512 checked download | `safeFetch`, `downloadAsset` |
| `install/extract.ts` | Single-executable tar.gz extraction | `extractSingleExecutable`, `TarFormatError` |
| `install/verify.ts` | Identity check of a binary over ACP `initialize` | `verifyAgy`, `MIN_AGY_VERSION`, `compareSemver` |
| `install/lock.ts` | Cross-process directory lock with heartbeat | `acquireDirLock`, `DirLock` |
| `install/release.ts` | Inspect, install, activate, prune releases | `inspectRelease`, `installRelease`, `activateRelease`, `pruneReleases` |
| `install/resolve.ts` | PATH, T3 cache and explicit path lookups | `findOnPath`, `findT3Binary`, `checkExplicitBinary` |
| `install/binary-manager.ts` | The process-global binary owner: resolution order, background install, updates, status | `BinaryManager`, `getBinaryManager`, `resolveExistingBinary`, `BinaryNotFoundError` |
| `install/env.ts` | Spawn env per kind and base args | `buildAgyEnv`, `agyBaseArgs` |

### 1.3 Auth (IA)

| File | Job | Exports |
| --- | --- | --- |
| `auth/constants.ts` | `MARKER_ACCESS = "agy-managed"` and auth timeouts | constants |
| `auth/methods.ts` | Auth method registry, only `oauth-personal` supported | `AuthMethodSpec`, `AUTH_METHODS`, `supportedMethods` |
| `auth/settings.ts` | The one writer of `antigravity-acp/settings.json`; profile dirs and marker | `updateProfileSettings`, `authSettingsPatch`, `ensureProfileDirs` |
| `auth/login.ts` | `agy acp --login` code flow | `startCodeLogin`, `parseAuthUrl`, `checkLoginResponse`, `mapLoginFailure` |
| `auth/probe.ts` | Signed-in probe and account email | `probeAuth`, `readAccountEmail` |
| `auth/logout.ts` | ACP `logout`, file fallback | `logoutProfile` |
| `auth/errors.ts` | Sign-in error classes, classifier and texts | `isSignInRequired`, `SignInUrlLineError`, `SignInRequiredError`, `AUTH_URL_STDOUT_PREFIX`, `SIGNED_OUT_MESSAGE`, `SIGN_IN_GATE_MESSAGE`, `redactAgyOutput` |
| `auth/epoch.ts` | Auth epoch counter file | `AuthEpoch` |
| `auth/manager.ts` | The process-global auth owner: state, login, logout, connection status, the bridge | `AuthManager`, `getAuthManager`, `AuthState`, `LocationHandle`, `createInstallAuthBridge` |

### 1.4 Runtime (SR)

| File | Job | Exports | SR |
| --- | --- | --- | --- |
| `config.ts` | Runtime options and env overrides | `RuntimeConfig`, `resolveRuntimeConfig(options, env)` | 10 |
| `agy-process.ts` | One shared `agy acp` process: spawn, leases, idle stop, drain, crash, breaker, wedged check | `AgyProcessManager`, `ProcessState`, `ExitInfo` | 3.1 to 3.5 |
| `acp-client.ts` | JSON-RPC over stdio for one generation, RPC timeouts, auth-URL line detection | `AcpClient`, `AcpError`, `AcpTimeoutError`, ACP types | 3.2 |
| `tmp-sweeper.ts` | Private TMPDIR per run, live set, stale sweep, owner registry | `createRunDir`, `sweepStaleRunDirs`, `OwnerRegistry` | 3.6 |
| `mcp-bridge.ts` | Streamable HTTP MCP endpoint with one registry per ACP session | `McpBridge`, `McpScope` | 3.3, 4.4 |
| `turn.ts` | One ACP prompt across HTTP requests: phases, sinks, parked calls, settle window | `Turn`, `TurnPhase`, `TurnOutcome` | 3.5, 3.7, 8.2 |
| `fingerprint.ts` | Canonical messages, fingerprints, request classification | `canonicalizeMessages`, `messageFingerprint`, `chainHash`, `classifyRequest` | 4.2, 4.3 |
| `session-store.ts` | Persisted bindings, cross-process locks, pruning | `SessionStore`, `BindingLock` | 4.8 |
| `replay.ts` | Structured history replay with budget | `buildReplayPrompt` | 4.7 |
| `prompt.ts` | System prompt append, tool lines, per-turn prompt blocks | `buildSessionAppend`, `extractLeadingSystem`, `buildToolsSection`, `toolsSchemaHash`, `toolsDescriptionHashes`, `buildTurnPrompt` | 7.1 to 7.3, 7.5 |
| `stall-watchdog.ts` | Per-turn silence timer, notes, stall decision | `StallWatchdog`, `Clock` | 6.3, 6.4 |
| `agy-log-tail.ts` | Tail agy's log for retry lines | `AgyLogTail`, `parseRetryLine`, `parseGoDuration` | 6.2 |
| `turn-outcome.ts` | Read agy's conversation DB error step, read-only | `lastStepIndex`, `readTurnErrorStep` | 6.5 |
| `errors.ts` | Failure to HTTP status or mid-stream error, tuned to OpenCode's classifier | `toHttpError`, `toStreamError`, `mapAcpError` | 6.6 |
| `profile.ts` | Agent file, `toolPermission` via the bridge, tool guard hook and its runtime probe, layer 3 permission match | `prepareProfileDir`, `writeToolGuardHook`, `removeToolGuardHook`, `probeGuardRuntime`, `matchMcpPermission` | 4.4, 7.4 |
| `events.ts` | OpenCode session event loop, deduplicated across locations | `runEventLoop` | 8.3 |
| `proxy.ts` | HTTP server: route checks, `/v1` gate, `/mcp`, `/health`, request dispatch | `AntigravityProxy` | 8.1, 8.2 |
| `models.ts` | Model cache and lazy discovery | `loadCachedModels`, `saveCachedModels`, `discoverAgyModels`, `inferLimits`, `toOpenCodeModelInfo` | 3.3 |
| `bun-env.d.ts` | Ambient Bun types the plugin uses (`Bun.serve`, `server.timeout`, `bun:sqlite`, `bun:test`) | types | 3.3, 6.5 |

Removed: `binary.ts` (split into `install/*` and `profile.ts`) and `auth.ts` (moved to `auth/login.ts`).

## 2. How install/auth and sessions/runtime connect

The only coupling is the bridge in `contracts.ts`. `auth/manager.ts` implements `InstallAuthBridge`; `agy-process.ts` and `proxy.ts` consume it. In the other direction, `agy-process.ts` and `tmp-sweeper.ts` provide `RuntimeControl` and `CreateRunDir`, which `index.ts` hands to `AuthManager.attachRuntime`.

```
index.ts
  ├─ getBinaryManager(cfg) ─┐
  ├─ getAuthManager(cfg) ───┴─ createInstallAuthBridge() ──► InstallAuthBridge ──► AgyProcessManager, AntigravityProxy
  └─ pool = acquirePool()  ──► RuntimeControl { stop, hold }, createRunDir ──► authManager.attachRuntime(...)
```

### 2.1 Reconciled interface

Both docs now agree on this shape (IA 15.1, 15.2; SR 9):

```ts
export interface InstallAuthBridge {
  resolveBinary(opts?: { waitMs?: number }): Promise<{ path: string; version: string }>;
  buildSpawnEnv(input: { tmpDir: string }): Record<string, string>;
  readonly geminiDir: string;
  readonly authMethod: string;
  authEpoch(): string;
  onAuthChanged(listener: (e: { epoch: string; reason: "login" | "logout" | "account-changed" }) => void): () => void;
  onBinaryChanged(listener: (e: { path: string; version: string }) => void): () => void;
  isSignInRequired(err: unknown): boolean;
  isPluginOwnedProfile(): boolean;
  beforeSpawn(): Promise<void>;
  reportAuthenticated(): void;
  reportSignInRequired(message: string): void;
  binaryStatus(): BinaryStatus;
  updateProfileSettings(patch: Record<string, unknown>): Promise<void>;
}

export interface RuntimeControl {
  stop(reason: "auth-changed"): Promise<void>;   // idempotent and joinable
  hold(reason: "login"): Lease;                  // never spawns
}
export type CreateRunDir = (kind: RunDirKind) => Promise<RunDir>;
export interface RunDir { readonly path: string; release(): Promise<void> }
```

| Concern | Owner | Rule |
| --- | --- | --- |
| Spawn order | runtime | `beforeSpawn()`, `resolveBinary()`, `createRunDir("runtime")`, `buildSpawnEnv`, `agyBaseArgs` plus runtime flags (SR 3.2) |
| Sign-in errors | both | `AcpClient` raises `SignInUrlLineError` on stdout or stderr lines with `AUTH_URL_STDOUT_PREFIX`; the runtime classifies every RPC error with `isSignInRequired` and calls the report methods; `AuthManager` sets `needs_auth` and asks for `stop("auth-changed")` (IA 12.1) |
| Logout | auth | `AuthManager` awaits `runtime.stop("auth-changed")` before ACP `logout`; the runtime does not start its own stop for reason `logout`; turns stopped this way fail with 401 |
| Login and account change | runtime | `onAuthChanged` with `login` or `account-changed` makes the runtime stop; live turns fail with retryable 503; bindings of the old epoch are dropped |
| Login vs idle stop | both | Login is its own child, holds `hold("login")`, and takes its temp dir from `createRunDir("login")`, which the sweeper never deletes while unreleased |
| Binary update | runtime | `onBinaryChanged` moves the process to `draining`; new requests get a new generation |
| `settings.json` | auth | Every write goes through `updateProfileSettings`; the runtime only passes `{ toolPermission: "strict" }` |
| Profile files | runtime | `config/agents/opencode-bridge.md` (one `mcpServers` entry, the pool MCP URL, mode 0600, rewritten at each pool start; `docs/live-test-fixes.md`), `config/hooks.json` key `opencode-bridge-guard`, `config/opencode-tool-guard.mjs`, `log/opencode-*.log` |
| Proxy gate | runtime implements, auth specifies | Check 1 proxy token on all `/v1`, check 2 `Bearer agy-managed` on chat completions (IA 13.3, SR 8.1) |
| Status notes during download | runtime | From `binaryStatus()`, texts from IA 15.3 |

### 2.2 Mismatches resolved

The install/auth doc adopted all three (its Review response rows AR-1 to AR-3): `CreateRunDir` returns a `RunDir` handle with `release()`; `binary_not_found` is HTTP 503 with `x-should-retry: false` before the stream and code 400 `invalid_request_error` after it starts; `MARKER_ACCESS` lives in `src/auth/constants.ts`; the proxy gate tests live in `test/e2e/auth-bridge.test.ts`.

## 3. Request path, end to end

One streaming tool turn, OpenChamber to agy and back:

1. OpenChamber sends a message; OpenCode builds an OpenAI chat request for provider `antigravity` (`openai-compatible`) with `apiKey = "agy-managed"` from the marker credential.
2. The `model.request` hook in `index.ts` sets `baseURL`, `x-antigravity-proxy-token`, `x-antigravity-meta` (model, variant), `x-antigravity-kind`, `x-antigravity-directory`, `x-antigravity-session`.
3. `proxy.ts`: loopback and no-`Origin` check, proxy token check, `Bearer agy-managed` check (SR 8.1).
4. Session mutex: a live non-parked turn for this session is cancelled first; `classifyRequest` returns `append`, `resume`, `redo`, `fresh`, `meta` or `ephemeral`; the `Turn` is registered; mutex released (SR 3.7, 4.3).
5. `AgyProcessManager.acquire("turn")`: if stopped, `beforeSpawn`, `resolveBinary` (maybe a download, with notes), run dir, spawn, `initialize`, `authenticate`, `reportAuthenticated` (SR 3.2). Streaming requests start SSE and pings after 2 s.
6. Session setup: live session reused, or `session/resume` with the stored id, or `session/new` with the system append in `_meta` and a per-session MCP scope; model and thinking level via `set_config_option` (SR 4.4).
7. `session/prompt` with only the new input (append) or the structured replay (fresh). The watchdog and log tail start (SR 6).
8. agy streams thought and message chunks, which go out as `reasoning_content` and `content`.
9. agy calls `call_mcp_tool`: the guard hook says `force_ask`, `allowPermission` checks session, server and tool, agy posts `tools/call` to `/mcp/<token>/<scope>`. The call parks; after the 250 ms settle window the response ends with `tool_calls` (SR 7.4, 3.5).
10. OpenCode runs the tool under its own permissions and sends the next request with the tool result. Classification gives `resume`; the parked call resolves; the new response attaches to the same turn.
11. agy finishes; the error-step check runs; the stream ends with `finish_reason: "stop"` and usage, or with a typed error that OpenCode retries or shows (SR 6.5, 6.6).
12. The binding is persisted; the lease is released; after 10 min without leases the process stops (SR 3.3).

Side paths: interrupts and deletes arrive through `events.ts`; a stall cancels the turn and returns 504, 429 or 503; a crash fails live turns with 503 and taints their bindings; sign-in failures return 401 and set `needs_auth`.

## 4. Configuration

All plugin options, from both docs. A set option wins over its env var, which wins over the default. Durations in milliseconds.

| Option | Env | Default | Meaning | Spec |
| --- | --- | --- | --- | --- |
| `binaryPath` | `OPENCODE_ANTIGRAVITY_BIN` | unset | Explicit executable; no fallback when it is wrong | IA 3, 5 |
| `binarySource` | `OPENCODE_ANTIGRAVITY_BINARY_SOURCE` | `managed` | `managed`, `path` or `t3code` | IA 3, 5 |
| `autoUpdate` | `OPENCODE_ANTIGRAVITY_AUTO_UPDATE` | `true` | Background manifest check every 6 h | IA 6.8 |
| `offline` | `OPENCODE_ANTIGRAVITY_OFFLINE` | `false` | Never touch the network | IA 3 |
| `offlineFallback` | | `true` | PATH, then T3 cache, when managed is missing and install fails | IA 5 |
| `isolatedAuth` | `OPENCODE_ANTIGRAVITY_ISOLATED_AUTH` | `true` | File token storage in the plugin profile | IA 9 |
| `geminiDir` | `OPENCODE_ANTIGRAVITY_GEMINI_DIR` | `<data>/gemini` | agy profile (`GEMINI_HOME`) | IA 3, 4 |
| data dir | `OPENCODE_ANTIGRAVITY_DATA_DIR` | `$XDG_DATA_HOME/opencode-antigravity`, else `~/.local/share/opencode-antigravity` | Binaries, profile, sessions, caches | IA 3 |
| `authMethod` | | `oauth-personal` | Others are reserved and answer 401 with an issue text | IA 3, 14 |
| `auth.gcpProject`, `auth.gcpLocation` | | unset | Reserved for later methods | IA 3 |
| `proxyPort` | `OPENCODE_ANTIGRAVITY_PROXY_PORT` | `0` (random loopback port) | Proxy listen port | IA 3 |
| `idleShutdownMs` | `OPENCODE_ANTIGRAVITY_IDLE_MS` | 600000 | Stop agy after this long with no leases; 0 disables | SR 3.3 |
| `sessionIdleCloseMs` | | 1800000 | `session/close` a live session unused this long | SR 3.3 |
| `parkedToolTtlMs` | | 1800000 | Cancel a turn parked on OpenCode this long | SR 3.3 |
| `cancelSettleMs` | | 15000 | Wait for a cancelled prompt's reply | SR 3.5 |
| `stallTimeoutMs` | `OPENCODE_ANTIGRAVITY_STALL_MS` | 180000 | Silence without retry evidence | SR 6.4 |
| `retryStallTimeoutMs` | | 300000 | Silence while agy logs retries | SR 6.4 |
| `statusNoteAfterMs` | | 20000 | First waiting note | SR 6.3 |
| `statusNotes` | | `true` | Status notes in `reasoning_content` | SR 6.3 |
| `breakerCooldownMs` | | 30000 | Fail fast after 3 early exits | SR 3.4 |
| `processPerSession` | | `false` | Pass `--process-per-session` | SR 5 |
| `sessionStore` | | `true` | Persist bindings | SR 4.8 |
| `resumeAfterRestart` | | `true` | `session/resume` for dormant bindings; flips to `false` if smoke test 11.3 step 3 fails | SR 4.5 |
| `sessionTtlDays` | | 14 | Prune bindings older than this | SR 4.8 |
| `maxStoredSessions` | | 500 | Prune beyond this count per profile | SR 4.8 |
| `steering` | | `true` | Steer a parked turn with new user input | SR 4.6 |
| `maxSystemPromptBytes` | | 32768 | Base system budget | SR 7.2 |
| `maxToolsPromptBytes` | | 49152 | Tool lines budget | SR 7.3 |
| `replayMaxChars` | | 600000 | Replay cap before the per-model limit | SR 4.7 |
| `toolGuardHook` | | `true` | `PreToolUse` guard in a plugin-owned profile; `false` removes it | SR 7.4 |
| `debug` | | `false` | Metadata logs to stderr | SR 10 |
| `debugContent` | | `false` | Also log truncated content | SR 10 |

`index.ts` calls `resolveInstallAuthConfig` and `resolveRuntimeConfig` and logs the issues of both once. Env booleans accept `1`, `true`, `yes`, `0`, `false`, `no`, case-insensitive (IA 3); `config.ts` uses the same parser.

## 5. Work packages

Five packages. WP-0 comes first and is small. WP-A and WP-B run in parallel and touch disjoint files; WP-B splits into B1 and B2 so the second implementer is not idle while the first does install/auth. WP-C joins everything. No file is owned by two packages; a package may read another's files and import their exports, never edit them.

### WP-0 Contracts (one person, first)

| Owns | Content |
| --- | --- |
| `src/contracts.ts` | Every type in 2.1, plus `RequestPlan`, `FreshReason`, `BindingRecord`, `SessionStoreApi`, `SessionAppend`, `ProviderFailure`, copied from SR 4.3, 4.8, 6.6, 7.1 |
| `src/auth/errors.ts` | Error classes, `AUTH_URL_STDOUT_PREFIX`, texts, `isSignInRequired` (IA 15.1). Needed by both halves early |
| `test/fixtures/mock-agy.ts` | Fake agy with the base protocol: `initialize` with identity fields and switches (IA 15.3 item 8), `authenticate`, `session/new`, `session/prompt`, `session/cancel`, journal file, scenario flag. After WP-0 it belongs to WP-B1 |
| `test/fixtures/fake-bridge.ts` | In-memory `InstallAuthBridge` for runtime tests. After WP-0 it belongs to WP-B1 |
| `test/contracts.test.ts` | `isSignInRequired` cases from IA 15.1; the fake bridge satisfies the interface (type-check) |

Done when `bun run type-check` and `bun test test/contracts.test.ts` pass.

### WP-A Install and auth (implementer 1)

| Owns | Proved by |
| --- | --- |
| `src/install/*.ts` (all of 1.2) | `test/install-manifest.test.ts`, `install-download.test.ts`, `install-extract.test.ts`, `install-lock.test.ts`, `install-platform.test.ts`, `install-release.test.ts`, `install-resolve.test.ts` |
| `src/auth/constants.ts`, `methods.ts`, `settings.ts`, `login.ts`, `probe.ts`, `logout.ts`, `epoch.ts`, `manager.ts` | `test/auth-login.test.ts`, `auth-logout.test.ts`, `auth-manager.test.ts`, `auth-probe.test.ts`, `test/config.test.ts` (install keys only), `test/install-env.test.ts` (the `buildAgyEnv` and `agyBaseArgs` cases IA 17.1 lists under `plugin.test.ts`), `test/auth-settings.test.ts` (the `updateProfileSettings` cases) |
| `test/fixtures/mock-agy-login.ts` | Fake for `--login`, `logout` and probe flows |
| `test/e2e-install.test.ts` | Opt-in, `AGY_E2E=1` |

`AuthManager` is tested against a fake `RuntimeControl` and a fake `CreateRunDir` that returns `RunDir` handles. Specs: IA sections 3 to 15, 17.

### WP-B1 Runtime core (implementer 2)

| Owns | Proved by |
| --- | --- |
| `src/config.ts`, `constants.ts`, `agy-process.ts`, `acp-client.ts`, `tmp-sweeper.ts`, `mcp-bridge.ts`, `turn.ts`, `errors.ts`, `stall-watchdog.ts`, `agy-log-tail.ts`, `turn-outcome.ts`, `events.ts`, `proxy.ts`, `models.ts`, `bun-env.d.ts` | `test/unit/agy-process.test.ts`, `acp-client.test.ts`, `tmp-sweeper.test.ts`, `mcp-bridge.test.ts`, `stall-watchdog.test.ts`, `agy-log-tail.test.ts`, `turn-outcome.test.ts`, `errors.test.ts`, `events.test.ts` |
| `test/fixtures/mock-agy.ts` (from WP-0 on), `test/fixtures/fake-bridge.ts` | `test/e2e/concurrency.test.ts`, `crash.test.ts`, `stall.test.ts`, `idle.test.ts`, `tools-multi.test.ts`, `abort.test.ts`, `auth-bridge.test.ts`, `privacy.test.ts` |

`AntigravityProxy` takes its session logic by injection: `new AntigravityProxy({ bridge, config, classify, store, buildAppend, buildReplay, profile })`, typed by `contracts.ts`. B1's tests pass a stub (every main request is `fresh` unless it resumes a parked turn, bindings in memory). `index.ts` passes B2's real modules, so nobody edits `proxy.ts` to connect them. That is enough for every B1 e2e test except session reuse. Specs: SR 3, 5, 6, 8, 9.

### WP-B2 Sessions and prompt (implementer 1, after WP-A, or a third person)

| Owns | Proved by |
| --- | --- |
| `src/fingerprint.ts`, `session-store.ts`, `replay.ts`, `prompt.ts`, `profile.ts` | `test/unit/fingerprint.test.ts`, `session-store.test.ts`, `session-store-lock.test.ts`, `replay.test.ts`, `prompt.test.ts`, `system-prompt.test.ts`, `tool-guard.test.ts` |
| | `test/e2e/session-reuse.test.ts`, `test/e2e/profile.test.ts` (they construct B1's `AntigravityProxy` with B2's modules injected; they only import B1's files) |

These are pure modules plus file I/O, testable without a process. `tool-guard.test.ts` covers both the guard script and `allowPermission`'s matching function, which lives in `profile.ts` as `matchMcpPermission(params, turn)` and is imported by `proxy.ts`. Specs: SR 4, 7.

### WP-C Integration (one person, last)

| Owns | Proved by |
| --- | --- |
| `src/index.ts` (injects B2's modules into the proxy); deletes `src/binary.ts`, `src/auth.ts`, `test/e2e-proxy.test.ts` (its cases move into WP-B1's e2e files, IA's gate cases into `test/e2e/auth-bridge.test.ts` through a WP-B1 change request) | `test/plugin.test.ts` (registration: no `settings.apiKey`, method id, zero methods on config issue, hook headers, event loop wiring, pool reload waits for an async stop) |
| `README.md` | |
| `test/real-agy.smoke.test.ts` | Opt-in, SR 11.3; its results decide the hook tool name, the resume default and the MCP fallbacks |

Then `bun run type-check`, `bun run test`, `bun run build`.

### Order and parallelism

```
WP-0 ──┬──► WP-A (implementer 1) ──► WP-B2 (implementer 1) ──┐
       └──► WP-B1 (implementer 2) ────────────────────────────┴──► WP-C
```

| Package | Depends on | Shares files with |
| --- | --- | --- |
| WP-0 | nothing | none |
| WP-A | WP-0 types and `auth/errors.ts` | none |
| WP-B1 | WP-0 | none; uses the fake bridge until WP-C |
| WP-B2 | WP-0; its e2e tests need B1's `proxy.ts` | none |
| WP-C | all | none |

A change one package needs in a file another package owns goes to that owner as a request, never as a direct edit.
