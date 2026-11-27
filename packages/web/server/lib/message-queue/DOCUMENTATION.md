# Message Queue

## Purpose

Owns the messages a user queued while a session was busy, and sends them the
moment the session goes idle. The queue lives in the web server so a closed
tab, a locked phone, or a dropped connection no longer strands it. Structural
template: `permission-auto-accept` — the server is authoritative, the shared UI
renders a projection, and VS Code (which has no server of its own) keeps its
UI-side queue and foreground auto-send hook.

## Invariants

- Raw JSON from client bodies, the queue file, OpenCode responses and hub
  events is read only in the boundary readers (`asNonEmptyString`, `asText`,
  `asRecord`, `asList`, `asCount`, `parse*`); everything below them branches on
  the domain values those return.
- The tick re-reads the queue after every await. A user can remove, reorder or
  clear items while idleness is being checked, and only the same head item may
  be sent.
- The queue file holds conversation content, so it is readable by its owner
  only (`0o600`).

## TypeScript boundaries

`runtime.ts` owns the parsed queue item and public snapshot contracts. Its input
types come from boundary schemas, which retain the existing defaults and
TypeError refusals. Context metadata is checked only as a non-array object and
passed through by reference; its properties remain unchecked until read.
Scheduled items may omit their provider and model to retain the session's
selection. Goal creation accepts numeric budgets and omitted unused fields
through the declaration on `../session-goal/create.js`.

### Why queued skills travel as names and resolve at send

An item carries the skill names the user mentioned with `$name`. At send the
runtime lists OpenCode's skills for the directory and attaches the matches (by
name, then id) to the prompt as `skills`, the way a direct send from the
composer does. OpenCode then puts the skill's text into the message itself; an
instruction alone fails for a skill whose frontmatter sets
`disable-model-invocation`, because OpenCode keeps it out of the model's skill
list and the model answers that no such skill exists. Names it does not list, a
failed list, and every skill of a slash command (the command route takes no
attachments) go into the same instruction text the shared UI's
`buildSkillMentionInstruction` writes.

Resolving at send rather than at queue time keeps the item valid when skills
change while it waits. The catalog reads (`/api/skill`, and `/api/command`
for slash commands) pass `location[directory]`: OpenCode ignores a plain
`directory` query there and would answer for its own working directory,
missing project skills and commands. `/api/skill` does not wait for the
location's plugins to finish activating and answers `[]` on a location that
is still booting, as a queue drained right after a restart finds it, so the
lookup first calls `/api/model`, which waits for activation. Plugins fill the
command catalog too, so text with a leading slash waits on `/api/model` before
`/api/command` decides whether it is a command, with or without skills; on a
cold location the command would otherwise go out as plain text. A prompt rejected with `Skill not found` (a skill removed
between the list and the prompt) is sent again without attachments and with the
instruction, so the item cannot retry forever.

Skill instructions are persisted apart from `syntheticIds` as
`skillInstructions: [{ id, names }]`, one entry per set of names first admitted
together. OpenCode keeps the first payload for an id, so one id reused for a
different set of names would silently drop the new ones. Which skills resolve
can differ between attempts: names an entry already covers are admitted again
under that entry's id with its original names (OpenCode answers the repeat
with the first record), and newly unresolved names, including skills the
prompt rejected, get a new entry persisted before the post. A retry therefore
neither admits an instruction twice nor loses a name.

A staged revert is committed only right before something is admitted ahead of
the message: captured context, the goal briefing, or a skill instruction
(including the one for a rejected skill, which is why the fallback commits it
then). For an instruction the commit comes after its id is saved, so a failed
queue write leaves the undo staged. An item with only attached skills leaves the revert to OpenCode, which
commits it once prompt preparation succeeds; committing it earlier would make
the undo permanent even when the send then fails. Committing late would make
the prompt commit the revert after an instruction and drop it with the
reverted messages.

### Why active-map lookups retain their object check

A session id can name an inherited property such as `constructor`. Only a
non-array object from the active-map lookup blocks delivery; comparing the
lookup with `undefined` would also block on inherited functions.

### Why internal invariant checks throw

A retained queue has a directory and a head item, a validated reorder resolves
every id, and synthetic admission follows id persistence. Checks at indexed
reads enforce these invariants without casts or non-null assertions.

## Files

- `runtime.ts` — `createMessageQueueRuntime(...)` (state, persistence,
  dispatch loop, event handling) and `registerMessageQueueRoutes(app, runtime)`.
- `skills.ts` — queued `$skill` mentions: parses them off an item, resolves
  them against OpenCode's catalog per send, admits the instruction for the
  unresolved ones, and sends the prompt with the attachments (including the
  `Skill not found` fallback). Owns `catalogScope`, the `location[directory]`
  query every catalog read uses.
- `runtime.test.js` — delivery, idleness gates, retries, held delivery, persistence,
  concurrency with in-flight sends, slash commands, and project knowledge.

Wiring: created in `server/index.js` after the global event hub and the
session-knowledge runtime; routes registered in
`server-frame/feature-routes-runtime.js` (before the generic OpenCode proxy) with
JSON bodies enabled in `server-frame/core-routes.js`; stopped by
`server-frame/shutdown-runtime.js`.

## Auto routing

`resolveAutoSelection` (the routing runtime) runs right before the send when
the queued send config names `openchamber/auto`, and answers with the real
model and agent. OpenCode 2.x holds both on the session, so the queue applies
them with the `POST /api/session/:id/model` and `/agent` calls it already
makes. The queue captures the sentinel like any other send config. The request
text it routes on carries the same image attachment fact as a direct send
(`attachmentHint`).

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
  skills?,        // `$name` skill mentions, resolved at send (see "Why queued skills travel as names")
  attachments: [{ id, filename, mimeType, size, source, serverPath?, agentPath?, dataUrl, original? }],
  context: [      // what the composer had attached, in send order
    { kind: 'context', text, metadata, instructions? },  // a draft chip or linked issue/PR; metadata is the UI's structured payload
    { kind: 'instruction', text },                       // derived from the text (skill instruction)
    { kind: 'synthetic', text },                         // handed to the composer by another surface
  ],
  sendConfig: { providerID, modelID, agent?, variant?, keepSessionModel?, keepSessionAgent? },  // required
  goal?: { objective?, tokenBudget },  // queued with "run as goal" armed
  syntheticIds?   // minted by the first delivery attempt, one per record admitted ahead of the message
  skillInstructions? // [{ id, names }], one per set of skill names admitted together; queue file only
}
```

`goal` is the composer's armed goal, taken off the composer when the message
is queued so it belongs to this message and no other. `objective` is present
only when the arming flow supplied its own (the plan flow); otherwise the
delivered `text` is the objective. A goal needs message text. Snapshots keep
`goal`, so the queue row can show it.

The server is a courier for `context`: it validates the shape (a kind it
knows, a `metadata` object on `context` entries) and delivers each entry as a
synthetic text part, an entry's `instructions` going out as its own part just
before it and its `metadata` riding the part verbatim so the timeline renders
the context block back. The payload inside `metadata` is the UI's contract
(`lib/messages/contextParts.ts`), parsed by the UI on the way back.

An attachment's `agentPath` — the file's on-disk location the desktop client
resolved at intake — travels to OpenCode as the prompt file's `name`, the
field the model reads as the file identity, falling back to `filename` when
absent. `filename` itself still rides the attachment unchanged for the UI's
own display.

An attachment's `original` (`{ mimeType, dataUrl, saveOnSend? }`) is the file
the user picked when the UI queued a path note in its place, for a model that
cannot read it or for a file held to be written at Send (`saveOnSend`). The UI sends it only while the request stays within its 40 MiB budget, so it may be absent. The server stores it and never delivers it; `take` hands it back so Edit
restores the picked file.

`parseQueuedItemInput` rejects anything the server could not deliver later
(no text, attachments, or context; missing model; malformed attachment or
context entry). Public snapshots and broadcasts strip the payloads —
attachment `dataUrl` and `original` (megabytes of base64) and `context` (a PR diff, say) —
so they do not ride every update; the only way to get them back is a `take`.
`syntheticIds` comes only from the queue file: `parseQueuedItemInput` drops it
from client input, and snapshots leave it out.

Snapshots retain `contextPreview`, capped at 100 characters plus an ellipsis.
It carries the attached comment or context label when `content` is empty and
never replaces editable text or delivered parts. Older items without a summary
derive one from the attached comment metadata or the first non-instruction
context text. This optional field needs no queue-file migration.

## Scheduled items

Scheduled tasks use the same items with an optional `scheduledTask` field
containing `projectId` and `taskId`. Reuse does not change the target's goal or
auto-accept policy.
Only the server can enqueue this provenance. Enqueue deduplicates the project
and task across all session queues. A scheduled item can omit its model to
keep the target session selection. Normal composer items still require their
captured model. The UI retains both kinds in the same projection.

Scheduled send guards and terminal result callbacks apply only to scheduled
items. A definitive before-send target or task refusal with 404 or 409 removes
that item and lets the next item proceed. This includes removed or retargeted
tasks and moved targets. Other validation errors and all send failures use the
existing queue retry policy, including model-switch 404 or 409 responses.
Successful send reports `sent` without waiting for an assistant reply. Removing,
clearing or evicting a waiting scheduled item reports `cancelled`. Scheduled
items can be reordered and removed, but cannot be taken for editing or manual
send. Bulk take returns only ordinary items and leaves scheduled items queued.
Disable, delete and retarget use `cancelScheduledTask`. Existing composer
persistence, retries, directory query and delivery gates remain unchanged.

## Queue file

`<data-dir>/message-queue.json` (`OPENCHAMBER_DATA_DIR` or
`~/.config/openchamber`): `{ version, revision, sessions: { [sessionId]:
{ directory, items } } }`, written atomically (temp file + rename) through a
serialized write chain. A missing file is an empty queue. A malformed file is
a failure, not an empty queue: it is moved aside as
`message-queue.json.corrupt-<timestamp>` before the runtime starts empty, so
the next write cannot overwrite the user's data. A failed read leaves writes
disabled until a later load succeeds. `revision` is a global monotonic counter
bumped on every mutation; clients use it to reject stale snapshots.

In-memory only, deliberately: the in-flight item (`sendingId`), retry
backoff, and abort timestamps. A restart has no in-flight sends; a
persisted "sending" flag would strand a message forever.

## Delivery loop

1. `start()` subscribes to the global upstream hub and loads the file; on
   load and on every hub `connect` it arms every session that has items.
2. `session.status` for a queued session: `idle` arms a short quiet timer
   (500 ms, coalescing the burst around a turn boundary), `busy`/`retry`
   clears it. A `message.updated` for a completed assistant reply arms as
   well, so a missed idle event cannot strand the queue. `session.deleted`
   drops the session's queue. An aborted idle (`session.idle` with
   `aborted: true`, translated from v2's `session.execution.interrupted`)
   records an abort.
3. `tick(sessionId)` bails when the queue is empty, an item is in flight, or
   the session is held. It re-arms after a 2 s post-abort hold (the UI's
   old behavior: a stop is not immediately followed by the next prompt) or
   while the head item is in retry backoff.
4. Idleness is re-verified against OpenCode before sending, because
   a prompt into a running turn steers into it instead of starting the
   next one: `GET /api/session/active` must not list the session, and the
   trailing message must not be an unfinished assistant reply (that route
   lists only running sessions, so a missed busy event leaves no entry while
   a turn still streams; the shared unwrap hands over the status map, and an
   older `{ data }` envelope is accepted too). The tail is read newest first,
   with the same trailing-message gate the UI uses. An unfinished reply
   created before this runtime started does not block: its run died with the
   previous server and will never complete, so a restored queue would wait on
   it forever. A reply with no `created` time still blocks. A failed fetch is
   unknown, never idle: the tick re-arms with backoff.
   Background work does not hold the head: a parent idle while its
   background subagents or commands run gets the next queued message, the
   same as a message the user sends from the composer then.
5. The head is marked in flight (broadcast), then sent. The captured model and
   agent are switched onto the session first (`POST /session/:id/model`,
   `/agent`), because v2 holds both on the session rather than in the body; a
   captured `openchamber/auto` is resolved into a real pair by the routing
   runtime beforehand. An item queued with `keepSessionModel` skips the model
   switch unless routing resolved one, and one queued with `keepSessionAgent`
   skips the agent switch unless routing chose an agent: its model or agent was
   only what the composer showed, not a pick, so a switch made while it waited
   stands (#7456, #7550). An agent picked before queueing still applies (#5426). The
   session's project knowledge is written into its
   instruction entries (`sessionKnowledgeRuntime.sync`, which never fails the
   send); the response style is left out, because the queued message is the
   user's own and the entry the session already holds stays as it is
   (`../session-knowledge/DOCUMENTATION.md`). Then the captured context goes
   ahead as synthetic messages
   (`POST /session/:id/synthetic` with `resume: false`, an attached item's
   metadata riding along). An item with a `goal` starts it the way a
   scheduled goal does: `createSessionGoal` (`../session-goal/create.js`)
   saves the goal through the injected `persistSessionGoal` before anything is
   admitted, so a failed save leaves nothing for the retry to duplicate, and
   the goal briefing goes as the last synthetic message. Before the goal save
   and the first synthetic message, the item's `syntheticIds` are minted and
   saved, and a revert staged on the session (`revert` on its record) is
   committed (`POST /session/:id/revert/commit`): OpenCode's commit deletes
   everything admitted past the revert's boundary, so committing at the prompt
   would delete the context admitted just before it. An item with nothing to
   admit ahead of its message mints no ids and reads no record; a failed save
   or an unreadable record fails the send. Then the message itself:
   - text starting with `/` that names a command in OpenCode's `/command`
     list (skills included) goes to `POST /session/:id/command` (body fields
     `name` and `text` since OpenCode 2.0.8) with its file attachments. The
     command route takes files only, which is why the context went ahead of
     it; sending "/name args" as a prompt instead would skip the template
     OpenCode expands only on that route. The command lookup runs before
     anything is admitted, so a failed lookup fails the send with nothing in
     the session;
   - otherwise `POST /session/:id/prompt` with the user's text, files and
     agent mention.
   Success removes the item, persists, broadcasts, and calls `onPromptSent`.
   Failure keeps the item, backs off
   2 s → 60 s (doubling per consecutive failure of that item), and re-arms.
   A retry, also after a restart, reuses the `syntheticIds`: OpenCode answers a
   second admission of an id with the first one, so a failure between the
   context and the message leaves each synthetic record in the session once.
   The ids end at the mint time, one millisecond apart, so they sort in
   admission order and ahead of the message, whose id OpenCode assigns.
6. The next item goes out after the next busy → idle cycle.

A 2xx HTML app-shell response is a failed dispatch, not acceptance. The queued item stays persisted and uses the existing retry backoff.

### Why background work does not hold the queue

The queue used to wait for a session's running subagents, treating the
parent's idle as a pause in one turn. Users read the idle parent as free: the
composer sends to it directly at that point, while a message queued a moment
earlier sat until every subagent finished. Delivering on the parent's own idle
keeps both paths the same; OpenCode hands the background result back to the
session whether or not a new turn started meanwhile.

## Held delivery

An auto-review run (`../auto-review`) bounces the reviewed session through
idle between its steps, and a queued follow-up must not land in the middle.
The runtime takes `isDeliveryHeld(sessionId)`, the auto-review runtime's
`holdsDelivery`, and the tick delivers nothing while it is true. The run calls
`release(sessionId)` when it ends, which arms a dispatch. `deliveryHoldReady`
(the auto-review's `startupLoad`) gates the first `reconcileAll` after start:
until the auto-review has loaded its runs every session is held, and a tick
that bailed then has nothing to re-arm it.

## Routes (`/api/message-queue`)

Normal authenticated OpenChamber runtime routes; never on browser URL-token
allowlists.

| Route | Purpose |
|---|---|
| `GET /api/message-queue` | Full snapshot `{ revision, sessions[] }` |
| `POST .../sessions/:id/items` | Append `{ directory, item }`; returns `{ revision, session, itemId }` and arms a dispatch (the session may already be idle) |
| `DELETE .../sessions/:id/items/:itemId` | Remove; `409` while that item is in flight |
| `POST .../sessions/:id/items/:itemId/take` | Remove and return the full item (payloads included); `404`/`409` |
| `POST .../sessions/:id/take` | Remove and return every item not in flight, in order |
| `PUT .../sessions/:id/order` | `{ itemIds }` must be a complete permutation |
| `DELETE .../sessions/:id` | Clear; the in-flight item stays, because its send resolves later and must still find its entry |

Every mutation broadcasts `openchamber:message-queue.updated` with
`{ revision, session }` to all connected clients (SSE and WS), so several
devices on one server see one queue. SSE uses the shared control stream at
`/api/openchamber/events`; `/api/global/event` carries no OpenChamber events.
The UI subscribes independently of its OpenCode transport and re-reads the
snapshot whenever either stream reconnects. The session in that payload always names
its `directory`, including the broadcast that removes the last item: the UI
keys its projection by directory, and a broadcast without one left the
delivered message on screen (a session's directory is remembered until the
session is deleted or evicted).

Limits: 20 items per session, 50 sessions (oldest evicted, never one with an
item in flight), 200k characters of content; attachment payloads are bounded
by the route family's 50 MB JSON limit.

## A session that moves

A queued message belongs to the session, not to the directory it was queued
in. The wire translator's move event is `session.updated` with
`info.projectID`; the runtime rekeys that session's entry to the new directory
and broadcasts before the next idle tick, so the delivery and every client
follow the session. Usage and title updates also carry a directory but no
`projectID`, so an in-flight event from the old location cannot move a queue
back. The UI drops the session's other directory keys when the server speaks
for one directory, so the queued row moves instead of appearing twice.

## UI ownership

`packages/ui/src/stores/messageQueueStore.ts` is the projection: see its
section in `packages/ui/src/stores/DOCUMENTATION.md`. A session in an isolated
space is queued in this module inside that space, not on the host: the host's
runtime sees the host's events only and never delivers into a space. The host
forwards the space's `openchamber:message-queue.updated` changes to the
browsers, see "Sessions and events" in
`packages/web/server/lib/spaces/DOCUMENTATION.md`. VS Code intentionally
does not use this module; with all OpenChamber webviews closed, queued
messages there are not delivered.
