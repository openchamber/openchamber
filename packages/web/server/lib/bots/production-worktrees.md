# Production bot checkout and isolated adoption

## Ownership

`production-worktrees.js` owns the private bot checkout, its filesystem/repository attribution, immutable publication branch reservation, snapshots, adoption and cleanup. `production-git.js` owns bounded Git plumbing and exact-account object fetching through the existing credential broker. `service-context.js` resolves the selected server identity and repository. `production-pull-requests.js` supplies private bot authority to the existing PR loop. Provider content writes remain in `services.js`.

Local Bot Git uses the existing private bundle Git wrapper with an operation-local
global config trusting exactly the checked directory. It loads no ambient global
hooks or credentials. A retained migration path also receives exact-directory
global trust for existing shared Git readers, only after its checkout and Git
directory match the owner mapping's inode identities. That trust grants no
coordinator or filesystem authority.

Spaces owns imported content. `isolated-stages.exportSnapshot` calls `journey.previewApply`, which calls `codeOut.bringCodeOut` before describing the apply. Code out fetches the exact result into a quarantine, checks Git objects and sizes its history, then promotes it under `refs/openchamber/spaces/<spaceId>/result`. A string reported by the agent confers no adoption authority.

### Composition

```js
const context = createBotServiceContext({ identities, services, fetchImpl, policyOptions,
  resolveDiscordTarget });
const worktrees = createProductionBotWorktrees({ dataDir, context,
  readItem: async (projectId, itemId) => (await store.read(projectId)).items.find(item => item.id === itemId),
  disposeInstance });

// After the recorded isolated fixing turn completed, before proof/inspection.
const exported = await isolated.exportSnapshot({ projectId: project.id, itemId: item.id });
if (exported.repository !== item.worktree) throw new Error('Isolated result repository changed');
await worktrees.adoptIsolated({ project, bot, item, resultSha: exported.resultSha });
const snapshot = await worktrees.inspect({ project, bot, item });
```

`adoptIsolated({ project, bot, item, resultSha, spaceId?, association? })` returns `{ headSha }` on success. Its caller must obtain the result and space ID from the item's recorded isolated-stage owner and match the returned repository with the recorded owned checkout. A supplied `spaceId` derives the expected source from the private checkout owner and requires matching persisted transfer metadata, start ref and that exact space's promoted result ref. The optional explicit `association` is `{ spaceId, source }` and must agree with a supplied `spaceId`. Interrupted adoption persists the association and requires it again on retry. Single-account callers without either field retain the existing promoted-ref check. It rejects an ordinary host bot, an unpromoted SHA, a changed selected identity, dirty/ignored data, hidden index flags and ancestry that drops the recorded base or current bot head.

`resolveTransferSource(source, { trustedMigrationPath } = {})` accepts the strict `bot-checkout` descriptor from
[Spaces](../spaces/DOCUMENTATION.md#front-door-source) and returns its checked
owned directory. The caller first verifies registration of the parent and its
canonical project ID. The helper reads the authoritative item and reuses the
private record, directory/Git filesystem identities, branch, repository and
worktree topology checks. Only a ready checkout resolves. The key is exactly
`${itemId}:worktree`; the descriptor cannot choose a checkout path. Both methods
are internal owners consumed by the agent service, with no owner callback.

### Retained migration paths

`readTrustedBotMigrationPaths({ dataDir: ownerDataDir })`, exported from
`production-worktrees.js`, reads only owner `bots/migration-paths.json` and returns
frozen entries. A missing file returns an empty list; malformed contents fail
with `BOT_MIGRATION_PATH_AUTHORITY_INVALID`. Composition captures that list from
the owner's local data directory and attaches the matching entry as
`request.trustedMigrationPath` to worktree operations, including
`readPublication`. The agent's copied mapping and returned snapshots supply no
authority. The entry is exactly
`{ projectId, itemId, directory, directoryIdentity, gitDirectory, gitIdentity }`.

A private checkout outside the current agent data root requires that entry or
fails with `BOT_MIGRATION_PATH_AUTHORITY_REQUIRED`. All 6 fields must match its
existing descriptor or it fails with `BOT_MIGRATION_PATH_AUTHORITY_MISMATCH`.
Existing item/project/branch, directory/Git inode and topology checks still run.
Descriptors, operation paths and live directories keep their original values.
An entry cannot recreate a missing private descriptor or reserve a replacement
checkout under the new data root.
This consumes the explicit mapping supplied during
[account migration](../host-install/DOCUMENTATION.md#bot-state-at-first-separation);
it grants no new path from an agent response.

The optional constructor dependency `advanceCheckout` defaults to `advanceBotCheckout`; tests inject interruption at that owning mutation boundary. Production composition needs no new dependency.

`readItem` returns the complete authoritative item for cleanup admission. Account selections require exactly one registered matching `github-account` identity. App selections name an exact private identity ID. Missing or ambiguous identities refuse. Selected Discord identities require server-owned captured routing through `resolveDiscordTarget`.

### Publication reservation

`bindPublication({ project, bot, item, branch })` returns exactly `{ publicationBranch }`. The caller selects a repository-compliant remote name after investigation. The owned local branch remains the literal `bot/<itemId>`. The same name can serve both roles, but it still requires a reservation. This server-internal method has no route or tool entrypoint.

Binding verifies the ready checkout, repository and selected identity through `context.github`. A new binding reads the authoritative item and rejects existing PR metadata or any `git.push` or `pr.*` effect, including refused and completed effects. An already committed binding can replay during later fixing rounds. The coordinator owns private execution descriptors and must preserve their existing publication destination. A caller's `item.publicationBranch` grants no ownership; when supplied, it must already match the optional private owner field.

A new reservation rejects the recorded or current default branch and every preexisting remote candidate, including a candidate at the checkout's SHA. Only a provider 404 proves absence. Binding performs reads only; it creates no remote ref and bypasses no repository rule. Publication must still use the provider's guarded ref creation and admission checks because an external actor can create a ref after reservation.

`readPublication({ repositoryId, botId, itemId })` returns `null` for an unbound owner, or exactly `{ publicationBranch, localBranch, directory, identityId, identityRevision }`. The returned identity is the captured private identity. It does not resolve current credentials or require the checkout to remain on disk. This lets the coordinator recover a lost item projection and read closure authority from ready, removing and removed owners. Missing owners, malformed files, lost reservation linkage, unsupported lifecycle states and disagreement with any captured ownership field throw. An already bound owner with a missing registry also throws.

Reservations live in `bot-worktrees/<sha256(repositoryId)>.publications.json`. The version-1 registry contains the repository ID and exclusive `{ publicationBranch, owner }` entries. Each entry captures all fixed private ownership fields, including project/path, repository, bot/item, local branch, checkout key, filesystem identities, base and selected identity revision. No credentials are stored. The optional owner `publicationBranch` is additive; legacy version-1 owners without it remain valid.

The lock order is owner record, then repository reservation. A read first locates a reservation under the repository lock, releases it, then takes both locks in that order and revalidates the complete linkage. Each JSON write uses a unique same-directory mode-0600 temporary file and rename. The registry commits before the owner's optional field. If the owner write fails, the reservation remains spent and the old owner remains valid. Repeating binding with the same owner and branch completes that write without treating a now-existing remote as new ownership. A different owner or replacement branch refuses. Reads refuse the incomplete linkage until this replay finishes. No automatic rollback frees the branch.

Cleanup retains both files indefinitely, including removed owner metadata. It removes only the original local ref and owned checkout. There is no retention eviction or power-loss durability guarantee.

PR composition remains:

```js
const { pullRequests, botWatch } = createProductionBotPullRequests({ context, services,
  getFixLoopRuntime: () => fixLoopRuntime,
  receiveFeedback: (projectId, itemId, event) => botsRuntime.receiveFeedback(projectId, itemId, event),
  reviewApps: approvedReviewApps });
fixLoopRuntime = createFixLoopRuntime({ ...existingFixLoopDependencies, botWatch });
```

`reviewApps` is an explicit server allowlist of `{ slug, appId }`. Human feedback retains the existing repository write/admin check. Bot watches have no per-round iteration cap; ordinary user loops keep their existing cap and account binding.

### Runtime behavior

| Runtime | Behavior |
|---|---|
| Web | Server owns adoption, inspection and publication admission. |
| Electron | Uses the same in-process server. |
| Hosted mobile | Uses authenticated server routes. |
| Capacitor mobile | Uses authenticated server routes. |
| VS Code | Unsupported; no bot worktree owner is constructed. |

## Invariants

- The bot branch is exactly `bot/<itemId>`, with its recorded owned path and checkout/metadata filesystem identities. The primary user checkout is never populated, reset, checked out or cleaned by adoption. Shared author/transport bindings remain unchanged.
- A publication reservation is immutable and exclusive across every bot and item in the same repository. Inspection and signed-publication verification read `record.publicationBranch ?? record.branch` remotely. Every local checkout and compare-and-swap continues to use `record.branch`.
- Only already promoted commit objects enter adoption. Code out owns quarantine, object validation, transfer limits and the exact fetched result. Adoption additionally reuses code out's `nameNotAllowedHere` and `firstRedirectedFolder` checks before materialization. Gitlinks and unsupported tree entries refuse materialization.
- The result must descend from both the recorded checkout base and its current head. Replace refs are disabled. A signed-publication rewrite therefore cannot be overwritten by an old unsigned space result. After such a rewrite, the coordinator must retain that published head or establish a separately authorized space history that descends from it.
- A schema-checked `adopting` record with `{ fromSha, resultSha, resultRef }` is atomically persisted before changing files, index or branch. Existing version-1 ready records remain readable without conversion. Only `adopting` carries this intent; it is removed when the owner records `ready` again.
- Git's guarded `checkout --detach --no-overwrite-ignore` updates files and index and temporarily detaches HEAD at the result. A compare-and-swap then moves the owned bot branch and reattaches HEAD. No merge, hard reset, forced checkout or project setup command runs. Hooks, fsmonitor, lazy fetching, recursive submodules and all configured clean/smudge/process filters are disabled at the Git boundary. Imported `.gitattributes` cannot select a configured host program.
- Status reads use the same filter exclusion and optional index writes are disabled. Adoption refuses assume-unchanged and skip-worktree entries, staged/unstaged edits and untracked/ignored files. Native checkout also refuses conflicting user data arriving after admission, including ignored files.
- Restart may continue an unchanged clean old tree, finish the branch CAS after a fully materialized result index, or finalize a clean result already at the branch. A partial tree, changed head, changed ownership or new local data produces a needs-you error and retains the intent and files. It never repairs an ambiguous checkout with a reset.
- Create, ordinary inspect, publication adoption and cleanup cannot treat `adopting` as ready. Retrying the same result reconciles its original intent; another result cannot replace it. A complete adoption leaves the index and working tree matching the exact published branch candidate, so existing `readBotGitSnapshot` branch checks succeed.
- The private lock excludes cooperating bot owners. It is not a filesystem transaction against external editors modifying files during a native Git command. Git's native refusal, CAS and final dirty checks bound that remaining race; ambiguous work is retained for attention. Records support process restart, with no power-loss durability claim.

## Decisions

### Why publication reservations precede the private owner projection

An owner-first write could lose repository exclusivity if the process stops before the reservation commits. Reserving first spends the remote name and lets the exact same owner finish the additive write after restart. Retaining reservations after cleanup prevents another item from claiming that publication's history.

### Why the local branch keeps its original ownership name

The checkout's branch, path and filesystem identities already authorize local adoption and deletion together. A separate remote name permits repository naming rules without changing that local authority. The caller's item snapshot remains a projection of the private binding.

### Why guarded checkout follows code-out promotion

The result already consists of validated Git objects. Guarded checkout preserves its commit history and refuses conflicting local work while materializing its index and files. Its explicit `--no-overwrite-ignore` is required because a two-tree `read-tree -m -u` overwrote an ignored file arriving after admission in the regression fixture. A branch-only update would leave a dirty old checkout, and a hard reset could erase newer local data.

### Why adoption keeps its own durable intent

Code out's result ref proves what arrived, while the bot checkout has a separate materialization lifecycle. The intent preserves the exact old/result pair so restart can distinguish a complete index from an interrupted write without guessing from dirty files.

### Why separated adoption names its Space

Linked Bot checkouts share a repository's refs. A result promoted for one Space
therefore cannot establish another Space's source binding. The owner-observed
Space ID selects one transfer sidecar and one result ref, and the private
checkout owner supplies the expected source for both admission and restart.

### Why host filters are disabled for reads too

Status and read-back can invoke clean filters selected by imported attributes. The same exclusion used for materialization keeps those checks from executing project-selected host programs.

## Source boundaries and validation

- `spaces/journey.js`, `previewApply`, delegates export to code out before returning the result.
- `spaces/code-out.js`, `bringCodeOut`, checks and promotes the exact object; `nameNotAllowedHere` and `firstRedirectedFolder` own host path safety.
- `spaces/host-git.js` and `code-transfer.js` own transfer command/environment and hook/fsmonitor restrictions.
- `git/service.js`, `buildWorktreePopulateCommand`, establishes the existing configured-filter exclusion pattern. Initial bot creation continues to use its safe detached population.
- `bots/services/git.js`, `readBotGitSnapshot`, verifies that publication's exact head still names the bot branch.

`production-isolated.test.js` drives real Git and the actual code-in snapshot/code-out quarantine owners against a local upload-pack stand-in. It covers exact files/index/head, server-observed proof commits, publication snapshot admission, live filter positive controls, durable interruption, partial-write retention, hidden index edits and ancestry/promoted-result refusal. The module driver and sensitivity driver report their controlled boundary explicitly. These checks establish host adoption behavior, not Docker isolation, live provider signing/publication, or live model execution.

`production-worktrees.test.js` drives real temporary checkout owners with controlled provider responses. Its publication cases cover exact API returns, immutable replay, concurrent same-repository conflicts, preexisting same-SHA refusal, interrupted owner writes, private linkage validation and retained removing/removed ownership. Run only this file with `bun run test server/lib/bots/production-worktrees.test.js` from `packages/web`. It establishes private reservation and local checkout behavior; live repository rules, provider publication and coordinator projection wiring require their owning integration checks.

Run the focused suite with `bun run test server/lib/bots/production-isolated.test.js` from `packages/web`. From the repository root, `node packages/web/server/lib/bots/production-isolated.driver.mjs` exercises adoption, actual isolated-proof program execution in the local source stand-in, publication snapshot validation and cleanup. `node packages/web/server/lib/bots/production-isolated-mutation.driver.mjs` removes filter exclusion, durable intent, ignored-file refusal and current-head ancestry in disposable module copies and requires each behavioral probe to turn red before rerunning the original probes.
