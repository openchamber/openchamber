# Review of `docs/design-sessions-runtime.md`

Target: `plugins/opencode-antigravity/docs/design-sessions-runtime.md`
Checked against: `docs/decisions.md`, `docs/design-install-auth.md` (section 15 and referenced sections), prototype code in `src/` and `test/`, T3 Code `app.asar` server bundles, `agy` 1.5.15 binary and embedded `hooks.md` docs, and `@opencode/ai@2.3.0`, `@opencode/core@2.3.0`, `@opencode/schema@2.3.0`, `@opencode/plugin@2.3.0`.

Summary of findings: 6 blockers, 8 major, 4 minor.

---

## Blockers

### SR-1
- **Severity**: blocker
- **Section**: 3.3, 3.5, 6.4, 10, 12
- **What is wrong**: `Bun.serve` drops idle HTTP connections after 255 seconds (`idleTimeout: 255`). Sections 6.4 and 12 account for this on non-streaming `/v1/chat/completions`, while missing that `/mcp/<token>` `tools/call` is also a non-streaming HTTP request on the same `Bun.serve` instance. When an OpenCode tool runs longer than 255 seconds (for example a build, test suite, subagent, or permission prompt), `Bun.serve` closes the MCP socket well before the 30-minute `parkedToolTtlMs`. `agy` sees a transport failure and moves on, while the proxy keeps the parked call alive and ignores the disconnect. The same 255 s cap also drops any non-streaming `/v1/chat/completions` call whose combined spawn time plus generation time exceeds 255 s.
- **Evidence**:
  - `plugins/opencode-antigravity/src/proxy.ts:189-194` configures `Bun.serve({ ..., idleTimeout: 255 })`.
  - `plugins/opencode-antigravity/src/mcp-bridge.ts:118-142` awaits `this.onToolCall(...)` with no bytes written until OpenCode posts the tool result, and never observes `req.signal`.
  - `docs/design-sessions-runtime.md` line 124 and line 740 set `parkedToolTtlMs` to 30 min (1 800 000 ms), and line 524 caps only non-streaming stall timeouts at 240 s.
- **Suggested fix**: Call `server.timeout(req, 0)` on `/mcp/<token>` `tools/call` requests (and non-streaming `/v1/chat/completions` requests) so Bun does not kill active parked calls at 255 s. Wire `req.signal` abort handling in `McpBridge` so a real disconnect from `agy` rejects and cleans up the parked call immediately. Add a check to smoke test 11.3 confirming whether `agy`'s own MCP HTTP client imposes a per-call timeout shorter than 30 min (and if it does, return Streamable HTTP `text/event-stream` responses with periodic keepalives from `tools/call`).

### SR-2
- **Severity**: blocker
- **Section**: 2, 3.2, 3.4, 6.3, 8, 9
- **What is wrong**: The interface contract in section 9 has drifted from `docs/design-install-auth.md` section 15 and section 13.3. Implementing section 9 as written leaves five required behaviors unimplemented:
  1. `InstallAuthBridge` omits `beforeSpawn(): Promise<void>`, `reportAuthenticated(): void`, and `reportSignInRequired(message: string): void`, and section 3.2 never calls them. Spawns can race with an active logout or login finalization, and mid-session sign-outs never update OpenCode's `needs_auth` connection status.
  2. Section 2 and section 3.2 omit `SignInUrlLineError` detection in `AcpClient` when stdout prints `Open the following link to authenticate the ACP server: `. The prototype skips non-JSON stdout lines, so `authenticate` hangs for 60 s until timeout.
  3. Section 8 omits the `/v1/*` credential gate from `design-install-auth.md` section 13.3: requests must present both `x-antigravity-proxy-token` and `Authorization: Bearer agy-managed` (answering 401 `auth_required` when the marker is missing). The prototype's `isAuthorizedApiRequest` accepts either header.
  4. Section 6.3 omits download progress notes from `BinaryManager.status()` (`Downloading Google's Antigravity CLI (<n> of <m> MB). This happens once.`), and section 8 omits `/health` reporting `auth` and `binary`.
  5. Section 9 omits `attachRuntime(control, createRunDir)` wiring between `AuthManager` and the pool.
- **Evidence**:
  - `docs/design-install-auth.md` lines 558-559 (proxy gate and `/health`), lines 596-639 (`InstallAuthBridge` additions, `SignInUrlLineError`, `RuntimeControl`, `CreateRunDir`).
  - `docs/design-sessions-runtime.md` lines 703-722 (`InstallAuthBridge` missing the 3 methods) and lines 103-111 (spawn steps).
  - `plugins/opencode-antigravity/src/proxy.ts:300-308` (`isAuthorizedApiRequest` OR-check) and `src/acp-client.ts:358-362` (non-JSON stdout lines ignored).
- **Suggested fix**: Sync section 9 verbatim with `design-install-auth.md` section 15. Add `beforeSpawn()`, `reportAuthenticated()`, `reportSignInRequired()` to section 3.2 and error handling, specify `SignInUrlLineError` in `AcpClient`, specify the dual-header `/v1/*` gate and `/health` fields in section 8, and include download progress notes in section 6.3.

### SR-3
- **Severity**: blocker
- **Section**: 3.6, 9
- **What is wrong**: `sweepStaleRunDirs()` deletes a live login temp dir created by the same process. Section 9 states that login creates its temp dir through `createRunDir()` so the sweeper leaves it alone, yet section 3.6 rule 1 deletes every `run-*` directory whose PID matches `process.pid` unless it is the current runtime generation's dir. A login (or `probe`, `logout`, or `verifyAgy` child) runs under the same PID with a different run dir, so any concurrent spawn triggers a sweep that deletes its `TMPDIR` out from under it.
- **Evidence**:
  - `docs/design-sessions-runtime.md` line 193: "`run-*` whose pid is ours but not the current generation: delete."
  - `docs/design-sessions-runtime.md` line 728: "a login's temp dir is created through `createRunDir()` ... so `sweepStaleRunDirs()` never deletes a live login's files."
  - `docs/design-install-auth.md` line 411 and line 628: `AuthManager` calls `createRunDir()` for `--login`.
- **Suggested fix**: Have `createRunDir()` return a handle `{ path: string; release(): void }` and keep all unreleased run dirs in an in-memory `Set<string>`. In `sweepStaleRunDirs()`, skip any `run-*` whose path is in that live set when `owner.pid === process.pid`.

### SR-4
- **Severity**: blocker
- **Section**: 3.5, 4.1, 4.3, 4.4, 6.4
- **What is wrong**: The rules for `tainted` bindings and `redo` contradict each other and break after a tool-resume stall:
  1. Section 4.1 marks every failed or cancelled turn as `tainted`, and section 4.3 step 4 runs before step 9 and forces `fresh` on any `tainted` binding. That makes step 9 (`failed_no_output` -> `redo`) unreachable.
  2. If `failed_no_output` is changed to leave the binding untainted (as section 6.4 implies), two cases still break. First, when `session/cancel` times out after `cancelSettleMs` (section 3.5), the ACP session is abandoned and must be tainted, so `redo` cannot reuse it. Second, when a `resume` turn stalls after resolving parked tool calls with no model output, `prefixCount` was already advanced past `[A, R]` (line 303), `T` is empty on OpenCode's retry, and `redo` tries to rebuild `messages[inputFrom..inputTo]` (`[assistant, tool]`) as a new `session/prompt` on a cancelled turn.
- **Evidence**:
  - `docs/design-sessions-runtime.md` line 225 (`live(turn) --turn failed/cancelled, or crash--> tainted`), line 291 (step 4 checks `tainted`), line 299 (step 9 checks `failed_no_output`), line 303 (prefix advances at dispatch), line 313 (`redo` dispatch), line 527 (`failed_no_output` vs `failed_with_output`).
- **Suggested fix**: Update section 4.1 so `failed_no_output` leaves the binding `live(idle)` only when all three hold: the turn started from `append` (never `resume` or `fresh`), `session/cancel` settled cleanly within `cancelSettleMs`, and zero text, thought, or tool calls were emitted. Every other failure or cancel (including any `resume` stall or cancel timeout) transitions to `tainted` and forces a `fresh` replay on the next request.

### SR-5
- **Severity**: blocker
- **Section**: 4.2, 4.3, 4.4, 4.6, 7.5
- **What is wrong**: Four fingerprinting and classification defects cause both false appends (silent history divergence) and false edits (unnecessary cold replays):
  1. **Edit classified as append (assistant tail)**: Step 6 (lines 293-295) validates only tool call IDs in `A` and allows multiple leading assistant messages. It never checks assistant text or tool call names and arguments. Editing the last assistant message's text or tool arguments (or inserting an extra assistant message) passes step 6 and reuses the old ACP session with stale history.
  2. **Edit classified as append (PDF and video parts)**: Section 4.2 hashes only `text` and `image_url` parts. OpenCode's OpenAI Chat protocol also emits `file` parts for PDFs and `video_url` parts. Adding, removing, or replacing a PDF or video attachment produces an identical message fingerprint.
  3. **Append classified as edit (multi-part text join)**: Section 4.2 joins text parts with `"\n"`. OpenCode's `lowerUserMessage` and `lowerAssistantMessage` collapse arrays of plain text parts into a single string with `.join("")` once `cache_control` moves off that message. When a user message has multiple text parts (for example a skill block plus user text), shifting cache breakpoints flips its representation between array (`"A\nB"`) and string (`"AB"`), triggering a false `prefix-mismatch`.
  4. **Tool-result media misclassified as steering, and step 3 contradicts section 7.5**: When an OpenCode tool returns an image or PDF, `openai-chat.js` appends a synthetic `role: "user"` message containing the media immediately after the `role: "tool"` messages. Step 6 puts that message into `U` and step 7 classifies a normal tool return as `resume` + `steer`, invoking the steering path (whose behavior is also unspecified when `steers` or `config.steering` is false). Separately, step 3 (line 290) cancels a parked turn and forces `fresh` whenever `toolsSchemaHash` changes, directly contradicting section 7.5 line 678 ("Ignored for the running turn"). The existing test `test/e2e-proxy.test.ts:276, 319` omits `parameters` on the resume request and would fail under step 3.
- **Evidence**:
  - `@opencode/ai@2.3.0/dist/protocols/openai-chat.js:119-133, 316-332` (`file` and `video_url` user parts), lines 372-376 and 424-429 (`.join("")`), lines 446-452 and 511-569 (`pendingAttachments` and `flushAttachments` emitting a `user` message after `tool` messages).
  - `@opencode/core@2.3.0/dist/chunks/app-9ep3x7ab.js:203-207` (multiple text parts in one user message when skills are attached).
  - `docs/design-sessions-runtime.md` lines 242-251, 290-301, 337-339, 678; `test/e2e-proxy.test.ts:276, 319`.
- **Suggested fix**:
  - Canonicalize `file` (`filename` + `sha256(file_data)`) and `video_url` (`url` hash) parts in `i` (or a `m` media array), and join text parts with `""` to match `openai-chat.js`.
  - Record `emittedTextHash` and `emittedToolCalls: [{ id, name, argsHash }]` on `lastTurn`, require `A.length <= 1`, and verify `A` matches them in step 6.
  - Run the parked-turn `resume` check (step 7) before step 3's `systemHash` and `toolsSchemaHash` checks (keeping `authEpoch` and `cwd` checks first) so mid-turn tool changes follow section 7.5.
  - Handle tool-result media user messages cleanly (attach image content to the MCP tool result when supported, or explicitly steer only when `steers && config.steering` and specify fallback to cancel + fresh when steering is disabled).

### SR-6
- **Severity**: blocker
- **Section**: 3.5, 3.7, 4.3, 8
- **What is wrong**: Section 3.7 states that when a resume request is missing some parked tool call IDs, the missing ones resolve with `isError: true` (`OpenCode returned no result for this tool call.`). That rule fails to separate emitted parked calls from unemitted ones. When `agy` makes a second MCP `tools/call` after the 250 ms settle window already closed the SSE stream for the first batch, the second call sits in `parkedCalls` with `emitted: false` and OpenCode has never seen it. When OpenCode posts the result for the first batch, resolving every missing ID in `parkedCalls` as an error kills the unemitted call.
- **Evidence**:
  - `plugins/opencode-antigravity/src/proxy.ts:387-396` (settle timer sets `emitted = true` on the first batch and clears `turn.sink`) and lines 475-479 (prototype flushes `unemitted` calls on the resume request with `respondWithToolCalls`).
  - `docs/design-sessions-runtime.md` line 216 (partial tool results rule) and section 4.3/8 (no mention of `unemitted` parked calls).
- **Suggested fix**: Track `emitted: boolean` per parked call. On `resume`, mark only `emitted === true` parked calls missing from `R` as `isError: true`. Then check for remaining `emitted === false` parked calls: if any exist, mark them `emitted = true`, append them to `emittedToolCallIds`, emit them as a `tool_calls` response, and stay in `parked` without advancing into `awaiting_model`.

---

## Major

### SR-7
- **Severity**: major
- **Section**: 7.4, 7.5, 11.3
- **What is wrong**: The tool guard has three gaps across layers 2 and 3:
  1. `opencode-tool-guard.sh` runs a shell substring `case` match over the entire stdin payload, which includes `lastUserInput` on every `PreToolUse` event. Any prompt mentioning `"name":"call_mcp_tool"` and `"ServerName":"opencode"` (or a tool argument containing those strings) causes the hook to allow every built-in tool past layer 2.
  2. The hook outputs `{"decision":"ask"}`. In `agy`'s hook contract, `ask` honors cached "Always Allow" permissions, which can skip layer 3 (`session/request_permission`), whereas `force_ask` always prompts.
  3. Section 7.4 never specifies layer 3 (`allowPermission`), leaving the prototype's implementation in place. The prototype has a fail-open check `(toolName === "" || turn.allowedToolNames.has(toolName))`, checks only PascalCase `ServerName` and `ToolName` (protojson in `agy` often uses camelCase), and requires `tc.name === "call_mcp_tool"` even though `toolCall.name` is an optional unstable ACP field and may be omitted or `mcp_tool`. Also, setting `toolGuardHook: false` does not say whether an existing `opencode-bridge-guard` entry in `hooks.json` is removed.
- **Evidence**:
  - Embedded `agy-customizations/docs/hooks.md` lines 149-166 (`camelCase` protojson keys, `lastUserInput` in common input fields) and lines 216-218 (`ask` respects "Always Allow" cache; `force_ask` ignores cached permissions).
  - `plugins/opencode-antigravity/src/proxy.ts:264-280` (`(toolName === "" || turn.allowedToolNames.has(toolName))`, PascalCase only, `tc.name === "call_mcp_tool"`).
  - T3 Code `runtimeLayer-CyWe8jGq.mjs:11202` (ACP `toolCall.name` is optional and marked `UNSTABLE`).
- **Suggested fix**: Replace the shell substring script with a small JS guard executed by `process.execPath` (Bun or Node is guaranteed present on both Unix and Windows, avoids PowerShell startup latency on Windows, and parses real JSON on both platforms). Inspect only `payload.toolCall.name` and `payload.toolCall.args` (supporting `ServerName` / `serverName` / `server_name`) and print `{"decision":"force_ask"}`. Specify layer 3 explicitly: require an active non-done turn of the current generation with `allowTools === true`, match server `"opencode"` across key casings, require a non-empty `toolName` present in `turn.allowedToolNames` (never fail open on `""`), and verify the exact `session/request_permission` payload in smoke test 11.3. When `toolGuardHook: false`, delete the `opencode-bridge-guard` key from `hooks.json` while preserving foreign hooks.

### SR-8
- **Severity**: major
- **Section**: 1, 6.3, 6.4
- **What is wrong**: Section 6.3 states that OpenCode does not send `reasoning_content` back to the model because OpenAI chat lowering only echoes reasoning for providers that ask for it. That is false in OpenCode 2.3.0. In addition, emitting status notes as `reasoning_content` has three unstated consequences in OpenCode's runner:
  1. `reasoning_content` deltas emit `reasoning-start`, which sets `outputStarted = true` and records `time.firstToken`.
  2. When the turn later stalls and returns a retryable 504/429/503 error, OpenCode sees `outputStarted === true`, calls `failAssistant(llmError)` to persist a visible failed assistant message containing the status notes, and starts a new assistant message on retry (`freshAssistant: true`). Repeated retries leave multiple failed assistant bubbles in the chat.
  3. Automatic context-overflow compaction in OpenCode is gated on `!publisher.record().outputStarted`. Once a status note has been sent, an overflow error on that turn can no longer trigger auto-compaction.
  4. On completed turns, `openai-chat.js` echoes `reasoning_content` back on subsequent requests whenever `observedField` is set or `!fullyStructured`. Our proxy ignores `reasoning_content`, so it stays out of `agy`, yet if the user or failover plugin switches to another provider mid-session, `[Antigravity]` status notes are sent to the other model as prior reasoning.
- **Evidence**:
  - `@opencode/ai@2.3.0/dist/protocols/openai-chat.js:401-436, 930-944` (records `reasoningField: "reasoning_content"` on ingest and replays `[field]: reasoningText` whenever `reasoning.length > 0`).
  - `@opencode/core@2.3.0/dist/chunks/app-xpfyx3j9.js:16, 303-304, 325-326` (`beginsOutput` includes `"reasoning-start"`, calling `firstToken()` and setting `outputStarted = true`).
  - `@opencode/core@2.3.0/dist/chunks/app-cg4g5y95.js:135, 165-170, 212-213` (checks `!recorded.outputStarted` for overflow compaction and in-place retry; persists `failAssistant` and sets `freshAssistant: true` once output started).
- **Suggested fix**: Correct the factual claim in section 6.3 and document these three side effects explicitly. Consider delaying the first note until after `session/prompt` is dispatched (and keeping `statusNoteAfterMs` conservative, or offering an option to suppress notes on retry attempts) so transient errors before first model output can retry cleanly in-place without leaving failed assistant bubbles.

### SR-9
- **Severity**: major
- **Section**: 1, 3.2, 6.4, 6.6
- **What is wrong**: Two OpenCode error-classification and timeout behaviors are misstated, causing a retry loop on `binary_not_found` and a potential timeout when `statusNotes: false`:
  1. **Mid-stream `binary_not_found` retries 10 times**: Section 3.2 starts SSE after 2 s while `resolveBinary()` may still be downloading or verifying the binary. If `resolveBinary()` then fails, HTTP 200 headers are already sent, so `x-should-retry: false` cannot be returned. Section 6.6 sends a mid-stream event with `code: 503`. OpenCode classifies any mid-stream `code >= 500` with no `http.headers` as `ProviderInternalError`, which is retryable, causing up to 10 retries of a broken install or unsupported platform.
  2. **Incorrect OpenCode timeout claims**: Section 1 (line 30) and section 6.4 (line 533) cite `app-mshnpp5g.js` (`aisdk.ts`) for `chunkTimeout` and claim SSE comments do not reset it and `Timeout` errors are not retried. This plugin uses `@opencode/ai/providers/openai-compatible` (`src/index.ts:124`), which goes through `@opencode/ai/dist/route/transport/http.js`, where `Stream.timeoutOrElse` wraps the raw response byte stream before SSE framing (so `: ping` comments do reset `chunkTimeout`), and HTTP header/chunk timeouts produce `TransportError` with `code: "Timeout"`, which OpenCode retries up to 3 times (`MAX_TIMEOUT_RETRIES = 3`).
  3. **Slow start with `statusNotes: false`**: Section 3.2 step 6 starts SSE after 2 s to send the start note. If `statusNotes: false` skips starting SSE early, a slow first download or `verifyAgy` (up to 90 s+) plus `initialize`/`authenticate` can exceed `Bun.serve`'s 255 s `idleTimeout` or OpenCode's 300 s `headerTimeout`.
- **Evidence**:
  - `@opencode/ai@2.3.0/dist/protocols/openai-chat.js:886-895`, `provider-error.js:205, 219`, `schema/errors.js:155-182` (`503` mid-stream -> `ProviderInternalError`, retryable; `400` mid-stream -> `InvalidRequestError`, non-retryable).
  - `@opencode/ai@2.3.0/dist/route/transport/http.js:55-80` (`Stream.timeoutOrElse` before `prepared.framing.frame`, creating `TransportError` with `code: "Timeout"`).
  - `@opencode/core@2.3.0/dist/chunks/app-2fc7eemy.js:39, 52-57` (`MAX_TIMEOUT_RETRIES = 3` on `Transport` `code === "Timeout"`).
- **Suggested fix**: For `binary_not_found` after SSE headers were already sent, emit `code: 400` and `type: "invalid_request_error"` (or wait to send SSE headers until `resolveBinary()` finishes when not downloading, while still using `code: 400` for any post-header fatal setup failure) so OpenCode stops retrying. Always start SSE and run `: ping` heartbeats after 2 s on streaming requests even when `statusNotes: false`. Update section 1 and section 6.4 to reflect `@opencode/ai`'s native `http.js` transport accurately.

### SR-10
- **Severity**: major
- **Section**: 2, 3.1, 3.3, 3.4, 3.5, 3.7, 4.3, 8, 9
- **What is wrong**: Several process, mutex, and turn state transitions are missing or race-prone, leaving implementers to guess and risking wedged sessions or leaked leases:
  1. **Second request while a turn is running (non-parked)**: `classifyRequest` (section 4.3) checks `liveTurn` only when `parked`. If a second request arrives while a turn is `dispatching`, `awaiting_model`, `streaming`, or `cancelling`, no rule cancels or rejects it; dispatching another `session/prompt` collides on `turnsByAcpSession` and leaks the first turn's lease.
  2. **`KeyedMutex` release boundary**: Section 8 step 2 acquires the session mutex and section 3.7 says it is released before streaming, while section 8 step 5 starts streaming after 2 s during a slow spawn. It is unspecified whether the mutex stays held across spawn/download (blocking interrupts and `session.deleted` for minutes) or is released before `turn` is registered (opening a race window).
  3. **Missing `AgyProcessManager` transitions**: Section 3.1 does not define `acquire()` during `stopping`, `stop()` during `starting` or `stopping` (note `AuthManager.logout` and `onAuthChanged` both invoke `stop("auth-changed")`), or the draining state required by `onBinaryChanged` (section 9 line 729). Worse, separating `"setup"` and `"turn"` leases in section 3.3 creates a zero-lease gap between `session/new` and `session/prompt` where `onBinaryChanged` could kill the process mid-request.
  4. **Circuit breaker misses startup crashes**: Section 3.4 step 5 counts only unexpected exits from `ready` (line 139), skipping exits during `starting` (line 149). A binary that crashes immediately on every spawn never trips the breaker.
  5. **Wedged-process check and missing RPC timeouts**: Section 3.5 triggers `stop("wedged")` when every turn is stuck in cancel-timeout and no RPC completed for `stallTimeoutMs`, yet defines no timer, no tracking of abandoned turns, and no policy for whether abandoned turns keep or release their lease. Section 2 promises per-request RPC timeouts in `AcpClient`, yet section 3.2 gives timeouts only for `initialize` (30 s) and `authenticate` (60 s), leaving `session/new`, `session/resume`, `set_config_option`, and `session/close` unbounded.
- **Evidence**:
  - `docs/design-sessions-runtime.md` lines 68-76 (process state machine), 116-123 (lease table), 139-149 (crash and breaker), 178 (cancel and wedged rule), 206 (KeyedMutex), 297 (`liveTurn` check), 688-691 (request sequence), 729 (`onBinaryChanged` drain).
- **Suggested fix**:
  - In `classifyRequest` / dispatch: if a live turn exists in any non-parked active phase, cancel it (tainting the binding) before starting a `fresh` session, or wait for `cancelling` to finish before classifying.
  - Hold one `"turn"` lease across setup and prompt (releasing it in `finally` if setup fails before `Turn` takes ownership) so no zero-lease gap exists.
  - Release `KeyedMutex` only after `Turn` is registered (or reserve a placeholder turn slot before awaiting spawn/download so a second request sees it without blocking interrupts).
  - Add `draining` to `ProcessState`, make `stop()` idempotent/joinable across `starting`/`stopping`, make `acquire()` wait for `stopping` -> `stopped`, and count crashes during `starting` toward the circuit breaker (excluding `auth_required`).
  - Specify explicit RPC timeouts (for example 30 s for `session/new`, `session/resume`, `set_config_option`, `session/close`) and a concrete timer/counter for abandoned turns so wedged processes recover reliably without leaking leases.

### SR-11
- **Severity**: major
- **Section**: 2, 4.4, 7.3, 7.4, 9
- **What is wrong**: Shared MCP state collides across concurrent sessions and across processes sharing `geminiDir`:
  1. `McpBridge` uses a single global `registry` map that only inserts and overwrites (`src/mcp-bridge.ts:48-64`), and section 2 leaves `mcp-bridge.ts` unchanged. When two OpenCode sessions run concurrently with different tool sets or different schemas for a tool of the same name, one session's `registerTools` overwrites the other's schemas in `tools/list`, violating section 7.3's guarantee that `tools/list` always returns exact full schemas.
  2. The prototype's `prepareProfileDir` (`src/binary.ts:116-129`) writes `mcpUrl` (containing this process's ephemeral port and secret `mcpToken`) into `<gemini>/config/agents/opencode-bridge.md`. With two OpenCode processes sharing `geminiDir` (supported by sections 3.6 and 4.8), process B overwrites process A's `mcpUrl`, the secret `mcpToken` is persisted on disk, and `meta` sessions (which pass `mcpServers: []`) still inherit the agent's static `mcpServers` block.
- **Evidence**:
  - `plugins/opencode-antigravity/src/mcp-bridge.ts:48-64` and `src/proxy.ts:495`.
  - `plugins/opencode-antigravity/src/binary.ts:116-129` (`mcpServers:` block in `opencode-bridge.md`).
  - `docs/design-sessions-runtime.md` lines 42-60 (`mcp-bridge.ts` not listed), line 315 (`meta` passes no MCP servers), line 319 (`mcpServers` passed on new and resume), line 622 (`tools/list` returns full schemas).
- **Suggested fix**: Remove `mcpServers:` from `opencode-bridge.md` so MCP is attached solely via `session/new` and `session/resume` (verify in smoke test 11.3 that `agy` connects to per-session `mcpServers` without a static declaration in the agent file). Scope `McpBridge`'s tool registry per session (for example by embedding a per-session token/binding id in `mcpUrl`, `/mcp/<mcpToken>/<scopeId>`, so `tools/list` returns the exact tool list for that session and cleans up on session close).

### SR-12
- **Severity**: major
- **Section**: 3.4, 4.8, 6.4
- **What is wrong**: Cross-process `<bindingId>.lock` handling breaks across host sleep and lacks ownership verification on unlock. Section 4.8 marks a lock stale whenever its mtime is older than 5 min, even if `lock.host` matches this machine and `lock.pid` is still alive. Section 6.4 explicitly expects host sleep (laptop lid closed) and parked turns live up to 30 min. After a 6-minute sleep, a second OpenCode process can steal the lock of a live process on the same host, and when the first process later goes dormant it unlinks the lock without verifying `poolId`, deleting the second process's live lock. Also, section 3.4 says `process.once("exit")` sends SIGTERM and does nothing else, leaving `owners/<pid>.json` and `.lock` files on disk on unclean shutdown.
- **Evidence**:
  - `docs/design-sessions-runtime.md` line 151 (`process.once("exit")` does nothing else), line 422 (5 min mtime staleness, no token check on unlock), line 525 (host sleep tolerance).
  - Contrast with `docs/design-install-auth.md` line 290, which verifies `owner.json.token` before removing a lock and releases on `process.on("exit")`.
- **Suggested fix**: On the same host (`lock.host === os.hostname()`), check `process.kill(lock.pid, 0)` first: if the PID is alive, do not treat a 5-minute mtime gap as stale (use mtime only when the host differs or as a much longer fallback such as 24 h). Verify `poolId` before deleting `<bindingId>.lock`, and remove owned `.lock` files and `owners/<pid>.json` synchronously on pool stop and `process.once("exit")`.

### SR-13
- **Severity**: major
- **Section**: 2, 4.8, 8
- **What is wrong**: The prototype's OpenCode event subscription is broken (`src/index.ts:179-189` passes a callback to `ctx.event.subscribe` and reads `event.properties.sessionID`, which never fires in OpenCode 2.3.0). `docs/design-install-auth.md` explicitly states that the runtime design owns fixing event subscription, yet `docs/design-sessions-runtime.md` never specifies the `AsyncIterable` loop, `types` filter, `event.data.sessionID` shape, `AbortController` teardown, or multi-location deduplication (OpenCode calls `setup()` once per location). In addition, `releasePool()` in `src/index.ts:57-71` calls `proxy.stop()` synchronously, whereas `AgyProcessManager.stop("shutdown")` is async (up to 8 s).
- **Evidence**:
  - `@opencode/plugin@2.3.0/dist/promise/event.d.ts:4-6` (`subscribe(options)` returns `AsyncIterable`).
  - `@opencode/schema@2.3.0/dist/session-event.js:28, 153-160, 206-215` (`session.deleted`, `session.execution.interrupted`, `session.execution.failed` carry `data.sessionID`).
  - `docs/design-install-auth.md` line 86 and line 639 ("the runtime design owns that fix").
  - `plugins/opencode-antigravity/src/index.ts:57-71, 179-189`.
- **Suggested fix**: Add a subsection in section 8 specifying the `for await (const event of ctx.event.subscribe({ types: ["session.deleted", "session.execution.interrupted", "session.execution.failed"], signal }))` loop, reading `event.data.sessionID`, aborting `signal` in `setup()` cleanup, making handlers idempotent across locations, and coordinating async `proxy.stop()` in `releasePool()` (including a new `acquirePool()` waiting if a previous pool is mid-shutdown).

### SR-14
- **Severity**: major
- **Section**: 7.1, 7.2
- **What is wrong**: Section 7.2's section-budget scheme (20 KB first section, 8 KB last section, middle sections share the rest) assumes OpenCode sends multiple leading `system` messages (agent prompt first, environment/instructions last). In OpenCode 2.3.0, `openai-chat.js` joins all `request.system` parts into a single `{ role: "system", content: string }` message (since `openai-compatible` sets no `cacheControl`). As a result:
  1. The multi-section split never runs for OpenCode.
  2. Under step 3 as written ("first section keeps up to 20 KB... unused share passes to the next section"), a single 36 KB system message is either capped at 20 KB (wasting 12 KB of the 32 KB locked budget) or head-truncated at 32 KB (discarding the trailing `<env>` and instructions block that step 3 aimed to protect).
  3. Hardcoded 20 KB + 8 KB values break when `maxSystemPromptBytes` is configured below 28 672 bytes, and section 7.2 does not require UTF-8-safe slicing or counting the omission marker's bytes inside the budget.
- **Evidence**:
  - `@opencode/ai@2.3.0/dist/protocols/openai-chat.js:467-480` (`[{ role: "system", content: ProviderShared.joinText(request.system) }]`).
  - `@opencode/core@2.3.0/dist/chunks/app-51cnt4a7.js:83-89` (`baseTranscript` builds 2 `SystemPart`s, which `openai-chat.js` concatenates into 1 message).
  - `docs/design-sessions-runtime.md` lines 597-604.
- **Suggested fix**: When there is a single system message over budget, keep both its head (about 75 percent of `maxSystemPromptBytes`) and its tail (about 25 percent, preserving `<env>` and instructions) with the omission marker in between. When there are multiple system messages, scale the first/last shares proportionally to `maxSystemPromptBytes` (for example 20/32 and 8/32). Slice on UTF-8 code-point boundaries and subtract the omission marker's byte length from the kept content so total output never exceeds `maxSystemPromptBytes`.

---

## Minor

### SR-15
- **Severity**: minor
- **Section**: 4.7, 4.8, 7.3, 7.5
- **What is wrong**: Four small specification gaps in prompt/replay formatting and state persistence:
  1. Section 7.5 emits `<system-update>The descriptions of these OpenCode tools changed:` with only the changed tools, yet section 4.8 persists only one aggregate `toolsDescHash`. After a process restart (or without an in-memory per-tool hash map), the proxy cannot tell which tools changed.
  2. Section 4.4 (line 309) and section 7.5 (line 677) use `<system-update>` (hyphen), while section 4.7 (line 356) uses `<system_update>` (underscore), and section 4.7 line 365 omits `</system_update>` from the closing-tag escape list.
  3. Section 4.7 never trims messages inside the last 6 messages: if a single recent tool result is 1 MB, the replay exceeds `budgetChars`. It also references `model.contextLimit` without a fallback for unknown model IDs.
  4. Section 7.3 stops at L5 (replacing `parameters` with an 80-char placeholder) with no fallback if a very large tool list still exceeds `maxToolsPromptBytes`.
- **Evidence**: `docs/design-sessions-runtime.md` lines 309, 356, 365-376, 396, 620, 677.
- **Suggested fix**: Store `toolsDescHashes: Record<string, string>` (tool name to short hash) in the binding record so changed tools are identifiable across restarts. Standardize on `<system-update>` and escape `</system-update>`. Add a step 7 in section 4.7 that head/tail trims oversized tool results within the last 6 messages, define `inferLimits(model).contextLimit` as the fallback, and add a final cap in section 7.3 if L5 still exceeds budget.

### SR-16
- **Severity**: minor
- **Section**: 1, 4.6, 6.2, 6.5
- **What is wrong**: Minor inaccuracies and missing edge cases compared with T3 Code and `agy` 1.5.15:
  1. Section 6.5 ignores `stopReason === "refusal"` (T3 Code treats it as quota exhaustion even without a SQLite error step), omits the `/s` (dotAll) flag on `API_ERROR` (error messages can span lines), omits symlink/UUID/inode verification on `<sessionId>.db`, and does not note that `bun:sqlite` uses `{ readonly: true }` while `node:sqlite` uses `{ readOnly: true }`.
  2. Section 6.2 maps glog timestamps (`I1123 12:04:48.980078`, which have no year or timezone) to epoch ms without specifying year-rollover or timezone handling; `parseGoDuration` omits `μs` (U+03BC, handled in T3 Code alongside `µs` U+00B5); `for model (\S+)` can capture trailing punctuation; model prefix matching needs a boundary check (`event.model === m || event.model.startsWith(m + "-")`) to avoid prefix collisions between model names.
  3. Section 4.6 states "(T3 Code does the same)" for its 10 s steering retry cap, whereas T3 Code's `sendPromptWhenIdle` retries indefinitely while the turn is active. Also, `agy` 1.5.15 has a third transient busy error string (`the running prompt is being cancelled; wait for it to finish, then send this prompt again`) that section 4.6 does not list, and the permission-wait retry in 4.6 has no retry bound.
- **Evidence**:
  - T3 Code `server-8K5Ixyrs.mjs:19275-19348, 19381-19417` (`API_ERROR /s`, `μs`, `stopReason === "refusal"`, `NATIVE_SESSION_ID`, `antigravityManagedPath`, inode check, `DatabaseSync(..., { readOnly: true })`).
  - T3 Code `runtimeLayer-CyWe8jGq.mjs:20236-20245` (`sendPromptWhenIdle` unbounded retry).
  - `agy` 1.5.15 binary strings (`the running prompt is being cancelled; wait for it to finish, then send this prompt again`) and real log lines in `~/.t3/userdata/providers/antigravity/*/antigravity-acp/log/*.log`.
- **Suggested fix**: In section 6.5, handle `stopReason === "refusal"`, add `/s` to `API_ERROR`, validate `sessionId` matches `/^[\w-]+$/` and check `lstat` (no symlinks) before opening SQLite, and note the `readonly` / `readOnly` option difference. In section 6.2, stamp tailed retry events with `clock.now()` (avoiding yearless glog parsing), add `μs`, strip trailing punctuation from `model`, and require `-` or end-of-string on model prefix attribution. In section 4.6, drop the inaccurate T3 parenthetical, bound the permission-wait retry, and retry on `"the running prompt is being cancelled"`.

### SR-17
- **Severity**: minor
- **Section**: 4.3, 4.8
- **What is wrong**: Section 4.8 assumes `sessionKey` is always an OpenCode session ID (`ses_...`) and never specifies what happens when `x-antigravity-session` is absent (for example direct `/v1/chat/completions` calls or an OpenCode call with no `sessionID`). The prototype falls back to `anon:<hash of first 512 chars of first user message>`, which collides across unrelated sessions that start with the same short prompt (such as `"hi"`). Persisting `anon:` keys in `SessionStore` would cross-wire unrelated sessions.
- **Evidence**: `plugins/opencode-antigravity/src/proxy.ts:446-447`, `src/prompt.ts:143-147`, `docs/design-sessions-runtime.md` line 387.
- **Suggested fix**: State in section 4.3 and 4.8 that requests without `x-antigravity-session` never read or write `SessionStore` and run as ephemeral sessions (allowing tool-call resume only in memory via `turnsByToolCallId`).

### SR-18
- **Severity**: minor
- **Section**: 11.1, 11.2, 11.3
- **What is wrong**: Several high-risk code paths in the design have no test cases in section 11:
  - Multi-round tool calls within a single ACP turn (park -> resume -> second park -> resume -> `end_turn`) and a late-arriving unemitted parallel tool call arriving after the 250 ms settle window.
  - Partial tool results (1 of 2 emitted parked calls returned: missing call resolves with `isError: true`, no HTTP 409).
  - Tool result returning an image (synthetic trailing `user` message from OpenCode's `openai-chat.js`).
  - Client abort (`AbortSignal`) during slow spawn, mid-stream, and while parked, plus `cancelSettleMs` timeout triggering abandoned-session taint and wedged-process recovery.
  - Second request arriving for the same session while a turn is `streaming` or `awaiting_model`.
  - `onAuthChanged` (`login`, `account-changed`, `logout`) failing live turns with 503 vs 401 and invalidating bindings; `onBinaryChanged` draining active leases before restarting.
  - `sweepStaleRunDirs` preserving a live `login` run dir created by the same PID.
  - `AcpClient` receiving `AUTH_URL_STDOUT_PREFIX` on stdout and failing fast with 401.
  - `ctx.event.subscribe` (`AsyncIterable` + `event.data.sessionID`) for `session.deleted` and `session.execution.interrupted`, including duplicate delivery across multiple locations.
  - Smoke test 11.3 capturing the exact `session/request_permission` payload (`toolCall.name`, `rawInput` key casing) and verifying whether `agy` enforces an MCP HTTP per-call timeout.
- **Evidence**: `docs/design-sessions-runtime.md` lines 775-825.
- **Suggested fix**: Add these cases to sections 11.1, 11.2, and 11.3.

---

## Checked and found correct

- **agy 1.5.15 CLI flags and version**: Verified via `antigravity --version` (`1.5.15`), `antigravity acp --help` (`--log-file`, `--process-per-session`, `--include-default-customizations`, `--agent`, `--gemini-dir`, `--app-data-dir`, `--disable-telemetry`), and `.install-complete.json`.
- **agy 1.5.15 retry log format and stream idle timeout**: Verified against real logs under `~/.t3/userdata/providers/antigravity/*/antigravity-acp/log/*.log`: `run.go:308] Run: attempt N failed (...), retrying in <Go duration>` with no session ID, `No capacity available for model <model>-<level>`, and `stream idle timeout (10m0s): context deadline exceeded`.
- **T3 Code ACP behavior**: Verified in `app.asar` (`server-8K5Ixyrs.mjs` and `runtimeLayer-CyWe8jGq.mjs`): `resumeMethod: "resume"`, `_meta.antigravity.systemPrompt.append === true`, 15-minute `promptInactivityTimeout` in 60 s slices with 10 s host-sleep tolerance and pause on pending tools/permissions, `retireAntigravityRuntimeTempDirs` rename-then-delete pattern, and `AntigravityTurnOutcome.ts` reading `step_type = 17` from `conversations/<sessionId>.db` with `PRAGMA busy_timeout = 100`.
- **OpenCode 2.3.0 retry classifier and backoff**: Verified in `@opencode/ai@2.3.0/dist/provider-error.js`, `schema/errors.js`, and `@opencode/core@2.3.0/dist/chunks/app-2fc7eemy.js`: `RateLimit`, `ProviderInternal` (>= 500, 408, 409), and `UnknownProvider` retry; `QuotaExceeded` (402 or 429 matching `QUOTA_TEXT`) and `Authentication` (401, 403) do not; `x-should-retry` overrides on HTTP responses; up to 10 retries, 2 s exponential capped at 10 s, jittered, raised to `retry-after` up to 15 min.
- **OpenCode 2.3.0 provider timeouts and events**: `DEFAULT_HTTP_TIMEOUT_MS = 300_000` (5 min) and `DEFAULT_CHUNK_TIMEOUT_MS = 900_000` (15 min) verified in `app-gmxz9m62.js` and `@opencode/ai/dist/schema/options.js`. Events `session.deleted`, `session.forked`, `session.revert.committed`, `session.compaction.ended`, `session.execution.interrupted` verified in `@opencode/schema@2.3.0/dist/session-event.js`.
- **Tool call ID format**: Verified in `@opencode/ai@2.3.0/dist/protocols/openai-chat.js:499-500` (`claude` models rewrite characters outside `[a-zA-Z0-9_-]`), so `call_` + 20 hex chars passes unchanged.
- **Locked decisions alignment**: All user decisions in `docs/decisions.md` (Q2-Q5 and planner follow-ups, including defaults 10 min idle, 20 s note, 180 s silence stall, 300 s retry stall) are reflected in the design.
