# Session Goal

Server-side control loop that keeps a session working toward a user-defined
objective stored under `metadata.openchamber.goal`, with Jev (the
classification model) or the small model as an independent progress check. Built on OpenChamber's backend-driven
architecture (session-assist is the structural template): the loop lives in
the web server and survives UI disconnects.

## Ownership

This module owns objective storage, goal creation, objective routes and the
server-side progress loop. OpenChamber's session metadata store owns persistence
and calls `notifyGoalChanged` after saving a goal. OpenCode owns session execution;
the UI owns arming goals and presenting their state.

## Invariants

- Goal writes re-read OpenChamber's metadata and check the logical goal id so a
  replacement or clear during a tick drops the stale write. Metadata updates
  preserve neighbouring feature payloads.
- Objective storage validates session ids before filesystem access. Metadata
  contains a flag, never a caller-supplied path, so it cannot select arbitrary files.
- A file-backed objective is read on every tick to support live edits. An
  unreadable file uses inline text when available; without either, the tick
  sends no continuation with an empty objective.
- Synthetic messages count as user-shaped pending work for quiescence, but
  completion notices do not start a new round for background-command waiting.
- Audits select the newest non-summary assistant's execution information.
  A compaction's summarization model and agent must not become the checker input.
- Consecutive truncation checks use completed, non-summary assistant turns and
  creation timestamps, with array position breaking ties. Unknown timestamps
  are excluded so unrelated messages cannot hide known chronology.
- Checker provider and model are written together. Jev clears the provider so
  the UI cannot pair its model with a previous small-model provider.
- Background audit content stays on the session's provider unless the user
  explicitly selects a small model. Passing the preferred provider preserves
  that boundary; configuring a classifier for another feature is not goal consent.
- The job list is read again after the message tail so work started by that
  turn, including subagent shells and images, holds the audit before it nudges
  the agent over running work.
- A wakeup received during an in-flight tick remains pending until that tick
  ends. Mid-goal edits leave its pending read intact, and an abort lets an
  in-flight tick reach its own pause check, so cancellation cannot strand a goal.

## Goal payload (`metadata.openchamber.goal`)

```
{
  id,                      // opaque per-logical-goal id; stale-write guard
  objective,               // inline user text (fallback), <= 5000 chars
  objectiveFile,           // true: objective text lives in a server-side file
  status,                  // active | paused | blocked | budgetLimited | complete
  tokenBudget,             // optional positive int
  tokensUsed,              // tokensCommitted + current segment (snapshot - baseline)
  tokensBaseline,          // segment start snapshot (pre-goal turn; 0 after compaction)
  tokensCommitted,         // closed segments' total (one segment per compaction)
  turnsUsed,               // auto-continuations sent (capped at the Settings turn limit)
  auditFailStreak,         // consecutive progress checks that could not run
  statusReason,            // why settled; 'resumed' is a kickoff signal from UI
  evaluationProviderID,    // provider of the latest check; '' when Jev answered
  evaluationModelID,       // model of the latest check (Jev's model id for Jev)
  lastAccountedMessageID,  // incremental accounting cursor
  createdAt, updatedAt
}
```

The UI writes goals (create/edit/pause/resume/clear) by patching this
metadata; the runtime never creates a goal on its own. Goal creation happens
at send time via the arm store (`useSessionGoalArmStore`): the composer
target button arms "the next prompt is the objective", and the run-as-goal
flows (fork-from-answer dialog, plan implement dialog) arm the same way —
the plan flow additionally supplies an objective OVERRIDE carrying the plan
content, since "Implement this plan: X" alone gives the audit nothing to
judge against. Queueing a message consumes the arm too: the goal travels on
that queued item (`goal` in `../message-queue`) and starts when that item is
delivered, by the server queue or by a send from the queue row, and a queued
item without a goal never consumes the composer's arm. The armed send also attaches a synthetic system-reminder
part telling the agent goal mode is active and that each turn should end
with a factual done/verified/remaining statement for the independent audit.
Freshness/stale-write protection is by `id`: every runtime write re-reads the
session and drops the write when the stored goal id no longer matches.

## File-backed objectives

The objective TEXT lives in `<data-dir>/goals/<sessionId>.md` (data dir =
`OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`), keyed by the SESSION ID:
sessions are globally unique and carry one goal at a time, so the mapping is
deterministic and a new goal simply overwrites the file. Metadata carries
only `objectiveFile: true` — never a path — so user-writable metadata cannot
become a file-read vector (`objectives.js` also validates the id shape
before touching the filesystem). Rationale: metadata rides every
`session.updated`, so multi-KB objectives must not live there.

- `objectives.js` — write/read/delete, 5000-char clamp.
- `routes.js` — `PUT/GET/DELETE /api/goals/objective/:sessionId`
  (OpenChamber-owned, registered before the generic proxy; JSON parsing via
  the `/api/goals` family in core-routes). The UI writes the file BEFORE
  patching the goal metadata and falls back to an inline objective when the
  write fails; `clearSessionGoal` deletes the file best-effort.
- The tick resolves the effective objective fresh on every cycle (the file
  is live-editable mid-goal) and falls back to the inline `objective` when
  the file is unreadable — a goal never dies because a file went away.
- UI display fetches content via the GET route
  (`useGoalObjectiveContent`); in VS Code the route is unavailable, so the
  strip shows a generic goal title (display-only fallback by design).
- Server-created goals write the file through `create.js`, which also owns
  objective fitting, inline fallback, metadata creation, and the synthetic
  first-turn reminder shared by scheduled tasks and CLI-created sessions.

- Forks: OpenCode copies the source metadata into a fork, goal included.
  The UI fork paths (`forkAfterMessage`, `forkFromMessage`, `/fork`) then copy
  the objective file to the fork's id, or inline the text when that write
  fails (`packages/ui/src/lib/sessionForkInheritance.ts`). The copy re-reads
  the fork's goal id first and is skipped when the user armed a new goal on
  the fork meanwhile. Forks made through `POST /api/openchamber/sessions/:id/fork`
  (CLI, scheduled tasks) get the same repair server-side before the prompt is
  dispatched (`openchamber-sessions/fork-inheritance.js`); UI forks call
  OpenCode directly, so both implementations exist. `/btw` forks drop the goal
  with the rest of the inherited namespace.

## Flow

1. `createSessionGoalRuntime` subscribes to the global SSE hub (same pattern
   as session-assist — it needs the envelope's `directory`).
2. `session.status: idle` arms a 3s per-session timer; `busy`/`retry` clears
   it. The window only lets a burst of status events settle: every check
   after it reads live state. Rechecks while work goes on without the parent,
   and retries after a failed read, wait 15s instead. A `session.updated` carrying a fresh active goal (`turnsUsed === 0` or
   `statusReason === 'resumed'`) arms a kickoff timer — 3s for fresh goals,
   ~250ms for an explicit Resume so the nudge feels immediate — since setting
   a goal on an idle session emits no status transition.
3. On fire (`tick`), gated by the `sessionGoalEnabled` setting:
   - fetch session (skip sub-agent sessions and workflow agents; a session an
     agent runs for its own work, `ownWork`, keeps its goal), require an
     `active` goal.
     A failed session read skips the audit and continuation. It retries after
     15, 30, then 60 seconds. After another failure, it re-reads goal metadata
     and settles a still-active goal as `blocked` with a reason and the usual
     settlement notification. A successful session read resets the counter.
     Updates for paused, cleared or settled goals and fresh or resumed active
     goals cancel the old retry window, as do session status events and a user
     abort with no tick in flight. A mid-goal edit leaves the counter, the
     armed retry timer and an in-flight read alone, since that tick is the
     goal's only pending work; an abort during an in-flight read lets the tick
     reach its own abort check and pause the goal;
   - authoritative live-activity check after the quiet window: re-read
     `/api/session/active`, bail if the parent resumed; then read OpenCode's
      job list (2.2.6+) for the whole subagent tree and bail while a
       background subagent or image runs; then read active sessions' parent
       links and bail while a direct child is active, since child sessions OpenChamber starts
      itself (workflow agents) are no OpenCode jobs and an older OpenCode has
      no job list. The loop rechecks after
      another quiet window so a missed parent idle event cannot strand the
       goal when the child finishes. Historical children are never paged.
       Unknown status, child, job or shell activity skips the audit and
       continuation and retries after 15, 30, then 60 seconds. A fourth failure
       blocks the goal with a resumable reason. Confirmed running work or a
       complete activity check resets this separate activity-failure counter;
      these reads live in `../opencode/session-activity.js`, shared with the
     notification runtime;
   - messages come from `/api/session/:id/message` as v2's flat records
     (`type`, `content[]`, `model`, `finish`, `tokens`); `toLoopMessage`
     projects them into the `{ info, parts }` view the rest of the tick reads,
     and a completed `compaction` record plays v1's `summary: true` assistant
     turn. v2 gives a compaction only `time.created`, so the projection
     stamps `time.completed` from it: every "finished" check in the tick reads
     `time.completed`, and without it a compaction looks still running. Other
     plumbing roles are dropped from the view;
   - quiescence check via the message tail (trailing user message or
     unfinished assistant reply → bail; the next idle transition re-arms);
   - background commands: the shells in the job list, read again after the
     messages so a command of the turn just read is listed; it includes the
     commands the session's subagents started. An OpenCode without the job
     list is asked `shell.list` for the session's directory (the header-scoped
     read in `../opencode/session-activity.js`; that location is already
     running), which sees only the session's own commands. A command started
     in this round, at or
     after its newest non-synthetic user message (the goal's start when none
     is in the window), holds the audit: OpenCode wakes the session with the
     result, and auditing earlier reads "waiting for the tests" as unfinished
     and nudges the agent over a running command. Commands from earlier rounds,
     such as a dev server, are not waited for. The goal instructions tell the
     agent to stop every command that does not finish on its own before ending
     a turn, since the wait cannot tell a server from tests. After 30 minutes
     the turn is audited as it stands: a command running that long is most
     likely a server left running. Resume, and a turn that ended in an error or
     abort, do not wait. An unreadable list is unknown and rechecks;
   - token accounting as a SNAPSHOT of the latest completed assistant turn:
     `input + cache.read + output`. Earlier turns' inputs and outputs fold
     into the next turn's cache, so the latest snapshot already carries the
     whole run's paid tokens — no summing across messages. Goal-relative via
     `tokensBaseline` (the same snapshot of the newest pre-goal turn,
     captured on the first tick). Compaction (an assistant message with
     `summary: true`) breaks the snapshot chain, so accounting is segmented:
     the summary message closes the segment into `tokensCommitted` from the
     latest known pre-summary snapshot, with previously displayed usage as a
     continuity floor. OpenCode reports the summary's own tokens as zero, so
     the summarization call is uncounted. The next segment starts with a zero
     baseline.
     `tokensUsed = tokensCommitted + current segment`, kept monotonic so
     unflagged context shrinks never move the budget backwards;
   - a user abort pauses the goal instead of blocking it: the event path in
     `processPayload` pauses immediately on the MessageAbortedError message
     (before any tick could send a continuation over the user's explicit
     stop), with a tick-side safety net. Messages sent while paused leave
     the goal alone; Resume re-arms the loop, and resuming over an aborted
     tail skips the audit and goes straight to a continuation nudge;
    - terminal checks, cheapest first: assistant turn error → `blocked`;
      `tokensUsed >= tokenBudget` → `budgetLimited`;
      `turnsUsed >= ` the turn limit (Settings → Goal, `sessionGoalMaxAutoTurns`, 1–200, default 20; read on every tick) → `blocked`;
    - error classification is independent of `finish`: `MessageAbortedError`
      keeps the pause/resume behavior; only a `finish: "length"` with no
      error, or `MessageOutputLengthError`, is an in-progress truncation that
      skips the audit and continues. Any other non-null error wins over a
      length finish and blocks with its non-empty `error.name`, or
      `assistant turn failed` when unnamed;
    - length recovery is bounded separately from the token budget and
      auto-continuation cap: the first truncation permits one continuation, but
      a second consecutive completed, non-summary assistant turn that is also
      truncated settles the goal as `blocked` (`repeated output truncation`).
      The consecutive state is derived from the loaded message history, not
      persisted, using `info.time.created` chronology rather than message IDs.
      Summary messages are not agent turns; an ordinary completed assistant
      turn naturally breaks the consecutive condition. Explicit Resume grants
      one new recovery attempt over the same transcript; the continuation
      consumes that permission, so another truncation blocks again. Resume
      does not bypass assistant errors or the token budget;
   - otherwise, a progress check of the objective + the last assistant turn
     only — no conversation history and no continuation prompts (`audit.js`).
     Three yes/no questions: does the report say all requested work is done
     (`all_done`), does it name requested work the agent still has to do
     (`remaining`), and is the agent stopped by something only the user can
     provide (`needs_user`). `decideProgress` combines them in code:
     `needs_user >= 0.5` → blocked, `all_done >= 0.5 && remaining < 0.5` →
     complete, anything else → continue. Jev answers with probabilities; the
     small model answers the same questions as JSON booleans read as 1/0, so
     there is one format and one decision. The long turn is cut to its head
     and, mostly, its tail, where the report sits.
     Who answers: Jev when `sessionGoalChecker` is `classifier` (an explicit
     pick; the default is `small-model`, since a classification provider set
     up for another feature is not consent to audit goals with Jev) and a
     classification provider can run it (`classifierEndpoint`, owned by
     `../routing`); the small model otherwise, and also when Jev fails this
     time (the session's own provider/model
     preferred). The check is the SOLE termination authority besides the hard
     stops above — the working agent has no channel to settle its own goal.
     `complete` and `blocked` settle on the first such answer: a blocked turn
     waits on the user, and another nudge would only spend a turn repeating the
     question (`statusReason: 'waiting for user input'`). There is no note: the
     strip shows the objective. A check that cannot run tolerates ONE
     consecutive unchecked continuation (`auditFailStreak`); a second
     consecutive failure settles the goal as `blocked` ("progress audit
     unavailable") — resumable, and settling resets the streak so Resume gets
     fresh tolerance. A dead checker can never drive the loop blind to the turn
     cap. Measured on 144 hand-written goal-report turns plus 8 real ones (a
     private lab outside this repository): Jev 142/144 with both
     misses on the safe side, gpt-6-luna 141/144. Change the questions or the
     threshold only with a new run of that lab. A small, narrow wording change
     to a criterion in `audit.js` needs only a few targeted cases on Jev and
     the small model;
   - continue: persist accounting + `turnsUsed` first (a crash after the
     write just waits for the next idle tick; the reverse could double-send),
     re-check the tail, then `POST /api/session/:id/prompt` with the
     continuation prompt. v2 keeps the model and agent on the session, so the
     prompt runs on what the session already uses; nothing is re-selected —
     the goal spends the session's own subscription.
4. Settling (`complete`/`blocked`/`budgetLimited`) fires the injected
   `emitGoalNotification` so the user hears about it even with the UI closed:
   desktop + UI broadcast + the standard push fanout (web-push with full
   text; APNs with a generic per-type title and the session name as body).
   It obeys the notify-on-completion setting. Conversely, while a goal is
   ACTIVE the notifications runtime suppresses per-turn "ready"
   notifications on every channel — they would only echo the loop's own
   continuations; error/question/permission notifications are untouched.
   Pausing a goal from the UI also aborts the running turn (and vice versa —
   an abort pauses the goal), so "stop" means stop on both axes.

## Continuation prompt

Built inline in `runtime.js`: the objective as untrusted user data in an
XML-escaped `<objective>` block, budget numbers,
`GOAL_MISSION_INSTRUCTIONS` (`audit.js`), keep-the-full-objective and
work-from-evidence rules, a completion-audit instruction, and
`GOAL_REPORT_INSTRUCTIONS` (`audit.js`): the final message ends the run, stop
background commands that never finish before it, and close it with four
lines, Done, Verified, Remaining and Needs from the user, each with "nothing"
said out loud. The audit sees only that final turn, so the report is its
evidence; Remaining and Needs from the user answer the `remaining` and
`needs_user` questions directly, and user-side steps (testing in the app,
review, commits) are named as neither. The first-turn reminder (`create.js`
and the UI's `sessionGoalActions.ts`) carries the same mission and report text.

### Why the prompts never mention the loop continuing the agent

The agent is sent on the whole objective in one run. A promise that the system
will prompt it to continue, per-turn reporting and a count of auto-continuations
all read as permission to stop after one step and hand back a list of what is
left. The continuation stays as the safety net, unannounced. The four report
lines keep their shape because the progress check reads them.

## Recovery after connecting

The loop is event-driven, so an idle event lost while the server or the event
stream was down leaves an active goal without a timer. On every connect of
the global event hub, `recoverActiveGoals` lists the 50 most recently updated
root sessions (`GET /api/session`, global, starts no location) and arms a
kickoff for each one whose goal is active and has no timer or tick. The tick
re-reads the goal from the store and checks the session is idle, so a busy
session or a settled goal costs one read.

## UI consumers (packages/ui)

- `lib/sessionGoalMetadata.ts` — payload parsing/types.
- `lib/sessionGoalActions.ts` — create/edit/pause/resume/clear via
  `patchSessionMetadata`; `lib/sessionGoalPresentation.ts` — status
  colors/labels shared across surfaces.
- `stores/useSessionGoalArmStore.ts` — the "next prompt starts a goal" flag,
  consumed by `sendMessage` in `sync/session-ui-store.ts` (works for drafts).
  A parallel launch reads it too and gives every lane its own goal
  (`lib/multirun/DOCUMENTATION.md`).
  Armed slash commands resolve their authoritative command template and apply
  OpenCode argument expansion (`$ARGUMENTS`, positional placeholders, or the
  implicit argument suffix) for the audit objective before goal metadata is
  written and before `session.command` dispatch. If command details cannot be
  loaded, the raw invocation remains the objective rather than blocking command
  execution.
- `hooks/useSessionGoal.ts` — live goal state.
- `components/chat/SessionGoalButton.tsx` — composer target button
  (arm / status color / cancel confirm); `SessionGoalRow.tsx` — goal row
  among the composer's top rows; `SessionGoalDialog.tsx` — manage dialog
  (edit/pause/resume/complete/clear).
- Sidebar glyph next to the date in `SessionNodeItem`.
- `components/sections/openchamber/SessionGoalCheckerField.tsx` — Settings →
  Chat → Goal: Jev or the small model checks progress
  (`sessionGoalChecker`). Without a classification provider the Jev chip is
  disabled and the small model shows as chosen, matching the server.
  `useGoalCheckAvailable` (`hooks/useSessionGoal.ts`) gates arming a new goal
  on either checker being able to run.

## Scheduled goals

Scheduled tasks can run as goals: `execution.goalEnabled` (+ optional
`execution.goalTokenBudget`) on a task makes the scheduled-tasks runtime
write the goal into OpenChamber's session metadata store through the
`persistSessionGoal` seam `server/index.js` hands it (objective = the expanded
task prompt; v2 `CommandInfo` carries no template, so a slash command's
objective is its raw invocation) and attach the goal-mode intro part to normal
prompts. The store write is what arms the loop (`notifyGoalChanged`).

## CLI-created goals

`openchamber session create --prompt <text> --goal` uses the explicit
`POST /api/openchamber/sessions` orchestration route. The server creates the
session, fits and stores the expanded prompt as its objective, patches active
goal metadata, appends the synthetic goal reminder, and only then dispatches
the prompt. `--goal-token-budget` applies the same optional budget contract as
scheduled goals. Slash commands retain command dispatch semantics and cannot
carry the synthetic prompt part. Their command template with OpenCode argument
expansion becomes the audit objective; goal metadata
is still installed before the command runs. A missing command template falls
back to the raw invocation.

`openchamber session send --goal` and `openchamber session fork --goal` use
the same server-owned prompt orchestration. Send installs a fresh goal on the
target session; fork first uses the official OpenCode fork operation (at the
optional message boundary), then installs the goal on the new session. Both
preserve the objective-file-before-metadata and metadata-before-dispatch
ordering used by create and scheduled goals.

## Limitations

- If goal metadata cannot be read or saved at retry exhaustion, settlement
  cannot be persisted or notified. The tick logs the failure and stops until
  another event or Resume arms it.

- Web-server feature: VS Code (extension-only) renders goal state via
  `session.updated` but does not run the loop.
- A goal on a session with no assistant reply yet starts after the first
  user exchange completes (there is no reply to audit before that).
- `tokensUsed` only counts completed assistant messages seen within the
  40-message fetch window per tick; extremely long busy stretches between
  idles undercount (acceptable: budget is a guardrail, not billing).

## Decisions

### Why objective content includes JSON values

The HTTP route passes JSON `content` through to objective storage. Storage keeps
the existing `String(content ?? '')` coercion, including numbers, booleans,
arrays and objects, before trimming and clamping. Session-id validation runs
before content coercion or filesystem access. The key guard also rejects
non-string values received from JavaScript callers.

### Why creation preserves unchecked objectives and warning causes

Creation coerces its objective with `String(objective ?? '')` before fitting it.
Warning causes retain arbitrary thrown values and the existing `message || cause`
logging fallback. The persistence callback's return value is ignored, but its
completion is awaited before the goal is returned. Small-model generation owns
the string contract for distilled text and accepts the existing `sessionID` and
omitted options.

### Why the loop remains JavaScript

`runtime.js:getErrorName` calls `error?.name?.trim?.()` without checking the name
or the method's result. A callable `trim` can return an arbitrary value; declaring
a string result would promise more than the code checks. A predicate exposing
`trim?: () => unknown` is rejected by
`tools/oxlint/anti-slop/rules/no-unknown-returns.ts:noUnknownReturnsRule`.
A temporary conversion probe reproduces that diagnostic. The same probe rejects
an unknown error-parser parameter through `noUnknownParametersRule` and its
non-predicate `typeof` checks through `noRuntimeTypeofRule`.

Changing a server owner's declared type, exporting a type, converting a small
helper or augmenting a dependency cannot change these lint-policy boundaries.
The loop stays whole in JavaScript to preserve the optional call, its unchecked
return and its existing failures without casts or a replacement contract.

### Why objective routes use the shared HTTP contract

The route registrar needs only three registration methods, session-id parameters,
JSON request bodies and JSON responses. These types come from
`../shared/http-contracts.js`. JSON object bodies supply `content`; primitive and array
bodies supply no content, matching property access on parsed JSON. Error fields
remain unknown because caught values do not guarantee a status code or message
type; status coercion and the original message fallback remain at the boundary.

### Why quiet windows still require live checks and not elapsed-time assumptions

Quiet windows coalesce status bursts and duplicate updates; they provide no
race guarantee. Resume uses a short delay because live activity and tail checks
still prevent a continuation over a busy session.

### Why bounded shell waiting and not indefinite waiting

A round waits for its background commands because their results wake the session
and an early audit can prompt over unfinished work. A command still running after
30 minutes is likely a server, so the loop audits the turn as it stands; goal
instructions require stopping commands that never finish before each final report.

### Why accounting persists before prompting and not after

The accounting write precedes the prompt so a failed prompt leaves a saved turn
count and waits for another idle tick. Reversing the order can double-charge a
turn. A fresh tail read after the audit drops a continuation if the user sends
another message meanwhile.

### Why failed session and activity reads retry before blocking

Session and activity reads retry so a transient transport failure does not
leave an active goal without a scheduled tick. Separate counters let a successful
session read reset its failures without erasing repeated activity failures.
The bounded backoff allows
recovery without sending a continuation from unknown state. At exhaustion, the
runtime attempts to block with a resumable reason because an unscheduled active
goal or an endless retry gives the user no explanation for the stopped turns.

Retry settlement passes a write-time predicate through `persistSessionGoal`.
The server checks it inside the metadata store's existing per-session write
queue, so a queued pause, clear, completion or replacement cannot be overwritten.
The predicate also rejects a retry window invalidated by a goal change, session
status event, user abort or runtime stop.
A rejected write returns `false` and emits no settlement notification. Direct
OpenCode writes outside this store still lack a cross-process compare-and-set.
