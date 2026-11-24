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

- `runtime.ts` — `createDispatchResultsRuntime(...)`: pending entries,
  persistence, the delivery loop, event handling; plus the pure
  `readDispatchOutcome` and `buildDispatchResultMessage`. The runtime returns
  `pending()` (entries oldest first) and `flush()` (the queued write) for tests
  and diagnostics. Workflow runs
  (`../workflows`) reuse `readDispatchOutcome` to tell when an agent's turn
  ended, and `createMessageId` and `escapeAttribute` for their report.
  Auto-review (`../auto-review`) reads each step's end with
  `readDispatchOutcome(..., { withText: true })`, which takes the text from
  the newest reply of the turn that has any, and mints its ids with
  `createMessageId`.
- `runtime.test.js` — delivery, waiting on running sessions, not waiting on
  their children,
  archived and deleted parents, a deleted dispatched session, idempotent
  retries, one result for several sends into one run, unknown versus idle,
  restart, a corrupt file.

Wiring: created in `server/index.js` after the message queue, handed to the
control service as `dispatchResults`, stopped by
`server-frame/shutdown-runtime.js`. The control service registers an entry after a
dispatch whose prompt landed (`promptDispatched: true`); the calling session
comes from the agent tool (`contextSessionId`).

## Invariants

- Raw JSON from the results file, from OpenCode and from hub events is parsed
  only through the boundary schemas at the top of `runtime.ts`; the rest of the
  module branches on what those schemas return.
- Public entry, registration, outcome, message and dependency types belong to
  `runtime.ts`. Entry types derive from the persistence schema, including its
  optional and nullable fields. Relative imports retain `.js` specifiers.

### Why requests receive a response schema

Each HTTP read parses its response before returning it to the delivery loop.
Synthetic delivery ignores the response body, so its schema accepts any value
and discards it; HTTP failures still determine retry and acknowledgement.

### Why exception properties use guards

File reads, JSON parsing and injected requests can throw arbitrary values.
The guards preserve property reads on objects and functions, including inherited
properties, and retain the existing nullish fallback when a message is absent.

### Why hub events are checked before processing

The unconverted hub can translate unrelated events. Its callback narrows payloads
through the dispatch event schemas before passing them to the typed handler.
The public `processPayload` entry also retains validation for JavaScript callers.
The activity probe's unconverted signature infers `signal` as required despite
its optional runtime behavior; passing `undefined` preserves the existing timeout.

## Entry and persistence

`{ id, parentSessionId, sessionId, dispatchedAt, afterIdleId?, messageId?, follow?, targetIdleId? }` in
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
before its entry exists. An idle event that lands while a tick is reading
re-arms that session: the tick may have seen the session busy a moment earlier,
and the event would otherwise be lost. The tick then asks OpenCode, and unknown
is never "over": a failed status read, a message page that does not parse, and
a malformed record all leave the entry waiting.

1. `/api/session/active` lists it → running; its next idle event re-arms.
2. The newest page of its records (`order: desc`, 50): OpenCode appends an
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
3. The session itself answers 404 → it was deleted; reported as stopped.

A failed read retries with backoff (2 s doubling to 60 s).

### Why the tick waits for a quiet period

Idle events arrive in bursts around a turn boundary. A tick on each event asks
OpenCode several times about the same boundary, and the first tick can still see
the session busy. One 500 ms quiet timer per session collapses the burst into a
single confirmation.

### Why an idle session's answer goes out while its children still run

Subagents in OpenCode 2 run in the background, as do workflow agents and
sessions started with `ownWork`: the session answers and goes idle while they
work, and their results arrive later as messages that start a new turn.
Waiting on them, as `hasWorkingChildren` does for goals and notifications,
kept a question to an orchestrating session from coming back for hours while
its workflow ran, though the session had answered in 36 seconds.

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
  and wakes the parent: the agent asked for this result. The lookup is awaited
  before that decision; `isSessionArchived` returns a Promise, and a Promise
  read as a value is truthy, which would record every answer without waking
  anyone.
- `id`: minted in OpenCode's `msg_` format at the first attempt and persisted
  before it; when that write fails the minted ids are dropped from memory and
  the attempt waits for the next retry, because an unsaved id would be minted
  again after a crash and the same run could arrive twice. OpenCode refuses a
  second admission of the same id (409), so a
  retry after a crash or a lost response cannot deliver twice; 409 counts as
  delivered. 404 means the parent is gone and the entry is dropped. A deleted
  parent's entries also go on its `session.deleted` event.

## Sessions a parent runs keep reporting

A session that is the parent's `operator-child` (created with `ownWork`, or
handed to a lead) reports every turn it ends, not only the one after a
prompt: a turn its own subagents' reports, a wait or a pull request event
started reaches the parent the same way. Every tick reads the session's
record first, running or not; while its link names the entry's parent and it
is not archived, the entry is marked `follow`, so a session taken over or
archived before its first turn ended is already known as followed. One
follower per parent and session carries the cursor (`afterIdleId`); other
entries of the pair fold into it. The tick delivers every turn that ended
after the cursor: turns that ended before one read go out together in one
message, each with its own body, so a failed turn still says it failed. Before posting, the follower persists the minted `messageId` with the
idle record it covers (`targetIdleId`); a retry after a crash resends exactly
those turns under that id, so OpenCode's 409 acknowledges them, and newer
turns follow under a new id in the same tick. When the link goes (the user
took the session over) or the session is archived, the follower is dropped
without sending what came after; a parent that answers 404 drops it too; a
deleted session still reports that it stopped. A session record that does
not parse is a failed read and retries, never a lost link. A hand-over
registers the session whether or not it is running, without a baseline when
the last idle record could not be read (then the time taken before the hand-over
began is the baseline). Over 200 entries, one-answer entries, the new one
included, are evicted before followers; a registration that does not survive
that is refused and the tool says no result is coming. An entry stored before
`targetIdleId` existed settles its delivery and keeps following from the newest
idle record. A session the parent only sent a prompt to, one
the user talks to, keeps the one-answer entry.

### Why every turn and not only the answer to a prompt

A dispatched session that starts background subagents answers "started the
reviews", goes idle, and gives its real answer in a later turn their reports
start. With one entry per prompt that answer reached nobody. OpenCode 2.3
reports every turn of its own `parentID` children to the parent for the same
reason.

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

### Why a group's text can come from any entry in it

An entry stored without `afterIdleId` compares `time.created` with
`dispatchedAt`, so its turn can miss a reply that began before its send while
another entry of the same run holds it. The delivery uses the outcome in the
group that has text, and the newest outcome otherwise.

## Runtime parity

Web and desktop with a managed OpenCode: active (the agent tool exists only
there). VS Code and external OpenCode: the agent tool is not injected, so no
entry is ever registered. Mobile clients see the delivered message through the
server they are connected to.
