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
is `robot`, one held open by a background command is `terminal`, an agent that
ended its turn to wait on its pull request (`sync/pr-watch.ts`) is
`git-pull-request` (all info color; `useSessionTurnActivity` in
`sync/global-session-status.ts` decides, the session's own run first, then the
subagent, the command, the pull request), and a finished unseen turn is
`checkbox-circle` (success color). Collapsed aggregates show only running or
unread. The local Appearance preference `animatedActivityIndicators`
is off by default. Enabling it swaps every running kind for a stepped spinner,
even when the OS requests reduced motion; the unread icon stays. A permission
or a question waiting on the user is one warning-colored glyph (`shield`,
`question`) with no tinted pad, on rows, aggregates and the phone. While one
waits, the row hides its running mark and elapsed counter: the session is
stopped on the user, and blue beside blue hid the request (maintainer,
2026-10-29). The counter reads the turn's start from the store, so it comes
back at the right time. Colors carry state only: info while it runs, success
once it waits to be read, warning while it waits on the user; the pin and
other non-state marks are muted. A session
row's title carries its state too: semibold at full strength while a finished
turn is unseen or a permission or question waits on the user, full strength
while it runs, a step below otherwise (`oc-title-rest`); the active row keeps the selection colors. The display
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
exact workspace-directory scope and does not use the fallback. In work and
the list by time use this same ownership resolver, on the phone too; rows keep
the session's own directory while taking display ownership (project id,
labels) from the index.

Web and desktop show managed Chats, then Pinned and In work, then the projects
or the list by time (see One view). There is no Recent zone any more (removed
2026-10): In work holds the works in progress, and the list by time answers
"what was I doing" across projects. Chats use
their shared managed root for folders and never expose worktree actions. Project
display can be all projects or one selected project; Chats, Pinned and In work
keep their global scope. Rows that span projects are labelled "project · branch"
through `resolveSidebarSessionLocations` (live root branch included). A
session of an isolated space has the space's name where the branch goes and
`inSpace` set on its location, so the zone rows of the desktop and the phone
mark it with the container icon the space's group carries, never with the
branch icon. The phone lists the same rows (see The phone). VS Code excludes
worktrees and, when a workspace folder is open, managed Chats. Empty VS Code
windows show Chats. Folder windows retain their workspace-scoped grouped list
and inline archived buckets. In empty windows the archived toggle shows a Chats
archive bucket containing top-level sessions only. Restoring a root restores
its archived descendants through the shared action. Web, Electron, hosted mobile
and Capacitor keep their existing Chats and Archive views.

A project lists its worktree works among the works of its root, not in a
block after them: the row model (`mergeWorktreeEntries` in
`sessionSidebarRowModel.ts`) puts each at the place of its most recent
session in the shared lifecycle order (`sessionOrderIndex`), so a worktree
someone just worked in leads the list as a session there would. Its archived
sessions count too (`buildWorktreeArchiveAnchors` in `works/sidebarWorks.ts`,
`worktreeArchiveAnchors` on the row model, and the list by time through
`orderSidebarWorks`): archiving the newest session in a worktree is not work,
so the worktree keeps the place that session gave it instead of falling to
the next one's, and a worktree whose sessions are all archived stays where it
was. A worktree spends one slot of the root's Show more limit, like a run; one
that never had a session closes the list, the newest first (`useSessionGrouping`). An isolated
space is listed the same way: it is a work of its own (see Works). Worktrees and spaces filed
in a folder stay in the folder; the archive bucket follows the list. There is no worktree sort and no worktree dragging, on the phone either:
its project editor lists the worktrees in the topology's order, with Delete.

Every other list of projects shows them in the sidebar's order through
`list/useProjectsInSidebarOrder.ts`: Settings > Projects, the project
selector of the Settings pages, the composer's project picker until a search
is typed, the move-chat, scheduled tasks and install-skill pickers, the
tracker project mapping, usage stats and the issues board. It applies the same
`sortProjectsByOrder` with the stored sort, as every sidebar does, and for `recent` ranks by `rankByLatestActivity` with the sidebar's
ownership rules over the global session list, archived sessions included; a
live session the global list has not picked up yet counts once it does. It
reads sessions and spaces only in `recent` and only while its list is shown
(`enabled`), keeps the last order while a closing popup fades, and does not
hold the order under the pointer the way the sidebar does. Search ranking keeps its own order; the
command palette lists projects only for a query, so it does not use it.

## The phone

Hosted mobile and Capacitor list the same works as the desktop. The phone's
drawer (`apps/MobileSessionsSheet.tsx`, also the iPad's sidebar) mounts
`SessionSidebar` with `phone` set: the collection, its topology and the row
model are the desktop's, and `view.renderList` hands the rows to
`apps/mobileSidebar/MobileSessionList.tsx`, which draws them with the phone's
own row components in the shared virtualizer (`SessionSidebarRows`, the
disclosure animation included). Only how a row is drawn and used differs, as
the maintainer decided on 2026-10-24: a phone has no hover, no right click and
no Shift.

- The drawer keeps its header (close, Add project, the display menu, More,
  New chat), the search field over the list, Reorder projects, the footer and
  the dialogs a row opens (project edit, new worktree, worktree delete). The
  display menu holds Grouping (by project or by time, `sidebarGrouping`), the
  project sort while grouped by project, Show pinned section, Show In work,
  "Also show in work under projects", Detailed rows, "Name worktrees by
  branch" and Reorder projects. Chats
  shows while the per-surface show-chats setting is on, which Settings owns
  (#5354); the header's New chat starts a chat, so Chats has no "+" of its own.
  More holds the pages the list opens, as the desktop header's: Overview,
  Issues and PRs, Scheduled tasks, Archive, Stats. The footer has the
  connected instance on the left (the app), a pending web update and
  Settings, the one filled button, on the right (maintainer, 2026-10-29:
  the phone follows the desktop's sidebar). The iPad's sidebar keeps the search field behind
  a toggle at the header's leading edge, as the desktop does; closing it
  clears the query. The phone's drawer shows the field at once.
- What a pointer does on hover or with a right click, a thumb does with a
  swipe (`MobileSwipeActionsRow`, one row out at a time,
  `mobileSidebar/mobileSidebarState.ts`): a session reveals archive, pin and
  Track or Done (top-level rows), delete (two taps), rename and Copy ID; a
  worktree work Done or Track, Rename, Archive worktree and Delete (its
  dialog); a run Done or Track, Open overview, Rename and Archive run; a draft
  Discard, without asking; a project Remove (two taps) and Edit; a space work
  Done or Track and its actions sheet, which also says what its state mark
  stands for. There is no long press: the swipe already
  holds every action. The rows share their behaviour with the desktop's
  through `useWorktreeWork`, `useRunWork` and `useSessionDraftRow`.
- A tap opens what the row stands for and closes the drawer. The chevron is
  always shown, since there is no hover to reveal it: in the slot of a
  one-line row, over the second line's first icon of a two-line row, in a
  thumb-sized target. The live state sits on the right before the time on
  every row, and the marks before it come in the desktop's order (the goal,
  the PR, the requests waiting on the user, the pin, the done hint). No row
  shows a date, as on the
  desktop: the list is ordered by recency; a turn's duration shows while it
  runs and until it is read.
- Detailed rows are on by default on the phone (store v12; a phone that was on
  the old List keeps two lines). Rows start near the edge, as the desktop's
  do: a two-line row's text 12px in, a one-line row's slot there and its text
  20px further (`mobileSidebar/mobileSidebarGeometry.ts`); the tree guides
  follow. The old 32px inset under the project tile went with the tree it
  served (maintainer, 2026-10-24). A two-line row takes the desktop's 6px
  above and below; a one-line row keeps the phone's 36px floor for a thumb.
- The drawer has one gutter, 12px on both sides, the New chat button's: the
  header's buttons, the search field, the section headers, the rows and the
  footer all end there. Captions (the zones and Projects) are the desktop's
  bare muted word with its chevron after it, always shown; a project header
  puts its icon in the column of the rows' chevrons and states and its label
  at the rows' size and medium weight (maintainer, 2026-10-29). Headers are
  40px tall for a thumb. Rows are rounded tiles, as on the desktop, not
  bands across the screen. The selected row takes the
  desktop's selection fill and title colour, painted over the row's opaque
  background (`MOBILE_ACTIVE_ROW_CLASS`): the selection token is translucent,
  and as a background it let the swipe actions behind the row show through.
  The actions are also hidden (`visibility`) whenever the row covers them:
  while a header opens or closes, WebKit stops painting the sliding and fading
  rows over their actions, and every row below the header showed its buttons
  through its text.
- The phone shows folders and folds them, but does not create, rename, delete
  or file them: folders are edited on the desktop or the web.
- Search filters the list in place, as on the desktop.
- Each time the drawer opens, the row of what is on screen (the run, the
  session or its folded work, else the active project) scrolls into view.
  The iPad's sidebar counts as open while it is shown; it stays mounted while
  hidden, as the phone's drawer does.
- Because the drawer's list is always mounted, it owns worktree discovery on
  the phone and the iPad (its `SessionSidebar` lists every project's
  worktrees and refreshes them on `worktree-changed` and `session-created`);
  `MobileApp` no longer runs a discovery of its own.
- Opening a new worktree from a project header leaves the active project as it
  is: the dialog takes the project as a prop, and a changed active project
  would make the list open that project's last session behind the dialog.
- The phone reads no session ahead (`useSessionPrefetch`): every speculative
  history read costs mobile data, and its list never did.


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
without remounting controls. Only project headers take part in the sort, so
nothing else shifts under the pointer and a drop always lands on a project.
Reordering refreshes boundaries using layout offsets
that include virtual positioning but exclude sortable transforms, so settling
animations cannot leave stale header positions. The sidebar has no separate
desktop-only top gradient or identity overlay.

Directory demand covers only the directory being worked in. Showing,
expanding, or restoring a project never bootstraps it. Row mounts must not start
bootstrap work. Selection and activity subscriptions stay session-scoped so a
structural list update does not make every row observe unrelated streaming
updates.

Session-row permission and form badges read the relevant directory-store buckets and show only whether something waits, without a count: one form can hold many questions, and a number that does not drop as the user answers them reads as wrong. A collapsed row covers its own pending requests and those of the descendants it hides; an expanded row covers only its own. The lookup never bootstraps a directory, so an unbootstrapped directory's store holds only live requests; until that store completes a bootstrap, the row lookup also reads forms from the cross-directory index, which the host seed fills at load, so a question already waiting in a project this client never opened still shows after a reload. Mobile rows show the same icon-only badges from the cross-directory index (`apps/usePendingRequests.ts`). A page an agent shows that waits for the user's answer has no directory-store bucket, so the row lookup also reads it from the cross-directory index and shows it as a form.

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
  limit. In a zone, consecutive session works collapse in one batch and a
  worktree work ends the batch, so the zone first gathers a run's members at
  the first one's place (`gatherRunMembers`): a fusion that moved up past a
  worktree row otherwise showed the same run twice.
- The run row is a work like a session or a worktree (`RunSidebarRow`), not a
  session: it never enters selection or the selection pool. It reads like
  their rows: the run's mark in the slot; the title; the lanes' model logos,
  then the lanes' state (aggregated by `useCollapsedSessionActivityState`). It opens to its lanes everywhere, zones included
  (`runExpansionKey`, same `expandedParents` store), as one-line session rows
  one level deeper; search forces it open. With Detailed rows it follows the
  two-line rows (`detailed`): no slot, the state on the right, the run's mark
  and lane count on the second line, the chevron over its first icon on hover.
  Its hover actions are Done (every lane and what the lanes started, past
  subagents, marked done) and a menu, also on right-click, with Open
  overview, Rename run (in the row) and Archive run (`runActions.ts`); keeping
  one lane stays in the overview, where the lanes are compared. A click opens
  the run's newest fusion when it has one, as a worktree's row opens its
  session, and otherwise the overview (`useUIStore.runOverviewKey`); Open
  overview in the menu always reaches it. A fusion that starts while the
  overview is shown opens at once (`RunOverview`). The run's row is selected
  while its overview is open or, with no overview, while one of its members is
  the current session. While an overview is open, session and worktree rows do
  not show the session it covers as selected, and clicking a worktree or draft
  row closes it (`closeMainSurfaces`), as a session row does.
- A row in rename keeps its height: the virtual list's 1px margins target
  `data-session-row-box`, which the session row and both rename containers
  carry (`data-session-row` stays on the normal row only, for Shift range
  selection). The run row's rename takes the whole line: no actions reserve
  and no fade while renaming. The maintainer chose this on 2026-10-24: a row
  that only opened the overview, with no actions and no lanes, read as foreign
  in the list of works and could not be finished from In work.

The phone draws the same run rows (`MobileRunRow` in
`apps/mobileSidebar/MobileWorkRows.tsx`). Row memoization compares membership
semantics (`sameMultiRunIdentity`, including the run title) so metadata-only
changes update rows. See `lib/multirun/DOCUMENTATION.md`.

## Works

The desktop and web sidebar lists works, not sessions (`works/DOCUMENTATION.md`
owns the details). A work is either a linked worktree or an isolated space
with every session in it, or a root session of the project root with what
nests under it. Nesting is display lineage (`lib/sessionWorkLineage.ts`,
`resolveSessionNestingParentId`): a subagent under its run (`parentID`), and
under the session it grew out of an auto-review (`originalSessionID`), and a
`/btw` side conversation, promoted or not (`originalSessionID`, after
promotion `fork.sessionID`). A plain fork stays a root: it usually takes the
task another way, so it is a work of its own (maintainer decision 2026-10-26).
A session another session's agent
started through the openchamber tool stays a root: it is the user's own
conversation, and its prompt links back to the sender in the transcript
(`metadata.openchamber.promptedBy`). The `originSessionID` older builds wrote
on such sessions is ignored. The folder decides first: a session in
another folder stays a root there, and so does a multi-run lane. See the
archive/delete/restore invariant below for action lineage.
`list/sessionCollection.ts` and `projects/useSessionGrouping.ts` both build
their trees with it, so the collection's `nestedSessionIds` never lists a
nested session as a root of its own.

A worktree's group header is its work row (`works/WorktreeWorkRow.tsx`), and
so is a space's (see "Spaces" below); the project root and archived buckets
keep `SessionGroupSection`. The row
reads like a session row, its title where session titles start: the
worktree mark tinted by the branch's PR in the slot, always, and the live
state of its sessions (running, news, a waiting request) at the end before
the time; the chevron replaces the mark while the row is hovered or focused,
when there is something to open (touch layouts keep the chevron). The
title carries the state as a session's does (semibold for news or a waiting
request, full strength while running, a step below otherwise), and the end shows the
running turn's duration, or the last turn's until it is read. The title is
the task title (the branch description,
`WorktreeMetadata.title`; a worktree made for a pull request or an issue
starts with that item's title, the agent's until replaced), until it has one
the branch (see Task titles below for the branch-first option); the tooltip
always names the branch. At the end sits the PR or the issue its sessions follow as a mark in its state's
colour without its number (one line has no room for it; the mark's tooltip names it and a click
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
session is, and Done marks all of those done (`collectSessionWorkInWork`).

Only a row that is a work of its own offers Track / Done (`ownsWork` on the
session row): a top-level session of the project root, a folder or a zone. A
session nested under one, a lane of a run and every session of a worktree or
a space work leave it to the work above them, on desktop, web and the phone.
Btw sessions and auto-reviews carry their own work state, and with a
Track / Done of their own one group mixed tracked and finished sessions that
looked alike at rest (maintainer decision 2026-10-26). Their state still
counts toward the work's, and the composer's Mark done still closes the open
session alone.

Work that is done or removed leaves the working set on every path (Done on a
session row or a worktree row, Mark done in the composer, removing a
worktree): `leaveFinishedSessions` in `lib/sessionTabs.ts` closes those
sessions' header tabs and, when the open session is one of them, moves to the
neighbouring tab still at work, or with none to a new draft in the project;
without tabs only that move applies.

Done on a worktree work marks every session in it done and leaves it (its
tabs close and the app moves off it, a draft in its folder included). That is
all by default: the worktree stays where it is, out of In work. With "Archive
a worktree when you mark it done" on (`worktreeArchiveOnDoneEnabled`,
Settings → Sessions → Finished worktrees, off by default; maintainer decision
2026-10-24, as archiving on every Done removed folders people expected to keep)
Done then archives it too. Archive worktree in the menu, and the row's
new-chat button, which turns into Archive while Shift is held (as a session
row's archive turns into delete), always archive. Archiving goes through
`archiveWorktreeWork` in `lib/worktrees/worktreeArchive.ts` (the server side
is in `web/server/lib/git`). An archive keeps every change and the branch, so
nothing has to be confirmed; a session still running there, or one whose
state cannot be read, keeps the worktree and says so. Delete in the menu stays the way to remove a worktree
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

A worktree's row is named by its task, and by its branch until the task has a
name; never by one of its sessions (maintainer decision 2026-10-27: a row
named after its latest session read as a session and changed name with each
one). "Name worktrees by branch" in the display menu
(`worktreeNameByBranch`, `sidebarWorktreeNameByBranch`, off by default, one
value for every surface) swaps them: the branch is the row's name, the task's
under it. The name the row does not show goes on a detailed row's second line;
the tooltip leads with the task's name. A space follows the same rule with its
own name in the branch's place. A session moved into a new worktree takes its
task's name along (the sidebar's Quick worktree move,
`lib/worktrees/sessionWorktreeMove.ts`, and the agent's
`session.moveToWorktree`, `carryToWorktree` in `work-naming.js`): the agent
does not name a task twice, so the new worktree would otherwise show its bare
branch. A move onto a branch that already exists keeps that branch's name.

### Spaces

An isolated space is a work like a worktree (`isGroupWork`, maintainer
decision 2026-10-26): one row for the space and every session in it, with the
same lineage under it, In work, Track / Done, folding (it starts folded) and
the draft rows of its folder. The row is the worktree's (`WorktreeWorkRow`,
`MobileWorktreeRow`), drawn for a space by `useWorktreeWork`:

- The space's instance icon where the worktree mark goes. Its title is its
  task's name, named as a main-checkout task is: the agent's `work.name` from
  inside the space names the root session it works in, and the user's rename
  of that session wins (`metadata.openchamber.workTitle`); the most recent
  named session names the row. Until then the row shows the space's own name,
  which otherwise stands where a worktree's branch does (the tooltip, a
  detailed row's second line). Rename task renames that session. It has no branch, pin or archive.
- Its state is one mark at the row's end (`spaces/SpaceStatus.tsx`): a
  spinner while it is made, a setup command runs or an action is under way;
  the word "Stopped" where a row's time goes while it is stopped (a square
  there read as a Stop button); a warning or an error. The row is one line, so
  the text is never on it. On the desktop the row's tooltip writes the state
  out, each line with the action that moves it on (Start, Grant access,
  Details, Remove); on the phone the actions sheet does, above the actions.
- Its menu (and right-click menu) and the phone's actions sheet hold the
  space's actions: Apply changes, Access and network, the repairs, Delete.
  New chat is gone while a new session there would fail: the making failed,
  the container is gone or the machine is out of reach.
- Done marks its sessions done and leaves the work, as on a worktree, and
  stops the space unless an agent still works in it: its files stay, its
  memory and processor come back, and the next message starts it. The
  space itself stays. Applying or discarding its changes is the apply
  dialog's and Delete's, never a side effect of Done.
- A space nobody has chatted in yet leads its project's list (and the list by
  time) while it is being made or runs (`liveSpaceIds`), where a worktree
  without sessions closes it: it was made to be used now, and at the end it
  fell under Show more and looked missing. One whose making failed or whose
  container is gone closes the list like that worktree. While it is
  made, the draft that waits for it sits on the project root and names the
  space by its creation request (`spaceOfCreationRequest`); the row counts
  that draft as begun there, so it is listed in In work and selected.
- A space's session belongs to the project the space was made from:
  `resolveProjectForSessionDirectory` maps a `/spaces/<id>/...` directory
  through the space's mark, so the header tab's project icon, the session
  switcher, the tray and the other places that name a session's project see
  it. The places that would carry host data into the space or apply the host
  project's config keep no project for it, visibly in their code: project
  knowledge and agent memory (`useProjectContextOwner`), workflows, the
  config store's project defaults, and a fork into a new worktree, which
  would hold none of the space's changes. A render that names the project
  subscribes to the space (`useSpaceProjectDirectory`), and the open session
  makes its project active once the space list names it
  (`sync/space-session-project.ts`), since the list can arrive after a
  reload has opened the session. A new session opened from inside a space
  stays in it, as from a worktree, unless the space can take none.

## One view

The desktop and web sidebar has one view. `sidebarGrouping`
(`useSessionDisplayStore`, per surface) groups works under their projects or
in one list by time; until the user picks one it follows the Tree / List pair
it replaced (`resolveSidebarGrouping`: List sorted by time keeps the list by
time, everything else groups by project); the phone follows the same
setting, and VS Code always groups by project. The display menu opens with Select sessions, then Grouping, then
(grouped by project) the project sort and project display,
then the section toggles (Chats, Pinned, In work), "Also show in work under
projects" (`keepWorkInPlace`, `sidebarKeepWorkInPlace`, off by default, shown
while In work is), Detailed rows, "Name worktrees by branch", then Collapse
all / Expand all.

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
  headers are sticky. The projects sit under a "Projects"
  caption (a `caption` row, `projectsCaption`) styled as a zone's label, so
  every section has a caption and a project is an item of its list: its label
  is the row's size, medium weight, beside its icon, and the indent of its
  sessions sets it apart from them. A project a size up and bold, with
  captioned zones above it, read as a heading of another level (maintainer,
  2026-10-28). The caption shows only with something listed above the
  projects, never in single-project mode. The caption folds like a zone: closed, it
  hides every project (`PROJECTS_CAPTION_COLLAPSE_KEY` in the zones' saved
  collapse set); Expand all opens it, Collapse all leaves it as it is and
  folds the projects one by one. One-line rows (sessions, works, drafts,
  runs) take 5px of vertical padding (a 30px row) and two-line rows 6px, so the one-line
  list reads denser (maintainer, 2026-10-28).
  A zone's label is a bare muted word at the row's size, with no icon, and
  the widest gap above it (20px); its chevron follows the word, always while
  the zone is closed and on hover while it is open. At a project's weight
  zones made the list read as a document of sections, and a quiet label with
  an icon in the projects' column read as one more row (maintainer,
  2026-10-28). Projects are set apart by
  space alone (`sectionSpacingAfter`): 12px before a project that has rows
  above it, 2px after a collapsed project, so a run of collapsed projects
  reads as a list. A hairline between projects was tried and dropped: with
  projects collapsed it striped every row (maintainer, 2026-10-28).
- Rows of zones that mix projects (Pinned, In work, the list by time) are
  `'mixed-compact'`: one line with no project icon (the room goes to the
  title; the whole-row tooltip names the project, branch and model), the PR
  or issue as a coloured mark;
  they open to what nests under them like the project tree. Detailed rows
  (`detailedZoneRows`, `sidebarDetailedZoneRows`, off by default; under a
  project it gives the works two lines as well, see "Locations and detailed
  rows") gives them
  the two-line `'timeline-mixed'` row. It opens to what nests under it like
  the one-line row does, which stays one-line zone rows (`'mixed-compact'`)
  under it. It reserves no slot for that: its state sits at the end of the
  first line, and its chevron takes the place of the second line's first icon
  (the project's, else the branch's or the space's) while the row is hovered
  or focused, always on touch layouts (`leadToggle` in
  `SessionTimelineRowBody`). A row used to stay flat, carrying the requests
  under it as badges; next to a worktree row that opens, that read as a
  missing chevron, and the maintainer chose the hover swap over a column
  reserved for it (2026-10-24).
  A worktree work in a zone is its work row
  naming its project (`mixed`), with its sessions under it; with Detailed
  rows it takes their two lines too (`detailed`): the second names the
  project, the branch (left out where it is the title) and the reference with
  its number, as a detailed session row's does. Its sessions stay one-line tree rows under it: they
  share the work's project, branch and reference, so a second line would only
  repeat them. Row keys carry the placement, so a worktree kept in
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
- An isolated space without chats still has its work row: it leads its
  project's list while it is made or runs, and closes it otherwise (see
  Spaces). Search leaves it out.

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
their sessions in the shared lifecycle order (`orderInWorkWorks` in
`works/sidebarWorks.ts`) and passes `workEntries` to the row model. In work
spans registered projects. A session whose destination has no registered project
stays out of In work, Pinned and search until `sync/session-admission.ts` checks
its OpenCode configuration and registers its folder. Pins and work state cannot
admit a destination, including in the tray. The raw global cache retains these
sessions for cleanup and lineage. A work In work lists leaves its project
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
(`components/chat/SessionDoneHintRow.tsx`). The phone's session swipe actions
run left to right by how often they are used on a phone: archive, pin
(top-level rows), Track / Done (rows that are works, feature on), delete, rename;
AI rename sits inside the rename editor. Phone rows also show the goal glyph and the permission/question badges
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
(`readChatDraftClaimingFolderDraft`). Search leaves drafts out. The phone lists
and opens the same drafts. VS Code has no shared drafts: it keeps the
per-folder key, where a new draft finds the text left in that folder.

Every way into a new session opens a fresh, empty draft, so several drafts can
wait in one folder. The draft's project and branch row ends with a "N drafts"
control while other drafts wait in its exact folder
(`components/chat/composer/ui/DraftsHerePicker.tsx`): a menu on desktop, a
bottom sheet on the phone, each entry opening the draft as its row does. It
sits in a row that is already there, so it takes no height and the centred
composer never moves for it; a list on the draft screen was tried and matched
none of the widths around it. A new Chat has one draft kept in its composer
and none stored, so it shows none.

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
  badges. It shows no provider logo: the model's provider says nothing about
  the work, and the maintainer dropped it on 2026-10-25. The linked PRs and
  issues come from `useSessionRefLines`, which the phone's rows read too.
- Detailed rows reach past the zones (`detailedZoneRows` keeps its name):
  under a project, every work takes the two lines too. That is the project
  root's sessions and drafts, in its folders as well (a session row's
  `detailed`, `detailedRoots` in the row model), and its worktree works (the
  group row's `detailed`). What nests inside a work stays one line: subagents,
  reviews and btw sessions under a session, and a worktree's own sessions and drafts,
  since they share the work's branch and reference. Every detailed row,
  under a project or in a zone, is laid out the same way: no slot, its text
  10px in at the first level (`sessionDetailedRowPaddingLeft`), the state at
  the end of the first line, and the chevron over the second line's first
  icon on hover. Under a project that line names the branch (the project
  root's, passed as `secondaryMeta`) but not the project, which its header
  already does; in a zone it opens with the project's icon. A worktree's
  first icon there is the worktree mark tinted by its PR; a draft's line
  opens with a pen and names the branch its session will go to once that
  directory's git status is known.

## Pinned

The display menu's Show pinned section toggle (`showPinnedSection`,
`sidebarShowPinnedSection`, per surface, on by default for new installs) adds a `pinned`
activity zone between Chats and In work. It lists pinned top-level,
unarchived project sessions in the shared lifecycle order; pinned chats stay
pinned at the top of Chats. A work whose root session is pinned is listed in
Pinned only: it leaves its project (`movedSessionIds`), always, with no
"also show under projects" choice; the zone is there because the user turned
it on (maintainer, 2026-10-25). Turned off, pinned sessions stay in their
projects. Search
lists each of them once, in the zone (`zoneSessionIds` carries both zones' ids),
and the rows follow the same render context. Its rows show no pin marker,
because the header already says they are pinned; In work rows show it only
while the zone is hidden, since otherwise no pinned session reaches In work.

A worktree work is pinned too, from its row's menu (desktop, web) or its swipe
actions (phone): Pinned lists it after the pinned sessions, the latest pin
first (`pinnedWorktrees` on the row model), and it leaves its project, In work
and the list by time (`movedGroupKeys`). With the zone hidden it stays in its
project, leading the list as pinned sessions do, with the pin mark on its row.
Manual worktree order is gone (see "Why a worktree is listed among the
project's sessions"); pinning is how a worktree stays on top. The pin lives in
the branch's config beside the task title (`branch.<name>.openchamberPinned`,
`setWorktreePinned` in `web/server/lib/git`), so every client of the server
sees it and a detached worktree, which has no branch, offers no pin. The row
moves once the server's topology event lists the change, as a task rename
does; there is no optimistic flip. VS Code has no worktree works, so no
worktree pins.

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
load. The phone's display menu has both toggles. VS Code
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

The desktop header row holds the list's own controls (Search, Add project,
Display mode) and, last, one More menu with the pages the sidebar opens:
Overview, Issues and PRs, Scheduled tasks, Archive, Stats, Integrations
catalog, then extension pages. Shortcuts and About are not pages of the list:
they stay on their keyboard shortcut, the command palette and the app menu,
and About is a Settings page. A row of icons for every
page said nothing without hovering and was the first thing on screen
(maintainer, 2026-10-28). Each page item is a toggle: it carries a check while
its page is open and the next pick closes it; the More trigger turns to the
text colour while any of its pages is open. The footer keeps Settings, an
available update and the instance switcher.

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
  Worktree and folder labels are medium weight a step below full strength
  (`oc-group-label`), between the project header and the session titles at rest. Tree session rows are a little
  tighter than zone rows.
  An empty worktree group or folder (no sessions, no folders, nothing loading)
  shows no chevron, does not toggle, lists nothing under its header, and is
  always open: a collapse saved while it had sessions is dropped, so its first
  new session shows at once. A group counts as empty only once its sessions
  have loaded; before that it only looks empty, and the saved collapse stays. Collapsing a project or a worktree group, from its
  header or Collapse all, forgets its Show more state. The project
  header stays the sticky zone band above its tree. Root sessions and the
  root's folders sit at level 0; worktree, space and archive headers sit at
  level 0 with their folders and sessions at level 1; a folder's sessions sit
  one level under the folder, and subsessions one level under their parent.
  The slot holds the rotating chevron of a folder or a run. An archive
  header holds its icon there and shows its chevron in its place while the
  header is hovered or focused; touch layouts keep the icon and toggle on a
  tap. A worktree's work row holds its branch mark there, a space's its instance
  icon (see Works). Its label therefore starts where root session titles start,
  and its sessions sit one level in. On a session row the slot holds the
  chevron of a session with subsessions and stays empty otherwise, so titles
  line up. The slot says what a row is and never its state: every row's live
  state (running kind, unread, the move/rename spinner) sits on the right
  before the time. With the state in the slot a running worktree read as a
  chat, its branch mark gone (maintainer, 2026-10-26). Session rows use the
  one-line form of `SessionTimelineRowBody`: pin, done hint, the live state
  and, while a turn runs or until it is read, the turn's duration on the
  right. No row shows a date:
  every list is ordered by recency and the whole-row tooltip has the time.
  One-line rows (sessions, runs, worktree works, drafts) are 34px: the 20px
  line, 6px above and below, a 1px margin each side (`SESSION_ESTIMATE`). The
  one-line Chats, Pinned, In work and list-by-time rows (`'tree-chat'`,
  `'mixed-compact'`, session and run rows) take the same geometry at level 0,
  so titles read down one edge from the zones into the projects. Detailed
  rows have no slot: their state is on the right too and
  their chevron swaps in for the second line's first icon. Session, run and draft titles rest a step below full strength
  (`oc-title-rest`). Everything
  else on a row (time, branch, counts, icons, a PR's number) is metadata in the
  muted text colour at full strength, never a fraction of it. Only the mark of
  a PR or an issue carries its state's colour; its number stays neutral. Session, run, worktree and space work
  and draft rows take the same faint hover fill; archive and folder
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
- Opening and closing a zone, project, worktree, folder, multi-run or a
  session's subsessions animates like a reasoning block in the chat (200ms
  ease-out, `sessionSidebarDisclosure.ts` finds the block and
  `lib/motion/rowDisclosure.ts` holds the timing and keyframes the file trees
  share; a session row with subsessions
  carries `expanded` for it). The rows are flat virtual rows, so no
  container changes height: `SessionSidebarRows` compares each new row list
  with the one last drawn, and when exactly one header changed state with one
  block of rows right under it, those rows are clipped above a moving boundary
  and every row after them slides with it. A closed block is drawn as inert
  ghost rows at its old place until the motion ends; rows sliding in from past
  the virtual range stay mounted meanwhile. The block also fades: closing rows
  are gone by 60% of the motion, and an opening row comes up as the boundary
  uncovers it, solid once half of it shows. Clipped at full strength, a
  closing row stayed legible until the rows sliding up cut through it, which
  read as old content lingering over the new. An opening fade on a clock of
  its own (clear for the first 20%) left the first rows under the header
  empty while the rows below already slid away. Collapse all, search, Show more and
  live list changes do not animate, nor does anything under reduced motion.
  The phone's list is drawn by the same renderer and animates the same way.
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
  accept drops. A session lands in the folder whose header is under the
  pointer at release, and nowhere otherwise (`sessionFolderCollision`); the
  nearest-target rule stays for the project header sort, where it picked a
  folder the pointer never reached. A row drags only when its owner has a
  folder that accepts drops (`SessionFolderOwnersProvider`): a drag with
  nowhere to land swallowed the click that started it when the mouse moved
  8 px during the press.
- Session rows allow vertical touch panning before the long-press drag activates.
  The TouchSensor owns movement only after activation; disabling touch panning on
  the whole row prevents quick swipes from scrolling even when no drag starts.
- `folders/SessionSidebarFolderItem.tsx` owns activity subscriptions for mounted
  collapsed folder headers. It includes descendant activity without mounting
  those sessions; a subtask is never unread on its own. Expanded and archived
  folders do not derive hidden activity.
- Single-project flat mode reveals 20 root sessions initially and 20 per Show
  more; Show less resets to 20. Chats keeps its reveal of 3. Elsewhere a
  Tree worktree group reveals 7 sessions, 7 more per Show more, and 10 in
  VS Code. Show more and Show less share one row under the list, in the
  micro size so it reads as a control rather than a row: Show more while
  something is hidden, Show less once more than the first batch shows
  (maintainer, 2026-10-27). Reveal
  controls change the logical list, not the viewport's bounded mounted window.
- Archiving or deleting a session includes its OpenCode subsessions and linked review sessions on every surface. Forks and promoted `/btw` sessions stay active. Rows pass only their `parentID` descendants (`collectParentIdDescendantIds`); `collectSessionSubtreeIds` adds global action lineage from `stores/sessionLineage.ts`, including reviews linked by `originalSessionID`, even when a row renders no children or a review lives in another directory. Archive reaches active descendants below archived intermediates without restamping those intermediates; delete includes archived descendants too. Restore brings back archived subsessions and reviews, stopping at active intermediates. `sessions/sessionSubtreeActions.ts` owns the store calls, partial-failure toasts and exact-ID Undo. The project menu's "Archive all" includes descendants of each selected session in the same batch; its dialog and success toast count top-level sessions.
- Subsessions belong to the agent run that spawned them, not to the user. They appear only nested under an active parent: the archive (sidebar bucket, auto folders and the Archive page) lists top-level sessions only, an archived subsession or one under an archived parent is hidden rather than promoted to a row of its own, and there is no restore for a subsession; it comes back when its parent is restored. A subsession whose parent is not loaded yet stays visible as a root.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild, from the global cache or from the live child-store list: the collection subscribes only to the live sessions the global cache does not hold yet (`useLiveSessionsExcluding`), so a covered session's live bumps neither re-render the sidebar nor rebuild the structure. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- The published worktree topology leaves out every checkout that holds a configured project in a sub-folder, as it leaves out checkouts that are configured projects (`partitionWorktreesByRegisteredProject` in `lib/worktrees/worktreeManager.ts`). For a project that is a sub-folder of a repository, the repository's checkout would otherwise show as a removable worktree whose delete dialog names the whole repository (issue #4666). The raw per-project lists keep that entry, because it ties a sub-folder project to its repository when one project's refresh replaces the buckets of the repository. The root-session `Move to worktree` menu does not offer that checkout either, unless the session is already there. Sessions in it outside every project folder belong to no project, like sessions in any folder that is not added: adding the repository root as a project shows them (maintainer decision 2026-10-11).
- A worktree Git still registers but whose directory is gone (`prunable` in `git worktree list`) stays in the topology with `worktreeStatus: 'missing'` and a warning icon on its group header. Its sessions remain accessible for manual movement or archiving through worktree deletion. Opening a session does not move it. The ordinary worktree delete action accepts a missing directory. Shift+click on the worktree delete button (it turns red while Shift is held) archives the group's sessions and deletes the worktree and its local branch without the dialog, never the remote branch, but only when a fresh status check finds no uncommitted changes and every commit already on the branch's upstream or, for a never-pushed branch, on the base branch the server compared it with (`aheadBase`, e.g. `origin/main`) or on another remote branch (`canDeleteWorktreeWithoutConfirm`); any other result, including a failed check or a never-pushed branch the server could not compare, opens the ordinary dialog. Topology discovery remains event-driven, including `session-created` and server `worktree-changed` control events, with no idle polling. A `session-created` event refreshes only the project whose root is the session's directory or whose known worktree holds it (`resolveProjectForCreatedSession`); any other directory, such as a new worktree nobody has listed yet, gets the full discovery, because a registered folder above it does not prove which repository it belongs to. After an instance switch the project list comes from the local cache, so discovery can run before the instance answers: projects whose discovery failed are discovered again once when the connection comes up. The worktree list and project-root caches are keyed by path, so a runtime switch clears them. The server sends `worktree-changed` after its own worktree create/remove and when a status or listing request notices that a repository's worktree set changed (see `packages/web/server/lib/git/DOCUMENTATION.md`); the event names every directory of that repository the server has seen, and the sidebar refreshes each registered project among them once, bypassing the 30-second list cache. A worktree this client created and is still bootstrapping keeps its `pending`/`invalid` status through that refresh. Hosted mobile and the desktop mini chat handle the same control event through `lib/worktrees/worktreeTopologyRefresh.ts`; VS Code intentionally excludes worktree topology.
- A worktree this client is removing shows it on its row, from the user's confirmation until git answers: a spinner replaces the branch icon, the row dims and its delete action hides. The desktop and phone worktree rows and the phone's project-edit worktree list all read `lib/worktrees/worktreeRemovalState.ts`. The row leaves with the topology once git confirms. It does not fade out: the server's `worktree-changed` refresh drops it as soon as the removal finishes, which would cut any exit animation short. A failed removal clears the state and the row returns to normal beside the error toast. Removing the files of a large worktree takes tens of seconds, so the spinner stays for as long as the deletion runs, never shorter. Another window removing the same worktree shows nothing until the topology refresh drops the row.
- Opening the root-session `Move to worktree` submenu force-refreshes the owning project's worktree topology so externally created worktrees appear without a full reload. While that refresh runs, the menu keeps the last known primary/linked topology visible; if the refresh fails, the stale topology remains and the load failure state stays explicit. Failure cleanup never removes or manages an existing destination worktree. The owning project resolves from the row's project id, then from the session's directory, then from the session's worktree metadata `projectDirectory` — the last step keeps sibling destinations listed for a restored session whose own worktree directory was deleted.
- Unarchiving a session whose directory the server confirms missing (its worktree was removed while it sat in the archive, by this app, by hand or by git) moves it, with its subsessions in that directory, to its project root (`lib/worktrees/relocateRestoredSession.ts`, maintainer decision 2026-10-02). OpenCode cannot run a prompt in a missing directory (it answers 500), while `session.move` works from one and appends a `location-switched` record that tells the model its working directory changed. The project root comes from the same ownership index as grouping (directory first, then OpenCode project metadata), so it survives a restart. A toast names the cause, the missing folder, not an action of this app. An unknown availability answer, an unresolved project or a missing project root leaves the session where it is; a rejected move shows an error toast.
- Cleanup after a PR merge is opt-in (`mergedWorktreeCleanupEnabled`, Settings → Sessions → Finished worktrees, beside archiving on Done, off by default; maintainer decision 2026-10-02). `hooks/useMergedWorktreeCleanup.ts` reads the branch PR status the sidebar already keeps fresh for each discovered linked worktree, asking GitHub nothing itself, and `lib/worktrees/mergedWorktreeCleanup.ts` decides: wait while any session there is not confirmed idle, is the open session, or the worktree is the directory on screen; otherwise archive the worktree with its sessions. An archive keeps uncommitted work and commits outside the merged PR, so the earlier rule (remove only a checkout with nothing to lose, keep the rest) is gone with the checks it needed. Each worktree and PR pair is tried once (remembered in local storage), so a failed archive is not retried on every pass. A worktree being archived or removed right now is skipped, so Done and a pass never archive it twice; a worktree the user restored from the archive is marked handled for its PR on the next pass (`takeRestoredWorktree`), since restoring a merged worktree is taking it back. It runs on desktop and web only; VS Code has no worktrees and a phone would race the desktop it drives. Only worktrees of projects whose worktrees the sidebar has discovered are covered.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event re-lists the worktrees of the session's project, or of every project when the session's directory is not a project root or a known worktree, so a newly created external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- A successful restore on the current runtime promotes only the session's ephemeral list-order rank. It does not change timestamps or live status, and it resets on a runtime switch.
- `useProjectRepoStatus` reads Git status once per project path while the sidebar is visible. A change to the project list that adds no path (collapse, rename, color, last opened) reads nothing; an added project reads only its own status; a failed read is retried on the next list change. New paths are first read together through `GitAPI.prefetchProjectStatuses`, one batched request that warms the status cache, so the per-project reads after it are cache hits; VS Code has no batched read and reads one by one. Hiding the sidebar or switching runtime starts over.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, branch, or worktree-ordering ranks changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave. The grouping builder therefore keeps its identity across inputs the section cache compares per project: it reads git branches and lifecycle ranks at call time, and keeps the session ownership map while every session's scope directory is unchanged (the ownership index itself is rebuilt on any session-list change). Without a search query every group shares one empty search-data map, so a rebuilt section does not invalidate the others' group headers.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- List loading and workspace initialization have separate states. The spinner follows only the list queue; config, MCP, LSP, and live-state recovery cannot keep a successful empty list spinning. A core initialization failure has a separate localized notice and reuses the retry/native-access actions without clearing loaded sessions.
- Directory permission failures remain visible even when stale sessions are retained. Flat groups inspect every represented root/worktree directory; local Desktop may open the native picker for the exact failed directory, while other runtimes keep the ordinary Retry action.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
- Pending-permission/question row badges ride in the meta cluster at the row's end with the time and status, and hide with it on hover or while the row menu is open, except on non-VS Code always-visible-actions rows, which reserve permanent padding and keep the cluster shown. VS Code hover-reveals its actions over the row's right edge even under `alwaysShowActions`, so its cluster keeps hiding.
- Hover-revealed actions on session rows, worktree headers and project headers swap in over the row's end (the right, or the left in a right-to-left layout) at once, without a fade; they do not re-lay the row out. What they cover (date, branch, badges, indicators) hides in the same step, and the title or label's tail fades away under them through the `oc-actions-mask` utility (`index.css`): the row's text line is an `@container`, `--oc-actions-reserve` says how far the actions reach in from its end edge, `--oc-actions-inset` how far the masked text starts from its start edge. A title whose own direction differs from the interface (`dir="auto"`) starts under the actions, so it takes `padding-inline-start` of the reserve instead of the fade. Reserves, insets and the mask's own gradient stops are rem so they track the interface font size, and the mask multiplies reserves and insets by `--padding-scale` because the buttons and offsets they describe are spacing tokens that grow with the density setting; a pixel reserve would stop short of the buttons at larger sizes and let the title show through. Change a reserve whenever an action's size, count or offset changes. Only permanently shown actions (`alwaysShowActions`) take layout room.
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

### Why row text has three levels and metadata is never faded

A row's text takes three levels: a title that needs the user (full strength,
semibold for news), a title at rest (`oc-title-rest`, halfway between body and
muted text), and metadata (the theme's muted text colour). Metadata used to stack opacity on top of the muted
colour (`/40` to `/80`, eight levels across the sidebar); at `/50` the time and
branch measured 2.4:1 in OpenChamber Dark and 2:1 in Light, under the 4.5:1
readable minimum. Themes already keep the muted colour readable on their
canvas, so a fraction of it undoes that. Resting titles moved up a step so
they stay above metadata that is now full muted. The step is a mix of the two
colours, not body text at 80%: light themes keep body text soft, and at 80% it
measured at most 0.11 above muted, and often below it, in every built-in
light palette. Folder and archive labels take `oc-group-label`, three
quarters of the way to body text, for the same reason: at 85% of body text
they fell under the resting titles they contain in every light palette.

### Why hover actions appear without a fade

The actions and what they cover swap in one step. A fade on every pointer
pass over a list reads as lag, and the mask under the title already keeps the
swap from jumping.

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

### Why a worktree is listed among the project's sessions

A worktree was a block of its own under the project, after every session of
the project root, with its own sort (recent, manual with dragging, A to Z).
Once a worktree became a work like a root session, that block hid it: a
worktree with the newest session sat under Show more, below sessions days
old. The maintainer decided (2026-10-24) that a worktree is a task like any
other of the project, with a collapsible group of its own, so it is listed
among them by its latest activity, and the worktree sort, the saved drag
order (`oc.sessions.groupOrder`) and worktree dragging went with the block.

### Why the phone draws the desktop's rows and not its own list

The phone had its own list, built in its drawer: Tree and List views, worktree
groups, its own In work, per-folder drafts. Once the desktop listed works, the
two answered differently what the user was working on, and every change to
works had to be made twice. The maintainer chose (2026-10-24) one model for
both, with the phone's rows for a thumb: swipe instead of hover and menus,
the chevron always shown, two lines by default. The phone keeps its own
renderer rather than the desktop's rows, whose hover actions, menus and
drag-and-drop a touch screen cannot use.

### Why tree guides end in a corner at the last child

The Files trees draw one straight guide per ancestor level down every row.
The session tree frames a group instead: the line starts under the open row
and stops at its last child with a corner, so where a worktree's or a
session's children end reads at a glance, and a long tree is not striped by
lines that run through rows they do not belong to.
