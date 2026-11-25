# Implementation review: opencode-antigravity

Deep-dive review of `plugins/opencode-antigravity`, covering fingerprint classification, replay correctness and budget, parked tool call lifecycle, stall watchdog and error mapping, PreToolUse hook and permission filter, download and extract security, secret exposure, and test suite integrity. Findings already covered by the prior review are omitted.

## Findings

### N-1 (blocker) `src/fingerprint.ts:353-368`

**Defect.** `classifyBound` allows a request with new user input (`tail.length > 0`) to fall through to `append` when `lastTurn.outcome === "failed_no_output"`, silently dropping the failed turn's user message from the prompt sent to `agy`.

**Failure scenario.** Turn 1 (`fresh`) completes with `"Hi."`. Turn 2 (`append`) sends `user("Delete temp.txt")`. `setupMain` (`src/proxy.ts:849-850`) advances `record.prefixCount` to 3 and `record.prefixHash` to cover `user("Delete temp.txt")`. Turn 2 then stalls before output and cancels cleanly, leaving `state: "live"` and `lastTurn: { outcome: "failed_no_output", plan: "append", emittedToolCalls: [], emittedTextHash: null, inputFrom: 1, inputTo: 3 }`. On Turn 3, the user sends a follow-up message (`[system, user("hello"), assistant("Hi."), user("Delete temp.txt"), user("Also rename foo.ts")]`) without retrying Turn 2 first. Step 6 passes because `failedClean` is allowed for `plan === "append"`. Step 8 passes because `prefixCount` already covers `user("Delete temp.txt")`. Step 9 passes because `expected` has empty text and no tool calls, matching `split.assistants === []`. Step 11 (`if (tail.length === 0 && failedClean)`) is skipped because `tail.length === 1`. Step 12 returns `{ kind: "append", input: [user("Also rename foo.ts")] }`. `agy` never receives `user("Delete temp.txt")`, while OpenCode displays both user messages in the conversation.

**Evidence.** Code path: `src/proxy.ts:849-850` moves `record.prefixCount` and `record.prefixHash` before `session/prompt`; `src/fingerprint.ts:331-368` only handles `failedClean` when `tail.length === 0`, then falls through to Step 12. Verified by calling `classifyRequest` with the Turn 2 binding (`outcome: "failed_no_output"`, `prefixCount: 3`) and Turn 3 messages ending with `user("Also rename foo.ts")`:

```text
N-1 plan: {"kind":"append","input":[{"role":"user","content":"Also rename foo.ts"}],"reminders":[]}
```

**Suggested fix.** In `classifyBound`, treat `failedClean` as exclusive to `redo`: after Step 11, if `failedClean` is true and `tail.length > 0`, return `{ kind: "fresh", reason: "tainted" }` (or include the failed turn's `[inputFrom, inputTo)` input only if `agy` is known to have dropped it; starting `fresh` is safer because `agy` history after a cancelled prompt is not guaranteed empty).

---

### N-2 (major) `src/proxy.ts:1016-1024`

**Defect.** When a resume request carries both tool results and new user steering input (`plan.steer.length > 0`), and the parked turn also has late unemitted tool calls to flush (`flush.length > 0`), `resumeParked` advances `turn.prefix` past the steering messages and returns early without steering. The user's steering message is permanently lost.

**Failure scenario.** Turn 1 parks on tool call `c1`. While OpenCode executes `c1`, `agy` emits a late tool call `c2` after the 250 ms settle window, and the user types `"USER_STEER_MESSAGE_NEVER_SENT"`. Request 2 arrives with `[system, user("go"), assistant([c1]), tool(c1, "one"), user("USER_STEER_MESSAGE_NEVER_SENT")]`. `classifyParked` returns `{ kind: "resume", results: [c1], media: [], steer: [user("USER_STEER_MESSAGE_NEVER_SENT")] }` with `prefix` covering all messages including the steering message. `resumeParked` calls `turn.resume(...)` (line 1016), sets `turn.prefix = prefix` (line 1017), and hits `if (flush.length > 0) return toolCallsResponse(...)` (line 1022), skipping lines 1024-1038. Request 3 then answers `c2` with `[..., user("USER_STEER_MESSAGE_NEVER_SENT"), assistant([c2]), tool(c2, "two")]`. `classifyParked` checks `chainHash(fps, turn.prefix.count) === turn.prefix.hash`, which matches because `turn.prefix` already absorbed the steering message. `tail.rest` is empty, `plan.steer` is `[]`, and Turn 1 finishes without `agy` ever seeing the user's message.

**Evidence.** Verified against `AntigravityProxy` with `realModules: true` and `mock-agy` scenario `"late-call"`:

```text
r2 finishReason: tool_calls toolCalls: [ "call_ee4187f0580858c22f01" ]
r3 finishReason: stop text: TOOL_RESULT:one|TOOL_RESULT:two
Total session/prompt sent to agy: 1 any contains USER_STEER_MESSAGE_NEVER_SENT: false
```

**Suggested fix.** Either run steering before returning `toolCallsResponse` (or queue `plan.steer` on `Turn` and dispatch it on the subsequent resume when `flush` is empty), or leave `turn.prefix` at the end of `tail.results` (excluding `tail.rest`) when flushing unemitted calls, or cancel and fall back to `fresh` replay whenever `flush.length > 0 && plan.steer.length > 0`. Also update `turn.prefix` and `entry.record.prefixCount/prefixHash` before `turn.resume()` invokes `onParked`, so the persisted parked snapshot does not hold the stale prefix with the new `emittedToolCalls`.

---

### N-3 (major) `src/proxy.ts:635-688`, `src/proxy.ts:1009-1040`

**Defect.** `handleMain` releases the per-session `KeyedMutex` before calling `resumeParked`, so `turn.resume()` and `turn.steer()` run outside the mutex. When a parked turn is steering and another request for the same session supersedes it, `turn.steer()` resolves `false` and `resumeParked` unconditionally calls `this.handleMain(chat, entry.key)` (line 1036), cancelling the newer turn and overwriting the session binding with stale history.

**Failure scenario.** Turn 1 is parked on a tool call. Request A arrives with the tool result plus a steering message. `handleMain` classifies `resume`, exits `this.mutex.run(key)` at line 679, and enters `resumeParked`. `turn.resume()` moves `turn.phase` to `"awaiting_model"`, then `await turn.steer(...)` waits on a `busy-steer` retry (1 s per retry, up to 10 retries). Meanwhile Request B arrives for the same session with a new prompt (for example, the user aborted Request A and sent a replacement message). Request B enters `mutex.run(key)`, sees `live.phase === "streaming"`, cancels Turn 1, and starts Turn 2 on a fresh ACP session. Cancelling Turn 1 settles `steerAttempt` with `"failed"`, so Request A's `await turn.steer(...)` returns `false`. Line 1034 calls `await turn.cancel("steer-failed")` (a no-op on the already-done Turn 1) and line 1036 calls `this.handleMain(chat, entry.key)`, which cancels Turn 2 and replays Request A's stale messages on a third ACP session. Separately, releasing the mutex before `turn.resume()` runs also leaves a window where a second request entering the mutex sees `live.phase === "parked"` before Request A transitions it.

**Evidence.** Verified against `AntigravityProxy` with `realModules: true` and `mock-agy` scenario `"echo,tools,hold,busy-steer"`:

```text
debug logs: [
  "[opencode-antigravity] plan fresh (no-binding)",
  "[opencode-antigravity] plan resume",
  "[opencode-antigravity] superseding a streaming turn",
  "[opencode-antigravity] plan fresh (tainted)",
  "[opencode-antigravity] steering failed; replaying into a fresh session",
  "[opencode-antigravity] plan fresh (prefix-mismatch)"
]
session/new count: 3
```

**Suggested fix.** Perform the synchronous `turn.resume()` state transition and prefix update inside `this.mutex.run(key)` before releasing the mutex. In `resumeParked`, before falling back to `this.handleMain(chat, entry.key)` on `!accepted`, check `if (chat.signal.aborted || entry.turn !== turn)` and return a 499/aborted response when the request was already superseded or aborted. Also skip `turn.resume()` when `plan.steer.length > 0` and steering is disabled (`!this.config.steering` or `!gen?.capabilities.steers`), cancelling directly to avoid sending tool results to a turn that will immediately be cancelled.

---

### N-4 (major) `src/turn.ts:247-250`, `src/turn.ts:287-288`, `src/turn.ts:394`

**Defect.** `Turn.onUpdate` appends to `this.responseTextValue` even when `this.sink` is `null` (buffering text while parked), and `Turn.resume` clears `this.responseTextValue = ""` without `Turn.attach` re-recording buffered text when flushing `this.buffer` to the next sink. Both halves break `emittedTextHash` echo verification.

**Failure scenario.**
1. Turn 1 streams `"First chunk."` and parks on tool call `c1` (`flushParked` sets `this.sink = null`). Before OpenCode posts the tool result, `agy` emits another `agent_message_chunk` (`"Late chunk while parked."`). Line 287 appends it to `this.responseTextValue`, making `turn.responseText === "First chunk.Late chunk while parked."` even though Request 1 only streamed `"First chunk."`. When Request 2 echoes `"First chunk."`, `classifyParked` computes `emittedTextHash("First chunk.") !== emittedTextHash("First chunk.Late chunk while parked.")`, rejects the resume with `tail-mismatch`, and cancels the live turn.
2. If Request 1 emitted no text (so Request 2 echoes empty text and passes `textMayBeEmpty: true`), `resume()` resets `this.responseTextValue = ""` (line 394) while `"Late chunk while parked."` remains in `this.buffer`. `attach(sink2)` (lines 247-250) writes `"Late chunk while parked."` to `sink2` without updating `this.responseTextValue`. When Turn 1 finishes, `binding.lastTurn.emittedTextHash` is missing that prefix (or is `null`), so Turn 2 fails `echoMatches` with `tail-mismatch`.

**Evidence.** Verified directly on `Turn` with `FakeClock`:

```text
After park -> responseText: "First chunk." phase: parked
After late chunk while parked -> responseText (polluted!): "First chunk.Late chunk while parked."
After resume -> responseText: ""
After attach sink2 -> sink2 received: ["Late chunk while parked."] but turn.responseText is: ""
```

**Suggested fix.** Update `this.responseTextValue` only when text is actually written to an attached sink: inside `onUpdate` when `this.sink` is non-null, and inside `attach` when draining `event.kind === "text"` from `this.buffer`.

---

### N-5 (major) `src/proxy.ts:676`

**Defect.** `handleMain` sets `turn.input = { from: entry.record?.prefixCount ?? 0, to: result.prefix.count }` for every non-resume plan, including `redo`. On a `redo`, `entry.record.prefixCount` already equals `result.prefix.count`, so `turn.input` becomes an empty range `[N, N)`.

**Failure scenario.** Turn 1 (`fresh`) succeeds (`prefixCount = 1`). Turn 2 (`append`) sends `user("STALL now")`, moving `prefixCount` to 3 and recording `lastTurn: { outcome: "failed_no_output", plan: "append", inputFrom: 1, inputTo: 3 }`. OpenCode retries once: `classifyRequest` returns `redo` (`input: [user("STALL now")]`). `handleMain` sets `turn.input = { from: 3, to: 3 }`. If this retry also fails cleanly with no output (for example, a second consecutive stall or transient 503), `onTurnEnded` writes `lastTurn: { outcome: "failed_no_output", plan: "redo", inputFrom: 3, inputTo: 3 }`. On OpenCode's second retry, `classifyBound` Step 11 (`src/fingerprint.ts:356`) checks `if (from < 0 || from >= to || to !== binding.prefixCount)` (`3 >= 3`), fails with `tail-mismatch`, and forces a cold `fresh` session replay even though `src/fingerprint.ts:332` explicitly permits repeated `redo` turns.

**Evidence.** Verified against `AntigravityProxy` with `realModules: true` and `mock-agy` scenario `"stall-on=STALL"`:

```text
After append stall -> lastTurn: {"outcome":"failed_no_output","plan":"append","emittedToolCalls":[],"emittedTextHash":null,"inputFrom":1,"inputTo":3} prefixCount: 3
After redo stall -> lastTurn: {"outcome":"failed_no_output","plan":"redo","emittedToolCalls":[],"emittedTextHash":null,"inputFrom":3,"inputTo":3} prefixCount: 3
session/new count: 2 prompt sessionIds: [ "d00b9616-...", "d00b9616-...", "d00b9616-...", "39b4a572-..." ]
proxy debug logs (plan lines): [
  "[opencode-antigravity] plan fresh (no-binding)",
  "[opencode-antigravity] plan append",
  "[opencode-antigravity] plan redo",
  "[opencode-antigravity] plan fresh (tail-mismatch)"
]
```

**Suggested fix.** In `src/proxy.ts:676`, when `plan.kind === "redo"` and `entry.record?.lastTurn` exists, preserve `{ from: entry.record.lastTurn.inputFrom, to: entry.record.lastTurn.inputTo }` on `turn.input`.

---

### N-6 (major) `src/replay.ts:292-323`

**Defect.** `buildReplayPrompt` computes `const recentStart = Math.max(0, items.length - RECENT_COUNT)` and `const old = items.slice(0, recentStart)` without clamping `recentStart` to `layout.latestStart`. When the latest input contains more than 6 items (for example, 8 parallel tool results after a crash or parked-turn expiry), the earlier items of the current turn's latest input fall into `old`.

**Failure scenario.** A conversation has 10 earlier user/assistant turns (`items[0..19]`), an assistant message calling 8 tools in parallel (`items[20]`), and 8 tool results (`items[21..28]`, so `latestStart = 21`, `items.length = 29`, `recentStart = 23`). `agy` crashes while parked, so the resume replays into a fresh session with a budget that triggers compaction. Because `items[21]` (`c0`) and `items[22]` (`c1`) lie before `recentStart`, Steps 1 to 3 truncate and then replace these brand-new tool results with `[tool result omitted, N characters]` before Step 6 drops any old turns from 10 turns earlier. Step 6 then sets `dropped = true` on `items[21..22]`, which `toolResultsText` (`src/replay.ts:185-191`) and `historySize` (`src/replay.ts:228`) ignore.

**Evidence.** Verified by calling `buildReplayPrompt` with 10 old user/assistant pairs and 8 parallel tool results (3,017 chars each) at `budgetChars = 25_000`:

```text
N-6 tool_results block contains omitted stub for CURRENT tool result c0: true
N-6 history still kept old user 0: true
N-6 c0 line: <turn n="22" role="tool" name="read" call_id="c0">[tool result omitted, 3017 characters]</turn>
```

**Suggested fix.** Clamp the boundary to `const recentStart = Math.min(layout.latestStart, Math.max(0, items.length - RECENT_COUNT))` so `old` only contains history items before `layout.latestStart`.

---

### N-7 (major) `src/turn-outcome.ts:121-131`

**Defect.** `classifyErrorPayload` only forwards `status` when `status >= 500` (after checking `QUOTA_EXHAUSTED`, thinking signature, and 429/`RESOURCE_EXHAUSTED`). Every other 4xx API error step (`400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 PERMISSION_DENIED`, `404 NOT_FOUND`) falls through to line 130 and becomes `{ kind: "provider_error", status: 502, message: null }`.

**Failure scenario.** Google rejects a turn with a permanent 4xx error step (such as `Error 400, Message: Invalid argument: unsupported mime type, Status: INVALID_ARGUMENT`, `Error 401, ..., Status: UNAUTHENTICATED`, `Error 403, ..., Status: PERMISSION_DENIED`, or `Error 404, ..., Status: NOT_FOUND`). `classifyErrorPayload` turns it into `provider_error` with `status: 502`. `errors.ts:121` marks `502` as retryable (`x-should-retry: true`, mid-stream `code: 502`), so OpenCode retries the permanent failure up to 10 times with backoff. For `401 UNAUTHENTICATED`, the plugin also fails to call `bridge.reportSignInRequired` and never surfaces `auth_required` (401) to OpenCode. Note that `src/errors.ts:121` already computes `retry: status >= 500 || status === 408 || status === 409` to make 4xx `provider_error`s non-retryable, and `docs/design-sessions-runtime.md:657` specifies `provider_error` carries the status from `agy`.

**Evidence.** Verified by calling `classifyErrorPayload`, `toHttpError`, `toStreamError`, and `isRetryable` on 400/401/403/404 error step payloads:

```text
Error 400, Message:  -> failure: { kind: "provider_error", status: 502, message: null } retryable: true http: 502 true sse.code: 502
Error 401, Message:  -> failure: { kind: "provider_error", status: 502, message: null } retryable: true http: 502 true sse.code: 502
Error 403, Message:  -> failure: { kind: "provider_error", status: 502, message: null } retryable: true http: 502 true sse.code: 502
Error 404, Message:  -> failure: { kind: "provider_error", status: 502, message: null } retryable: true http: 502 true sse.code: 502
```

**Suggested fix.** In `classifyErrorPayload`:
1. Map `status === 401 || grpc === "UNAUTHENTICATED"` to `{ kind: "auth_required", message: SIGNED_OUT_MESSAGE }` and invoke `bridge.reportSignInRequired(SIGNED_OUT_MESSAGE)` in `proxy.ts`'s `checkOutcome` hook when it occurs.
2. For other 4xx statuses (`status !== null && status >= 400 && status < 500`), preserve `status` in `{ kind: "provider_error", status, message: \`Antigravity reported HTTP ${status} from Google.\` }` so `errors.ts` emits a non-retryable 4xx code (400/403/404).

---

### N-8 (major) `src/profile.ts:308-322`, `src/acp-client.ts:232-251`

**Defect.** Layer 3 (`matchMcpPermission`) allows permission requests with an omitted `toolCall.name` whenever `args` or `rawInput` contain matching `ServerName` and `ToolName` values, without checking `toolCall.kind` or rejecting unexpected keys in `args`/`rawInput`. `parsePermissionParams` (`src/acp-client.ts:232-251`) drops `toolCall.kind` entirely.

**Failure scenario.** Standard ACP `ToolCallUpdate` objects mark `name` optional and identify tool calls by `title`, `kind`, and `rawInput`. When the PreToolUse hook is off (`skipped-foreign-profile` for a user-supplied `geminiDir`, `skipped-probe-failed`, or `toolGuardHook: false`), Layer 3 is the sole runtime permission filter. If `agy` sends a `session/request_permission` for a built-in tool (such as `run_command` or `write_to_file`) with `toolCall.name` omitted and raw model arguments that include injected `ServerName: "opencode"` and `ToolName: "read"` alongside `CommandLine: "rm -rf /"`, `matchMcpPermission` skips line 316 (`call.name !== undefined`), reads `server === "opencode"` and `tool === "read"`, checks `turn.allowedToolNames.has("read")`, and returns `true` (`allow_once`).

**Evidence.** Code path: `src/acp-client.ts:237-251` discards `tc.kind`; `src/profile.ts:316-321` checks only `SERVER_KEYS` and `TOOL_KEYS`. Verified directly:

```text
N-9 matchMcpPermission for run_command with omitted name: true
```

**Suggested fix.** Parse `toolCall.kind` in `parsePermissionParams` and reject built-in kinds (`execute`, `edit`, `delete`, `move`, `search`, `fetch`, `read`). When `call.name` is absent, require every key in `args` and `rawInput` to be in the MCP call parameter allowlist (`ServerName`, `serverName`, `server_name`, `ToolName`, `toolName`, `tool_name`, `Arguments`, `arguments`) so any built-in tool payload carrying `CommandLine`, `TargetFile`, `CodeContent`, or similar keys is rejected.

---

### N-9 (major) `src/auth/errors.ts:82-99`, `src/errors.ts:170-184`

**Defect.** Two secret-redaction gaps leak credentials or PII into user-facing error responses:
1. `SENSITIVE_LINE` in `src/auth/errors.ts:82` matches `/https:\/\/|state=|code=|token|@/i`, which does not match `http://` URLs or `/mcp/`. Because `mcpServers` passes `http://127.0.0.1:<port>/mcp/<mcpToken>/<scopeId>` to `agy`, any `AcpError` quoting that URL passes through `redactAgyOutput` unchanged in `mapAcpError` (`src/errors.ts:182-183`), leaking the live 24-byte `mcpToken` into the HTTP/SSE error payload.
2. `mapAcpError` (`src/errors.ts:170-173`) returns `err.message` verbatim whenever `isSignInRequired(err)` is true and `message.startsWith("Antigravity")`, without calling `redactAgyOutput`. Any `AcpError(-32000, ...)` from `agy` whose message begins with `"Antigravity"` can leak an OAuth URL, `state`, or account email.

**Failure scenario.** `agy` encounters an MCP transport error (connection refused, reset, or timeout) and returns JSON-RPC error `-32603` with Go's standard `net/http` error string: `MCP server opencode failed: Post "http://127.0.0.1:54321/mcp/<mcpToken>/<scopeId>": dial tcp 127.0.0.1:54321: connection refused`. `mapAcpError` calls `redactAgyOutput`, which keeps the line verbatim, and sends the live `mcpToken` in the SSE/HTTP error response to OpenCode and its logs.

**Evidence.** Verified directly with `redactAgyOutput` and `mapAcpError`:

```text
N-10a redacted contains mcpToken: true mapped.message: Antigravity error: MCP server opencode failed: Post "http://127.0.0.1:54321/mcp/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/cafebabecafebabecafebabe": dial tcp 127.0.0.1:54321: connection refused
N-10b auth_required contains secret/email: true mappedAuth: {
  kind: "auth_required",
  message: "Antigravity auth failed for alice@example.com: https://accounts.google.com/o/oauth2/auth?state=SECRET_STATE"
}
```

**Suggested fix.** Extend `SENSITIVE_LINE` in `src/auth/errors.ts:82` to match `https?:\/\/|\/mcp\/|bearer\s|authorization|state=|code=|token|@` (case-insensitive). In `src/errors.ts:170-173`, only pass through the message from `SignInRequiredError` (or `SignInUrlLineError`), and always return `SIGNED_OUT_MESSAGE` for `AcpError` instances classified as sign-in required.

---

### N-10 (minor) `src/proxy.ts:942-970`

**Defect.** For streaming requests, `respond()` does not attach an abort listener to `chat.signal` while awaiting `Promise.race([setup, earlyTimer])`. Cancellation relies solely on `SseResponder`'s `ReadableStream` `cancel` callback, which only runs after `respond()` returns a `Response` to Bun.

**Failure scenario.** A streaming chat request starts while `agy` is spawning (`slow-start`), resuming a dormant session, or applying config options, and completes setup within `earlySseMs` (2 s). The client aborts at 100 ms. Because `respond()` ignores `chat.signal`, `withSetup` runs `initialize`, `authenticate`, `session/new`, `session/set_config_option`, and dispatches `session/prompt` to `agy` before `SseResponder` is returned and Bun fires `cancel()`. For an `append` turn, dispatching `session/prompt` and immediately cancelling it taints a healthy session binding unnecessarily.

**Evidence.** Verified against `AntigravityProxy` with `scenario: "slow-start=400"`, `earlySseMs: 2000`, aborting `fetchChat` at 100 ms:

```text
fetch result: AbortError: The operation was aborted.
methods after abort at 100ms: [ "initialize", "authenticate", "session/new", "session/set_config_option",
  "session/prompt", "session/cancel", "session/close"
]
```

**Suggested fix.** Register an abort listener on `chat.signal` (and check `chat.signal.aborted` immediately) at the start of `respond()` for streaming requests as well as non-streaming ones, calling `void turn.cancel("cancelled")` and removing the listener once `SseResponder` attaches.

---

### N-11 (minor) `src/replay.ts:250-262`, `src/replay.ts:328-347`

**Defect.** `cutMiddle(text, max)` ignores the length of its omission marker (`\n[... N characters omitted ...]\n`, ~35 chars), so cutting adds ~35 chars above `max` and can grow short strings when `max` is small. In Step 7, `share` is shrunk across at most 4 passes and calls `cutMiddle` repeatedly on already-cut text (nesting omission markers), while `size(layout)` ignores `<system-update>` wrappers and non-text fallback blocks in `latestBlocks`. Under small budgets or recent assistant messages with many tool calls, `buildReplayPrompt` exceeds `budgetChars`.

**Failure scenario.** An assistant message in the last 6 messages contains 30 tool calls (`read_file_tool` with 200-char arguments) and `budgetChars` is 1,500 (above the minimum legal `replayMaxChars` of 1,000 in `src/config.ts:88`). Step 7 runs 4 passes, shrinking `share` to 0, where each `cutMiddle(call.args, 0)` still emits a 35-char marker inside a 90-char `<tool_call>` element, yielding 3,825 chars against a 1,500-char budget.

**Evidence.** Verified directly with `buildReplayPrompt`:

```text
N-7a (30 calls) budget=1500, actual=3825, over=true
```

**Suggested fix.** Account for the omission marker length inside `cutMiddle` (never returning a string longer than `Math.max(max, 0)` or longer than the original string), cut from the original bodies and args on each pass so markers never nest, and allow Step 7 to drop or summarize excess tool calls or oldest recent history items when cutting text alone cannot meet `budgetChars`.

---

### N-12 (minor) `src/install/extract.ts:244-252`

**Defect.** `TarReader.finish()` returns early on line 246 when `this.pending.length > 0 && this.phase.kind === "trailer" && isZeroBlock(this.pending)`, skipping the `if (!this.entryDone)` and `if (this.written <= 0)` checks on lines 250-251. In addition, line 249 does not reject `this.phase.kind === "padding"`, accepting archives truncated mid-padding after entry data.

**Failure scenario.** A gzipped tar archive consisting of 513 zero bytes (one 512-byte zero block that transitions `phase` to `"trailer"`, plus 1 trailing zero byte left in `pending`) passes `extractSingleExecutable` without throwing `TarFormatError` and writes a 0-byte executable file with mode `0700`. Downstream `verifyAgy` and upstream SHA-512 verification still prevent activation of a tampered archive, so this is a defense-in-depth defect in the tar parser itself.

**Evidence.** Verified directly against `extractSingleExecutable`:

```text
N-11 extractSingleExecutable SUCCEEDED on 513 zero bytes: { bytes: 0 } file size on disk: 0
```

**Suggested fix.** In `src/install/extract.ts:245-249`, replace the early `return` with a guard that only throws on non-zero/non-trailer pending bytes, and also reject `this.phase.kind === "padding"`:

```ts
if (this.pending.length > 0 && !(this.phase.kind === "trailer" && isZeroBlock(this.pending))) {
  throw corrupt("truncated archive");
}
if (this.phase.kind === "data" || this.phase.kind === "meta" || this.phase.kind === "padding") {
  throw corrupt("truncated archive");
}
```

---

### N-13 (minor) `src/proxy.ts:849-856`, `src/proxy.ts:897-900`

**Defect.** For `append` and `redo` turns, `setupMain` mutates `record.prefixCount`, `record.prefixHash`, `record.model`, `record.thoughtLevel`, and `record.state = "live"` before returning to `withSetup`, while `turn.acpSessionId` is only assigned after `await setup(gen)` resolves on line 899.

**Failure scenario.** If `turn.cancel("cancelled")` runs across the microtask boundary between `setupMain` returning (line 856) and `withSetup` resuming (line 898), `promptInFlight` is still `false`, so `cancel` ends the turn synchronously and invokes `onTurnEnded(turn)`. Inside `onTurnEnded` (`src/proxy.ts:1173`), `turn.acpSessionId` is still `null`, so `turn.acpSessionId === record.acpSessionId` is `false`. `onTurnEnded` skips tainting and saving `record`, and `withSetup` returns on line 898 (`if (!ready || turn.done) return`). `entry.record` remains untainted with `state: "live"` and the cancelled request's `prefixCount`/`prefixHash` even though `session/prompt` was never sent.

**Evidence.** Code path: `src/proxy.ts:849-856` mutates `record` inside `async setupMain`; `src/proxy.ts:897-899` awaits `setup(gen)` before assigning `turn.acpSessionId = ready.acpSessionId`; `src/proxy.ts:1173` guards binding update and tainting on `turn.acpSessionId === record.acpSessionId`.

**Suggested fix.** Return the pending record update from `setup` and apply it in `withSetup` right before `turn.startPrompt(...)` (after `turn.acpSessionId` is set and the final `if (turn.done) return;` check at line 907 has passed, with no `await` before `startPrompt`).

---

### N-14 (minor) `test/e2e/stall.test.ts:30-51`, `test/e2e/idle.test.ts:109-118`, `test/e2e/crash.test.ts:32-50`, `test/e2e/tools-multi.test.ts:38-57`, `test/e2e/privacy.test.ts:11-37`, `test/plugin.test.ts:349-358`

**Defect.** Several tests pass without exercising the production modules or behaviors claimed in their titles:
1. `test/e2e/idle.test.ts:109-118` (*"a live session unused for sessionIdleCloseMs gets session/close and stays resumable"*) only checks `record.state === "dormant"` (which `MemoryStore.save` always writes even for live records) and never sends a follow-up request to verify `session/resume` succeeds.
2. `test/e2e/stall.test.ts:30-51` (*"a clean no-output stall of an append turn keeps the binding; the redo prompts the same ACP session"*) runs with `stubSessionModules()` and manually pushes `append` and `redo` into `h.modules.nextPlans`, bypassing `classifyRequest` entirely. This hid N-1 and N-5.
3. `test/e2e/crash.test.ts:32-50` (*"crash-parked: the tool result posted after the crash goes to a fresh session whose replay ends with the results"*) runs with `stubReplay` (`test/fixtures/proxy-harness.ts:147`), bypassing `buildReplayPrompt` and asserting `<tool_results>late result</tool_results>` (a format the real `replay.ts` never emits).
4. `test/e2e/tools-multi.test.ts:38-57` (*"a built-in tool permission is rejected"*) runs with `stubPermission` (`test/fixtures/proxy-harness.ts:99-108`), bypassing `matchMcpPermission` in `src/profile.ts`.
5. `test/e2e/privacy.test.ts:11-37` patches `console.error` to capture logs while `startHarness` overrides `log: (line) => this.logs.push(line)` so `console.error` is never called, and only exercises a happy-path stubbed `tools` turn (never hitting `mapAcpError`/`redactAgyOutput`, which hid N-9).
6. `test/plugin.test.ts:349-358` polls `store.load("ses_loop", "0") === null` after emitting `session.deleted` without first verifying the record existed in the store, so it passes even if `store.save` has not landed yet or the epoch does not match `"0"`.

**Failure scenario.** Regressions in real `classifyRequest`, `buildReplayPrompt`, `matchMcpPermission`, `redactAgyOutput`, and post-idle-close resumption pass CI undetected.

**Evidence.** Inspected all six test files and `test/fixtures/proxy-harness.ts:56-219`. Out of 10 files under `test/e2e/`, only `session-reuse.test.ts` and `profile.test.ts` pass `realModules: true`.

**Suggested fix.** Enable `realModules: true` in `stall.test.ts`, `crash.test.ts`, `tools-multi.test.ts`, `idle.test.ts`, and `privacy.test.ts`; send a resuming chat turn in `idle.test.ts:109-118`; add an error-path leak assertion (`AcpError` carrying the MCP URL) to `privacy.test.ts`; and assert `await store.load("ses_loop", "0") !== null` before emitting `session.deleted` in `plugin.test.ts:349`.

---

## Areas checked and found correct

- **Core canonicalization and prefix hashing (`src/fingerprint.ts:69-185`)**: String vs text-part arrays, `cache_control` stripping, trailing whitespace trimming, tool-call argument canonicalization (sorted keys with raw fallback on invalid JSON), `file`/`video_url`/unknown part fingerprinting, empty assistant dropping, and `chainHash` folding all hold up against edits, reverts, forks, compaction, and echo tampering on normal `ok` turns.
- **System prompt budgeting and tool schema compaction (`src/prompt.ts:160-443`)**: UTF-8 code point boundary slicing (`headBytes`/`tailBytes`), marker-inclusive byte budgeting in `cutHeadTail`, multi-message share redistribution, recursive keyword-allowlisted `compactSchema`, L0-L6 tool truncation ladder, and `toolsSchemaHash` order independence are sound.
- **Stall watchdog timers and log tail parsing (`src/stall-watchdog.ts`, `src/agy-log-tail.ts`)**: Silence timer progression, retry-evidence extension to `retryStallTimeoutMs` without resetting silence, 15 s note rate limit with deferred retry note, host-sleep slack reset, `pause`/`resume` around parked turns, Go duration parsing (including both micro signs), and truncation-safe incremental log tailing are solid.
- **Download transport, manifest validation, and release activation (`src/install/download.ts`, `src/install/manifest.ts`, `src/install/release.ts`, `src/install/verify.ts`)**: `safeFetch` enforces HTTPS, default port, no userinfo, exact origin allowlist on every manual redirect hop (max 5), rejects non-`identity` `Content-Encoding`, enforces size caps before and during streaming, verifies SHA-512 before returning, and `release.ts` checks symlinks on `platformDir`/`versionsDir`/release dir/record/executable with `realpath` containment and atomic `active.json` commit/rollback.
- **PreToolUse guard script and probe (`src/profile.ts:53-285`)**: The guard script parses stdin as JSON, inspects only `toolCall.name` and `toolCall.args`, never emits `"allow"`, uses `"force_ask"` for `"opencode"` MCP calls and `"deny"` for everything else, and `prepareProfileDir` only writes `hooks.json` in plugin-owned profiles after `probeGuardRuntime` passes while preserving foreign hooks.
- **MCP bridge scope isolation (`src/mcp-bridge.ts`)**: Per-session `McpScope` registries, `conversation_id` cross-check against `scope.acpSessionId`, tool allowlist enforcement, constant-time token validation in `proxy.ts`, and `req.signal` abort propagation to `Turn.onMcpCall` work as designed.
- **SQLite error-step path guards (`src/turn-outcome.ts:39-75`)**: Strict `SESSION_ID` regex, symlink checks on `antigravity-acp`, `conversations`, and `<id>.db`, `dev`/`ino` identity pinning between turn start and turn end, read-only open with `busy_timeout = 100`, and `substr(..., 1, 16384)` bounding are properly implemented.
