# Session Sidebar

Sidebar code is organized by the business object it owns. Shared contracts are
kept at this root in `types.ts` and `utils.tsx`.

- `shell/` owns sidebar chrome, navigation, search, confirmations, and switcher effects.
- `list/` owns global-first session collection, directory bootstrap demand,
  layout-owned synchronization, authoritative cleanup, and nearby-session prefetch.
- `projects/` owns project zones, grouping, ordering, scroller behavior, project
  view state, repository state, and worktree presentation.
- `sessions/` owns session rows, row actions, expansion, ownership, and activity indicators. A collapsed group or folder shows one indicator for its hidden sessions: a pending permission (shield) outranks a pending question, which outranks a running turn, which outranks unread. Pending requests are read from the cross-directory `global-blocking-requests` index, so a project never opened in this launch still shows them; running and unread come from the global status index and the notification store.
- `recent/` owns Recent and managed Chats activity projections.
- `folders/` owns folder DnD, bulk actions, archived folders, and folder UI.
- `sessionSidebarRowModel.ts` owns the ordered, mode-neutral projection for
  Chats, Recent, projects, groups, folders, sessions, status notices, empty
  states, and reveal controls. `SessionSidebarRows.tsx` is the shared desktop
  Web, Electron and VS Code sidebar row renderer. Normal and committed-search modes use the same
  model and the same `@tanstack/react-virtual` instance.
- `list/useSidebarGroupStatus.ts` subscribes to project and standalone Chats
  directories together. Chats uses the same `activity:chats` identity for status
  and row projection, including a Chats-only sidebar. An unresolved global list
  keeps unopened groups loading; a global failure exposes Retry against the global
  loader, without bootstrapping a directory. A complete global snapshot or complete
  active-directory coverage stops loading independently of initialization. Archived
  groups require global coverage. Directory failures keep their retry/access actions.
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
unconditionally. The hook is the only bootstrap demand owner and publishes
only the current directory and the selected session's directory; it also
refreshes newly added topology, coalesces control events, and performs
authoritative cleanup. Root-level `useGlobalSessionsPolling` remains the only
initial and 45-second global poller, with bounded startup recovery.
`useSessionListSync` must not create a second global polling lifecycle.

The global sessions cache is the complete source for active and archived
coverage. Initialized directory stores only supply sessions missing from that
cache. Live busy and retry state comes from `global-session-status`, never from
the global cache or persisted history. A failed global or directory fetch keeps
existing data; it is never treated as an authoritative empty list.

Activity indicators use `SessionActivityIndicator` in project and timeline rows,
header tabs, switchers and collapsed aggregates. Each state is a static icon:
the session's own run is `circle`, a pause held open by a background subagent
is `robot`, one held open by a background command is `terminal` (all info
color; `useSessionTurnActivity` in `sync/global-session-status.ts` decides, the
session's own run first, then the subagent), and a finished unseen turn is
`checkbox-circle` (success color). Collapsed aggregates show only running or
unread. The local Appearance preference `animatedActivityIndicators`
is off by default. Enabling it swaps every running kind for a stepped spinner,
even when the OS requests reduced motion; the unread icon stays. Permission/question badges and per-session
elapsed counters retain their existing precedence and behavior. The display
store is at version 9: missing preferences inherit the default during hydration,
while an explicitly saved choice survives reload.

Full-app active records remain in the collection when their directory is no
longer in known topology, such as a deleted worktree. Grouping first uses exact
configured project/worktree ownership. It may then use authoritative OpenCode
project metadata only when that project's canonical worktree maps to a
configured project root. This fallback changes display ownership, not the
session's real directory used for routing. Records with no resolved owner have
no guaranteed project group. VS Code keeps exact workspace-directory scope and
does not use the fallback. The mobile sheet, Recent, and Timeline use this
same ownership resolver; rows keep the session's own directory while
taking display ownership (project id, labels) from the index.

Web and desktop show managed Chats before optional Recent activity (off by
default since the timeline view exists; the display menu toggles it). Chats use
their shared managed root for folders and never expose worktree actions. Project
display can be all projects or one selected project. The mobile sessions sheet
(`apps/MobileSessionsSheet.tsx`) partitions the same way through
`partitionSidebarSessions` and lists Chats as a collapsible section above the
project tree. In the grouped view its display panel offers the same Recent
toggle (`sidebarShowRecentSection`, per surface, so the phone and the desktop
choose separately): a collapsible section under In work with the desktop's
membership (`useRecentSessionCollection`), subsessions kept for expansion,
compact rows labelled "project · branch" through `resolveSidebarSessionLocations`
with the desktop Recent policy (live root branch included, a branch equal to
the project label hidden; the branch map is held while the drawer closes),
seven rows before Show more. A session of an isolated space has the space's
name where the branch goes and `inSpace` set on its location, so the Timeline
rows of the desktop and the phone, and the Recent tooltip, mark it with the
container icon the space's group carries, never with the branch icon. The
timeline never shows Recent. VS Code excludes worktrees and managed
Chats, while retaining its workspace-scoped grouped list and inline archived
buckets.

Worktree groups inside a project follow `worktreeSortOrder` (profile setting
`sidebarWorktreeSortOrder`, default `manual`). `recent` floats worktrees by session activity, so
they move while sessions run. `manual` and `a-z` never read activity: both start
alphabetical, and only `manual` applies the saved drag order
(`oc.sessions.groupOrder`) and enables worktree dragging. The mobile sheet keeps
its own manual worktree order (`useWorktreeOrderStore`).

Hosted mobile and Capacitor use their separate `MobileSessionsSheet` renderer.
The shared directory-cache rules apply there, but this sidebar virtualizer does not.

Both project display modes use `projects/CrossfadeZoneHeaders.tsx` for sticky
zone headers. The live header keeps one portal host as it moves between its
virtual row placeholder and a stationary layer inside the native scroller,
preserving its controls and menu state. The global virtualizer keeps the current
and adjacent project/activity headers mounted and publishes each row's logical
start for boundary measurement. Row and header resizing or virtual-start changes
refresh cached boundaries; scrolling only compares those offsets
and changes the DOM at a zone handoff. An inert, accessibility-hidden snapshot of
the outgoing header fades over the incoming header for 150 ms. Reduced motion
skips the fade. Project dragging temporarily returns headers to their sections
without remounting controls. Reordering refreshes boundaries using layout offsets
that include virtual positioning but exclude sortable transforms, so settling
animations cannot leave stale header positions. The sidebar has no separate
desktop-only top gradient or identity overlay.

Directory demand covers only the directory being worked in. Showing,
expanding, or restoring a project never bootstraps it. Row mounts must not start
bootstrap work. Selection and activity subscriptions stay session-scoped so a
structural list update does not make every row observe unrelated streaming
updates.

Session-row permission and form badges read the relevant directory-store buckets. A collapsed row counts its own pending requests and those of the descendants it hides; an expanded row counts only its own. Flat Timeline rows carry badge-only scopes from their full session tree while keeping their rendered node childless, so selection, search, and row nesting do not change. Counting never bootstraps a directory; an unbootstrapped directory contributes zero until live state arrives.

Session menus share `SessionAiRenameMenuItem` with header tabs and the
single-session header. AI renaming uses the same leading spinner as a worktree
move; the pending operation survives closing the menu or selecting another
session. Eligibility loads only while a menu is open. See the AI session titles
section in `sync/DOCUMENTATION.md` for context selection and mutation guards.

Manual rename inputs share `components/session/sessionRenameKeyboard.ts` with
the header and mobile list. Enter explicitly submits the owning form on
keydown; Escape cancels. IME composition keys keep their text-input behavior,
and held Enter does not submit repeatedly.

## Multi-run rows

A multi-run (`lib/multirun/runs.ts`, two or more active members) renders as one
`run` row instead of one row per lane. `SessionProjectCollection` builds the
run index from the active root sessions and hands it to the row model; grouping
only receives `runKeyBySessionId`, kept referentially stable while membership is
unchanged so ordinary session updates do not invalidate project sections.

- Grouping lists every member under the project root, so a lane's worktree
  does not form its own group while it belongs to a run. After "Keep" the
  survivor is no longer a run member and falls back into its worktree group.
- The row model collapses members into one entry at the first member's
  position (`collapseRunEntries`) in every container: project groups, folders,
  Recent, Work and Timeline. A run spends one slot of a reveal limit.
- The run row is not a session: it never enters selection or the selection
  pool. Expanded (`runExpansionKey`, same `expandedParents` store) it lists its
  lanes as session rows one level deeper; search forces it open. In Timeline
  it never expands and renders through `SessionTimelineRowBody` like the
  session rows around it (project and time, title, lane count and model
  logos); the overview lists the lanes.
- Its activity indicator aggregates the lanes through
  `CollapsedSessionActivityIndicator`. Clicking it opens the run overview
  (`useUIStore.runOverviewKey`); a lane's context menu offers the same.

The mobile sheet does not use the row model: `MobileSessionsSheet` builds the
same index, moves members to the project root bucket and renders one
`MobileRunRow` per run that opens the overview. Row memoization compares
membership semantics (`sameMultiRunIdentity`, including the run title) so
metadata-only changes update rows. See `lib/multirun/DOCUMENTATION.md`.

## In work

Sessions in work (`metadata.openchamber.work.state === 'open'`, see
`packages/web/server/lib/session-work/DOCUMENTATION.md`) render in their own
`work` activity zone under Chats and above Recent / the timeline, in both view
modes, while `sessionWorkEnabled` is on. `list/SessionProjectCollection.tsx`
selects them from the ordered collection (top-level, unarchived, not managed
Chats, shared lifecycle order) and passes `workItems`, `workSessionIds`, and
`keepWorkInGroup` (from `sessionWorkKeepInGroup`) to the row model. A session
in work MOVES: the row model drops it from Recent, the Timeline list, and
Chats, so it appears once there. By default it also leaves its project group
and folders; with `keepWorkInGroup` on it stays in its project group and
folders as well, so it appears in two places. Chats are never in work and offer no Track
action. An empty zone is not rendered. Rows use
`renderContext: 'timeline'` in the timeline view and `recent` (project and
branch shown) in the projects view. Search in the projects view keeps a tree
whose subsession matches (`sessionTreeMatchesSidebarQuery`): those subsessions
are nowhere else in the sidebar. The zone counts only sessions that match
themselves (`countSessionTreeQueryMatches`), and a group subtracts the trees
that moved out of it with the same counter its search data used
(`countSessionSearchMatches`), so one exact id is one match; a group or project
whose only matches moved renders nothing. Track / Done captures the runtime key at the
click (`setSessionWorkState`), so a server switch mid-request writes nothing to
the new server.

Row actions revealed on hover are the same three in both views: Track / Done
(eye in the muted action color like its neighbours / check in
`status.success`, one icon size up because the glyph draws small), quick
archive/delete, the menu. Pin/unpin lives in the menu only. Touch layouts (`alwaysShowActions`)
keep Track / Done in the menu. At rest a row in work shows a grey check only
while Jev's done hint is current (`isDoneSuggested`); the composer shows the
same hint as a top row (`components/chat/SessionDoneHintRow.tsx`). The
whole-row tooltip in the projects view shows the current recap. The mobile
sheet (`apps/MobileSessionsSheet.tsx`) mirrors it: an "In work" section under
Chats takes the sessions in work with their subsessions out of the project
buckets and the timeline, and Track / Done is a swipe action on top-level
rows. Mobile swipe actions run left to right by how often they are used on a
phone, because a short drag exposes the leftmost first: archive, pin (top-level
rows), Track / Done (top-level rows, feature on), delete, rename; AI rename sits
inside the rename editor. Top-level rows also show a pin marker beside the
time; pins are the same device-local `useSessionPinnedStore` the desktop menu
writes, so a pin set on one device does not appear on another. Mobile rows
also show the goal glyph and the permission/question badges
(`apps/MobileSessionStateBadges.tsx`): before the time on grouped rows, at the
end of the branch line on timeline rows. Counts come from the cross-directory
request index (`sync/global-blocking-requests.ts`), not directory stores, so a
never-opened project still shows them; a collapsed or timeline row also counts
its subsessions' requests. Row memoization
compares `metadata` by reference and `time.idle`, so metadata-only changes
(work, goal, recap) re-render the row.

## Timeline view

`sidebarViewMode` (profile-scoped, per surface) switches the desktop and web
sidebar between `projects` and `timeline`. VS Code has no switch and always
renders `projects`.

- Timeline keeps the managed Chats zone, with an initial reveal of 3 instead of
  the usual Chats limit. Pinned chats are always shown and never spend that
  limit, so Show more/Show fewer count only unpinned rows. Chats rows render
  with `renderContext: 'timeline-chat'`: one line, no left gutter, pin marker
  and status icon on the right beside the time; the goal glyph and badges ride
  in the same cluster. Collapsing a zone header resets its
  Show more state.
- Zone collapse state lives in `useSessionProjectViewState` next to project
  collapse and lasts for the mount only. The display menu's Collapse all /
  Expand all (grouped view only) set every project and the grouped zones
  (`GROUPED_ACTIVITY_KEYS`: Chats, In work, Recent) together; the timeline's
  Projects zone keeps its own state. Session folders keep their own collapse
  state.
- Zone headers are sticky in the projects view and never in the timeline; there
  is no user toggle. Timeline zone headers drop the leading icon and use a
  taller band.
- Below Chats it renders one `timeline` activity header (a sticky zone header
  like `chats` and `active-now`) followed by every non-archived root project
  session from all projects and worktrees in one flat list, in the shared
  lifecycle order, with pinned sessions floating first. There is no reveal
  limit: the list is virtualized.
- Timeline rows carry `renderContext: 'timeline'`, depth 0 and empty children.
  They never expand, show no chevron, no folders, no project headers, no
  worktree groups and no Recent projection. Folders are not projected, so the
  row menu hides `Move to folder`. Their archive/delete actions still
  cover the full subtree, because `collectSessionSubtreeIds` resolves
  descendants from the global cache at action time.
- `worktreeIndex.ts` is the shared exact worktree index (normalized keys,
  project-root exclusion, first-wins dedupe) for Recent/Timeline, project
  grouping, and the session switcher. `recent/sessionLocation.ts` is the single
  owner of a session's project, directory, worktree and branch label: it resolves
  the project through the session ownership index first (managed worktrees live
  outside the project path), falls back to a path-prefix match, and finds the
  containing worktree by longest prefix so a session in `<worktree>/sub` keeps
  that worktree's branch and PR key. Branch labels are live-first: live git
  status wins over discovered worktree metadata. Recent hides a branch equal to
  the project label; Timeline shows the branch on every row, using the live
  project root branch for root-directory sessions and the worktree branch
  otherwise.
- Recent resolves each root and active descendant against its own directory and
  owner. Its projection attaches that worktree at every depth, including children
  under worktree subdirectories; an unresolved worktree stays null. Each visible
  row also resolves its own tooltip metadata rather than inheriting its parent's
  branch, preserving the resolver's deliberate branch suppression. The full
  subtree remains available to archive/delete actions, and managed Chats keep
  their separate projection.
- A timeline row's third line ends with its state cluster: goal glyph, PR (or
  the zombie warning), permission/question badges, provider logo. The goal
  sits there rather than in the first-line meta because hover actions cover
  that meta and the running counter owns it during a turn.
- Search filters Timeline with the same rule as Recent (exact `ses_` id, else
  title contains) and counts one match per listed row.

## Search

Dedicated search fields in the sidebar, mobile session list, and archive submit
only on Enter. `SessionSearchInput` owns draft text locally; list owners receive
only committed queries, so typing does not invalidate the session tree. Clearing
the field resets the applied query immediately. IME confirmation and held Enter
do not submit. Escape clears text first, then closes the sidebar search when
already empty. Session rows receive one stable reset action rather than transient
search-open or draft state. Closing a retained mobile search discards unsubmitted
text.

The desktop sidebar field and its query go together: whatever hides the field
(the search button, Escape, a click outside the sidebar, opening a session)
also clears the query, so the list is never filtered by text that is not on
screen. When a query matches nothing, the empty state offers "Search the
archive": it opens the Archive page with that query in its field and clears the
sidebar search. VS Code has no Archive page and no such button. The Archive page
is mounted only while open and keyed by its open count, so every open, including
a handover while it is already on screen, starts with the query it was given
(empty for a plain open) and no directory filter.

The header's page buttons (Issues and PRs, Scheduled tasks, Archive, extension
pages, Usage in the footer) are toggles: pressed while their page is open, and
the next click closes it.

Sidebar and Recent queries beginning with `ses_` match only the full session ID,
case-insensitively and ignoring surrounding whitespace. Partial IDs and typos
return no matches, without falling back to titles, directories, group labels,
or folder names. Ancestors remain as tree context for a matching child. A matched
node keeps its subtree for rendering and subtree actions. Only exact ID matches
count toward the result total.

Search changes model inputs, not renderer ownership. It forces project, group,
folder, and activity rows open without changing the normal-mode collapse or
show-more state. Closing search therefore restores the exact prior Chats,
Recent, project, group, and folder projection.
ID search does not include archived sessions. `ArchiveView` applies the same
exact-ID rule to its own archived list. Other queries keep each view's existing
matching and ordering. Search does not fetch sessions or broaden list membership.

## Loading rules

- Publish bootstrap demand only for the current directory and the selected session's directory. Known project roots and worktrees are topology, not demand: rows and sessions come from the global session list, activity from the global status index and the host status seed. Every directory-scoped read makes OpenCode create and initialize a location, so demanding the whole topology created one per project at startup.
- Directory demand and refresh requests preserve path case after separator and drive-letter normalization. Case-insensitive sidebar membership keys stay inside the collection projection; sending those keys as paths creates duplicate directory stores and can address a different directory on case-sensitive filesystems.
- A never-bootstrapped directory is ready only after a complete global snapshot. Before that, the group shows global loading or failure, and Retry reloads the global list. Previously loaded groups stay ready during background polling. Directory failures and denied folder access still use forced bootstrap or native access recovery for the affected directory.
- The sync scheduler deduplicates, promotes, retries, and limits work. Sidebar components must not reproduce that lifecycle with mount effects.
- Hide speculative work when the sidebar/chat surface is hidden: message prefetch, Git/PR enrichment and subscriptions, search listeners, sticky-header observation, and archived-folder derivation stop. The session row tree unmounts so row-owned status, permission, unseen, and viewport subscriptions do no background work. The outer sidebar remains mounted, preserving UI state and authoritative directory refresh for an immediate reopen; deferred derived work reruns from current state when visibility returns.
- Change-request enrichment uses worktree topology only to discover at most 50 unique demanded directories in stable project order. Repository binding selects the primary provider, instance, account, revision, and primary remote; connected accounts outside that binding add no requests, and missing or `needs-attention` bindings create no provider request.
- Binding discovery shares the [repository binding owner](../../../lib/source-control/DOCUMENTATION.md) with editors and pickers. Mounted directory subscriptions refresh affected status demand after binding mutations; the existing status timer does not poll repository bindings. Auth-entry changes update only directories using that entry and do not release or reload bindings.
- The sidebar does not subscribe its whole tree to the cross-directory live-session aggregate. Global create/structural/lifecycle snapshots drive rendered session metadata; the cached sync index only fills sessions not yet present globally and provides refresh fallback data. Row activity continues to come from the session-keyed live status index.
- Session selection does not invalidate the sidebar orchestration component. Each mounted row selects only whether its own session ID is active, while parent expansion, project selection memory, and neighbor prefetch run in small effect-only subscribers.
- Parent expansion is exclusively manual. Selecting or navigating to a subsession never expands its parent automatically. Project/worktree and `recent` trees use independent persisted context keys and receive separate stable projections, so expansion changes in one context neither invalidate nor change the other. The persisted storage key remains `v3`; older state mixed contexts and is not migrated into this contract.
- `SessionTreeItem` is memoized with a comparator over the props it actually
  reads: the row list re-renders on every virtualizer frame while scrolling and
  on every model rebuild, spreading a shared props bag and a fresh
  `renderExtras` object onto each row, so identity comparison would never
  match. Sessions and secondary metadata compare by value; a scroll therefore
  renders only rows entering the viewport, and a model rebuild only rows whose
  session changed.
- The sidebar model flattens parent/child sessions into occurrence-keyed rows.
  `SessionTreeItem` renders one row with `renderChildren={false}`; it must never
  recursively mount descendants in the shared scroller. One preorder ID pool
  plus index ranges supplies hidden descendants to subtree selection without
  copying a descendant array for every ancestor.
- A row's `depth` is its visual indent, not its tree depth: a folder's sessions
  and run rows start at 1 so they sit under the folder header, and children add
  one level from there. Do not read `depth > 0` as "this is a subagent".
- The existing `ScrollableOverlay` is the sole scroll owner. The shared row
  renderer measures variable-height rows, uses stable occurrence keys, keeps a
  bounded pre-initialization window, and pins editing, focused, and open-menu
  occurrences in its range extractor. The scroller publishes its DOM element
  through callback-backed state so virtualization activates after every mount
  without waiting for an unrelated render. Archived groups must not add a
  nested virtualizer.
- An unmeasured row is estimated at the measured height of a row with the same
  kind, render context and trailing section gap (`sessionSidebarRowSizeKey`),
  falling back to the model estimate plus that gap. The virtualizer corrects the
  scroll position whenever a row above the viewport measures differently from
  its estimate, and those writes land in the middle of a scroll gesture as small
  jumps; rows of one key share a height at any interface font size, so after
  the first rows mount the estimates are exact.
- Sticky project/activity identity comes from model header descriptors and the
  first visible virtual index, which keeps the live current and adjacent header
  rows mounted. `CrossfadeZoneHeaders` uses their cached virtual layout offsets
  for the visual handoff. DOM sentinels and intersection observers are not used.
- Shift selection and Ctrl/Cmd+A consume the model's logical row order. API
  session IDs are deduplicated only at the action boundary, after hidden
  descendants have been included. Selection is cleared on runtime switch and
  confirmed session deletion. Bulk destructive actions classify archive state
  from the model's current session records at action time, never mounted DOM or
  selection-time metadata. A confirmation owns an immutable ID and action
  snapshot; changed targets or archive authority require confirmation again.
  The current session map comes from unfiltered project sections, so collapsing
  a project or entering search cannot hide authority for an existing selection.
- Rename drafts stay parent-owned, while editing and menu lifecycles are keyed
  by row occurrence. Duplicate Recent, project, and folder rows never open a
  second rename input, and the owning occurrence remains mounted through menu
  close completion. `useSessionRowMenuState` keeps the shared open-menu key
  pinned until close completion while a local close request drives the
  controlled `open` prop; a controlled menu whose `open` follows the pinned key
  never closes, so its deferred rename never starts.
- Folder drops carry occurrence drag keys and owner-scoped targets. A drop is
  accepted only when the current model marks every owner scope complete and
  the source and target owner match. Archived rows and archived targets never
  accept drops.
- Session rows allow vertical touch panning before the long-press drag activates.
  The TouchSensor owns movement only after activation; disabling touch panning on
  the whole row prevents quick swipes from scrolling even when no drag starts.
- `folders/SessionSidebarFolderItem.tsx` owns activity subscriptions for mounted
  collapsed folder headers. It includes descendant activity and respects the
  unread-subtask preference without mounting those sessions. Expanded and archived
  folders do not derive hidden activity.
- Single-project flat mode reveals 20 root sessions initially and 20 per Show
  more; Show fewer resets to 20. Chats retains its own default reveal size. Reveal
  controls change the logical list, not the viewport's bounded mounted window.
- Archiving or deleting a session takes its whole active subtree with it on every surface, because the server does not cascade `time.archived`. Recent and managed Chats build their rows with `buildActiveSessionNode` from `list/sessionCollection.ts`, so the descendants a row collects match the project tree at any depth; the mobile sessions sheet resolves the same lineage with `getDescendantIds` over its full active list rather than the rendered bucket. `sessions/sessionSubtreeActions.ts` owns the single-versus-batch store calls and the outcome toasts for all of them, and `collectSessionSubtreeIds` extends the surface's own descendant list at action time with a walk over the global active-plus-archived cache, so an active subagent below an archived intermediate is still archived (archive skips the archived intermediate; delete includes it). A projection that flattens a tree to one level silently leaves grandchildren active.
- Subsessions belong to the agent run that spawned them, not to the user. They appear only nested under an active parent: the archive (sidebar bucket, auto folders and the Archive page) lists top-level sessions only, an archived subsession or one under an archived parent is hidden rather than promoted to a row of its own, and there is no restore for a subsession; it comes back when its parent is restored. A subsession whose parent is not loaded yet stays visible as a root.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild, from the global cache or from the live child-store list: the structure takes only the live sessions the global cache does not hold yet (`selectLiveGapSessions`), so a covered session's live bumps leave it untouched. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- A worktree Git still registers but whose directory is gone (`prunable` in `git worktree list`) stays in the topology with `worktreeStatus: 'missing'` and a warning icon on its group header. Its sessions remain accessible for manual movement or archiving through worktree deletion. Opening a session does not move it. The ordinary worktree delete action accepts a missing directory. Shift+click on the worktree delete button (it turns red while Shift is held) archives the group's sessions and deletes the worktree and its local branch without the dialog, never the remote branch, but only when a fresh status check finds no uncommitted changes and every commit already on the branch's upstream or, for a never-pushed branch, on the base branch the server compared it with (`aheadBase`, e.g. `origin/main`) or on another remote branch (`canDeleteWorktreeWithoutConfirm`); any other result, including a failed check or a never-pushed branch the server could not compare, opens the ordinary dialog. Topology discovery remains event-driven, including `session-created` and server `worktree-changed` control events, with no idle polling. A `session-created` event refreshes only the project whose root is the session's directory or whose known worktree holds it (`resolveProjectForCreatedSession`); any other directory, such as a new worktree nobody has listed yet, gets the full discovery, because a registered folder above it does not prove which repository it belongs to. After an instance switch the project list comes from the local cache, so discovery can run before the instance answers: projects whose discovery failed are discovered again once when the connection comes up. The worktree list and project-root caches are keyed by path, so a runtime switch clears them. The server sends `worktree-changed` after its own worktree create/remove and when a status or listing request notices that a repository's worktree set changed (see `packages/web/server/lib/git/DOCUMENTATION.md`); the event names every directory of that repository the server has seen, and the sidebar refreshes each registered project among them once, bypassing the 30-second list cache. A worktree this client created and is still bootstrapping keeps its `pending`/`invalid` status through that refresh. Hosted mobile and the desktop mini chat handle the same control event through `lib/worktrees/worktreeTopologyRefresh.ts`; VS Code intentionally excludes worktree topology.
- A worktree this client is removing shows it on its row, from the user's confirmation until git answers: a spinner replaces the branch icon, the row dims and its delete action hides. The desktop group header, the mobile sheet's worktree bucket and the mobile project-edit worktree list all read `lib/worktrees/worktreeRemovalState.ts`. The row leaves with the topology once git confirms. It does not fade out: the server's `worktree-changed` refresh drops it as soon as the removal finishes, which would cut any exit animation short. A failed removal clears the state and the row returns to normal beside the error toast. Removing the files of a large worktree takes tens of seconds, so the spinner stays for as long as the deletion runs, never shorter. Another window removing the same worktree shows nothing until the topology refresh drops the row.
- Opening the root-session `Move to worktree` submenu force-refreshes the owning project's worktree topology so externally created worktrees appear without a full reload. While that refresh runs, the menu keeps the last known primary/linked topology visible; if the refresh fails, the stale topology remains and the load failure state stays explicit. Failure cleanup never removes or manages an existing destination worktree. The owning project resolves from the row's project id, then from the session's directory, then from the session's worktree metadata `projectDirectory` — the last step keeps sibling destinations listed for a restored session whose own worktree directory was deleted.
- Unarchiving a session whose directory the server confirms missing (its worktree was removed while it sat in the archive, by this app, by hand or by git) moves it, with its subsessions in that directory, to its project root (`lib/worktrees/relocateRestoredSession.ts`, maintainer decision 2026-10-02). OpenCode cannot run a prompt in a missing directory (it answers 500), while `session.move` works from one and appends a `location-switched` record that tells the model its working directory changed. The project root comes from the same ownership index as grouping (directory first, then OpenCode project metadata), so it survives a restart. A toast names the cause, the missing folder, not an action of this app. An unknown availability answer, an unresolved project or a missing project root leaves the session where it is; a rejected move shows an error toast.
- Cleanup after a PR merge is opt-in (`mergedWorktreeCleanupEnabled`, Settings → Sessions, off by default; maintainer decision 2026-10-02). `hooks/useMergedWorktreeCleanup.ts` reads the branch PR status the sidebar already keeps fresh for each discovered linked worktree, asking GitHub nothing itself, and `lib/worktrees/mergedWorktreeCleanup.ts` decides: wait while any session there is not confirmed idle, is the open session, or the worktree is the directory on screen; otherwise archive its sessions, and remove the worktree with its local branch only when the checkout is clean and has no commit outside the merged PR's head commit (`head..HEAD` is empty, so a checkout behind a PR that gained commits on the host qualifies). When this clone never fetched that commit, a branch whose upstream it is not ahead of qualifies too; with neither answer the worktree stays. Sessions are archived once per worktree and PR pair (remembered in local storage), so work continued in a kept worktree is never archived again. A kept worktree without sessions is checked again on every pass and removed once nothing there can be lost; sessions in a kept worktree mean the work went on, and it is left alone. It runs on desktop and web only; VS Code has no worktrees and a phone would race the desktop it drives. Only worktrees of projects whose worktrees the sidebar has discovered are covered.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event re-lists the worktrees of the session's project, or of every project when the session's directory is not a project root or a known worktree, so a newly created external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- Recent membership includes active root sessions immediately even when their last committed `time.updated` falls outside the 48-hour window. Children and archived sessions remain excluded, and inactive roots remain timestamp-based. The active-ID subscription is disabled while the sidebar is hidden and ignores retry/status detail changes, avoiding streaming-frequency rerenders.
- A successful restore on the current runtime promotes only the session's ephemeral list-order rank. It does not change timestamps or live status, and it resets on a runtime switch. Restore does not change Recent's existing active/48-hour membership rule.
- `useProjectRepoStatus` reads Git status once per project path while the sidebar is visible. A change to the project list that adds no path (collapse, rename, color, last opened) reads nothing; an added project reads only its own status; a failed read is retried on the next list change. Hiding the sidebar or switching runtime starts over.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, or branch changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- List loading and workspace initialization have separate states. The spinner follows only the list queue; config, MCP, LSP, and live-state recovery cannot keep a successful empty list spinning. A core initialization failure has a separate localized notice and reuses the retry/native-access actions without clearing loaded sessions.
- Directory permission failures remain visible even when stale sessions are retained. Flat groups inspect every represented root/worktree directory; local Desktop may open the native picker for the exact failed directory, while other runtimes keep the ordinary Retry action.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
- Pending-permission/question row badges fade with the same hover/menu-open rule as the date label, except on non-VS Code always-visible-actions rows, which reserve permanent padding and keep the badges shown. VS Code hover-reveals its actions over the row's right edge even under `alwaysShowActions`, so its badges keep fading (`selectRowBadgeVisibilityClass` in `sessions/sessionNodeItemUtils.ts`).
- Hover-revealed actions on session rows, worktree headers and project headers cross-fade over the right end; they never re-lay the row out. What they cover (date, branch, badges, indicators) fades with opacity, and the title or label's tail fades away under them through the `oc-actions-mask` utility (`index.css`): the row's text line is an `@container`, `--oc-actions-reserve` says how far the actions reach in from its right edge, `--oc-actions-inset` how far the masked text starts from its left. Change a reserve whenever an action's size, count or offset changes. Only permanently shown actions (`alwaysShowActions`) take layout room.
- Tooltips that list PRs or issues (session rows, timeline PR badges, worktree headers) render them as links through `sessions/SidebarRefLinks.tsx` and close 750 ms after the pointer leaves, so the pointer can travel in. The row and header action buttons sit in their own `TooltipProvider`: the pointer crosses them on the way, and a same-group tooltip would replace the open one at once. Timeline rows keep the row tooltip trigger disabled, since an empty row tooltip blocks the badge's.


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
