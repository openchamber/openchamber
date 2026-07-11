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
  objective,               // user text, <= 2000 chars
  status,                  // active | paused | blocked | budgetLimited | complete
  tokenBudget,             // optional positive int
  tokensUsed,              // tokensCommitted + current segment (snapshot - baseline)
  tokensBaseline,          // segment start snapshot (pre-goal turn; 0 after compaction)
  tokensCommitted,         // closed segments' total (one segment per compaction)
  turnsUsed,               // auto-continuations sent (capped at MAX_AUTO_TURNS)
  blockedStreak,           // consecutive blocked audit verdicts
  auditFailStreak,         // consecutive failed/unavailable audit calls
  note,                    // latest audit progress note, <= 280 chars
  statusReason,            // why settled; 'resumed' is a kickoff signal from UI
  lastAccountedMessageID,  // incremental accounting cursor
  createdAt, updatedAt
}
```

The UI writes goals (create/edit/pause/resume/clear) by patching this
metadata; the runtime never creates a goal on its own. Goal creation happens
at send time (the composer target button arms "the next prompt is the
objective"), and the armed send also attaches a synthetic system-reminder
part telling the agent goal mode is active and that each turn should end
with a factual done/verified/remaining statement for the independent audit.
Freshness/stale-write protection is by `id`: every runtime write re-reads the
session and drops the write when the stored goal id no longer matches.

## Flow

1. `createSessionGoalRuntime` subscribes to the global SSE hub (same pattern
   as session-assist — it needs the envelope's `directory`).
2. `session.status: idle` arms a 15s per-session timer; `busy`/`retry` clears
   it. A `session.updated` carrying a fresh active goal (`turnsUsed === 0` or
   `statusReason === 'resumed'`) arms a short 3s kickoff timer, since setting
   a goal on an idle session emits no status transition.
3. On fire (`tick`), gated by the `sessionGoalEnabled` setting:
   - fetch session (skip sub-agent sessions), require an `active` goal;
   - quiescence check via the message tail (trailing user message or
     unfinished assistant reply → bail; the next idle transition re-arms);
   - token accounting as a SNAPSHOT of the latest completed assistant turn:
     `input + cache.read + output`. Earlier turns' inputs and outputs fold
     into the next turn's cache, so the latest snapshot already carries the
     whole run's paid tokens — no summing across messages. Goal-relative via
     `tokensBaseline` (the same snapshot of the newest pre-goal turn,
     captured on the first tick). Compaction (an assistant message with
     `summary: true`) breaks the snapshot chain, so accounting is segmented:
     the summary message closes the segment into `tokensCommitted` (the
     summary turn read the whole context, so its snapshot prices the
     compaction itself) and the next segment starts with a zero baseline.
     `tokensUsed = tokensCommitted + current segment`, kept monotonic so
     unflagged context shrinks never move the budget backwards;
   - terminal checks, cheapest first: assistant turn error → `blocked`;
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
     write just waits for the next idle tick; the reverse could double-send),
     re-check the tail, then `POST /session/:id/prompt_async` with the
     continuation prompt using the last assistant message's
     provider/model/agent — the goal spends the session's own subscription.
4. Settling (`complete`/`blocked`/`budgetLimited`) fires the injected
   `emitGoalNotification` so the user hears about it even with the UI closed.

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
- `hooks/useSessionGoal.ts` — live goal state.
- `components/chat/SessionGoalButton.tsx` — composer target button
  (arm / status color / cancel confirm); `SessionGoalRow.tsx` — goal strip
  above the composer; `SessionGoalDialog.tsx` — manage dialog
  (edit/pause/resume/complete/clear).
- Sidebar glyph next to the date in `SessionNodeItem`.

## Limitations

- Web-server feature: VS Code (extension-only) renders goal state via
  `session.updated` but does not run the loop.
- A goal on a session with no assistant reply yet starts after the first
  user exchange completes (no provider/model to continue with before that).
- `tokensUsed` only counts completed assistant messages seen within the
  40-message fetch window per tick; extremely long busy stretches between
  idles undercount (acceptable: budget is a guardrail, not billing).
