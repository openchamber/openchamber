# Session Assist

Server-side watcher that generates a short recap of the agent's last reply
and the agent's own proposed next step with the small model
(`lib/small-model`), storing both on the session's metadata under
`metadata.openchamber.assist`.

## What the suggestion is

The suggestion is written **in the agent's voice** — "I would…" — and says what
it would do next if told to keep going. It is explicitly **not** an order
addressed to the agent in the user's voice.

That distinction is the reason the whole conversation is sent. A suggestion
generated from the last exchange alone cannot see the request the session
started from, so it has no way to know the work is finished, and its prompt
gives it no way to say so: it will always manufacture a next step, and the
agent's own "I did not verify X" caveats become the next instruction. The
system prompt therefore requires an **empty string** when the user's request is
already satisfied or the session is waiting on a human decision, and an empty
suggestion is a correct answer rather than a generation failure.

## Flow

1. `createSessionAssistRuntime` is a consumer of the server's global SSE
   fan-out (`index.js` → `onPayload`), riding the same upstream connection as
   notifications. Purely event-driven — dormant sessions never generate
   anything, there is no backfill and no session scanning.
2. `session.status: idle` arms a 60-second per-session timer; any `busy`/
   `retry` status or a user `message.updated` clears it (the "1 minute of
   quiet" rule).
3. On fire: fetch the session (skip sub-agent sessions with `parentID`),
   render the WHOLE conversation (`buildTranscript`) and call
   `generateSmallModelText` with the
   session's own provider/model taken from the last assistant message — so
   the utility call spends the same subscription as the conversation.
   `restrictToPreferredProvider` forbids the resolver's global fallback:
   conversation content never goes to a provider the user didn't pick for
   the session, unless the small model was chosen explicitly (settings
   override or opencode config). A resolver 404 is silently skipped.
4. The requested JSON fields (`recap`, `suggestion`, or both) are clamped and
   PATCHed onto the session metadata together with `forMessageID` (the last
   assistant message id) and `generatedAt`. Before writing, the session tail is
   re-checked (a stale result is dropped) and the metadata is merged from a
   fresh session read so concurrent metadata writes made during generation are
   preserved.

## Transcript shape and the prefix cache

`buildTranscript` renders every message oldest-first as `#N Role:` blocks —
text parts plus **tool names only**, never tool input or output (a session can
be almost entirely tool calls, so omitting them renders it as an empty
conversation; including their payloads would pipe file contents and command
lines into a utility prompt).

Everything that varies per call — the pointer to the last message, the
requested fields, the language sample — goes **after** the transcript. The
history is therefore an append-only prefix between consecutive assists on one
session, which a backend that caches prefixes can serve without re-prefilling.
That is an opportunity, not a guarantee: it depends entirely on the provider.
An OpenAI-compatible backend in front of vLLM or sglang does it automatically,
and there the effect is large (measured: 35s for the first assist on a
154k-character transcript, 8s for each of the next two). Anthropic caching, by
contrast, requires explicit `cache_control` breakpoints, which `callSmallModel`
never sends, so this ordering buys nothing there and costs nothing either.
Over budget the oldest messages are dropped, but only on
a `TRANSCRIPT_DROP_CHUNK` boundary: dropping one message per turn would move the
start of the transcript every time and re-prefill the whole session on every
cycle.

The budget is not a constant. It comes from `describeSmallModel().inputCharBudget`
for the model that will actually answer, minus `PROMPT_SCAFFOLD_RESERVE_CHARS`:
a local proxy model is absent from the models.dev catalog and falls back to a
conservative 64k context, so a fixed budget would either waste a large window or
overflow a small one.

This buys latency, not spend — the provider still bills every input token, and
assist cost is now proportional to session length rather than constant. Text
parts and tool names alone stay far below what the conversation itself sends:
measured on live sessions, 403 messages render to ~10k tokens, 1921 to ~56k.

**The fetch scales too, and it is the larger number.** `fetchSessionMessages`
without a `limit` pulls every message with its parts, tool inputs and outputs
included, and the transcript then keeps only text and tool names. On a long
session that is a transient multi-megabyte download and JSON parse in the
server process once per assist cycle, far bigger than the prompt it produces.
It is bounded (one in-flight assist per session, a 20s timeout) and OpenCode's
message endpoint offers no field projection to narrow it, but anyone measuring
this feature's cost should measure the fetch, not just the model call.

The prefix cache is **assist-to-assist only**. This module calls the provider
directly, with its own system prompt and no tool schemas, so it shares no
prefix with the request OpenCode makes for the conversation itself.

Because the clamp in `lib/small-model` truncates the **tail**, which here is the
instruction, the call passes `onOverflow: 'error'`. A session larger than its
own model's context (`context-too-small`) and a reasoning model that spends the
output budget thinking (`output-exhausted`) are expected outcomes of a
whole-session transcript, so both are skipped without a warning.

## Settings gate

`sessionRecapEnabled` and `sessionSuggestionEnabled` in OpenChamber settings
(Settings → Chat, default on) are hard generation switches checked at fire
time. When both are off, no small-model calls run and nothing is written. When
one is on, the runtime still makes at most one small-model call and asks only
for that field. The UI also hides disabled payload types immediately.

## Freshness contract (no clearing writes)

Clients do not need the payload to be deleted: they render it only while
`assist.forMessageID` still equals the session's last assistant message id
(and the session is idle). Any new message invalidates the payload
everywhere instantly and offline; the next idle cycle overwrites it.

## UI consumers (packages/ui)

- `lib/sessionAssistMetadata.ts` — payload parsing.
- `hooks/useSessionAssist.ts` — freshness gating + the 1-minute quiet window
  for the recap (single timeout to the boundary, no polling).
- `components/chat/SessionRecapSpacer.tsx` — renders the recap inside the
  fixed-height reserved gap under the last message (height never changes).
- `components/chat/SessionSuggestionChip.tsx` — one tappable suggestion chip
  near the composer (desktop chips row + above the mobile pill); hidden as
  soon as the composer has any content. Tap fills the input, never sends.

## Limitations

- The watcher lives in the web server, so VS Code (extension-only, no web
  server) does not generate assists; it still renders payloads produced by a
  web/desktop instance of the same OpenCode server via `session.updated`.
- Metadata payloads ride every `session.updated` event — keep the clamps
  (`RECAP_CHAR_LIMIT`, `SUGGESTION_CHAR_LIMIT`) small.
