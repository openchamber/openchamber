# Worktree reads

## Ownership

This module resolves project roots and lists worktree topology through the runtime Git API. The sidebar owns publication of that topology into the session stores.

## Invariants

- A worktree list belongs to the instance where it started. An instance change stops it before another request or cache write, including a return to the original instance.
- A root-branch lookup checks its instance owner after resolving the root and before reading that root's status.
- A topology invalidation within the same instance may retry the list, bounded by the existing convergence limit. Same-instance transport changes keep that behavior.
- Failed or retired lists reject. They cannot stand in for an authoritative empty worktree list.

## Decisions

### Why topology revisions and instance ownership are separate

A topology change requires another read of the same project. An instance change makes that project's path obsolete. Retrying both through one generation check sent the old path to the new instance, so reads now retain an instance predicate separately from the topology revision.
