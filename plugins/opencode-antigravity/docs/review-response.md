# Implementation review response

Two independent deep reviews ran on the finished code: [review-impl.opus.md](review-impl.opus.md) (Opus High, O-1 to O-12) and [review-impl.neon.md](review-impl.neon.md) (Gemini 4 Neon High, N-1 to N-14). Each finding went to the implementer who owns the file. The per-owner tables, with the reason and the proving test for every row, are:

| Owner | Files | Table |
| --- | --- | --- |
| Auth and install | `src/auth/*`, `src/install/*` | [review-response-auth.md](review-response-auth.md) |
| Proxy and turn | `src/proxy.ts`, `src/turn.ts` | [review-response-proxy.md](review-response-proxy.md) |
| Runtime support | `src/agy-process.ts`, `tmp-sweeper.ts`, `acp-client.ts`, `turn-outcome.ts`, `errors.ts`, `index.ts` | [review-response-runtime.md](review-response-runtime.md) |
| Sessions | `src/fingerprint.ts`, `session-store.ts`, `replay.ts`, `profile.ts`, `contracts.ts` | [review-response-sessions.md](review-response-sessions.md) |

## Outcome per finding

| Id | Severity | Result |
| --- | --- | --- |
| N-1 | blocker | Fixed (sessions) |
| O-1 | major | Fixed (runtime; auth side needed no change) |
| O-2 | major | Fixed (auth: microtask notify; proxy: epoch read once, busy entries kept) |
| O-3 | major | Fixed (auth: install and auth locks; sessions: binding locks) |
| O-4 | major | Fixed (runtime) |
| O-5 | major | Fixed (runtime) |
| O-6 | major | Fixed with a bounded 30 s drain wait plus a status note; see [decisions.md](decisions.md) |
| N-2 to N-5 | major | Fixed (proxy) |
| N-6 | major | Fixed (sessions) |
| N-7 | major | Fixed (runtime, proxy reports sign-in required) |
| N-8 | major | Fixed (runtime passes `kind`; sessions rejects built-in kinds and foreign keys) |
| N-9 | major | Fixed (auth widens redaction; runtime never passes agy error text through) |
| O-7 to O-12 | minor | Fixed |
| N-10, N-11, N-12 | minor | Fixed |
| N-13 | minor | Refuted: no cancel can land between `setupMain` returning and `withSetup` resuming, since every cancel source is a macrotask |
| N-14 | minor | Fixed; one sub-claim (N-14.5, the privacy test ignoring the log sink) refuted, an error-path case added anyway |

25 of 26 findings fixed, 1 refuted. Each fix has a test that fails with the fix reverted.

## State after the fixes

From the plugin directory: `bun run type-check` clean; `bun run test` 611 pass, 5 skip (opt-in real-binary smoke test), 0 fail across 49 files; `bun run build` passes.

## Still unverified without a signed-in account

- Which ACP `kind` agy sends on a permission request for `call_mcp_tool`. Layer 3 accepts `other` or no kind; any other value would reject every OpenCode tool call.
- Whether `session/resume` keeps the `_meta` system prompt append (decides the `resumeAfterRestart` default).
- Which tool name the PreToolUse hook sees for MCP calls (`call_mcp_tool` or `mcp_tool`; both accepted).
