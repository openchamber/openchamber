# Bots server composition

## Ownership

`host.js` constructs the production coordinator, config and item stores, identity and service owners, checkout and PR adapters, stages, source discovery, proof, notices, attention, provider lifecycle and scheduler projection. `host-sessions.js` owns the live bot-session index and dedicated isolated notice queues. The root server supplies existing runtime dependencies and registers this composition through `feature-routes-runtime.js`.

`server/index.js` distinguishes a space server with the existing `OPENCHAMBER_SPACE_IDLE_STOP_FILE` marker. That process constructs `createBotChildServer` only. Its persistent inbox uses the authenticated agent-tool call context and existing UI-authenticated listener. It has no bot identities, service executor or coordinator. Host requests to the child inbox are explicitly refused before the OpenCode proxy.

| Runtime | Behavior |
|---|---|
| Web | Owns production Bot execution, authenticated routes and persistent state. |
| Electron | Uses the same in-process server and notification owner. |
| Hosted mobile | Uses its connected server's routes and existing event transport. |
| Capacitor mobile | Uses its connected server's routes and existing event transport. |
| VS Code | No Bot host or child composition is constructed. |

## Invariants

- Construction performs no provider reads or execution. The bootstrap continuation starts workers after OpenCode readiness, without delaying the HTTP listener or initial shell. Mutation requests received earlier return `BOT_HOST_NOT_READY`.
- One watcher callback feeds host and space events. Item mutations, stage allocation and startup records populate the session index. Ordinary sessions and token deltas perform no Bot SDK or disk reads. Completed steps use the existing complete, cache-inclusive cumulative token reader. Discovery usage stays in its own ledger and contributes once to daily admission.
- Permission and form waits remain active stages. Their existing live attention entries resolve through ordinary replies. Authorization, budget and execution failures require explicit item attention.
- Isolated sessions resolve their recorded binding and current spaces host at each operation. Notices have separate host-owned persistence and a dispatcher-backed queue per session. Host session reads, queue transport and token readers are never substitutes for an isolated target.
- The child persists a tool call before merging `openchamber.botToolPending` into session metadata. Translation preserves the resulting metadata event. The host checks the recorded space/session before pulling the inbox. Recovery also pulls pending calls for recorded active fixing sessions. No host tool credential enters a space.
- Production space options come exclusively from `readBotSpaceOptions(bot.space, selection)`. Each stage gets exactly its selected provider's explicit grant, the configured network and no setup commands. Missing grants produce attention. Host logins and other spaces' grants supply no implicit authority.
- `placement.js` persists an item's execution placement before session allocation. Stage creation, dispatch, stop, inspection, proof and notice routing use that placement. Changing the bot's isolation option affects new execution placements in either direction. Restart recovers older items from their isolated binding or first journaled stage snapshot, never from path spelling or current config. Conflicting captured history requires attention.
- Item detail and answer/resume/stop responses expose `sessionDirectories`, keyed by session ID. Active and archived inspection use captured placement independently of current bot configuration, including after its deletion. Host sessions use the captured host checkout. Isolated sessions require a matching stage and session in the retained host-owned binding. After space removal, `getSpaceArchive().sessionDirectory(spaceId, sessionId)` supplies the imported session's current host archive directory only for that exact retained pair. Missing archive records disable the link. These reads need no container startup or OpenCode read.
- Isolated inspection exports through code-out quarantine and adopts the promoted result before reading a correction. A remotely published head with the exact same immutable tree remains the candidate after signed publication. The private publication map translates proof SHAs only after comparing the corresponding immutable trees.
- Cleanup uses the recorded isolated binding and the spaces archival journey before removing the owned checkout. Failed or uncertain removal retains the record and worktree. A durable removal intent can reconcile an absent space after a lost receipt; a removed binding makes repeated stage Stop a no-op even while Spaces is disabled. Reconciliation repeats the locally verified, idempotent checkout removal before reading its final receipt, so a repaired dirty-checkout refusal can complete through a fresh host. Unknown user directories grant no cleanup authority.
- `stages.resume(capturedRunWithSessionId)` resolves the item's recorded placement and forwards the explicit Resume hook. It restores the same isolated container through the existing start/grant/read owners. It performs no prompt dispatch. The coordinator calls it only after checking Resume eligibility, budget and Stop state; ordinary dispatch and bootstrap remain fail-closed for interrupted bindings.
- Missing source identities produce durable, deduplicated attention items even before a stage session exists. Missing execution identities produce ordinary item attention through the coordinator. Push delivery remains the existing notification runtime's responsibility.
- Pending investigation returns HTTP 202. Scheduler acknowledgement retains the same occurrence without treating pending work as an authoritative empty result. Discovery completion reruns that occurrence.
- Existing PR-watch ticks wake coordinator reconciliation, including head/base/policy invalidation. A merged-watch settlement wakes closure; an unmerged close or failed watch produces attention. These callbacks do not await work that may drain the originating watch task.
- Shutdown stops scheduler admission and cancels the coordinator before awaiting host startup, then drains the remaining Bot owners and dedicated queues before closing space transports. Startup checks shutdown intent before coordinator activation and after recovery, and cannot activate provider/discovery owners after Stop. A failed cleanup owner does not prevent the remaining owners from stopping.

## Decisions

### Why composition has one server owner

The production adapters have dependency cycles around feedback, tool dispatch and provider targets. Late-bound closures resolve those owners after construction; the root entrypoint only supplies its existing capabilities.

### Why isolated queues live on the host

The host must recheck current item, bot and session authority before inference dispatch. A dedicated queue retains that authority and durable IDs while sending through the recorded space's authenticated dispatcher.

### Why metadata wakes the child tool inbox

OpenCode already emits durable metadata events over the space's existing stream. The marker wakes an inward pull and carries no host credential or new listener.

### Why signed publication retains tree identity

GitHub signing rewrites commit IDs. Keeping the published head when its tree equals the exported correction avoids replacing verified publication with an older unsigned history. Proof runs the corresponding source snapshots inside the space and reports the verified published SHAs.

### Why placement belongs to the item

Bot settings can change while a stage is running. Keeping both host and isolated placement in an item-owned record prevents a later stage, Stop or notice from switching runtimes after that edit. The first captured stage snapshot supplies placement for older host executions that have no isolated binding.

### Why archive inspection keeps the execution journal

Retention moves the terminal item out of the active list while retaining its reports, diff and session addresses in their existing owners. The item read joins those retained records without recreating a checkout or requiring the bot definition; execution and mutation entrypoints still require an active item.

### Why cleanup reconciliation can finish local removal

The archival journey may remove the space before the checkout owner refuses a dirty directory or loses its receipt. Repeating that owner's verified idempotent remove finishes the captured cleanup after repair; a read-only check would leave a valid remaining checkout permanently unresolved.

## Validation

`host.test.js` covers production construction, readiness refusal, config and managed rows, missing-identity attention, notifications, UI events, pending discovery, same-occurrence completion, discovery-inclusive budgets, token-event operation counts, suggestion conversion and the child inbox. `host-sessions.test.js` exercises actual isolated queue persistence and synthetic HTTP delivery with a controlled space owner and proves no host fallback on failure. `isolated-stages.test.js` covers the actual binding resolver and archival removal, including a disposable metadata-check mutation that must make the refusal assertion fail.

The lifecycle regressions in `host.test.js` drive budget interruption and public Resume through a fresh production host. Resume restores the captured space after the bot's isolation setting changes, creates a durable new stage attempt in that space and retains the original session. Separate cases recover Stop after a dirty-checkout refusal and after an actual binding receipt-write failure following successful space removal. Spaces uses controlled peers and checkout creation uses a controlled service context. The binding store, item/effect journals, stage adapter, production composition and checkout owner are real. These tests establish the coordinator's Resume callsite without live provider access.

`host-proof.test.js` runs the production composition with a real Git regression/fix pair and a SIGTERM-resistant host proof command, both after startup and during recovery of an enabled persisted item. Shutdown cancels the coordinator before awaiting startup, and startup guards prevent reactivation of the coordinator, provider or discovery owners. The host forwards cancellation into the process-tree runner, records inconclusive evidence and drains temporary proof checkouts while retaining the item's checkout. Service authentication uses controlled HTTP and a disposable locally generated app key. Removing only the host's signal forwarding makes the running-host regression fail; waiting for startup before cancellation makes the recovery regression fail.

`node packages/web/server/lib/bots/host-process.driver.mjs` starts real `server/index.js` host and child processes with temporary HOME/data and a controlled OpenCode HTTP peer. It exercises the real UI-auth gate, Bot config and admission routes, missing-identity item attention, notification-center route, SSE invalidation, child-only inbox, absence of child identities and graceful shutdown. It reads the canonical project ID from the real settings route.

These checks do not establish live model inference, GitHub/Jira/Discord writes, push delivery, Docker isolation, packed child tools, relay-device behavior or packaged Electron behavior. Those require the coordinator's authorized runtime QA.
