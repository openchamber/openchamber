# Session controls

## Ownership

This module owns session dialogs, project and worktree entry points, scheduled-task
editing, and shared session controls. The sidebar owns work projection and row
interactions in `sidebar/DOCUMENTATION.md`. Project knowledge and project discovery
own their contracts in `project-context/DOCUMENTATION.md` and
`project-import/DOCUMENTATION.md`. Space UI contracts live in
`spaces/DOCUMENTATION.md`; host enforcement stays in `lib/spaces` and the server.

## Invariants

- Directory browsing resolves relative names against the browsed folder because
  the server's working directory can be somewhere else. An absolute path pasted
  after the untouched `~/` prefix remains absolute.
- Project identity uses the resolved filesystem path. Symlinks to an added project
  cannot add it again, but added folders remain browsable for subfolders. A linked
  ancestor alone does not make every descendant a symlink.
- Folder listings publish resolved identities with their rows, so a symlink never
  briefly appears addable. Previous rows remain until the next listing arrives
  to avoid a loading flash, and actions check which folder those rows belong to.
- Each browsed folder keeps its scroll offset per runtime (`browseListMemory`).
  The key and the check that the rows are the folder's own use one identity
  with case kept, so `/work/Foo` and `/work/foo` stay separate lists on a
  case-sensitive filesystem. A read in flight, its loading message included,
  or a failed read neither takes the saved offset nor records its own.
  A name filter or the hidden-folders toggle makes its own list, so clearing
  the filter returns to the full folder's offset.
- Batch selections survive folder navigation and take precedence over creating
  the directory typed in the filter. Space toggles selection only while browsing;
  during path entry it remains a literal space.
- An existing clone destination is a parent directory; a nonexistent destination
  is the checkout itself. Cloning never overwrites an existing folder.
- Repository identity proposals describe existing configuration. Adding a project
  changes its author or account binding only after an explicit identity choice.
  System Git writes no author override. A local-only repository can still receive
  a signature, and a failed identity write does not undo adding the project.
- A managed remote grant covers fetch and push together. A transport is eligible
  only when both endpoints agree; endpoint host and SSH port come from the fetch
  address. An incompatible identity remains visible with its reason and is never
  proposed or used for a clone. A host change resets the proposal, while a user
  choice for the same host stays selected.
- VS Code adds workspace folders through its host and offers no clone or OpenCode
  import entry. Mobile sheets keep the shared overlay width and avoid autofocus
  that would cover the folder list with the keyboard.
- Forks inside an isolated space stay there because a host worktree contains none
  of the space's changes. Goal and review loops require the OpenChamber server,
  so VS Code only displays their state.
- Dialog defaults reset on opening. Background configuration refreshes and goal
  toggles preserve user-edited instructions; closing retains fields through the
  exit animation.
- New-worktree source selection waits for fetched branches. Persisted branch
  seeds contain only local branches and can incorrectly select local `main` when
  the bound remote's default branch should win.
- The "Based on" picker lists each remote's detected default branch first while
  nothing is typed, the bound remote's first, and only when that branch is in the
  fetched list. A typed query ranks them with every other branch. The
  existing-branch picker lists no defaults: it checks out a branch, not a base.
- A stacked branch starts from its named parent, fetching the remote copy when
  needed. Failure to find it never substitutes the project root's current branch.
- Worktree folder names remain ASCII and keep their initial random name when a
  branch produces an empty slug. User-renamed folders stop following the branch.
- A worktree created for an issue or change request opens its draft before loading
  the item's context. The resulting chip targets that draft only. Change-request
  fetches use the chosen repository account and verify the selected revision;
  contributor setup commands require consent after checkout.
- Scheduled-task eligibility comes from the scheduler's membership rule. Failed
  eligibility reads remain errors because an empty picker would claim the project
  has no sessions. Request identity depends on session directories and IDs, so
  streaming record updates do not restart eligibility reads.
- The target picker's candidates take the global session cache as authority; a
  live directory copy only adds a session the cache holds neither as active nor
  as archived, through the stores' own gap-fill helper
  (`addUnlistedLiveSessions` in `stores/globalSessions.ts`). Until the cache's first
  full load is done (`hasLoaded`) and an eligibility read started after it has
  answered, the picker reads as loading, even when live sessions are already
  checked, so a partial list never looks complete. Candidates that no read has
  started for yet also read as loading; only an empty candidate set is an empty
  project. A later refresh keeps the shown list (`useScheduledTaskTargets`).
- The target picker lists root sessions while its search is empty and subagents
  only through a search, each named as its parent's subagent. Review sessions
  count as roots and `ownWork` workers never appear. A query equal to a whole
  session id finds that session; anything else, `ses_`-prefixed text included,
  searches titles. The saved target shows first on the empty list, even when it
  is a subagent, ineligible or not loaded; a saved target that became an
  `ownWork` worker stays on the field but is not offered as a row. Ctrl+N/P in
  the search box moves the highlight by physical key, so it works on any
  keyboard layout.
- The selected scheduled-task scope is mirrored synchronously for async work.
  Only the newest request for the scope on screen can replace the list or finish
  its spinner. Task actions retain the scope of the displayed list, and an editor
  retains the task owner captured when it opened. A scope reorder changes neither.
- Moving a task writes its destination copy before deleting its source. A failed
  source deletion leaves 2 copies and reports them, preserving at least 1 task.
  After a mutation, refresh targets the scope currently on screen.
- A task's target session and base branch belong to its selected project and clear
  on a project change. Non-Git projects save in-directory runs; switching isolation
  off sends explicit choices so the stored task cannot retain isolation.
- Opening a scheduled run uses the session's own directory, including linked
  worktrees. A session missing from the global cache is fetched before routing,
  since a run can create it after that cache last loaded.
- Worktree removal reads current global and live sessions at each step, including
  subdirectories, and reads the current navigation state after slow teardown.
  Kept sessions move before removal; archived sessions are archived while the
  folder exists and restored if removal fails. Repeated quick-delete clicks share
  one pending operation, and a failed safety check opens the ordinary dialog.
- Todo sends start from the destination project's defaults, preserving an agent
  picked while defaults load. Sending waits for those defaults. A new worktree
  applies its own directory defaults to untouched choices; explicit model and
  effort choices survive, with dialog values as fallback when no model resolves.
- Side-panel tabs live under the main chat's directory and carry the opened
  session's own directory separately, so sessions from other projects resolve.
- Search drafts preserve typed spacing when the parent confirms the same trimmed
  query, so a debounce cannot erase the space before the next word.
- Activity counters subscribe in a leaf span so ticks do not rerender the row.
  A running turn with no authoritative start shows no guessed duration. Durations
  drop seconds after an hour to fit row metadata and localize complete unit text.
- AI rename checks eligibility only while its controls are open and requires the
  small model; unavailable configuration disables it with an explanation.

## Decisions

### Why the branch picker explicitly focuses its input

The picker requests autofocus because Chromium's focus scan can skip candidates
under its `display: contents` portal. Keyboard events reach cmdk before propagation
stops, so the enclosing menu's typeahead cannot consume branch navigation.

### Why the base picker lifts every remote's default

The comparison picker lifts only the bound remote's default because it rejects a
base on another remote. A new worktree can start from any remote branch, and work
in a fork often starts from upstream's default, so every remote's default is lifted.

### Why repository identity is one choice

An identity carries account, authentication transport and commit signature together.
One choice keeps the add and clone dialogs from assembling incompatible answers.

### Why repository hints stay in the footer

Discovering an existing repository changes the footer hint without moving folder
rows under the pointer. Phone identity controls retain a labelled line because
touch offers no tooltip to explain an icon alone.

### Why session menu hints ignore focus

Each hint waits for a resting pointer in its own tooltip group. Menus focus hovered
items, so focus-triggered hints would open immediately while scanning the menu.

### Why the target picker hides subagents until a search

A task may target a subagent session (#3340), so hiding subagents outright would
remove an accepted feature, and listing them all buried the root sessions under
hundreds of runs. The maintainer chose roots at rest with subagents one search
away. The list stops at 100 rows with a line asking for a sharper query, because
cmdk renders every row it navigates and a project can hold thousands of sessions.

### Why the switcher orders by recency

Pins ordered by creation can fill every switcher slot and hide recent conversations.
Opening shows the cached recency list and refreshes authoritative records; Mini Chat
reads only the newest page because it keeps no complete session list.
