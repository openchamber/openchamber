# Discovery, isolated stages and provider lifecycle

## Ownership

`discovery.js` owns one read-only source investigation per project, bot and scheduled occurrence, including its cumulative and daily token ledger. `isolated-stages.js` owns the durable item-to-space and session bindings, dispatch through the spaces dispatcher, and proof execution inside that space. `isolated-tools.js` owns the child tool inbox; the host keeps a separate tool receipt journal. `provider-runtime.js` owns outbound Jira polling and Discord Gateway lifecycles. `adapter-state.js` owns their private, schema-checked, atomic records under `<dataDir>/bots/`. It separates short record locks from execution-owner locks. No credentials belong in those records.

The coordinator owns candidate admission, item transitions, attention, schedules and service writes. The worktree adapter owns adopting a quarantined isolated result into its checkout. Spaces owns container hardening, code transfer, grants and the authenticated dispatcher. The child inbox routes use its server's existing authenticated listener.

| Runtime | Behavior |
|---|---|
| Web | The server owns discovery, provider events, isolated execution and tool receipts. |
| Electron desktop | The in-process web server uses the same owners and contracts. |
| VS Code | Bots and isolated spaces remain unsupported. |
| Hosted mobile | Calls its connected server; no local worker or credential resolution. |
| Capacitor mobile | Calls its connected server; no local worker or credential resolution. |

## Constructor contract for index

```js
const isolated = createBotIsolatedStages({
  dataDir,
  getSpacesHost,       // Current spaces host, or null while disabled. Resolve at use time.
  resolveProject,      // projectId -> { id, path }
  sessionKnowledgeRuntime, // Existing owner, including collect(directory)
  handleTool: (request) => botsRuntime.handleTool(request), // Host coordinator only
});

const stages = createBotStageSessions({
  sessionService, clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime,
  activityProbe, readSessionDefaults, readTokenSnapshot, isolated,
});

const discovery = createBotDiscovery({
  dataDir, stages,
  onReady,     // ({ projectId, botId, occurrence }) -> rerun that same occurrence
  onAttention, // ({ projectId, botId, occurrence, sessionId, reason, state }) -> durable attention
});

const providerRuntime = createBotProviderRuntime({
  dataDir, config, store, identities, services, runtime,
  listProjects, resolveProject, serviceContext,
  onNeedsYou,         // ({ projectId?, botId?, itemId?, reason, state }) -> durable attention
});

const sources = createBotSources({
  services,
  resolveJiraContext: providerRuntime.resolveJiraContext,
  discover: discovery.discover,
});

// Pass this function to createBotServiceContext. It reads persisted channel
// choices and conversation links, and refuses missing or ambiguous targets.
const resolveDiscordTarget = providerRuntime.resolveDiscordTarget;

const proof = createBotProofRunner({
  root: ownedProofRoot,
  executeIsolatedProof: isolated.executeIsolatedProof,
});
```

Construction can use thin forwarding closures for the coordinator cycle. Resolve `runtime` at call time through `admit`, `pump` and `receiveFeedback`; do not start providers until the coordinator exists and has recovered its item/session index.

Production composition injects `resolveSpaceOptions: ({ bot, selection }) => readBotSpaceOptions(bot.space, selection)`. The bot explicitly selects its place, network and model-access references. Each stage receives only its selected provider's grant and no setup commands. A missing selected grant produces `BOT_ISOLATED_MODEL_GRANT_REQUIRED`; nothing is inherited from host logins or other spaces. Later stages can add their explicitly selected provider through `journey.grantAccess`. The standalone `resolveBotSpaceOptions` resolver remains available to existing adapter fixtures and is not used by the running host.

The Jira source is the user's arbitrary JQL. Its context is `{ identityId, identityRevision, site }`, with the site supplied by that selected identity. `sources.jira` sends `jira.search` with `target: {}` and preserves the JQL exactly, including `ORDER BY`. Candidates may belong to different projects. Writes derive `{ projectKey, issueKey }` from the admitted issue key through the existing service-context owner. The service owner must accept the site-wide read target and stop rewriting the JQL; the exact required adjustment is in [jira-search-integration.md](./jira-search-integration.md).

Discord configuration is persisted with each definition as `discord: { channels: [{ guildId, channelId }] }`. Existing definitions default to `{ channels: [] }`. Both IDs are decimal snowflake strings, never numbers, and duplicate guild/channel pairs are invalid. The existing Gateway's 100-channel bound applies. The provider runtime reads this configuration through its private `readBotDiscordConfig({ bot })` helper. The editor owner adds those 2 ID fields and saves the whole `discord` value. An empty list disables channel mentions and leaves only DMs from approved people eligible.

An API-key provider requires an explicit per-bot environment-backed model grant. Custom-provider and login grants also require explicit per-bot selection and resolve through their existing spaces owners. The saved config contains references only. New executions use the new config; an existing item's recorded space retains its own lifecycle.

### Source pending contract

Call `sources.investigate({ project, bot, occurrence, maxItems: bot.source.maxItems })`. The explicit positive `maxItems` must equal the captured source limit. The adapter returns parsed, source-ID-deduplicated candidates only after a completed authoritative turn. It applies no additional item cap.

A pending investigation rejects with `BotDiscoveryPending`, `code: 'BOT_DISCOVERY_PENDING'`, `status: 202` and `pending: { projectId, botId, occurrence, dispatchKey, sessionId }`. `createBotSources.investigate` preserves that error. The coordinator must recognize it as pending and retain the occurrence. It must not turn it into `[]`, mark the scan skipped, or generate a replacement occurrence. `onReady` schedules the same occurrence again. Keep HTTP and scheduler acknowledgement separate from the eventual candidate list.

The route owner handles this tag before its ordinary 4xx/5xx error conversion and returns HTTP 202 with `{ pending: true, ...error.pending }`. A 202 must not pass through the current error-status clamp, which converts it to 500. The scheduler owner records a pending occurrence as admitted, then lets `onReady` resume it. These changes belong to runtime/routes composition.

`discovery.start()` wakes recorded unfinished occurrences after restart. Feed authoritative idle, permission and authorization through `discovery.onSessionEvent({ sessionId, reason })`. `stop()` stops routing new wakes; it leaves sessions running through normal server shutdown. `stopRun({ project, bot, occurrence })` explicitly stops one run after confirming its stage owner stopped. Reconfiguration uses `reconfigure()` to wake existing occurrences without changing their captured requests.

The discovery stage uses `bot.models.investigation`, `botStagePermissions`, ask-mode permission handling, and automation metadata with source `bot` and stage `investigation`. Files and shell are read-only; MCP tools follow the user's explicit per-tool choices. Managed memory writing stays denied. Knowledge sync requests `includeMemorySaveRule: false`.

The existing host `sessionService.send()` performs another knowledge sync with its default options. Index must supply discovery's stages with a read-only session-service knowledge adapter that forwards `sync(id, directory)` to `sessionKnowledgeRuntime.sync(id, directory, { includeMemorySaveRule: false })`, or the session-service owner must preserve that option for read-only automation. The permission denial already prevents a memory write, but the default sync otherwise reintroduces the instruction to save memory. Isolated stages send through the SDK and do not perform that second sync.

### Discovery token ledger

Forward cumulative completed-step usage, including cache usage, to `discovery.recordUsage({ sessionId, total, at? })` alongside the item runtime's existing usage hook. `at` is the authoritative step timestamp when available; otherwise the host clock supplies the UTC day. An unknown session returns `{ tracked: false }`. A tracked session persists only a positive cumulative delta; duplicate or older totals do not charge again. The completed outcome also records its final snapshot before parsing output, so a failed investigation or invalid candidate JSON still spends tokens. Events received after that final snapshot cannot attribute a later manual turn to the discovery.

`discovery.usage({ projectId, botId, day? })` returns `{ total, byDay, day, dailyTotal, complete }`. The default day is UTC, matching the item runtime. `complete` is false when an older record has no usage ledger; that case cannot authorize a known-zero budget. These are the recorded cumulative counts for discovery, separate from the item ledger. The coordinator adds `dailyTotal` to that bot's item usage when checking its daily limit, and preserves the normal live completed-step accounting semantics. It must not charge the aggregate into every admitted item. Corrupt or unreadable ledgers throw. No history is silently evicted.

### Isolated stage contract

Pass `isolated` unchanged to `createBotStageSessions`. It implements `create`, `dispatch`, `outcome`, `reconcile`, `stop` and the explicit `resume` hook. `create` records a space allocation before containers can start, copies the owned item checkout through code-in, then records a deterministic session ID before the SDK create and the coordinator callback. Prompt IDs are deterministic per recorded session/run, so dispatcher transport retries cannot create a second prompt.

`createSpaceJourney.createBotSpace(request, { sourceDirectory, onAllocated })` is server-only. The registered project supplies label ownership and authorization. The caller verifies `sourceDirectory` as the item's owned checkout; that checkout supplies the copied code, history and eventual code-out target. HTTP routes pass only their ordinary request and cannot supply either internal option. Failed allocation persistence creates no container. The existing journey retains its create rollback and grant-restoration behavior.

`outcome` reads active execution and descendants, then uses `readDispatchOutcome`. It returns null while pending. Failed activity, body reads or complete cache-inclusive token reads fail. Fixing goal budgets are armed in the space server's metadata and synthetic goal reminder. `stop` is an interruption that keeps files, placement and session IDs. It records `stopping` before stopping the entire container, then confirms `exited` before recording `stopped`. A lost acknowledgement retains the interruption intent across restart. Terminal checkout cleanup separately calls `remove`; `stop` alone does not authorize deletion. No isolated operation calls a host session owner.

`stages.resume({ ...capturedRun, sessionId })` belongs only to the coordinator's explicit Resume operation, after enabled/budget/Stop checks and before releasing the item back to execution. The request includes the original project/item IDs, host directory, bot snapshot with explicit `space.grants`, stage, selected model and recorded session ID. Composition resolves captured placement before forwarding it. Host placement needs no container operation. Isolated Resume checks the binding and session, records `resuming`, calls `journey.startSpace` for readiness and recorded network restoration, and re-grants only the selected provider through `journey.grantAccess`. It reads live access and verifies hardening before recording `ready`. This hook sends no prompt, creates no session and allocates no replacement space. The coordinator owns continuation and prompt-effect reconciliation.

Resume failures retain `resuming` or the previous interrupted state and require another explicit Resume. Ordinary create, dispatch, outcome, proof, notice reads and startup never recover an interrupted container implicitly. Resume reads explicit bot access references through `readBotSpaceOptions`; it does not invoke the standalone resolver that can inspect ambient logins or other spaces. Existing version-1 bindings remain readable without conversion.

Removal records `removing` before the archival journey. A successful receipt records `removed`; repeated Stop of that binding needs no Spaces host. If the journey acknowledgement or binding receipt is lost, Stop and removal reconcile the intent against `manager.listAllSpaces`. Only authoritative absence with every place available confirms removal. Failed reads and unavailable places preserve the intent. A missing space without removal intent cannot confirm Stop. A returned partial-removal failure records `remove-failed`; absence then cannot erase that known failure, which still requires inspection. A remaining space can retry the archival journey. Lifecycle mutations use the same item owner lock so Stop cannot overwrite a concurrent removal receipt.

`executeIsolatedProof(input, { signal })` looks up exactly one binding by the proof runner's recorded host checkout. It sends a fixed Node program and JSON input through `manager.exec` to that space. Git creates separate detached snapshots for the test and fix SHAs. The command runs as an argv, without a shell, with `{files}` expanded from the test commit. Missing commands, signals, output limits and snapshot cleanup failures are inconclusive. The proof never checks out or resets the agent's checkout. The outer container command has a 300-second limit and the host call a 330-second limit. A caller's abort is checked before and after execution; Docker exec currently does not forward that signal to its runner, so it cannot promise immediate cancellation inside the container.

`isolated.exportSnapshot({ projectId, itemId })` delegates to the existing code-out quarantine and returns `{ spaceId, directory, repository, resultSha }`. The production worktree owner's `adoptIsolated({ project, bot, item, resultSha })` adopts that verified result before host-side inspection/publication. Reading the unchanged host worktree as the isolated fix would be incorrect. `bindingFor(request)` resolves a recorded binding by item, session or unique host checkout. It exposes no secret. SDK create/get record answers pass through `unwrapOpenCodeResponse` before their identity or metadata is trusted.

### Isolated bot tool channel

On a server running inside a space, `createBotChildServer` constructs `createBotIsolatedToolInbox({ dataDir, onPending })` and mounts `registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace })` after that server's existing API UI-auth gate. The host refuses these paths before its proxy. No listener is added. The child managed bot callback calls `inbox.request({ sessionId, callId, action, input }, { signal })`; `callId` and the abort signal come from the authenticated agent-tool context through `executeBotAction`.

`onPending({ sessionId, requestId })` uses the child's existing metadata writer to merge `openchamber.botToolPending: requestId` into that session. The request is on disk before that update emits its ordinary `session.updated` event. The host follows space events on its existing hub and calls `isolated.forwardTools({ spaceId, sessionId })` for that marker. Take `spaceId` from the host's space event connection, never from an agent payload. At startup/reconnect, call the same operation for active fixing sessions from the authoritative item store. Do not scan historical sessions or invoke it inside a project execution lock that `handleTool` itself needs.

The host pulls `GET /api/openchamber/bots/isolated-tools?sessionId=...` through the existing dispatcher and sends settlements to `POST /api/openchamber/bots/isolated-tools/settle`. The child server's own login cookie authenticates these inward requests. No host managed-tool token or service credential enters the container. The response envelope is `{ requests: [{ id, request: { sessionId, callId, action, input } }] }`; `id` is the canonical digest of `{ sessionId, callId }`. A page may hold at most 100 pending calls and must fit the existing bounded transport. An invalid page is refused before a host action.

`forwardTools` requires a recorded matching space, a recorded fixing-session ID, matching session metadata and directory, then delegates only `{ sessionId, action, input }` to the host coordinator. It validates every request's session and digest before executing any request from the page. The coordinator remains the authority for the current fixing session, item state, operation ID and service destination. The child is hostile and may replace its server; a matching child response grants no authority beyond that host binding.

The host persists `dispatching` before calling the coordinator and a compact, sanitized reply before acknowledging it in the child. Lost acknowledgements replay the recorded reply. A host crash with only `dispatching` recorded yields `BOT_ISOLATED_TOOL_OUTCOME_UNKNOWN` and needs-you; it never silently repeats the action. Replies contain only JSON coordinator results or `{ code, status, state }`, with no raw upstream body. Child calls and settlements are immutable, survive restart and preserve unknown outcomes. Aborting a waiting child request preserves the pending record. The child server uses local waiters while a call is open and performs no periodic polling.

These child routes and callback wiring must be present in the tools package that actually runs in the space. A dev run against cached published tools does not test the edited server; use the existing packed-tools workflow for that QA.

### Provider lifecycle contract

Start the coordinator first, then `providerRuntime.start()` and `discovery.start()`. Start returns per-project provider failures while unrelated projects continue. `providerRuntime.stop()` clears its timer, waits for in-flight work and configuration, then closes its Gateways. Call `reconfigure()` after bot, identity, channel or approved-people changes. A repeated unchanged configuration keeps its Gateway. `tick()` is a deterministic manual polling entrypoint and coalesces overlapping ticks.

Jira polls only enabled bots' active Jira-origin items, through `serviceContext({ project, bot, item, service: 'jira', operation: 'jira.comments' })` and `services.read('jira.comments')` with the selected current identity revision. Polling does not resolve Discord destinations or the configured Done transition. Permanent authorization failures stop polling that item until explicit reconfiguration. Each item has its own event-store consumer scope, so two bots watching the same issue both receive the comment once. Jira discovery resolves the selected public identity and site and uses the existing paged source adapter.

Discord uses the existing outbound Gateway. Configured-channel mentions and DMs from the currently machine-approved people file are eligible. Delivery rechecks current channels, identity revision and people approval. A reference to a recorded root message reaches that active item's feedback. A DM with one active conversation continues that item. A new eligible message admits an `alert` source with stable `discord:<messageId>` identity, records its conversation link, then pumps the project. Repeated admission after a crash uses the coordinator's source deduplication. Each bot has a separate event-store consumer scope.

`providerRuntime.resolveDiscordTarget({ project, bot, item })` reads the current persisted bot and selected identity. One linked conversation supplies its captured channel, and a linked DM also supplies the captured recipient ID, rechecked against the currently approved people file. An item without a conversation link uses exactly one configured channel. Missing, removed or ambiguous destinations produce needs-you. A link whose identity revision changed requires review and cannot redirect to the configured fallback channel. An older DM link without a captured recipient is not sufficient to send.

The Gateway and Jira reader persist the cursor and pending event before invoking delivery. Delivery failures leave the event pending. The provider reads the current item before delivering a reply. `waiting-answer` uses the coordinator's `answer` transition; other states use `receiveFeedback`. Authorization and uncertain-effect attention require explicit recovery and cannot be cleared by a comment. The coordinator durably deduplicates the event ID. Its notice adapter must handle feedback received before an item has a session.

All provider writes remain owned by `createBotServices`, including enterprise destination enforcement. These lifecycle adapters perform provider reads and inbound-to-local admission only. They create no exposure or provider credential entry path.

## Invariants

- Only a missing private record means no record. Malformed JSON, schema failures and read errors cannot authorize replacement, completion or another send.
- Discovery's session identity and dispatch key are durable before its prompt. Ambiguous dispatches only reconcile through activity and outcome reads.
- Completed empty discovery and pending discovery are distinct. A new source limit does not rewrite an already captured occurrence.
- Isolation defaults off in the existing bot schema. When selected, a disabled spaces host, failed Docker operation, missing grant, failed verification or lost binding produces needs-you. No host fallback exists.
- Grants name only host-owned sources. Jira, Discord and GitHub tokens never enter the bindings, knowledge transport or space creation envelope.
- Event cursor identity includes provider identity revision and the consuming item or bot. One consumer's receipt cannot suppress another's delivery.
- Provider authorization failure produces attention. A failed read never supplies an authoritative empty candidate or comment list.

## Decisions

### Why pending discovery is an error with a durable occurrence

The existing source interface returns a candidate array. A tagged pending error preserves that interface and lets the scheduler acknowledge work without treating an unfinished investigation as a successful empty scan.

### Why server workers reuse the spaces journey

The journey already owns verified creation, code-in, grant restoration and rollback. An internal allocation callback lets the bot persist identity before those effects without duplicating container lifecycle code or exposing worktree overrides through HTTP.

### Why Resume owns container recovery

A budget interruption keeps the existing space and session. An explicit Resume restores readiness and selected access before normal dispatch becomes available; allowing dispatch or startup to start containers would bypass the coordinator's human-attention and budget checks.

### Why removal intent precedes the archival journey

The space can disappear before its receipt reaches the binding file. A durable intent permits authoritative absence reconciliation after restart, while a recorded partial failure preserves unfinished cleanup for inspection.

### Why provider receipts include the consumer

Several bots can select one service identity and watch the same issue or channel. Provider-only cursor scopes let the first consumer acknowledge an event for every other bot. Consumer-scoped durable receipts preserve each bot's independent inbox.

### Why isolated tools use an inward inbox

The existing managed callback inside a space reaches that space's server. A child inbox lets the host pull bounded requests over its authenticated dispatcher, enforce its own recorded item/session authority, and return receipts without exposing a host callback credential or opening a listener.

### Why discovery usage has its own ledger

An investigation may produce no items or several items. Charging each candidate would lose usage or multiply it. A per-occurrence cumulative ledger counts the work once and lets the coordinator include it in the existing daily budget.

## Validation

Run the web test script on each file sequentially: `config.test.js`, `sources.test.js`, `discovery.test.js`, `provider-runtime.test.js`, `space-access.test.js`, `isolated-tools.test.js`, `isolated-tools.http.test.js` and `isolated-stages.test.js`. Existing `provider-events.test.js` and `discord-gateway.test.js` cover cursor-before-delivery and Gateway pacing/auth behavior. Run `node --check` on changed JS and MJS files.

`node packages/web/server/lib/bots/adapters.driver.mjs` exercises the actual discovery owner, isolated stage adapter, pinned SDK, authenticated spaces dispatcher, child inbox, activity/token readers, identity store, Jira HTTP adapter, event store and item coordinator. Its inside server and provider are controlled loopback fixtures. It proves selected-provider-only grants, nested record envelopes, durable dispatch, one prompt through restart, cache-inclusive daily usage, authorized tool settlement, wrong-space refusal, deduplicated delivery and authorization attention. It does not prove real OpenCode, Jira, Discord or Docker behavior.

`node packages/web/server/lib/bots/adapter-mutation.driver.mjs` removes protections in disposable module copies. The allocation probe fails when its failed durability barrier no longer prevents creation. Separate tool probes allow one host action, refuse a wrong space or a foreign request session, then fail when removal of that check permits an extra host action. Each original probe runs green again after its mutant. Container isolation and code-in/out guarantees still require the spaces live suites and Docker conditions documented by that module.
