# Fixes from the live test against the real agy

Live runs used agy 1.5.15 (T3 Code's copy, read only) with a signed-in throwaway profile, through `test/real-agy.smoke.test.ts` with `AGY_SMOKE=1 AGY_SMOKE_GEMINI_DIR=<profile>`. No token, prompt text or MCP token is quoted here.

## Why OpenCode tool calls did not work

Two causes, one after the other.

**1. The custom agent had no `call_mcp_tool`.** The agent file declared `tools: []` and no `mcpServers`, because the design attached MCP only per session through `session/new`. agy did connect the per-session server (log: `Preloading 1 MCP servers of the session`, and it cached the `read` tool under `antigravity-acp/mcp/opencode/`), but the agent's tool list held only `list_resources`, `read_resource` and `manage_task`. The model said so itself: "the `call_mcp_tool` function required to invoke the `opencode` `read` tool is not present in my available tool declarations". The agent variants tried live:

| Agent frontmatter | Result |
| --- | --- |
| `tools: []`, no `mcpServers` (before) | No `call_mcp_tool`; no permission request, no MCP call |
| plus `inheritMcp: true` | Same |
| `tools: [call_mcp_tool]` or `tools: [mcp_tool]` | `failed to construct executor: ... tool "call_mcp_tool" not found in registry` |
| `mcpServers: [opencode]` (name only) | MCP tools appear natively as `mcp_opencode_read`; the guard denies them (it expects `call_mcp_tool`) |
| `mcpServers:` with `name: opencode` and a `url` | `call_mcp_tool` appears; the hook and the permission request follow (below) |

With the URL entry, the call still went to the per-session URL from `session/new`: the tool call parked on its session scope, and the pool endpoint got no request in any run.

**2. Layer 3 rejected the real permission request.** Once `call_mcp_tool` existed, the request arrived as:

```
permission rejected name=call_mcp_tool kind=execute keys=Arguments,ServerName,ToolName,raw.Arguments,raw.ServerName,raw.ToolName
```

The N-8 fix had made every built-in kind a rejection, and agy gives our own MCP call the kind `execute`.

## What agy sends for the MCP call

- **Permission request:** `toolCall.name` is `call_mcp_tool`, `toolCall.kind` is `execute`. `args` and `rawInput` both hold exactly `Arguments`, `ServerName` and `ToolName`.
- **PreToolUse hook:** the tool name is `call_mcp_tool`, with `args` keys `Arguments`, `ServerName` and `ToolName`. It is not `mcp_tool`, as the hook docs suggested. The guard keeps both names.

## Fixes and their tests

| # | Fix | Test |
| --- | --- | --- |
| 1 | The agent file declares one server, `opencode`, at `http://127.0.0.1:<port>/mcp/<token>/pool` (`src/profile.ts`). `proxy.start` writes it after the listener is up, so the port is known, and every pool start rewrites it with that pool's token. The file is 0600 and the token is never logged. The new pool endpoint (`src/mcp-bridge.ts`, `POOL_SCOPE_ID`) only runs a `tools/call` whose conversation id belongs to an open session scope, and only with that scope's tools. Per-session scoping and the conversation-id check stay, and so does the guard | `test/unit/tool-guard.test.ts` "a plugin-owned profile gets the agent file..."; `test/e2e/profile.test.ts` "the agent file names this pool's MCP endpoint, mode 0600..." and "a restart rewrites the agent file"; `test/unit/mcp-bridge.test.ts` "the pool endpoint routes tools/call by conversation id" |
| 1 | Layer 3 accepts `kind: "execute"` only together with `name: "call_mcp_tool"`. It rejects every other built-in kind, `execute` without that name, and any key an MCP call never carries, named or not. The mock agy now sends the real payload shape | `test/unit/tool-guard.test.ts` "the payload agy 1.5.15 sends for our MCP call is accepted"; `test/e2e/live-fixes.test.ts` "the mock sends agy's real permission payload" |
| 1 | The proxy's permission debug line names the tool, the ACP kind and the key names, never values | same e2e test |
| 4 | With no model in the request, the proxy takes the first entry of a catalog agy reported. With no such catalog it sets no model, so agy keeps its own current one (`AGY_DEFAULT_MODEL`). It never falls back to the built-in list | `test/e2e/live-fixes.test.ts` "a request without a model and no discovered catalog keeps agy's current model" |
| 4 | agy's `Unknown model ID: <id>` becomes a 400 with `x-should-retry: false`: "This Antigravity account has no model "<id>". Pick another Antigravity model." | `test/unit/errors.test.ts` "agy's Unknown model ID is a 400..."; `test/e2e/live-fixes.test.ts` "a model the account lacks answers 400"; mock scenario `strict-models` |
| 5 | Failures after agy's own retries carry `agyRetried`: an error step (429 or 503/`UNAVAILABLE`) and a stall after retry lines. They answer 429 with `x-should-retry: false`, and mid-stream code 429 with a text OpenCode 2.3.0 reads as a quota error ("limit exhausted"), so neither path is retried. The text: "..., and Antigravity already retried on its own. Request limit exhausted for now: try again later or pick another model." A stall without retry evidence stays a retryable 504; an error step 500 stays a retryable `provider_error` | `test/e2e/live-fixes.test.ts` "agy already retried", 3 tests; `test/unit/errors.test.ts` new table rows; `test/unit/turn-outcome.test.ts`, `test/unit/stall-watchdog.test.ts` and `test/e2e/stall.test.ts` updated |
| 6 | `docs/manual-test.md`: step 5.2 opens Antigravity from the Providers page under "Not signed in"; step 6 picks a model from the account's catalog (with a command that lists it); step 10.1 removes the account through "Actions for Google (...)" | (doc) |
| 7 | The signed-in smoke test spawns agy once, reads the account's catalog and sends its first model, or `AGY_SMOKE_MODEL` when the catalog lists it. It also records the hook's tool name and the permission payload keys | `test/real-agy.smoke.test.ts` |

One earlier test was wrong: `test/e2e/profile.test.ts` read the MCP token from the mock's `scopePath`, which holds the scope id. It now reads the token from the `session/new` MCP URL.

## Resume after a restart

agy accepted `session/resume` with the stored id (log: `Loading/Resuming session: <id>` and `Preloading 1 MCP servers of the session`), and the proxy logged no `session/resume failed`. After the restart, the model answered "Call `call_mcp_tool` with `ServerName` `"opencode"`." The proxy sends the same `_meta` append on `session/resume`, so this run cannot tell whether agy kept the original append or used the one sent again. Either way the resumed session knows the protocol, so `resumeAfterRestart` stays `true`.

## Smoke result

`AGY_SMOKE=1 AGY_SMOKE_GEMINI_DIR=<profile> bun test test/real-agy.smoke.test.ts`: 5 pass, 0 fail. The signed-in run:

```
[smoke] guard: installed
[smoke] live catalog: gemini-4-hydrogen, gemini-3.8-flash, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium
[smoke] model: gemini-4-hydrogen
[smoke] turn 1: status 200, finish tool_calls, calls read
[smoke] hook saw: {"name":"call_mcp_tool","argKeys":["Arguments","ServerName","ToolName"]}
[smoke] turn 2: finish stop, mentions pelican: true
[smoke] after resume: Call `call_mcp_tool` with `ServerName` `"opencode"`.
[smoke] [opencode-antigravity] plan fresh (no-binding)
[smoke] [opencode-antigravity] permission allowed name=call_mcp_tool kind=execute keys=Arguments,ServerName,ToolName,raw.Arguments,raw.ServerName,raw.ToolName
[smoke] [opencode-antigravity] mcp call parked (1 open)
[smoke] [opencode-antigravity] plan resume
[smoke] [opencode-antigravity] plan append
```

## Not verified live

- That the guard denies a built-in tool (`run_command`) for a real model. The hook runs and sees `call_mcp_tool`; a deny run needs a prompt that makes the model try a shell command.
- Steps 4, 5, 8 and 9 of SR 11.3: steering while a call is parked, the retry-line format in a capacity error, a 20 minute parked call, and image results.
- The error path of fix 5 against Google. The earlier run hit two 503 retries on `gemini-3.8-flash` that agy then got past; the mapping is tested with the mock only.

The throwaway profile got the plugin marker file (`.opencode-antigravity-profile`) so the guard installs in it, plus the rewritten agent file and `hooks.json`.

## Review of the live-test fixes (`docs/review-live-fixes.opus.md`)

Each fix has a test that fails when the fix is reverted.

| Id | Result | Reason | Proving test |
| --- | --- | --- | --- |
| L-1 | Fixed | Each pool writes its own agent `opencode-bridge-<poolId8>` and starts agy with `--agent` set to that name. Before each spawn, a sweep deletes per-pool files whose pool has no live owner entry, and deletes the shared `opencode-bridge.md` of the earlier build when no other process uses the profile. agy takes any agent name; its own docs only warn against names of built-in agents. The per-pool name was not run live (see below) | `test/e2e/profile.test.ts` "two pools on one profile keep their own agent files; each agy runs its own pool's" and "a spawn sweeps agent files of pools that are gone"; the mock journals the `--agent` it was started with (`process/start`) |
| L-2 | Fixed | `stop()` and the exit cleanup delete the pool's agent file, so no port or token outlives the pool, also in a user's own gemini dir | `test/e2e/profile.test.ts` "pool stop deletes its agent file; a restart writes a new one" |
| L-3 | Fixed | The proxy keeps `agyRetried` on an error step only when the turn saw an attributed retry line; a first-attempt 429 or 503 error step stays retryable | `test/e2e/live-fixes.test.ts` "an error step without a retry line for the turn stays retryable"; the "agy's retries" case now runs `error-step,retry-log=300`; `test/e2e/stall.test.ts` "error-step" |
| L-4 | Fixed | A retry line is attributed only when its model matches the turn or exactly one turn waits. A guessed attribution still lengthens the limit and sends the note, but the stall stays retryable | `test/e2e/live-fixes.test.ts` "two waiting turns and a retry line that names neither model"; `test/unit/stall-watchdog.test.ts` "a retry line attributed by guess" |
| L-5 | Fixed | Layer 3 accepts `kind: "execute"` only under the name `call_mcp_tool`. `mcp_tool` stays accepted without a built-in kind | `test/unit/tool-guard.test.ts` "the payload agy 1.5.15 sends for our MCP call is accepted" |
| L-6 | Fixed | The pool endpoint's `tools/list` returns only the tools of the conversation's own scope, and `[]` without a known conversation. In the live runs agy never called the pool endpoint, including `tools/list` | `test/unit/mcp-bridge.test.ts` "the pool endpoint routes tools/call by conversation id" |
| L-7 | Fixed | An auth change marks the catalog as not current, so `defaultModel()` stops using the old account's first model and the next spawn rediscovers | `test/e2e/live-fixes.test.ts` "the old account's catalog is not used as the default after an account change" |

The `checkOutcome` hook now also calls `reportSignInRequired` for a 401 error step: the cross-owner change from N-7, which was still open.

### Needs a live check

- The per-pool agent name with the real agy. A start with `--agent opencode-bridge-<8 hex>` should log no `Agent "..." not found`, and a tools turn should still offer `call_mcp_tool`. The live runs used `opencode-bridge`.
- L-6: whether agy lists an agent-declared server through the pool endpoint before it offers `call_mcp_tool`. It did not in any live run, and the proxy now answers `[]` without a known conversation.

## agy 1.5.15's error step format (browser test run 2)

| Id | Result | Reason | Proving test |
| --- | --- | --- | --- |
| Run 2, bug 1 | Fixed | agy 1.5.15 writes its error step as `API error (attempt N): transport error (ResourceExhausted, HTTP 429): ...: RESOURCE_EXHAUSTED (code 429): ...`, which `API_ERROR` did not match, so the step became a retryable 502. `parseAgyApiError` (`src/turn-outcome.ts`) reads the HTTP status, the gRPC status (title case or upper snake) and the attempt number in this format and the older `Error 429, Message: ..., Status: ...`. 429/`RESOURCE_EXHAUSTED` maps to `rate_limited` and 503/`UNAVAILABLE` to `capacity`. An attempt above 1 in the step counts as evidence that agy retried, just like an attributed retry line, so the answer is the non-retried exhaustion message even when log attribution failed (L-3). `mapAcpError` uses the same parser for an RPC error carrying this text: it is a retryable rate limit or capacity failure, final only with an attempt above 1. agy's retry log lines in this format already parsed; a test now pins the exact 429 line | `test/unit/turn-outcome.test.ts` "agy 1.5.15's error step format"; `test/unit/errors.test.ts` "an RPC failing with agy's transport error text"; `test/e2e/live-fixes.test.ts` "agy 1.5.15's error step with attempt 8 is final" and "with attempt 1 stays retryable" (mock scenario `error-step=<n>`); `test/unit/agy-log-tail.test.ts` "agy 1.5.15's 429 retry line from browser run 2" |
