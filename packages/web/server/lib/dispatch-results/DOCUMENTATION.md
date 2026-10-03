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
  `readDispatchOutcome` and `buildDispatchResultMessage`.
- `runtime.test.js` — delivery, waiting on running sessions and subagents,
  archived and deleted parents, a deleted dispatched session, idempotent
  retries, unknown versus idle, restart, a corrupt file.

Wiring: created in `server/index.js` after the message queue, handed to the
control service as `dispatchResults`, stopped by
`opencode/shutdown-runtime.js`. The control service registers an entry after a
dispatch whose prompt landed (`promptDispatched: true`); the calling session
comes from the agent tool (`contextSessionId`).

## Entry and persistence

`{ id, parentSessionId, sessionId, dispatchedAt, messageId? }` in
`<data-dir>/dispatch-results.json`, written atomically through a serialized
write chain, owner-readable only. `register` resolves once the entry is on
disk, so a restart right after the tool answers still delivers. A missing file
is nothing pending; a malformed file is moved aside as
`dispatch-results.json.corrupt-<timestamp>`; a failed read keeps writes off
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
   run ends. The newest one created at or after `dispatchedAt` ends the
   dispatched turn; the answer is the newest assistant reply after the
   dispatch. Created before the dispatch, or no record yet → not over; three
   2 s rechecks cover a record trailing its event, then events take over.
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
- `resume: false` for an archived parent: the answer is recorded, nothing
  runs behind the user's back.
- `id`: minted in OpenCode's `msg_` format at the first attempt and persisted
  before it. OpenCode refuses a second admission of the same id (409), so a
  retry after a crash or a lost response cannot deliver twice; 409 counts as
  delivered. 404 means the parent is gone and the entry is dropped. A deleted
  parent's entries also go on its `session.deleted` event.

## Runtime parity

Web and desktop with a managed OpenCode: active (the agent tool exists only
there). VS Code and external OpenCode: the agent tool is not injected, so no
entry is ever registered. Mobile clients see the delivered message through the
server they are connected to.
