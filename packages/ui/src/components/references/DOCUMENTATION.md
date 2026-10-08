# Reference picker

The picker for GitHub issues and pull requests and Linear issues, used by the
composer (any number of items, attached together) and by New Worktree (one
item, which names the branch). The issues and PRs board
(`components/sourceBoard`) lists the same items on a full page and acts on
them; see *Board* below. Extensions are not inside it: they draw their
own search in an iframe and attach through `host.attach`, so the + menu lists
every source, GitHub, Linear and each extension, as its own row.

## Files

| File | Owns |
| --- | --- |
| `useReferenceBrowser.ts` | The state both the picker and the board read: GitHub tab and filter, search, highlight, the previewed item and its details, arrow and Ctrl+N/P keys. |
| `ReferenceBrowser.tsx` | The parts both lay out: tabs (GitHub only), search filling the row with the filter as one menu beside it (32 px, like the tabs), the list with its loading, failure, empty and not-connected states. |
| `ReferencePickerDialog.tsx` | The picker around them: checked items, the diff switch, Enter/Shift+Enter, confirm. Desktop shows the list and a preview side by side; mobile opens the preview in place of the list. |
| `ReferencePickerRow.tsx`, `ReferencePreview.tsx` | What a row and the preview show. State colours are the theme's PR tokens through the sidebar's rule (`lib/source-control/prVisualState.ts`). |
| `referenceSources.ts` | Which cache a list or a Linear preview comes from, and its key. |
| `referenceCache.ts` | Stale-while-revalidate lists and values. |
| `resolveComposerReferences.ts`, `useAttachReferences.ts` | Turning confirmed items into composer chips with their full context. |
| `referencePickerItems.ts` | Item union, keys, state looks, filters. |

## GitLab projects

The GitHub source is the project's repository source. When the project's read
context is GitLab's (`useGitHubReadContext` prefers GitHub, then GitLab), the
same tabs list its issues and merge requests (`gitlabReferences.ts`): pages
come from the provider-neutral `issuesList` / `changeRequestsList` (the same
state and whose-items filter as GitHub, page number as cursor), the preview from `issueComments` /
`changeRequestContext`, and items carry `provider: 'gitlab'` so rows read `!N`
for a merge request. GitLab gives no close reason, so a closed issue reads as
done. The + menu, the picker title and New Worktree name GitLab for such a
project.

## Lists and the cache

- A list is cached per key `[runtime, account or Linear workspace, project, kind, filter, search text]`. Switching tabs or filters, or reopening the picker, shows the cached list at once; one older than 60 s refreshes in the background and is replaced when the answer lands.
- A failed first load is an `error` state with Retry. A failed refresh keeps the shown items and shows the error above them. Failure never becomes an empty list.
- Every first-page request bumps the key's generation; an answer or a later page from an older generation is dropped.
- Keys someone is subscribed to are never evicted; the 40-entry bound is a soft target.
- GitHub pages come from `GET /api/source-control/github/references` (server: `packages/web/server/lib/github/DOCUMENTATION.md`), read with the project's GitHub read context (`useGitHubReadContext`): the account its binding names, or the current github.com account for a repository nobody bound. List and preview cache keys carry that account. Linear lists use `linear.issuesList` with the filter's status, whose issues (`assignee=me` or `created`) and priority, combined; picking in the filter menu keeps it open.

- An open PR turns orange on failed checks or a conflict, as in the sidebar. A page does not carry that (mergeability alone made a 30-PR page about three times slower), so once the list shows, `useGitHubPullStatuses` asks `references/status` for the open PRs it lists, ten per request and all at once (a whole page in one query takes GitHub about ten seconds, at the edge of the request timeout), and the rows and the preview recolour when it lands. The preview's Checks line does not wait for that batch: the previewed PR's own detail carries its checks (GitHub's head-commit `statusCheckRollup`, summarized like the batch; GitLab's pipeline). On the board the totals open `SourceBoardChecksDialog`, which reads the PR's runs, steps and failed annotations through `useChangeRequestContextStore` (the PR panel's cache) when it opens, and again while runs are still going. `components/views/git/CheckRunList.tsx` draws the runs for both. Statuses are cached per PR and head commit. Until a status arrives, or when it fails, a PR reads as open. GitLab projects ask nothing and keep their state colour.

## Preview and attach

- The preview shows the list item at once and asks for the rest of the item the highlight rests on (250 ms after it stops moving): GitHub comments, and a PR's size, review and newest commits, from `references/detail` with the same read context (a GitLab merge request's pipeline, commits and verdicts come with its detail, read with `includeTimeline`); a Linear issue's description and comments from `linear.issueGet`. Both land in value caches: going back to an item shows what was already read at once, without waiting out the 250 ms, and attaching a previewed Linear issue reuses the answer.
- A PR's thread is its activity (`referenceTimeline.ts`): comments, review verdicts and commits by time, commits in a row grouped, so a review reads next to the commits it answered. Comments made at the same moment as a commit come first. Each commit names its author: the host account with its avatar on GitHub, the name git recorded on GitLab.
- Descriptions and comments render with `allowRawHtml`, the Files preview's allowlist: GitHub's `<img>` screenshots, tables and `<details>` show, scripts, styles and author classes are dropped. An image with both `width` and `height` scales by its ratio. The Linear panel and the Git view's PR section render GitHub and Linear text the same way.
- Attaching reads the full context the agent receives through the provider-neutral source-control reads (`issueGet` + `issueComments`, `changeRequestContext`) with the same read context: issue with all comments, PR context with the diff only when "Also send the diff" is checked for that PR, Linear issue with comments. Chips and context parts use the provider-neutral kinds `repository-issue` and `change-request` (with its provider). Each item resolves on its own; the ones that fail stay checked in the picker with the reason, the rest attach.
- Linear sub-issues: a sub-issue's row names its parent above the title, a parent's row shows how many sub-issues are finished (`2/5`, or `20+` when the list counted only the first 20). The preview has a Parent row and, once the detail lands, a Sub-issues section. Clicking either previews that issue through `openItem`, kept like a pinned item while the list does not hold it; the picker and the board both pass `onOpenLinearIssue`. A parent or sub-issue comes without labels, so the preview takes labels and parent from its detail when it has one. The agent gets the parent and sub-issues with the issue's JSON.
- The composer keeps attached items as a list (`chat/composer/composerReferences.ts`). The same item attached again replaces its chip in place.

## Keyboard

Arrows and Ctrl+N/P move the highlight from the search field. Enter attaches the
checked items, or the highlighted one when nothing is checked; Shift+Enter
checks the highlighted item. Double-click attaches a row.

## Runtimes

Web, desktop and hosted mobile use it as above; Capacitor mobile gets the
in-place preview layout. VS Code never opens it: the composer offers only files
there.

## Board

`components/sourceBoard` is a full page over the chat area, opened from the
sidebar header (desktop and web, and the phone shell's menu; not VS Code). It
uses `useReferenceBrowser` and the shared parts without checkboxes; the
preview's footer holds actions instead of what the agent gets.

- The board keeps its own project, tab and Linear team per runtime
  (`stores/useSourceBoardStore.ts`). Switching them never changes the app's
  selected project.
- The repository tab is the project's host only: GitHub or GitLab, whichever
  `useRepositoryHostProvider` names; a project with no supported remote shows
  Linear alone.
- The toolbar is one row: the scope (a project picker with icons and search,
  like the draft composer's; a team picker on Linear, with the workspace in the
  same menu when there is more than one), one switch for Issues, Pull requests
  and Linear, then the search and the filter. The preview's footer is one row:
  where a Linear issue starts and a PR's merge or ready on the left, and one
  Attach to session menu on the right: the open session (when the chat shows
  one, not a draft; the board closes and its composer takes the chip), a new
  session, or a new session in a worktree.
- Linear lists one team or all. An issue starts in its team's mapped project
  (`resolveLinearMappedProjectPath`), else the mapping's default, else the
  board's project; the user can pick another for that issue. Its state pill
  in the preview opens the team's states (`SourceBoardLinearStatus`).
- An issue, PR or Linear issue a session links to opens on the board, selected:
  from the work-status panel and from the sidebar's badges and their tooltips
  (`sourceBoard/openOnBoard.ts`). The board moves to the session's project and
  tab and previews the item, read on its own (`focusRepositoryItem` with its
  link, `focusLinearIssue` with its identifier, then the browser's
  `pinnedItem`) while the search stays empty and the list as it was. A link
  finds that one item whatever its state, on GitLab too, where a number or link
  is read rather than searched; one the host does not know opens in the
  browser, and a Linear identifier Linear cannot read is searched for. The phone opens the found
  item's preview. Cmd or Ctrl-click, VS Code, a session outside any
  project, Linear while disconnected and links the board does not list open in
  the browser. A badge's `+N` does nothing; its tooltip lists the others.
- The side panel and its rail stay beside the board. A board under 960 px
  wide shows the kinds by icon and drops the list column: a trigger left of the search names the previewed
  item (`#12`, `!12`, `ENG-7`) and opens the list as a dropdown over the
  preview; typing in the search opens it too, and picking a row, Enter or
  Escape closes it. The search then takes a row of its own.
- `toggle_source_board` (`mod+k b`) opens and closes the board; the command
  palette lists it too.
- Actions: start in a worktree (New Worktree opens with the item chosen,
  `initialSelection`), a new session in the project with the item attached,
  and for a PR its Changes (`usePullRequestSelectionStore.requestDiff` hands the
  PR to the diff view's PR scope), Walkthrough, Merge (one split button named
  after the remembered method, the arrow picks another; asks first) and Ready
  for review, and Close or Reopen for an issue or a PR that is not merged, in
  the menu of the preview's state pill (no confirmation: both are reversible). Changes and Walkthrough open
  in the folder the app shows when it belongs to the project, else in a new
  draft of the project.
- Labels and reviewers (`SourceBoardMetaEditors`, `SourceBoardChoicePicker`):
  the preview's Labels row (shown empty too) and an open PR's Reviewers row
  get a pencil that opens a searchable checklist, read when it opens. The new
  set is sent once, when the popup closes, so several clicks are one change;
  a GitHub PR's author is not offered as its reviewer.
- Reply (`SourceBoardReply`, GitHub and GitLab items): below the activity a
  comment box; on an open PR also Approve and Request changes (needs text),
  for the head commit the preview shows. The box is keyed by the item, so a
  draft never moves to another one, and keeps its text until the host has it.
  After a write, and after a refused review (usually a push since the
  preview was read), the item's detail is read again (`ensure(..., { force })`
  after any read already running) and the list refreshes.
- Attach (`sourceBoard/pullAttachments.ts`): a comment (on hover), all the
  comments shown (from the Activity heading) and, in the checks dialog, the
  failed runs with their steps and annotations are pinned above the composer
  as inline drafts (`pr-comment`, `pr-check`), the way the PR panel always
  did. They go to the session in view or a new session's draft; with neither
  open, a toast says so.
- The PR panel (`views/git/BranchPullRequestPreview.tsx`) shows the checked-out
  branch's open PR with this same preview: no new-session or worktree actions,
  since the branch is already here. `PullRequestSection` keeps the create form
  and the merged/closed state. The form is one row of branch → base (picked in
  place), the title (a one-commit branch is titled by that commit until edited),
  the description with Generate on it (its arrow adds notes only the generator
  reads), and a split Create button whose arrow picks a draft, remembered. The
  host makes the PR from what the remote has, so an unpublished or ahead branch
  is pushed first through the Git view's own publish path (`useBranchPush`) and
  the button says so. The PR comes from the branch status; on GitHub
  `#N` is also looked up for its labels and comment count, which the status
  does not carry.

