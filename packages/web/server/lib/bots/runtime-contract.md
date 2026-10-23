# Bot coordinator contract

## Ownership

`runtime.js` owns item admission and transitions. `effects.js` owns dispatch safety. `execution-store.js` persists immutable effect requests and stage reports beside the item snapshot. The item store remains the authority for item state and effect settlement. A descriptor is durable before its item effect exists; an orphan descriptor grants no permission to send.

## Runtime dependencies

`createBotsRuntime({ config, store, resolveProject, listProjects, stages, worktrees, services, serviceContext, runProof, pullRequests, sources, attention, notices, questions, scheduler, events, now? })` requires every dependency. There are no ambient-account, host-isolation or successful-empty fallbacks.

- `config` and `store` are the exports of `config.js` and `store.js`.
- `resolveProject(projectId)` returns `{ id, path }`; `listProjects()` returns those project records.
- `stages` is `createBotStageSessions({ sessionService, clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe, readSessionDefaults, readTokenSnapshot, isolated })` from `stage-sessions.js`. `readTokenSnapshot` uses the existing `pr-fix-loop/token-usage.js` owner and must return a complete total, including cache usage. `isolated` requires `create`, `dispatch`, `outcome`, `reconcile`, `stop` and `resume`; an explicit refusing adapter is appropriate when isolation is unavailable. `stages.stop` confirms the session and its children stopped before cleanup. `stages.resume` restores captured isolated access only during explicit Resume; it is a no-op for host placement.
- `worktrees.create({ project, bot, item, key })` returns `{ directory, branch, baseBranch, baseSha }`. It starts from the default branch and uses `bot/<item id>`. `reconcile(request)` returns `{ state: 'succeeded', result }` or `{ state: 'outcome-unknown' }`. A create reconciliation returns the checkout; a remove reconciliation returns `{ id: itemId }`. `remove(request)` verifies the recorded item ownership before removing anything. `inspect({ project, item, bot })` returns `{ baseSha, headSha, baseBranch, remoteSha, changes: [{ oldPath?, newPath? }], diff, testSha?, fixSha?, testFiles? }`. These are server-observed values. `acceptPublished({ project, bot, item, snapshot, result })` adopts verified signed GitHub objects from the service's commit map into the owned checkout; the coordinator then invalidates proof and judgment before proceeding.
- `services` is `createBotServices(...)`, including its authoritative `read` method. Its prepared envelope is retained verbatim in the private execution journal. `execute` returns the actual service envelope `{ status, result, ... }`; `service-receipts.js` converts its result to the compact item receipt. The coordinator supplies `execute` with `beforeDispatch`, which durably admits the effect after captured identity and destination-policy validation and before entering any content executor. `beforeAdmission` separately rechecks the merge generation after GitHub preflight. Public item responses expose the compact item effect record only.
- `serviceContext({ project, bot, item, service, operation })` requires the requested service and operation and returns only that service's binding as `{ [service]: { identityId, identityRevision, target, expectedStatusId? } }`. Unrelated identities and destinations are not resolved. Only `jira.transition` resolves `expectedStatusId` through `jira.transitions`; ordinary Jira reads and comments do not require the configured done transition. The identity resolver and repository owner supply these values, never the agent.
- `runProof({ directory, testSha, fixSha, command, args, testFiles, isolated, item })` returns a proof record accepted by `botItemSchema`. An isolated request must execute inside its recorded space or fail.
- The coordinator passes `runProof` a second `{ signal }` argument through the production host. Host proof has a 120-second execution deadline and cancellation produces inconclusive evidence. Item Stop persists its intent and cancels a locally active proof before waiting for project ownership; shutdown cancels every locally active proof before draining owners. Host proof uses the existing `spaces/run-command.js` process-tree owner and finishes its bounded termination and temporary-checkout cleanup before returning. Cancellation cannot start judgment or publication. Isolated proof retains its existing inner and outer execution limits and receives the caller's cancellation signal.
- `pullRequests.ensureLoop({ project, bot, item })` attaches automatic PR watch to the fixing session with no implicit iteration cap. `read({ project, bot, item })` returns `{ headSha, baseSha, merged, approved, mergeMode: 'auto-merge' | 'queue' }`. `stop({ project, bot, item })` relinquishes the loop before cleanup. The existing loop remains the feedback owner; feedback enters `receiveFeedback`.
- `createBotSources({ services, resolveJiraContext, discover })` supplies `sources.jira({ project, bot, jql, maxItems })` through the actual `services.read` operation `jira.search`, preserving pagination and exact identity. `resolveJiraContext` returns `{ identityId, identityRevision, site }`. `sources.investigate({ project, bot, occurrence })` delegates to the required `discover` owner, which must persist and reconcile a read-only investigation session with the bot's model and explicit MCP rules. Both return admitted-source candidates `{ source, title, description?, evidence? }[]`. Only the user's `maxItems` limits the result.
- `attention.sync({ projectId, item, critical? })` upserts a persistent high `bot` request keyed by item ID in `needs-you` or `waiting-answer`, and resolves it when the item leaves those states. It owns push policy and must survive notification-center retention. A critical report also requests an alert.
- `notices.deliver({ projectId, item, eventId, text })` uses the existing `openchamber-notice` queue with stable deduplication IDs.
- `questions` is the real `createBotQuestions` owner described in [questions-contract.md](questions-contract.md). Required methods are `ask`, `retry` and `answered`. Investigation uses `investigation:<round>` with resume state `fixing`; judge questions use `judge:<round>` with resume state `judging`, passing original model-output directory IDs rather than mapped GitHub logins. `item.ask` requires a stable `operationId`, accepts only approved directory IDs and an optional requested role, and uses `tool:<operationId>`. Replays reuse the original resume state and cannot replace an unanswered intent.
- `scheduler.sync(projectId, managedRows)` reconciles bot-owned rows and enforces managed-row edit/delete restrictions. `scheduler.remove(projectId, botId)` removes only that bot's row. `runtime.runScheduled(projectId, botId, occurrence)` is the dispatch hook.
- `events.subscribe(listener)` returns an unsubscribe function; `events.publish(event)` broadcasts item changes. `createBotEvents` provides a local implementation. The host forwards upstream idle/permission/authorization through `onSessionEvent({ sessionId, reason })`, completed-step cumulative usage through `recordUsage({ sessionId, total })`, and PR/provider notices through `receiveFeedback(projectId, itemId, { eventId, text })`. A `bot.wake` event refreshes one project. `handleTool({ sessionId, action, input })` accepts only the authenticated current fixing session; the host must take the session ID from its authenticated tool context. `start()` returns per-project recovery failures without blocking unrelated projects.

## HTTP

`registerBotRoutes(app, { botsRuntime, identities })` registers authenticated OpenChamber routes before the generic OpenCode proxy. Identity responses use the identity store's public methods only.

- `GET /api/projects/:projectId/bots` returns `{ config, revision, items, presets }`.
- `GET|PUT .../config`, PUT body `{ config }`.
- `POST .../:botId/run`, body `{ occurrence? }`.
- `GET|POST .../items`, POST body `{ botId, source, title, description?, evidence? }`.
- `GET .../items/:itemId` includes the complete proof, absence reason, judgment, evidence and retained stage reports/diff for active or archived items. Archived inspection never starts a stage or reads a provider; mutations remain restricted to active items.
- `POST .../items/:itemId/answer`, body `{ text, eventId }`.
- `POST .../items/:itemId/resume`, body `{}`. Repairs a pending tool request under the original logical key after proven pre-dispatch failure, or reconciles its original uncertain effect by reads. It cannot re-send ambiguous writes.
- `POST .../items/:itemId/stop`, body `{}`.
- `GET .../archive?month=YYYY-MM`.
- `GET .../policy`; `POST .../policy/approve`, body `{ file, fingerprint }`.
- `GET|POST .../identities`; `PUT|DELETE .../identities/:identityId`, expected revision required for mutations.

## Invariants

- Project work is serialized under an execution-owner lock. Item and descriptor file locks are short and separate. No remote operation runs while the item file lock is held.
- A new checkout resolves its selected GitHub binding through `serviceContext` with `github.checkout` before admitting a worktree effect. Missing identity or credentials leave no captured request or uncertain checkout, so explicit Resume can use repaired configuration and Stop can finish. Existing effects keep their original request and reconciliation rules.
- `prepared` may dispatch once. `effects.run` accepts `executePrepared(request, claimDispatch)` for service execution: authorization failure before `claimDispatch` leaves the effect prepared. Local executors use the ordinary `execute` path. Persisted `dispatching` and `outcome-unknown` only reconcile; they never receive a replacement key. Terminal refused effects remain immutable.
- Tool mutations persist their canonical request in private `pendingTool` before service preparation. Failure produces durable attention; restart restores attention if the process stopped before that transition. Resume owns safe repair under the project execution lock. A prepared request requires explicit Resume after repair, and the model cannot replace it with another operation ID or changed content.
- Repair preserves captured identity revisions and destination authority. It does not silently reassociate an existing request with a replacement identity. Stop can refuse an unexecuted prepared tool and clear its pending intent; dispatched or unknown tools retain their receipts and continue to block cleanup.
- Every item effect with a dispatching or unknown outcome blocks fresh external work for that item, even when no pending-tool pointer exists. Existing keys can replay receipts or reconcile through reads using captured input. Pending remote revocation retains its separate cancellation authority and remains executable while unrelated uncertain effects block new work. Other items remain independent.
- Stage session IDs persist before prompts. Stage outcomes use `readDispatchOutcome` after authoritative activity checks. Read failure never supplies empty success.
- A pending question intent restores its waiting projection before ordinary stage progression after restart. Waiting questions are retried only by explicit Resume. Retry preserves separate `needs-you` attention and checks current bot enablement and token budgets. A provider reply never performs automatic Resume of authorization, permission or budget attention.
- Answer delivery is deduplicated under the project owner lock. Each feedback event captures the pending question key, so replaying an old answer cannot clear a newer question. Only `questions.answered` clears the pending pointer. UI answers and Stop refuse only the exact original prepared question effect; dispatching or unknown effects remain blocking.
- `data.questionAnswer` records the answered question's original resume state and fixed next judge round before pointer settlement. Restart finishes the transition and clears that coordinator-owned intent without repeating feedback or incrementing the round twice. A separate `needs-you` state remains until explicit Resume after the question is settled. Stop keeps its execution intent authoritative over any answer continuation.
- Configured concurrency limits active items. Daily token and pending-human limits gate admission. Goal exhaustion produces recoverable attention.
- A usage-triggered interruption records the owning run and session before stopping it. After budget repair, explicit Resume restores the captured placement and access, reconciles any uncertain original prompt through reads, and persists a new attempt round before re-entering an incomplete stage. Completed stage output is reused. The original run, session receipts and worktree stay retained; the continuation uses the same captured space even if the current isolation switch changed. Ordinary dispatch never starts a stopped binding.
- Fixed human paths override judge output. Re-reading the exact head/base and policy fingerprint precedes merge authorization. The private admission generation and effect descriptor capture the PR, owned branch, head, base, policy fingerprint, round, mode and exact service binding. The key hashes that tuple, so unchanged-head reauthorization cannot replay an earlier generation's receipt.
- Merge writes only enable GitHub auto-merge or queue admission. Closure operations have separate durable keys. A failed closure preserves the merged PR and its successful receipts. Authoritative merge observation retires active admission before closure. A persisted closing item resumes closure without revoking that already-observed merge. Captured Jira transition requests replay before any current transition lookup, even if the transition is no longer offered or configured.
- Stop blocks unrelated prepared, dispatching and unknown effects. Its exact `<itemId>:cleanup` worktree removal can recover through its original journal request. Both Stop and merged closure reconcile uncertain cleanup without another removal, retaining the captured bot and checkout across later configuration changes.
- Production cleanup removes the isolated space before the host checkout. The binding journals `removing` before archival, then records `removed` or a known `remove-failed` result. Reconciliation can confirm a lost successful receipt only through authoritative absence across all places; known partial failures stay blocking. Checkout removal can finish idempotently after the space is gone. Both owners must finish before the cleanup effect succeeds.
- Observed head/base/policy invalidation, disable and item stop persist `revoking` before clearing judgment, delivering new correction feedback, pushing or cleaning up. Recovery runs before human-wait and disabled-bot skips. Prepared admissions become refused; dispatched admissions only reconcile. Both cancellation effects retain separate generation-bound keys, and the final authoritative read must observe both remote flags absent. Failed reads preserve revocation intent and produce "Remote auto-merge may still be active" attention.
- Unknown original admission dispatch remains blocking even when cancellation reads find no authorization. A still-in-flight admission cannot be disproved by absent flags. Explicit stop retains its intent across restart and cannot finish cleanup until all effects settle. A merge observed during cancellation is recorded as `merged`, with its actual remote observation; ordinary merge ownership can close, while a stopped owner requires attention and retains its checkout.
- Isolation is fail-closed. An unavailable isolated adapter never falls back to a host session.

## Runtimes

| Runtime | Behavior |
|---|---|
| Web | Server executes and persists the coordinator. |
| Electron | Uses the same in-process server. |
| Hosted mobile | Calls authenticated server routes. |
| Capacitor mobile | Calls authenticated server routes. |
| VS Code | Unsupported; no bot runtime is constructed. |

## Decisions

### Why immutable descriptors precede effect admission

The compact item schema records authority and receipts. Recovery also needs the exact provider request. A separate private journal retains that request without changing the storage worker's schema; writing it first makes a crash leave harmless unadmitted data.

### Why unknown dispatches require reconciliation

A lost response does not establish whether a provider wrote anything. Reusing the captured request for authoritative reads preserves the original key and prevents duplicate comments, PRs and merge requests.

### Why service authorization precedes dispatch admission

Missing credentials or denied destination policy can be repaired before a content executor starts. Keeping the effect prepared through those checks lets explicit Resume repair the same request without rewriting a terminal refusal or inventing a replacement mutation key. Once the content executor is entered, failures remain conservative and require reconciliation.

### Why authorization is revoked on observed invalidation

GitHub admission checks the expected head once. The approved contract freshly verifies the complete tuple before admission and blocks further work while observed invalidation or stop is being revoked. GitHub can still merge before cancellation arrives or while the host is offline. These APIs provide no continuing lease over the base or local policy, and direct merge cannot close that race.

### Why pending source discovery is an explicit dependency

JQL has an existing provider read. General MCP discovery needs a persisted source-session owner and admission lifecycle. A required `discover` adapter makes that integration visible and prevents a silent empty-source response when it is unavailable.

### Why service context is scoped to an operation

A Jira transition needs a current destination status, while comments and polling need only the exact issue and identity. Resolving every configured service for every operation let an unrelated Discord destination or a completed Jira transition block GitHub work and closure recovery. Persisted operation descriptors already own replay authority and bypass fresh destination discovery.

### Why answering retains a continuation intent

The question owner settles its pointer separately from the coordinator's stage transition. A crash between those writes must not strand an answered item in `waiting-answer`. The coordinator retains the exact target and next round until the transition commits; feedback-to-question attribution also prevents a delivered answer's replay from settling a later question.

## Validation boundary

`runtime.test.js` and `runtime-driver.mjs` exercise the actual item store, private disk journal, config parser, policy reader, HTTP routes, `createOpenChamberSessionService`, stage adapter and `readDispatchOutcome`. The fixture injects deterministic OpenCode clients and process/provider adapters. It performs no live Git publication, Jira/Discord write, Docker isolation, GitHub signature verification or packaged-app check. Those checks belong to production adapter wiring and are not established by this driver.

`merge-authorization.test.js` and `merge-authorization.driver.mjs` add the real identity resolver, GitHub HTTP adapter and source-control mutation/audit journals. Controlled upstreams prove revocation after head/base/policy changes, separate remote flags, unchanged-head generations, stop, disabled recovery, enterprise refusal, ambiguous writes and a merge winning cancellation. The tests also cover stale prepared admissions and the final provider dispatch guard. Live GitHub auto-merge and queue behavior still require authorized QA with the composed production host.

`tool-dispatch.test.js` and `tool-dispatch.driver.mjs` use those real runtime and provider owners to verify changed/new-key refusal after a lost response, read-only original-key recovery, explicit same-key repair after identity/policy/context failure, crash attention and item independence. OpenCode and GitHub peers are controlled fixtures. These checks establish local dispatch and journal behavior; they do not establish live provider authentication or host route composition.

The runtime does not register itself. `host.js` constructs every required production owner and `server/index.js` installs its routes, managed tool and lifecycle. [host-composition.md](host-composition.md) defines that wiring and its validation boundary. `reportAttention({ projectId, itemId, reason })` lets the host report a source/provider failure through the existing transition owner. Production `sources.usage({ projectId, botId, day })` supplies discovery's complete daily total to budget admission; an incomplete ledger cannot authorize a known-zero budget.
