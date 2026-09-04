# Session Goal

Server-side control loop that keeps a session working toward a user-defined
objective stored under `metadata.openchamber.goal`, with the small model as
an independent progress auditor. Built on OpenChamber's backend-driven
architecture (session-assist is the structural template): the loop lives in
the web server and survives UI disconnects.

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
  turnsUsed,               // auto-continuations sent (capped at MAX_AUTO_TURNS)
  blockedStreak,           // consecutive blocked audit verdicts
  auditFailStreak,         // consecutive failed/unavailable audit calls
  note,                    // latest audit progress note, <= 280 chars
  statusReason,            // why settled; 'repeated output truncation' is the bounded truncation breaker; 'resumed' is a kickoff signal from UI
  evaluationProviderID,    // provider used by the latest successful audit
  evaluationModelID,       // model used by the latest successful audit
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
judge against. The armed send also attaches a synthetic system-reminder
part telling the agent goal mode is active and that each turn should end
with a factual done/verified/remaining statement for the independent audit.
Freshness/stale-write protection combines goal `id`, goal metadata identity
(objective/file flag, status, budget, and creation time), a logical-goal
identity (objective/file flag, budget, and creation time), expected `status`, a per-session cancellation generation, and a runtime-local serialized
read/modify/PATCH queue. Busy/retry status events and fresh goal replacements
advance the generation before clearing work; repeated identical
`session.updated` events do not. A newer runtime write supersedes an older
queued write. Resume dedup keeps the CAS identity separate from the goal
lifecycle signal (`goal.updatedAt` plus the session's `time.updated`), so
repeated delivery is suppressed while a file-backed edit can start a new
Resume. At the `session.updated` boundary, finite `session.time.updated` is
the primary monotonic freshness value and finite `goal.updatedAt` is its
secondary value. Older events are ignored; equal freshness keeps the first
accepted event. A first event may have no freshness timestamp, but after a
finite per-session baseline exists, an event with no finite freshness value is
ignored. Every write and continuation re-checks stopped state, generation,
goal identity, and active status immediately before its operation. A
continuation also re-reads the message tail and effective file objective after
the final admission checks and immediately before `prompt_async`. External UI
`PATCH` callers cannot participate in that queue or CAS protocol, so they can
still race a runtime write; these checks are not cross-process atomicity or a
server-side CAS.

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
  is live-editable mid-goal). A file-read failure is never authoritative empty
  success: when no inline fallback exists, the runtime uses the normal bounded
  retry/backoff policy and settles the goal as `blocked` with
  `statusReason: 'objective file unavailable'` after retry exhaustion.
  The runtime captures that effective text for the tick and re-reads the file
  immediately before every terminal write and continuation dispatch; changed content rejects
  stale in-flight work and starts a fresh bounded tick without changing the
  metadata identity.
  Inline fallbacks continue to preserve the ordinary file-backed path when the
  file is temporarily unreadable.
- UI display fetches content via the GET route
  (`useGoalObjectiveContent`); in VS Code the route is unavailable, so the
  strip degrades to the audit note (display-only fallback by design).
- Server-created goals write the file through `create.js`, which also owns
  objective fitting, inline fallback, metadata creation, and the synthetic
  first-turn reminder shared by scheduled tasks and CLI-created sessions.

## Flow

1. `createSessionGoalRuntime` subscribes to the global SSE hub (same pattern
   as session-assist — it needs the envelope's `directory`). It keeps a local
   directory record for every authoritative active goal it observes. On server
   startup, `start({ listDirectories })` also performs one bounded scan of known
   directories and arms active root goals that emitted no post-restart event.
   The strict settings read distinguishes a missing settings file (successful
   empty result) from malformed data, including an array payload, and from a
   read or migration failure. If the directory list or a
   session-list fetch is unavailable, the scan schedules at most four delayed
   recovery attempts and never treats the failure as an empty result. The
   OpenCode lifecycle keeps its separate best-effort warmup fallback, while
   `start` retains the strict signal for goal recovery. The lifecycle calls
   `start` again after confirmed readiness with a fresh bounded window, covering
   the startup race where the initial scan ran before OpenCode was usable.
   Recovery remains capped at the same four MRU directories and has no
   permanent polling loop.
2. `session.status: idle` arms a 15s per-session timer; `busy`/`retry` advances
   the session generation before clearing it. A `session.updated` carrying a fresh active goal (`turnsUsed === 0` or
   `statusReason === 'resumed'`) arms a kickoff timer — 3s for fresh goals,
    ~250ms for an explicit Resume so the nudge feels immediate — since setting
    a goal on an idle session emits no status transition. Resume replaces an
   existing idle timer; if work is in flight, the replacement is armed once
   that work clears. A shorter pending delay always wins, and a later normal
   idle event cannot replace an already-earlier Resume timer. Fetch/quiet
   failures use bounded exponential delays derived from the idle delay (15s,
   30s, 60s, 120s by default), at most four retries after the initial tick.
     On fetch retry exhaustion, the runtime re-reads the authoritative goal and
     settles an active goal as `blocked` even when no dispatch reservation exists.
     The guarded write uses the current goal revision and generation, with a
     `statusReason` that identifies the exhausted fetch retry. If the read or
     blocked PATCH is unavailable, terminalization retries with bounded backoff
     and then stops until a later authoritative idle event or Resume starts a
     fresh bounded window. This path never calls `prompt_async`.
    Authoritative activity and successful audit/continuation progress reset the
    corresponding retry state; a failed fetch never becomes an empty success.
    A `message.updated` user event invalidates an armed timer or in-flight tick
    only when its finite creation timestamp is at or after that work's arm
    point. Replayed events and events without timestamps do not cancel active
    work; Clear/no-goal updates and user aborts keep their explicit invalidation
    behavior.
3. On fire (`tick`), gated by the `sessionGoalEnabled` setting:
    - fetch session (skip sub-agent sessions), require an `active` goal;
      a response with the requested ID but without `metadata.openchamber.goal`
      is a valid no-goal response only when this runtime has no known active goal;
      otherwise it is partial/unknown and follows the bounded fetch-retry policy;
   - authoritative live-activity check after the quiet window: re-read the
     session status map, bail if the parent resumed, then list direct child
     sessions and bail while any child is `busy`/`retry`. A background
      subagent leaves its parent idle, then injects its result into the parent
      when done; that parent `busy` → `idle` cycle re-arms the loop without
      polling. Status/children/message fetch failure is unknown, not empty, so
      it skips the audit and re-arms a bounded quiet retry after in-flight work
       clears. A fetch failure is never represented as an empty successful
       response.
       Recent-message and child/status payloads are shape-validated at the
       runtime boundary. A valid status map omits idle sessions, so the target
       or a child absent from that map is authoritative idle. Malformed maps,
       malformed explicit target/child entries, and unknown explicit status
       types remain retryable unknown state, never an empty success.
       Unknown status events for a known goal follow the bounded status retry
       policy instead of clearing timers or treating the session as busy;
       unknown events for unrelated sessions do not invalidate this goal.
   - quiescence check via the message tail (trailing user message or
     unfinished assistant reply → bail; the next idle transition re-arms);
   - token accounting as a SNAPSHOT of the latest completed assistant turn:
      `input + reasoning + cache.read + cache.write + output`. Earlier turns' inputs and outputs fold
     into the next turn's cache, so the latest snapshot already carries the
     whole run's paid tokens — no summing across messages. Goal-relative via
      `tokensBaseline` (the same snapshot of the newest pre-goal turn,
      captured on the first tick). Compaction (an assistant message with
      `summary: true`) breaks the snapshot chain, so accounting is segmented:
       the summary message closes the segment into `tokensCommitted`; OpenCode
       zeroes the summary token fields, so the compaction call itself is a
       known undercount, and the next segment starts with a zero baseline.
      Messages are ordered by finite `time.created`, while equal timestamps
      retain authoritative API order. Missing or non-finite timestamps stay in
      a stable unknown bucket after timestamped messages. The persisted `lastAccountedMessageID`
      remains compatible; if it is outside the bounded page, the runtime does
      not replay the page or infer chronology from IDs and preserves prior
      monotonic totals until a safe cursor is visible. `tokensUsed =
      tokensCommitted + current segment`, kept monotonic so unflagged context
      shrinks never move the budget backwards;
      if the initial full page contains no visible pre-goal assistant baseline,
      the runtime conservatively leaves the cursor and totals unchanged rather
      than charging unknown pre-goal context. This can undercount until a safe
      baseline is visible, but preserves monotonic totals and summary
      segmentation;
   - a user abort pauses the goal instead of blocking it: the event path in
     `processPayload` pauses immediately on the MessageAbortedError message
      (before any tick could send a continuation over the user's explicit
      stop), with a tick-side safety net. A per-session cancellation generation
      prevents stale ticks from writing metadata or dispatching after abort. If
      busy/retry advances the generation before the pause write completes, the
      pending abort is rebound to the new generation and the next authoritative
      idle pauses the goal before audit/dispatch.
      Messages sent while paused leave the goal alone; Resume re-arms the loop,
      and resuming over an aborted tail skips the audit and goes straight to a
      continuation nudge;
    - terminal checks, cheapest first: genuine assistant turn errors → `blocked`;
      `finish: "length"` and `MessageOutputLengthError` remain resumable when
      applicable: the first eligible completed non-summary truncation may
      recover, while the second consecutive one blocks with
      `statusReason: 'repeated output truncation'`; summaries and assistants
      without a finite `time.created` do not contribute to the breaker;
     `tokensUsed >= tokenBudget` → `budgetLimited`;
     `turnsUsed >= MAX_AUTO_TURNS` (20) → `blocked`;
   - if the latest message is a compaction summary, skip the audit and
     continue unconditionally — running into the context window mid-work is
     by definition "in progress, not finished" (the summary is a retelling,
     not evidence, and must not be judged);
   - otherwise, small-model audit of the objective + the last assistant turn
     only — no conversation history and no continuation prompts
     (`restrictToPreferredProvider`, session's own provider/model preferred):
     JSON `{verdict: continue|complete|blocked, note}`. The audit is the SOLE
     termination authority besides the hard stops above — the working agent
     has no channel to settle its own goal. `complete` settles; `blocked`
     increments `blockedStreak` and settles only after 3 consecutive blocked
     verdicts, so a one-off snag cannot end the goal. Audit failure/absence
     tolerates ONE consecutive unaudited continuation (`auditFailStreak`); a
     second consecutive failure settles the goal as `blocked` ("progress
     audit unavailable") — resumable, and settling resets the streak so
     Resume gets fresh tolerance. A dead small model can never drive the
     loop blind to the turn cap;
    - continue: persist accounting + `turnsUsed` first (a crash after the
      write is reconciled by the next idle tick or restart scan; the reverse
      could double-send),
      re-check the tail, then `POST /session/:id/prompt_async` with the
      continuation prompt using the last assistant message's
      provider/model/agent — the goal spends the session's own subscription.
        A proven pre-admission rejection re-arms after in-flight work clears and
        retries the existing accounting reservation for that exact tail without
        incrementing tokens or turns again. The reservation is created before
        the ambiguous accounting PATCH and is idempotently recognized on the
        next read, so an accepted PATCH with a lost response cannot double-count.
        Proven rejection dispatch is attempted at most four times, including the
         initial attempt. On exhaustion the runtime enters an in-memory
         `terminalization-pending` state before disabling ordinary retries. An
         authoritative active goal is settled as blocked and its reservation is
         released only after the terminal write succeeds. If the final fetch,
         guarded restore, or blocked PATCH fails, terminalization retries with
          bounded backoff, at most four times after the first terminal attempt.
           If any terminal write (`complete`, `budgetLimited`, or ordinary
           `blocked`) committed before its response was lost, the next
           authoritative terminal read completes the same settlement, releases
           the matching reservation, and emits one notification without another
           PATCH. Exhaustion of that resolution window leaves the
          reservation protected and waits for a later authoritative idle or
          Resume to start one new bounded resolution window. While pending or
          escalated, no path may call `prompt_async`. An ambiguous `prompt_async`
        response is reconciled against authoritative session, status, and
        message state. It is never retried as a blind POST. A later status or
        changed tail drops the reservation. If the tail moved before dispatch,
        guarded cleanup restores the exact
        before-accounting values; if that restore is no longer safe, the goal is
        explicitly blocked rather than silently charged. If both the restore
        and blocked writes fail, the reservation remains as an explicit local
         pending or escalated state and retries through the bounded policy; a
          later authoritative idle or Resume starts another bounded resolution
           window. Pause, replacement/edit, abort, and runtime stop never
        silently drop an undispatched reservation: an active edit-in-place that
        retains the reservation identity (`id` + `createdAt`) rebinds it and
        preserves its accounting, while lifecycle invalidation restores the
        exact before-state; an identity change either proves the old charge is
        gone or blocks the current goal explicitly when the charge cannot be
         separated. Resume adopts its authoritative accounting state. When it
           resets `turnsUsed` while retaining the accounting cursor, any
           rejected or terminalization reservation for the previous segment is
           resolved as superseded, its fence is cleared, and the idle kickoff
           creates one fresh continuation reservation. A genuinely new logical
           goal
          cleans up the old reservation. Accounting-first ordering remains
          intact.
        The restart scan uses the persisted cursor and authoritative transcript.
        If `sessionGoalEnabled` is false, it skips the ambiguity hold and keeps a
        bounded per-goal retry window. Any active-goal timer that fires while the
        setting is disabled does no work or dispatch, but its authoritative local
        session record is retained. Re-enabling the setting clears the bounded
        retry window and re-arms every known active goal, including goals found by
        the restart scan, so unchanged idle goals recover without permanent
        polling.
       If the cursor already names the current assistant tail and no in-memory
       reservation survived, the state is ambiguous (the POST may have been
       accepted); recovery holds that goal rather than charging or dispatching
       again. A new tail or explicit Resume releases the hold. This is the
       bounded safest outcome without adding a reservation schema or a
       cross-process transaction.
4. Settling (`complete`/`blocked`/`budgetLimited`) fires the injected
   `emitGoalNotification` so the user hears about it even with the UI closed:
   rollback fallback that confirms `blocked` uses this same settlement path;
   the reservation is removed only after that terminal write succeeds.
   desktop + UI broadcast + the standard push fanout (web-push with full
   text; APNs with a generic per-type title and the session name as body).
   It obeys the notify-on-completion setting. Conversely, while a goal is
   ACTIVE the notifications runtime suppresses per-turn "ready"
   notifications on every channel — they would only echo the loop's own
   continuations; error/question/permission notifications are untouched.
    Pausing a goal from the UI also aborts the running turn (and vice versa —
    an abort pauses the goal), so "stop" means stop on both axes.

`stop()` clears timers and invalidates all in-flight ticks, metadata writes, and
continuation dispatches. Late completions cannot write or send. The runtime's
queue/version/goal/status guards are local to this server process; an external
UI `PATCH` cannot join them and may still race a runtime write.

## Continuation prompt

Built inline in `runtime.js`: the objective as untrusted user data in an
XML-escaped `<objective>` block, budget numbers, keep-the-full-objective and
work-from-evidence rules, a completion-audit instruction, and the requirement
to end every turn with a factual done/verified/remaining report — the audit
sees only that final turn, so the report is its evidence.

## UI consumers (packages/ui)

- `lib/sessionGoalMetadata.ts` — payload parsing/types.
- `lib/sessionGoalActions.ts` — create/edit/pause/resume/clear via
  `patchSessionMetadata`; `lib/sessionGoalPresentation.ts` — status
  colors/labels shared across surfaces.
- `stores/useSessionGoalArmStore.ts` — the "next prompt starts a goal" flag,
  consumed by `sendMessage` in `sync/session-ui-store.ts` (works for drafts).
  Armed slash commands resolve their authoritative command template and apply
  OpenCode argument expansion (`$ARGUMENTS`, positional placeholders, or the
  implicit argument suffix) for the audit objective before goal metadata is
  written and before `session.command` dispatch. If command details cannot be
  loaded, the raw invocation remains the objective rather than blocking command
  execution.
- `hooks/useSessionGoal.ts` — live goal state.
- `components/chat/SessionGoalButton.tsx` — composer target button
  (arm / status color / cancel confirm); `SessionGoalRow.tsx` — goal strip
  above the composer; `SessionGoalDialog.tsx` — manage dialog
  (edit/pause/resume/complete/clear).
- Sidebar glyph next to the date in `SessionNodeItem`.

## Scheduled goals

Scheduled tasks can run as goals: `execution.goalEnabled` (+ optional
`execution.goalTokenBudget`) on a task makes the scheduled-tasks runtime
stamp `metadata.openchamber.goal` onto the fresh session (objective = the
expanded task prompt, or the argument-expanded command template for a slash
command) and attach the goal-mode intro part to normal prompts.
The loop here picks it up from session events like any other goal.

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

- Web-server feature: VS Code (extension-only) renders goal state via
  `session.updated` but does not run the loop.
- A goal on a session with no assistant reply yet starts after the first
  user exchange completes (no provider/model to continue with before that).
 - `tokensUsed` only counts completed assistant messages seen within the
   40-message fetch window per tick; extremely long busy stretches between
   idles undercount (acceptable: budget is a guardrail, not billing). Message
   chronology is `time.created`; missing timestamps remain in stable API order,
   and IDs never break chronology. The cursor is an opaque message identity,
   never an ordering key.
- The runtime-local queue and reservation cannot make an external UI PATCH or
  another OpenChamber process participate in the same compare-and-swap. Final
  session/status, transcript-tail, objective-content, generation, and status
  checks minimize this race; a mutation after those checks and before the POST
 remains ambiguous. Ambiguous POST responses are reconciled and never retried
 blindly, so an accepted-but-lost continuation cannot trigger duplicate
 provider execution. Only a proven non-admission rejection enters the bounded
 dispatch retry policy. Undispatched accounting is restored to its guarded
 before-state or explicitly blocks instead of being silently charged.
- A hard process crash can still occur after the accounting PATCH and before
  the in-memory reservation is durable. On restart the transcript/cursor hold
  prevents a second charge or prompt, but it cannot reconstruct the exact
  pre-PATCH counters without another persisted reservation record; the goal
  may remain active until a new tail or explicit Resume supplies intent.
