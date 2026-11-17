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

### Why a measured wrapper and not canvas intrinsic sizing

The history graph measures a plain wrapper and absolutely insets its canvas.
A canvas in flex flow contributes its default 150px intrinsic height and changes
the commit row's height. Reused parent lanes keep their vertical passing segment
through merge rows because dropping it breaks continuity between commits.

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
