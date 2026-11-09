# Session work ("In work")

## Purpose

Keeps the sessions the user is working in in one block at the top of the
sidebar until they mark them done. Sending a message puts a session in work;
the user alone closes it. While a session is in work, Jev says after a turn
whether the work looks done; Jev never decides what goes in. Independently of work, the
same call says whether the turn handed over changes worth a look (the
composer then offers an AI review or a walkthrough). The same turn-end Jev call tells session assist whether the
Small Model is worth waking.

## Files

- `questions.js` — the turn-end Jev questions (measured wording, see
  "Measurement"), the thresholds, and the decisions taken from the answers.
- `state.js` — `metadata.openchamber.work` and the merge patches that change
  it. Every patch is decided against the record at write time.
- `membership.js` — which sessions can be in work and which ones the block
  shows.
- `runtime.js` — `createSessionWorkRuntime`: `processPayload` (a sent message,
  a turn start), `evaluateTurnEnd` (called by session assist), `stop`.

## State

`metadata.openchamber.work`:

- `state`: `open` | `done`
- `openedAt`, `openedBy` (`auto` for a sent message, `user` for Track; `jev`
  on records from when Jev decided)
- `doneAt` once the user closed it
- `suggestDoneAt` while Jev thinks the last turn closed the work out

`metadata.openchamber.reviewOffer`: `{ at }` while Jev thinks the last turn
handed over changes the user could look over. It lives outside `work` so it
needs neither the In work block nor a session in work.

The UI parser is `packages/ui/src/lib/sessionWorkMetadata.ts`; the user's own
Track / Done go through the generic metadata route
(`setSessionWorkState` in `packages/ui/src/sync/session-actions.ts`), which
also exists in VS Code. An agent does the same on the user's word with the
`openchamber` tool's `session.markDone` / `session.track`, which write
`userStatePatch` (`../openchamber-control/DOCUMENTATION.md`).

`membership.js` holds which sessions this feature serves (`canBeInWork`) and
which ones the sidebar block shows (`isInWork`, `isDoneSuggested`), for this
runtime and for the agent tool's `session.list`.

## Invariants

- A sent message only opens. This runtime never writes `done`; only the user
  closes, in the app or through an agent they asked.
- A message reopens a closed session only when it was sent after the user
  closed it (`openPatch` compares the message's `time.created` with `doneAt`).
- Writes go through `updateSessionMetadata`, which decides the patch inside the
  store's per-session write queue, so a user's Done written a moment earlier
  is seen and kept.
- A turn-end check is bound to its turn: every turn start and new user
  message advances a per-session counter, and a hint is written only if
  the counter is unchanged when the write runs (decided inside the store's
  queue). A late Jev answer about a turn the user already moved past writes
  nothing.
- The review offer is written as soon as Jev answers. Looks done waits until
  the user stayed quiet for 10 minutes after the turn; any new turn or message
  in that time cancels it, and when it lands it replaces the review offer.
  The wait lives in this process only: a server restart drops the pending
  hint, and that turn gets none.
- A hint is current while its time `>= session.time.idle` (the assist's
  freshness rule). This runtime also deletes a hint it wrote when the next
  turn starts; the rule covers hints written by another process.
- Only top-level, unarchived project sessions that are not review sessions,
  `/btw` side questions or scheduled task runs (`openchamber.kind` `review` /
  `btw` / `scheduled`) open or are asked about. A run's marker is set when
  the scheduled-tasks runtime creates the session; a user fork drops it
  (`fork-inheritance.js`, `sessionForkInheritance.ts`), so the fork counts. Managed Chats (under the
  `chatRoots` the server passes in) are plain conversations and never in work.
- A known subsession costs nothing: `../session-lineage.js` remembers which
  sessions have a parent (from `session.created` events and from any record
  read anyway), and a known one is skipped before any read or Jev call.
- Every failure (no classification provider, Jev error or timeout, an
  unreadable session) leaves state unchanged and returns an unknown gate, so
  session assist runs exactly as it did without Jev.

## When a session opens

A user message was sent (`message.updated`, role user, from the hub's
translation of `session.inbox.enqueued`), with the feature on: a session not
already in work and eligible opens. A message with only files or attached
context counts too; its text is empty. So does a shell command the user ran
from the composer (`session.shell.started`; OpenCode records it as a shell
message and a synthetic result, never as a user message, and only the user
starts one). Each message id is handled once; a session
already in work reads nothing from OpenCode. No Jev: until 2026-10, Jev judged
whether a message started work, and every session now counts instead.

The open a message owes stays pending in this runtime until it is settled:
the session opened or was already open, the user closed it after the message,
it can never be in work, OpenCode no longer has it, or In work is off. A failed
metadata read, session read or write is tried again after 2s, 10s and 60s,
then given up with a warning. A session archived when the message arrived
waits for OpenCode's `session.unarchived` and is tried again then; sending to
an archived session restores it right after the send, so this is the usual
order there. One open is pending per session, the newest message's, and a
retry never moves the turn counter: the message id is taken once, and only
taking it starts a turn. Recovery is local because nothing delivers the same
message again: the hub hands each event to a server subscriber once and does
not retry a subscriber that failed.

## When Jev is asked

- A turn ended: session assist calls `evaluateTurnEnd` before it arms its quiet
  window. One call carries only the questions that apply: the four looks-done
  signs while in work, `review_ready` while the review offer is on, `recap` and
  the two next-step signs for the assist fields the user has on. No applicable
  question, no call.
- Looks done = `report`, and not `agent_continues`, `waits_reader` or
  `offers_agent`, each at 0.5; a sign Jev did not answer means no hint. The
  next-step suggestion is worth waking the Small Model when `agent_continues`
  and not `waits_reader`; an unanswered sign leaves it allowed.
- Jev reads the request's first 1500 characters, the answer's first and last
  500, and three earlier turns cut as routing cuts them.

## Measurement

The looks-done and next-step signs were measured on 881 turns of 100 recent
sessions, 95 of them closed by the user with Done, which marks the closing
turn (`julia-lab/label/turnend`: `run-jev-genre2-prod.mjs`,
`score-genre2-prod.mjs`, with the blind hand judgments in `judge/`). With the
10-minute pause, looks done stood on the closing turn in 54 of the 95 sessions
and showed 34 times while the user went on working; the earlier single
question (`wrap_up >= 0.8`, "does this turn close out the work") gave 36 and
16. On 19 hand-judged disagreements it was right 13 times (the old question
11), and the next-step sign pair was right on 17 of 24 where the old
`next_step` question was right on 5: that question also said yes when the
agent only waited for its own background work. A sign "mentions things not
done" fired on most final answers, which nearly always carry side notes, and
"suggests optional steps for the reader" split the models (kappa 0.20); both
were dropped.
`review_ready >= 0.7` was set on the 156 sessions and checked on the 190,
against whether the turn ran an edit tool (Jev sees no tools): with looks
done winning it hinted after 271 of 362 edit turns and after 14 of 823 turns
without edits. The lab is `julia-lab/jev-work` (`run-review.mjs`,
`score-held.mjs`) under `~/projects/openchamber-extensions`.
`recap` stayed high (0.86–0.96) after a closing "thanks"/"commit" that followed
real work, because it reads the same three turns the recap does. Do not change
the wording or thresholds without re-running this measurement.

### Why looks done waits 10 minutes and not shows at once

In a long session almost every turn finishes something, so a closing-looking
turn is often a subtask the user moves past within minutes, and nothing in the
agent's message tells it from the last one. The pause is that signal: on the
95 sessions above, the signs shown at once would stand on 150-210 turns the
user went on from; after 10 quiet minutes, 34. 20 minutes would cut that to
about 25 for 3 fewer timely hints; 10 was chosen so the hint does not feel
late. The review offer does not wait, because it is useful while the user
looks at the changes.

### Why plain signs of the message and not one question about the turn

A question such as "does this turn close out the work" makes the model weigh
the request against the answer, and it latched onto words like "commit" or
"thanks" instead. Signs of one text are what a small model recognises
consistently: Jev and another model agree on them far more (kappa 0.52-0.74
against 0.34-0.70), so the same signs can train a local model later. The code
combines them, so changing what the hint means changes code, not wording.

## Settings

- `sessionWorkEnabled`: the block, the actions, and opening on a sent
  message, default on.
- `sessionReviewOfferEnabled`: the review offer, default off (Settings → Chat →
  Session Assistance); not offered in VS Code, inert without a classification
  provider, independent of In work.

Both are read at every use. A session in work also stays under its project
group and folders: In work is an extra view of it, not a move.

## Runtime parity

- Web, desktop, hosted mobile, Capacitor: all of it; the server opens
  sessions and owns Jev.
- VS Code: no OpenChamber server, so sessions do not open on their own and
  there is no done hint and no review offer. The block and Track / Done work
  through the extension's metadata bridge, the deleted-folder answer included.

## Tests

`state.test.js` (patches, reopen rule, hint lifecycle), `runtime.test.js`
(open on a sent message without Jev, the reopen rule, one handling per
message, ineligible sessions, an open recovered after a failed read or write
and after a restore, the retry bound, a retry that keeps the turn's hint, the combined turn-end
call, the review offer with and without In work and looks done winning over
it, a late answer after the next turn started, never closing, failure as
unknown), plus the gate cases in
`../session-assist/runtime.test.js`, and `updateSessionMetadata` in
`../openchamber-sessions/session-metadata-store.test.js`.
