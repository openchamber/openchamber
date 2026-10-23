# Production bot checkout and isolated adoption

## Ownership

`production-worktrees.js` owns the private bot checkout, its filesystem/repository attribution, immutable snapshots, adoption and cleanup. `production-git.js` owns bounded Git plumbing and exact-account object fetching through the existing credential broker. `service-context.js` resolves the selected server identity and repository. `production-pull-requests.js` supplies private bot authority to the existing PR loop. Provider content writes remain in `services.js`.

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

`adoptIsolated({ project, bot, item, resultSha })` returns `{ headSha }` on success. The method is server-internal and has no HTTP/tool entrypoint. Its caller must obtain the result from the item's recorded isolated-stage owner and match the returned repository with the recorded owned checkout. It rejects an ordinary host bot, an unpromoted SHA, a changed selected identity, dirty/ignored data, hidden index flags and ancestry that drops the recorded base or current bot head.

The optional constructor dependency `advanceCheckout` defaults to `advanceBotCheckout`; tests inject interruption at that owning mutation boundary. Production composition needs no new dependency.

`readItem` returns the complete authoritative item for cleanup admission. Account selections require exactly one registered matching `github-account` identity. App selections name an exact private identity ID. Missing or ambiguous identities refuse. Selected Discord identities require server-owned captured routing through `resolveDiscordTarget`.

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
- Only already promoted commit objects enter adoption. Code out owns quarantine, object validation, transfer limits and the exact fetched result. Adoption additionally reuses code out's `nameNotAllowedHere` and `firstRedirectedFolder` checks before materialization. Gitlinks and unsupported tree entries refuse materialization.
- The result must descend from both the recorded checkout base and its current head. Replace refs are disabled. A signed-publication rewrite therefore cannot be overwritten by an old unsigned space result. After such a rewrite, the coordinator must retain that published head or establish a separately authorized space history that descends from it.
- A schema-checked `adopting` record with `{ fromSha, resultSha, resultRef }` is atomically persisted before changing files, index or branch. Existing version-1 ready records remain readable without conversion. Only `adopting` carries this intent; it is removed when the owner records `ready` again.
- Git's guarded `checkout --detach --no-overwrite-ignore` updates files and index and temporarily detaches HEAD at the result. A compare-and-swap then moves the owned bot branch and reattaches HEAD. No merge, hard reset, forced checkout or project setup command runs. Hooks, fsmonitor, lazy fetching, recursive submodules and all configured clean/smudge/process filters are disabled at the Git boundary. Imported `.gitattributes` cannot select a configured host program.
- Status reads use the same filter exclusion and optional index writes are disabled. Adoption refuses assume-unchanged and skip-worktree entries, staged/unstaged edits and untracked/ignored files. Native checkout also refuses conflicting user data arriving after admission, including ignored files.
- Restart may continue an unchanged clean old tree, finish the branch CAS after a fully materialized result index, or finalize a clean result already at the branch. A partial tree, changed head, changed ownership or new local data produces a needs-you error and retains the intent and files. It never repairs an ambiguous checkout with a reset.
- Create, ordinary inspect, publication adoption and cleanup cannot treat `adopting` as ready. Retrying the same result reconciles its original intent; another result cannot replace it. A complete adoption leaves the index and working tree matching the exact published branch candidate, so existing `readBotGitSnapshot` branch checks succeed.
- The private lock excludes cooperating bot owners. It is not a filesystem transaction against external editors modifying files during a native Git command. Git's native refusal, CAS and final dirty checks bound that remaining race; ambiguous work is retained for attention. Records support process restart, with no power-loss durability claim.

## Decisions

### Why guarded checkout follows code-out promotion

The result already consists of validated Git objects. Guarded checkout preserves its commit history and refuses conflicting local work while materializing its index and files. Its explicit `--no-overwrite-ignore` is required because a two-tree `read-tree -m -u` overwrote an ignored file arriving after admission in the regression fixture. A branch-only update would leave a dirty old checkout, and a hard reset could erase newer local data.

### Why adoption keeps its own durable intent

Code out's result ref proves what arrived, while the bot checkout has a separate materialization lifecycle. The intent preserves the exact old/result pair so restart can distinguish a complete index from an interrupted write without guessing from dirty files.

### Why host filters are disabled for reads too

Status and read-back can invoke clean filters selected by imported attributes. The same exclusion used for materialization keeps those checks from executing project-selected host programs.

## Source boundaries and validation

- `spaces/journey.js`, `previewApply`, delegates export to code out before returning the result.
- `spaces/code-out.js`, `bringCodeOut`, checks and promotes the exact object; `nameNotAllowedHere` and `firstRedirectedFolder` own host path safety.
- `spaces/host-git.js` and `code-transfer.js` own transfer command/environment and hook/fsmonitor restrictions.
- `git/service.js`, `buildWorktreePopulateCommand`, establishes the existing configured-filter exclusion pattern. Initial bot creation continues to use its safe detached population.
- `bots/services/git.js`, `readBotGitSnapshot`, verifies that publication's exact head still names the bot branch.

`production-isolated.test.js` drives real Git and the actual code-in snapshot/code-out quarantine owners against a local upload-pack stand-in. It covers exact files/index/head, server-observed proof commits, publication snapshot admission, live filter positive controls, durable interruption, partial-write retention, hidden index edits and ancestry/promoted-result refusal. The module driver and sensitivity driver report their controlled boundary explicitly. These checks establish host adoption behavior, not Docker isolation, live provider signing/publication, or live model execution.

Run the focused suite with `bun run test server/lib/bots/production-isolated.test.js` from `packages/web`. From the repository root, `node packages/web/server/lib/bots/production-isolated.driver.mjs` exercises adoption, actual isolated-proof program execution in the local source stand-in, publication snapshot validation and cleanup. `node packages/web/server/lib/bots/production-isolated-mutation.driver.mjs` removes filter exclusion, durable intent, ignored-file refusal and current-head ancestry in disposable module copies and requires each behavioral probe to turn red before rerunning the original probes.
