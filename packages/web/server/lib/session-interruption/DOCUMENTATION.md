# Session interruption

## Purpose

Records why OpenCode interrupted a session's last turn, so the UI can tell a
question OpenCode killed from one the user stopped.

OpenCode 2.x evicts a directory's location after 60 minutes without session
events and interrupts every execution there first (`location-activity.ts`,
reason `inactivity`). A `question` waiting for an answer emits no events, so
a question left unanswered for an hour ends with its tool part in `error`.
The UI shows such a question again as answerable (`orphanedQuestions.ts`).
A Stop errors the part the same way, and the reason that tells them apart
lives only on the live `session.execution.interrupted` event: OpenCode
stores `interrupted` and nothing more.

## Files

- `runtime.js` — `createSessionInterruptionRuntime({ persistMetadata, updateMetadata, buildOpenCodeUrl, getOpenCodeAuthHeaders })`,
  fed by the global hub subscriber in `server/index.js`; `recordRestartInterruptions` is called by its `onOpenCodeRestarted`.
- `restart.js` — the restart record patch, `findInterruptedTool`,
  `findOpenAssistantMessageID` and the `opencode-restart-interrupted`
  notification payload.
- `auto-resume.js` — the resume message and the notice's Continue
  (`continueManually`). The server's automatic recovery belongs to
  `../opencode/session-runtime.js`.
- `routes.js` — `POST /api/openchamber/sessions/:sessionId/restart-resume`
  with `{ at, directory? }`: 200 sent, 409 the record changed or was already
  resumed, 502 OpenCode did not take the message.

## State

`metadata.openchamber.interruption`: `{ reason, at, cause, tool }`, written
for every interruption that reaches the hub as `session.idle` with
`aborted: true` (`user`, `superseded`, `inactivity`; `cause` and `tool` are
null there, so the write replaces a restart record whole). `shutdown` never does, because OpenCode
resumes that turn. `at` is the arrival time, so it is at least the session's
`time.idle` for that turn; a later turn moves `time.idle` past it and the
record stops counting. The UI parser is `inactivityInterruptionAt` in
`packages/ui/src/lib/questions/orphanedQuestions.ts`.

## A managed OpenCode restart

A restart of the managed OpenCode kills every running turn with reason
`shutdown`, which the hub drops, so nothing above records it. After the
restart, `session-runtime.js` schedules bounded automatic recovery and returns
`autoResumeSessionIds` beside all interrupted `sessionIds`.
`recordRestartInterruptions({ sessionIds, cause })` writes recovery details for
every interrupted session, including those with automatic recovery pending:

```jsonc
{ "reason": "opencode-restart", "at": 1760649461000,
  "cause": "memory-pressure",          // memory-pressure | health-timeout | process-exited | unknown
  "tool": { "name": "shell", "input": "sleep 600", "callID": "toolu_…" },   // or null
  "resume": null }                     // a cut-off question: { "state": "manual", "reason": "question-pending" }
```

- `cause` comes from the lifecycle (`../opencode/cgroup-memory.js`).
- `tool` is the last tool call of the newest turn whose state is `running`,
  `streaming`, or `error` with `error.type: "aborted"`, read from the 30
  newest message records after the restart. `input` is the first of
  `command`, `filePath`, `path`, `url`, `pattern`, `query`, `description`,
  flattened and cut to 200 characters.
- A cut-off `question` waits for the user's answer, so its record starts as
  `resume: { state: 'manual', reason: 'question-pending' }`. It remains
  answerable until the user responds or dismisses it.
- Each session is read and written on its own (`updateMetadata`, decided at
  write time in the store's queue). A failed read records `tool: null`, a
  failed write is logged, and neither stops the other sessions or the toast.
- The record is cleared when the session runs again, the user sends the next message in the session,
  answers a cut-off question, presses Continue, or dismisses the notice. The
  UI deletes the key through the metadata route
  (`dismissRestartInterruption` in `packages/ui/src/sync/session-actions.ts`),
  Continue on the server once its message is in. While a cut-off question is
  answerable in the form dock, the UI hides the notice and the question card
  shows the time and cause instead. The UI parser is
  `packages/ui/src/lib/sessionRestartInterruption.ts`; the notice is
  `SessionRestartInterruptionRow.tsx` above the composer.
- The toast uses `../opencode/restart-notification.js` for its guidance and
  kind, enriched with this module's multi-session targets. Automatic recovery
  keeps its upstream retry budget and eligibility rules. The toast is also
  kept in the notification center as one `restart` entry whose action lists every chat.
  The center's "Needs you" filter keeps it while any listed chat still has
  this record and its resume is not `sent`.

### The turn the restart cut off

OpenCode leaves the killed turn open, its tool `running`, until the session
runs again. The same write records which message that was:

```jsonc
"restartCutTurn": { "messageID": "msg_…", "at": 1760649461000, "callID": "toolu_…", "toolName": "shell" }
```

`null` when the newest turn had no open assistant message. Dismiss, Continue
and a sent message leave it; the next restart replaces it. The UI finalizes
that message and its running tools as interrupted while it is still the
session's last conversation message (`restartCutTurnToolParts` in
`packages/ui/src/sync/sync-context.tsx`), and keeps its question answerable
(`packages/ui/src/lib/questions/orphanedQuestions.ts`).

### A question waiting for the user

When the cut-off tool is a `question` whose input reads (restart), or an
inactivity eviction errored one (its newest messages are read for that reason
only), the same write records it:

```jsonc
"pendingQuestion": { "messageID": "msg_…", "callID": "toolu_…", "title": "Which color?",
                     "cause": "opencode-restart" | "inactivity", "at": 1760649461000 }
```

`null` otherwise, which also clears an older one. The UI shows the session as
waiting for the user from it (`packages/ui/src/sync/pending-questions.ts`), and
the notification center gets a `question` entry. The UI clears it when the
question is answered or dismissed and with any sent message; this server
clears it when it sees the session run again (`session.status` busy), only for
a record older than that turn and only for sessions it recorded one on.

### Continue

Continue sends a synthetic restart message with `trigger: 'continue'`, then
deletes the record. It claims the record written at that `at` inside the
store's queue unless its resume is already `sent`. A failed send puts the
previous `resume` back.

## Priority sessions

`metadata.openchamber.priority = { at }`: the user marked the session as a
priority (the UI sets it through the metadata route and deletes the key to
clear it; `packages/ui/src/lib/sessionPriority.ts`). An absent key or any
other shape means an ordinary session.

## Automatic recovery

`../opencode/session-runtime.js` owns automatic restart recovery for eligible
sessions, including its retry budget and queue admission. Priority does not
select a second recovery sender. Every interrupted session retains the detailed
cause, tool, cut-off question and Continue action while recovery is pending.
Exhausted automatic retries leave those persisted records available after reload.
A busy status clears the restart notice and pending question through the metadata
store's queue, only when their timestamps are no newer than that status. The
cut-turn marker keeps its existing lifetime. HTTP admission alone does not clear
the details, because the session may still fail to start running.
Each restart registers its session generation before reading history. A busy
status during those reads suppresses the notice and pending question in the
queued write, while retaining the cut-turn marker. Busy during persistence
queues settlement after that write. Both decisions reject superseded generations,
including restarts with equal timestamps, and settled questions are not announced.

Continue's send adapter leases `../session-automation` admission after
restoring both automation owners. A held session retains its manual notice.
The lease spans the SDK call, so a new automation cannot take ownership during
the send.

### Why automatic recovery has one owner

The upstream session runtime already schedules bounded restart continuation.
Running the fork's priority sender as well could send twice or bypass an
exhausted recovery budget. This module persists recovery details independently
of that schedule. Filtering scheduled sessions loses their manual fallback when
all automatic sends fail. A manual continuation's busy status cancels the
automatic timer through the session runtime's existing lifecycle.

The message is a synthetic message with `resume: true`, so the session's own
agent and model answer it, and its metadata
(`{ source: 'openchamber-notice', kind: 'restart-resume', trigger, at, cause, tool }`)
makes the transcript show an OpenChamber row instead of a user message
(`packages/ui/src/lib/opencode/openchamber-resume.ts`). The answer to a
cut-off question travels the same way with `kind: 'question-answer'`, sent by
the UI. The result of a job that finished during the restart is not in the
message yet: that needs the execution queue (stage 2).

## Runtimes

- Web, desktop, hosted and Capacitor mobile: automatic recovery belongs to the
  server's session runtime; manual interruption details are recorded here.
- VS Code: the extension host runs no hub subscriber and owns its own
  OpenCode lifecycle, so nothing is recorded or resumed, and the priority
  mark only lists the session first; a question errored by
  inactivity stays an error there. The notice still renders for a record
  another server wrote, without Continue (the extension has no route to send
  it), and Dismiss works through the metadata bridge. The rows, the
  interrupted turn and an answer to a cut-off question work there too: they
  read session metadata and use only OpenCode's own API.
- A turn interrupted while this server was not running has no record and is
  left as an error.

## Testing

`bunx vitest run server/lib/session-interruption` from `packages/web`. The UI
side: `bun test src/lib/questions src/lib/opencode/openchamber-resume.test.ts
src/sync/interrupted-turn-recovery.test.ts src/components/chat/SessionRestartInterruptionRow.test.tsx`
from `packages/ui`.
