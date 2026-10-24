# Session Sidebar

Sidebar code is organized by the business object it owns. Shared contracts are
kept at this root in `types.ts` and `utils.tsx`.

- `shell/` owns sidebar chrome, navigation, search, confirmations, and switcher effects.
- `list/` owns global-first session collection, directory bootstrap demand,
  layout-owned synchronization, authoritative cleanup, and nearby-session prefetch.
- `projects/` owns project zones, grouping, ordering, scroller behavior, project
  view state, repository state, and worktree presentation.
- `sessions/` owns session rows, row actions, expansion, ownership, and activity indicators. A collapsed group or folder shows one indicator for its hidden sessions: a pending permission (shield) outranks a pending question, which outranks a running turn, which outranks unread. Pending requests are read from the cross-directory `global-blocking-requests` index, so a project never opened in this launch still shows them; running and unread come from the global status index and the notification store.
- `recent/` owns the In work and timeline row projections and session
  locations (the name predates the removal of Recent).
- `folders/` owns folder DnD, bulk actions, archived folders, and folder UI.
- `sessionSidebarRowModel.ts` owns the ordered, mode-neutral projection for
  Chats, In work, projects, groups, folders, sessions, status notices, empty
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
elapsed counters retain their existing precedence and behavior. A session
row's title carries its state too: semibold at full strength while a finished
turn is unseen or a permission or question waits on the user, full strength
while it runs, muted otherwise; the active row keeps the selection colors. The display
store is at version 10 (v10 dropped the Recent toggle): missing preferences inherit the default during hydration,
while an explicitly saved choice survives reload.

Full-app active records remain in the collection when their directory is no
longer in known topology, such as a deleted worktree. Grouping first uses
configured project/worktree ownership, matching a directory inside a worktree to that worktree. It may then use authoritative OpenCode
project metadata only when that project's canonical worktree maps to a
configured project root. OpenCode's catch-all `global` project id is excluded
from that bridge: it is shared by every session whose directory resolves to no
configured root (non-git directories, `C:/`, subagent workspaces), so mapping it
would file unrelated sessions under whichever project owns the id. This fallback
changes display ownership, not the session's real directory used for routing.
Records with no resolved owner have no guaranteed project group. VS Code keeps
exact workspace-directory scope and does not use the fallback. The mobile sheet,
In work, and Timeline use this same ownership resolver; rows keep the session's
own directory while taking display ownership (project id, labels) from the
index.

Web and desktop show managed Chats, then Pinned and In work, then the projects
or the list by time (see One view). There is no Recent zone any more (removed
2026-10): In work holds the works in progress, and the list by time answers
"what was I doing" across projects. Chats use
their shared managed root for folders and never expose worktree actions. Project
display can be all projects or one selected project; Chats, Pinned and In work
keep their global scope. The mobile sessions sheet
(`apps/MobileSessionsSheet.tsx`) partitions the same way through
`partitionSidebarSessions` and lists Chats as a collapsible section above the
project tree — only while the per-surface show-chats sidebar setting is on,
which Settings owns; the phone's display menu has no Chats toggle, so a hidden
section here is the setting at work, not a missing section (#5354). Its header
has no title: close, Add project, the display menu
(a dropdown with the view, the project sort, the section toggles and Reorder
projects, which swaps the menu's button for Done while it runs) and New chat;
Chats has no "+" of its own, as New chat starts the same chat. Its footer
keeps Issues and PRs and Settings as buttons and puts Scheduled tasks,
Archive and Usage in a "More" menu. Rows that span projects are labelled "project · branch" through
`resolveSidebarSessionLocations` (live root branch included; the branch map is
held while the drawer closes). A session of an isolated space has the space's
name where the branch goes and `inSpace` set on its location, so the timeline
and In work rows of the desktop and the phone mark it with the container icon
the space's group carries, never with the branch icon. The phone's timeline
(`apps/MobileTimelineList.tsx` rows, built by the sheet) mirrors the desktop:
manual project order with reordering, one header per project over its root
sessions from every worktree and space, 7 at a time with Show more / Show
fewer (collapsing a project resets it), two-line rows with a fixed-height
second line, and the project's icon on that line in In work. Sorted by time
(the display menu's Sessions choice), it lists every project's sessions under
one Projects section in the desktop's three-line rows, without the sessions
Pinned and In work list and without Reorder projects; the sheet is not
virtualized, so the rows arrive 40 at a time as the end scrolls near (an
intersection sentinel in `MobileTimelineList.tsx`), with no Show more row. The
phone's Tree view follows the desktop tree: Chats, Pinned and In work list
tree rows at level 0 (two-line timeline rows when Detailed rows is on, the
zones showing all their sessions at once), and project sessions are
tree rows (12px per level, subsession chevron on the left with a
thumb-sized target) with the desktop's guide lines, worked out while the
sheet renders its nested tree. A tree row shows its live state in the slot left of the
title; a row with subsessions keeps its chevron there, since a phone has no
hover to trade them, and shows its state on the right. Titles carry the state
as on the desktop (`apps/mobileSessionTitle.ts`), and run titles are muted.
Worktree headers are drawn as
folder rows (chevron, 12px icon, medium-weight label a step below full
strength), each opening with a
small gap. Zone and project labels share the header size and no rule
separates projects, as zones and projects are sections of equal weight. Its tree starts 32px in
(`MOBILE_TREE_BASE_PADDING_PX`), so root session titles start where the
project label does next to the project icon's 32px slot (no tile: a bare
20px glyph, or a 24px image with rounded corners; zone icons likewise). In
Tree the phone shows the project's and each worktree's chat folders above
their other sessions, in the desktop's order with sub-folders named
"Parent / Child", each a folder row with its filed top-level sessions one
level under it. The phone does not create, rename, delete or file folders: its
rows have no menu, and the swipe actions already hold the five actions a phone
uses most; folders are edited on the desktop or the web, and the phone shows
the change at once. Collapsing a folder there is the phone's own, as
everywhere. A search lists its matches without folders, and List has none,
as on the desktop. Its display menu offers the Pinned and In work toggles and, in Tree,
Detailed rows; pinned sessions and sessions in work stay under their project
in both views. VS Code excludes
worktrees and managed
Chats, while retaining its workspace-scoped grouped list and inline archived
buckets.

Worktree groups inside a project follow `worktreeSortOrder` (profile setting
`sidebarWorktreeSortOrder`, default `manual`). `recent` floats worktrees by session activity, so
they move while sessions run. `manual` and `a-z` never read activity: both start
alphabetical, and only `manual` applies the saved drag order
(`oc.sessions.groupOrder`) and enables worktree dragging. The mobile sheet keeps
its own manual worktree order (`useWorktreeOrderStore`).

Every other list of projects shows them in the sidebar's order through
`list/useProjectsInSidebarOrder.ts`: Settings > Projects, the project
selector of the Settings pages, the composer's project picker until a search
is typed, the move-chat, scheduled tasks and install-skill pickers, the
tracker project mapping, usage stats and the issues board. It applies the same
`sortProjectsByOrder`, keeps the manual order while the phone shows its List
view, and for `recent` ranks by `rankByLatestActivity` with the sidebar's
ownership rules over the global session list, archived sessions included; a
live session the global list has not picked up yet counts once it does. It
reads sessions and spaces only in `recent` and only while its list is shown
(`enabled`), keeps the last order while a closing popup fades, and does not
hold the order under the pointer the way the sidebar does. Search ranking keeps its own order; the
command palette lists projects only for a query, so it does not use it.

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
without remounting controls. Only headers of the dragged kind take part in the
sort: a project moves among project headers, a worktree among the worktree
headers of its own project, so nothing else shifts under the pointer and a drop
always lands on a header of the same kind. Reordering refreshes boundaries using layout offsets
that include virtual positioning but exclude sortable transforms, so settling
animations cannot leave stale header positions. The sidebar has no separate
desktop-only top gradient or identity overlay.

Directory demand covers only the directory being worked in. Showing,
expanding, or restoring a project never bootstraps it. Row mounts must not start
bootstrap work. Selection and activity subscriptions stay session-scoped so a
structural list update does not make every row observe unrelated streaming
updates.

Session-row permission and form badges read the relevant directory-store buckets and show only whether something waits, without a count: one form can hold many questions, and a number that does not drop as the user answers them reads as wrong. A collapsed row covers its own pending requests and those of the descendants it hides; an expanded row covers only its own. Flat Timeline rows carry badge-only scopes from their full session tree while keeping their rendered node childless, so selection, search, and row nesting do not change. The lookup never bootstraps a directory, so an unbootstrapped directory's store holds only live requests; until that store completes a bootstrap, the row lookup also reads forms from the cross-directory index, which the host seed fills at load, so a question already waiting in a project this client never opened still shows after a reload. Mobile rows show the same icon-only badges from the cross-directory index (`apps/usePendingRequests.ts`). A page an agent shows that waits for the user's answer has no directory-store bucket, so the row lookup also reads it from the cross-directory index and shows it as a form.

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
  Pinned, In work and the list by time. A run spends one slot of a reveal
  limit.
- The run row is not a session: it never enters selection or the selection
  pool. Expanded (`runExpansionKey`, same `expandedParents` store) it lists its
  lanes as session rows one level deeper; search forces it open. In a zone
  it never expands and renders through `SessionTimelineRowBody` like the
  session rows around it (title and status, then the lane count and model
  logos); the overview lists the lanes.
- Its activity indicator aggregates the lanes through
  `CollapsedSessionActivityIndicator`. Clicking it opens the run overview
  (`useUIStore.runOverviewKey`); a lane's context menu offers the same.

The mobile sheet does not use the row model: `MobileSessionsSheet` builds the
same index, moves members to the project root bucket and renders one
`MobileRunRow` per run that opens the overview. Row memoization compares
membership semantics (`sameMultiRunIdentity`, including the run title) so
metadata-only changes update rows. See `lib/multirun/DOCUMENTATION.md`.

## Works

The desktop and web sidebar lists works, not sessions (`works/DOCUMENTATION.md`
owns the details). A work is either a linked worktree with every session in
it, or a root session of the project root (or of a space) with what nests
under it. Nesting is display lineage (`lib/sessionWorkLineage.ts`,
`resolveSessionNestingParentId`): a subagent under its run (`parentID`), and
under the session it grew out of an auto-review (`originalSessionID`), a fork
or promoted `/btw` (`fork.sessionID`), and a session another session's agent
started through the openchamber tool (`metadata.openchamber.originSessionID`,
written by the server's create route). The folder decides first: a session in
another folder stays a root there, and so does a multi-run lane. Archive,
restore and the Archive page keep OpenCode's `parentID` only.
`list/sessionCollection.ts` and `projects/useSessionGrouping.ts` both build
their trees with it, so the collection's `nestedSessionIds` never lists a
nested session as a root of its own.

A worktree's group header is its work row (`works/WorktreeWorkRow.tsx`); spaces,
the project root and archived buckets keep `SessionGroupSection`. The row
reads like a session row, its title where session titles start: the live
state of its sessions in the slot (running, news, a waiting request), or
while there is none the worktree mark tinted by the branch's PR; the chevron
replaces either while the row is hovered or focused, when there is something
to open (touch layouts keep the chevron and show the state at the end). The
title carries the state as a session's does (semibold for news or a waiting
request, full strength while running, muted otherwise), and the end shows the
running turn's duration, or the last turn's until it is read. The title is
the task title (the branch description,
`WorktreeMetadata.title`; a worktree made for a pull request or an issue
starts with that item's title, the agent's until replaced), until it has one
the title of the session a click
opens, and only for a worktree without sessions the branch; the tooltip
always names the branch. At the end sits the PR or the issue its sessions follow as a tinted mark without its
number (one line has no room for it; the mark's tooltip names it and a click
opens it). It shows no date and no session
count, like the rows around it: the room goes to the title. Every icon before a one-line title
moves the hover mask in by its width (`--oc-actions-inset`), or the title's
tail shows through the hover actions. A click opens the latest
session that is not a review or a fork, else the latest of any kind, else a
draft in the worktree (`works/workActions.ts`). Its hover actions are Track /
Done, New chat and a menu with Rename task, Move to folder and Delete
worktree. The row is highlighted while folded if the open session or draft is
inside it, and also unfolded while the open draft there has no row yet (a
worktree just made), so the selection always shows. A worktree work starts folded, unlike a group: its open state is
`workExpansion` in `useSessionProjectViewState` (stored as
`oc.sessions.workExpand`: what Expand all / Collapse all last set, plus the
works toggled since), which the collection folds into the row model's
collapsed groups. A root session row is in work when it or any nested non-subagent
session is, and Done marks all of those done.

Work that is done or removed leaves the working set on every path (Done on a
session row or a worktree row, Mark done in the composer, removing a
worktree): `leaveFinishedSessions` in `lib/sessionTabs.ts` closes those
sessions' header tabs and, when the open session is one of them, moves to the
neighbouring tab still at work, or with none to a new draft in the project;
without tabs only that move applies.

Done on a worktree work, and Archive worktree in its menu, mark every session
in it done, leave it (its tabs close and the app moves off it, a draft in its
folder included, so the work on screen does not keep the worktree), then
archive the worktree with its sessions (`archiveWorktreeWork` in
`lib/worktrees/worktreeArchive.ts`; the server side is in `web/server/lib/git`).
An archive keeps every change and the branch, so nothing has to be confirmed;
a session still running there, or one whose state cannot be read, keeps the
worktree and says so. Delete in the menu stays the way to remove a worktree
for good. The work has left In work in every case. Archives exist where the
runtime's git offers them (web, desktop); VS Code keeps its own list without
them.

Task titles are named by the agent through the openchamber tool's `work.name`
(`web/server/lib/openchamber-sessions/work-naming.js`). A worktree's title is
its branch description, with the agent's copy beside it
(`branch.<name>.openchamberAgentTitle`, see `setWorktreeTaskTitle` in
`web/server/lib/git`). A task in the main checkout renames its root session
and records `metadata.openchamber.workTitle { title, by }`. A rename by the
user (the row's Rename task, a session rename, AI rename) always wins: the
agent's next call changes nothing and answers with the user's name.

## One view

The desktop and web sidebar has one view. `sidebarGrouping`
(`useSessionDisplayStore`, per surface) groups works under their projects or
in one list by time; until the user picks one it follows the Tree / List pair
it replaced (`resolveSidebarGrouping`: List sorted by time keeps the list by
time, everything else groups by project). The phone still reads
`sidebarViewMode` and `listSessionGrouping`, and VS Code always groups by
project. The display menu opens with Select sessions, then Grouping, then
(grouped by project) the project sort, worktree sort and project display,
then the section toggles (Chats, Pinned, In work), "Also show in work under
projects" (`keepWorkInPlace`, `sidebarKeepWorkInPlace`, off by default, shown
while In work is), Detailed rows, then Collapse all / Expand all.

- Chats rows are one line with the tree's slot (`'tree-chat'`). Chats open
  with a reveal of 3 and 7 more per Show more; pinned chats are always shown
  and never spend that limit. Pinned sessions under a project do spend its
  limit, so a project or worktree list never opens with more than 7.
  Collapsing a zone header resets its Show more state.
- Zone collapse state lives in `useSessionProjectViewState` next to project
  collapse and is saved in local storage (`oc.sessions.activityCollapse`). The
  display menu's Collapse all / Expand all set every project and the zones
  (`SIDEBAR_ACTIVITY_KEYS`: Chats, Pinned, In work and the list by time)
  together. Session folders keep their own collapse state. Zone and project
  headers are sticky.
- Rows of zones that mix projects (Pinned, In work, the list by time) are
  `'mixed-compact'`: one line with no project icon (the room goes to the
  title; the whole-row tooltip names the project, branch and model), the PR
  or issue as a coloured mark;
  they open to what nests under them like the project tree. Detailed rows
  (`detailedZoneRows`, `sidebarDetailedZoneRows`, off by default) gives them
  the two-line `'timeline-mixed'` row, which never expands and carries the
  requests under it as badges. A worktree work in a zone is its work row
  naming its project (`mixed`), with its sessions under it, out of the drag
  sort (`sortable: false`). Row keys carry the placement, so a worktree kept in
  its project too never collides; collapse and Show more state stay keyed by
  the group and are shared.
- Grouped by time, all-projects mode replaces the project headers with one
  `timeline` zone: project-root drafts first, then every work Pinned and In
  work do not list, by the lifecycle order of its latest session, then the
  worktrees nobody has started a session in. It is virtualized, so it has no
  reveal limit, and ends with the statuses a project header would show for
  projects it lists nothing for (one loading line, one line per failed
  directory). Single-project mode keeps its project header and groups by
  project.
- An isolated space without chats has no session row, so its group header
  sits under its project until its first chat; it hides nothing and is not
  dragged. Search leaves it out.

## In work

Works in work render in their own `work` activity zone under Chats (and
Pinned) and above the projects while `sessionWorkEnabled` is on and the
display menu's In work toggle (`showWorkSection`, `sidebarShowWorkSection`,
per surface, on by default) shows it. A session work is in work when its root
or a nested non-subagent session is (`metadata.openchamber.work.state ===
'open'`, see `packages/web/server/lib/session-work/DOCUMENTATION.md`); a
worktree work when any root session in it is, or, while it has no session
yet, when a draft is begun in it (open in the composer or kept as a row): the
user just made it for a task, so it opens the block. A worktree this client
is removing keeps its place in the block until git is done
(`useRemovingWorktreePaths`), though its sessions are archived first. A subagent's own state
never counts. `list/SessionProjectCollection.tsx` orders the works by the first of
their sessions in the shared lifecycle order (`works/sidebarWorks.ts`) and
passes `workEntries` to the row model. A work In work lists leaves its project
or folder (`movedSessionIds`, `movedGroupKeys`) unless "Also show in work
under projects" is on; search lists every zone session once, in its zone,
either way. VS Code always keeps them in place. Chats are never in work and
offer no Track action. An empty zone is not rendered.

Search in a zone keeps a root whose subsession matches, since the one-line
rows open to it; with Detailed rows the root stays listed though its row
cannot open (`matchZoneSessionsForSidebarQuery`). The zone counts only
sessions that match themselves (`countSessionTreeQueryMatches`), carried on
the item as `searchMatchCount`; a group subtracts the trees that moved out of
it with the counter its search data used, so one exact id is one match, and a
group or project whose only matches moved renders nothing. Track / Done
captures the runtime key at the click (`setSessionWorkState`), so a server
switch mid-request writes nothing to the new server.

Everything a row or header reveals on hover (actions, chevrons, the label
mask) also shows for keyboard focus, through `group-has-[:focus-visible]`,
never `group-focus-within`: a mouse click focuses the row or button, and
`:focus-within` kept the revealed chrome on screen after the pointer left until
focus moved elsewhere. A session row's hover actions are Track / Done (eye in
the muted action color / check in `status.success`, one icon size up because
the glyph draws small), quick archive/delete, the menu. Pin/unpin lives in the
menu only. Touch layouts (`alwaysShowActions`) keep Track / Done in the menu.
At rest a row in work shows a grey check only while Jev's done hint is
current (`isDoneSuggested`); the composer shows the same hint as a top row
(`components/chat/SessionDoneHintRow.tsx`). The mobile sheet
(`apps/MobileSessionsSheet.tsx`) keeps its own In work section, whose sessions
stay in their project buckets, with Track / Done as a swipe action on
top-level rows. Mobile swipe actions run left to right by how often they are
used on a phone: archive, pin (top-level rows), Track / Done (top-level rows,
feature on), delete, rename; AI rename sits inside the rename editor. Mobile
rows also show the goal glyph and the permission/question badges
(`apps/MobileSessionStateBadges.tsx`) from the cross-directory request index
(`sync/global-blocking-requests.ts`). Row memoization compares `metadata` by
reference and `time.idle`, so metadata-only changes (work, goal, recap)
re-render the row.

## Drafts

A new session's draft not sent yet is a row where its session would go,
from its first save (a draft with nothing typed is not stored and has no
row): at the top of the project root's list (and of the list by time), or
at the end of its worktree's list. The server keeps the drafts for every
client (`web/server/lib/session-drafts/DOCUMENTATION.md`); `useSessionDraftsStore`
reads them and reads again on `session-drafts-changed`. Every opened project
draft has its own `workDraftId`, and the composer keys its text by
`draft:<id>` (`workDraftComposerKey`), so two drafts in one folder never share
text; `useSessionDraftPublishing` mirrors the open draft, attachments
included, a moment after typing stops and at once when the composer leaves
it. The draft in the composer keeps its row, selected, until it is sent (the
session's row takes its place) or thrown away. A draft the user empties is discarded
(a reopened draft showing empty before its text is restored is not), sending
discards it for good (`sendMessage`, `discard` with `final`, which also drops
a save still on its way), and the row's cross discards it without asking; on the open draft it also
clears the composer, which starts a fresh draft in the same place. A
project draft switched to a new Chat takes its text along, and its row goes.
Opening a row (`works/openSessionDraft.ts`) opens the draft at once with its
text and server files through `pendingComposerRestore`; attachments stored on
the server follow once downloaded, if the user is still on the draft. A draft
this device failed to store (offline, or a 413 for attachments over the
server's limit, which the user is told once) keeps this device's newer copy
when reopened here. The first draft opened in a folder takes over the text
that folder kept under the old per-folder key
(`readChatDraftClaimingFolderDraft`). Search leaves drafts out. VS Code has no
shared drafts and the phone does not list them yet: both keep the per-folder
key, where a new draft finds the text left in that folder.

## Folders with worktrees

A folder of the project root can hold whole worktrees: the member id is
`worktree:<directory>` (`worktreeFolderMemberId`) beside the session ids, so
the folder store and the server file it with the same assign and unassign
changes as a session. A filed worktree renders inside its folder, one level
deeper, and nowhere else under the project; filed into a folder that is gone,
it stays under the project. The work row's menu (the "⋯" button and a right-click on the row show the
same items) files it (Move to folder);
dragging a worktree onto a folder is not offered.

## Locations and detailed rows

- `worktreeIndex.ts` is the shared worktree index (normalized keys,
  project-root exclusion, first-wins dedupe) for the zones, project grouping,
  and the session switcher. A session in `<worktree>/sub` resolves to its
  worktree through `findPrefixWorktreeEntry` (longest path wins); the group key
  stays the worktree root. `recent/sessionLocation.ts` is the single owner of a
  session's project, directory, worktree and branch label: it resolves the
  project through the session ownership index first (managed worktrees live
  outside the project path), falls back to a path-prefix match, and finds the
  containing worktree by longest prefix. Branch labels are live-first.
- A detailed zone row has two lines of fixed height (20px and 16px); the second
  is rendered even when empty, so nothing shifts when a branch or badge
  arrives. The first holds the title and the action indicator, pin, done hint,
  status icon and time; hover actions cover that cluster. The second opens
  with the project's icon and holds the branch (or the space's name) and the
  state cluster: goal glyph, PR (or the zombie warning), permission/question
  badges, provider logo.

## Pinned

The display menu's Show pinned section toggle (`showPinnedSection`,
`sidebarShowPinnedSection`, per surface, off by default) adds a `pinned`
activity zone between Chats and In work. It lists pinned top-level,
unarchived project sessions in the shared lifecycle order; pinned chats stay
pinned at the top of Chats. A work whose root session is pinned is listed in
Pinned only. Its sessions also stay in their projects. Search
lists each of them once, in the zone (`zoneSessionIds` carries both zones' ids),
and the rows follow the same render context. Its rows show no pin marker,
because the header already says they are pinned; In work rows show it only
while the zone is hidden, since otherwise no pinned session reaches In work.

A pin lives in the session's metadata (`openchamber.pinned: { at }`,
`lib/sessionPins.ts`), written through the metadata route like the work state,
so every client of the server sees it; VS Code keeps it in its own metadata
store. `useSessionPinnedStore` derives the pinned keys (runtime, directory,
session) from the global session list and overlays a click until the server
answers (`sync/session-pins.ts`, which reverts it and the caller toasts on
failure). Older versions kept pins in this device's storage
(`oc.sessions.pinned.v2`); those count as pinned until the first complete
session list of their server, when they move into metadata, a pin whose
session is gone is dropped, and one that fails to write stays for the next
load. The phone sheet
mirrors both toggles: its display menu offers Show pinned section and, in
its Tree, Detailed rows, and its Pinned and In work sections render tree rows
there unless detailed rows are on. VS Code
shows no section toggles, so it has no Pinned zone and its In work rows stay on
one line.

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

Sidebar queries beginning with `ses_` match only the full session ID,
case-insensitively and ignoring surrounding whitespace. Partial IDs and typos
return no matches, without falling back to titles, directories, group labels,
or folder names. Ancestors remain as tree context for a matching child. A matched
node keeps its subtree for rendering and subtree actions. Only exact ID matches
count toward the result total.

Search changes model inputs, not renderer ownership. It forces project, group,
folder, and activity rows open without changing the normal-mode collapse or
show-more state. Closing search therefore restores the exact prior Chats,
In work, project, group, and folder projection.
ID search does not include archived sessions. `ArchiveView` applies the same
exact-ID rule to its own archived list. Other queries keep each view's existing
matching and ordering. Search does not fetch sessions or broaden list membership.

## Loading rules

- Publish bootstrap demand only for the current directory and the selected session's directory. Known project roots and worktrees are topology, not demand: rows and sessions come from the global session list, activity from the global status index and the host status seed. Every directory-scoped read makes OpenCode create and initialize a location, so demanding the whole topology created one per project at startup.
- Directory demand and refresh requests preserve path case after separator and drive-letter normalization. Case-insensitive sidebar membership keys stay inside the collection projection; sending those keys as paths creates duplicate directory stores and can address a different directory on case-sensitive filesystems.
- A never-bootstrapped directory is ready only after a complete global snapshot. Before that, the group shows global loading or failure, and Retry reloads the global list. Previously loaded groups stay ready during background polling. Directory failures and denied folder access still use forced bootstrap or native access recovery for the affected directory.
- The sync scheduler deduplicates, promotes, retries, and limits work. Sidebar components must not reproduce that lifecycle with mount effects.
- Hide speculative work when the sidebar/chat surface is hidden: message prefetch, Git/PR enrichment and subscriptions, search listeners, sticky-header observation, and archived-folder derivation stop. Paused work keeps its last result (branches, repository status) instead of clearing it, so reopening neither re-reads every project's Git status nor redraws the list without it. Once shown, the session row tree stays mounted while the desktop sidebar is closed: rebuilding and re-measuring it was the bulk of the reopen frame (`SessionProjectCollection`). The closed sidebar skips its rendering (`content-visibility: hidden` after the close animation, `inert`), so row-owned status, permission and unseen subscriptions still re-render rows on events but cause no style or layout work. The outer sidebar remains mounted, preserving UI state and authoritative directory refresh for an immediate reopen; deferred derived work reruns from current state when visibility returns.
- A mouse resting within 18 px of the window's start edge below the titlebar while the desktop sidebar is closed shows it over the chat (`useSidebarPeek` in `components/layout`). The edge is measured from document pointer moves; no element sits there, so nothing under it loses clicks. The column stays at zero width, so the chat does not move; the same mounted tree slides out with its rendering resumed and `inert` lifted, and counts as visible for the work above. It slides back once the pointer has been away for 300 ms, on a click outside it, or on Escape. A menu or dialog opened from it (anything with a popup role portalled outside `#root`) or an inline rename holding focus keeps it out until done.
- Change-request enrichment uses worktree topology only to discover at most 50 unique demanded directories in stable project order. Repository binding selects the primary provider, instance, account, revision, and primary remote; connected accounts outside that binding add no requests, and missing or `needs-attention` bindings create no provider request.
- Binding discovery shares the [repository binding owner](../../../lib/source-control/DOCUMENTATION.md) with editors and pickers. Mounted directory subscriptions refresh affected status demand after binding mutations; the existing status timer does not poll repository bindings. Auth-entry changes update only directories using that entry and do not release or reload bindings.
- Linked change requests and issues take one path whatever their provider. `getLinkedSidebarChanges` and `getLinkedSidebarIssues` (`lib/linkedIssues.ts`) read each link's address through `useRepositoryUrlMatcher()` into a `RepositoryThreadRef`; rows, worktree headers and the list's followed items (`repositoryRefs` in `list/SessionProjectCollection.tsx`) turn it into a tracked item with `repositoryThread(kind, ref)` and read one `repositoryStates` array (`buildSessionIssueItems`). A change whose state has not arrived is listed uncoloured by its provider's reference (`#12`, `!12`), as is any change no provider reads. The row's reference and status wording come from the provider's descriptor (`formatChangeRequestReference`, `getPrStatusLabel(summary, term, t)`); no surface here names a provider. Tracker items (`source: 'tracker'`, a Linear issue) are followed as `workItem(provider, identifier)` and read through `useTrackedWorkItemStates`: the tracker's own state name, in the issue colour of its category (`getTrackerItemStateLook`), with the tracker's mark from `lib/trackers/presentation.ts`.
- A worktree's PR badge reads the read contexts the sidebar registered for its directory. When the shown directories change (a sibling worktree deleted or created, a branch renamed), a directory still shown keeps its registration until the fresh read replaces it; only directories that left the shown set, or were registered under another runtime, are released (`list/registeredContextDirectories.ts`), and unmount releases all. Releasing every directory on each change blanked every other badge and branch tint until the binding reads came back (issue 5160).
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
- The grouped view is drawn as a file tree, with the shared parts of the Files
  and changes trees (`components/views/files/FileTreeRowParts.tsx`,
  `fileTreeRow.ts`) through `sessions/sessionTreeGeometry.ts`: 6px from the
  edge (the Files trees use 8px; 6px puts root session titles where the
  project label starts) plus 12px per level, then a 14px slot and a 6px gap
  before the text. An open worktree, space, archive, folder, session or run
  frames its children with a guide line under the centre of its slot, which
  turns toward the last child in a rounded corner (`sessions/SessionTreeGuides.tsx`).
  The row model works out each row's lines (`treeGuides`, from
  `computeSessionTreeGuides` over the rows' tree levels); a line runs through
  a child's own subtree only while a later sibling follows. Headers of
  projects and zones, Show more and status lines, and detailed zone rows are outside
  the tree and break every line. The lines draw over the row, so they show on
  its hover and selection fills, inside a box that contains the row's margins
  so neighbouring rows' lines meet.
  Worktree and folder labels are medium weight a step below full strength,
  between the project header and the muted session titles at rest. Tree session rows are a little
  tighter than zone rows.
  An empty worktree group or folder (no sessions, no folders, nothing loading)
  shows no chevron, does not toggle, lists nothing under its header, and is
  always open: a collapse saved while it had sessions is dropped, so its first
  new session shows at once. A group counts as empty only once its sessions
  have loaded; before that it only looks empty, and the saved collapse stays. The phone treats empty worktrees the same way. Collapsing a project or a worktree group, from its
  header or Collapse all, forgets its Show more state. The project
  header stays the sticky zone band above its tree. Root sessions and the
  root's folders sit at level 0; worktree, space and archive headers sit at
  level 0 with their folders and sessions at level 1; a folder's sessions sit
  one level under the folder, and subsessions one level under their parent.
  The slot holds the rotating chevron of a folder or a run. A space or
  archive header holds its icon there (the space's box, the archive) and shows
  its chevron in its place while the header is hovered or focused; touch
  layouts keep the icon and toggle on a tap. A worktree's work row holds its
  sessions' activity there instead, like a session row (see Works). Its
  label therefore starts where root session titles start, and its sessions
  sit one level in. On a session row it holds the live state (running kind, unread, or the
  move/rename spinner), so the state reads down the left edge with the titles,
  and stays empty otherwise so titles line up. A session with subsessions shows
  its state there at rest and its chevron while the row is hovered or focused;
  touch layouts (`alwaysShowActions`) have no hover, so a parent keeps its
  chevron and its state goes to the right. Session rows use the one-line form
  of `SessionTimelineRowBody`: pin, done hint and, while a turn runs or
  until it is read, the turn's duration on the right. No row shows a date:
  every list is ordered by recency and the whole-row tooltip has the time.
  One-line rows (sessions, runs, worktree works, drafts) are 34px: the 20px
  line, 6px above and below, a 1px margin each side (`SESSION_ESTIMATE`). The
  one-line Chats, Pinned, In work and list-by-time rows (`'tree-chat'`,
  `'mixed-compact'`, session and run rows) take the same geometry at level 0
  with the state in the slot, so it reads down one edge from the zones into
  the projects. Detailed zone rows are flat and keep the live state on the
  right. Session and run titles are muted at rest. Session, run, worktree work
  and draft rows take the same faint hover fill; space, archive and folder
  headers take none, so a pointer moving down the
  sidebar tells sessions from their containers. Show more, empty and
  status rows carry the level whose text they line up with.
- A row's `depth` is its tree level as above, not its parentage. Do not read
  `depth > 0` as "this is a subagent".
- The existing `ScrollableOverlay` is the sole scroll owner. The shared row
  renderer measures variable-height rows, uses stable occurrence keys, keeps a
  bounded pre-initialization window, and pins editing, focused, and open-menu
  occurrences in its range extractor. The scroller publishes its DOM element
  through callback-backed state so virtualization activates after every mount
  without waiting for an unrelated render. Archived groups must not add a
  nested virtualizer.
- An unmeasured row is estimated at the measured height of a row with the same
  kind and render context (`sessionSidebarRowSizeKey`, kept without the
  trailing section gap) plus its own gap as measured, falling back to the
  model estimate. The virtualizer keys each row with its gap
  (`sessionSidebarRowVirtualKey`): a header gains or loses its gap as it
  closes or opens, and under its plain key the old measured height would hold
  until the resize observer reported, so the rows below hopped a frame later. The virtualizer corrects the
  scroll position whenever a row above the viewport measures differently from
  its estimate, and those writes land in the middle of a scroll gesture as small
  jumps; rows of one key share a height at any interface font size, so after
  the first rows mount the estimates are exact.
- Sticky project/activity identity comes from model header descriptors and the
  first visible virtual index, which keeps the live current and adjacent header
  rows mounted. `CrossfadeZoneHeaders` uses their cached virtual layout offsets
  for the visual handoff. DOM sentinels and intersection observers are not used.
  The handoff moves the live header, focus included. Chromium scrolls a moved
  focused element into view, so after a click on a header every handoff threw
  the list back to that header and the sidebar would not scroll until focus
  left it; `moveHost` keeps the scroll position across a move that carries
  focus.
- Opening and closing a zone, project, worktree, folder or multi-run animates
  like a reasoning block in the chat (200ms ease-out,
  `sessionSidebarDisclosure.ts`). The rows are flat virtual rows, so no
  container changes height: `SessionSidebarRows` compares each new row list
  with the one last drawn, and when exactly one header changed state with one
  block of rows right under it, those rows are clipped above a moving boundary
  and every row after them slides with it. A closed block is drawn as inert
  ghost rows at its old place until the motion ends; rows sliding in from past
  the virtual range stay mounted meanwhile. Collapse all, search, Show more and
  live list changes do not animate, nor does anything under reduced motion.
  The phone's sessions sheet does the same with a height animation per body
  (`apps/MobileDisclosure.tsx`).
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
  by row occurrence. Duplicate In work, project, and folder rows never open a
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
  collapsed folder headers. It includes descendant activity without mounting
  those sessions; a subtask is never unread on its own. Expanded and archived
  folders do not derive hidden activity.
- Single-project flat mode reveals 20 root sessions initially and 20 per Show
  more; Show fewer resets to 20. Chats keeps its reveal of 3. Elsewhere a
  Tree worktree group reveals 7 sessions, 7 more per Show more, and 10 in
  VS Code. Reveal
  controls change the logical list, not the viewport's bounded mounted window.
- Archiving or deleting a session takes its whole active subtree with it on every surface, because the server does not cascade `time.archived`. In work and managed Chats build their rows with `buildActiveSessionNode` from `list/sessionCollection.ts`, so the descendants a row collects match the project tree at any depth; the mobile sessions sheet resolves the same lineage with `getDescendantIds` over its full active list rather than the rendered bucket. `sessions/sessionSubtreeActions.ts` owns the single-versus-batch store calls and the outcome toasts for all of them, and `collectSessionSubtreeIds` extends the surface's own descendant list at action time with the global session lineage (`stores/sessionLineage.ts`), so an active subagent below an archived intermediate is still archived (archive skips the archived intermediate; delete includes it). A projection that flattens a tree to one level silently leaves grandchildren active. The project menu's "Archive all" archives the subagents of each selected session in the same batch; its dialog and success toast count top-level sessions, the rows the user sees.
- Subsessions belong to the agent run that spawned them, not to the user. They appear only nested under an active parent: the archive (sidebar bucket, auto folders and the Archive page) lists top-level sessions only, an archived subsession or one under an archived parent is hidden rather than promoted to a row of its own, and there is no restore for a subsession; it comes back when its parent is restored. A subsession whose parent is not loaded yet stays visible as a root.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild, from the global cache or from the live child-store list: the collection subscribes only to the live sessions the global cache does not hold yet (`useLiveSessionsExcluding`), so a covered session's live bumps neither re-render the sidebar nor rebuild the structure. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- The published worktree topology leaves out every checkout that holds a configured project in a sub-folder, as it leaves out checkouts that are configured projects (`partitionWorktreesByRegisteredProject` in `lib/worktrees/worktreeManager.ts`). For a project that is a sub-folder of a repository, the repository's checkout would otherwise show as a removable worktree whose delete dialog names the whole repository (issue #4666). The raw per-project lists keep that entry, because it ties a sub-folder project to its repository when one project's refresh replaces the buckets of the repository. The root-session `Move to worktree` menu does not offer that checkout either, unless the session is already there. Sessions in it outside every project folder belong to no project, like sessions in any folder that is not added: adding the repository root as a project shows them (maintainer decision 2026-10-11).
- A worktree Git still registers but whose directory is gone (`prunable` in `git worktree list`) stays in the topology with `worktreeStatus: 'missing'` and a warning icon on its group header. Its sessions remain accessible for manual movement or archiving through worktree deletion. Opening a session does not move it. The ordinary worktree delete action accepts a missing directory. Shift+click on the worktree delete button (it turns red while Shift is held) archives the group's sessions and deletes the worktree and its local branch without the dialog, never the remote branch, but only when a fresh status check finds no uncommitted changes and every commit already on the branch's upstream or, for a never-pushed branch, on the base branch the server compared it with (`aheadBase`, e.g. `origin/main`) or on another remote branch (`canDeleteWorktreeWithoutConfirm`); any other result, including a failed check or a never-pushed branch the server could not compare, opens the ordinary dialog. Topology discovery remains event-driven, including `session-created` and server `worktree-changed` control events, with no idle polling. A `session-created` event refreshes only the project whose root is the session's directory or whose known worktree holds it (`resolveProjectForCreatedSession`); any other directory, such as a new worktree nobody has listed yet, gets the full discovery, because a registered folder above it does not prove which repository it belongs to. After an instance switch the project list comes from the local cache, so discovery can run before the instance answers: projects whose discovery failed are discovered again once when the connection comes up. The worktree list and project-root caches are keyed by path, so a runtime switch clears them. The server sends `worktree-changed` after its own worktree create/remove and when a status or listing request notices that a repository's worktree set changed (see `packages/web/server/lib/git/DOCUMENTATION.md`); the event names every directory of that repository the server has seen, and the sidebar refreshes each registered project among them once, bypassing the 30-second list cache. A worktree this client created and is still bootstrapping keeps its `pending`/`invalid` status through that refresh. Hosted mobile and the desktop mini chat handle the same control event through `lib/worktrees/worktreeTopologyRefresh.ts`; VS Code intentionally excludes worktree topology.
- A worktree this client is removing shows it on its row, from the user's confirmation until git answers: a spinner replaces the branch icon, the row dims and its delete action hides. The desktop group header, the mobile sheet's worktree bucket and the mobile project-edit worktree list all read `lib/worktrees/worktreeRemovalState.ts`. The row leaves with the topology once git confirms. It does not fade out: the server's `worktree-changed` refresh drops it as soon as the removal finishes, which would cut any exit animation short. A failed removal clears the state and the row returns to normal beside the error toast. Removing the files of a large worktree takes tens of seconds, so the spinner stays for as long as the deletion runs, never shorter. Another window removing the same worktree shows nothing until the topology refresh drops the row.
- Opening the root-session `Move to worktree` submenu force-refreshes the owning project's worktree topology so externally created worktrees appear without a full reload. While that refresh runs, the menu keeps the last known primary/linked topology visible; if the refresh fails, the stale topology remains and the load failure state stays explicit. Failure cleanup never removes or manages an existing destination worktree. The owning project resolves from the row's project id, then from the session's directory, then from the session's worktree metadata `projectDirectory` — the last step keeps sibling destinations listed for a restored session whose own worktree directory was deleted.
- Unarchiving a session whose directory the server confirms missing (its worktree was removed while it sat in the archive, by this app, by hand or by git) moves it, with its subsessions in that directory, to its project root (`lib/worktrees/relocateRestoredSession.ts`, maintainer decision 2026-10-02). OpenCode cannot run a prompt in a missing directory (it answers 500), while `session.move` works from one and appends a `location-switched` record that tells the model its working directory changed. The project root comes from the same ownership index as grouping (directory first, then OpenCode project metadata), so it survives a restart. A toast names the cause, the missing folder, not an action of this app. An unknown availability answer, an unresolved project or a missing project root leaves the session where it is; a rejected move shows an error toast.
- Cleanup after a PR merge is opt-in (`mergedWorktreeCleanupEnabled`, Settings → Sessions, off by default; maintainer decision 2026-10-02). `hooks/useMergedWorktreeCleanup.ts` reads the branch PR status the sidebar already keeps fresh for each discovered linked worktree, asking GitHub nothing itself, and `lib/worktrees/mergedWorktreeCleanup.ts` decides: wait while any session there is not confirmed idle, is the open session, or the worktree is the directory on screen; otherwise archive the worktree with its sessions. An archive keeps uncommitted work and commits outside the merged PR, so the earlier rule (remove only a checkout with nothing to lose, keep the rest) is gone with the checks it needed. Each worktree and PR pair is tried once (remembered in local storage), so a failed archive is not retried on every pass. A worktree being archived or removed right now is skipped, so Done and a pass never archive it twice; a worktree the user restored from the archive is marked handled for its PR on the next pass (`takeRestoredWorktree`), since restoring a merged worktree is taking it back. It runs on desktop and web only; VS Code has no worktrees and a phone would race the desktop it drives. Only worktrees of projects whose worktrees the sidebar has discovered are covered.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event re-lists the worktrees of the session's project, or of every project when the session's directory is not a project root or a known worktree, so a newly created external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- A successful restore on the current runtime promotes only the session's ephemeral list-order rank. It does not change timestamps or live status, and it resets on a runtime switch.
- `useProjectRepoStatus` reads Git status once per project path while the sidebar is visible. A change to the project list that adds no path (collapse, rename, color, last opened) reads nothing; an added project reads only its own status; a failed read is retried on the next list change. New paths are first read together through `GitAPI.prefetchProjectStatuses`, one batched request that warms the status cache, so the per-project reads after it are cache hits; VS Code has no batched read and reads one by one. Hiding the sidebar or switching runtime starts over.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, branch, or worktree-ordering ranks changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave. The grouping builder therefore keeps its identity across inputs the section cache compares per project: it reads git branches and lifecycle ranks at call time, and keeps the session ownership map while every session's scope directory is unchanged (the ownership index itself is rebuilt on any session-list change). Without a search query every group shares one empty search-data map, so a rebuilt section does not invalidate the others' group headers.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- List loading and workspace initialization have separate states. The spinner follows only the list queue; config, MCP, LSP, and live-state recovery cannot keep a successful empty list spinning. A core initialization failure has a separate localized notice and reuses the retry/native-access actions without clearing loaded sessions.
- Directory permission failures remain visible even when stale sessions are retained. Flat groups inspect every represented root/worktree directory; local Desktop may open the native picker for the exact failed directory, while other runtimes keep the ordinary Retry action.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
- Pending-permission/question row badges ride in the meta cluster at the row's end with the time and status, and fade with it on hover or while the row menu is open, except on non-VS Code always-visible-actions rows, which reserve permanent padding and keep the cluster shown. VS Code hover-reveals its actions over the row's right edge even under `alwaysShowActions`, so its cluster keeps fading.
- Hover-revealed actions on session rows, worktree headers and project headers cross-fade over the row's end (the right, or the left in a right-to-left layout); they do not re-lay the row out. What they cover (date, branch, badges, indicators) fades with opacity, and the title or label's tail fades away under them through the `oc-actions-mask` utility (`index.css`): the row's text line is an `@container`, `--oc-actions-reserve` says how far the actions reach in from its end edge, `--oc-actions-inset` how far the masked text starts from its start edge. A title whose own direction differs from the interface (`dir="auto"`) starts under the actions, so it takes `padding-inline-start` of the reserve instead of the fade. Reserves, insets and the mask's own gradient stops are rem so they track the interface font size, and the mask multiplies reserves and insets by `--padding-scale` because the buttons and offsets they describe are spacing tokens that grow with the density setting; a pixel reserve would stop short of the buttons at larger sizes and let the title show through. Change a reserve whenever an action's size, count or offset changes. Only permanently shown actions (`alwaysShowActions`) take layout room.
- Tooltips that list PRs or issues (session rows, timeline PR badges, worktree headers) render them as links through `sessions/SidebarRefLinks.tsx`. The PR badge and header tooltips close 750 ms after the pointer leaves, so the pointer can travel in; the whole-row tooltip closes at once and relies on the popup staying open while the pointer heads into it. The row and header action buttons sit in their own `TooltipProvider`: the pointer crosses them on the way, and a same-group tooltip would replace the open one at once. Every row but VS Code's has the whole-row tooltip, opening to the right (title, time, project, branch, links, recap); every other tooltip on a row, a header's folder name included, opens above its element (`sessions/RowMarkTooltip.tsx` for status marks), so it never covers the neighbouring marks and actions. A session menu item that opens a submenu explains itself only while disabled: the hint would cover the open submenu.


## Project action indicators

`SidebarTerminalActivity` shares terminal discovery with the project action views and the
terminal panel while the sidebar is visible. One server listing covers all directories, including
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
it on the project-root header and on sessions in linked worktrees. In work shows it on every
session with an active action in its own directory. Archived buckets do not show action
indicators. Indicators stay inside the existing row/header action-padding boundary, so
hover, keyboard focus, and always-visible action buttons move them left without hiding them.

## Decisions

### Why every project list follows the sidebar's sort and has no sort of its own

The maintainer decided (#4829) that a project sits in the same place in every
list, so Settings, pickers and dialogs take the sidebar's project sort and
offer no control of their own. The Settings project selector sorted A to Z on
purpose before; that is replaced. The hook recomputes "Recent" from the global
session list instead of reading the order the sidebar last drew, because the
sidebar is not mounted on every surface (the phone drawer while closed,
another VS Code webview).

### Why one view replaced Tree and List

Tree grouped sessions by worktree and List grouped them by project or time,
and neither said what the user was working on: a worktree was a folder of
sessions, and the reviews, forks and dispatched sessions of one task were
separate rows. The maintainer chose one view whose row is the work (a worktree
or a session in the project root with what grew out of it), named for its task,
with the grouping as its only choice (2026-10). Rows are one line with no
project icon and no date: the order already says how recent a work is, the
tooltip names its project and time, and the room goes to the title.

### Why the phone's List search skips subsessions and does not reveal them

The phone's List rows are flat on purpose, so a root kept for its subsession's match
showed a row whose match the user could neither see nor open, under a count
that included it. Revealing the subsession would make List rows expand, which
is what Tree is for. The maintainer chose that List search matches only the
sessions List shows (#4843); Tree keeps looking through the whole tree.

### Why tree guides end in a corner at the last child

The Files trees draw one straight guide per ancestor level down every row.
The session tree frames a group instead: the line starts under the open row
and stops at its last child with a corner, so where a worktree's or a
session's children end reads at a glance, and a long tree is not striped by
lines that run through rows they do not belong to.
