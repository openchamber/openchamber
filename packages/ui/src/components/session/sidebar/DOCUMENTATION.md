# Session Sidebar

Sidebar code is organized by the business object it owns. Shared contracts are
kept at this root in `types.ts` and `utils.tsx`.

- `shell/` owns sidebar chrome, navigation, search, confirmations, and switcher effects.
- `list/` owns global-first session collection, directory bootstrap demand,
  layout-owned synchronization, authoritative cleanup, and nearby-session prefetch.
- `projects/` owns project zones, grouping, ordering, scroller behavior, project
  view state, repository state, and worktree presentation.
- `sessions/` owns session rows, row actions, expansion, ownership, and activity indicators.
- `recent/` owns Recent and managed Chats activity projections.
- `folders/` owns folder DnD, bulk actions, archived folders, and folder UI.
- Root session right-click and overflow menus expose `Move to worktree`: a submenu
  listing the canonical primary and linked worktree destinations, with the current
  target disabled and a separate `New worktree...` action. Opening the submenu
  refreshes the worktree topology. Moving transfers the full idle subtree. Clean
  and non-Git sources move session-only; a dirty Git source prompts to move only
  the session, move all source changes, or cancel. Descendants move first without
  changes and roll back session-only if a later descendant fails. The root moves
  last and carries source changes once, which prevents rollback from replaying the
  transferred patch into the source.
- Failure cleanup: a worktree created for the move is removed only after a
  definite failure. When the change-carrying request fails without confirming
  its outcome, that worktree is KEPT (it may hold the only copy of the user's
  changes), both directories are refreshed authoritatively because the session
  may have moved server-side, and the toast points the user at the destination.
  Existing destinations are never removed; they get the same guidance.

`MainLayout` and `VSCodeLayout` call `useSessionListSync({ isVSCode })`
unconditionally. The hook publishes complete directory bootstrap demand,
refreshes newly added topology, coalesces control events, and performs
authoritative cleanup. Root-level `useGlobalSessionsPolling` remains the only
initial and 45-second global poller. `useSessionListSync` must not create a
second global polling lifecycle.

The global sessions cache is the complete source for active and archived
coverage. Initialized directory stores only supply sessions missing from that
cache. Live busy and retry state comes from `global-session-status`, never from
the global cache or persisted history. A failed global or directory fetch keeps
existing data; it is never treated as an authoritative empty list.

Web and desktop show managed Chats before optional Recent activity. Chats use
their shared managed root for folders and never expose worktree actions. Project
display can be all projects or one selected project. The mobile sessions sheet
(`apps/MobileSessionsSheet.tsx`) partitions the same way through
`partitionSidebarSessions` and lists Chats as a collapsible section above the
project tree, with no Recent projection. VS Code excludes worktrees and managed
Chats, while retaining its workspace-scoped grouped list and inline archived
buckets.

Directory demand always includes known project roots and worktrees. Visibility
only changes priority. Row mounts must not start bootstrap work. Selection and
activity subscriptions stay session-scoped so a structural list update does not
make every row observe unrelated streaming updates.

## Loading rules

- Always publish every known project root and worktree directory. Collapse/visibility changes priority only; they do not opt a directory out of authoritative refresh.
- Current directory and selected-session directory are `selected` demand and therefore run first.
- Expanded projects/worktrees outrank merely visible and background groups.
- The sync scheduler deduplicates, promotes, retries, and limits work. Sidebar components must not reproduce that lifecycle with mount effects.
- Hide speculative work when the sidebar/chat surface is hidden: message prefetch, Git/PR enrichment and subscriptions, search listeners, sticky-header observation, and archived-folder derivation stop. The session row tree unmounts so row-owned status, permission, unseen, and viewport subscriptions do no background work. The outer sidebar remains mounted, preserving UI state and authoritative directory refresh for an immediate reopen; deferred derived work reruns from current state when visibility returns.
- The sidebar does not subscribe its whole tree to the cross-directory live-session aggregate. Global create/structural/lifecycle snapshots drive rendered session metadata; the cached sync index only fills sessions not yet present globally and provides refresh fallback data. Row activity continues to come from the session-keyed live status index.
- Session selection does not invalidate the sidebar orchestration component. Each mounted row selects only whether its own session ID is active, while parent expansion, project selection memory, and neighbor prefetch run in small effect-only subscribers.
- Parent expansion is exclusively manual. Selecting or navigating to a subsession never expands its parent automatically. Project/worktree and `recent` trees use independent persisted context keys and receive separate stable projections, so expansion changes in one context neither invalidate nor change the other. The persisted storage key remains `v3`; older state mixed contexts and is not migrated into this contract.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, share, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- A worktree git still registers but whose directory is gone (`prunable` in `git worktree list`) stays in the topology with `worktreeStatus: 'missing'` and a warning icon on its group header. Dropping it would hide every session that lived there, and a hidden session cannot be opened, so it could never be relocated. Opening one of those sessions relocates it to the project root (`recoverMissingSessionDirectory`), and the empty group is removed through the ordinary worktree delete action, which `git worktree remove --force` accepts for a missing directory. Topology refresh stays event-driven: besides `session-created`, the sidebar rediscovers on `subscribeWorktreeTopologyChanged`, which the relocation raises after the server confirmed a directory missing. No idle polling is added.
- Opening the root-session `Move to worktree` submenu force-refreshes the owning project's worktree topology so externally created worktrees appear without a full reload. While that refresh runs, the menu keeps the last known primary/linked topology visible; if the refresh fails, the stale topology remains and the load failure state stays explicit. Failure cleanup never removes or manages an existing destination worktree.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event retriggers bounded worktree discovery so a newly created external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- Recent membership includes active root sessions immediately even when their last committed `time.updated` falls outside the 48-hour window. Children and archived sessions remain excluded, and inactive roots remain timestamp-based. The active-ID subscription is disabled while the sidebar is hidden and ignores retry/status detail changes, avoiding streaming-frequency rerenders.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, or branch changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- Directory permission failures remain visible even when stale sessions are retained. Flat groups inspect every represented root/worktree directory; local Desktop may open the native picker for the exact failed directory, while other runtimes keep the ordinary Retry action.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
- Pending-permission/question row badges fade with the same hover/menu-open rule as the date label, except on non-VS Code always-visible-actions rows, which reserve permanent padding and keep the badges shown. VS Code hover-reveals its actions over the row's right edge even under `alwaysShowActions`, so its badges keep fading (`selectRowBadgeVisibilityClass` in `sessions/sessionNodeItemUtils.ts`).


## Project action indicators

`SidebarTerminalActivity` shares terminal discovery with the action header and terminal
panel while the sidebar is visible. One server listing covers all directories, including
collapsed projects. The sidebar keeps that loop running only while a project action is
known to be running anywhere; with nothing running it lists once on mount, to pick up
runs another client started, and then stays quiet so an idle sidebar costs no polling. It preserves local mutations newer than the listing and keeps known
state on failure. Terminal discovery is separate from OpenCode session bootstrap.

`DirectoryActionIndicator` reads only its directory's terminal metadata. Output chunks and
unrelated directories do not rerender it. It displays a static `pulse` icon in `status.info`
for live project actions, including auto-discovered commands. Persisted idle tabs and ordinary
interactive terminals do not indicate activity. This indicates process activity, not server
readiness.

Grouped views show the icon on project-root and worktree headers. Flat project views show
it on the project-root header and on sessions in linked worktrees. Recent shows it on every
session with an active action in its own directory. Archived buckets do not show action
indicators. Indicators stay inside the existing row/header action-padding boundary, so
hover, keyboard focus, and always-visible action buttons move them left without hiding them.
