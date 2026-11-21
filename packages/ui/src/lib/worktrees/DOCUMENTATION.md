# Worktrees

## Ownership

This module owns worktree topology, creation and bootstrap, archive recovery, removal, and session relocation through runtime APIs. The sidebar owns discovery publication into the session stores; the topology refresh helper also publishes for surfaces without separate raw topology. Runtime Git implementations own filesystem operations and archive snapshots.

## Invariants

- A worktree list belongs to the instance where it started. An instance change stops it before another request or cache write, including a return to the original instance.
- A root-branch lookup checks its instance owner after resolving the root and before reading that root's status.
- A topology invalidation within the same instance may retry the list, bounded by the existing convergence limit. Same-instance transport changes keep that behavior.
- Failed or retired lists reject. They cannot stand in for an authoritative empty worktree list.
- A move into a newly created worktree seeds its task title from the session's current title. Explicit `workTitle.by: 'user'` retains user ownership; every other title is agent-owned so `work.name` may replace it.

### Topology and caches

- Prunable worktrees remain in topology as `missing`, so their sessions keep a sidebar group and remain available for relocation.
- A repository's topology belongs to its configured primary checkout, or its first configured checkout when the primary is absent. Configured checkouts and checkouts containing configured project folders stay out of removable worktree lists, because deleting them deletes the project's folder.
- Discovery equality compares metadata values because every read creates fresh objects. Branch, task title and pin changes must trigger publication even when paths stay unchanged; status changes are compared too.
- Repository refreshes replace every bucket for that repository together. A failed project listing retains its published topology and does not block successful listings for other projects.
- Client-tracked `pending` and `invalid` statuses survive a Git listing that reports `ready`, because registration does not prove population or setup has finished.
- Root and listing caches reduce repeated Git calls. Creation and removal invalidate root resolutions because topology changes can change a directory's primary root. Invalidation retires in-flight root entries and prevents their results from reseeding the cache; recency updates retain the original expiry time.
- A known branch can answer a root-branch lookup only when the project directory is the primary root. A linked checkout can have a different branch.
- A newly created session's directory proves project ownership only through an exact registered root or known worktree. Mere containment can conceal an undiscovered checkout belonging to another project and requires full discovery.

### Creation and directories

- Checkout roots remain the identity for Git, bootstrap, removal and moves. Projects opened inside a repository start worktree sessions in the corresponding folder, where their OpenCode configuration lives. Folder validation waits for checkout population and resolves symlinks to confirm containment; an unknown, missing or unverified folder falls back to the checkout root with a warning. Failed population removes the newly created checkout and local branch, while cleanup failure preserves the original error.
- Path containment helpers require normalized inputs. Nested checkout ownership uses the longest containing checkout; project ownership uses the longest project in that checkout, then the matching folder in the primary checkout. A project surrounding a linked checkout does not own its contents merely through containment. Session moves preserve each session's project folder because several projects can share a checkout.
- Generated branch names retain their generated prefix, including an issue number, so later renaming preserves that context. A change request's title seeds the task title until the agent names it.
- Requests resolved with `keep` retain their destination for drafts that have not submitted yet.

### Removal and session moves

- Removal state is client-local and clears on endpoint changes because different instances can use the same paths. A pending removal stays marked until Git answers, preventing cleanup and repeated actions from racing it.
- Session membership includes subdirectories and live-store sessions absent from the global list. The global record wins when both contain the session. Retried removal actions include sessions created since the original attempt.
- Activity checks read the host directly because unused directories can lose their cached statuses. Local activity is read after the host responds so activity started during the request counts. Session activity covers every child store because directory deduplication can omit the store carrying its live status; an unknown read prevents automatic cleanup and moves.
- Tree moves group sessions by source folder and use parent links to move descendants before their root. Remaining source sessions are checked for idleness immediately before each move because setup and earlier moves can take long enough for them to start running.
- A failed tree move rolls back completed members while its runtime remains current. Incomplete rollback reports the sessions left in the destination. Ambiguous transport failures retain a newly created destination because the server may still apply the move; both directories refresh to reconcile their unknown placement. Best-effort refresh failure preserves the direct action's outcome because those updates already reconcile the stores.
- Keeping sessions rejects missing source folders and destinations inside the checkout being deleted, because either would leave sessions behind. Trees completed before another tree fails remain in their projects. After confirmed moves, only newly added session IDs block deletion: a local list refreshed before confirmation can still show moved sessions at the old path.
- Skipping destructive deletion confirmation requires evidence that files and commits are safe; an unknown base comparison for a never-pushed branch requires confirmation. Branch deletion is offered only after reads confirm that the branch is neither a remote default nor held by another checkout, matching server protections. Failed reads offer no branch deletion.
- Teardown runs before session archival so failed or untrusted commands leave sessions untouched across automatic cleanup retries. The snapshot captures the state after teardown. Failed-bootstrap checkouts skip teardown because setup did not run; contributor forks skip project commands before checkout trust passes. Automatic removal rejects untrusted shared commands without prompting.
- Remote deletion checks remote readiness before teardown, then runs teardown before deleting the remote branch, so refusal leaves the checkout untouched and teardown failure deletes no branch. Teardown runs once. Bypassing it requires the explicit failure-toast action and preserves the user's deletion options.

### Archives and recovery

- Repository archive refs are authoritative. Client listings reload on mount and mutation, retain previous entries while loading or on failure, and accept only the newest request for the current runtime so late reads cannot undo a mutation.
- Sessions archive before their folder is removed because session mutations require that folder; reversing the order requires relocation and adds a moved note to each transcript. Failed session archival or worktree removal restores sessions already archived. A partial filesystem removal with a retained server archive keeps sessions archived and still reports the failure.
- Concurrent restores of one archive join the same operation because subsessions and Archive-page actions can request it together. Failed snapshot restoration removes its newly created checkout and any newly created branch so a retry finds the branch free; pre-existing branches remain.
- Archive deletion deletes its still-archived sessions first and stops on failure so the archive explaining them remains. Active sessions and sessions held by another archive are excluded.
- Restoring a merged worktree marks its current change request handled, because the user's restore would otherwise be archived on the next cleanup pass. A later change request can make it eligible again. Cleanup checks removal state after activity reads, since a manual action can start during the read, and one archive failure leaves other candidates eligible. Archival preserves changes and commits, so cleanup does not need a destructive-deletion loss check.
- A merged head absent from the clone can fall back to upstream ahead status when checking unmerged commits; absence of both sources leaves the answer unknown.
- Restored sessions relocate only after the server confirms their source directory missing. Archive restoration takes priority so sessions recover the changes they worked on; failed restoration reports the failure and still permits relocation to an available project root. Project metadata identifies ownership when the missing directory matches no known path. Availability is checked again after restoration because a subsession can already have restored the same worktree. Unknown availability leaves sessions in place, and a shared toast ID prevents duplicate restoration notices.

## Decisions

### Why topology revisions and instance ownership are separate

A topology change requires another read of the same project. An instance change makes that project's path obsolete. Retrying both through one generation check sent the old path to the new instance, so reads now retain an instance predicate separately from the topology revision.

### Why source defaults follow the remote and not an earlier selection

New tasks prefer the bound remote's default branch and its fresher tracking ref so a feature branch checked out at the root does not carry unmerged work into the task. Earlier selections are not remembered because later tasks can silently inherit a branch that has moved on; an explicit branch-on-top action prefers the local branch so it includes unpushed work.

### Why checkout has a deadline and not setup

Checkout uses the server gate's deadline. Setup can take much longer in large repositories, so it waits for the server's completion or failure report; bootstrap subscriptions keep transient checkout files out of change views.

### Why path helpers stay independent of stores

Sync and multi-run code reached by the manager also need containment helpers. Keeping those helpers free of store and runtime imports prevents an import cycle; failed-start cleanup loads the manager dynamically for the same reason, because the manager reaches the session store that imports start-directory resolution.

### Why branch search ranks local and remote candidates together

Match quality determines the shared order so exact and prefix matches appear before weaker matches regardless of branch source or alphabetic grouping. Pinned remote defaults lead only the untyped list for the same reason: a query never shows a default branch it does not match.

### Why benchmark imports happen before measurement

The benchmark dynamically loads the manager once before measuring calls so subscriber registration and other module-level side effects stay outside the measurements. Warmup lets the runtime optimize the measured code, and the stringify comparison consumes both results to prevent dead-code elimination.

### Keeping a worktree's sessions on delete

Deleting a worktree with "Keep sessions in the project" moves its sessions to their projects, then removes it (`moveSessionsThenRemoveWorktree`, wired in `moveWorktreeSessionsThenRemove`).

- OpenCode answers `session.move` once the move is queued in the session's inbox. A runner of the source folder applies it afterwards, and removing the folder first stopped that runner: the session stayed in the deleted folder, seen live on mobile. The removal waits until a session read places every moved session in its project, and keeps the worktree when that does not happen within ten seconds. The ten seconds hold while reads are in flight: when they pass, outstanding reads are aborted and count as not moved.
- The whole delete belongs to the runtime instance it began on, a switch away and back included. Once that instance is gone, no further status read, move, store write, refresh or rollback goes out, inside a tree's move too, and the worktree stays: those requests would reach the other server, which does not know the sessions.
- The dialog and the mobile sheet offer the option from the same read the run does, the global list and the live stores (`readSessionsInWorktree`): a session only a live store holds yet would otherwise hide the option and fall back to archiving.
- A failed removal leaves the moved sessions in the project, a teardown that stopped it included. Moving them back adds another "moved" note to each transcript, and git may already have removed the folder before failing on the branch.
