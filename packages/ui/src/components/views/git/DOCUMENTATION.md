# Git view controls

## Ownership

This module owns the shared Git controls, branch comparison helpers, publish
chooser, operation recovery presentation and history graph. The surrounding
views compose these controls. Shared view lifecycles, repository selection,
comparison scopes and push-for-review presentation are documented in
[`../DOCUMENTATION.md`](../DOCUMENTATION.md). Git execution and durable network
operation contracts belong to the runtime APIs and source-control modules.

## Invariants

### Comparison references

- A comparison base must resolve to an existing ref and must differ from both
  the current branch and its remote copy. A guessed `main` cannot make a
  comparison available by itself.
- Remote branch matching compares the whole branch name after the remote
  prefix. A suffix match would mistake `origin/feature/main` for `main`.
- The repository default read from `remote/HEAD` has authority over conventional
  branch-name guesses. It stays separate from the root worktree's current
  branch hint because those inputs answer different questions.
- Cross-repository pull request generation starts from the upstream default's
  SHA. A bare name can resolve to the local branch and produce an empty range
  such as `main..main`.

### Publication and branch switching

- A dirty branch switch requires an explicit commit-or-revert choice before
  checkout, so local work cannot silently follow the switch or be lost. Cancel
  leaves the working tree untouched; an empty commit message uses the commit
  panel's generation pipeline.
- A dirty-switch push preserves the tracked destination branch even when its
  name differs from the local branch. An upstream outside the available
  remotes has no automatic fallback because another destination could expose
  work kept on a local path.
- A new branch's automatic publish destination comes from its bound identity
  or its sole eligible remote. Inherited fork access permits fetching and
  requires an explicit choice before publication to that fork.
- Only a destination confirmed in the mounted panel can supply reusable push
  authority. Tracking alone grants none, and a failed post-push read cannot
  undo a completed push or preserve authority for another one.
- Review hosts receive changes through push for review. A regular branch push
  could land the commits without review.
- Change-Id preflight examines the newest 50 commits. Only a missing Change-Id
  on the tip can be repaired by the panel's amend action; older missing trailers
  require a rebase and hold the push back.
- A Change-Id counts only in the final trailer block of the commit message; a mention in the body does not
  (https://gerrit-review.googlesource.com/Documentation/user-changeid.html). The link lives here because shared
  UI sources may not name a review host (`lib/source-control/providers/neutrality.test.ts`).
- The remembered merge-method preference excludes Submit because a review
  host offers no alternative method to choose.

### Change request state

- A created change request is associated with the open session only when that
  session works in the Git view's directory. The view can show another worktree.
- An automatically detected base can arrive after the form opens and updates
  it until the person chooses a base. A manual choice stays authoritative.
- The default branch remains the trunk when inferring a stack parent, even if
  it has an open release request.
- A failed refresh preserves the last authoritative result for its context.
  Status supplies the current request state and head; a list lookup adds missing
  labels and counts without replacing those fresher fields.
- The request's own detail supplies its stack when available. The branch
  status's stack is a fallback only until that detail answers.
- Explicit refresh invalidates the server's short-lived request answers and
  refreshes its followed item where supported. Refreshing branch status alone
  leaves the sidebar badge stale. Focus refresh reads staleness at event time
  because a request can change while the app is away.
- Provider identity and terminology remain available when no connected account
  can read the project, so an authentication failure still names the right host.

### Recovery and repository resolution

- An unreadable repository shows Git's diagnostic and retry. Initialization is
  unavailable because failure to read a repository does not establish its
  absence. Home and disk roots also exclude initialization because a repository
  there would cover every file.
- Once a repository becomes readable again, recovery re-reads its binding so a
  `safe.directory` refusal cannot leave a stale blocker behind.
- Failed durable-operation reads and writes retain the blocker. An immediate
  reconciliation failure still permits delayed reads to resolve an interrupted
  mutation.
- Nested resolution keeps loading while a discovered repository awaits
  selection or probing. An unsupported discovery runtime shows the plain
  not-a-repository state because retry cannot provide the missing capability.
- The repository picker includes a repository root even before its first
  commit, so selecting a nested repository does not remove the route back.
- Conflict resolution uses prompts from the repository's project even for a
  temporary worktree. Failure to read those prompts leaves the dialog open
  without opening a session or filling its input.

### Interaction and layout

- Revert actions require confirmation because they sit beside staging actions
  and an adjacent click must not discard work. Revert-all deduplicates paths
  shared by staged and unstaged groups.
- Prefetch starts at the first visible row, excluding overscan above the scroll
  offset, so offscreen files cannot consume the visible-path budget.
- Collapsed directory chains retain the deepest node's expansion key. A
  directory path's trailing slash remains meaningful to its displayed name.
- Check and failed-step expansion state belongs to the caller so closing the
  list does not erase it. Mounted previews keep a live clock because the Git
  panel can remain mounted for hours.
- Integration cannot be cancelled or closed while its operation runs; its
  dialog remains available to show progress. Net-deletion celebration waits
  for the push when a commit includes one.
- A diff tab takes the zone the Git panel sits in, so opening one unmounts the
  changes list. Its offset is kept per runtime and repository in a module-level
  map and restored before the remounted list paints (`ChangesPanel`'s `memoryKey`).
  A list of 1,000 rows or more is virtualized: the virtualizer reads its first
  offset while rendering, before the scroller mounts, and writes it to the
  scroller when it attaches, so its `initialOffset` is the saved offset.

### Unified Git and Changes surface

- A refresh hint gives each hinted path, or every entry for a pathless hint, a
  new content revision (`useWorkingDiffFreshness`). Clearing the shared cache
  alone leaves an open entry on its own patch when status line counts match.
  Hints received while the panel is hidden apply when it shows again.
- Scope writes are idempotent: the panel switches to `turn` only while it is not
  already there, and the tab is rewritten only when its scope changes, so a
  pending changed-file chip cannot loop through tab updates.
- A changed-file chip settles once the turn snapshot does: a listed file is
  revealed and scrolled to; a file missing from the snapshot falls back to the
  working tree, selecting its nested repository or opening it outside any
  repository, as the separate Changes view did.
- The wide layout fetches the selected file even when no row is expanded.
- The wide layout's sidebar always shows files as a tree, folders expanded
  until the user collapses one; the flat list is only the narrow layout's.
  A newly selected file opens its collapsed group and folders, so the selected
  row is never hidden; the user can collapse them again afterwards.
  Every wide scope (working changes, commits, turn, branch, PR) shares one
  sidebar width, `gitSidebarWidth`, resized by dragging its edge and reset by
  double-clicking it; the diff column keeps at least 360px.
- The sidebar's change tree uses the file tree's rows (`ChangesTreeRows`): whole
  names, sideways scroll, the status letter in the end lane and the stage and
  revert buttons in a lane over it on hover. It shows no line counts; the open
  diff's header has them.
- Commits and pull requests drill down the same way (`GitDrillHeader`). Wide:
  the sidebar lists commits or pull requests, picking one turns the sidebar
  into that item's file tree under a header with an icon-only back button, and
  the right side shows the selected file. Narrow: the list, then the item's
  files as accordions under the same header. Pull requests are listed in
  `PullRequestListPanel` instead of a dropdown; a pull request selected from
  elsewhere (a handoff or the branch's own) opens drilled in.
- The panel header's toolbar holds the scope, review and sync controls; the
  branch picker sits in the row below, next to the identity. When the toolbar
  still does not fit, the scope label truncates rather than overflowing onto
  the panel's own window buttons.
- Wide or narrow is chosen once, when a zone resize animation starts, from the
  zone's target size (`data-zone-size`) minus the inset measured at rest. Deciding
  from the measured width swapped the whole body mid-animation, where the
  remount showed as a stall; widths seen during the animation are ignored, and
  the settled width is measured again afterwards. The swap happens on the click,
  and through the animation the view's root is pinned to the target width on
  a compositor layer (`will-change: transform`), so the zone only clips and
  moves finished content: no layout or paint per frame. On a 120 Hz screen a
  frame has 8 ms, and re-laying the panel's content each frame cost 12 to
  14 ms of paint alone. Rendering the new layout mid-animation, as a
  transition, dropped frames wherever it landed.
- Work that would land during the animation waits for it to settle: rows past
  the first ones (`ProgressiveRows`, `useRowLimitAfterSettle`) and the wide
  layout's diff body.
- `GitView` is memoized and its parent passes it stable callbacks: an expand or
  collapse re-renders the zone, and before that every changed-file row and its
  tooltips rendered again on each click. The branch picker builds its menu only
  while open, since a repository's remote branches made every header render
  slow. A changed-file row mounts its hover actions on first hover or focus,
  and its stage button uses the list's delegated tooltip.
- AI Review and Walkthrough stay in the header at any width: the toolbar fit
  drops their words first and moves them into the menu only when the row
  still does not fit, so a resize never makes them appear or vanish at once.
- Measured on the production build with 76 changed files (2026-11-23, 60 Hz
  capture): the click restyled 7,600 to 10,600 elements before (the zone's
  size was an inherited custom property) and 584 after, the same as a small
  surface; no main-thread task over 8 ms runs during the animation. The click
  itself costs 45 to 50 ms, the price of rendering the new layout up front.
- Commits pages through the branch-scoped history (`useCommitComparison`'s
  `maxCount`), the same source the list and its loading state read.
- Find in changes and Alt+Up/Down file stepping run on the standalone diff
  view's hooks (`useDiffViewFind`, `useDiffFindSurface`, `useChangedFileStepping`)
  in both bodies: working changes (`useWorkingDiffNavigation`) and the review
  scopes. Each body's root is its own `[data-find-surface]` and hosts the
  `DiffFindBar`. A find match or a step lands where a chat reveal does: working
  changes through `useWorkingFocus`'s `focus` (open the group, expand, select,
  scroll), review scopes through `revealTurnFile`. Review scopes search and step
  only while files are on screen, so not over a commit or pull request list.
- Every scroller that holds `MultiFileDiffEntry` diffs (both layouts, both
  bodies) is a `data-diff-virtual-root` around a `data-diff-virtual-content`,
  as in the standalone diff view. Without it Pierre's shared virtualizer binds
  to `document`, which never scrolls here: a long diff rendered its first rows
  only, and find could not bring a match further down into view.
- Working-changes find searches every entry on its own: a file in both Staged
  and Changes is two sources, `staged:<path>` and `unstaged:<path>`, each
  reading its own side's diff, so a match reveals the entry that holds it.
  `useDiffViewFind`'s `findKeyOf` gives a file its find key; viewers, word
  requests, full-context changes and reveals cross between that key and the
  entry's path with the group prefix. Stepping walks every entry, Staged
  first, in list order.
- Find results are cached per source revision. A working source's revision
  holds the content revision the displayed patch also follows (index revision,
  refresh hints, per-file nonces), the file's status letters and line counts,
  and the number of times the panel has been shown, so an edit made while the
  panel was closed is read again on reopen. A comparison source's revision
  holds the comparison range, so a path one commit has not loaded yet never
  reuses another commit's patch.
- The navigation cursor follows the user: opening a file by hand in the narrow
  layout selects it, so Alt+Up/Down steps from there. Review scopes close find
  when their files leave the screen (back to the commit or pull request list).
- Saved local `diff` tabs become the `git` tab; a converted tab replaces a plain
  Git tab and the panel's and zones' active ids follow it.

## Decisions

### Why qualified remote bases and not bare local names

The range API uses refs literally, so a bare base resolves to the bound remote's
copy before a local branch. Explicit `refs/heads/` choices stay local, and refs
on other remotes are rejected because matching names can belong to different
projects. The shared base-selection precedence remains documented in the parent.

### Why a create form after closure and not a read-only preview

A closed or merged request remains visible as branch history while the form
offers the next request. Closure releases the branch for new work.

### Why a recovery card and not another progress indicator

The initiating control already shows a running transfer. The card reserves its
space for saved operations, failures and unknown outcomes, retaining the
operation ID so the person can investigate outside the app.

### Why one unified Git & Changes surface and not two rail icons

Git operations and inline diffs share the same working-tree loop: staging files or hunks, reviewing edits, and committing. Merging them into the retained `git` surface removes the tab-switch ping-pong, adapts automatically between narrow inline accordions and wide master-detail without a manual tree toggle, and keeps `DiffViewOptionsMenu` (`equalizer-2`) separate from repository operations in `···`.

### Why inline Commits scope with right-click actions and not History/Graph dialogs

The History modal duplicated the `commit` comparison scope, and the commit-graph canvas added maintenance without matching how people inspect history in the panel. Moving commit list browsing directly into the `commit` scope (with right-click context menu and header `···` actions for checkout, branch creation, cherry-pick, revert, and reset) removes both modals and the lane-assignment canvas.

### Why a collapsible desktop commit dock

In narrow docked panels, an always-expanded commit form consumes vertical space while reading inline diffs. Collapsing automatically to one line when nothing is staged and no draft is entered (and expanding automatically on first stage, with a manual collapse toggle) keeps diffs readable without hiding commit state.

### Why positioned virtual rows and not flow stacking

Changed-file rows use their virtual offsets because variable-height flow rows
can drift from the computed total height before measurement. Tree actions
replace statistics on hover to keep row geometry stable; touch layouts show
both because hover is unavailable.

### Why retained input focus and not immediate form collapse

The phone's commit form stays mounted while focused even after its draft clears,
so typing cannot remove the field and keyboard. Commit input sizing runs in the
layout phase against a reset baseline to avoid mount flicker.

### Why visible identity failures and not hidden menu choices

Binding failures sit beside the identity they affect. Ineligible identities stay
listed with their reason so an instance or transport mismatch has an explanation.
Identity and comparison menus scroll within their available popup height because
a low trigger and a growing list cannot assume space below the form.

### Why find keys per group entry and not per path in working changes

Find keys its sources, viewers and reveals by a string, which the standalone
diff view sets to the file path. Working changes key by group entry instead:
keyed by path, a partly staged file had one source, and text only its staged
half holds could not be found or revealed. The key is the entry key with its
group prefix, so translating to and from the entry's path stays a prefix
operation, nested repository rows included.
