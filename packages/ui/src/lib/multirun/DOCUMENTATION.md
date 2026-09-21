# Multi-run membership and fusion

## Authority

`identity.ts` owns the version-1 `session.metadata.openchamber.multirun` contract.
Each launcher invocation gets a UUID group identity; its prompt groups retain
their `g1`, `g2` names. Provider/model IDs and display labels are data, not keys.
Members carry a `run` or `fusion` role and their owning `sessionID`.

OpenCode copies metadata when forking, sometimes without a `parentID`. A marker
belongs only to the matching session ID. A copied, pending, malformed or future
marker is ineligible and never falls back to a title. Metadata is not an access
grant; all reads, writes and deletions still go through the authenticated SDK.

`createSession.ts` creates a pending marker with `sessionID: null`, then reads
and updates the new session to bind the server-assigned ID. Callers register and
dispatch only after the returned metadata confirms binding. The fresh read
preserves unrelated metadata because upstream updates replace the whole object.
The SDK has no compare-and-swap operation; this is limited to a new, undispatched
session, not a general concurrent metadata editor.

A failed binding attempts to delete only that newly created session. Worktrees
are retained because setup may already have written files. Successful siblings
remain usable and creation reports the failed count. Runtime changes stop later
requests, registration and dispatch; cleanup is not redirected into the new
runtime. A pending record left behind is not an eligible member.

## Consumers

- `useMultiRunStore` writes membership for both isolated and shared-directory runs.
- Sidebar menus use membership, including metadata-only row invalidation.
- `MultiRunFusionDialog` selects the same group and prompt group, excludes fusion
  results, and retains user exclusions across session-list updates.
- `fusion.ts` revalidates selected IDs and reads current output before creating
  the result. Read failures stop fusion rather than silently dropping a source.
  A successful empty output is omitted; no nonempty output means no new session.
- Fusion results keep the group identity and role `fusion`, so another fusion
  can be started from the result without using it as a source.
- `groups.ts` and Agent Manager use group keys for selection, rendering and bulk
  actions. Deletion rechecks membership and directory. Worktree removal skips
  the project root and requires an authoritative empty inclusive session list.

The global session cache already preserves metadata across reload, archive and
runtime switching. No separate persistence or polling is added. Web, Electron
and VS Code share the SDK contract. Hosted mobile and Capacitor retain their
existing controls; this change adds no mobile launcher or fusion menu.

## Legacy sessions

Unmarked sessions use `title.ts` only for compatibility. Embedded model slashes,
prompt groups, duplicate indices and old empty-group segments are supported.
Legacy groups are scoped to their resolved project directory. A new fusion over
legacy sources stores that legacy scope without rewriting the source sessions.
Native and legacy groups never join just because their labels match.

Old titles ending in `/2` or `/fusion` are inherently ambiguous. Preserve their
previous suffix interpretation; do not write guessed membership back to them.
Legacy names can still collide or lose recognition after renaming. Only new
ID-bound records provide exact membership.
