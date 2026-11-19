# Local Git coverage

Run the `git` zone:

```sh
OPENCODE_BINARY="/Applications/OpenChamber Canary.app/Contents/Resources/opencode-cli/opencode" bun run verify -- git
```

The feature map is `zones/git.json`. It selects the local Git controls and
`GitView.tsx`, which connects their actions. Existing `diff.hunk` scenarios
already cover hunk staging, unstaging and confirmed discard.

## Behavior inventory

This inventory comes from the source. The feature map names the 20 paths
actually exercised, and the limits below name the remaining setup requirements.

| Feature | Ordinary path | Ordinary failure or refusal |
| --- | --- | --- |
| Changed files | Read modified, new and deleted paths, open working or staged diffs, fold groups, browse compact directory trees | An outside edit can leave the mounted panel's status stale |
| Staging | Stage and unstage one file, a folder or all files | A failed request restores the unstaged row and allows retry |
| Discard | Confirm reverting one file, a folder or all files | Dismissal preserves work; failed or partial reverts must leave remaining work visible |
| Commit | Write a message, click Commit or use Cmd/Ctrl+Enter, commit only staged files | Empty messages and an empty index disable Commit; failed commits retain the message and index |
| Branches | Create a sanitized name, search and switch local branches, revisit recent branches | Empty names are refused; missing searches show no local branches; duplicate names fail |
| Dirty checkout | Commit and switch, or revert and switch | Dismissal keeps the branch and files; a failed commit/revert must not switch; push-after-commit has no remote here |
| History | Expand commits and files, view committed diffs, copy SHA, refresh, load older commits | Failed diffs offer retry; large diffs require Render anyway; binary and renamed files have explanatory states |
| Graph | Open graph, expand a commit, create a branch at it, confirm checkout/cherry-pick/revert/reset/merge/rebase | Cancel preserves the branch; dirty working trees and conflicting changes can refuse operations |
| Branch update | Select another local branch and merge or rebase, inspect progress | Dirty work opens stash-and-retry; conflicts offer abort, later resolution or preparation of a chat prompt |
| Stashes | Name and create a stash including untracked files, search, apply, pop or drop | Empty search/list states, disabled creation on a clean tree, failed writes and restoration conflicts |
| Publication | Press Publish | With no remote, a toast explains the missing destination and no chooser opens |
| Repository configuration | Open the identity/configuration controls | No connected account or granted remote is available |

The 20 scenarios prioritize staging, discard confirmations, commit boundaries,
dirty checkout, history recovery and stash restoration. They use the real UI
and Git repository. The `field` assertion reads a form field's current `value`;
`see` reads rendered text and `editor` reads only the chat composer.
Commit scenarios write a local fixture author to the scratch repository's
`.git/config`; the stand's first commit uses environment variables and leaves
no configured author for subsequent commits. They make commits on disposable
branches and return to `main`, so the unchanged reset can remove those branches.

## Coverage limits

- Successful fetch, pull, push, commit-and-sync, remote removal and contributor
  publication need a remote and granted access. The fixture has neither.
- Change requests, checks, stacks, review pushes, Change-Id repair, account
  failures and provider-specific terminology need a source-control provider.
- Successful generated commit subjects, highlights and conflict resolution
  need a model that follows those prompts. The fixed conversation fixture has
  no scripted response for them.
- Initializing a repository, unreadable/nested-repository recovery, worktree
  rename and reintegration across worktrees need additional repository setup. No Git setup
  step exists, and the existing fixture is left unchanged.
- Stash Drop uses a native browser confirmation. The step vocabulary has no
  way to accept or dismiss that confirmation.
- Phone-specific commit focus and long-press revert are not
  exercised by these desktop scenarios. Electron and VS Code behavior needs
  their respective runtime.
- The inventory also includes local paths outside the selected 20 scenarios:
  folder discard, partial revert failures, duplicate branch names, recent-branch
  ordering, SHA copy, large/binary/renamed history diffs, history pagination,
  confirmed graph mutations, local merge/rebase and stash conflicts. These are
  reachable with further scenario setup; this zone does not claim to prove them.

## Findings on unchanged code

- After creating `net-commit`, writing `commit.txt` and `uncommitted.txt` on
  disk, waiting 1.5 seconds and immediately closing/reopening Git with its rail
  button, the panel still showed "Working tree clean". The stage button never
  appeared within 20 seconds. Evidence is
  `tmp/verify/2026-11-17T13-36-31/git.commit.selected/failure.png`.
  Reloading the page exposed the files in the next run. The scenarios use reload
  after outside writes; the product is unchanged.
- The stand cannot reset after a failed scenario leaves its newly created
  branch checked out: `resetWorktrees` tries deleting the current branch before
  checking out `main`. The same run ended with
  `cannot delete branch 'net-commit' used by worktree`.
  Successful branch scenarios explicitly return to `main`. This infrastructure
  limitation is left unchanged because fixtures and reset behavior are outside
  this task.

## Mutation proof

The unchanged product passed all 20 final scenarios three times consecutively:
`tmp/verify/2026-11-17T14-09-20/summary.json` records 60 passes and no failures.
Each mutation below then made its scenario fail. All product edits were
restored, and `git diff --exit-code -- packages` passed.
Review identified optimistic staging as insufficient proof, so file, folder,
bulk and retried staging now reload and check the authoritative Git status.
Additional no-op mutations proved that unchanged indexes fail those checks.

| Scenario, prefixed with `git.` | Temporary product break | Observed failure |
| --- | --- | --- |
| `changes.tree-folder` | Ignore directory expansion clicks in `ChangesPanel.tsx`; skip the real folder-stage call in `GitView.tsx` | Collapse left `first.txt` visible; a reload exposed the unchanged index |
| `changes.file` | Open a staged row as a working diff; skip the real unstage call in `GitView.tsx` | Staged added code was absent; after unstage and reload the file was still staged |
| `changes.all` | Ignore the group action in `ChangesPanel.tsx`; skip real bulk stage or unstage in `GitView.tsx` | The opposite action was absent after reload |
| `changes.revert-file` | Skip the confirmed file revert in `ChangesPanel.tsx` | Disk retained `'discard'` |
| `changes.revert-all` | Skip the confirmed bulk revert in `ChangesPanel.tsx` | Disk retained `'discard all'` |
| `changes.fold` | Ignore group collapse clicks in `ChangesPanel.tsx` | `fold.txt` remained visible |
| `changes.stage-error` | Suppress the stage-error toast; skip the retried stage call in `GitView.tsx` | The error notification was absent; a successful-looking retry remained unstaged after reload |
| `commit.required` | Remove message/index preconditions in `CommitSection.tsx` | Commit was enabled without them |
| `commit.selected` | Ignore the submit shortcut in `CommitInput.tsx` | The staged file never left the index |
| `commit.error` | Clear the draft in `GitView.tsx`'s commit catch | `field` read an empty message |
| `branches.create-switch` | Replace sanitized hyphens with underscores in `BranchSelector.tsx` | Header never showed `net-branch` |
| `branches.empty` | Enable empty-name creation in `BranchSelector.tsx` | Create was enabled |
| `branches.dirty-cancel` | Ignore dialog close requests in `DirtyBranchSwitchDialog.tsx` | Escape left the dialog open |
| `branches.dirty-revert` | Skip revert-and-switch in `DirtyBranchSwitchDialog.tsx` | Header stayed on the source branch |
| `branches.dirty-commit` | Skip commit-and-switch in `DirtyBranchSwitchDialog.tsx` | Header stayed on the source branch |
| `history.graph-cancel` | Ignore Cancel in `HistoryCommitRow.tsx` | Confirm remained visible |
| `history.diff` | Skip closing a cached diff in `HistoryCommitRow.tsx` | Added lines remained visible |
| `history.retry` | Ignore the error row's retry in `HistoryCommitRow.tsx` | Committed code never appeared |
| `stash.roundtrip` | Skip Apply in `StashesDialog.tsx` | `stash.txt` was not restored |
| `publish.no-remote` | Report cancellation for a missing remote in `useGitPublishChooser.ts` | The missing-remote explanation was absent |

Red-run artifacts are under `tmp/verify/`, at these timestamps:

- Changes: `2026-11-17T13-48-37`.
- Commit validation and failed draft: `2026-11-17T13-52-18`; commit shortcut:
  `2026-11-17T13-53-58`.
- Branch creation, empty name, dismissal, revert and commit:
  `2026-11-17T13-55-15`, `2026-11-17T13-56-30`,
  `2026-11-17T13-57-48`, `2026-11-17T13-59-10`,
  `2026-11-17T14-00-31`.
- History: `2026-11-17T14-01-55`.
- Stash and publication: `2026-11-17T14-04-03`.
- Strengthened file/folder/bulk/retry scenarios: `2026-11-17T14-15-49`;
  real unstaging skipped: `2026-11-17T14-18-25`; real retry skipped:
  `2026-11-17T14-20-21`.
