# Pull request watch

## Ownership

Owns an agent waiting on its pull request. The agent opens a pull request (or
a GitLab merge request), calls the `openchamber` tool's `wait.start` with
source `pr` and its address (`pr.watch` under the older name), and goes on with its work or ends its turn, whichever the task needs:
the call only subscribes. This module follows the pull request whether or not
any window is open and wakes the session with one synthetic message when
something the agent has to act on happens; a message that arrives while the
session runs waits for that turn to end. The agent never polls and never holds
a turn open to wait.

Wiring: created in `server/index.js` after `../dispatch-results`, handed to the
control service as `prWatch` (`../openchamber-control/service.js`, actions
`pr.watch` and `pr.unwatch`, always for the calling session), attached to the
tracked-items service and its readers when `server-frame/feature-routes-runtime.js`
creates them, routes registered there, stopped by
`server-frame/shutdown-runtime.js`.

## Invariants

- Every awaited read whose result changes a watch is followed by an
  `isCurrent(watch)` check before that result is used: a stop, a session
  deletion or a new watch of the same pull request replaces or removes the
  record mid-await, and the old attempt must neither wake nor drop the newer
  one.
- A tracked-items answer is dropped if its read began before the watch's
  baseline read or the last accepted read. Even an answer that changes
  nothing advances the read order. If neither the snapshot nor the queue
  cursor moves and there is no event, there is no broadcast or disk write.
- `merged` and `closed` are events even with no baseline: nothing reads an
  ended pull request again, so its first known state is already the news.
- A watch's key joins the session ID and the tracked item with a space
  (`keyOf`); session IDs contain no spaces, so the pair stays unambiguous.
  Re-watching a pull request deletes its record before setting it again, so the
  session's list keeps the order the watches were started in.
- A wake stays out of delivery (`enriching`) from the moment it is recorded
  until its details read is over, so an idle event during that read cannot
  deliver it without its names. The details stay in memory when persisting
  them fails; only a restart loses them.

## Watch

`{ sessionID, directory, url, item, startedAt, last, queueRemoval?, wake }`, one per session
and pull request: a session waits on as many as it watches, and `pr.watch` on
one it already waits on starts that watch over. `pr.unwatch` with `url` stops
that one, without it every one of the session; a supplied `url` that names no
pull request (empty, null, not a string) is a 400 that stops nothing. `item` is the tracked item
the address names (`parsePullRequestUrl`): a GitHub pull request, on another
host a GitHub Enterprise one, or a GitLab merge request read on its own
origin. Other providers are refused. `last` is the last state seen (state,
head commit, check outcome, merge state, `activity` count, title); `wake` is a
pending wake with its events and the id of the message that carries it.
`queueRemoval` holds the latest known GitHub removal ID and timestamp, or
an explicit empty result. Older files without the field still load. Only
active watches pay for the removal timeline: the watch's own reads and its
tracked-items interest ask for it (`queueRemoval`, `queueRemovals`).

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
batching, backoff and rate-limit handling. Its `subscribe` listener hands
fresh reads here, including unchanged summaries. The watch names the events:

- `merged`, `closed`;
- `checks-failed`: the checks turned failing, or failed again on a new push;
- `checks-passed`: every check passed, or passed again on a new push;
- `conflict`: the merge state turned `dirty`;
- `behind`: it turned `behind` (GitHub reports it only where the base branch
  requires branches to be up to date; GitLab not at all);
- `queue-removed`: GitHub recorded a new removal from the merge queue.
  GitHub can report it with unchanged checks and head, even if no poll saw
  the pull request in the queue. `merged` and `closed` take precedence.
- `activity`: the `activity` count grew. On GitHub that is conversation
  comments plus reviews (a reply in a review thread is a review of its own),
  on GitLab the merge request's user notes.

The first known check, conflict, and activity states establish baselines.
A merge while "Archive a worktree after its PR is merged"
(`mergedWorktreeCleanupEnabled`) is on ends the watch without a wake.
The UI is about to archive that worktree with its sessions.

## Wake

A wake ends its watch: the item leaves the interest, and the agent calls
`wait.start` with source `pr` again when it needs to wait once more. The message is sent as
soon as the watch fires, also while the session's turn runs: OpenCode steers it
into that turn. An archived session is not woken, its watches end.

A session's wakes are admitted one at a time: an attempt that comes up while
another is in flight runs once that one is over, after the quiet delay
(`QUIET_MS`, 500 ms). A second pull request's wake is steered into the turn
the first one started; each message keeps its own id and is admitted once,
and the agent reads both, at worst in one turn. The message id is minted and saved before the first attempt,
and OpenCode answering 409 to a second admission counts as delivered, so a
crash or a lost response never wakes twice. A 404 ends the watch; other
failures retry with backoff and are given up after eight attempts.

The message is a `synthetic` admitted with `delivery: steer` and `resume: true`:
an `<openchamber-pull-request url number>` envelope naming what changed and
telling the agent the watch ended, `description` `Pull request #N: …` and
`metadata` with `source: "openchamber-pr-watch"`, `url`, `events`,
`failedChecks`, `authors`, and `queueRemovalReason` when GitHub supplies one.
The removal reason is bounded, single-line text without angle brackets or
control characters. The chat builds its row from the metadata in the
user's language and never shows the envelope
(`packages/ui/src/lib/opencode/session-notices.ts`).

A failed check or new activity names what to start with: the failed checks
(`a check failed (lint, tests)`) and the authors of the new comments and
reviews, newest first, as many as the `activity` count grew
(`someone commented or reviewed (alice, coderabbitai[bot])`). They come from
one read with `details: true` when the wake is decided, saved on `wake`; the
wake is not delivered until that read is over, and a read that fails sends it
without names. At most eight names per event; check names are workflow
authors' text, so `<`, `>` and line breaks are dropped from them.

`session.deleted` ends the session's watches.

## Routes and events

| Route | Purpose |
|---|---|
| `GET /api/pr-watch` | `{ revision, watches[] }`: `sessionID`, `directory`, `url`, `number`, `title`, `status` (`unknown`, `pending`, `passed`, `failed`, `open`, `waking`), `startedAt` |
| `DELETE /api/pr-watch/sessions/:sessionID` | The user's stop, of the pull request at `?url=` or of every one: what it stops does not wake the session |

Every change broadcasts `openchamber:pr-watch.updated`
`{ revision, sessionID, watches[], watch | null }` on the control stream:
`watches` is the session's whole list, `watch` its newest entry for clients
that know only one. The UI projection is `packages/ui/src/sync/pr-watch.ts`.

## Runtime parity

Web, desktop and both mobile clients show the composer row and the working
mark for a session of the server they are connected to. VS Code has no
OpenChamber server, so no agent there has the tool. The server inside an
isolated space refuses `pr.watch`: it has no source-control accounts to read
with.

## Decisions

### Why failure fields stay opaque

Thrown failures can be errors, plain objects, functions or primitives. The
failure guards preserve arbitrary non-null messages and the existing
`Number.isInteger` status rule, without requiring positive or safe integers.
The object/function checks protect reads of unknown thrown values.

### Why the route contract names only the methods it uses

The server has no installed Express declarations. The local route contract
describes registration, request fields and JSON responses without adding a
dependency. Tracked-item readers retain their inferred JavaScript contract;
their summaries still pass through the existing snapshot and details schemas.

### Why a wake does not wait for the session to be idle

Delivery once waited for the session's turn to end, and before that for its
subagents and workflow agents too. Agents often wait on a timer or a pull
request precisely to check on work that runs under them or beside them, and
that work can run for an hour: a 20-minute timer arrived when the workflow
ended, with the row saying "waking the agent" all along. The wake is one more
message: steered into a running turn, the agent reads it at its next step;
into an idle session, it starts a turn. Holding it back only made it late.
`../extension-waits` follows the same rule.

### Why a source of `wait.*` and not a store merged into extension waits

The agent sees one way to wait (`../openchamber-control/DOCUMENTATION.md`),
so `waitSource` and `listWaits` describe watches the way `wait.list` names a
wait. The watches stay here: they ride the tracked-items refresh, a second
watch of the same pull request starts it over where a second timer is
another wait, and the composer row reads their check status. Merging the
stores would move all of that for no change the agent or the user sees.

### Why each pull request is its own watch

An agent often opens several pull requests in one task (a stack, one per
repository) and waits on all of them. One watch per session replaced the
earlier pull request without telling the agent, which went on believing
something would wake it. Each pull request keeps its own baseline and wakes
on its own; delivery stays one at a time per session, so wakes usually arrive
between turns, and a second one may share the first one's turn (see *Wake*).

### Why one wake ends the watch

After a wake the agent works: it reads the failure, pushes a fix, answers a
review. Changes arriving meanwhile would steer into that turn or pile up
behind it. Ending the watch keeps one message per wait, and the agent says
when it waits again, with a fresh baseline after its own push or comment.

### Why queue removals use a timeline cursor

An enqueue and removal can both happen between polls, so a transition out
of the queue can be invisible. The watch baselines the latest removal when
it starts or starts again. Creation time orders removals across timestamps,
and fresh read order resolves distinct IDs in the same second. An omitted
or malformed removal field leaves the cursor intact and does not block other
events. A successful empty read establishes a baseline without erasing a
known ID. A wait started again keeps the earlier wait's cursor, including a
confirmed empty timeline, even when its own baseline read was unavailable.
If the baseline read was unavailable and no cursor exists, the time that read began
filters out historical removals; the first successful read after it sets the
cursor, and from then on any newer ID is new, except one stamped in a second
that ended before the watch started, which is history however late GitHub
shows it. GitHub stamps removals to the
second, so one stamped in the same second as that start cannot be ordered by
time alone: the watch takes it as history, does not wake, and logs the
degraded baseline. The watch saves the new removal cursor and the pending wake
in the same write, so a restart cannot retain one without the other.

### Why the quiet delay, and not delivery on each event

Idle events arrive in bursts around a turn boundary: a wake on each one asks
OpenCode several times about the same boundary, and the first asks can still
see the session busy. One 500 ms quiet timer per session (`QUIET_MS`) collapses
the burst into a single confirmation. The delay after a delivered wake has the
same job: OpenCode reports the turn it started as running only a moment later.

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
