# Bots persistence and repository policy

Production Git, isolated-result adoption, exact service context and PR-watch composition are documented in [production-worktrees.md](production-worktrees.md). The coordinator contract remains in [runtime-contract.md](runtime-contract.md).

The running server constructs those owners through [host-composition.md](host-composition.md), including its child-only tool inbox, lifecycle, isolated queues and event wiring.

Bot-owned isolated network and model-access references, the pure resolver and its required host composition are documented in [space-options.md](space-options.md).

Durable questions, approved recipient routing, service-only mentions and answer
recovery are documented in [questions-contract.md](questions-contract.md).

`createBotNotices` adapts feedback to durable synthetic delivery. Its required
constructor, dispatch guard and isolated-queue contract are in
[notices-contract.md](notices-contract.md).

## Ownership

This module owns personal bot definitions, item snapshots, archival, approved repository policy and the production coordinator composition. Its runtime, adapter, attention and notice contracts define the execution boundaries. `host.js` registers authenticated routes through the server's feature composition; shared UI lives in `packages/ui`. Web, Electron, hosted mobile and Capacitor use the server contract. VS Code has no bots backend.

The production discovery, isolated stage and provider lifecycle adapters are documented in [production-adapters.md](./production-adapters.md). Their private records capture dispatch and space identity before effects, and keep provider cursor ownership separate for each consuming item or bot.

Bot definitions persist `discord: { channels: [{ guildId, channelId }] }`, with an empty channel list for older definitions. Channels are explicit guild destinations; approved people separately authorize DMs. Source discovery uses the user's JQL and selected Jira site without a configured project restriction. Discovery has its own per-occurrence token ledger so candidate admission cannot multiply or discard its usage.

`attention.js` adapts authoritative item transitions to durable notification-center
requests. [attention-contract.md](attention-contract.md) defines its required
constructor, alert owner, UI target and failure behavior.

`createBotsConfig({ projectConfigRuntime })` in `config.js` exposes `read(projectId)`, `update(projectId, editableConfig)`, and server-only `setApproval(projectId, relativeFile, fingerprint | null)`. The project config runtime owns locking and whole-document writes. `readBotsConfig(raw)` returns `{ ok: true, config }` or `{ ok: false, error }`. `parseConfigEdit` throws on invalid edits and strips server-only approvals. A missing key defaults to `{ concurrency: 2, retentionDays: 90, definitions: [], approvals: {} }`; explicit null or malformed config fails. Definition parsing is exported as `botDefinitionSchema`.

`createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime })` in
`scheduler.js` exposes server-only `sync(projectId, managedRows)` and
`remove(projectId, botId)`. `managedRows` is the complete successful
`config.definitions.map(botTaskFor)` projection for one project. Invalid snapshots
throw before reconciliation. Existing non-bot IDs cannot be taken over. Sync
preserves task state through locked upserts, then removes stale bot rows and
refreshes scheduler timers. Remove affects only rows carrying the requested
`botId`. Normal tasks, suggested scans and other owners remain unchanged.

Each row write is atomic. A later failure leaves earlier successful writes valid,
preserves obsolete rows until replacements persist, and reports failure to the
config caller. Repeating the complete sync safely finishes reconciliation. A
timer-refresh failure also propagates; the next successful sync refreshes it.
No failed config read or source discovery may be converted into an empty sync.

Host composition constructs `createScheduledTasksRuntime` with the deferred
`runBot: (projectId, botId, occurrence) => botsRuntime.runScheduled(projectId, botId, occurrence)`
dependency, preserving the existing `runSuggestedScan` dependency. It constructs
`createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime })`, passes that
adapter as `scheduler` to `createBotsRuntime`, assigns `botsRuntime`, and only
then starts either runtime. Imports come from `scheduled-tasks/runtime.js`,
`bots/scheduler.js`, and `bots/runtime.js` respectively. This module does not
edit `server/index.js` or register routes.

`scheduler.test.js` covers ownership persistence, managed mutation refusal,
manual dispatch, concurrency, failed writes, stale cleanup and shared occurrence
claiming. `node packages/web/server/lib/bots/scheduler-driver.mjs` drives real bot
config, project persistence, scheduler and task service with an explicit
deterministic bot hook. It proves config sync/list/run and refusal without an
ordinary session; it does not exercise production source discovery or providers.

`createBotStore({ projectsDirPath, fsImpl?, now?, owner? })` in `store.js` exposes:

- `read(projectId)` returns `{ revision, items }`.
- `update(projectId, change)` runs `change(snapshot)` under the file lock. Return `{ snapshot: { revision, items }, result? }` to commit, or `{ result }` to skip. With no result, a commit returns the committed snapshot. The callback receives a detached current value and must preserve its revision and existing item revisions. A state-only mutation replaces a matching item in the array. The store increments revisions and appends transition history. Remote calls must happen after the promise resolves, outside the callback.
- `archive(projectId, { before?, itemIds? })` moves terminal items whose `finishedAt < before` and whose effects have settled. It returns `{ archived: string[], snapshot }`. The coordinator derives `before` from configured retention days. Ordinary writes never evict items.
- `readArchive(projectId, month?)` returns deduplicated archived items, optionally restricted to `YYYY-MM`.
- `filePathFor(projectId)` returns `<projectsDir>/<projectConfigFileStemOf(projectId)>/bots.json`. Archives are sibling `bots-archive/YYYY-MM.jsonl` files. Snapshot and archive operations share `bots.json.lock`.

`schema.js` exports `createBotItem({ id?, botId, source, title, description?, now? })`, `botItemSchema`, `botEffectSchema`, `botEffectAuthoritySchema`, `botOwnerSchema`, `BOT_ITEM_STATES`, `TERMINAL_ITEM_STATES`, `assertItemTransition`, and `assertEffectTransition`. Sources have `{ kind: manual | jira | suggestion | alert | investigation, id, url? }`; source identity and bot ID are immutable. Sessions are `{ investigation?, fixing?, judge? }` with session IDs as values. Worktree and branch are strings. Evidence is `{ source, summary, url? }[]`. Proof, judgment, wait, token usage, transitions and effects are parsed structured records, never opaque provider payloads.

Effects have stable `key`, a kind, SHA-256 `inputDigest`, `createdAt`, `updatedAt`, and `{ service, identityId, revision, target }` authority. Identity and target are opaque executor-resolved references, never credentials. `prepared` has no result; `dispatching` has `{ pid, host }` owner; `succeeded` has `{ id, url?, sha?, sessionId? }` receipt; `refused` and `outcome-unknown` have a stable `code`. Persist prepared, then dispatching, before a remote write. A persisted dispatching record must be reconciled after restart; it can never become prepared again. Unknown outcomes require human attention until authoritative reconciliation settles them. The coordinator owns that live reconciliation and setting `needs-you`; loading persisted history does not prove activity.

`readRepositoryPolicy(projectPath, approvals?)` reads `.agents/areas/*.md` and `.openchamber/people.json`. Area frontmatter is `{ name, paths: string[], level: human | judgment, owners: string[] }`, followed by explanatory Markdown. People JSON is an array of `{ id, name, roles: string[], github?, jira?, discord? }`. Service identities are strings. Every file fingerprint hashes exact UTF-8 contents. `approveRepositoryPolicy({ config, projectId, projectPath, file, fingerprint })` verifies the expected fingerprint and records explicit machine approval. It never edits repository files. `evaluateRepositoryPolicy(policy, [{ oldPath?, newPath? }])` returns level, reason, matched areas, owners, people trust and the policy fingerprint. `resolvePolicyPeople(policy, { owners?, role?, service })` returns `resolved` or `ask`; unresolved owners never become guessed accounts.

## Invariants

`drivers.test.js` runs the standalone process, provider and mutation drivers through the web package's existing `test` command. Each driver runs in a separate Node process. A nonzero exit or timeout fails its test, preserving the driver's assertions and cleanup boundaries.

- Only ENOENT means an empty snapshot. Invalid JSON, root/version errors, permissions and I/O failures throw and preserve disk contents. Invalid individual items are dropped independently. Successful empty snapshots remain authoritative.
- Every read and complete mutation takes the cross-process file lock. Writes use unique same-directory temporary files, mode 0600, and rename. Failed pre-rename writes preserve the old file and clean their temporary file. This supports process restart; snapshots do not claim power-loss durability.
- IDs and per-bot source identities cannot repeat or be reused after archival. Existing items leave the snapshot only through archive. New items start queued; history and identity cannot be rewritten. Each changed item has a monotonic revision and the process/host that committed it. Stage sessions must be persisted by the coordinator before prompt dispatch.
- Effects cannot disappear or change their digest or captured authority. A new effect starts prepared. Terminal receipts are immutable. Dispatching and unknown effects never re-enter a sendable state.
- Archive appends and syncs a complete newline-terminated record before snapshot removal. Restart reads suppress snapshot copies whose IDs already reached the archive. Repeating archive removes those copies without duplicating records. A torn final line has no authority and is truncated before the next append. One invalid archived item falls independently; unsupported record versions fail.
- Repository policy rejects symlinks at each relative component, verifies canonical containment and file identity around reads, and bounds files to 1 MiB. Linux additionally checks the opened handle's canonical path. Repository policy inputs must be stable during an admission check; callers re-read policy and compare its fingerprint at execution along with the exact base/head SHAs and destinations.
- New, changed, removed or unreadable area rules force human review globally until repaired or explicitly approved/withdrawn. Both old and new diff paths count. `.agents/areas/`, `.openchamber/`, `.github/` and any `CODEOWNERS` file require human review regardless of a judge's response. An unapproved people file supplies no identities.

## Decisions

### Why scheduled rows carry the bot ID

The task ID names the scheduler record while `botId` identifies the dispatch
owner and configuration page. Persisting both ownership fields keeps list,
mutation refusal and dispatch consistent after restart and loop discovery.

### Why a locked callback and not a read followed by replacement

The callback sees the latest disk revision inside the process-shared lock. Independent coordinators can mutate different items without losing either update, and stale detached snapshots fail the revision check.

### Why archive records precede snapshot removal

Removing first loses an item if the process stops before append. Appending first can leave 2 copies, which stable IDs reconcile on every subsequent read and archive operation.

### Why untrusted areas block the whole change

Changed or unreadable paths cannot prove the previous rule's scope. Treating only the new patterns as human would let a repository edit remove its own review requirement.

### Why approval stays in the personal config

Repository changes can alter policy and routing of questions. Only an explicit local approval grants the exact fingerprint authority; pulling a teammate's files cannot grant that consent.
