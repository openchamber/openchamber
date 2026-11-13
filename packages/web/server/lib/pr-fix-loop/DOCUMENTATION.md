# PR fix loop

The server watches one PR for one host session. Auto mode sends feedback through the host message queue and keeps the existing agent-managed GitHub workflow. Approval mode requires a new protected isolated-space worker and publishes only a host-captured result the user approved.

## Ownership

- `runtime.js` owns loop state, persistence, feedback cadence, iteration and token limits, worker preparation claims, and approval admission. Its routes have ordinary host UI authentication. No agent-tool action approves or publishes a receipt.
- `approval-contract.js` parses worker models, host-owned worker identities, GitHub head destinations and immutable receipt fields.
- `space-worker.js` creates a fresh `purpose: 'pr-fix-loop-approval'` space, verifies its host record and inspected runtime, seeds the exact PR head, creates its session, and addresses its own queue, live status and usage through `dispatcher.requestInside(spaceId, ...)`.
- `publication.js` captures the exact exported commit under a new host branch and publishes its saved authority. `../source-control/fix-loop-git.js` reuses the existing binding service and managed network executor.
- `review-actions.js` bounds the worker's suggested replies to the authenticated feedback IDs assigned to one iteration. The host executes the resulting operations through the provider's ordinary bound mutation service after approved publication.
- `../github/pr-feedback.js` reads complete feedback and the head repository's immutable GitHub node id, owner and repository name. A fork's head destination remains separate from the repository that hosts the PR.
- `../spaces/` owns the permanent restriction profile and quarantine/code-out checks. This module never interprets an in-space HTTP response as host authentication, a command, a grant or publication authority.

`server/index.js` builds the adapters without starting Spaces, and starts persisted loops after Spaces and Git services initialize. Host event subscribers continue to exclude space events. Worker progress uses authoritative space-specific polling.
Single-account loops and agent-owned auto loops load GitHub clients directly
from `../github/octokit.js`.
A captured account resolves only through `getOctokitForAccountId(accountId)` and
never falls back to the active credential. Legacy auto loops without an account
use `getOctokitOrNull('github.com')`, explicitly scoped to the supported instance.

## Front-door approval runtime

In front-door mode, a second `createFixLoopRuntime` instance runs approval loops
in the front door. Its own `<data dir>/pr-fix-loops.json` is authoritative for
local loop ids, worker preparations, receipts and lifecycle state. Auto mode
remains entirely agent-owned; the front-door instance refuses auto mode. The
single-account runtime and its local adapters are unchanged.

Front-door GitHub adapters use opaque `{ accountId }` handles. Tokens stay in
the agent account. Through `agent-upstream`, the front door requests bounded,
schema-checked feedback, author permissions, failed checks and project-side
operations. Binding reads, publication and review operations use the existing
agent-side Git services. Notifications remain local to the front door. The
[agent-server contract](../agent-server/DOCUMENTATION.md#pr-fix-loop-services)
owns the private service boundary.

`space-worker.js` uses the front door's Spaces host and existing dispatcher for
worker queues, turns and usage. The trusted Spaces journey owns stop and resume.
It reads the original host session
through the schema-checked agent upstream. The agent fetches the exact
provider-reported PR head into the registered project; the D2a bundle transfer
seeds that head into the worker. Existing code out checks the result before the
agent promotes its bundle into the project. The front door never opens the
project directory.

The front door generates each receipt identity and retains publication
authority. Delegation preserves the existing fresh-provider, binding and
exact-head checks in `runtime.js` and `publication.js`, together with the managed
executor's exact-object and lease checks. Agent answers cannot select a loop,
Space, host session or publication authority.

### Why approval and auto loops run in separate runtimes

Approval loops require the front door's Space and receipt authority. An agent
callback into the front door would give the agent a path to that authority.
Running the approval runtime there keeps calls one-way to bounded agent
services while auto loops retain their existing agent-owned queue.

## Approval setup

1. The user explicitly enables Spaces and configures its place through the existing funnel. The fix loop never enables the switch or reads credentials to give a space access automatically.
2. `POST .../fix-loops/workers` takes the PR's normal bound read context and `{ sessionId, owner, repo, number, name, placeId?, model: { providerID, modelID, variant? } }`. The original session must exist on the host in that directory. The server creates a new protected space with an empty corridor and no grants or setup commands, and returns `202 { worker }` while the ordinary Spaces creation continues.
3. The client follows the Spaces list/progress and uses the existing grant dialog for this new space. Creation passes the selected provider/model pair as the immutable `approvalModel`; only a pair reviewed by the Spaces inference policy is accepted. Every validation matches that record against the worker's selected model. The permanent profile accepts grants only for that provider and the reviewed endpoint formats. Existing general-purpose spaces cannot be selected or converted.
4. Activation supplies `workerId` and `config.pushMode: 'approval'`. The server consumes that preparation for one loop, verifies its original host session/directory, permanent purpose, inspected isolation and granted model, and requires a ready managed Git destination whose exact push endpoint is the PR head repository. Missing or unsupported authority refuses activation before enqueue.

Prepared workers are persisted and listed separately. Forgetting a preparation only removes its selection record; the Spaces UI owns stopping or deleting the space. A loop keeps its host session as `sessionId`, and its public `worker` names `parentSessionId`, `spaceId`, selected `model`, and the separate in-space `sessionId` and `spacePath`. The worker session metadata also names the loop and original host session. It never claims host parent/child identity.

Before the first turn, the host resolves and fetches the exact provider-reported PR object through the existing managed contributor transfer. It sends that object into the fresh space and checks it out there. No local PR branch or pre-existing head object is required. No host working tree is checked out or changed.

## Worker turns and receipts

Message cursors may be omitted or null at the start/end of history. An empty session with null terminal cursors has zero usage. A full page still requires a nonempty next cursor; null never authorizes a partial usage total or an incomplete turn result.

Approval feedback goes only to the worker's own message queue, with the captured model. The worker can change code and commit inside its space. It receives no GitHub grant or provider-read credential. The host records one iteration UUID and its selected thread, review and conversation-comment IDs before enqueue. The prompt requires one `openchamber-review-actions` JSON block in the final assistant text, with that UUID and exactly one reply for every assigned target. Thread replies also carry a boolean saying whether the worker fixed the thread. Replies are limited to 4000 characters, with at most 200 targets. Unknown fields, duplicate or unassigned targets, another iteration, missing replies and ambiguous blocks block receipt creation.

The worker's claims remain untrusted. The host can enforce target membership and publication order; it cannot prove that a suggested reply is true or a code fix is correct. The public `review.actions` are frozen with the pending receipt for inspection. The user approves the exact code object; the loop's originally requested automatic replies and resolution run after publication without another UI action, including with every client closed.

While working, the loop reads the space queue, global active sessions inside that space, and recent worker messages every 10 seconds. Both readiness and review-result reads select the newest completed assistant within the latest user turn, skipping only its trailing successful `idle` marker. The captured 2.0.29 idle marker omits `outcome`; the adapter accepts that shape, while explicit failed/interrupted outcomes and errors block completion. A user without a reply or an unfinished assistant holds the turn. A previous idle boundary, unknown records or content, invalid time ordering, failed assistant results and incomplete tool settlement cannot establish idle authority or supply an older result. Any queued item or active session also holds the turn. Failed worker operations preserve state and back off from 1 to 15 minutes. Usage comes from completed worker assistant records through `token-usage.js`; it is accounting reported by the server inside the space, not a hostile-agent-resistant token cap.

Turn reads use the official `{ data, cursor: { next?, previous? } }` envelope with `limit=100`, matching the token reader's page size. The first page is newest first; each subsequent request passes the opaque, URL-encoded `cursor.next`, without `order`. Reads stop immediately at the latest `user`, including inside a full page. Only the latest result, message IDs and cursors survive between pages. Missing, empty or repeated cursors, duplicate message IDs, overlapping pages and increasing creation times refuse completion. A short or empty page without the user boundary also refuses completion, even if it carries a next cursor, matching the pinned server's terminal-page behavior. Each response retains its 8 MiB cap. The read permits at most 32 pages and 3,200 messages, bounding response bodies to 256 MiB, the code-out transfer ceiling. A turn beyond that bound throws a history-read-limit error and remains blocked with retained work; it never supplies a partial result or an earlier turn. No full-history cache or worker DTO field is added. The runtime still validates the review iteration UUID separately.

Once the turn settles, existing `bringCodeOut` snapshots the work, fetches into quarantine, checks objects and transfer limits, and promotes the checked result. A reported conflicted index, nested repository or result that does not descend from the supplied PR head prevents receipt creation. Conflict-index reports come from inside and remain untrusted; a valid commit can still contain incorrect or unfinished code. The host creates an exclusive `refs/heads/openchamber-approval/<receipt uuid>` at the exact object. The public `pendingApproval` is:

```
{ id, commit, localRef, repositoryId,
  destination: { headRepo: { id, owner, repo }, ref, expectedHead },
  createdAt, changedPaths, changedBytes }
```

The host persists it before offering approval. Counts describe the code-out comparison with the space's initial snapshot. The saved commit and `localRef` let the client review that exact object through existing Git comparison reads. A newer worker commit or another export cannot replace a pending receipt. Public snapshots are copies. The exact binding revision, config revision, managed remote and endpoint fingerprint remain private with the receipt.

`POST .../:id/approve { receiptId }` accepts only the pending receipt identity. The host reads fresh authenticated GitHub state and refuses a closed PR, changed head, changed ref, renamed/transferred head repository or replacement repository with the same name. It verifies local repository and transport authority through the binding/network executor. The executor checks that the receipt branch still names the approved commit, revalidates before transfer, disables repository hooks, and pushes exactly `<approved sha>:<approved ref>` with `--force-with-lease=<ref>:<expected head>` to the saved managed endpoint. Contributor provenance uses the existing exact-destination selection mechanism. No mutable branch tip, ambient remote or worker-provided command selects publication.

An interrupted publication retains its exact receipt and `publishing` marker. Restart never retries that write or enqueues another turn. Approving the same receipt reconciles an exact matching remote result without another push; an unchanged old head can retry the same leased object. Both paths require an open PR, including when the remote already names the approved commit. Closed or merged PRs retain the receipt and work without publishing, clearing the receipt or starting review writes. A preflight refusal preserves the previous publication marker. Changed remote state remains a refusal. Failed or uncertain publication keeps the local object and receipt.

Successful publication durably changes review work from `awaitingPublication` to `pending`, with the exact published receipt. A host timer posts each thread reply before resolving that thread, and posts replies to assigned reviews and conversation comments in the same PR conversation. The host supplies repository, PR number, published head SHA, branch, binding context and deterministic operation keys. Worker text supplies only the bounded reply and fixed-thread choice. No URL, HTTP method, credential, repository or generic API request comes from the worker.

Every write independently passes `validateMutationContext`, exact-account resolution, current PR/head checks and the existing durable mutation executor. A thread mutation also reads its GitHub node and verifies membership in this PR. Git transport approval and provider-read success confer no extra GitHub write permission. A permission refusal remains a visible `review.state: 'blocked'` and prevents ready status. This path never requests broader credentials or changes the user's grant. Posting generated replies is the user-requested action toward their connected GitHub service; no extra external destination or enterprise-policy exception is introduced.

The loop persists dispatch intent before each operation and advances its cursor after a durable mutation receipt. Restart reuses the exact operation key and permits replay only. A missing or expired mutation record cannot cause another write. A refusal proven to precede dispatch in the live host invocation can retry; a failed provider write or unknown result retains its durable blocker. Reply writes have the mutation executor's sticky unknown-outcome limitation, so a lost response can require manual reconciliation and stopping this loop. No pending or failed review job can be replaced by another iteration or read as ready. A remote comment arriving between provider preflight and thread resolution remains a GitHub API race; resolution has no atomic comment-version precondition.

## Lifecycle and persistence

Server-internal bot watches use `createBotWatch(input, authority)` and the injected `botWatch` owner. A private symbol prevents HTTP create payloads from acquiring this authority. Persisted authority pins project, bot, item and exact service identity/revision independently of user repository bindings. Bot reads use `botWatch.getOctokit`, admitted feedback uses `botWatch.deliver` with deterministic event IDs, and selected review apps pass `botWatch.authorizeApp`. Human feedback retains the same repository write/admin check. Bot watches bypass the per-round iteration check and leave token/human limits with the bot coordinator. Ordinary loops retain their account selection, queue, default iteration cap and approval behavior. Attaching the same watch again returns it unchanged and leaves its timer alone: the bot coordinator re-attaches on every pull-request read, and each tick wakes the coordinator, so an immediate tick on re-attach polled GitHub in a closed circle. `stopBotWatch({ projectId, botId, itemId })` stops only that item's owned watches and waits for a running tick before returning, even if its credentials were removed. See [the production adapter contract](../bots/production-adapters.md).

`<data dir>/pr-fix-loops.json` is version 2, serialized and atomically renamed with mode `0600`. Version 1 auto loops remain readable. An approval record with no valid trusted worker fails closed on startup, create/update and resume. A record that carries a worker or pending receipt cannot normalize into auto mode. Unknown execution modes are rejected. Malformed or unreadable state fails loading and is left intact. Persistence covers process restart; power-loss durability is not promised.

Failed agent reads preserve loop and receipt state. Worker export failure retains
`working` state for recovery. No private agent service response authorizes a
front-door fallback to project access.

The ordinary host queue also validates each `pr-fix-loop` origin at dispatch, before model switching, synthetic context or prompt delivery. It lazily loads the owning loop even when the queue starts first. Approval, missing, stopped, malformed, wrong-session and wrong-directory authorities stay queued with an error; absence of the admission service also refuses delivery. Only a matching active auto loop may dispatch on the host. This closes already queued version-1 approval work across restart. Work already delivered to a host OpenCode before this guard existed cannot be retroactively isolated or undone.

Execution mode is fixed for an existing loop. Stop and prepare a new loop to change it. A pending receipt or review job prevents replacement or configuration changes through both activation `POST` and configuration `PATCH`. Explicit stop persists the loop as stopped, stops both worker containers through the trusted journey, and retains worker files, commits, approval refs and receipts. Stop errors remain visible. A stopped/error loop resumes only after its protected worker starts and passes verification again. Deleting the original host session also stops its worker. Forgetting a finished loop never deletes its space or retained approval branch.

The token budget prohibits subsequent model iterations once a completed turn consumes its budget. In approval mode the host still captures that turn's exact code and replies. The loop stays `working` while an interrupted export needs recovery and `waitingForPush` while the retained receipt needs approval. Publication and bounded host review writes can finish without another model turn. After those operations complete, the loop settles as `budgetReached` and sends its settlement notification once. Pending or blocked review writes retain their own visible state until they finish. Charged usage and pending work survive restart through the existing persisted fields; no new budget flag or state version is required. Auto mode keeps its existing terminal transition at the completed turn boundary.

Shutdown clears timers and drains pending state writes. Spaces and their own queues retain the documented Spaces lifecycle and may finish an already dispatched turn while the host is closed. They cannot publish. A turn intent is persisted before its queue request; an interrupted dispatch cannot fall back to a host session or blindly enqueue a second turn. Missing evidence of a completed turn keeps it blocked for explicit repair.

Automatic review feedback requires current repository write or admin permission, read through the loop's exact GitHub account before host enqueue. GitHub's base permission maps maintain to write and triage to read. Author allow lists, mentions and bot settings only narrow this authority. Every included thread comment, including older context beside a trusted new reply, must pass the same check. An untrusted fresh reply cannot retrigger an older trusted thread. Permission results are deduplicated per login within one feedback read and never retained across iterations. Read failures, malformed responses and mismatched identities preserve unknown authority, retain the feedback baseline, report an error and use the shared rate-limit/backoff path. Approval mode retains filtered external feedback inside its protected worker and still requires exact human-approved publication.

Automatic dispatch intent persists `internal.feedbackTrustVersion: 1` only after admission succeeds. The host queue requires this marker as well as the matching active loop/session/directory. Older queued prompts without evidence of author checks remain queued with an error and must be removed before the loop can collect fresh feedback. Already delivered host work cannot be recalled.

Before any automatic iteration, the server awaits loading the persisted message queue and checks for an existing item for that loop, including while its saved status is `watching`. A queued legacy prompt therefore cannot inherit admission from a later permission-checked iteration. Queue read failure does not establish an empty queue.

## Watching a ready PR

The server attaches ordinary user loops to the shared `../tracked-items` service
as the `pr-fix-loop` interest with the loop's captured reading account. Bot watches
keep their own polling through `botWatch.getOctokit` with captured bot authority;
they never enter the user-account tracking service. User-loop watching has no independent
PR timer. Its server-only refresh subscription receives successful unchanged
reads and explicit unavailable outcomes. A moved summary asks for detailed
feedback; an unchanged one does so at most every 3 minutes to refresh author
trust and feedback the summary does not represent. Detailed-read failures retain
their baseline and backoff. Working turns, protected-worker progress and pending
review writes keep their existing lifecycle timers. A finished host turn asks
the shared service for a fresh observation before another feedback read.
Failed detail reads also arm one bounded retry through the shared service. This
keeps recovery live after a merged summary has stopped ordinary observation.

`../session-automation` owns cross-automation admission. An active loop reserves
its host session and canonical PR across accounts and sessions. A bot watch
reserves the PR only: the bot coordinator writes to the fixing session, and the
watch's own feedback reaches it as a bot notice, which the host queue leases
with no fix-loop owner. `notify` receives a settling bot watch with its
`botAuthority`, which `list()` and events leave out. Retained receipts
and review jobs keep the reservation while stopped. Operation leases cover
in-flight steps and publication. A stop during worker resume cancels activation
and stops the worker again after the outstanding resume returns.
Every durable save releases a terminal loop's reservation once its final receipt
and review job are cleared, including publication that completed after Stop.

In front-door mode each server has its own admission. A front-door approval loop
reserves its session and PR against other fix loops only: the front door
refuses a creation while the other runtime's loop holds either, and runs
creations one at a time. On the agent, pr-watch wakes, queued sends and
auto-review do not see a front-door approval loop. When one of them pushes to
the PR while a receipt waits, approving that receipt fails its head check, and
the loop keeps the receipt and its work, waiting with that error.

`config.watch` (default `true`; records saved before it load as `false`) turns "ready" into a wait. When CI is green, no thread is unresolved and no change request is pending, a watching loop stays `status: 'watching'` with `statusReason: 'pr-ready'` and reacts to new CI failure or feedback under the same admission rules. It ends when the PR closes, the user stops it, the session is deleted, or a limit or error settles it. Without `watch`, `ready` stays terminal. A saved `ready` loop stays finished.

A round runs from the PR leaving ready until it is ready again. `iterations` counts the round and resets to 0 on entering `pr-ready`; `totalIterations` keeps the lifetime count (records without it start from their `iterations`). `maxIterations` limits one round. The token budget keeps counting from `createdAt` across rounds. `limitReached` and `budgetReached` remain terminal. Restart needs nothing new: `pr-ready` is `watching`, so `start()` schedules it again in 5 seconds and `seen` keeps handled feedback from going out twice.

Approval mode follows the same path once publication and host replies finish; the worker keeps running while the loop watches, and the next feedback starts a turn in it.

`notify(loop)` runs once per round when the loop enters `pr-ready` (`internal.readyAnnounced`). `server/index.js` titles it "Pull request is ready" and records it in the notification center as a `normal` `fix-loop` entry with the loop id as `requestId`; settled limits, budget, errors and the push-approval wait are `high`. `resolveNotifications(loop)` moves the loop's center entries to history (`notificationCenter.resolve({ sessionId, kinds: ['fix-loop'], requestId })`) when a new round starts, a receipt is published, or the loop is stopped, resumed or forgotten.

## Iteration messages in the transcript

Each host iteration item carries `notice` beside its `text`: `{ source: 'openchamber-notice', kind: 'fix-loop', loopId, pr, trigger, iteration, maxIterations, headSha, checks: [{ name, url }], feedback: [{ type, author, url, path?, line? }] }`, at most 200 feedback entries. The message queue sends it as the metadata of a synthetic message (`../message-queue/DOCUMENTATION.md`), and the UI renders it through `readOpenChamberResume` as a collapsible row headed "Fix loop: CI failed on #5" or "Fix loop: new review on #6" that opens to the full text the agent read. Bodies and logs travel only in `text`. The approval worker's turn drops the notice and stays an ordinary message, because its turn reader uses the latest user message as the boundary.

## The agent marker and the reviewer's own account

Everything the agent writes on GitHub ends with `<sub>Written by the OpenChamber agent</sub>` and `<!-- openchamber-agent:v1 -->` (`agent-marker.js`). Approval mode adds it in `reviewOperations` for jobs created with `agentMarker: 1`; a review job saved before the marker existed replays its exact old body, since a replay must send what its operation key was made for. Automatic mode asks for the exact block in the iteration prompt, because the session posts with its own GitHub tools.

Admission of a review, thread comment or conversation comment, in order: text carrying the HTML marker never counts (quoting the visible line does not suppress anything); in automatic mode, an unmarked reply by the reading account created while one of the loop's own turns ran (`internal.turnWindows`, persisted, last 20) or up to 2 minutes after it never counts, which covers a reply the agent posted without the marker (never a review or a thread's first comment); then blocked authors, allowed authors, `ignoreSelf` and `ignoreBots`, the mention; and last, in automatic mode, current repository write access, the only check that calls GitHub. Marked comments stay in a thread's text as context but cannot trigger it. `ignoreSelf` now defaults to `false`, so a user reviewing the agent's PR with the same account reaches the session; records saved before keep `true`.

The marker identifies text and is not a signature. Anyone can paste it to make the loop skip their comment. That only suppresses a reaction: it grants no access, starts no work and changes nothing that is published.

`internal.handled` keeps the ids sent to the agent; `seen` keeps every id read. Changing an admission setting (`triggers`, `ignoreSelf`, `ignoreBots`, the author lists, the mention) resets `seen` to `handled` and reads again under first-read rules, so what the loop skipped is weighed again and history stays history. Records saved before `handled` keep what they saw.

On a first read with `mentionOnly`, a review or conversation comment that mentions the loop and is newer than the agent's last marked text on the PR is admitted, besides unresolved threads and a pending change request. Without `mentionOnly`, earlier reviews and conversation comments stay history.

Feedback cadence, CI completeness and other notifications retain their existing behavior. Completed assistant-step usage sums input, output, reasoning and cache tokens. Settled results notify on the original host session and are kept in the notification center. A receipt that waits for the user's push approval (`waitingForPush`) calls `notifyAwaitingApproval(loop)` once per receipt id, and `server/index.js` records it in the center only, with the loop id as `requestId`. Approval waits do not become ready from a local-ahead heuristic.

## HTTP API

All routes are under `/api/source-control/github/pr/fix-loops` and precede the generic proxy.
The source-control provider shell registers them with the supplied host runtime.
Activation and preparation use GitHub's bound resource reader; host review jobs
use the shell's canonical mutation service. A missing replay record remains an
unknown outcome and cannot post a replacement reply.

In front-door mode, preparation and approval activation are local. Auto-mode
creation forwards to the agent server. Per-loop routes use the front door's
persisted local ids to select the owning runtime. The list merges both runtimes
through reconstructed schemas and rejects agent entries claiming approval mode,
a worker or approval state. Agent loop events retain their typed stream;
front-door approval events are local. Creation answers `409
fix_loop_automation_conflict` while the other runtime's loop holds the same host
session or pull request, the check one server's automation admission makes.

| Route | Request and response |
|---|---|
| `GET /` | `{ loops }`, including `worker` and `pendingApproval` |
| `POST /?<bound read context>` | `{ sessionId, owner, repo, number, config?, workerId? }` to `{ loop }`; approval requires the prepared worker |
| `POST /workers?<bound read context>` | Preparation described above, `202 { worker }` |
| `GET /workers` | `{ workers }`, unconsumed preparations |
| `DELETE /workers/:id` | Forget the preparation only, `{ ok: true }` |
| `PATCH /:id` | `{ config }`, partial, with fixed execution mode |
| `POST /:id/approve` | `{ receiptId }` to `{ loop }` |
| `POST /:id/stop` | Persist stop and stop its worker, `{ loop }` |
| `POST /:id/resume` | Reverify/start the existing protected worker, `{ loop }` |
| `POST /:id/refresh` | Schedule a read; pending approval remains immutable |
| `DELETE /:id` | Forget a finished loop; `409` while active |

Updates remain `openchamber:pr-fix-loop.updated { loop }`; removals carry `{ id, removed: true }`. The UI must use the receipt approval route. The ordinary Git push button does not approve a receipt.

The exact prepared-worker DTO, also used by `loop.worker`, is:

```ts
{ id: string /* UUID */, spaceId: string /* 12 lowercase hex */,
  parentSessionId: string, directory: string,
  model: { providerID: string, modelID: string, variant?: string },
  sessionId: string | null, spacePath: string | null }
```

Preparation has null session fields until the host initializes the first turn. Worker records contain no readiness or access heuristic. Use the ordinary Spaces list entry for that same `spaceId`: activation requires `purpose: 'pr-fix-loop-approval'`, the matching immutable `approvalModel`, `state: 'running'`, no damage, a verified manager result and an explicit usable selected-provider grant. Access is `null`, `unknown`, `granted` or `needs_access`. Only `granted` or `needs_access` can pass, and only when the selected grant's ID is absent from `needsAccess`. Null or unknown access never establishes readiness. Preparation never grants access.

`loop.pendingApproval` is the receipt shape above or null. `loop.review` is null or:

```ts
{ state: 'awaitingPublication' | 'pending' | 'blocked' | 'complete',
  actions: Array<
    { kind: 'thread', id: string, body: string, resolve: boolean } |
    { kind: 'review' | 'comment', id: number, body: string }>,
  completed: number, total: number, lastError: string | null }
```

Progress counts host operations, so a thread reply with resolution counts as 2. Older auto records may omit `worker`, `pendingApproval`, `review`, `totalIterations` and `config.watch`. The loop status enum remains `watching`, `working`, `waitingForPush`, `ready`, `stopped`, `closed`, `limitReached`, `budgetReached`, `error`. Approval accepts only `{ receiptId }`; it accepts no replacement commit, destination, action array or credential. Review work has no new HTTP action or button.

## Runtimes and evidence

Web, Electron, hosted mobile and Capacitor use the host routes, normal auth and shared runtime transport. No new listener, socket or relay protocol exists. VS Code remains unsupported because it has no host loop or Spaces service. GitHub publication is an explicit action toward the user's connected GitHub service; model traffic uses only the explicitly granted session provider.

Focused regressions cover protected preparation, missing/ordinary worker refusal, per-space queue/status transport, exact initial head seeding, host-queue exclusion at dispatch, persisted pending results, restart refusal, immutable approval identity, scoped review-result parsing, post-publication review work and durable replay, independent write refusal, stop races, hostile/incomplete exports, changed ref/head/repository, wrong fork destinations, and the executor's exact commit/lease/hooks contract. Live Docker confinement, live model grants and GitHub publication need the parent integration run. Existing quarantine tests own malformed Git objects and transfer teardown; parser tests here do not prove container isolation.
