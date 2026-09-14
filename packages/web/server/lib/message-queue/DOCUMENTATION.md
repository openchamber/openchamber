# Message Queue

## Purpose

Owns the messages a user queued while a session was busy, and sends them the
moment the session goes idle. The queue lives in the web server so a closed
tab, a locked phone, or a dropped connection no longer strands it. Structural
template: `permission-auto-accept` — the server is authoritative, the shared UI
renders a projection, and VS Code (which has no server of its own) keeps its
UI-side queue and foreground auto-send hook.

## Files

- `runtime.js` — `createMessageQueueRuntime(...)` (state, persistence,
  dispatch loop, event handling) and `registerMessageQueueRoutes(app, runtime)`.
- `runtime.test.js` — delivery, idleness gates, retries, holds, persistence,
  concurrency with in-flight sends, slash commands, and project knowledge.

Wiring: created in `server/index.js` after the global event hub and the
session-knowledge runtime; routes registered in
`opencode/feature-routes-runtime.js` (before the generic OpenCode proxy) with
JSON bodies enabled in `opencode/core-routes.js`; stopped by
`opencode/shutdown-runtime.js`, which waits for in-flight sends and the queued
write chain before closing the server.

## Item

An item is what the UI would have sent itself, captured at queue time so the
send never re-resolves mutable UI state:

```
{
  id, createdAt,
  content,        // raw text for display and editing
  contextPreview?, // bounded display-only summary captured by the UI
  text,           // text to deliver (agent mention stripped, file mentions resolved); defaults to content
  agentMention?,  // delivered as an `agent` part
  attachments: [{ id, filename, mimeType, size, source, serverPath?, dataUrl }],
  context: [      // what the composer had attached, in send order
    { kind: 'context', text, metadata, instructions? },  // a draft chip or linked issue/PR; metadata is the UI's structured payload
    { kind: 'instruction', text },                       // derived from the text (skill instruction)
    { kind: 'synthetic', text },                         // handed to the composer by another surface
  ],
  sendConfig: { providerID, modelID, agent?, variant? }   // required
}
```

The server is a courier for `context`: it validates the shape (a kind it
knows, a `metadata` object on `context` entries) and delivers each entry as a
synthetic text part, an entry's `instructions` going out as its own part just
before it and its `metadata` riding the part verbatim so the timeline renders
the context block back. The payload inside `metadata` is the UI's contract
(`lib/messages/contextParts.ts`), parsed by the UI on the way back.

`parseQueuedItemInput` rejects anything the server could not deliver later
(no text, attachments, or context; missing model; malformed attachment or
context entry). Public snapshots and broadcasts strip the payloads —
attachment `dataUrl` (megabytes of base64) and `context` (a PR diff, say) —
so they do not ride every update; the only way to get them back is a `take`.

Snapshots retain `contextPreview`, capped at 100 characters plus an ellipsis.
It carries the attached comment or context label when `content` is empty and
never replaces editable text or delivered parts. Older items without a summary
derive one from the attached comment metadata or the first non-instruction
context text. This optional field needs no queue-file migration.

## Persistence

`<data-dir>/message-queue.json` (`OPENCHAMBER_DATA_DIR` or
`~/.config/openchamber`) stores `{ version, revision, sessions,
sessionLifecycles, takeReceipts, completedRestores, enqueueIdempotency }`. The
file is written atomically through a serialized temp-file and rename chain.
Lifecycle tombstones retain a session generation and directory after deletion.
Take receipts protect payloads until the client acknowledges delivery, and
bounded operation history makes retries idempotent across a restart. A missing
file is an empty queue. Malformed syntax and structurally invalid envelopes are
moved aside as `message-queue.json.corrupt-<timestamp>` before the runtime
starts empty, so the next write cannot overwrite the original data. A failed
read or quarantine leaves writes disabled until a later load succeeds. Valid
queue entries next to malformed entries are recovered when their enclosing
maps are structurally valid. `revision` is a global monotonic counter bumped on
every mutation; clients use it to reject stale snapshots.

After the initial load, durable mutations from public routes and upstream hub
events share one FIFO transaction chain. Each transaction captures the full
in-memory queue state, applies its change, and lets `commit()` bump `revision`,
write the file atomically, and broadcast only after the write succeeds. A
failed write restores the captured state, including lifecycle and receipt
metadata. Holds and dispatch markers remain in memory and do not enter this
durable chain.

In-memory only, deliberately: the in-flight item (`sendingId`), retry
backoff, abort timestamps, and holds. A restart has no in-flight sends; a
persisted "sending" flag would strand a message forever.

## Delivery loop

1. `start()` subscribes to the global upstream hub and loads the file; on
   load and on every hub `connect` it arms every session that has items.
2. `session.status` for a queued session: `idle` arms a short quiet timer
   (500 ms, coalescing the burst around a turn boundary), `busy`/`retry`
   clears it. A `message.updated` for a completed assistant reply arms as
   well, so a missed idle event cannot strand the queue. `session.deleted`
   drops the session's queue. An assistant `MessageAbortedError` records an
   abort.
3. `tick(sessionId)` bails when the queue is empty, an item is in flight, or
   the session is held. It re-arms after a 2 s post-abort hold (the UI's
   old behavior: a stop is not immediately followed by the next prompt) or
   while the head item is in retry backoff.
4. Idleness is re-verified against OpenCode before sending, because
   `prompt_async` into a running turn steers into it instead of starting the
   next one: `GET /session/status` must not list the session as busy/retry,
   and the trailing message must not be an unfinished assistant reply (the
   status map only lists busy sessions, so a missed busy event leaves no
   entry while a turn still streams). A failed fetch is unknown, never idle:
   the tick re-arms with backoff.
5. The head is marked in flight (broadcast), then sent:
   - text starting with `/` that names a command in OpenCode's `/command`
     list (skills included) and carries no captured context goes to
     `POST /session/:id/command` with the captured model, agent, variant, and
     file parts. That route accepts file parts only, so a command queued
     **with** context takes the prompt route instead, the same rule the
     composer applies: the command's template is expanded with its arguments
     (`$ARGUMENTS`, `$1..$N`, or appended), a skill keeps its `/name args` text
     and gets an explicit "the user invoked this skill" synthetic part after
     the context;
   - otherwise `POST /session/:id/prompt_async` with the parts in the same
     order a UI send uses: text, files, the captured context, the skill
     invocation when there is one, pending project knowledge
     (`sessionKnowledgeRuntime.resolvePendingForSession`, synthetic, recorded
     as delivered only after the prompt is accepted), then the agent mention.
   Success removes the item, persists, broadcasts, and marks the user
   message sent for notifications. Failure keeps the item, backs off
   2 s → 60 s (doubling per consecutive failure of that item), and re-arms.
6. The next item goes out after the next busy → idle cycle.

## Holds

Auto-review is driven from the UI and bounces the original session through
idle between iterations; the UI tells the server to hold that session's queue
(`PUT .../hold { held: true, ttlMs? }`) while a run is going and releases it
when the run ends. A hold expires on its own (default 5 min, cap 10 min)
because the UI that asserted it may be gone. Expiry re-arms a queued session
through the normal quiet, abort, and retry gates. The UI re-asserts it every
two minutes while the run continues. The UI persists one `clientToken` per
runtime and the last accepted or echoed `sequence` per session in browser
storage, so a reload continues as the same owner with a monotonically
increasing sequence. While a hold is active, only its current token can
mutate it; a different token's sequence-1 assertion cannot replace the active
owner. After the hold is released or expires, a different token may establish
a new hold at sequence 1. Delayed lower-sequence mutations from the same
token are ignored. When the server refuses a stale sequence it echoes the
sequence it holds, and the UI retries just above that echo (bounded; failed
releases keep retrying in the UI's bounded release lane). Hold requests also
carry the captured session generation, so deletion and session-ID reuse
reject stale holds. Releasing arms a dispatch.

## Routes (`/api/message-queue`)

Normal authenticated OpenChamber runtime routes; never on browser URL-token
allowlists.

| Route | Purpose |
|---|---|
| `GET /api/message-queue` | Full snapshot `{ revision, sessions[], sessionLifecycles }`. `sessions[]` includes active empty sessions so clients can clear a projection with the authoritative directory and generation. |
| `POST .../sessions/:id/items` | Append `{ directory, item, idempotencyKey?, generation? }`; returns `{ revision, session, itemId }` and arms a dispatch (the session may already be idle) |
| `DELETE .../sessions/:id/items/:itemId` | Remove `{ directory, generation? }`; `409` while that item is in flight or when the captured directory is stale. |
| `POST .../sessions/:id/items/:itemId/take` | Remove and return the full item (payloads included); accepts `{ directory, operationId?, requireHead?, generation? }` and returns a durable take receipt. A receipt larger than 50 MiB is rejected before removal. |
| `POST .../sessions/:id/take` | Remove and return every item not in flight, in order; accepts `{ directory, operationId?, generation? }`. An oversized receipt is rejected before removal. |
| `POST .../sessions/:id/restore` | Restore `{ directory, items, operationId?, generation? }`; a take operation id is required when lifecycle metadata requires a receipt |
| `POST .../sessions/:id/take-receipts/:operationId/ack` | Acknowledge a successfully delivered take receipt with `{ directory, generation? }` |
| `PUT .../sessions/:id/order` | `{ directory, itemIds }`; `itemIds` must be a complete permutation |
| `DELETE .../sessions/:id` | Clear `{ directory, generation? }`; the in-flight item stays |
| `PUT .../sessions/:id/hold` | `{ directory, held, ttlMs?, generation?, sequence?, clientToken? }`; active holds reject other tokens, and stale same-token sequences are ignored |

Every mutation broadcasts `openchamber:message-queue.updated` with
`{ revision, session }` to all connected clients (SSE and WS), so several
devices on one server see one queue. SSE uses the shared control stream at
`/api/openchamber/events`; `/api/global/event` carries no OpenChamber events.
The UI subscribes independently of its OpenCode transport and re-reads the
snapshot whenever either stream reconnects. The session in that payload always names
its `directory` and current session `generation`, including the broadcast that
removes the last item: the UI
keys its projection by directory, and a broadcast without one left the
delivered message on screen (a session's directory is remembered until the
session is deleted or evicted).

The `directory` in every session mutation is the caller's captured session
directory. The server compares it with the authoritative current directory and
rejects a stale move with `409` before changing the queue, revision, or take
receipts. Recreated session incarnations require a matching durable take
receipt for restore; first-ever restores and receipt-backed recovery remain
valid.

Limits: 20 items per session, 50 sessions (oldest evicted, never one with an
item in flight), 200k characters of content; attachment payloads are bounded
by the route family's 50 MB JSON limit.

## UI ownership

`packages/ui/src/stores/messageQueueStore.ts` is the projection: see its
section in `packages/ui/src/stores/DOCUMENTATION.md`. VS Code intentionally
does not use this module; with all OpenChamber webviews closed, queued
messages there are not delivered.
