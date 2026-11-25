# Review response: sessions and prompt

Response to `docs/review-impl.neon.md` (N-*) and `docs/review-impl.opus.md` (O-*) for `src/fingerprint.ts`, `src/session-store.ts`, `src/replay.ts`, `src/prompt.ts`, `src/profile.ts` and the permission type in `src/contracts.ts`. Each finding was reproduced with a unit test that fails on the code before the fix.

| Id | Result | Reason | Proving test |
| --- | --- | --- | --- |
| N-1 | Fixed | After a clean no-output failure, new user input now gets an `append` that sends the failed turn's input again before it, the same way `redo` does. agy may not have recorded a cancelled prompt's input, so it is never assumed to be there. A failed range that cannot be read gives `fresh` | `test/unit/fingerprint.test.ts`: "N-1: new input after a clean no-output failure carries the failed turn's input again", "N-1: an echo of the failed turn's status note is dropped before the new input" |
| N-6 | Fixed | The old/recent boundary is clamped to the start of the latest input, so steps 1 to 6 never cut or drop the current turn's tool results however many there are | `test/unit/replay.test.ts`: "N-6: every result of the latest input stays whole while old turns can still be cut" |
| N-11 | Fixed | `cutMiddle` counts its marker inside `max` and falls back to a plain head when the marker does not fit. Step 7 cuts from the original text on each pass, so markers never nest. When the call wrappers alone are too large, it collapses recent tool calls into a count line, then drops recent history before the latest input. The budget counts the latest input as rendered, including `<system-update>` wrappers and fallback blocks. A 3,000-case fuzz with budgets from 1,000 to 61,000 had no overshoot | `test/unit/replay.test.ts`: "N-11: many recent tool calls under a small budget still fit", "N-11: system updates and fallback blocks of the latest input count against the budget" |
| O-3 (binding locks) | Fixed | A same-host lock is stale when its pid is dead, when it was acquired before this boot (`os.uptime()`), or when its heartbeat is more than 5 min old. A live holder touches it every 60 s. The trade-off: right after a long sleep, a contender can win before the holder's next touch. This replaces SR 4.8's "a live pid is never stale" | `test/unit/session-store-lock.test.ts`: "O-3: same host, live pid (reused), heartbeat 1 h old: stolen", "O-3: same host, live pid, acquired before this boot: stolen even with a fresh heartbeat", "same host, live pid, fresh heartbeat: not stolen" |
| N-8 | Fixed | `PermissionRequestParams.toolCall.kind` was added. `matchMcpPermission` rejects the built-in ACP kinds (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`). When `toolCall.name` is absent, every key in `args` and `rawInput` must be a `call_mcp_tool` key (`ServerName`, `ToolName` and `Arguments` in each casing) | `test/unit/tool-guard.test.ts`: "N-8: a built-in tool with injected ServerName and ToolName is rejected", "N-8: a nameless MCP call with only MCP keys, kind other or absent, is accepted" |

## Changes needed in other owners' files

- **`src/acp-client.ts` (runtime support):** `parsePermissionParams` must pass `toolCall.kind` through when it is a string. Without it, the kind check in layer 3 never sees a kind.
- **`src/proxy.ts` (proxy):** line 676 records `turn.input = { from: entry.record?.prefixCount ?? 0, ... }`. For `append` and `redo` plans it should be `from: result.prefix.count - plan.input.length`. The N-1 `append` now carries the earlier failed input, which starts before the previous prefix. A second clean failure would otherwise redo only the newest message.

## Not verified

- The ACP `kind` agy sends for a `call_mcp_tool` permission request. Layer 3 accepts `other` or no kind. If agy labels the MCP call `fetch` or `read`, every tool turn is rejected, and smoke test 11.3 step 7 shows it at once.
