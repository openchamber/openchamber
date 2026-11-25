# Decisions

The user's locked answers to the design questions, and the answers to the planners' follow-up questions. The user said to take the recommended option for anything not asked explicitly, so the follow-ups below use the planner's recommendation.

## Locked by the user

| # | Topic | Decision |
|---|-------|----------|
| Q1 | agy binary | Managed, SHA-512-verified download from Google's manifest by default. `binaryPath` / `OPENCODE_ANTIGRAVITY_BIN` override. PATH and T3 Code's cache only when configured or as an offline fallback. |
| Q2 | Session continuity | Persisted OpenCode-to-ACP session mapping with message fingerprints. Append-only turns reuse the ACP session; divergence opens a fresh session with a structured replay. |
| Q3 | Process topology | One shared `agy acp` process per plugin pool, many sessions, crash recovery, idle shutdown. |
| Q4 | 429 and stalls | Status notes in `reasoning_content` during silence or retries; stall timeout cancels the ACP turn and returns a retryable error. |
| Q5 | Prompt and tools | Base system prompt up to 32 KB, compact exact tool schemas, `--agent opencode-bridge` with `tools: []`, plus a `PreToolUse` hook denying everything but `call_mcp_tool`. |
| Q6 | Auth isolation | `isolatedAuth: true` by default. |
| Q7 | Auth methods | `oauth-personal` only, with seams for `oauth-business`, `gemini-api-key`, `agent-platform`. |

## Follow-ups (planner recommendation taken)

| Source | Question | Decision |
|--------|----------|----------|
| install-auth | With `isolatedAuth: false`, does Disconnect sign terminal agy out of the keyring? | No. The proxy stops OpenCode from using the shared login; the terminal login stays. |
| install-auth | OAuth method mode: `code` or `auto`? | `code`. Generic sign-in errors in OpenChamber are an upstream OpenCode issue to report separately. |
| sessions-runtime | After an agy restart, `session/resume` first or always fresh + replay? | Resume first, replay as fallback. If the smoke test shows resume drops the `_meta` system prompt, the default flips to fresh. |
| sessions-runtime | Tool description changes: fresh session or note in the next prompt? | Same session plus a note. Name or schema changes still start a fresh session. |
| sessions-runtime | Defaults | 10 min idle stop, 20 s status note, 180 s silence stall (504), 300 s while agy logs retries (429/503). |
| implementation review O-6 | After a binary update, how long can a parked turn on the old agy hold up new requests? | At most 30 s (`drainWaitMs`), counted from the first request that has to wait; then the old agy stops and its parked turns fail with a retryable 503. The recommended two-generation drain (new requests on the new agy at once) was not built: every MCP call, permission check, cancel and exit handler in `proxy.ts` and `turn.ts` assumes one live generation, so it would rewrite the request path for a case that happens at most every 6 h. A status note while a request waits is a request to the proxy owner. |
| live test | How does the custom agent get `call_mcp_tool`? | The agent file declares one MCP server, `opencode`, at the proxy's pool URL (token inside, file 0600, rewritten at each pool start). agy 1.5.15 then offers `call_mcp_tool` and sends the calls to the per-session server from `session/new`; the pool endpoint routes by conversation id if it is ever used. A name-only entry would expose the tools natively as `mcp_opencode_<tool>`, which the guard and the prompt do not use. |
| live test | After agy exhausted its own retries (error step, or a stall after retry lines) | Not retried by OpenCode: 429 with `x-should-retry: false` and a quota-style text, "try again later or pick another model". A plain stall without retry evidence stays a retryable 504. |
