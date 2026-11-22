# Session work ("In work")

## Purpose

Keeps the sessions the user is working in in one block at the top of the
sidebar until they mark them done. The user chooses how sessions go in
besides Track (`sessionWorkEntry`): not on their own, on every sent message,
or when Jev says work started. The user alone closes. While a session is in
work, Jev says after a turn whether the work looks done. Independently of work, the
same call says whether the turn handed over changes worth a look (the
composer then offers an AI review or a walkthrough). The same turn-end Jev call tells session assist whether the
Small Model is worth waking.

## Files

- `questions.js` — the Jev questions (measured wording, see "Measurement"),
  the thresholds, and the decisions taken from the answers.
- `settings.js` — the `sessionWorkEntry` values and the rule for a settings
  document without one (see "Settings").
- `state.js` — `metadata.openchamber.work` and the merge patches that change
  it. Every patch is decided against the record at write time.
- `runtime.js` — `createSessionWorkRuntime`: `processPayload` (a sent message,
  a turn start), `evaluateTurnEnd` (called by session assist), `stop`.

## State

`metadata.openchamber.work`:

- `state`: `open` | `done`
- `openedAt`, `openedBy` (`auto` for a sent message, `jev` when Jev decided,
  `user` for Track)
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

- A sent message, or Jev reading one, only opens. Nothing here ever writes
  `done`.
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

Only while In work is on (`sessionWorkEnabled`), and only an eligible session
not already in work; a session already in work reads nothing from OpenCode and
costs no Jev call. Each message id is handled once. What opens depends on
`sessionWorkEntry`:

- `off`: nothing opens on its own; the user tracks sessions.
- `every-message`: a sent user message (`message.updated`, role user, from the
  hub's translation of `session.inbox.enqueued`) opens the session, no Jev. A
  message with only files or attached context counts too; its text is empty.
  So does a shell command the user ran from the composer
  (`session.shell.started`; OpenCode records it as a shell message and a
  synthetic result, never as a user message, and only the user starts one).
- `jev`: Jev reads a sent message with text, with the three settled turns
  before it as history (`loadSettledTurns`), and the session opens when
  `decideOpen` says real work started. The turn-end call asks the same
  questions about the finished turn while the session is not in work, which
  catches work that only shows in the reply, a message with only files, and a
  shell command. Without a classification provider nothing opens, as with
  `off`.

## When Jev is asked

- A message with text was sent, only with `sessionWorkEntry` `jev` and the
  session not in work.
- A turn ended: session assist calls `evaluateTurnEnd` before it arms its quiet
  window. One call carries only the questions that apply: the open questions
  (`change`, `toward_change`) with `sessionWorkEntry` `jev` while not in work,
  `wrap_up` while in work, `review_ready` while the review offer is on,
  `recap` / `next_step` for the assist fields the user has on. No applicable
  question, no call.
- Jev reads the request's first 1500 characters, the answer's first and last
  500, and three earlier turns cut as routing cuts them.

## Measurement

156 real sessions (93 work, 50 not, 9 housekeeping, 4 neutral) set the wording;
190 older held-out sessions, labelled before looking at answers, checked it:
for opening (`change >= 0.85` or `toward_change >= 0.9`), send and turn end
together missed 4/92 work sessions and opened 10/78 non-work ones (four of
them discussions of concrete changes, which count as work). The misses are
work that starts inside a PR-review session. `wrap_up >= 0.8`
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

- `sessionWorkEnabled`: the block and the actions, default on. Off, nothing
  opens whatever `sessionWorkEntry` says.
- `sessionWorkEntry` ("Sessions enter In work"): `off` (default),
  `every-message` or `jev`; not offered in VS Code. `jev` without a
  classification provider behaves as `off`, and Settings shows Off with a note
  until a provider is set up.
- `sessionReviewOfferEnabled`: the review offer, default off (Settings → Chat →
  Session Assistance); not offered in VS Code, inert without a classification
  provider, independent of In work.

All three are read at every use.

Migration (2026-10): from 2026-10-12 until `sessionWorkEntry` existed, every
sent message opened a session while `sessionWorkEnabled` was on. A settings
document without a valid `sessionWorkEntry` gets one on the first migrated
read (`migrateSettingsSessionWorkEntry` in `../opencode/settings-runtime.js`):
`every-message` when `sessionWorkEnabled` is stored as `true`, so someone who
had switched In work on keeps what they had, and `off` otherwise (stored
`false`, or never set). The value is written, so a later change of
`sessionWorkEnabled` never picks it again. Until that read happens, this
runtime applies the same rule (`resolveSessionWorkEntry`). A session in work also stays under its project
group and folders: In work is an extra view of it, not a move.

## Runtime parity

- Web, desktop, hosted mobile, Capacitor: all of it; the server opens
  sessions and owns Jev.
- VS Code: no OpenChamber server, so sessions do not open on their own, the
  entry setting is not offered, and there is no done hint and no review
  offer. The block and Track / Done work
  through the extension's metadata bridge.

## Tests

`state.test.js` (patches, reopen rule, hint lifecycle), `runtime.test.js`
(each entry mode: off opens nothing; every message opens on a sent message,
an attachment or a shell command without Jev; Jev decides opens on Jev's
answer at send and at turn end, and behaves as off without a classification
provider; the reopen rule, one handling per
message, ineligible sessions, the combined turn-end
call, the review offer with and without In work and looks done winning over
it, a late answer after the next turn started, never closing, failure as
unknown), plus the gate cases in
`../session-assist/runtime.test.js`, `loadSettledTurns` in
`../session-assist/context.test.js`, the migration in
`../opencode/settings-runtime.test.js`, normalization in
`../opencode/settings-helpers.test.js`, and `updateSessionMetadata` in
`../openchamber-sessions/session-metadata-store.test.js`.
