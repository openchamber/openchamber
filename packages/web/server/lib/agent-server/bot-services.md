# Bot execution services

## Ownership

The owner front door owns the complete Bot coordinator, placement, questions,
discovery, provider event journals, scheduling and PR-watch lifecycle. The agent
executes named operations against registered parent projects and private Bot
checkouts. This transport uses the existing authenticated loopback upstream.
Provider adapters retain their existing enterprise destination checks.

## Integration

`createAgentBotServices(upstream, { dataDir, resolveProject, listProjects, readItem, readBot })`
returns `identities`, `context`, `worktrees`, `stages`, `services`,
`readSessionDefaults`, `sessionKnowledgeRuntime`, `readSession`, `readTokens`,
`isWorking`, `runProof`, `readPolicyFiles`, `blame`, `readPullStatus`, `botWatch`,
`pullRequests`, `hostSessions`, `createGateway`, `tools` and `deliverSynthetic`.
The top-level `readFeedback`, `readAuthorPermission` and `readFailedChecks` methods
are aliases of the corresponding `botWatch` methods.

`bindOwner({ dataDir, resolveProject, listProjects, store, config })` installs these
readers after host construction. `readItem(projectId, itemId)` returns the owner's
item or null; `readBot(projectId, botId)` returns its definition or null. Calls with
`{ project, bot, item }` capture those values directly. Provider service calls
resolve their existing `botId/itemId` through the owner registry. Provider reads
must supply an additional `scope: { project, bot, item }`; the scope remains
outside the existing provider input schema. A selected service binding alone
cannot identify a registered parent.

`dataDir` is the owner's data directory. Every scope and watch read loads its exact
project/item entry through `readTrustedBotMigrationPaths({ dataDir })`. Only that
local control copy supplies `trustedMigrationPath`; the agent mirror is never
read by the client. A caller-supplied mapping that differs from the local copy
refuses. Mapping data travels separately from prepared effects and BotAuthority.

Identity methods retain their global public signatures. Each request names the
first known local registered project, without reading other project directories.
Every agent operation verifies both the registered project ID and canonical path.

Stage methods retain the local adapter signatures. The client resolves the
registered parent from `projectId` and checks the supplied directory against the
captured item checkout. Discovery stages use only that registered parent.
`stages.create(request, onCreated)` invokes `onCreated` locally after the checked
agent response. Agent persistence records allocation before configuration.
Completed stage outcomes require a complete token count. Failed and cancelled
outcomes may omit it, including a provider refusal before inference starts.
Omitted usage is preserved as unknown rather than replaced by zero; the owner
classifies that terminal failure before considering an explicit retry round.

`services.execute(effect, input, { beforeAdmission, beforeDispatch })` performs
agent preflight, then both local callbacks in that order, then exact agent
execution. Callbacks never serialize. Owner question and approved-DM checks run
before these service calls. The agent constructs its provider executor with
`ownerAuthorityChecked: true` only in the separated authenticated composition.
The client recomputes the prepared input digest using the existing service
descriptor fields and parsed operation input before preflight or either callback.
Prepared replies also retain the selected identity's credential revision.
Reconciliation retains the descriptor's original selected identity after a Bot
default changes. It never substitutes that new default or rewrites the digest.

Context requests capture public identity metadata and the exact service target.
Replies contain only the requested service. GitHub account replies also confirm
the selected account ID and credential revision; the client removes those extra
wire checks before returning the existing binding shape to callers.

`botWatch.getOctokit(authority)` returns an inert `{ botAuthority }` handle.
The feedback owner dispatches this handle to `botWatch.readFeedback`,
`readAuthorPermission` and `readFailedChecks`.
`authorizeApp(authority, author, selectedApprovedApp)` verifies the owner's selected
approved review app using the selected Bot identity.
The handle exposes no HTTP or GraphQL method.
Each watch request separately captures its expected owner-recorded checkout
directory and trusted migration path. Neither field is added to BotAuthority.

`hostSessions` exposes `readSession(entry)`, `isWorking(entry)`,
`readTokens(entry, options)`, `syncKnowledge(entry, options)`,
`deliverNotice({ ...entry, id, text, notice })`, `pullTools(entry)` and
`settleTool(entry, settlement)`. Entries carry `projectId`, `botId`, `itemId`,
`stage`, `sessionId` and the captured host `directory`.

`sessionKnowledgeRuntime.collect(directory)` resolves only a registered parent or
an exact checkout in the owner's item store. An unknown directory refuses.

`createBotExecutionServices({ agentServer: true, ...deps })` constructs inert agent execution owners.
`registerBotServiceRoutes(app, { services })` mounts their private typed routes
after API authentication, only when the composition explicitly constructs these
agent services. The front-door gate must refuse the entire private namespace.
The factory is also re-exported from `bot-service-routes.js`. Agent execution
exposes `handleTool(request, options)`, `stop()` and an internal
`worktrees.resolveTransferSource(source, { trustedMigrationPath })` for the existing
Spaces transfer owner.

Checkout validation delegates to that production resolver, including its reviewed
migration-path mapping. Source tuples contain only parent project identity,
Bot/item identity and the original checkout key. Adoption forwards the exact
`spaceId` to the checkout owner's transfer-association check and preserves its
interrupted-adoption recovery.

Provider execution and PR reads construct per-request publication resolvers over
the same mutation/audit files and process identity. The resolver forwards that
request's exact migration mapping, including publication reads after checkout
removal. Concurrent requests share no mutable current-scope variable.
Removal, removal reconciliation and publication-history reads can reach their
durable checkout journal after the mapped directory is gone. They grant no Git
trust to a missing directory; every operation that needs a live checkout still
requires its exact physical identities. A replacement or redirected path remains
refused, including during cleanup recovery.

`stop()` refuses new execution, cancels every active proof controller, closes
Gateway connections and awaits proof cleanup. Cleanup has a 30-second shutdown
deadline. Failure or timeout rejects shutdown; an unfinished proof promise and its
owned files are retained rather than reported as cleaned. This deadline is a
one-shot operation bound; the agent has no coordinator or polling timer.

## Discord transport

`createGateway({ project, bot, identityId, identityRevision, channels, people,
eventStore, deliver, onError })` retains the existing Gateway lifecycle interface.
The owner owns its event store, approved routing, heartbeat and reconnect timers.
Agent operations are `gateway-open`, `gateway-pull`, `gateway-send` and
`gateway-close`. They carry a captured connection ID and accept only identify,
resume and heartbeat protocol sends. The agent inserts the selected Discord token
at the socket write. Replies contain typed credential-free protocol frames.

Agent connections retain at most 128 frames of at most 128 KiB. Pulls return at
most 16 frames and retain them until a later request acknowledges their IDs.
Acknowledgement follows durable owner admission and delivery. Agent shutdown
calls `stop()` to close these sockets. It never reconnects them.

Pulls carry `after`, the last completely delivered frame, and optional `observed`,
the last frame the owner read. Omitted `observed` defaults to `after`. Observation
must be at least `after` and cannot exceed the agent's latest frame ID. It selects
the next page without releasing retained frames. The owner handles protocol
control immediately and serializes durable work in frame order; only completed
work advances `after`. Close, reconnect and Stop wait for that work. Failed work
leaves its frame unacknowledged and recovery drains the journal before resuming.

## Invariants

- Every reply carries the exact captured request association. The client checks
  it before using the bounded reconstructed operation result.
- Registered parent validation uses `registeredTransferDirectory`. Child
  directories are authorized only through the private checkout owner and captured
  project/Bot/item/create key. A directory string grants no authority.
- Identity responses contain public metadata only. Service contexts contain
  opaque identity revisions and typed destinations only.
- Tool settlements reconstruct the existing item, question and compact receipt
  contracts. Valid item text retains its full contract limit; an oversized or
  unknown structured result refuses without truncation or a generic JSON fallback.
- Proof cancellation aborts the agent's existing proof runner. It never creates
  an arbitrary command endpoint; its command and arguments must equal the captured
  Bot proof configuration and its commits belong to the exact checkout.
- Policy responses carry bounded raw bytes and explicit missing/unreadable states.
  The owner computes fingerprints and approval authority.
- The agent retains execution receipts and protocol connections only. It runs no
  Bot coordinator, discovery, provider polling or reconnect timers.

## Decisions

### Why callbacks remain in the owner

Durable dispatch admission and question selection require current owner state.
A preflight request establishes agent credential and publication readiness before
the owner claims dispatch; the subsequent request repeats exact descriptor checks.

### Why checkout ownership travels separately from operation arguments

A proof command, service input directory or stage session can otherwise select an
unrelated checkout. The captured association identifies the private owner that
must authorize each operation before its arguments reach existing adapters.

### Why Discord protocol transport stays in the agent

Discord's identify and resume frames require its private token. Narrow protocol
operations let the owner retain all routing and lifecycle decisions while the
agent keeps that token at the outbound socket boundary.

### Why frame observation is separate from acknowledgement

Waiting for durable delivery in the frame reader prevents the owner from seeing
heartbeat ACKs behind a slow message. An observation cursor lets that reader
continue while the ordered worker retains delivery authority. The agent's
128-frame unacknowledged bound also bounds queued owner work, so reading ahead
does not create an unbounded queue or acknowledge an undelivered message.

### Why publication resolvers are request-local

Migration authority belongs to a captured project/item request. A shared mutable
scope could apply one concurrent request's retained path to another effect or
watch. Separate resolver closures keep the original immutable descriptors intact.

## Validation

`bot-services.test.js` exercises the HTTP boundary, captured association and SHA
checks, callback ordering, exact checkout/session ownership, allocation recovery,
proof cancellation and bounded shutdown, trusted migration propagation,
concurrent publication callbacks, account-context substitution refusal, tool
inbox settlement, synthetic delivery and Discord frame acknowledgement. Native
service adapters produce the tested descriptors and receipts under disposable
provider fixtures. A long native Bot item reply reproduced the old generic JSON
limit failure and passes through the explicit result schema. Socket credentials
are disposable fixtures.
This file does not establish live provider permissions, Docker isolation, Git
checkout materialization or process-level migration behavior.

`bot-owner-gateway.test.js` executes both gateway owners with typed request/reply
validation and disposable socket credentials. Its held admission and delivery
cases advance a deterministic clock across 3 heartbeat intervals, check ACK and
heartbeat-request handling, then release delivery and check ordered events and
delayed acknowledgement. It also covers close and invalid-session recovery,
delivery failure, Stop during a held delivery, pull cancellation, retained-frame
replay and the 128-frame bound. From the repository root, run
`bun run --cwd packages/web test server/lib/agent-server/bot-owner-gateway.test.js --maxWorkers 1`.
The peer socket and clock are controlled; this proves no live Discord connection.

## Runtimes

Web, Electron, hosted mobile and Capacitor use the same server boundary. VS Code
has no Bot backend. Single-account construction keeps its existing local owners.
