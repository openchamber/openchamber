# Shared session folders

## Ownership

This module owns folder-change semantics and scope membership shared with the server's session-folders module. Stores own persistence and transport.

## Invariants

- Pending changes replay over newer server snapshots with exactly the server's semantics. A move records previous membership and cannot undo a later move when delivered late or twice; deletion leaving a session unfiled does not count as a competing move.
- Nested worktrees own their folders independently of the containing project, while archived placement remains the restore flow's responsibility.
- No-op changes retain the map identity and untouched folders and scopes retain their references. Field ordering matches parsed server answers so replayed equivalent state compares equal.
