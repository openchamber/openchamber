# Pull request watch

## Ownership

Owns an agent waiting on its pull request. The agent opens a pull request (or
a GitLab merge request), calls the `openchamber` tool's `pr.watch` with its
address, and goes on with its work or ends its turn, whichever the task needs:
the call only subscribes. This module follows the pull request whether or not
any window is open and wakes the session with one synthetic message when
something the agent has to act on happens; a message that arrives while the
session runs waits for that turn to end. The agent never polls and never holds
a turn open to wait.

Wiring: created in `server/index.js` after `../dispatch-results`, handed to the
control service as `prWatch` (`../openchamber-control/service.js`, actions
`pr.watch` and `pr.unwatch`, always for the calling session), attached to the
tracked-items service and its readers when `opencode/feature-routes-runtime.js`
creates them, routes registered there, stopped by
`opencode/shutdown-runtime.js`.

## Watch

`{ sessionID, directory, url, item, startedAt, last, wake }`, one per session; a
new `pr.watch` replaces the session's previous one. `item` is the tracked item
the address names (`parsePullRequestUrl`): a GitHub pull request, on another
host a GitHub Enterprise one, or a GitLab merge request read on its own
origin. Other providers are refused. `last` is the last state seen (state,
head commit, check outcome, merge state, `activity` count, title, last
merge queue removal); `wake` is a
pending wake with its events and the id of the message that carries it.

`pr.watch` reads the pull request before it answers, so what cannot be
followed fails at once with the reason: no account connected for that host,
a pull request that does not exist or the account cannot see, one already
merged or closed. A provider that is only unavailable (a rate limit) does not
refuse: the watch reads it later. The state read becomes the baseline.

Persisted in `<data-dir>/pr-watch.json`, written atomically, owner-readable
only. A malformed file is moved aside, one unreadable watch is dropped alone,
and a failed read keeps writes off until a load succeeds. At most 200 watches.

## What wakes the session

Watches register their items as the server interest `pr-watch` of the
tracked-items service (`../tracked-items`, `setServerInterest`), which
refreshes them on its own cadence (an open pull request every minute, every
30 seconds while checks run) whether or not a client is visible, with its
batching, backoff and rate-limit handling. Its `subscribe` listener hands every
moved state here, and `changesBetween(last, next)` names the events:

- `merged`, `closed`;
- `checks-failed`: the checks turned failing, or failed again on a new push;
- `checks-passed`: every check passed, or passed again on a new push;
- `dequeued`: the merge queue removed it after the baseline, for any reason
  but the merge itself (GitHub's `queueRemoval`); the message carries the
  reason, `it was removed from the merge queue (failed checks)`. The head's
  checks stay green when a queue check fails, so `checks-failed` never sees it.
  A baseline saved before removals were followed has none and waits for one
  more read;
- `conflict`: the merge state turned `dirty`;
- `behind`: it turned `behind` (GitHub reports it only where the base branch
  requires branches to be up to date; GitLab not at all);
- `activity`: the `activity` count grew. On GitHub that is conversation
  comments plus reviews (a reply in a review thread is a review of its own),
  on GitLab the merge request's user notes.

The first known state is only a baseline, never an event. A merge while
"Archive a worktree after its PR is merged" (`mergedWorktreeCleanupEnabled`)
is on ends the watch without a wake: the UI is about to archive that worktree
with its sessions, and a woken turn would run in a session on its way out.

## Wake

A wake ends the watch: the item leaves the interest, and the agent calls
`pr.watch` again when it needs to wait once more. The message waits until the
session is not running and none of its subagents runs (a user may be talking
to the agent), checked against OpenCode (`../opencode/session-activity.js`);
the session's next idle event re-arms it. An archived session is not woken,
its watch ends. The message id is minted and saved before the first attempt,
and OpenCode answering 409 to a second admission counts as delivered, so a
crash or a lost response never wakes twice. A 404 ends the watch; other
failures retry with backoff and are given up after eight attempts.

`../session-automation` gates final admission after those reads. A writer owning
either the session or canonical PR defers the wake and keeps its saved message
ID. Releasing ownership re-arms pending wakes without a new provider read.
Only matching session/PR releases re-arm ownership-held wakes. A failed send's
own lease release leaves its retry timer unchanged.

The watch receives successful live refresh outcomes, including unchanged ones.
A read older than the watch baseline requests another shared refresh, including
for a merged PR whose ordinary cadence has ended. Unchanged fresh state adds no
revision or persistence write.

The message is a `synthetic` admitted with `delivery: steer` and `resume: true`:
an `<openchamber-pull-request url number>` envelope naming what changed and
telling the agent the watch ended, `description` `Pull request #N: …` (the
chat shows it as a notice row, `packages/ui/src/lib/opencode/session-notices.ts`)
and `metadata.source: "openchamber-pr-watch"`.

A failed check or new activity names what to start with: the failed checks
(`a check failed (lint, tests)`) and the authors of the new comments and
reviews, newest first, as many as the `activity` count grew
(`someone commented or reviewed (alice, coderabbitai[bot])`). They come from
one read with `details: true` when the wake is decided, saved on `wake`; the
wake is not delivered until that read is over, and a read that fails sends it
without names. At most eight names per event; check names are workflow
authors' text, so `<`, `>` and line breaks are dropped from them.

`session.deleted` ends the session's watch.

## Routes and events

| Route | Purpose |
|---|---|
| `GET /api/pr-watch` | `{ revision, watches[] }`: `sessionID`, `directory`, `url`, `number`, `title`, `status` (`unknown`, `pending`, `passed`, `failed`, `open`, `waking`), `startedAt` |
| `DELETE /api/pr-watch/sessions/:sessionID` | The user's stop: the session is not woken |

Every change broadcasts `openchamber:pr-watch.updated`
`{ revision, sessionID, watch | null }` on the control stream. The UI
projection is `packages/ui/src/sync/pr-watch.ts`.

## Runtime parity

Web, desktop and both mobile clients show the composer row and the working
mark for a session of the server they are connected to. VS Code has no
OpenChamber server, so no agent there has the tool. The server inside an
isolated space refuses `pr.watch`: it has no source-control accounts to read
with.

## Decisions

### Why one wake ends the watch

After a wake the agent works: it reads the failure, pushes a fix, answers a
review. Changes arriving meanwhile would steer into that turn or pile up
behind it. Ending the watch keeps one message per wait, and the agent says
when it waits again, with a fresh baseline after its own push or comment.

### Why the tracked-items service and not a poller of its own

It already reads pull requests in batches per host and account, honours
GitHub's rate limits and backs off a failing provider. A second poller would
spend the same budget twice.

### Why the details are read at the wake and not carried in every summary

The sidebar refreshes the same live summaries for every linked pull request.
On GitHub the newest comments only widen the one GraphQL document, but on
GitLab the failed jobs and the newest notes are two more calls per merge
request. Asking for them once, for the one pull request that wakes someone,
keeps the sidebar's cost where it was on both providers.
