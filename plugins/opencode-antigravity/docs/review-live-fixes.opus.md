# Review of the live-test fixes

Scope: the five changes listed in `docs/live-test-fixes.md`, read in `src/profile.ts`, `src/mcp-bridge.ts`, `src/proxy.ts`, `src/errors.ts`, `src/turn-outcome.ts` and `src/stall-watchdog.ts`. The real agy was not run. Evidence comes from the code, from the plugin's own tests, and from two scratch scripts kept outside the repo (under the session scratchpad), run with `bun run` against the repo's `src` and test harness.

The plugin's tests for these fixes pass: `bun test test/unit/mcp-bridge.test.ts test/unit/tool-guard.test.ts test/unit/errors.test.ts test/unit/turn-outcome.test.ts test/unit/stall-watchdog.test.ts test/e2e/live-fixes.test.ts test/e2e/profile.test.ts test/e2e/stall.test.ts` gave 92 pass, 0 fail.

Counts: 0 blocker, 1 major, 6 minor.

## Findings

### L-1 major: two pools on one profile overwrite each other's agent file

- **Where:** `src/profile.ts:282`, `src/proxy.ts:426-429`. Every pool writes the same `config/agents/opencode-bridge.md`, and agy is always started with `--agent opencode-bridge` (`src/agy-process.ts:505-506`).
- **Defect:** the file names one pool's port and token, and the last pool to start wins. Nothing locks the file, and nothing rewrites it when a pool's own agy respawns. `docs/design-sessions-runtime.md` (section 4.4, the paragraph on the agent file) supports two OpenCode processes sharing one gemini dir, and it rejected exactly this shape for that reason. Its fallback for the case that came true was a per-pool file `opencode-bridge-<poolId8>.md`, passed to `--agent`, deleted at pool stop and swept when the owner is dead.
- **Failure scenario:** OpenChamber's managed OpenCode server (pool A) and a TUI (pool B) share the plugin profile. B starts after A, so the file names B. A's agy goes idle and stops, or crashes. A's next request respawns agy, which reads B's URL and token. If B has stopped by then, the URL points at a closed port. If B is running, A's agy talks to B's pool endpoint: `tools/list` returns B's tools, and a pool `tools/call` finds no scope for A's conversation id and fails. The live test saw tool calls go to the per-session URL, so with a per-session server present this may stay latent. What agy does when the agent-level server is unreachable at spawn, and whether `call_mcp_tool` survives that, was not checked live.
- **Evidence:** scratch script `twopools.ts`, using the e2e harness with `realModules: true` and a second proxy on the same dirs:

  ```
  A port 63160 file -> http://127.0.0.1:63160/mcp/<token>/pool
  B started on 63161 file -> http://127.0.0.1:63161/mcp/<token>/pool
  B stopped; file still exists: true -> http://127.0.0.1:63161/mcp/<token>/pool mode 600
  dead pool URL: ECONNREFUSED
  A stopped; file still exists: true
  ```

  While A is still running, its profile names B's dead endpoint.
- **Suggested fix:** do what the design doc planned. Name the agent `opencode-bridge-<poolId8>`, write it at pool start, pass that name to `--agent`, delete it in `stop()` and in `exitCleanup`, and have the sweeper delete agent files whose owner entry is gone. Add an e2e test with two proxies on one gemini dir that checks each agy spawn gets its own pool's URL.

### L-2 minor: the agent file and its token outlive the pool, also in a user's own gemini dir

- **Where:** `src/proxy.ts:443-458` (`stop()` never touches the file), `src/profile.ts:278-282` (written before the `isPluginOwnedProfile` check at line 290).
- **Defect:** after `stop()` and after process exit the file stays with the last pool's MCP token and port. For a foreign profile (`isolatedAuth` off, the user's own gemini dir) the plugin now leaves a file holding a secret URL in the user's own agy config.
- **Failure scenario:** the token is dead once its pool stops, and the file is 0600, so the exposure is small. The cost is that a later process listening on that port gets requests from any agy that starts with this agent and still carries the stale URL, and the user's own agy config keeps an MCP server entry pointing at nothing.
- **Evidence:** the scratch run above: `A stopped; file still exists: true`. `test/e2e/profile.test.ts` "a restart rewrites the agent file" reads the file only while a pool runs.
- **Suggested fix:** the deletion from L-1. Without the per-pool name, `stop()` should at least rewrite the file without the `mcpServers` entry, or delete it, when the file still names this pool's token.

### L-3 minor: an error step is marked `agyRetried` without any retry evidence

- **Where:** `src/turn-outcome.ts:125-131`; the retryable branches at `src/errors.ts:70-77` and `src/errors.ts:80-87`.
- **Defect:** every 429, `RESOURCE_EXHAUSTED`, 503 or `UNAVAILABLE` error step gets `agyRetried: true`, on the assumption that agy writes an error step only after its own retries failed. The turn never checks that a retry line was seen. No code in `src` builds `rate_limited` or `capacity` without `agyRetried`, so the retryable branches in `errors.ts` run only in unit tests.
- **Failure scenario:** agy gives up on a first-attempt 429 without retrying, for example for a limit it treats as final. The turn ends with a 429 and "Antigravity already retried on its own", and OpenCode does not retry. The cost is one lost automatic retry and a wrong message. `docs/live-test-fixes.md` lists this path as not verified against Google.
- **Evidence:** `grep -rn 'rate_limited\|"capacity"' src` shows only `turn-outcome.ts:127,130` and `stall-watchdog.ts:211,213`, all with `agyRetried: true`. The e2e test "an error step after agy's retries is a 429 OpenCode does not retry" runs the `error-step` scenario and checks only the mapping. No test covers an error step with no retry line before it.
- **Suggested fix:** keep a per-turn `sawRetry` flag set in `Turn.onRetry` (`src/turn.ts:315`), unlike the watchdog's `lastRetry`, which resets on activity. Have the outcome hook set `agyRetried` only when the flag is set. Add an e2e case for an error step without retry lines that stays retryable. If the assumption is kept, the comment at `turn-outcome.ts:125` should say it is unverified.

### L-4 minor: a retry line attributed to the wrong turn now makes that turn's stall non-retryable

- **Where:** `src/proxy.ts:1336-1342`, `src/stall-watchdog.ts:206-213`.
- **Defect:** when a retry line's model matches no waiting turn, or names no model, every waiting turn whose silence began before the line gets it. Before fix 5, a wrong attribution only lengthened the stall limit and produced a retryable 429 or 503. Now the turn ends with a non-retryable 429 that says agy already retried. Fix 4 makes the fallback more frequent: a turn without a model runs as `antigravity-default`, which never matches the model agy names in its retry line.
- **Failure scenario:** two sessions wait at once in one pool. Session A's model gets a 503 and agy logs a retry line without a model, or with a model id that matches neither turn. Session B is waiting on a slow model of its own, gets the retry event, and goes silent past `retryStallTimeoutMs`. B fails with `antigravity_capacity_exhausted`, and OpenCode does not retry it, though nothing retried for B.
- **Evidence:** code path only. `test/e2e/stall.test.ts` and `test/e2e/live-fixes.test.ts` "a stall after agy's retry lines" use a single turn.
- **Suggested fix:** set `agyRetried` on a stall only when the retry line matched the turn by model, or when exactly one turn was waiting. Keep the fallback attribution for notes and the longer limit only.

### L-5 minor: layer 3 accepts `kind: "execute"` under the name `mcp_tool` too

- **Where:** `src/profile.ts:333-336`, `src/profile.ts:23-29`.
- **Defect:** the doc says `execute` is accepted only with `name: "call_mcp_tool"`. The code accepts it for any name in `MCP_CALL_TOOL_NAMES`, which still holds `mcp_tool`. The comment at lines 23-29 says both names stay until a signed-in smoke run shows which one the hook gets. That run happened and showed `call_mcp_tool` for both the hook and the permission request.
- **Failure scenario:** a request named `mcp_tool` with kind `execute` and only the MCP keys passes layer 3. No known built-in tool sends that, and the key-shape check still rejects any extra key, so this is a gap between the doc and the code. It is not a bypass.
- **Evidence:** scratch script `probe.ts`: `mcp_tool+execute accepted: true`. No test in `test/unit/tool-guard.test.ts` covers this pair. The test at line 137 accepts `mcp_tool` without a kind.
- **Suggested fix:** require `call.name === "call_mcp_tool"` for `execute`, add the `mcp_tool` + `execute` rejection to the "payload agy 1.5.15 sends" test, and update the comment. Dropping `mcp_tool` from the guard script as well is a separate call: the hook name came from agy's docs and the live hook saw `call_mcp_tool`.

### L-6 minor: the pool's `tools/list` hands every open scope's tools to any conversation

- **Where:** `src/mcp-bridge.ts:111-116`, `src/mcp-bridge.ts:151`, together with `src/proxy.ts:815` and `src/models.ts:95`.
- **Defect:** a pool `tools/list` with no conversation id, or with one that matches no scope, returns the union of every open scope's tool definitions. Sessions that get no per-session server now inherit the agent's pool server: the discovery session (`mcpServers: []`), meta and ephemeral sessions, and turns without tools. The design doc named "meta sessions inherited the server" as one reason to keep MCP off the agent file.
- **Failure scenario:** a title or discovery session lists tools through the pool and gets the names, descriptions and schemas of tools from other sessions, possibly other projects. A call from it fails: the pool finds no scope, and layer 3 rejects it because the turn has no tools. Only the token holder sees this, so the cost is wasted model attempts and cross-session tool text in a prompt.
- **Evidence:** `probe.ts`: `pool tools/list with unknown conv id: [ "bash", "read", "secret_tool" ]`. `test/unit/mcp-bridge.test.ts` "the pool endpoint routes tools/call" asserts the union as intended.
- **Suggested fix:** return `[]` for a conversation id that matches no scope. Whether a list without any conversation id can also be `[]` depends on whether agy needs the list to offer `call_mcp_tool`, and that needs one live run.

### L-7 minor: the default model can come from another account's catalog

- **Where:** `src/proxy.ts:767-769`, `src/proxy.ts:1372-1391`, `src/models.ts:61-73`.
- **Defect:** `defaultModel()` takes `models[0]` whenever `modelsUpdatedAt > 0`. The catalog is cached in `dataDir`, survives sign-out and account changes, and is refreshed only after a spawn when it is older than a day. An account change does not reset it.
- **Failure scenario:** the user switches to an account that lacks the first model of the old catalog. A request without a model now gets a non-retried 400 "This Antigravity account has no model ...". OpenCode normally sends a model, so few requests take this path.
- **Evidence:** code path only. The e2e test covers "no discovered catalog" only.
- **Suggested fix:** on `account-changed` and `logout`, set `modelsUpdatedAt` to 0, or store the account epoch with the cache and ignore a cache from another epoch in `defaultModel()`.

## Answers to the questions

- **Who can call a tool through the pool endpoint.** `handleHttp` rejects any request with an `Origin` header and any non-loopback `Host` (`src/proxy.ts:530`), so a browser page and DNS rebinding are out. The path needs the 24-byte MCP token, compared in constant time. A pool `tools/call` runs only on an open scope whose `acpSessionId` equals the conversation id, and only with that scope's tools (`mcp-bridge.ts:139,169`). `Turn.onMcpCall` checks the turn's own allowlist again (`src/turn.ts:322`). A closed scope is gone from the map, so its conversation id finds nothing. A tool from another session's scope answers "not enabled" (unit test and `probe.ts`). The conversation id comes from agy's `_meta`, which the model does not write. One weakening: per-session URLs needed the token and a 96-bit random scope id, while the pool needs the token and a conversation id, which sits in session-store files and agy's conversation DB names. Both are same-user 0600 or agy-owned files, so this changes little in practice. A scope that has not got its `acpSessionId` yet cannot be reached through the pool.
- **Token leaks.** No debug line or error text carries the token. The pool log line names only the method, and `errors.ts:187` drops any agy text with a URL or `/mcp/`. The e2e test checks the logs. The file is written to a temp file with mode 0600, chmodded, and renamed, so it is never readable by others, even briefly. The leak is the file left behind after stop and in a foreign profile (L-2). agy's own log may echo the URL, as it already did for per-session URLs.
- **Built-in tools through both layers.** Not found. `toolCall.name` comes from agy. A `run_command` request named `call_mcp_tool` still carries `CommandLine`, and the key-shape check rejects it (`probe.ts`: `false`). A nameless `execute` is rejected, and so is any other built-in kind under the MCP name. The guard denies every name other than `call_mcp_tool` or `mcp_tool` with `ServerName` `opencode`. The `mcp_tool` gap is L-5.
- **Agent-file race.** Yes, see L-1. Each write is atomic, but the file is shared and the last pool to start owns it.
- **Non-retry only after real retries.** For a stall it holds: `agyRetried` needs a retry line since the last activity, and a plain stall stays a retryable 504 (e2e test). For an error step it does not hold (L-3), and attribution across turns can give the flag to the wrong turn (L-4). OpenCode 2.3.0's classifier was read: mid-stream `code: 429` becomes the status, and `QUOTA_TEXT` matches "Request limit exhausted", so the turn is a `QuotaExceededError` (`@opencode/ai/dist/provider-error.js:129,189`). The HTTP path sends `x-should-retry: false`.
- **Test coverage.** The tests cover the pool routing by conversation id, an unknown id, a tool from another scope, the real permission payload, `execute` without the name, the 0600 mode and the log check, the 400 for an unknown model, and the three retry cases with one turn each. They do not cover two pools on one profile, the file after stop, `mcp_tool` with `execute`, an error step without retry lines, retry attribution with two waiting turns, or the default model after an account change.

## Checked and found correct

- Atomic 0600 write of the agent file (`writeAtomic`), with the temp file removed on failure; the YAML URL is a JSON-quoted string.
- Start ordering: the listener is up before the profile write, and a failed write stops the listener (`src/proxy.ts:426-436`).
- `servesScope("pool")` accepts only the exact id `pool`, and extra path segments answer 404.
- The conversation-id cross-check on per-session scopes is unchanged.
- Permission debug line: tool name, kind and key names only, never values (`src/proxy.ts:1303-1307`).
- `Unknown model ID` mapping: the id is echoed only when it matches `^[A-Za-z0-9._:-]{1,80}$`; status 400 gives `x-should-retry: false` on HTTP and code 400 mid-stream, and OpenCode classifies a 4xx as an invalid request.
- `defaultModel()` never falls back to the built-in list: `loadCachedModels` returns the fallbacks with `updatedAt: 0`, which the check skips, and `AGY_DEFAULT_MODEL` skips `set_config_option`.
- `StallWatchdog` clears `lastRetry` on any model activity, so a retry that agy got past does not mark a later stall.
- A duplicate `acpSessionId` across two open scopes would route to the older scope (`scopeForConversation` takes the first match). I found no path that leaves an old scope open when a session is resumed: `setupMain` calls `closeLive` before `tryResume`, and process exit closes every scope of that generation.
