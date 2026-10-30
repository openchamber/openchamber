# Reference picker

The picker for a project's issues, change requests and discussions (where the
host keeps them), on whichever
source-control provider hosts it, and each served tracker's work items
(Linear issues), used by the
composer (any number of items, attached together) and by New Worktree (one
item, which names the branch). The issues and PRs board
(`components/sourceBoard`) lists the same items on a full page and acts on
them; see *Board* below. Extensions are not inside it: they draw their
own search in an iframe and attach through `host.attach`, so the + menu lists
every source, the repository's provider, each tracker and each extension, as its own row.

## Files

| File | Owns |
| --- | --- |
| `useReferenceBrowser.ts` | The state both the picker and the board read: repository tab and filter, the provider's descriptor and term, search, highlight, the previewed item and its details, arrow and Ctrl+N/P keys. |
| `ReferenceBrowser.tsx` | The parts both lay out: tabs (repository source only, the change-request tab named by the provider's term), search filling the row with the filter as one menu beside it (32 px, like the tabs), the list with its loading, failure, empty and not-connected states. |
| `ReferencePickerDialog.tsx` | The picker around them: checked items, the diff switch, Enter/Shift+Enter, confirm. Desktop shows the list and a preview side by side; mobile opens the preview in place of the list. |
| `ReferencePickerRow.tsx`, `ReferencePreview.tsx` | What a row and the preview show. State colours are the theme's PR tokens through the sidebar's rule (`lib/source-control/prVisualState.ts`). |
| `useReferenceImagePreview.tsx` | Opening the preview's pictures in the chat's image viewer. |
| `referenceSources.ts` | Which read context and which read a list or preview comes from (by the provider's features), which cache, and its key. |
| `listBackedReferences.ts` | Pages, lookups and previews of a provider without a reference search, from the neutral list reads. |
| `acrossRepositories.ts` | Which folders a list across repositories asks, and which it leaves out and why. |
| `projectUploads.ts` | Attachments written as project paths, rewritten for display. |
| `referenceCache.ts` | Stale-while-revalidate lists and values. |
| `liveReferences.ts` | The followed live state laid over listed items and PR statuses. |
| `PullStackRows.tsx` | A PR's stack map in the preview. |
| `resolveComposerReferences.ts`, `useAttachReferences.ts` | Turning confirmed items into composer chips with their full context. |
| `referencePickerItems.ts` | Item union (`source: 'repository'`, or `source: 'tracker'` with its `provider`), sources (`'repository'` or `` `tracker:${id}` ``), keys, number labels, state looks, filters. |

## Providers

The repository source lists the project's issues and change requests on
whichever provider hosts it. What the UI does with a provider comes from its
descriptor (`lib/source-control/providers`, *Provider registry* in that
module's documentation), never from its id:

- The read context is the one whose provider comes first by registry `order`
  (`useRepositoryReadContext`); the host named while no account works, and the
  provider a project is remembered under, follow the same order
  (`useRepositoryHost`, `useRepositoryReferenceProvider`). Remotes are
  recognised on each provider's default instance
  (`defaultSourceControlIdentities` in `lib/source-control/identity.ts`) and on
  every connected account's instance.
- `features.referenceSearch`: pages come from `sourceControl.references`;
  without it they come from the provider-neutral `issuesList` /
  `changeRequestsList` (`listBackedReferences.ts`, page number as cursor, the
  same state and whose-items filter). There a number (`#12`, or with the
  kind's own prefix, `!12`) or a link the provider's URL patterns read as an
  item of this kind on this provider is read on its own, not searched for; a
  link to another provider's item is searched as text.
- `features.referenceDetail`: the preview's detail comes from `referenceDetail`;
  without it from `issueComments` / `changeRequestContext`.
- `features.listStatuses`: open PRs' checks are asked with the list
  (`changeRequestListStatuses`); without it they come only from the followed
  live state (*Live state of listed items*).
- `features.projectUploads`: attachments are rewritten (`projectUploads.ts`).
- Wording and marks: the change-request tab, search placeholder, picker title,
  board title and not-connected text are chosen by the descriptor's term
  (`pullRequest` or `mergeRequest`) with its label as `{provider}`; the dialog's
  mark is `ProviderIcon`; numbers read with the descriptor's prefixes
  (`referenceNumberLabel`: `#12`, `!12`).

Every `RepositoryReference` names its provider: the web adapter
(`packages/web/src/api/repository-references.ts`) stamps the items it reads
with the read context's provider, and list-backed items take it from the
neutral issue or change request. The neutral issue carries no close reason, so
a closed list-backed issue reads as done.

### Why the read context waits for the provider list on a first visit

Which read a list or preview takes depends on the provider's features, and a
cache key does not carry the read path. On the very first visit to a runtime
there is no remembered list, so until the server answers every provider would
read as the generic fallback with every feature off: a GitHub project would be
listed list-backed, cached, and kept after the real descriptor arrived.
`useRepositoryReadContext` therefore answers "still loading" while the registry
holds nothing and has not answered; a failed answer with nothing held (`error`)
reads providers through the fallback rather than waiting forever.

### Why item keys carry the kind on every provider

`referencePickerItemKey` is in memory only. Choosing the marker from the
descriptor (`sharedNumberSpace`) would have to thread descriptors into every
caller that keys a selection (New Worktree, attach), while marking every change
request `!` and every issue `#` keeps keys unique on any provider: where both
share one number space only one of them can exist.

## Discussions

A provider whose descriptor has `features.discussions` (GitHub) gets a third
repository tab, Discussions, in the picker, the board's switch and New
Worktree; elsewhere the tab is absent, and a remembered Discussions tab reads
as Issues (`useReferenceBrowser`) once the host is known; until the provider
list and the project's host are known it waits on Discussions instead of
listing issues and switching. Discussions come only from the provider's
own search (`referenceSearch`, `referenceDetail` with `kind: 'discussion'`);
the list-backed reads have none and refuse the kind.

- The list loads only while its tab is open: the background read that makes
  switching between issues and change requests instant leaves discussions out.
- Filters: open, unanswered (open questions in a category that takes
  answers), closed, all; anyone's or the user's own, remembered per kind like
  the others.
- State looks (`discussionStateLook`): open in the open colour, with a
  check while its answer is chosen; resolved in the merged colour; outdated
  and duplicate in the closed colour. Rows add the category (its emoji and
  name) and upvotes; the preview adds category, answer status, upvotes and a
  lock note.
- Comments are threads: each comment's replies sit under it, and on the board
  and in a Tracker tab each takes a reply (`threadActions`, `replyTo` the
  comment's id) and, in a category that takes answers, Mark or Unmark as
  answer where the host says this account may; the chosen one wears an
  Answer badge. The reply box at the bottom writes a comment of its own, and
  is left out of a locked discussion this account may not comment on. The
  state pill closes an open discussion as resolved, outdated or duplicate, or
  reopens a closed one, offered only while the detail does not say this
  account may not (`canChangeDiscussionState`); labels edit as one set.
- Attached, a discussion becomes a `repository-discussion` chip and context
  part: `Source control discussion context (JSON)` with the listed item (its
  description as the list cut it, `bodyTruncated` saying so), its newest
  comments with their replies and which one is the answer
  (`resolveComposerReferences.ts`). The session keeps it as an `external`
  link under its canonical address (`buildLinkedDiscussion`), the id an
  agent's link to it gets too, so every client keeps it and newer ones read
  it as a discussion: the sidebar and work status show it among the issues,
  coloured as an issue reads (resolved done, outdated and duplicate dropped).
- New Worktree starts from one the way it starts from an issue: a new branch,
  `discussion-<number>-<slug>`.

## Lists and the cache

- A list is cached per key `[runtime, account or tracker and its account, project, kind, filter, search text]`. Switching tabs or filters, or reopening the picker, shows the cached list at once; one older than 60 s refreshes in the background and is replaced when the answer lands. `revalidateReferences` makes every mounted list, preview and PR status check its age again.
- A failed first load is an `error` state with Retry. A failed refresh keeps the shown items and shows the error above them. Failure never becomes an empty list.
- Every first-page request bumps the key's generation; an answer or a later page from an older generation is dropped.
- Keys someone is subscribed to are never evicted; the 40-entry bound is a soft target.
- Searched pages come from `sourceControl.references`, `GET /api/source-control/<provider>/references` (server: `packages/web/server/lib/github/DOCUMENTATION.md` for GitHub); the preview's detail from `referenceDetail` and PR colours from `changeRequestListStatuses` go through the same provider prefix, read with the project's read context (`useRepositoryReadContext`): the account its binding names, or the current account of the host for a repository nobody bound. List and preview cache keys carry that account. Tracker lists use `trackers.list(provider, …)` with the filter's state, whose items (`me` or `created`) and priority, combined; picking in the filter menu keeps it open. The state menu is the descriptor's `stateFilters` in its order (Linear adds In Review and Duplicate), and people and priority appear only where the descriptor's `capabilities.filters` offers them; a filter the tracker does not offer reads as its default. The last filter is remembered per tracker for the app run.

- An open PR turns orange on failed checks or a conflict, as in the sidebar; checks still running keep the open colour. A page does not carry that (mergeability alone made a 30-PR page about three times slower), so once the list shows, `useRepositoryPullStatuses` asks `references/status` (where the provider has `features.listStatuses`) for the open PRs it lists, ten per request and all at once (a whole page in one query takes GitHub about ten seconds, at the edge of the request timeout), and the rows and the preview recolour when it lands. The preview's Checks line shows the same status as the row; until it arrives, the previewed PR's own detail carries its checks (GitHub's head-commit `statusCheckRollup`, summarized like the batch; GitLab's pipeline). On the board the totals open `SourceBoardChecksDialog`, which reads the PR's runs, steps and failed annotations through `useChangeRequestContextStore` (the PR panel's cache) when it opens, and again while runs are still going. `components/views/git/CheckRunList.tsx` draws the runs for both. Statuses are cached per PR and head commit. Until a status arrives, or when it fails, a PR reads as open.

## Live state of listed items

A list and the statuses asked for it are what the host said when they were
read. While a surface is on screen (the picker, the board while open, a
Tracker tab while shown), the open items its list shows are also followed
through the server's tracked items (`liveReferences.ts`, `lib/trackedItems`,
server `tracked-items`), the same live state behind the sidebar's badges: the
server reads them on a cadence (30 s while checks run), after an agent turn,
after a change made through the app and on the board's refresh, and pushes a
state only when it moved. A followed state answered after the list was read is
laid over the row: a PR's state, draft, title, head commit, checks and
mergeability, an issue's state and title, a tracker item's state (name and category) and title. A
GitLab merge request gets its pipeline colour this way, which no list status
carries.

- Followed items are read with the account the list was read with
  (`accountId` of the read context), so the same PR on the sidebar and the
  board is one item on the server.
- Each page of a list, and each PR status, counts as read 30 s before it
  arrived, the age of the server's own short-lived answers
  (`provider-read-cache`), so a followed state from just before it still wins
  and an older one never does. A read forced after a change or a refresh
  (`ReadStamp.forced`: a retry, the read after a write) is answered anew and
  counts from when it arrived, so a change the user just made is never
  replaced by the state from before it.
- At most the first 50 open items of a list are followed (the server reads
  GitHub PRs 25 to a query, sequentially); the client sends
  at most 300 items in all, the server's limit, the surfaces declared first in
  full. The list on screen is followed, never the other tab loaded in the
  background or a board kept mounted while closed.
- What joins or leaves a list (a new PR, a PR merged out of an open filter)
  still waits for the list to be read again: on open, on window return and
  after an agent turn finishes, for lists read more than 60 s ago.

### Why followed items and not reading lists again on a timer

A list that stays on screen used to show what it read until the window lost
and regained focus, so a PR whose checks finished meanwhile stayed orange. A
client timer would read whole pages (GitHub search, ten-PR status batches) and
send them over a relay that is paid per byte even when nothing changed. The
server already follows the sidebar's items on a state-based cadence and pushes
only changes, so listed items join that set; the sidebar, the board and the
Tracker then show one state for the same PR.

## Preview and attach

- Desktop previews pin the item header above its divider and the action footer below the scroll region. The metadata grid, description and comments scroll together for repository and tracker items, a divider below the grid as on mobile. Mobile keeps the whole preview in one flow.
- The preview shows the list item at once and asks for the rest of the item the highlight rests on (250 ms after it stops moving): GitHub comments, and a PR's size, review and newest commits, from `references/detail` with the same read context (a GitLab merge request's pipeline, commits and verdicts come with its detail, read with `includeTimeline`); a tracker item's description and comments from `trackers.get(provider, id)`. Both land in value caches: going back to an item shows what was already read at once, without waiting out the 250 ms, and attaching a previewed tracker item reuses the answer.
- A PR's thread is its activity (`referenceTimeline.ts`): comments, review verdicts and commits by time, commits in a row grouped, so a review reads next to the commits it answered. Comments made at the same moment as a commit come first. Each commit names its author: the host account with its avatar on GitHub, the name git recorded on GitLab.
- Descriptions and comments render with `allowRawHtml`, sharing the Files preview's Streamdown processing and restricted rehype policy in `chat/markdown/streamdownPlugins.ts`. GitHub screenshots, tables and disclosures show; scripts, author styles and application classes are excluded. Media components preserve safe image dimensions and aspect ratios. Tracker items and the Git view's PR section use this same renderer.
- Inside a preview, `#12`, `owner/repo#12` (`!12` where change requests have their own prefix), `@someone` and commit ids link the way the item's host links them (`referenceLinks.ts` provides the item's repository to every body; `chat/markdown/remarkRepositoryReferences.ts` builds the links from the descriptor's URL patterns). Code, existing links, words and paths stay text, and a run of hex counts as a commit only with a digit and a letter in it. A provider without `urls.commit` or `urls.user` gets no links for those. The links open like any link in item text: an issue or change request in the Tracker, a commit in the Diff view when the folder the item was read through has it (`useOpenChatLink`), else on the host. Only the desktop app looks for the commit first: knowing whether the repository has it takes a git read, and a browser opens a new tab only right inside the click, so on the web a missing commit would open nowhere. The SHAs of a PR's commit rows open the same way.
- Emoji shortcodes (`:tada:`) in item text read as emoji, the way the host shows them; hosts send the shortcode as written. The names are GitHub's (`gemoji`), loaded from `lib/emoji/shortcodes.ts` only once a body holds something shaped like a shortcode, so a preview without one never loads the table. Code keeps its shortcodes, and an unknown name stays text. Chat does not convert them: agents write the emoji themselves.
- Descriptions and comments opt into `singleTilde` strikethrough, preserving GFM's `~text~` rendering on GitHub. Chat requires `~~text~~` so prose ranges remain literal.
- Where issues and change requests share one number, `#12` links the issue page, which the host forwards to a change request. The Tracker reads such a link as an issue first and, when no issue has that number, as a change request (`TrackerItemView`).
- A review comment's ```` ```suggestion ```` fence (GitLab's `suggestion:-0+2` too) draws as a suggested change: a diff of the lines the comment sits on against the suggestion. Those lines come with the comment as `excerpt` where the host sends them (GitHub, from the thread's diff hunk); without them the suggestion shows as added lines. Copying the block copies the suggested code.
- Clicking a picture in the description or a comment opens the chat's image viewer (`useReferenceImagePreview.tsx`) with every loaded picture of the item, in page order, so the arrows step through them; a picture inside a link keeps opening its link. Escape closes the viewer alone, never the picker dialog under it. The viewer's chunk loads on the first click, and nothing runs while it is closed.
- `chat/markdown/MarkdownMedia.tsx` owns video nodes: a Linear upload written as a video-named image, a GitHub `user-attachments/assets` URL alone on its line, or a safe raw `<video>`. Linked pictures retain their link behavior. Controls and load/error recovery belong to the video component; the Markdown body has no container-wide video fallback listener. Original source metadata stays separate from authenticated playback URLs.
- A provider with `features.projectUploads` (GitLab) writes an attachment as a project path, `/uploads/<secret>/<name>`, readable only by signed-in members. `projectUploads.ts` rewrites those paths in the displayed description and notes, outside code: a picture or clip to `GET /api/source-control/<provider>/uploads/:secret/:filename` with the preview's read context and the URL token, kept fresh while such an item is shown; a link to any other file to the file on the host. The text attached for the agent keeps the host's path. That is why `ReferencePreview` takes the item's `directory`.
- Attaching reads the full context the agent receives through the provider-neutral source-control reads (`issueGet` + `issueComments`, `changeRequestContext`) with the same read context: issue with all comments, PR context with the diff only when "Also send the diff" is checked for that PR, tracker item with comments. Chips and context parts use the provider-neutral kinds `repository-issue`, `change-request` (with its provider) and `tracker-item` (with its tracker). A tracker item's agent text is `lib/trackers/itemContext.ts`: `<Tracker name> issue context (JSON)` then `{ item, comments }` in the neutral tracker shape, the same for every tracker. Each item resolves on its own; the ones that fail stay checked in the picker with the reason, the rest attach.
- Children (Linear sub-issues), where the tracker's `children` capability says so: a child's row names its parent above the title, a parent's row shows how many children are finished (`2/5`, or `20+` when the list counted only the first 20). The preview has a Parent row and, once the detail lands, a Sub-issues section. Clicking either previews that item through `openItem`, kept like a pinned item while the list does not hold it; the picker and the board both pass `onOpenTrackerItem`. A parent or child comes without labels, so the preview takes labels and parent from its detail when it has one. Labels and priority likewise show only where the `labels` and `priority` capabilities say so. The agent gets the parent and children with the item's JSON.
- The composer keeps attached items as a list (`chat/composer/composerReferences.ts`). The same item attached again replaces its chip in place.

## Changes on review hosts

Where the provider keeps revisions (`features.revisions`) and a change has
more than one, the Changes row starts with a revision picker, on the latest by
default; picking another reads that revision's files and diff with
`revision` (`useRepositoryReferenceDetail`, cached under its own key), while
the latest detail keeps naming the revisions, the votes and the submit
requirements. The Changes and Walkthrough links beside the counts
(`SourceBoardPullLinks`) take the picked revision into their source
(`{ kind: 'pr', …, revision }`), so the comparison, its file reads and the
walkthrough show the same revision as the counts; the comparison picker and the
walkthrough label name it by its short SHA. A change's private and topic flags show under its title, and
work in progress too unless the state pill already says Draft. Where heads are revisions rather than branches
(`features.branchHeads: false`) the branch row shows only the target branch.

On the board a votes host's reply votes on the labels the change names
(`SourceBoardVotes`) and only on the latest revision, the one the latest
detail names rather than the listed head; submit waits for the change's
requirements and names the unmet ones beside the disabled button
(`sourceBoard/mergeChoice.ts`). It also holds while the change's status says
it is not mergeable, and says so; when the latest detail could not be read it
says the requirements could not be read rather than staying silently disabled.
Submitting a change also submits every open change below it in its relation
chain (`status.stack`/`pull.stack`, the layers before it whose state is open),
so when there are any the line beside Submit says how many, and the
confirmation's title and message do too (`landsWithIt` in `mergeChoice.ts`).

## Stacked pull requests

A PR that is a layer of a stack (GitHub's own, or on GitLab a chain of merge
requests by branch) shows a Stack section in its preview, under the details
and above the description, read with its detail (`pull.stack`). It is a
section of its own, like a tracker item's children, because a list of
layers does not fit the one-line label and value rows. Its heading names the
layer's place (`3 of 3`, counted from the bottom); then the layers top first, each one line with its state, number and
title, the previewed one marked in its live colour, and the branch the stack
lands on last. Another layer opens where the surface opens items: on the board
in the board's own preview (read on its own, like a link), in the Tracker as a
tab of its own. A GitHub stack with more than one open layer links to its page
for Rebase stack, which GitHub's API does not offer, from the heading's end.

- Merge on a stacked PR says which open layers below it merge with it, and
  the toast says how many did. A merge GitHub queues or is still running says
  so; the live state shows when it lands.
- New branch on top (the board's attach menu, the Git view's branch PR) opens
  New Worktree on a new branch starting from the PR's branch, its local copy
  when there is one. The server records that branch as the new one's parent,
  so its comparisons and its PR target it, and GitHub stacks the new PR on it
  when it is created. Offered for open PRs whose branch is in their own
  repository; a fork's branch cannot be stacked on.

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
sidebar header (desktop and web, and the phone shell's menu; not VS Code). A
git project's menu in the sidebar opens it on that project's repository. It
uses `useReferenceBrowser` and the shared parts without checkboxes; the
preview's footer holds actions instead of what the agent gets.

- The board keeps its own project, tab and, per tracker, container (Linear team) per runtime
  (`stores/useSourceBoardStore.ts`). Switching them never changes the app's
  selected project. A tracker's tab is `tracker:<id>`; the `linear` tab and
  `linearTeamId` stored before trackers read as `tracker:linear` and Linear's
  container.
- On desktop and web the board stays mounted once opened and is only hidden
  (`invisible`, `inert`) while closed, so it reopens where it was left,
  whichever way it was opened (its button, a link): the previewed item, the
  search, both scroll positions, a reply draft. A reopen puts focus back in
  the search. A new project or tab still starts a fresh list. The phone's
  board page is not kept. It draws its own header: the close button and the
  scope picker share one row, then the switch, then the search with the
  filter beside it; an open item puts a back button and its number in that
  header instead.
- What the board shows stays current through `sourceBoard/useBoardRevalidation.ts`
  and the followed live state (*Live state of listed items*). While the board
  is on screen, lists, the preview and PR statuses read more than 60 s ago are
  read again when it opens, when the window gets focus back and when an agent
  turn finishes.
- The repository tab is the project's host only, the provider
  `useRepositoryHostProvider` names. A tracker gets a tab only while an account
  is signed in (`useTrackerSources`), named by the descriptor's product name; a
  served tracker nobody signed in to is connected from Settings, which lists
  every served one. A project with no remote on a known host shows its
  connected trackers alone, or the no-source note with the project pickers
  when none is connected: an unconnected tracker tab lists nothing, and the
  board remembers its project, so such a tab would leave nothing leading back.
  `resolveBoardTab` (`sourceBoard/boardRepository.ts`) decides. Until the
  folder says whether it holds a repository and until every served tracker's
  status first arrives (`useTrackerSourcesPending`), the board shows a loading
  state instead of guessing. A failed status read is not a disconnect: it ends
  the wait, and the tracker keeps its tab if it was signed in before.
- On a tracker the scope picker is the container picker
  (`SourceBoardContainerPicker`). When the project offers no repository tab,
  the project and repository pickers stay beside it: they are the only way
  off the tracker for that project.
- The board reads one folder, `useBoardRepository` (`sourceBoard/boardRepository.ts`):
  the project's root when it is a git repository, unless a repository under it
  was picked. When the root is not one but repositories lie under it, the board
  reads one of them, or all of them together. A second picker beside the project
  picker (`SourceBoardRepositoryPicker`, a bottom sheet on the phone) chooses;
  it appears only when there is something to switch to (`choosable`), so an
  established root with nothing below it keeps its own row alone.
  Discovery is the Git store's (`ensureNestedRepos`), read only: the board never
  calls `selectNestedRepo` for browsing, so its choice is independent of the Git
  screen's. The choice is per project id in the persisted board choice:
  `repositoryByProject` (the single repository) and `allRepositoriesByProject`
  (whether all are listed; absent means all, unless a single repository was
  remembered before this existed). Updates merge into both maps, older data
  reads as empty. A remembered repository that is no longer discovered falls
  back to the first, which under an established root is the root itself. While
  the root is probed and the folder searched, a root without a remote shows a
  loading state instead of the no-remote one; a failed
  search shows an error with Retry and is never read as "no repositories"; a
  runtime without discovery (`'unsupported'`) stays at the root.
- **All repositories** is the picker's first entry and the default for such a
  folder, offered only where `sourceControl.referencesAcross` exists and the
  root is no repository (`allAvailable`): an established root lists itself, and
  "all" of its repositories would only be the same one beside itself. A
  runtime without the route lists the first repository. Every runtime that
  mounts the board has it; VS Code has no board. The list, its search
  (including a pasted link or `#number`, which the server resolves) and paging
  come from one `referencesAcross` call per page
  (`useRepositoryAcrossReferenceList`) to one provider: the lowest-`order`
  provider among the folders' read contexts that has
  `features.referencesAcross`, with the contexts of the folders on it,
  gathered by `useRepositoryReadContexts` (one hook over the folders' bindings,
  `useRepositoryBindings`, not a loop; `partitionAcrossContexts`). It waits
  until every folder's context is known; its cache key carries the set of
  contexts asked, so a change in it lists again. A folder on another provider
  (`unsupportedProvider`, named) or one with no readable context is not sent; one the answer skips (`no-repo`, `disconnected`,
  `invalid-context`, `error`) is reported with the page (`ListPage.skipped`),
  and a later page adds to that list rather than replacing it. When the answer
  read no folder at all, the list fails if any folder failed, and otherwise
  reads as disconnected or as having no repository: a failure never shows as an
  empty list. A
  quiet note above the rows (`SourceBoardAcrossNote`) counts the repositories
  left out of the list, and its menu names them with the reason. Rows name
  their repository (the upstream-chip pattern, shown on every row). Each item
  carries `directory`, the folder it was read through, and everything per item
  uses it: detail (`useRepositoryReferenceDetail`), the read context of merge, ready,
  close or reopen, labels, reviewers, reply and the checks dialog, and Changes
  and Walkthrough. Open PRs' checks are asked per folder, each group through its
  own context and in batches, and a group that fails leaves the others
  (`ensurePullStatuses`). The pure parts are in `references/acrossRepositories.ts`.
- A repository link opened on the board (`repositoryFocus`, the phone and a window
  with no folder on screen; desktop opens links in the Tracker) from a session
  in such a folder lists all repositories first (`choiceForFocus`, decided in the board
  because discovery lives there, so it waits for the probe and discovery and the
  pinned lookup never runs against a stale single repository), remembers that
  as the project's choice, and opens the item in its own repository. A root that
  is a repository has nothing to list across, so the item is read through the
  repository its link names instead (`useLinkRepository`, the folder rule the
  Tracker uses): a submodule's item opens from an established root's board, its
  labels, comments and Changes links belonging to that repository, while the
  list and the remembered choice stay as they were. A runtime without the
  search is unchanged.
  Link lookup waits for repository discovery and candidate bindings unless the
  root already matches the link. Failed discovery keeps the link with Retry;
  it never triggers the external-browser fallback. The home directory is never
  scanned, including on retry, and cached discoveries there are ignored.
  Repository focus stays in the store until the preview opens and discovery
  settles, so resolving a remembered child can remount the list without losing
  the request. A discovery failure on a repository root leaves its list usable
  and shows a separate Retry even when no link is pinned.
- With one repository chosen (or a folder that is one), lists, preview, labels,
  reviewers, reply, merge and the other writes use that repository's read
  context. New session and Attach keep the project's root. Changes and
  Walkthrough of a PR from a repository under a root that is not one open a
  tab with that repository as `targetDirectory`, the request keyed by it
  (`resolvePullLinkTarget`, for the item's `directory`), so the views read the
  PR there and the Git screen's nested selection never moves; a session
  already inside the repository reads it as its own. The phone's Changes takes
  the request under the normalized folder the app shows, with the repository
  beside it (`usePullRequestSelectionStore.changesRepositories`): it shows that
  repository in place of the Git selection until the next request for the
  folder or a repository picked in its picker. Worktree actions (check out a PR, start an issue in a worktree) are
  not offered for these items: creating one needs the project itself to be a
  repository.
- The toolbar is one row: the scope (a project picker with icons and search,
  like the draft composer's; on a tracker a container picker, its containers
  from the tracker's project mapping, with the account in the same menu when
  the tracker connects several, `SourceBoardContainerPicker`), one switch for
  Issues, Pull requests and each tracker, then the search and the filter. The
  preview's footer is one row: where a tracker item starts and a PR's merge or
  ready on the left, and one
  Attach to session menu on the right: the open session (when the chat shows
  one, not a draft; the board closes and its composer takes the chip), a new
  session, or a new session in a worktree.
- A tracker lists one container or all. An item starts in its container's
  mapped project (`resolveTrackerMappedProjectPath`), else the mapping's
  default, else the board's project; the user can pick another for that item.
  Where the tracker can change states (`stateUpdate`), its state pill in the
  preview opens the container's states (`SourceBoardTrackerStatus`), ordered
  by category (triage, backlog, todo, in progress, done, canceled), then
  position and name.
- An issue, PR or tracker item a session links to opens from the work-status
  panel, the sidebar's badges and their tooltips, and links in chat while
  `openTrackerLinksOnBoard` is on (`chat/useOpenChatLink.ts`), all through
  `sourceBoard/openTrackerItem.ts`. On desktop and web it opens as a tab of
  the Tracker beside the chat on screen, read through the session's project
  without the app moving there (`lib/surfaces/DOCUMENTATION.md`, Tracker): the
  board is a catalogue people go to, and nothing opens it for them. The phone,
  which has no side panel, and a window with no folder on screen open it on
  the board instead, selected. The board moves to the session's project and
  tab and previews the item, read on its own (`focusRepositoryItem` with its
  link, `focusTrackerItem` with its tracker and identifier, then the browser's
  `pinnedItem`) while the search stays empty and the list as it was; the pinned
  lookup reads the folder the link's repository names rather than the one the
  list reads. A link
  finds that one item whatever its state, on GitLab too, where a number or link
  is read rather than searched. The board takes from that answer only the item
  whose link names the same repository and number (links are read through the
  providers' URL patterns, `isSameRepositoryItemLink`; the kind is part of the
  comparison only where the provider numbers issues and change requests apart),
  never just the first row, and
  each request is shown once, so the item shown for the previous link never
  answers for a new one. One the host does not know opens in the
  browser, and a tracker identifier its tracker cannot read is searched for. The phone opens the found
  item's preview. Cmd or Ctrl-click, VS Code, a session outside any
  project, a tracker while disconnected and links the board does not list open in
  the browser. Sidebar chips hand over their project's root path, so a
  worktree session or group outside the root resolves before the live
  worktree map has loaded (`SessionGroupSection`, `SessionNodeItem`). A
  badge's `+N` does nothing; its tooltip lists the others.
- A PR's review threads read as the comment that opened them with the
  replies under it (`ReferenceCommentItem.thread`); a reply is not an entry of
  its own. A resolved thread folds to one line ("Resolved · N replies") and
  opens on click; resolving folds it, reopening unfolds it. On the board
  (`threadActions`, `sourceBoard/threadActions.ts`) a thread can be answered
  and resolved or reopened, as far as the host says this account may. A
  provider with `features.startThread` (GitLab) also starts a thread on a
  change request from the reply box; GitHub threads start only from a line in a
  review, so GitHub has no such button.
- The issue or PR preview, on the board and in a Tracker tab, the checked-out
  branch's own tab included, has a refresh button beside the host link
  (`onRefresh`). It reads the shown item alone
  again: the server forgets its short-lived answers about that item
  (`sourceControl.refreshProviderReads(context, { item })`,
  `POST <provider>/read-cache/refresh?scope=item`) and reads that item's
  followed state now; the app forgets that PR's listed checks; then the
  item's detail is read again. Other items, lists and followed state are left
  alone, so a change made on the host's own site shows without waiting out
  the cache and without a read of everything else. The branch's tab also asks
  the branch's PR status again, since it reads state, head and checks there.
- The board's list has a refresh button of its own after the filter. It reads
  what is listed again (`{ lists: true }`, `scope=lists`; a tracker's
  `trackers.refreshListReads(provider)`), with the checks of the listed PRs, so an item
  just opened on the host appears. VS Code has no board and answers the call
  as unsupported.
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
  PR to the diff view's PR scope, keyed by the folder the PR is read through), Walkthrough, Merge (one split button named
  after the remembered method, the arrow picks another; asks first) and Ready
  for review, and Close or Reopen for an issue or a PR that is not merged, in
  the menu of the preview's state pill (no confirmation: both are reversible). Changes and Walkthrough open
  in the panel beside the chat on screen and read the PR through the folder the
  app shows when it belongs to the project, else through the project's root,
  without the app moving there; only with no chat on screen does a draft of the
  project open first. The phone offers Changes only, in the project's draft when
  the app shows another: it closes the board and
  opens the workspace drawer's Git tab, whose PR mode takes the request
  (keyed by the normalized folder) the way the desktop diff view does.
- Labels and reviewers (`SourceBoardMetaEditors`, `SourceBoardChoicePicker`):
  the preview's Labels row (shown empty too) and an open PR's Reviewers row
  get a pencil that opens a searchable checklist, read when it opens. The new
  set is sent once, when the popup closes, so several clicks are one change;
  a PR's author is not offered as its reviewer unless the provider has
  `features.authorCanReview` (GitLab).
- Reply (`SourceBoardReply`, every repository item): below the activity a
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
- The Tracker's branch tab (`views/git/BranchPullRequestPreview.tsx`) shows the checked-out
  branch's open PR with this same preview: no new-session or worktree actions,
  since the branch is already here, except New branch on top, which starts the
  next layer of a stack in a worktree of its own. Its item tabs (`views/TrackerItemView.tsx`)
  show any issue, PR or tracker item the same way, also without them: starting
  work happens on the board and in New Worktree. `PullRequestSection` keeps the create form
  and the merged/closed state. The form is one row of branch → base (picked in
  place), the title (a one-commit branch is titled by that commit until edited),
  the description with Generate on it (its arrow adds notes only the generator
  reads), and a split Create button whose arrow picks a draft, remembered. The
  host makes the PR from what the remote has, so an unpublished or ahead branch
  is pushed first through the Git view's own publish path (`useBranchPush`) and
  the button says so. The PR comes from the branch status; on a provider with
  `features.referenceSearch` `#N` is also looked up for its labels and comment
  count, which the status does not carry.
