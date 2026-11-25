# Sessions and runtime design

Status: design, ready to implement. Scope: decisions Q2 to Q5 (session mapping, shared process, stall handling, system prompt and tool guard). Install, binary download and sign-in are designed in `docs/design-install-auth.md`; this document only states what it needs from that design.

Constraints that hold for every part below:

- All changes stay inside `plugins/opencode-antigravity`.
- No new npm dependencies. Bun and Node built-ins only (`node:fs`, `node:crypto`, `node:child_process`, `bun:sqlite` with a `node:sqlite` fallback).
- Nothing logs tokens, MCP path secrets, prompt text, tool arguments or tool results unless the user sets `debugContent: true`. `debug: true` logs metadata only: ids, sizes, counts, timings, state transitions.

## 1. What was verified, and where

| Fact | Source |
| --- | --- |
| agy 1.5.15 is the installed build | `~/.t3/tools/antigravity-acp/darwin-arm64/versions/*/.install-complete.json` |
| `agy acp` flags: `--log-file`, `--process-per-session`, `--include-default-customizations`, `--agent`, `--gemini-dir`, `--app-data-dir` | `antigravity acp --help` |
| ACP `session/resume` exists since 1.5.0 and "restores a session without replaying its history". Each session keeps its own model and thinking level. Sending another `session/prompt` during a running prompt steers it | changelog embedded in the binary (`strings`), entry for 1.5.0 |
| Initialize advertises `loadSession`, `sessionCapabilities.{resume,close,list,fork}`, `mcpCapabilities`, `promptCapabilities`, `_meta.antigravity.systemPrompt.append` | Go struct tags in the binary; T3 Code reads `agentCapabilities._meta.antigravity.systemPrompt.append === true` |
| Since 1.5.13 model retries are silent over ACP: "the chat shows an error only when every retry fails" | changelog 1.5.13 |
| agy writes retries to its log file as `I1124 10:09:02.372424  669 run.go:308] Run: attempt 2 failed (transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-hydrogen-xhigh on the server: ...), retrying in 57.16798293s`. The line has no session id | T3 Code's agy profile logs, `.../providers/antigravity/<key>/antigravity-acp/log/acp-server-<ts>-<pid>.log` |
| Observed backoff: attempt 1 waits about 4 s, attempt 2 waits 10 to 30 s, later attempts about 60 s each. Attempts up to 8 were seen (248 first failures, 103 second, 36 third, 12 fourth). The TUI string `Model unavailable (attempt 2/10), retrying in 12s` suggests a cap of 10 attempts | same logs, binary strings |
| agy has its own `stream idle timeout (10m0s)` on model streams, then retries | same logs |
| When every retry fails, agy reports the API error as a chat message and `end_turn`, and writes an error step (`step_type = 17`) to `<gemini>/antigravity-acp/conversations/<sessionId>.db`, table `steps`. Payload text matches `Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)`, quota exhaustion matches `reason:QUOTA_EXHAUSTED` | T3 Code `AntigravityTurnOutcome.ts` in `app.asar` |
| T3 Code runs a 15 minute no-output watchdog per prompt. Activity is only content updates (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, ...). The watchdog pauses while a tool or permission request is pending, checks in 60 s slices, tolerates host sleep, and on expiry fails the turn with "Antigravity sent nothing for 15 minutes, so T3 Code stopped the turn and restarted the agent. Send a message to continue." It also restarts the agy process | T3 Code `AcpAdapterV2.watchPromptInactivity`, `retireInactivePrompt` |
| T3 Code resumes Antigravity sessions with `session/resume` (`resumeMethod: "resume"`), passes the same `_meta.antigravity.systemPrompt.append` on new, load and resume, and falls back to a fresh session when resume fails | T3 Code `AcpSessionRuntime`, `makeAntigravityAcpRuntime` |
| T3 Code gives each agy instance a private TMPDIR under its state dir with per-run `run-*` subdirs removed on release, and at startup renames leftovers to `<dir>.old-*` and deletes them in the background. It does the same for `<profile>/antigravity-acp/tmp` | T3 Code `retireAntigravityRuntimeTempDirs` |
| Hooks live in `hooks.json` in a customization root. The global root is `<gemini-dir>/config/` (the prototype's custom agent in `config/agents/` already loads from there). `PreToolUse` handlers get JSON on stdin with `toolCall.{id,name,args}` and print `{"decision":"allow"|"deny"|"ask"|"force_ask","reason":...}`. `allow` skips the permission prompt. Command runs via `sh -c` (Unix) or `cmd /c` (Windows) with cwd set to the directory holding `hooks.json`, default timeout 30 s. Matcher is a regex on the tool name, which is the step type lowercased without `CORTEX_STEP_TYPE_` | hooks docs embedded in the binary |
| The MCP step type is `CORTEX_STEP_TYPE_MCP_TOOL`, so a hook may see the MCP tool as `mcp_tool` and not `call_mcp_tool` | binary strings |
| OpenCode 2.3.0 retries `RateLimit`, `ProviderInternal` (any HTTP status >= 500, 408, 409) and `UnknownProvider`. `QuotaExceeded` (402, or 429 whose text matches `quota exceeded`, `usage limit`, `limit exhausted`, `insufficient quota`), `Authentication` (401, 403) and `Timeout` are not retried. Header `x-should-retry: true|false` overrides. Up to 10 retries, exponential from 2 s capped at 10 s spacing, jittered, raised to `retry-after` up to 15 min. A mid-stream SSE event `{"error":{"code":<number>,"message":...}}` is classified with `status = code`. A retry after output started keeps the failed assistant message and starts a fresh one | `@opencode/ai@2.3.0` `provider-error.js`, `schema/errors.js`, `protocols/openai-chat.js`; `@opencode/core@2.3.0` chunks `app-2fc7eemy.js`, `app-cg4g5y95.js` |
| OpenCode provider timeouts: `headerTimeout` 5 min, `chunkTimeout` 15 min. The `openai-compatible` route this plugin registers runs through `@opencode/ai` `route/transport/http.js`, which applies the chunk timeout to the raw response bytes before SSE framing, so `: ping` comments reset it. A header or chunk timeout is a `TransportError` with `code: "Timeout"`, retried up to 3 times (`MAX_TIMEOUT_RETRIES`) | `@opencode/core@2.3.0` `app-gmxz9m62.js`, `app-2fc7eemy.js`; `@opencode/ai@2.3.0` `route/transport/http.js` lines 55 to 80 |
| OpenCode 2.x keeps the system prompt stable: built-in instructions (date, environment) render an `initial` text once and a `changed` text later. The OpenAI chat protocol joins all system parts into one `{ role: "system", content }` message when no cache control is set (the `openai-compatible` case). Mid-conversation system updates are lowered into user messages, merged into the previous user message when it is a plain string | `@opencode/core` `app-ec4qt37t.js`, `app-51cnt4a7.js`; `@opencode/ai` `openai-chat.js` lines 467 to 480, 517 to 569 |
| OpenAI chat lowering: user content parts are `text`, `image_url`, `video_url`, `file` (`filename`, `file_data`). A user message whose parts are all plain text without `cache_control` collapses to one string with `join("")`. Media returned by a tool (`file` items in a tool result) is emitted as a separate `role: "user"` message right after the tool messages. Reasoning is echoed back on later requests as `reasoning_content` once ingested from that field | `@opencode/ai@2.3.0` `openai-chat.js` lines 119 to 133, 372 to 376, 401 to 436, 440 to 452 |
| The `opencode` 2.3.0 executable is a compiled Bun 1.4.4 binary. With `BUN_BE_BUN=1` it runs a script as Bun: `BUN_BE_BUN=1 opencode -e '...'` printed `process.versions.bun = 1.4.4` | run on this machine |
| `Bun.serve` closes a connection idle for `idleTimeout` seconds (255 max). `server.timeout(req, 0)` disables it for one request (present in Bun 1.4.4) | `src/proxy.ts` line 192, run on this machine |
| OpenCode emits `session.deleted`, `session.forked`, `session.revert.committed`, `session.compaction.ended`, `session.execution.interrupted` | `@opencode/schema@2.3.0` |

Not found: the source of `@openchamber/opencode-claude`. It is referenced as `@openchamber/opencode-claude@^0.4.0` in `packages/ui/src/components/sections/plugins/pluginDisplayName.test.ts`, but no copy exists under `~/Documents/src/oc`, `~/.bun/install/cache`, `~/.cache/opencode`, `~/.local/share/opencode` or `~/.config/opencode`. The fingerprint scheme below is designed from first principles. When that source becomes available, compare its canonicalization rules with section 4.2 before shipping.

Not verified against the real binary (needs the opt-in smoke test in section 11.3): whether `hooks.json` loads with `--include-default-customizations=false`, which tool name the hook sees for MCP calls, whether `session/resume` honours `_meta.antigravity.systemPrompt.append`, steering while an MCP call is in flight, whether the custom agent gets `call_mcp_tool` when MCP servers come only from `session/new`, whether agy's MCP HTTP client has its own per-call timeout, and the exact `session/request_permission` payload for an MCP call.

Settled by the user (`docs/decisions.md`): resume first with replay as fallback; description-only tool changes keep the session and add a note; defaults 10 min idle stop, 20 s status note, 180 s silence stall, 300 s stall while agy logs retries.

## 2. Module layout

New and changed files under `src/`. `proxy.ts` keeps HTTP routing and orchestration; everything with its own state machine moves out.

| File | Status | Exports | Responsibility |
| --- | --- | --- | --- |
| `config.ts` | new | `resolveRuntimeConfig(options, env): RuntimeConfig` | Defaults and env overrides from section 10 |
| `agy-process.ts` | new | `AgyProcessManager`, `ProcessState`, `Lease`, `ExitInfo` | One shared `agy acp` process: spawn, leases, idle stop, crash handling, breaker |
| `acp-client.ts` | changed | `AcpClient` gains `capabilities`, `agentVersion`, `resumeSession`, `closeSession`, `gracefulClose`, per-request timeouts, `onActivity`; raises `SignInUrlLineError` (from `auth/errors.ts`) on the stdout auth-URL line | JSON-RPC over stdio for one process generation |
| `mcp-bridge.ts` | changed | `McpBridge` with per-scope registries: `openScope(tools): McpScope`, `closeScope(id)`, `handleRequest(req, scopeId, server)` | Streamable HTTP MCP endpoint; one tool registry per ACP session; observes `req.signal` |
| `tmp-sweeper.ts` | new | `createRunDir(kind): Promise<RunDir>`, `RunDir { path, release() }`, `sweepStaleRunDirs`, `OwnerRegistry` | Private TMPDIR per run and cleanup after crashes |
| `events.ts` | new | `runEventLoop(ctx, handlers, signal)` | OpenCode event subscription (`AsyncIterable`) for session events, deduplicated across locations |
| `session-store.ts` | new | `SessionStore`, `BindingRecord`, `BindingLock` | Persisted OpenCode session to ACP session mapping |
| `fingerprint.ts` | new | `canonicalizeMessages`, `messageFingerprint`, `chainHash`, `classifyRequest`, `RequestPlan` | Decide reuse, resume, steer or fresh |
| `replay.ts` | new | `buildReplayPrompt(messages, budget)` | Structured history replay for fresh sessions (moves out of `prompt.ts`) |
| `prompt.ts` | changed | `buildSessionAppend`, `extractLeadingSystem`, `buildToolsSection`, `toolsSchemaHash`, `toolsDescriptionHash`, `buildTurnPrompt` | System prompt append with budgets, per-turn prompt blocks |
| `turn.ts` | new | `Turn`, `TurnPhase`, `TurnOutcome` | One ACP prompt across one or more HTTP requests: sinks, parked calls, settle window |
| `stall-watchdog.ts` | new | `StallWatchdog`, `Clock` | Per-turn silence timer, status notes, stall decision |
| `agy-log-tail.ts` | new | `AgyLogTail`, `parseRetryLine`, `parseGoDuration` | Tail agy's log file for retry lines |
| `turn-outcome.ts` | new | `readTurnErrorStep(geminiDir, sessionId, afterIdx)`, `lastStepIndex` | Read agy's conversation DB error step, read-only |
| `errors.ts` | new | `ProviderFailure`, `toHttpError`, `toStreamError`, `mapAcpError` | One mapping from failures to HTTP status or mid-stream error, tuned to OpenCode's classifier (moves `mapErrorToHttpStatus` out of `proxy.ts`) |
| `profile.ts` | new, from `binary.ts` | `prepareProfileDir`, `writeToolGuardHook`, `removeToolGuardHook`, `probeGuardRuntime`, `matchMcpPermission` (layer 3, 7.4) | Agent file, `toolPermission` setting, hooks, guard script. `isPluginOwnedProfile` comes from the auth design |
| `proxy.ts` | changed | `AntigravityProxy` | HTTP, the `/v1` gate, `/mcp/<token>/<scope>`, `/health`, request dispatch to the pieces above |
| `index.ts` | changed | default plugin | Pool sharing with async shutdown, event loop, lazy discovery, wiring of the install/auth bridge |
| `constants.ts` | changed | new defaults | Numbers in section 10 |

`binary.ts` and `auth.ts` are removed by the install/auth design (its section 16); `buildAgyEnv` sits behind the interface in section 9.

## 3. Process and session lifecycle

### 3.1 Process state machine

```
stopped --acquire()--> starting --initialize+authenticate ok--> ready
starting --spawn/initialize/authenticate error--> stopped   (error goes to every waiter)
ready --leases drop to 0--> ready(idle timer armed) --idleShutdownMs elapsed, still 0 leases--> stopping
ready(idle timer armed) --acquire()--> ready (timer cleared)
ready --binary changed--> draining --last lease released--> stopping
ready --unexpected exit--> stopped (crash path, 3.4)
ready|draining --stop(reason)--> stopping --exit or kill--> stopped
stopped --3 early exits within 120 s--> broken --breakerCooldownMs--> stopped
```

Transitions not shown are defined as follows:

| Call | In state | Effect |
| --- | --- | --- |
| `acquire()` | `starting` | Joins the running start |
| `acquire()` | `draining` | Waits until `stopped`, then spawns a new generation. Existing leases keep running on the old one, for at most `drainWaitMs` (30 s) after the first request started waiting; then the old one stops (`docs/decisions.md`, O-6) |
| `acquire()` | `stopping` | Waits until `stopped`, then spawns |
| `acquire()` | `broken` | Rejects with `breaker_open` (6.6) |
| `stop(reason)` | `stopped`, `broken` | Resolves at once |
| `stop(reason)` | `starting` | Marks the start cancelled; when it settles, the child is stopped and waiters get `agy_exited` (or `auth_required` for `auth-changed` after logout) |
| `stop(reason)` | `stopping` | Returns the promise of the stop in progress. `stop` is idempotent and joinable; `AuthManager.logout` and `onAuthChanged` may both call it |
| `stop("auth-changed")` | `draining` | Same as from `ready`: does not wait for leases |

`AgyProcessManager` owns at most one child at a time and a monotonically increasing `generation`. Every ACP session id, listener and parked call is tagged with the generation it lives in. Anything from an older generation is dead by definition.

```ts
export type ProcessState = "stopped" | "starting" | "ready" | "draining" | "stopping" | "broken";
export type LeaseReason = "turn" | "discovery" | "login" | "close";
export interface Lease { readonly generation: number; release(): void }
export interface ExitInfo { generation: number; code: number | null; signal: string | null; expected: boolean; uptimeMs: number }

export class AgyProcessManager {
  constructor(opts: {
    config: RuntimeConfig;
    install: InstallAuthBridge;            // section 9
    allowPermission: (p: AcpPermissionParams, generation: number) => boolean;
    onExit: (info: ExitInfo) => void;
    clock?: Clock;
  });
  get state(): ProcessState;
  get generation(): number;
  get client(): AcpClient | null;          // null unless ready
  acquire(reason: LeaseReason): Promise<{ client: AcpClient; lease: Lease }>;  // spawns if needed
  hold(reason: "login"): Lease;            // keeps the process from idling out, never spawns
  stop(reason: "idle" | "auth-changed" | "binary-changed" | "wedged" | "shutdown"): Promise<void>;
}
```

### 3.2 Spawn

1. `install.beforeSpawn()` (section 9). It waits while a logout or login finalization runs and rejects with a sign-in error while signed out after logout; that maps to 401 `auth_required`.
2. `install.resolveBinary()` gives `{ path, version }`. It may download; `install.binaryStatus()` feeds the download notes (6.3). A missing binary maps to `binary_not_found` (6.6).
3. `createRunDir("runtime")` makes `<os.tmpdir()>/opencode-antigravity/run-<ownerPid>-<startMs>-<rand6>` (mode 0700), writes `owner.json` with `{ pid, startedAt, poolId, kind }`, and returns a `RunDir` handle that stays in the process's live set until `release()` (3.6). `sweepStaleRunDirs()` runs in the background first.
4. Environment from `install.buildSpawnEnv({ tmpDir })`, unmodified. TMPDIR, TEMP, TMP point at the run dir.
5. Args: `agyBaseArgs(geminiDir)` from the auth design (`acp --gemini-dir <g> --app-data-dir antigravity-acp`), plus `--include-default-customizations=false --disable-telemetry --agent opencode-bridge --log-file <g>/antigravity-acp/log/opencode-<yyyymmddThhmmss>-<ourPid>-<generation>.log`, plus `--process-per-session` when configured. The log path is always passed, so the log tail knows the file. The child cwd is the plugin data dir; each session carries its own cwd.
6. `initialize` with a 30 s timeout, then `authenticate` with the configured method and a 60 s timeout. Success calls `install.reportAuthenticated()`. A sign-in error (`install.isSignInRequired(err)`, which includes `SignInUrlLineError`) calls `install.reportSignInRequired(SIGNED_OUT_MESSAGE)`, kills this generation and fails waiters with 401. `AcpClient` raises `SignInUrlLineError` when a stdout line starts with `AUTH_URL_STDOUT_PREFIX` (`Open the following link to authenticate the ACP server: `), so `authenticate` fails at once and does not wait out its timeout. Keep `initializeResult.agentInfo.version` and the capability flags: `canResume = sessionCapabilities.resume != null`, `canClose = sessionCapabilities.close != null`, `appendsSystemPrompt = _meta.antigravity.systemPrompt.append === true`, `steers = version >= 1.5.0`.
7. Every later RPC has a timeout: `session/new`, `session/resume`, `session/set_config_option`, `session/close` 30 s each; `session/prompt` none (the watchdog covers it). A timeout rejects the RPC with `AcpTimeoutError` and counts toward the wedged check (3.5). A sign-in error from any RPC takes the same path as in step 6.
8. Streaming requests start the SSE stream if steps 1 to 6 have not finished after 2 s, and send `: ping` every 15 s from then on, whether or not status notes are on. With notes on, the start note or the download note goes out (6.3). This keeps both `Bun.serve` and OpenCode's 5 min header timeout out of play during a first download.

### 3.3 Leases and what idle means

The process is idle when it holds zero leases. Leases:

| Holder | Taken | Released |
| --- | --- | --- |
| Turn | by the request handler, before any session setup (`session/new`, `session/resume`, `set_config_option`) | when the turn reaches `done`, including after a parked turn is reaped; in a `finally` when setup fails before a `Turn` takes the lease over. One lease covers setup and prompt, so there is no zero-lease gap between them |
| Discovery | around model discovery | when discovery settles |
| Close | around `session/close` | when the RPC settles |
| Login | `hold("login")` from the auth design | when login ends |

A turn parked on an OpenCode tool call holds its lease. agy has a `session/prompt` in flight and an open MCP HTTP request; stopping the process would lose the turn.

HTTP connection lifetimes. `Bun.serve` runs with `idleTimeout: 255`, which would close a parked MCP `tools/call` request (no bytes flow until OpenCode posts the result) and a non-streaming chat completion after 255 s. The proxy calls `server.timeout(req, 0)` for every `/mcp/<token>/<scope>` request and every non-streaming `/v1/chat/completions` request. Streaming chat requests keep the default and stay alive through `: ping`. `McpBridge` listens to `req.signal`: if agy drops a parked `tools/call` (its own timeout, or a crash), the parked call is removed, the turn is cancelled (3.5) and the binding tainted, so the tool result OpenCode posts later goes through a fresh session with replay (4.3 step 8). If the smoke test (11.3) shows agy's MCP client times out calls before `parkedToolTtlMs`, `tools/call` answers with `content-type: text/event-stream` (allowed by Streamable HTTP), sends a `: keepalive` comment every 15 s, and writes the JSON-RPC result as one `data:` event when the call resolves. The parked TTL (`parkedToolTtlMs`, default 30 min, lowered from 60) bounds this: the reaper cancels the turn, releases its lease, and the binding is tainted so the late tool result goes through a fresh session (section 4.5). After that the idle timer can start.

Idle stop: when leases hit 0, arm `idleShutdownMs` (default 10 min). Any `acquire` clears it. When it fires with still 0 leases, `stop("idle")`:

1. Mark every live binding `dormant` (persisted, ACP id kept for resume).
2. End stdin; wait up to 5 s for exit (agy 1.5.3 waits for its backend to finish saving on stdin close). Then SIGTERM, wait 3 s, then SIGKILL.
3. Remove the run dir in the background (rename to `trash-*` first so a slow delete never blocks a respawn).
4. State `stopped`. The next `acquire` spawns a new generation.

Model discovery no longer spawns the process at plugin setup. It runs when the process is already ready and the last discovery is older than `DISCOVERY_INTERVAL_MS`, or once after the first spawn of the day. Cached models serve the catalog otherwise. Without this, every OpenCode start would unpack the runtime just to list models.

Sessions idle inside a live process: a binding without a turn for `sessionIdleCloseMs` (default 30 min) gets `session/close` when `canClose`, which frees agy memory. The binding stays `dormant` and resumes later.

### 3.4 Crash

On unexpected exit of generation G (exit while `ready` and not `stopping`):

1. Reject all pending RPCs of G with `AgyExitedError(code, signal)`.
2. For every turn in G: phase `failed(crash)`. Streaming sinks get a mid-stream error `{"error":{"code":503,"type":"antigravity_exited","message":"Antigravity CLI stopped unexpectedly (exit 137). Retrying restarts it."}}`, which OpenCode classifies as `ProviderInternal` and retries. Unattached turns keep the error for the next request that attaches.
3. Parked MCP calls of G: reject their promises and drop them from `turnsByToolCallId`. Their HTTP requests belong to the dead child and need no answer. The turn keeps `emittedToolCalls` so the binding knows which tool results OpenCode will post.
4. Every binding live in G: `tainted` with reason `crash` (history inside agy for the interrupted turn is unknown). Bindings that were `dormant` in G stay `dormant`.
5. Breaker: record the exit time. An early exit is an exit within 120 s of spawn, from `starting` or `ready`, that was not requested; an exit after a classified sign-in error does not count. Three early exits inside a 120 s window set `broken` for `breakerCooldownMs` (30 s). Requests during `broken` get HTTP 503 with `retry-after: 30` and the message `Antigravity CLI keeps exiting right after start. Check the Antigravity sign-in and the log in <gemini>/antigravity-acp/log.`
6. The run dir is removed in the background.
7. No eager respawn. The next request spawns generation G+1.

Exit while `starting` rejects the start promise; waiters get the mapped error (401 for sign-in, 503 otherwise), and the exit counts toward the breaker.

`process.once("exit")` runs synchronous cleanup only: SIGTERM to the child, `unlinkSync` of this pool's `owners/<pid>.json` and of every binding lock it owns (after checking `poolId`, 4.8). The plugin registers no signal handlers. A killed OpenCode leaves the run dir behind; the sweeper removes it next time. agy exits on its own when its stdin closes.

### 3.5 End-to-end sequence of one tool turn

```
OpenCode                  Proxy                         agy (generation G)          MCP bridge
   | POST /chat (user)      |                              |                          |
   |----------------------->| classify -> fresh/append     |                          |
   |                        | acquire("turn")  ----------->| (spawn if stopped)       |
   |                        | session/new or resume ------>|                          |
   |                        | set_config_option(model) --->|                          |
   |                        | session/prompt ------------->|                          |
   |<-- SSE reasoning/text -|<-- session/update chunks ----|                          |
   |                        |                              |-- tools/call(read) ----->| park
   |                        |<-- (settle 250 ms) ----------------------------------------|
   |<-- tool_calls, stop ---| phase parked, sink closed    |   (prompt in flight)     |
   | runs tool              |                              |                          |
   | POST /chat (+tool msg) |                              |                          |
   |----------------------->| classify -> resume           |                          |
   |                        | resolve parked ------------------------------------------>| 200 result
   |<-- SSE continuation ---|<-- session/update chunks ----|                          |
   |                        |<-- prompt result end_turn ---|                          |
   |                        | turn-outcome check (DB)      |                          |
   |<-- finish stop, usage -| binding.lastTurn=ok, persist |                          |
   |                        | release lease                |                          |
```

MCP requests go to `/mcp/<token>/<scopeId>`, where `scopeId` is a random id per ACP session (4.4). The diagram leaves it out.

Cancel: `session.execution.interrupted` from OpenCode, a client abort of a streaming request, a superseding request, the stall watchdog, an aborted parked MCP request, or the parked reaper. Steps: phase `cancelling`, send `session/cancel`, resolve every parked MCP call with `isError: true` and text `The OpenCode tool call was cancelled.`, wait up to `cancelSettleMs` (15 s) for the `session/prompt` reply (`stopReason: "cancelled"`), then `done(cancelled)`. The turn keeps its lease while `cancelling`.

If the reply never comes within `cancelSettleMs`, the turn becomes `abandoned`: listener removed, lease released, binding tainted, and the ACP session id is never prompted again. The pool counts abandoned turns in `abandonedTurns` and records `lastRpcSettledAt` (any reply or notification from agy updates it). A 30 s check timer runs while `abandonedTurns > 0`: when `abandonedTurns >= 1` and no RPC has settled for `stallTimeoutMs`, or when `abandonedTurns >= 3` within 10 min, the process is wedged: `stop("wedged")`, and every remaining turn takes the crash path. The counter resets with each new generation.

### 3.6 TMPDIR cleanup

Layout:

```
<os.tmpdir()>/opencode-antigravity/          0700, created once
  run-<pid>-<startMs>-<rand6>/               TMPDIR of one agy generation
    owner.json                               { pid, startedAt, poolId, kind }
  trash-<rand>/                              renamed leftovers being deleted
```

```ts
export type RunDirKind = "runtime" | "login" | "probe" | "logout" | "verify";
export interface RunDir { readonly path: string; release(): Promise<void> }  // release renames to trash-* and deletes in the background
export function createRunDir(kind: RunDirKind): Promise<RunDir>;
```

Every `RunDir` that has not been released is in an in-memory `liveRunDirs` set (process-global, `Symbol.for("openchamber.opencode-antigravity.rundirs.v1")`). Login, probe, logout and verify children from the auth design use the same function.

`sweepStaleRunDirs()` runs before each spawn, in the background, and never throws:

- `run-*` whose pid is ours: delete only when its path is not in `liveRunDirs` (a leftover from a reloaded plugin instance). A live login, probe or runtime dir is never touched.
- `run-*` whose pid is not alive (`process.kill(pid, 0)` throws `ESRCH`): delete. `EPERM` counts as alive.
- `run-*` older than 7 days whatever the pid says (pid reuse): delete.
- `trash-*`: delete.
- Prototype leftovers `opencode-agy-run-*` and `opencode-agy-login-*` directly under `os.tmpdir()` with mtime older than 24 h: delete. They carry no pid, and the login abandon timer is 5 min, so 24 h never hits a live login.
- agy's own `<gemini>/antigravity-acp/tmp`: retire (rename to `<dir>.old-<rand>`, then delete) only when `OwnerRegistry` shows no other live process using this gemini dir. The registry is `<dataDir>/owners/<pid>.json` written at pool start and removed at pool stop; entries with dead pids are ignored and removed.

Deletion is rename-then-delete, so a respawn never waits on removing about 1 GB. On Windows, files in use fail to delete; the error is ignored and the next sweep retries.

### 3.7 Concurrency

One process hosts many ACP sessions. Every notification and request from agy carries a session id (`session/update`, `session/request_permission`) or the conversation id (`tools/call` `_meta["antigravity.google/conversation_id"]`), so routing is by id: `turnsByAcpSession`, `turnsByToolCallId`. JSON-RPC requests over stdio are matched by id, so concurrent prompts need no extra locking at the transport.

Per OpenCode session, a `KeyedMutex` serializes the decision part of a request. Order inside the mutex: classify, then register a `Turn` in phase `dispatching` on the binding (before any await on spawn, download or session setup), then release the mutex. Session setup and the prompt run outside the mutex. A second request, an interrupt or `session.deleted` therefore never waits minutes behind a first download; it sees the registered turn and acts on it (the table below). Interrupt and delete handlers do not take the mutex at all: they act on the registered turn directly.

| Situation | Behavior |
| --- | --- |
| Two OpenCode sessions at once | Two bindings, two ACP sessions, two turns, independent watchdogs. Both can be parked at once; results resolve in any order by tool call id |
| Same session, tool results for the parked calls | Resume (4.4) |
| Same session, tool results plus new user messages | Resume, then steer (4.6) |
| Same session, request that does not continue the parked turn (edit, revert, unrelated history) | Cancel the parked turn, taint, fresh session |
| Same session, meta request (`x-antigravity-kind` title, compaction or generate) while a turn is parked | Runs in its own ephemeral session; does not touch the binding |
| Same session, a main request while the live turn is `dispatching`, `awaiting_model` or `streaming` | OpenCode only does this after it gave up on the first response (abort, retry). Cancel the live turn (3.5), wait for it to leave `cancelling` (at most `cancelSettleMs`), then classify against the now tainted binding, which gives `fresh` |
| Same session, a main request while the live turn is `cancelling` | Wait for it to finish, then classify |
| Same session, two main requests racing | The mutex orders them; the second sees the turn the first registered |
| Partial tool results (some emitted parked ids missing) | Only calls with `emitted: true` count. Missing emitted ones resolve with `isError: true`, text `OpenCode returned no result for this tool call.` The prototype's 409 goes away: OpenCode classifies 409 as retryable and would loop |
| Parked calls OpenCode has not seen yet (`emitted: false`, agy called them after the settle window closed the first batch) | The resume request resolves the answered calls, then marks the unemitted ones `emitted: true`, adds them to `emittedToolCalls`, answers with a `tool_calls` response for them and stays `parked`. It does not return to `awaiting_model` until every emitted call is answered |

## 4. Session mapping (Q2)

### 4.1 Binding state machine

```
(none) --first request--> live(fresh)
live --turn running--> live(turn) --turn ok--> live(idle)
live(turn) --clean no-output failure (below)--> live(idle), lastTurn.outcome = failed_no_output
live(turn) --any other failure or cancel, abandoned cancel, or crash--> tainted
live(idle) --sessionIdleCloseMs, or idle stop, or process exit while idle--> dormant
dormant --next request, append-only--> session/resume --ok--> live(idle) --> prompt
dormant --resume fails--> fresh
tainted --next request--> fresh
any --history diverges, system/tools schema change, cwd change, auth epoch change--> fresh
any --session.deleted, TTL, count cap--> removed
```

A failed turn leaves the binding `live(idle)` with `lastTurn.outcome = "failed_no_output"` only when all three hold:

1. the turn was dispatched from an `append` or `redo` plan (never `resume` or `fresh`);
2. the turn produced no text, no thought chunk from the model and no tool call (status notes are ours and do not count);
3. its `session/cancel` settled within `cancelSettleMs`, or the prompt ended on its own with an error.

Every other failure or cancel taints the binding, including any stall after tool results were resolved, any cancel that timed out, and any failure after output started.

`fresh` means: `session/new` with the current system append, a structured replay of the whole history as the first prompt, and a new binding record that replaces the old one. The old ACP session gets `session/close` if it is live and the capability exists.

Requests without `x-antigravity-session` (no OpenCode session id, for example a direct `/v1/chat/completions` call) never read or write `SessionStore`. They run as ephemeral sessions: `fresh` every time, tool-call resume only in memory through `turnsByToolCallId`, `session/close` when the turn ends. The prototype's `anon:<hash of the first user message>` key goes away, since two unrelated sessions that start with "hi" would share it.

### 4.2 What is fingerprinted

Messages are canonicalized before hashing so that OpenCode's lowering differences between requests do not look like edits.

Canonical message: `{ r, t, m, c, k, n }`, serialized with sorted keys and no whitespace.

| Field | Rule |
| --- | --- |
| `r` role | `user`, `assistant`, `tool`, or `system` for system/developer messages after the leading run |
| `t` text | All text parts joined with `""`, which is what `openai-chat.js` does when it collapses plain text parts into a string. A string content and an array of text parts with the same text give the same `t`. `cache_control` and every other part field are dropped. Trailing whitespace on the whole text is trimmed |
| `m` media | For each non-text part in order: `img:` plus `sha256(base64 data)` first 16 hex for `image_url` data URLs, `imgurl:` plus sha256 of the URL otherwise; `file:` plus `filename` plus sha256 of `file_data`; `video:` plus sha256 of `video_url.url`. Unknown part types: `other:` plus `type` plus sha256 of the part JSON |
| `c` tool calls | Assistant only: `[{ id, name, args }]` in order, `args` re-serialized from `JSON.parse(arguments)` with sorted keys (raw string when it does not parse) |
| `k` tool call id | Tool messages only |
| `n` name | Tool messages only, when present |

Ignored: `reasoning_content`, `reasoning`, `reasoning_details`, `reasoning_opaque`, `refusal`, any provider metadata. Assistant messages whose text is empty and that have no tool calls are dropped before hashing (OpenCode drops them itself on some paths).

Tool-result media. A `user` message that directly follows tool messages and contains only media parts (no text) is the attachment message `openai-chat.js` emits for files a tool returned. Canonicalization keeps it as its own message for hashing, and classification treats it as part of `R` (4.3).

`messageFingerprint(m) = sha256(canonicalJson(m)).slice(0, 32)`.

`chainHash(fps, count) = fold over fps[0..count): h = sha256(h + ":" + fp)`, starting from `sha256("agy-binding-v1")`. The binding stores only `prefixCount` and `prefixHash`, so the record stays small for long sessions and a prefix check is one pass.

What the binding knows about its own last output, so an edited assistant message is caught:

| Field | Content |
| --- | --- |
| `lastTurn.emittedTextHash` | sha256 of all assistant text the proxy streamed for the last OpenAI response of the turn, canonicalized like `t`; null when none |
| `lastTurn.emittedToolCalls` | `[{ id, name, argsHash }]` for every tool call the proxy sent to OpenCode in the current turn, in order |

Other inputs that force a fresh session when they change:

| Input | Hash |
| --- | --- |
| Leading system section | `systemHash = sha256(final base-system text after budgeting)` (section 7). Only the leading run of system/developer messages counts; later system messages are conversation items |
| Tool schemas | `toolsSchemaHash = sha256(sorted lines "name\tcanonical(parameters)")` |
| Tool descriptions | `toolsDescHashes: Record<name, sha256(description).slice(0, 16)>`. A change alone does not force a fresh session (7.5) |
| Working directory | exact `cwd` string |
| Auth | `authEpoch` from the auth design |
| agy profile | `profileId = sha256(realpath(geminiDir)).slice(0, 16)` (part of the store path) |

Model and thinking level are not part of the identity: `session/set_config_option` switches them inside the live session.

### 4.3 Classification

`classifyRequest(binding, request, liveTurn) -> RequestPlan`:

```ts
export type RequestPlan =
  | { kind: "meta" }                                         // title, compaction, generate, or no tools
  | { kind: "ephemeral" }                                    // no session header
  | { kind: "resume"; results: ToolResult[]; media: MediaPart[]; steer: OpenAiMessage[] }
  | { kind: "append"; input: OpenAiMessage[]; reminders: string[] }
  | { kind: "redo"; input: OpenAiMessage[] }                 // same input again after a clean no-output failure
  | { kind: "fresh"; reason: FreshReason };
export type FreshReason =
  | "no-binding" | "prefix-mismatch" | "tail-mismatch" | "system-changed" | "tools-changed"
  | "cwd-changed" | "auth-changed" | "tainted" | "resume-failed" | "locked-elsewhere"
  | "store-disabled" | "superseded" | "steer-failed";
```

Steps, in this order:

1. `kind` header is title, compaction or generate, or `tools` is empty: `meta`. No session header: `ephemeral`.
2. Canonicalize, drop the leading system run, compute fingerprints `F`.
3. No binding: `fresh` (`no-binding`). Binding `authEpoch` or `cwd` differs: cancel any live turn, `fresh`.
4. A live turn in `dispatching`, `awaiting_model`, `streaming` or `cancelling`: handled before classification (3.7); after that the binding is tainted and step 6 applies.
5. Live turn `parked`:
   a. Prefix check as in step 7 against the prefix recorded at turn start. Mismatch: cancel the turn, `fresh`.
   b. Split the tail as in step 8. `A` must match `emittedToolCalls` of this turn (ids, names, `argsHash`); text in `A` must match `emittedTextHash` or be empty.
   c. `R` answers parked ids: `resume`, with `media` from tool-result media messages in `R` and `steer = U`. Tools, descriptions and system prompt of the request are not compared: a running turn keeps the set it started with (7.5).
   d. Otherwise cancel the turn, `fresh` (`tail-mismatch`).
6. Binding `tainted`: `fresh` (`tainted`).
7. `systemHash` or `toolsSchemaHash` differs: `fresh` (`system-changed`, `tools-changed`).
8. `F.length < prefixCount` or `chainHash(F, prefixCount) != prefixHash`: `fresh` (`prefix-mismatch`). This covers edits, reverts, compaction and any rewrite of earlier history.
9. Tail `T = messages[prefixCount..]`, split into `A` (leading assistant messages), `R` (tool messages after `A`, plus tool-result media messages directly after them), `U` (the rest).
   - `A.length <= 1`. Its tool calls must equal `lastTurn.emittedToolCalls` of the last response (id, name, `argsHash`, same order). Its text must canonicalize to `lastTurn.emittedTextHash`, or be empty when that is null. If the last response emitted nothing, `A` must be empty. Any difference: `fresh` (`tail-mismatch`). This catches an edited assistant message or an inserted one.
   - Every tool message in `R` must answer an id from `A`. Otherwise `fresh`.
   - `U` may hold user and system messages only. A tool or assistant message in `U`: `fresh`.
10. `R` non-empty with no live parked turn: the turn that emitted those ids is gone (crash, reaper, interrupt, dropped MCP request). That event tainted the binding, so step 6 caught it. If not (defensive), `fresh`.
11. `T` is empty and `lastTurn.outcome == "failed_no_output"`: `redo` with the input of the failed turn. This is OpenCode retrying the same step after our retryable error. Status notes are reasoning only, so if OpenCode echoes the failed assistant message it has no text and no tool calls, and canonicalization drops it.
12. `U` non-empty: `append` with `input = U` and `reminders` from tool description changes (7.5).
13. Anything else (for example `T` empty after a successful turn): `fresh` (`tail-mismatch`).

After `resume`, `append` or `redo` dispatch, the binding moves its prefix to cover every message of this request: `prefixCount = F.length`, `prefixHash = chainHash(F, F.length)`. Assistant messages produced by our own output are learned from the request that echoes them, after the step 5b or 9 check; they are never predicted.

### 4.4 Dispatch per plan

| Plan | ACP calls | Prompt blocks |
| --- | --- | --- |
| `append` on a live session | `set_config_option` if model or level changed, `session/prompt` | `buildTurnPrompt(U, reminders)`: system messages in `U` become `<system-update>...</system-update>` text blocks, user content keeps text, image and file parts, reminders come first |
| `append` on a dormant binding | `session/resume { sessionId, cwd, mcpServers, _meta }` (one retry after 500 ms on error), then as above | same |
| `resume` | none for the results; resolve each parked MCP call with the tool message content | none |
| `resume` with `media` | Images become MCP `{ type: "image", data, mimeType }` content items and other files become `{ type: "resource", resource: { uri: "opencode-attachment://<n>", mimeType, blob } }` items, appended to the result of the last tool call in `R` (OpenCode does not say which call produced which file). The smoke test checks that agy passes them to the model; if it does not, they become a text line `[The tool also returned <n> attachment(s): <filenames>. They could not be forwarded.]` | none |
| `resume` with `steer` | resolve, then steer (4.6) | steer text blocks |
| `redo` | `session/prompt` in the same session | the blocks of the failed turn, rebuilt from the request. agy's history then holds the user input twice around an error step; that costs a few tokens and keeps the cache warm |
| `fresh` | `session/close` for a live old id, `session/new { cwd, mcpServers, _meta }`, `set_config_option` | `buildReplayPrompt(messages)` (4.7) |
| `meta`, `ephemeral` | `session/new` (meta: no MCP servers and a text-only append), prompt, then `session/close` | replay of the whole request |

`_meta` is `{ antigravity: { systemPrompt: { append } } }` on new and resume, only when `appendsSystemPrompt` is true. When it is false, the append text is prefixed to the first prompt of a fresh session instead, and the binding records `appendInPrompt: true`; resume is then disabled for that binding because the instructions live only in history.

MCP is attached only per session. Each ACP session gets an `McpScope` from `mcpBridge.openScope(tools)` with a random `scopeId` and its own tool registry, so two sessions with different tool sets or different schemas for the same tool name never see each other's `tools/list`. `mcpServers` is `[{ type: "http", name: "opencode", url: "http://127.0.0.1:<port>/mcp/<mcpToken>/<scopeId>", headers: [] }]` on new and resume. A resumed session gets a new scope with the current port and token. `closeScope` runs on `session/close`, on taint and on process exit. A `tools/call` on an unknown scope answers `isError: true`. The scope also identifies the turn, so `_meta["antigravity.google/conversation_id"]` becomes a cross-check: a mismatch with the scope's ACP session id answers `isError: true`.

The agent file `config/agents/opencode-bridge.md` no longer declares `mcpServers`. With the URL in the file, a second OpenCode process sharing the gemini dir overwrote the first one's URL, the secret token sat on disk, and meta sessions inherited the server. Smoke test 11.3 checks that `call_mcp_tool` works with per-session servers only. If it does not, each pool writes its own agent `opencode-bridge-<poolId8>.md` (mode 0600, with a pool-level MCP URL whose scope is resolved by conversation id), passes that name to `--agent`, and deletes the file at pool stop; the sweeper removes files whose pool owner is dead.

### 4.5 When agy does not know the persisted id

`session/resume` fails with an ACP error (for example `Failed to read session <id>; retry, or load it with session/load`, `trajectory not found`), or the process lacks `canResume`, or `resumeAfterRestart` is false:

1. Retry resume once after 500 ms (the "retry" wording means a read can fail transiently).
2. On a second failure: `fresh` with reason `resume-failed`. The old record is replaced. The debug log notes `resume-failed` with the ACP error code, never the message body.

`session/load` is not used: it replays the whole history as `session/update` notifications, which the proxy would have to discard, and T3 Code uses `session/resume` with this binary for the same reason.

A tainted binding never resumes even when agy still knows the id. After a crash or a cancelled turn, agy's trajectory and OpenCode's history disagree about the last turn, and a replay is the only state both sides agree on.

### 4.6 Steering while parked

When the resume request carries new user messages after the tool results (the user typed while a tool ran, and OpenCode delivered it with the results):

1. Resolve the parked calls with their results.
2. If `steers` and `config.steering`: send `session/prompt` with the steer blocks to the same session while the first prompt is still running. agy treats it as steering; the newer prompt supersedes the older one. Two agy 1.5.15 answers are transient: `the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again` and `the running prompt is being cancelled; wait for it to finish, then send this prompt again`. On either, retry every 1 s, at most 10 times. T3 Code retries without a bound while the turn is active; a bound is kept here so a stuck permission cannot hold the request forever.
3. The response of this HTTP request attaches to the turn; updates for the session keep flowing into it. The turn ends when the newest prompt returns. Replies to superseded prompts are ignored except for usage, which is summed.
4. Steering off (`steers` false or `config.steering` false), retries used up, or any other error: cancel the turn, taint, and run the request as `fresh` (`steer-failed`). The replay includes the tool results and the new user message, so nothing is lost.

### 4.7 Structured replay

`buildReplayPrompt(messages, budgetChars)` returns ACP blocks:

Block 1, text:

```
<conversation_history>
The messages below happened earlier in this conversation, before this Antigravity session started. They are context. The tool calls listed already ran in OpenCode; do not run them again unless the user asks.

<turn n="1" role="user">...</turn>
<turn n="2" role="assistant">text
<tool_call id="call_x" name="read">{"filePath":"src/a.ts"}</tool_call>
</turn>
<turn n="3" role="tool" name="read" call_id="call_x">...</turn>
<system-update>...</system-update>
</conversation_history>
```

Then the latest input:

- Ends with user messages: their text, image and file blocks.
- Ends with tool results (crash or reaper path): `<tool_results>` with each result, then `Continue the task using these tool results.`

Escaping: inside content, `</turn>`, `</tool_call>`, `</conversation_history>`, `</tool_results>`, `</system-update>` are written as `&lt;/turn>` and so on. Nothing else is escaped, so code stays intact. The tag is `<system-update>` everywhere in this design (replay, append prompts, tool description notes).

Budget: `budgetChars = min(replayMaxChars, contextLimit * 2)` (about half the context at 4 characters per token; 400 000 for 200 K-token models, capped at 600 000 by default). `contextLimit` comes from the discovered model; for an unknown model id it is `inferLimits(modelId).contextLimit` from `models.ts`. Over budget, apply in order until it fits:

1. Tool results older than the last 6 messages: cut to 2 000 characters (head 1 500, tail 500, marker `[... N characters omitted ...]`).
2. Same results: cut to 300 characters.
3. Same results: replaced with `[tool result omitted, N characters]`.
4. Assistant text older than the last 6 messages: cut to 1 000 characters.
5. User messages older than the last 6: cut to 4 000 characters (head and tail).
6. Drop the oldest turns whole, replacing them with one line `[N earlier messages omitted]`.
7. Still over (the last 6 messages alone are too large): each of them is cut head and tail to an equal share of the budget, tool results first, then assistant text, then user text, with the same marker.

The last 6 messages and every user message's existence are kept until step 7. Images in the latest user input stay as image blocks; earlier images become `[image <mime>, <sha prefix>]`.

### 4.8 Where state persists, format, locking, pruning

Path: `<dataDir>/sessions/v1/<profileId>/<bindingId>.json`, where `dataDir` is `resolveDataDir()` (`$OPENCODE_ANTIGRAVITY_DATA_DIR` or `$XDG_DATA_HOME/opencode-antigravity`), and `bindingId = sha256(sessionKey).slice(0, 32)`. Files are mode 0600, directories 0700.

Record:

```json
{
  "version": 1,
  "sessionKey": "ses_01J...",
  "acpSessionId": "5c1e...-uuid",
  "authEpoch": "3",
  "agyVersion": "1.5.15",
  "cwd": "/Users/me/project",
  "model": "gemini-4-neon",
  "thoughtLevel": "high",
  "systemHash": "9f2c...",
  "toolsSchemaHash": "41aa...",
  "toolsDescHashes": { "bash": "07be...", "read": "a1c3..." },
  "appendInPrompt": false,
  "prefixCount": 42,
  "prefixHash": "c0ff...",
  "state": "dormant",
  "taintReason": null,
  "lastTurn": {
    "outcome": "ok",
    "plan": "append",
    "emittedToolCalls": [],
    "emittedTextHash": "5d41...",
    "inputFrom": 40,
    "inputTo": 42
  },
  "createdAt": 1764000000000,
  "updatedAt": 1764000500000,
  "turns": 17
}
```

`lastTurn.outcome` is one of `ok`, `parked`, `failed_no_output`, `failed_with_output`, `cancelled`. `state` on disk is `dormant` or `tainted`; `live` exists only in memory and is written as `dormant`.

Writes: after every turn state change that matters (parked, done, tainted, fresh). Write to `<file>.tmp-<pid>-<rand>` then `rename`. A record that fails to parse or has an unknown `version` is renamed to `<file>.corrupt-<ms>` and treated as missing.

Locking:

- In process: `KeyedMutex` by session key (3.7).
- Across processes (two OpenCode servers sharing the data dir and gemini dir): `<bindingId>.lock`, created with `wx`, holding `{ pid, host, poolId, token, acquiredAt }` (`token` is 16 random bytes in hex). Taken when a binding becomes live, held while live, touched every 60 s, removed when the binding goes dormant, the pool stops, or on `process.once("exit")`. Stale check, the same rule as the auth design's `acquireDirLock`:
  - same host (`lock.host === os.hostname()`): stale only when `process.kill(lock.pid, 0)` throws `ESRCH`. A live pid is never treated as stale however old the mtime is, so a holder that slept with the laptop keeps its lock;
  - other host, or unreadable file: stale when the mtime is older than 5 min.
  - Takeover renames the lock file to `<bindingId>.lock.stale-<rand>` (only one contender wins), deletes it, and retries `wx`.
  - Release reads the file first and unlinks it only when `poolId` and `token` are ours, so a lock someone else took over is never removed.
  A lock held by another live process: the request is served with an ephemeral fresh session (reason `locked-elsewhere`) that is not persisted, so two agy processes never drive the same conversation.

Pruning, at pool start (after a 30 s delay) and every 6 h:

1. Delete records with `updatedAt` older than `sessionTtlDays` (14).
2. Keep at most `maxStoredSessions` (500) records per profile, newest by `updatedAt`.
3. For each deleted record, when `isPluginOwnedProfile(geminiDir)` and the id is not live in any process (no lock), delete `<gemini>/antigravity-acp/conversations/<acpSessionId>.db`, `-wal`, `-shm`. The id must match the UUID pattern. Files the plugin did not record are never touched.
4. Ephemeral sessions (meta, discovery, locked-elsewhere) are appended to `<dataDir>/sessions/v1/<profileId>/ephemeral.jsonl` with `{ id, createdAt }`, closed with `session/close` after use, and their conversation files are deleted by the same rule once older than 1 h. The ledger is rewritten without the deleted entries.

`session.deleted` from OpenCode deletes the record, closes the live ACP session and deletes its conversation files under the same rule. `session.forked`, `session.revert.committed` and `session.compaction.ended` are not needed: the fingerprint check sees those changes in the next request, and it is the authoritative signal.

Auth epoch change: records with another epoch are treated as missing on load and removed by the next prune.

`OwnerRegistry` files (`<dataDir>/owners/<pid>.json`, 3.6) follow the same rules: written at pool start with `{ pid, host, poolId, token }`, removed with a `poolId` check at pool stop and synchronously on `process.once("exit")`.

## 5. Shared process recap for reviewers (Q3)

The rules from section 3 in one table:

| Question | Answer |
| --- | --- |
| How many agy processes | One per plugin pool, which is one per OpenCode process (`POOL_GLOBAL_KEY` on `globalThis`) |
| When it starts | First request that needs it, or first discovery when nothing else runs |
| When it stops | Idle 10 min with no leases; auth change; binary change after live turns end; wedged; pool shutdown |
| Parked tool call | Counts as active until `parkedToolTtlMs` (30 min), then the reaper cancels it |
| Crash | In-flight turns fail with retryable 503, parked calls are released, bindings tainted, next request respawns, breaker after 3 fast crashes |
| RAM inside a live process | Sessions idle 30 min get `session/close` and resume later |
| Temp space | Private run dir per generation, removed on exit, swept after crashes |
| Option for crash isolation | `processPerSession: true` adds `--process-per-session` to the args; default false because it multiplies RAM. Everything else in this design stays the same |

## 6. Silence, retries and stalls (Q4)

### 6.1 Signals

| Signal | Counts as | Notes |
| --- | --- | --- |
| `session/update` of kind `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan` | activity | Same set T3 Code uses |
| `session/request_permission`, MCP `tools/call` for the turn's session | activity | |
| `session/prompt` reply | end of the prompt | |
| `usage_update`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update` | nothing | They arrive without the model making progress |
| Retry line in agy's log | retry evidence | Not activity. It proves agy is backing off |
| Error step in the conversation DB after `end_turn` | turn failure | 6.5 |

### 6.2 Log tail

`AgyLogTail` follows the `--log-file` of the current generation. It polls with `fs.stat` once per second while at least one turn is in `awaiting_model` or `streaming`, reads appended bytes from the last offset, splits lines, and stops polling when no turn waits. No `fs.watch` (unreliable on macOS for appends).

```ts
export interface RetryEvent {
  at: number;                 // clock.now() when the line was read; glog stamps carry no year or zone
  attempt: number;            // N in "attempt N failed"
  delayMs: number;            // parsed Go duration
  httpStatus?: number;        // from "HTTP (\d{3})" or "code (\d{3})"
  grpcStatus?: string;        // UNAVAILABLE, RESOURCE_EXHAUSTED, ...
  model?: string;             // from "for model ([\w.-]+)", trailing punctuation never captured
  kind: "rate_limit" | "capacity" | "stream_idle" | "other";
}
export function parseRetryLine(line: string): RetryEvent | null;
export function parseGoDuration(text: string): number | null;   // "1m0.104941814s" -> 60105
```

Line pattern: `/\] Run: attempt (\d+) failed \((.*)\), retrying in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+)\s*$/`. Both micro signs are accepted, U+00B5 and U+03BC, as T3 Code does. `kind`: `rate_limit` when status 429 or `RESOURCE_EXHAUSTED`; `capacity` when 503 or `No capacity available`; `stream_idle` when `stream idle timeout`. The parser keeps only these fields. It never stores the raw line, which can contain request details. The same log has lines with the account email (`applyAuthResult: email=`); they never match and are never read into memory beyond the current chunk.

Attribution: the retry line names no session. An event goes to turns in `awaiting_model` or `streaming` where `event.model === turn.model` or `event.model.startsWith(turn.model + "-")` (agy writes model plus level, `gemini-4-hydrogen-xhigh` for `gemini-4-hydrogen` at `xhigh`; the `-` boundary keeps `gemini-4` from matching `gemini-4.5-x`). If no turn matches or the line has no model, it goes to every waiting turn whose silence started before the event. Attribution only changes the status note text and the final error code; the stall decision itself is per-turn silence.

If the log file is missing or the format changes, the tail yields nothing and the watchdog still works on silence alone.

### 6.3 Status notes

Notes are `reasoning_content` deltas (locked decision Q4), so OpenChamber shows them in the reasoning block. Each note starts and ends with a newline and carries the `[Antigravity]` prefix. Side effects in OpenCode 2.3.0, all accepted:

- OpenCode echoes ingested `reasoning_content` back on later requests. The proxy ignores reasoning in requests (4.2), so agy never sees the notes. If the user or the failover plugin moves the session to another provider, that provider receives the notes as prior reasoning. They are short and labelled.
- A reasoning delta counts as output started (`reasoning-start` sets `outputStarted` and `time.firstToken`). A later retryable error then keeps a failed assistant message with the notes and retries into a fresh one, so each stall that was preceded by a note leaves one failed bubble in the chat. Without a note (silence under 20 s) OpenCode retries in place.
- OpenCode's automatic compaction on context overflow runs only while no output started. agy compacts its own context, and its overflow errors arrive as error steps (6.5) mapped to `provider_error`, so this costs nothing today; it would matter if agy ever reported overflow in OpenCode's wording.
- No note goes out before `session/prompt` is dispatched, except the start and download notes, which only appear when setup is slow anyway.

| When | Note |
| --- | --- |
| Process start takes more than 2 s | `[Antigravity] Starting Antigravity CLI. The first start unpacks its runtime and can take a while.` |
| `install.binaryStatus()` reports a download in progress | `[Antigravity] Downloading Google's Antigravity CLI (<n> of <m> MB). This happens once.`, refreshed at most every 15 s; waiting for another window's download uses the auth design's waiting text |
| 20 s of silence, no retry evidence | `[Antigravity] Waiting for the model. No output for 20 s.` |
| Then every 60 s of continued silence | `[Antigravity] Still waiting. No output for 1 min 20 s.` |
| Retry event attributed to the turn | `[Antigravity] Google answered HTTP 503 (no capacity for gemini-4-neon-high). Antigravity retries on its own: attempt 3, next try in about 60 s.` |
| Retry event, rate limit | `[Antigravity] Google is rate-limiting requests (HTTP 429). Antigravity retries on its own: attempt 2, next try in about 20 s.` |

Notes contain only status code, gRPC status word, model id, attempt, delay and elapsed time. At most one note per 15 s per turn. `statusNotes: false` turns them off; the watchdog and the `: ping` heartbeat still run (3.2 step 8). Non-streaming requests get no notes.

### 6.4 Watchdog

```ts
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
export class StallWatchdog {
  constructor(opts: { config: RuntimeConfig; clock: Clock; onNote(text: string): void; onStall(f: ProviderFailure): void });
  start(): void;                // phase awaiting_model
  activity(): void;             // resets silence
  retry(e: RetryEvent): void;   // evidence, no reset
  pause(): void;                // parked
  resume(): void;               // tool results resolved, back to awaiting_model
  stop(): void;
}
```

Phases where it runs: `awaiting_model` and `streaming`. It pauses while the turn is parked, because OpenCode is running the tool then, and while an ACP permission request is unanswered (ours are answered synchronously, so this is a guard only).

Decision, with `silence = now - lastActivity`:

| Condition | Result |
| --- | --- |
| No retry evidence since last activity, `silence >= stallTimeoutMs` (180 s) | Stall, failure `stalled` (504) |
| Retry evidence since last activity, `silence >= retryStallTimeoutMs` (300 s) | Stall, failure from the last retry kind: 429 for `rate_limit`, 503 for `capacity` or `other`, 504 for `stream_idle` |
| Host slept (a 60 s check slice took more than 70 s) | `lastActivity = now`, same as T3 Code, so a laptop lid does not fail every turn |

On stall: cancel the turn (3.5), then `sink.fail(failure)`. The binding follows 4.1: `failed_no_output` without taint only for a clean no-output failure of an `append` or `redo` turn, taint otherwise. Non-streaming requests use the same limits; `server.timeout(req, 0)` (3.3) keeps `Bun.serve` from closing them first.

Why these numbers:

- agy's own retry ladder reaches about 60 s per attempt from attempt 3. 180 s of plain silence means agy already spent two or three attempts, or a stream is hung (agy waits 10 min before its own stream-idle retry). OpenCode's retry starts in 2 s and its failover plugin can switch providers, which helps more than waiting.
- With retry evidence the logs show most turns recover by attempt 2 or 3 (103 second failures out of 248 first, 36 third, 12 fourth). 300 s covers attempts up to about 5. Past that, agy rarely recovers soon and the user is better served by OpenCode's retry, failover, or an error.
- OpenCode's own limits are larger: a 5 min header timeout, which the early SSE start avoids, and a 15 min chunk timeout on raw bytes, which our `: ping` resets. OpenCode would therefore never time out a silent turn on its own while the proxy heartbeats; this watchdog is the only stall detector, and its typed error gives a better message than OpenCode's `Timeout` (retried at most 3 times).
- T3 Code's 15 min watchdog is a last resort that restarts the whole agent. Here a stall cancels one session's turn in a shared process, so a shorter limit costs little.
- First output can be slow on high thinking levels, but agy streams `agent_thought_chunk` while thinking, which counts as activity.

### 6.5 Error step after end_turn

Before writing `finish_reason: "stop"`, the proxy reads the turn's error step:

1. At turn start, `lastStepIndex(<gemini>/antigravity-acp/conversations/<id>.db)`. Guards first, as T3 Code does: the session id must match `/^[\w-]+$/`; `lstat` of `antigravity-acp`, `conversations` and the `.db` file must show no symlinks; remember the file's `dev` and `ino` and require the same pair after the turn. Open with `bun:sqlite` `new Database(path, { readonly: true })`, or `node:sqlite` `new DatabaseSync(path, { readOnly: true })` when not on Bun (the option names differ), then `PRAGMA busy_timeout = 100`. Missing file or missing `steps` table: index -1. Any error: skip the check for this turn.
2. After `end_turn`: `SELECT step_type, substr(step_payload, 1, 16384) FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`. If `step_type = 17`, decode the payload as UTF-8 and parse it like T3 Code, with `API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s` (dotAll, messages span lines):
   - `reason:QUOTA_EXHAUSTED`: failure `quota_exhausted` (429, message `Antigravity quota exceeded for this period.`, so OpenCode classifies it as `QuotaExceeded` and stops retrying; the failover hook still fires).
   - `Error 429` or status `RESOURCE_EXHAUSTED`: failure `rate_limited` (429).
   - HTTP status >= 500: failure `provider_error` with that status.
   - Invalid thinking signature (`messages.N.content.N.thinking.signature: Field required` or `Invalid \`signature\` in \`thinking\` block`): failure `provider_error` 502, and the binding is tainted with reason `broken-history` so the next request replays into a fresh session.
   - Other: 502.
3. `stopReason === "refusal"` with no error step: failure `quota_exhausted`, as T3 Code does.
4. With a failure, the stream ends with the mid-stream error and no `stop`. The text agy already streamed (its own error message) stays in OpenCode's failed assistant message.

This reads agy internals, read-only, only from the session's own file. A changed schema makes the check return nothing and the turn ends with `stop` as before.

### 6.6 Error mapping

`errors.ts` is the only place that picks status codes and wording. Rules, from OpenCode's classifier in section 1:

- Mid-stream errors always carry a numeric `code`, so OpenCode uses it as the HTTP status.
- Retryable failures never contain the phrases `quota exceeded`, `usage limit`, `limit exhausted`, `insufficient quota`, `too many tokens`, or context-overflow phrases.
- HTTP responses (before the stream starts) add `x-should-retry: true` or `false` explicitly, and `retry-after` in seconds when agy announced a delay.
- Mid-stream there are no headers, so OpenCode classifies by `code` alone: any code >= 500 is retried. Failures that must not retry use a 4xx code mid-stream: 401 for sign-in, 400 with `type: "invalid_request_error"` for setup failures that a retry cannot fix.

| Failure | HTTP before stream | Mid-stream event | OpenCode result |
| --- | --- | --- | --- |
| `stalled` | 504 | `{"error":{"code":504,"type":"antigravity_stalled","message":"Antigravity sent nothing for 3 minutes, so the turn was cancelled."}}` | ProviderInternal, retried |
| `rate_limited` (evidence or error step) | 429, `retry-after` | code 429, `Google is rate-limiting Antigravity requests (HTTP 429).` | RateLimit, retried |
| `capacity` | 503, `retry-after` | code 503, `Google has no capacity for <model> right now (HTTP 503).` | ProviderInternal, retried |
| `quota_exhausted` | 429, `x-should-retry: false` | code 429, `Antigravity quota exceeded for this period.` | QuotaExceeded, not retried |
| `agy_exited` | 503 | code 503 | retried |
| `breaker_open` | 503, `retry-after: 30` | code 503 | retried |
| `auth_required` | 401 | code 401 | Authentication, not retried |
| `binary_not_found`, unsupported platform, bad `binaryPath` | 503, `x-should-retry: false` | code 400, `type: "invalid_request_error"`, the auth design's message | InvalidRequest, not retried |
| `config_issue` (unsupported `authMethod`) | 401 | code 401 | not retried |
| `provider_error` | status from agy or 502 | same | retried |
| client aborted | 499 | none | n/a |

## 7. System prompt and tool guard (Q5)

### 7.1 Append layout

`buildSessionAppend({ messages, tools, config })` returns `{ text, systemHash, toolsSchemaHash, toolsDescHashes, stats }`:

```
<opencode_system_prompt>
...leading OpenCode system messages, at most 32 KB...
</opencode_system_prompt>

## Tool execution protocol
You run inside OpenCode. Call every tool through call_mcp_tool with ServerName "opencode", the exact ToolName below, and Arguments that match its JSON schema. Built-in Antigravity tools are disabled. Never call list_resources, read_resource or manage_task.

<opencode_tools>
{"name":"bash","description":"...","parameters":{...}}
{"name":"read","description":"...","parameters":{...}}
</opencode_tools>
```

Tools are one minified JSON object per line, in the order OpenCode sent them. Meta sessions get the system section and `Do not call any tools. Respond with text only.`

Sizes are UTF-8 bytes (`Buffer.byteLength`). `maxSystemPromptBytes` defaults to 32 768, `maxToolsPromptBytes` to 49 152. Both are deterministic functions of their input, so the same request always yields the same hashes. Every cut lands on a UTF-8 code point boundary, and the byte length of every omission marker counts inside the budget, so the output never exceeds it.

### 7.2 Base system truncation order

Input: the leading run of `system` and `developer` messages. With the `openai-compatible` provider OpenCode sends one joined system message (section 1); several are possible with other lowering paths, so both cases are defined.

1. Join messages with a blank line. Under budget: done.
2. Normalize whitespace: trailing spaces removed, runs of 3 or more newlines become 2. Under budget: done.
3. One message: keep the head up to 75 percent of `maxSystemPromptBytes` and the tail up to the rest, with the marker `[... N bytes of OpenCode instructions omitted to fit the Antigravity prompt budget ...]` between them. The tail holds OpenCode's environment block and the project instructions, which is why it is kept.
4. Several messages: the first gets up to 20/32 of the budget, the last up to 8/32, the middle ones share the remaining 4/32 in order. Shares scale with `maxSystemPromptBytes`. A message over its share keeps head and tail in the 75/25 split of step 3 with the marker; unused share passes to the next message in order.

The debug log records message count and omitted bytes, never the text.

### 7.3 Compact exact schemas and tool truncation order

Schema compaction keeps every constraint at any depth (the prototype collapsed below depth 4 and dropped constraints, which made the schemas inexact). Kept keywords: `type`, `properties`, `required`, `items`, `prefixItems`, `additionalProperties`, `patternProperties`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `not`, `$ref`, `$defs`, `definitions`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `format`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `default`, `nullable`, `description`. Dropped: `$schema`, `$id`, `title`, `examples`, `$comment`, `deprecated`, `readOnly`, `writeOnly`, `x-*`.

Over `maxToolsPromptBytes`, apply levels until it fits; each level applies to all tools:

| Level | Change |
| --- | --- |
| L0 | Allowlisted keywords, full descriptions |
| L1 | Property descriptions cut to 160 characters |
| L2 | Tool descriptions cut to 400 characters |
| L3 | Property descriptions removed, tool descriptions cut to 160 characters |
| L4 | Tool descriptions removed |
| L5 | From the end of the list (MCP tools come after OpenCode's built-ins), replace `parameters` with `"omitted: over the prompt budget; call with your best arguments and read the validation error"` until it fits |
| L6 | Still over with every schema omitted (hundreds of tools): from the end of the list, tools collapse into one final line `{"more_tools":["name1","name2",...]}` listing names only, until it fits. Names that still do not fit are dropped from the prompt and counted in the warning |

Constraints are never removed before L5. L5 and L6 log a warning with the counts. A tool dropped from the prompt stays callable: the per-session MCP registry (`tools/list`) always holds every tool with its full schema, so validation errors stay exact.

### 7.4 PreToolUse guard

Layers, from outermost: (1) custom agent `opencode-bridge` with `tools: []`, started with `--agent opencode-bridge`; (2) `PreToolUse` hook that denies every tool except the OpenCode MCP call; (3) ACP permission filter in `allowPermission`; (4) per-session MCP registry and per-turn allowlist. Layer 2 is new; layer 3 is specified here because the prototype's version fails open.

`writeToolGuardHook(geminiDir)` runs from `prepareProfileDir`, only when `install.isPluginOwnedProfile()` is true and `toolGuardHook` is on. For a user-supplied gemini dir without the marker, the hook is skipped and a one-time warning says the guard is off: writing a global hook into someone's real `~/.gemini` would deny tools in their own agy sessions. With `toolGuardHook: false`, `removeToolGuardHook` deletes the `opencode-bridge-guard` key and the guard script and keeps every other hook.

Guard runtime. The guard is a JavaScript file run by the same runtime as the plugin, so it parses real JSON on every OS without a shell or PowerShell dependency:

- `process.versions.bun` set (OpenCode 2.x, compiled or `bun`): command `BUN_BE_BUN=1 "<process.execPath>" ./opencode-tool-guard.mjs` on POSIX, `set "BUN_BE_BUN=1" && "<process.execPath>" opencode-tool-guard.mjs` on Windows. Section 1 shows the compiled `opencode` 2.3.0 binary running scripts this way; for a plain `bun` the variable is harmless.
- Otherwise (Node): `"<process.execPath>" ./opencode-tool-guard.mjs`.
- `probeGuardRuntime()` runs the exact command once at pool start with two sample payloads and a 5 s timeout and requires `force_ask` and `deny`. On failure the hook is not written (an existing one is removed), and a one-time warning says the guard is off. Layers 1, 3 and 4 still apply.
- `hooks.json` is rewritten at every pool start, so an OpenCode upgrade that moves `process.execPath` is picked up.

`<gemini>/config/hooks.json`; any hook named other than `opencode-bridge-guard` is kept as is:

```json
{
  "opencode-bridge-guard": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "BUN_BE_BUN=1 \"/path/to/opencode\" ./opencode-tool-guard.mjs", "timeout": 5 }]
      }
    ]
  }
}
```

`<gemini>/config/opencode-tool-guard.mjs`, mode 0700:

```js
// Lets only OpenCode's MCP server through to the permission check; every other tool is denied.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let call;
try { call = JSON.parse(Buffer.concat(chunks).toString("utf8")).toolCall; } catch {}
const name = typeof call?.name === "string" ? call.name : "";
const args = call && typeof call.args === "object" && call.args ? call.args : {};
const server = args.ServerName ?? args.serverName ?? args.server_name;
const ok = (name === "call_mcp_tool" || name === "mcp_tool") && server === "opencode";
process.stdout.write(JSON.stringify(ok
  ? { decision: "force_ask" }
  : { decision: "deny", reason: 'Only OpenCode tools are available here. Call them through call_mcp_tool with ServerName "opencode".' }) + "\n");
```

Notes on the guard:

- It reads only `toolCall.name` and `toolCall.args`. `lastUserInput` and the rest of the payload never influence the decision, so a prompt that quotes the magic strings changes nothing.
- It never prints `allow`. It prints `force_ask`, which always raises the ACP permission request and ignores agy's "Always Allow" cache (`ask` would honour that cache and could skip layer 3).
- Both `call_mcp_tool` and `mcp_tool` are accepted because the hook name is derived from the step type `CORTEX_STEP_TYPE_MCP_TOOL`. The smoke test records which name arrives; the other is then dropped.
- It writes nothing to disk and prints only the decision.

Layer 3, `allowPermission(params, generation)`, returns true only when all hold:

1. `params.sessionId` maps to a turn of the current generation that is not done and has `allowTools === true`;
2. the tool is the MCP call: `toolCall.name` is `call_mcp_tool` or `mcp_tool`, or, because ACP marks `toolCall.name` optional and unstable, the name is absent and `rawInput`/`args` carry a server and tool name;
3. the server, read from `args` or `rawInput` under `ServerName`, `serverName` or `server_name`, is `"opencode"`;
4. the tool name, read under `ToolName`, `toolName` or `tool_name`, is non-empty and in the turn's `allowedToolNames`. An empty or missing tool name is a rejection (the prototype allowed it).

The selected option is `allow_once`, never `allow_always`, so agy's permission cache never fills. The smoke test captures one real `session/request_permission` payload (key casing, `name`, `rawInput`) and the parser is pinned to it.

`toolPermission: "strict"` stays in `settings.json`, so every tool that the hook passes on reaches layer 3.

### 7.5 When the tool set changes mid-session

| Change | Effect |
| --- | --- |
| Tool added, removed, renamed, or parameters changed (`toolsSchemaHash` differs) | Fresh ACP session with replay (locked decision). The live session gets `session/close` |
| Only descriptions changed (some entry of `toolsDescHashes` differs, schema hash equal) | Same session (decision in `docs/decisions.md`). The next prompt starts with `<system-update>The descriptions of these OpenCode tools changed:` followed by the new lines of exactly the changed tools in the 7.3 format `</system-update>`. The per-tool map is persisted, so this works across restarts. The binding stores the new map |
| Change inside a parked turn (the resume request lists other tools) | Ignored for the running turn: tools of a turn are fixed at its start (`allowedToolNames`, its MCP scope). Classification checks the parked turn before any hash (4.3 step 5). The next new-turn request compares hashes |
| Removed tool called by a stale model | Layer 3 rejects the permission, layer 4 returns `Tool "x" is not enabled for this turn.` |

OpenCode's `task` and `skill` tools carry lists in their descriptions that change when agents or skills change. Without the description rule each such change would cost a cold session.

## 8. Request handling, end to end

### 8.1 HTTP routes

| Route | Checks | Notes |
| --- | --- | --- |
| any | `Origin` header absent and `Host` loopback, else 403 | unchanged |
| `/v1/*` | Check 1: `x-antigravity-proxy-token` equals the per-process secret (constant time), else 401 `Unauthorized`. The `Authorization: Bearer <secret>` fallback is removed | install/auth design 13.3 |
| `/v1/chat/completions` | Check 2, after check 1: `Authorization` is exactly `Bearer agy-managed`, else 401 `auth_required`, `x-should-retry: false`, `SIGN_IN_GATE_MESSAGE`. A config issue (unsupported `authMethod`) answers 401 `auth_required` with the issue text | same |
| `/v1/models` | check 1 only | |
| `/mcp/<mcpToken>/<scopeId>` | token in path (constant time), scope must exist | `server.timeout(req, 0)`; `req.signal` observed (3.3) |
| `/health` | none | `{ ok, acp: ProcessState, auth: AuthState["kind"], binary: { source, version, phase } }`. No email, path, token or session ids |

### 8.2 `handleChatCompletions`

1. Parse body, headers (`model.request` hook values), `stream`. Non-streaming: `server.timeout(req, 0)`.
2. Under the session mutex (3.7): handle a live non-parked turn (cancel and wait), `plan = classifyRequest(...)`, register the `Turn` in `dispatching` for `append`, `redo`, `fresh`, `meta`, `ephemeral`. Release the mutex.
3. `resume`: resolve parked calls (only emitted ones count, 3.7), flush unemitted calls as a new `tool_calls` response if any, else steer if needed, else attach the response to the turn.
4. Other plans: `acquire("turn")` (spawning if needed, 3.2). Streaming requests start SSE after 2 s and heartbeat. Then session setup, config options, watchdog start, `session/prompt`, attach the response. The turn owns the lease from here; a failure before this point releases it in `finally`.
5. Turn events: chunks go to the sink or the buffer; MCP calls park with the 250 ms settle window; the prompt reply runs the error-step check (6.5), then `finish`.
6. Binding update and persist on park, done, taint (4.1, 4.8).

`Turn` phases: `dispatching -> awaiting_model <-> streaming -> parked -> awaiting_model ... -> cancelling -> done(ok | failed | cancelled)` or `abandoned`. The watchdog follows them. `Turn.outcome()` gives `ok`, `failed_no_output`, `failed_with_output`, `cancelled` for the binding.

Tool call ids stay `call_` plus 20 lowercase hex characters: OpenCode rewrites ids with other characters for Claude-family model ids, and agy offers Claude models.

### 8.3 OpenCode events

The prototype's `ctx.event.subscribe(handler)` with `event.properties` never fires in OpenCode 2.3.0: `subscribe(options)` returns an `AsyncIterable`, and events carry `data`. `events.ts`:

```ts
export function runEventLoop(ctx: PluginContext, pool: PoolHandlers, signal: AbortSignal): void {
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        types: ["session.deleted", "session.execution.interrupted", "session.execution.failed"],
        signal,
      })) {
        const id = event.data?.sessionID;
        if (typeof id !== "string") continue;
        if (event.type === "session.deleted") pool.onSessionDeleted(id);
        else pool.onSessionInterrupted(id);
      }
    } catch (err) { if (!signal.aborted) debugLog("event loop ended", errorCode(err)); }
  })();
}
```

- `setup()` runs once per OpenCode location, so several loops deliver the same event. Handlers are idempotent: `onSessionInterrupted` acts only on a turn that is live and not already cancelling; `onSessionDeleted` keeps a set of handled ids for 10 min.
- `session.execution.failed` cancels a live turn the same way. A turn that already ended is left alone.
- Each `setup()` creates its own `AbortController` and aborts it in the cleanup function it returns.

### 8.4 Pool sharing and shutdown

`index.ts` keeps one pool per OpenCode process under `POOL_GLOBAL_KEY`. `releasePool()` drops the ref count; at 0 it waits `RELOAD_GRACE_MS` (10 s), then awaits `proxy.stop()`, which awaits `AgyProcessManager.stop("shutdown")` (up to 8 s). The global entry stays in place, marked `stopping`, until that promise settles. `acquirePool()` arriving meanwhile awaits the stop and then creates a fresh pool, so a plugin reload never runs two proxies against one gemini dir. `attachRuntime(control, createRunDir)` is called on the auth manager each time a pool is created.

## 9. Interfaces to the install/auth design

`docs/design-install-auth.md` section 15 is the source for these signatures; this section adopts them and states what the runtime does with each.

```ts
export interface InstallAuthBridge {
  resolveBinary(opts?: { waitMs?: number }): Promise<{ path: string; version: string }>;
  buildSpawnEnv(input: { tmpDir: string }): Record<string, string>;   // buildAgyEnv({ kind: "runtime", tmpDir })
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
```

| Member | Runtime use |
| --- | --- |
| `beforeSpawn()` | First step of every spawn (3.2 step 1). Rejection maps to 401 `auth_required` |
| `resolveBinary()` | Every spawn, never cached by the pool, so an update takes effect at the next generation. `version` gates resume, steering and close. `BinaryNotFoundError` maps per 6.6 |
| `binaryStatus()` | Download and lock-wait notes (6.3). `downloading` and `waiting_for_lock` use the auth design's texts |
| `buildSpawnEnv` | Spawn env, unmodified |
| `isSignInRequired` | Every RPC error and every `SignInUrlLineError` (3.2 steps 6, 7). `AcpClient` checks every non-JSON stdout line and every stderr line for `AUTH_URL_STDOUT_PREFIX` |
| `reportAuthenticated`, `reportSignInRequired` | After each `authenticate`, and on sign-in errors from `session/new`, `session/resume` and `session/prompt` |
| `onAuthChanged` | `login`, `account-changed`: `stop("auth-changed")`; in-flight turns fail with 503 `Antigravity sign-in changed. Retrying with the new account.` (retryable). `logout`: the runtime does not start a stop itself, because `AuthManager` awaits `runtime.stop("auth-changed")` before ACP `logout`; turns stopped that way fail with 401. In all cases bindings of the old epoch are treated as missing |
| `onBinaryChanged` | `ready -> draining` (3.1) |
| `isPluginOwnedProfile` | Hook install (7.4), conversation file pruning (4.8) |
| `updateProfileSettings` | `prepareProfileDir` writes `{ toolPermission: "strict" }` through it; the runtime never writes `settings.json` itself |
| `authEpoch` | Stored in each binding (4.8) |

What the runtime gives the auth design:

```ts
export interface RuntimeControl {
  stop(reason: "auth-changed"): Promise<void>;   // AgyProcessManager.stop, idempotent and joinable
  hold(reason: "login"): Lease;                  // AgyProcessManager.hold, never spawns
}
export type CreateRunDir = (kind: RunDirKind) => Promise<RunDir>;   // tmp-sweeper.ts
```

`CreateRunDir` returns a handle: the path stays in `liveRunDirs` until `release()`, which is what keeps a live login dir safe from a sweep run by the same process (3.6). The auth design's section 15.2 currently types it as `() => Promise<string>`; it has to adopt the handle and call `release()` in its `finally`, where it now removes the dir. `index.ts` passes both through `authManager.attachRuntime(control, createRunDir)` once the pool exists.

Rules on both sides:

- **Idle shutdown never kills a login.** Login is its own `agy acp --login` child owned by `AuthManager`. It also takes `hold("login")` for its whole life, so the pool neither idles out nor restarts during sign-in, and its temp dir comes from `createRunDir("login")`.
- **Binary change.** The pool drains (3.1). Bindings stay valid; agy conversations survive a version change and resume.
- **Profile files.** The auth design owns `settings.json` (all writes through `updateProfileSettings`) and the profile marker. This design owns `config/agents/opencode-bridge.md`, `config/hooks.json` (its `opencode-bridge-guard` key), `config/opencode-tool-guard.mjs` and the `log/opencode-*.log` files.
- **Protocol version.** `initialize` sends `protocolVersion: 1` (agy answers 1 when asked for 2).
- **Fake agy.** `test/fixtures/mock-agy.ts` answers `initialize` with `agentInfo.name: "Antigravity ACP Server"`, `agentCapabilities.auth.logout: {}`, `loadSession: true`, `sessionCapabilities.resume: {}` and an `authMethods` entry `{ id: "oauth-personal" }`, so it passes the auth design's identity check; a scenario switch turns each off.

## 10. Configuration

Plugin options (`ctx.options`), each with an env override where noted. Durations in milliseconds.

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `idleShutdownMs` | `OPENCODE_ANTIGRAVITY_IDLE_MS` | 600000 | Stop the process after this long with no leases. 0 disables |
| `sessionIdleCloseMs` | | 1800000 | `session/close` a live session unused this long |
| `parkedToolTtlMs` | | 1800000 | Cancel a turn parked on OpenCode this long |
| `cancelSettleMs` | | 15000 | Wait for the cancelled prompt's reply |
| `stallTimeoutMs` | `OPENCODE_ANTIGRAVITY_STALL_MS` | 180000 | Silence without retry evidence |
| `retryStallTimeoutMs` | | 300000 | Silence with retry evidence |
| `statusNoteAfterMs` | | 20000 | First waiting note |
| `statusNotes` | | true | Send status notes |
| `breakerCooldownMs` | | 30000 | Fail fast after repeated start crashes |
| `processPerSession` | | false | Pass `--process-per-session` |
| `sessionStore` | | true | Persist bindings. False keeps them in memory only |
| `resumeAfterRestart` | | true | Try `session/resume` for dormant bindings |
| `sessionTtlDays` | | 14 | Prune records older than this |
| `maxStoredSessions` | | 500 | Prune beyond this count per profile |
| `steering` | | true | Steer a parked turn with new user input |
| `maxSystemPromptBytes` | | 32768 | Base system budget |
| `maxToolsPromptBytes` | | 49152 | Tools section budget |
| `replayMaxChars` | | 600000 | Replay cap before the per-model limit |
| `toolGuardHook` | | true | Write the `PreToolUse` guard in a plugin-owned profile. False removes an existing guard entry |
| `debug` | | false | Metadata logs to stderr |
| `debugContent` | | false | Also log truncated prompt and tool content. Never on by default |

Fixed internal limits (constants, not options): RPC timeouts 30 s (`initialize` 30 s, `authenticate` 60 s), settle window 250 ms, SSE heartbeat 15 s, early SSE start 2 s, wedged check every 30 s, steering retries 10 at 1 s.

Install and auth options (`binaryPath`, `binarySource`, `autoUpdate`, `offline`, `offlineFallback`, `isolatedAuth`, `geminiDir`, `authMethod`, `proxyPort`) are defined in the install/auth design, section 3. `docs/architecture.md` has the merged table.

## 11. Test plan

The existing pattern stays: `bun test test/`, a fake agy written as a Bun script, a real `AntigravityProxy` over loopback HTTP. The fake moves from a string in `e2e-proxy.test.ts` into `test/fixtures/mock-agy.ts`. Each test writes a two-line wrapper into its temp dir that runs `bun <fixture> --scenario <name> --journal <path> "$@"`, so scenarios do not leak through global env between parallel tests. The fake appends every RPC it receives to the journal (JSONL with method, sessionId, and prompt text), which tests read to assert what agy saw.

Fake agy additions:

- `initialize` advertises `agentInfo.version` (default `1.5.15`), `sessionCapabilities: { resume: {}, close: {} }`, `_meta.antigravity.systemPrompt.append: true`, all switchable per scenario.
- Sessions persist to `<gemini-dir>/mock-sessions.json`, so a new fake process can `session/resume` them; unknown ids answer `{ code: -32603, message: "Failed to read session <id>; retry, or load it with session/load" }`.
- `session/close`, `session/cancel` (reply to the running prompt with `stopReason: "cancelled"`), steering (a second `session/prompt` while one runs supersedes it).
- Scenarios: `text`, `tools`, `parallel`, `unauth` (existing); `stall` (never replies after the thought chunk); `retry-log` (appends real-format retry lines to the `--log-file` path, then replies); `crash-mid-stream` (exits 137 after the first chunk); `crash-parked` (exits while an MCP call is open); `error-step` (creates `<gemini>/antigravity-acp/conversations/<id>.db` with `bun:sqlite`, table `steps(idx, step_type, step_payload)`, inserts a type 17 row with `Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED`, then streams an error text and `end_turn`); `quota-step` (same with `reason:QUOTA_EXHAUSTED`); `slow-start` (sleeps 3 s before answering `initialize`); `busy-steer` (first steer answers `the running prompt is being cancelled; wait for it to finish, then send this prompt again`); `late-call` (a second MCP `tools/call` 400 ms after the first, after the settle window); `tool-media` (expects an MCP result with an image item and records it); `mcp-drop` (aborts its parked `tools/call` HTTP request after 200 ms); `cancel-hang` (never answers the prompt after `session/cancel`); `auth-url-line` (prints `Open the following link to authenticate the ACP server: https://...` on stdout instead of answering `authenticate`); `start-crash` (exits 1 before answering `initialize`).
- MCP calls go to the URL from `session/new` `mcpServers`, never to the agent file. The fake records the scope path it was given.

Tests inject short timeouts through options (`stallTimeoutMs: 300`, `statusNoteAfterMs: 100`, `idleShutdownMs: 200`) and a temp `OPENCODE_ANTIGRAVITY_DATA_DIR` per test.

### 11.1 Unit tests

| File | Cases |
| --- | --- |
| `test/unit/fingerprint.test.ts` | String content and array-of-parts with the same text give one fingerprint. `cache_control` and reasoning fields are ignored. Tool call args with reordered keys match. Empty assistant messages drop out. `chainHash` of a prefix equals the stored value after appending messages |
| same | `classifyRequest`: append-only (new user after our text), resume (tool results for parked ids), resume with steer, edit of message 2 (`prefix-mismatch`), revert to a shorter history, compaction (summary replaces history), unknown tool call id in the tail (`tail-mismatch`), retry of the same request after `failed_no_output` (`redo`), same after `failed_with_output` (`fresh`, tainted), system change, tool schema change, description-only change (append with one reminder), cwd change, auth epoch change, meta kind, mid-conversation system message (append with a `<system-update>` block) |
| `test/unit/prompt.test.ts` | Leading system only: a later system message does not change `systemHash`. Under 32 KB nothing changes. Over budget: whitespace normalization first, then section budgets with the exact marker, output identical on repeated calls. Tools are JSONL, minified, keep `minLength`, `pattern`, `anyOf` at depth 6, drop `title` and `$schema`. Tool ladder: a 60 KB tool set reaches the first level that fits, L5 replaces parameters from the end only |
| `test/unit/replay.test.ts` | Turn tags and tool calls appear in order; closing tags inside content are escaped; ladder trims old tool results first and keeps the last 6 messages untouched; images become placeholders except in the latest input; ending with tool results adds the continue instruction |
| `test/unit/session-store.test.ts` | Atomic write leaves no tmp files; corrupt file is renamed and treated as missing; lock from a dead pid is replaced; lock from a live pid (the test process spawned as a child that sleeps) is respected; prune by TTL and by count; prune deletes only recorded conversation ids with UUID names, only in a plugin-owned profile |
| `test/unit/agy-log-tail.test.ts` | Parses the real line formats from section 1 (attempt 1 with `4s`, attempt 2 with `1m0.104941814s`, `stream idle timeout (10m0s)`), extracts 503, `UNAVAILABLE`, model `gemini-4-hydrogen-xhigh`; a line with `email=` yields null; the tail reads only appended bytes, survives truncation and a missing file |
| `test/unit/stall-watchdog.test.ts` | With a fake clock: note at 20 s, repeat at 80 s, stall at 180 s with failure 504; retry evidence moves the limit to 300 s and the code to 429 or 503; `pause` while parked stops the clock; `activity` resets; a 75 s gap in a 60 s slice counts as host sleep; non-streaming requests use the same limits; at most one note per 15 s |
| `test/unit/errors.test.ts` | Every row of 6.6: status, `x-should-retry`, `retry-after`, mid-stream `code` is a number; retryable messages contain none of the quota or overflow phrases (regexes copied from OpenCode's `provider-error.js` with a comment naming the source version) |
| `test/unit/tmp-sweeper.test.ts` | Removes `run-*` of a dead pid, keeps a live one, removes our own stale generation, removes legacy `opencode-agy-run-*` older than 24 h and keeps a fresh one, never throws on permission errors |
| `test/unit/tool-guard.test.ts` | Runs the guard with the command `probeGuardRuntime` builds (`process.execPath`, `BUN_BE_BUN=1`): MCP call to `opencode` gives `force_ask` (for `call_mcp_tool`, `mcp_tool`, and `ServerName`, `serverName`, `server_name`); `run_command` gives `deny`; MCP call to another server gives `deny`; `run_command` whose `lastUserInput` and `CommandLine` both contain `"name":"call_mcp_tool"` and `"ServerName":"opencode"` gives `deny`; invalid JSON gives `deny`. `allowPermission` cases: missing or empty tool name rejected, tool outside `allowedToolNames` rejected, camelCase keys accepted, absent `toolCall.name` with server and tool in `rawInput` accepted, done turn rejected, older generation rejected; the chosen option is `allow_once` |
| `test/unit/fingerprint.test.ts` (additions) | `file` and `video_url` parts change the fingerprint when added, removed or replaced. A two-part text message as array and as `join("")` string give one fingerprint. Edited assistant text in `A` gives `tail-mismatch`; edited tool call args give `tail-mismatch`; two assistant messages in `A` give `tail-mismatch`. A media-only user message after tool messages lands in `R`, giving `resume` with `media`, no `steer`. Tools schema change while parked still gives `resume`. A `failed_no_output` after a `resume` turn is tainted, giving `fresh`. No session header gives `ephemeral` and no store access |
| `test/unit/agy-process.test.ts` | With a fake spawner and clock: `acquire` during `stopping` waits then spawns; `stop` twice returns one promise; `stop` during `starting` stops the child when the start settles; `draining` keeps existing leases and spawns a new generation for new ones; a crash during `starting` counts toward the breaker, a sign-in failure does not; one turn lease spans setup and prompt and is released when setup throws; abandoned turns trigger `stop("wedged")` per the 3.5 rule |
| `test/unit/session-store-lock.test.ts` | Same-host lock with a live pid and an mtime 1 h old is not stolen; same-host dead pid is stolen; foreign host older than 5 min is stolen; release with another `poolId` or token leaves the file; exit cleanup removes only own locks and owner file |
| `test/unit/mcp-bridge.test.ts` | Two scopes with different schemas for `read` each list their own; `tools/call` on a closed scope answers `isError`; a conversation id that differs from the scope's session answers `isError`; an aborted request rejects the parked call |
| `test/unit/tmp-sweeper.test.ts` (addition) | A same-pid `run-*` that is in `liveRunDirs` (a login) survives a sweep; after `release()` it is removed |
| `test/unit/acp-client.test.ts` | `AUTH_URL_STDOUT_PREFIX` on stdout or stderr rejects the pending `authenticate` at once with `SignInUrlLineError`; every RPC except `session/prompt` times out after 30 s (fake clock) |
| `test/unit/events.test.ts` | A fake `ctx.event.subscribe` yielding `{ type, data: { sessionID } }`: interrupted cancels a live turn; the same event from two loops cancels once; `session.deleted` deletes the record; aborting the signal ends the loop |
| `test/unit/system-prompt.test.ts` | One 40 KB system message keeps 24 KB head and 8 KB tail with the marker, total at most 32 768 bytes; multi-byte text is never split inside a code point; a 16 KB budget scales the shares; L6 collapses names into `more_tools` |
| `test/unit/turn-outcome.test.ts` (additions) | `stopReason: "refusal"` without an error step gives `quota_exhausted`; a symlinked `.db` or a session id with `/` is skipped; a multi-line message matches `API_ERROR` with `/s` |
| `test/unit/turn-outcome.test.ts` | DB with no `steps` table gives null; type 17 row with 429 gives `rate_limited`; `reason:QUOTA_EXHAUSTED` gives `quota_exhausted`; thinking-signature text gives `provider_error` with taint; rows at or before the start index are ignored |

### 11.2 End-to-end tests

| File | Case |
| --- | --- |
| `test/e2e/session-reuse.test.ts` | Two user turns on one session key: journal shows one `session/new`, two `session/prompt` on the same id, and the second prompt contains only the new user text |
| same | Edit the first user message, then send: second `session/new`, its prompt contains `<conversation_history>` with the old turns |
| same | Tool schema change: fresh session. Description-only change: same session, prompt starts with `<system-update>` |
| same | Restart: stop the proxy, start a new one with the same data dir, send the next turn: journal shows `session/resume` with the stored id and the same `_meta` append, then an append-only prompt |
| same | Restart with an id the fake does not know: `session/resume` fails twice, then `session/new` with replay, and the record holds the new id |
| `test/e2e/concurrency.test.ts` | Two session keys both parked at once; results posted in reverse order; each continuation carries its own result |
| same | Tool results plus a new user message: journal shows a second `session/prompt` on the same id while the first is open; response contains the steered reply. With `busy-steer`, the retry after 1 s succeeds |
| same | Meta title request while a turn is parked: separate session, `session/close` after it, parked turn resumes normally |
| `test/e2e/crash.test.ts` | `crash-mid-stream`: stream ends with an error event whose `code` is 503; the next request spawns a new pid (journal file per pid) and works through a fresh session |
| same | `crash-parked`: posting the tool result after the crash gives a fresh session whose replay ends with `<tool_results>` and the continue instruction |
| same | Three crashes right after start: the fourth request gets HTTP 503 with `retry-after: 30` without spawning |
| `test/e2e/stall.test.ts` | `stall`: reasoning contains the waiting note, journal shows `session/cancel`, stream ends with error code 504; the retried request (same messages) is `redo` on the same ACP id |
| same | `retry-log`: note mentions HTTP 503 and the attempt; stall error code is 503 |
| same | `error-step`: stream ends with error code 429 and no `finish_reason: "stop"`. `quota-step`: code 429 with the quota message |
| `test/e2e/idle.test.ts` | `idleShutdownMs: 200`: the fake exits after a finished turn and its run dir is gone; it does not exit while a turn is parked; the next request respawns and resumes |
| same | `slow-start`: a streaming request receives the start note before the first model chunk |
| `test/e2e/tools-multi.test.ts` | Park, resume, second park, resume, `end_turn` inside one ACP prompt: one `session/prompt` in the journal. `late-call`: the resume request answers with a `tool_calls` response for the late call, then a second resume completes the turn. Partial results: one of two emitted calls answered, the other resolves with `isError` and the stream continues, no 409. `tool-media`: a tool result followed by OpenCode's media-only user message reaches the fake as an MCP image item, with no steering prompt |
| `test/e2e/abort.test.ts` | Client abort during `slow-start`, mid-stream and while parked: `session/cancel` in the journal, lease released (idle stop follows). `cancel-hang`: after `cancelSettleMs` the binding is tainted, the next request is `fresh`, and with a second hang the process is stopped as wedged. `mcp-drop`: the turn is cancelled and the later tool result goes through a fresh session. A second main request while the first streams cancels the first and runs `fresh` |
| `test/e2e/auth-bridge.test.ts` | With a fake `InstallAuthBridge`: `onAuthChanged("login")` fails a live turn with code 503 and drops bindings; a `logout` stop fails it with 401; `beforeSpawn` rejecting gives 401 `auth_required` without a spawn; `onBinaryChanged` drains: the running turn finishes on the old pid, the next request gets a new pid; `auth-url-line` gives 401 within 1 s and `reportSignInRequired` is called; a download in progress (`binaryStatus` downloading) sends the download note; a fatal `resolveBinary` failure after SSE started gives a mid-stream code 400; `/v1/chat/completions` without `Bearer agy-managed` gives 401 `auth_required`, without the proxy token 401 `Unauthorized`; `/health` has no email or path |
| `test/e2e/profile.test.ts` | `hooks.json` and the guard script exist, script mode 0700, in a plugin-owned gemini dir; a foreign hook entry is preserved; `toolGuardHook: false` removes our entry and keeps the foreign one; a user gemini dir without the marker gets no hook; the agent file has no `mcpServers` and no token; `settings.json` `toolPermission` was written through `updateProfileSettings` |
| `test/e2e/privacy.test.ts` | With `debug: true` and `debugContent: false`, capture `console.error` over a tools turn: it contains no prompt text, no tool arguments, no tool result, no bearer secret, no MCP token |

Existing cases in `test/e2e-proxy.test.ts` (park and resume, parallel batching, auth and CSRF guards, interrupt recovery, non-streaming meta) move into these files unchanged in meaning. The interrupt case changes expectation: after `interruptSession`, the next request is `fresh` (taint), and the journal shows `session/cancel` for the old id. The auth case changes too: chat requests carry `x-antigravity-proxy-token` and `Authorization: Bearer agy-managed`, and a request with only `Authorization: Bearer <secret>` now expects 401 `Unauthorized`.

### 11.3 Opt-in real binary smoke test

`test/real-agy.smoke.test.ts`, skipped unless `AGY_SMOKE=1`; the steps below that need a model also need a signed-in profile path in `AGY_SMOKE_GEMINI_DIR`. It answers the open items from section 1, and its result decides the hook name and the resume default:

1. With the guard installed, prompt the model to run a shell command: the log shows the hook decision `deny`, the ACP permission request never arrives for `run_command`. Record the tool name the hook saw (`call_mcp_tool` or `mcp_tool`) by temporarily logging only `toolCall.name`.
2. A tools turn through `call_mcp_tool` still works with the hook on.
3. Resume after a process restart: ask "what tool protocol do you follow" in the resumed session; the answer must mention `call_mcp_tool` and `ServerName "opencode"`, which shows the append survived resume.
4. Steering while an MCP call is parked: the steered text reaches the model and the first prompt ends without hanging.
5. The log file passed with `--log-file` receives `run.go` lines (check format only, against a capacity error if one happens).
6. Per-session MCP only: with the agent file carrying no `mcpServers`, `call_mcp_tool` reaches `/mcp/<token>/<scope>`. If not, switch to the per-pool agent file (4.4). Result (agy 1.5.15): without an entry the agent has no `call_mcp_tool`; with one the calls still go to the per-session server. The agent file now names the pool endpoint (`docs/live-test-fixes.md`).
7. Capture one `session/request_permission` for an MCP call and record its keys (`toolCall.name` present or not, `rawInput` and `args` key casing); pin `allowPermission` and the guard to it.
8. MCP call timeout: park a call for 20 min (a tool that waits on OpenCode). If agy gives up earlier, switch `tools/call` to the SSE keepalive response (3.3) and record agy's limit.
9. Tool-result media: an MCP result with an image item reaches the model (ask it to describe the image).

## 12. Open risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Hooks may not load with `--include-default-customizations=false`, or see another tool name | Layer 2 is a no-op or denies MCP | Smoke test 11.3. Layers 1, 3, 4 hold either way; a deny of MCP fails every tool turn in the smoke test |
| `session/resume` may drop the `_meta` append | Resumed sessions forget the tool protocol | Smoke test 11.3 step 3. If it fails, set `resumeAfterRestart` default to false; dormant bindings then go fresh, which matches the locked decision's wording |
| Steering semantics while an MCP call is open are not documented | Steered input lost or turn hangs | Fallback to cancel and fresh replay on any steering error; `steering: false` switch; smoke test step 4 |
| The retry log line and the conversation DB schema are agy internals | Notes or error-step mapping silently stop | Both fail soft to silence-only behavior; parser tests pin today's format; re-check on each agy update |
| Retry lines carry no session id | In a busy process a note can name another session's retry | Model-prefix attribution; the stall decision does not depend on attribution |
| One process hosts every session | One crash fails all live turns | Retryable 503, taint, fast respawn; `processPerSession` option |
| Respawn after idle unpacks about 1 GB again | First request after idle waits seconds | 10 min idle default, start note after 2 s; measure startup on a cold disk before release |
| OpenCode merges a mid-conversation system update into the previous plain-string user message | That message's fingerprint changes and the session goes fresh | Rare (needs an instruction change right after a user message); visible as `prefix-mismatch` in debug stats; revisit if it shows up |
| `redo` repeats the user input inside agy's history | A few extra tokens; model may mention the retry | Only after a failed turn with no output; any other failure replays fresh |
| Workspace `.agents/` customizations in user projects (rules, skills, trusted-folder hooks, `mcp_config.json`) still load in agy | Duplicate instructions with OpenCode's own AGENTS.md; extra MCP servers | Extra servers are blocked by layers 2 and 3 (`ServerName`); duplicate rules cost tokens only. Out of scope here |
| Two OpenCode servers sharing data and gemini dirs | Contention on bindings | Cross-process lock; the loser serves an ephemeral session |
| agy's MCP HTTP client may time out a parked call before 30 min | Long tools fail inside agy | `req.signal` handling cancels and replays; SSE keepalive response if smoke test 8 shows a limit |
| Per-session MCP servers may not expose `call_mcp_tool` to the custom agent | No tools at all | Smoke test 6; per-pool agent file fallback (4.4) |
| Guard runtime probe fails (an OpenCode build that ignores `BUN_BE_BUN`) | Layer 2 off | Layers 1, 3, 4 still enforce; one-time warning |
| Status notes count as output for OpenCode | A failed assistant bubble per stall that had a note; notes visible to another provider after a switch | Accepted with the locked Q4 decision (6.3) |
| `@openchamber/opencode-claude` source not reviewed | Its canonicalization may handle cases this one misses | Compare before release when the package is available |

## Review response

Response to `docs/review-plan-sessions-runtime.neon.md`. Each finding was checked against the source named in it before the change.

| Id | Result | Reason |
| --- | --- | --- |
| SR-1 | Fixed | `idleTimeout: 255` and the silent `await` in `mcp-bridge.ts` confirmed; `server.timeout(req, 0)` (present in Bun 1.4.4) for MCP and non-streaming requests, `req.signal` handling, SSE keepalive fallback, smoke test 8 (3.3) |
| SR-2 | Fixed | Section 9 now adopts the auth design's section 15 verbatim, including `beforeSpawn`, report calls, `binaryStatus`, `updateProfileSettings`; spawn steps, `SignInUrlLineError` on stdout and stderr, the two-check `/v1` gate and `/health` fields added (3.2, 8.1) |
| SR-3 | Fixed | Same-pid rule deleted live login dirs; `createRunDir` returns a handle kept in `liveRunDirs` until `release()` (3.6, 9) |
| SR-4 | Fixed | 4.1 contradicted step 9; clean no-output failures of `append` or `redo` turns stay untainted, everything else taints, and step order puts `tainted` after the parked check (4.1, 4.3) |
| SR-5 | Fixed | Confirmed `file` and `video_url` parts, `join("")`, and the media-only user message after tool messages in `openai-chat.js`; canonicalization, `A` verification against emitted text and calls, parked check before hash checks, media forwarding (4.2 to 4.4) |
| SR-6 | Fixed | Confirmed the prototype's unemitted flush path; only emitted calls get the missing-result error, unemitted ones are flushed as `tool_calls` (3.7, 8.2) |
| SR-7 | Fixed | `force_ask`, a JSON guard that reads only `toolCall`, and a strict layer 3. Two corrections to the review: a false `ask` only reached layer 3, which rejects non-MCP tools, so nothing ran; and `process.execPath` in OpenCode is the compiled `opencode` binary, which runs scripts only with `BUN_BE_BUN=1` (verified), so the command sets it and a startup probe guards it (7.4) |
| SR-8 | Fixed | Confirmed reasoning echo and `outputStarted`; the false claim is gone and the side effects are documented as accepted under the locked Q4 decision (6.3) |
| SR-9 | Fixed | Confirmed `http.js` applies the chunk timeout to raw bytes and `Timeout` is retried 3 times; section 1 and 6.4 corrected, fatal setup failures mid-stream use code 400, SSE and pings start after 2 s regardless of notes (3.2, 6.6) |
| SR-10 | Fixed | `draining`, joinable `stop`, `acquire` during `stopping`, startup crashes in the breaker, one turn lease across setup and prompt, mutex released after turn registration, non-parked live turn handling, RPC timeouts, abandoned-turn counter (3.1 to 3.7) |
| SR-11 | Fixed | Confirmed the global registry and the token in the agent file; per-session MCP scopes, `mcpServers` removed from the agent file, per-pool agent fallback (2, 4.4) |
| SR-12 | Fixed | Same-host live pid is never stale, `poolId` and token checked on release, exit cleanup of locks and owner file (3.4, 4.8) |
| SR-13 | Fixed | Confirmed `subscribe(options)` returns `AsyncIterable`; `events.ts` loop with `types`, `event.data.sessionID`, idempotent handlers, per-setup `AbortController`, async pool shutdown (8.3, 8.4) |
| SR-14 | Fixed | Confirmed one joined system message for `openai-compatible`; 75/25 head and tail for one message, scaled shares for several, UTF-8 safe cuts with the marker inside the budget (7.1, 7.2) |
| SR-15 | Fixed | Per-tool description hashes, one `<system-update>` tag with its escape, step 7 for oversized recent messages, `inferLimits` fallback, L6 cap (4.7, 4.8, 7.3, 7.5) |
| SR-16 | Fixed | `refusal`, `/s`, id and symlink and inode guards, `readonly` vs `readOnly`, `clock.now()` stamps, `μs`, model boundary, agy's two busy strings, bounded retry and the T3 parenthetical corrected. `Agent is already processing` does not occur in the agy 1.5.15 binary, so it was dropped from the fake (4.6, 6.2, 6.5) |
| SR-17 | Fixed | No session header means `ephemeral`, never the store; the `anon:` key goes away (4.1, 4.3) |
| SR-18 | Fixed | Unit, e2e and smoke cases added for every listed path (11.1 to 11.3) |

