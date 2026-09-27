# Session work ("In work")

## Purpose

Keeps sessions where real work is going on in one block at the top of the
sidebar until the user marks them done. Jev moves a session in when work
starts in it; the user alone closes it. The same turn-end Jev call tells
session assist whether the Small Model is worth waking.

## Files

- `questions.js` — the Jev questions (measured wording, see "Measurement"),
  the thresholds, and the decisions taken from the answers.
- `state.js` — `metadata.openchamber.work` and the merge patches that change
  it. Every patch is decided against the record at write time.
- `runtime.js` — `createSessionWorkRuntime`: `processPayload` (a sent message,
  a turn start), `evaluateTurnEnd` (called by session assist), `stop`.

## State

`metadata.openchamber.work`:

- `state`: `open` | `done`
- `openedAt`, `openedBy` (`jev` | `user`)
- `doneAt` once the user closed it
- `suggestDoneAt` while Jev thinks the last turn closed the work out

The UI parser is `packages/ui/src/lib/sessionWorkMetadata.ts`; the user's own
Track / Done go through the generic metadata route
(`setSessionWorkState` in `packages/ui/src/sync/session-actions.ts`), which
also exists in VS Code.

## Invariants

- Jev only opens. Nothing here ever writes `done`.
- Jev reopens a closed session only for a request sent after the user closed
  it (`openByJevPatch` compares the request's `time.created` with `doneAt`).
- Writes go through `updateSessionMetadata`, which decides the patch inside the
  store's per-session write queue, so a user's Done written a moment earlier
  is seen and kept.
- A turn-end check is bound to its turn: every turn start and new user
  message advances a per-session counter, and the done hint is written only if
  the counter is unchanged when the write runs (decided inside the store's
  queue). A late Jev answer about a turn the user already moved past writes
  nothing.
- The done hint is current while `suggestDoneAt >= session.time.idle` (the
  assist's freshness rule). This runtime also deletes a hint it wrote when the
  next turn starts; the rule covers hints written by another process.
- Only top-level, unarchived project sessions that are not review sessions
  (`openchamber.kind === 'review'`) are asked about. Managed Chats (under the
  `chatRoots` the server passes in) are plain conversations and never in work.
- A known subsession costs nothing: `../session-lineage.js` remembers which
  sessions have a parent (from `session.created` events and from any record
  read anyway), and a known one is skipped before any read or Jev call.
- Every failure (no classification provider, Jev error or timeout, an
  unreadable session) leaves state unchanged and returns an unknown gate, so
  session assist runs exactly as it did without Jev.

## When Jev is asked

- A user message was sent (`message.updated`, role user, from the hub's
  translation of `session.inbox.enqueued`): only with the feature and auto-open
  on, a usable classification provider, and the session not already in work.
  History is the three settled turns before it (`loadSettledTurns`). Each
  message id is asked about once.
- A turn ended: session assist calls `evaluateTurnEnd` before it arms its quiet
  window. One call carries only the questions that apply: the open questions
  while not in work, `wrap_up` while in work, `recap` / `next_step` for the
  assist fields the user has on. No applicable question, no call.

## Measurement

156 real sessions (93 work, 50 not, 9 housekeeping, 4 neutral) set the wording;
190 older held-out sessions, labelled before looking at answers, checked it:
send and turn end together missed 4/92 work sessions and opened 10/78 non-work
ones (four of them discussions of concrete changes, which count as work). The
misses are work that starts inside a PR-review session. `wrap_up >= 0.85`
hinted 60 times across 104 work sessions, 18 of them followed by more work.
`recap` stayed high (0.86–0.96) after a closing "thanks"/"commit" that followed
real work, because it reads the same three turns the recap does. Do not change
the wording or thresholds without re-running this measurement.

## Settings

`sessionWorkEnabled` (the block and the actions, default on) and
`sessionWorkAutoOpen` (Jev opens sessions, default on; not offered in VS Code,
and inert without a classification provider). Both are read at every use.

## Runtime parity

- Web, desktop, hosted mobile, Capacitor: all of it; the server owns Jev.
- VS Code: no OpenChamber server, so no Jev and no done hint. The block and
  Track / Done work through the extension's metadata bridge.

## Tests

`state.test.js` (patches, reopen rule, hint lifecycle), `runtime.test.js`
(send-time open, no repeat asks, ineligible sessions, the combined turn-end
call, a late answer after the next turn started, never closing, failure as
unknown), plus the gate cases in
`../session-assist/runtime.test.js`, `loadSettledTurns` in
`../session-assist/context.test.js`, and `updateSessionMetadata` in
`../openchamber-sessions/session-metadata-store.test.js`.
