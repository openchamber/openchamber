# Worktree reads

## Ownership

This module resolves project roots and lists worktree topology through the runtime Git API. The sidebar owns publication of that topology into the session stores.

## Invariants

- A worktree list belongs to the instance where it started. An instance change stops it before another request or cache write, including a return to the original instance.
- A root-branch lookup checks its instance owner after resolving the root and before reading that root's status.
- A topology invalidation within the same instance may retry the list, bounded by the existing convergence limit. Same-instance transport changes keep that behavior.
- Failed or retired lists reject. They cannot stand in for an authoritative empty worktree list.
- A move into a newly created worktree seeds its task title from the session's current title. Explicit `workTitle.by: 'user'` retains user ownership; every other title is agent-owned so `work.name` may replace it.

## Decisions

### Why topology revisions and instance ownership are separate

A topology change requires another read of the same project. An instance change makes that project's path obsolete. Retrying both through one generation check sent the old path to the new instance, so reads now retain an instance predicate separately from the topology revision.

### Keeping a worktree's sessions on delete

Deleting a worktree with "Keep sessions in the project" moves its sessions to their projects, then removes it (`moveSessionsThenRemoveWorktree`, wired in `moveWorktreeSessionsThenRemove`).

- OpenCode answers `session.move` once the move is queued in the session's inbox. A runner of the source folder applies it afterwards, and removing the folder first stopped that runner: the session stayed in the deleted folder, seen live on mobile. The removal waits until a session read places every moved session in its project, and keeps the worktree when that does not happen within ten seconds. The ten seconds hold while reads are in flight: when they pass, outstanding reads are aborted and count as not moved.
- The whole delete belongs to the runtime instance it began on, a switch away and back included. Once that instance is gone, no further status read, move, store write, refresh or rollback goes out, inside a tree's move too, and the worktree stays: those requests would reach the other server, which does not know the sessions.
- The dialog and the mobile sheet offer the option from the same read the run does, the global list and the live stores (`readSessionsInWorktree`): a session only a live store holds yet would otherwise hide the option and fall back to archiving.
- A failed removal leaves the moved sessions in the project, a teardown that stopped it included. Moving them back adds another "moved" note to each transcript, and git may already have removed the folder before failing on the branch.
