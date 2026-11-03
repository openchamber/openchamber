# Dispatch Results

## Purpose

Delivers the result of a session an agent dispatched with `returnResult` back
into the session that dispatched it, and wakes that session. The agent's
`session.create`, `session.send` or `session.fork` call returns at once; when
the dispatched session's turn ends, its final answer arrives as a synthetic
message and the agent continues on its own. This is OpenCode 2's background
subagent report (core `session/subagent-completion.ts`) for primary sessions
the user can also follow and talk to.

It replaces the agent tool's blocking `wait`: a blocked tool call held the
agent's whole turn open for up to ten minutes. The CLI keeps `--wait`, since a
terminal has no session to deliver into.

## Files

- `runtime.js` — `createDispatchResultsRuntime(...)`: pending entries,
  persistence, the delivery loop, event handling; plus the pure
  `readDispatchOutcome` and `buildDispatchResultMessage`. Workflow runs
  (`../workflows`) reuse `readDispatchOutcome` to tell when an agent's turn
  ended, and `createMessageId` and `escapeAttribute` for their report.
  Auto-review (`../auto-review`) reads each step's end with
  `readDispatchOutcome(..., { withText: true })`, which takes the text from
  the newest reply of the turn that has any, and mints its ids with
  `createMessageId`.
- `runtime.test.js` — delivery, waiting on running sessions and subagents,
  archived and deleted parents, a deleted dispatched session, idempotent
  retries, one result for several sends into one run, unknown versus idle,
  restart, a corrupt file.

Wiring: created in `server/index.js` after the message queue, handed to the
control service as `dispatchResults`, stopped by
`opencode/shutdown-runtime.js`. The control service registers an entry after a
dispatch whose prompt landed (`promptDispatched: true`); the calling session
comes from the agent tool (`contextSessionId`).

## Entry and persistence

`{ id, parentSessionId, sessionId, dispatchedAt, afterIdleId?, messageId? }` in
`<data-dir>/dispatch-results.json`, written atomically through a serialized
write chain, owner-readable only. `register` resolves once the entry is on
disk, so a restart right after the tool answers still delivers; when the write
fails it rejects and drops the entry, and the tool tells the agent no result is
coming. A failed write leaves the chain running for the next one. A missing file
is nothing pending; a file that is not JSON or has no `entries` array is moved
aside as `dispatch-results.json.corrupt-<timestamp>`; a failed read keeps writes off
until a load succeeds; one malformed entry is dropped alone. At most 200
entries, oldest dropped with a warning.

Timers, retry counts and the in-flight guard are memory only: after a restart
`start()` re-arms every watched session from a fresh tick.

## When the turn is over

Event-driven like `../message-queue`: `session.status` idle for a watched
session arms a 500 ms quiet timer, busy clears it, a hub reconnect and startup
re-arm everything. `register` arms once too, because a short turn can end
before its entry exists. The tick then asks OpenCode, and unknown is never
"over":

1. `/api/session/active` lists it → running; its next idle event re-arms.
2. A subagent of it runs → not over: the session runs again on the subagent's
   result. Rechecked after 5 s (`../opencode/session-activity.js`).
3. The newest page of its records (`order: desc`, 50): OpenCode appends an
   `idle` record with `outcome` (`succeeded`, `failed`, `interrupted`) when a
   run ends. The dispatch route reads the newest one before the prompt goes
   out (`afterIdleId`, null when the session has none); a newer idle record
   ends the dispatched turn, and the answer is the newest assistant reply
   between the two. Matching by record order keeps OpenChamber's clock out of
   it, so a remote OpenCode whose clock lags still matches; only an entry
   stored without the baseline compares `time.created` with `dispatchedAt`.
   No newer record yet → not over; three 2 s rechecks cover a record trailing
   its event, then events take over. A `session.send` into a session that is
   already running can end on that running turn when OpenCode steers the
   prompt into it; that turn's answer then includes the prompt's work.
4. The session itself answers 404 → it was deleted; reported as stopped.

A failed read retries with backoff (2 s doubling to 60 s).

## Delivery

`POST /api/session/:parent/synthetic` with
`{ id, text, description, metadata, delivery: 'steer', resume }`:

- `text`: `<openchamber-session sessionID="…" state="…" title="…">answer</openchamber-session>`,
  the answer cut at 50 000 characters with a pointer to `session.messages`.
  A failure or stop says so ("The session failed: …", "stopped before it
  finished") and keeps any last reply; an empty completed answer says it had
  no text, never silence.
- `metadata`: `{ source: 'openchamber-session', sessionID, state, title? }`,
  `state` one of `completed`, `error`, `cancelled`. The UI reads it in
  `packages/ui/src/lib/opencode/dispatched-session.ts` and renders a compact
  "Session finished: <title>" row that opens to the answer.
- `delivery: 'steer'`: a parent that is busy reads it at its next step, the
  way OpenCode delivers a subagent report; an idle one is woken by `resume`.
  A parent waiting on a page or a secret card reads it right after the user's
  answer, and the chat shows the row only then (`../openchamber-control/`,
  *Why a background message waits behind a page*).
- `resume: false` for an archived parent: the answer is recorded, nothing
  runs behind the user's back. A failed archive lookup counts as not archived
  and wakes the parent: the agent asked for this result.
- `id`: minted in OpenCode's `msg_` format at the first attempt and persisted
  before it; when that write fails the attempt waits for the next retry. OpenCode refuses a second admission of the same id (409), so a
  retry after a crash or a lost response cannot deliver twice; 409 counts as
  delivered. 404 means the parent is gone and the entry is dropped. A deleted
  parent's entries also go on its `session.deleted` event.

## One result per run and parent

Every entry ready in a tick reads the same newest run, so entries of one
parent that are still without an id share one minted id and one delivery,
then all go. A parent that sends several prompts into a running session hears
back once, with the run that took them all. Another parent watching the same
session gets its own result. An entry that already holds an id from an earlier
attempt keeps it and delivers alone.

### Why one shared result and not one receipt per send

The prompts steer into one run, which produces one answer; a receipt per send
put the same answer into the parent's context once per prompt (eight times in
#6109).

### Why an entry with an id is never grouped

Its id may already have landed with an earlier run whose response was lost.
Grouping a newer entry under that id would make OpenCode answer 409 for the
newer run, and its result would be dropped as delivered.

## Runtime parity

Web and desktop with a managed OpenCode: active (the agent tool exists only
there). VS Code and external OpenCode: the agent tool is not injected, so no
entry is ever registered. Mobile clients see the delivered message through the
server they are connected to.
