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
also exists in VS Code.

## Invariants

- A sent message only opens. Nothing here ever writes `done`.
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
- A turn writes at most one hint: looks done wins over the review offer.
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

## When Jev is asked

- A turn ended: session assist calls `evaluateTurnEnd` before it arms its quiet
  window. One call carries only the questions that apply: `wrap_up` while in
  work, `review_ready` while the review offer is on, `recap` / `next_step` for
  the assist fields the user has on. No applicable question, no call.
- Jev reads the request's first 1500 characters, the answer's first and last
  500, and three earlier turns cut as routing cuts them.

## Measurement

156 real sessions (93 work, 50 not, 9 housekeeping, 4 neutral) set the wording;
190 older held-out sessions, labelled before looking at answers, checked it.
`wrap_up >= 0.8`
reads the whole turn (a commit, push, merge, sync or release the answer
reports done closes the work); on the held-out sessions it hinted 80 times
across 106 work sessions, 22 of them followed by more edits, and caught 53 of
81 shipping steps. At 0.85 the same wording hinted 70 times (18) and missed a
closing turn whose answer asked the user for a last check (0.82); the earlier
request-only wording at 0.85 hinted 60 times (16) and caught 33.
Growing the answer excerpt from 300+300 to 500+500 left `wrap_up` where it
was (80 hints, 22 followed by edits; 53 of 77 shipping steps).
`review_ready >= 0.7` was set on the 156 sessions and checked on the 190,
against whether the turn ran an edit tool (Jev sees no tools): with looks
done winning it hinted after 271 of 362 edit turns and after 14 of 823 turns
without edits. The lab is `julia-lab/jev-work` (`run-review.mjs`,
`score-held.mjs`) under `~/projects/openchamber-extensions`.
`recap` stayed high (0.86–0.96) after a closing "thanks"/"commit" that followed
real work, because it reads the same three turns the recap does. Do not change
the wording or thresholds without re-running this measurement.

## Settings

- `sessionWorkEnabled`: the block, the actions, and opening on a sent
  message, default on.
- `sessionReviewOfferEnabled`: the review offer, default off (Settings → Chat →
  Session Assistance); not offered in VS Code, inert without a classification
  provider, independent of In work.

Both are read at every use. A session in work also stays under its project
group and folders: In work is an extra view of it, not a move.

## When the session's folder is gone

OpenCode (2.0.32, 2.1.0) refuses every metadata write for a session whose
folder no longer exists, once that folder is not loaded, with
`LocationNotFoundError`, though the session still reads.
The metadata route, and the VS Code bridge, answer that with the code
`SESSION_DIRECTORY_MISSING`; Track / Done then shows "This session's folder was
deleted" with an Archive button that archives the session and its subagents at
once, without the archive confirmation; the success toast offers Undo
(`sessionWorkFailure.ts` in the sidebar sessions). Any other failure keeps the
generic toast.

### Why offer archive and not keep the work state somewhere else

Work state lives on the OpenCode record, the single authority every client
reads. A second store for sessions OpenCode refuses would have to be merged
into every read and cleaned up when the folder returns. Archive is already
OpenChamber's own record, works without the folder, and takes the session out
of In work, which is what the user wanted from Done.

## Runtime parity

- Web, desktop, hosted mobile, Capacitor: all of it; the server opens
  sessions and owns Jev.
- VS Code: no OpenChamber server, so sessions do not open on their own and
  there is no done hint and no review offer. The block and Track / Done work
  through the extension's metadata bridge, the deleted-folder answer included.

## Tests

`state.test.js` (patches, reopen rule, hint lifecycle), `runtime.test.js`
(open on a sent message without Jev, the reopen rule, one handling per
message, ineligible sessions, the combined turn-end
call, the review offer with and without In work and looks done winning over
it, a late answer after the next turn started, never closing, failure as
unknown), plus the gate cases in
`../session-assist/runtime.test.js`, and `updateSessionMetadata` in
`../openchamber-sessions/session-metadata-store.test.js`.
