# Retained context views

`ContextPanel` keeps file, diff and walkthrough views mounted to preserve
navigation, expanded sections and editor state. Its `visible` prop combines
the panel's open state with the selected tab. Hiding via CSS alone does not
pause React effects.

Tabs belong to the panel's directory, the project root. A view showing a
repository nested under a root that is not one (Git, Changes) still opens its
diff and file tabs under that root: a tab keyed by the nested repository is
stored where the panel never looks, and the click shows nothing.

A panel's content fades in and out with the toggle, but turns inert and
unclickable only when the closing animation ends, and an opening zone leaves
`inert` only when its animation ends too (`useOpenWhenSettled`): those
properties are inherited, so flipping them restyles the whole surface, and
with an accessibility client on adds it to the tree, in the frame the
animation needed to start. The file editor leaves `inert` at once instead, in
the commit that puts its DOM back; out of `inert` in place, it cost a 300 ms
frame (`isZoneExposed`). A surface that focuses itself on being shown waits
for its zone to turn interactive (`useZoneInteractive`), since focus inside an
inert card is lost. Closing, the file editor's view counts as hidden from the
moment the animation ends (`useOpenUntilSettled`); opening shows it at once.
While hidden the docked
`CodeMirrorEditor` is `detached`: its DOM is out of the document, its state
and scroll position kept, and it comes back on show. Hiding the editor in
place instead (`aria-hidden`, `inert`, `display: none`, `content-visibility`)
costs Chrome a 200 to 300 ms frame whenever an accessibility client is on,
on every panel close and every switch away from the file surface; both must
happen in one commit, so the editor is never hidden while attached.
`CodeMirrorEditor` reconfigures only the compartments whose input changed,
so `FilesView` keeps its line-number config's identity across renders.

File tree ownership and request rules are in `files/DOCUMENTATION.md`.
`DiffView` gates repository discovery, comparisons, per-file reads, viewport
measurement and keyboard navigation on visibility. Hidden refresh hints retain
only dirty paths scoped to runtime and directory; reopening invalidates those
paths and requests fresh status. Completed range diffs remain cached while
pending reservations are cancelled and retried on resume. Hidden tabs never
consume another tab's pending navigation request. A collapsed file entry is
passed `visible: false` whatever the view's state, and its callbacks keep their
identity, so showing or hiding the view re-renders only the expanded entries
(every entry of a 150-file change re-rendered on each panel open before).

A Changes tab opened without a scope (the context rail, multirun) stores
`diffScope: null`, and `DiffView` opens it on Branch whenever the Branch scope
is offered, else on the working tree. The Branch scope is offered whenever the
checked-out branch has a comparison base (chosen, the open pull request's, the
one it was created from, or the default branch; never the branch itself), so a
repository without a remote gets it from the reflog and the default branch
does not get it at all. The default follows the branch until the person picks a scope,
which is persisted on the tab; coercing a default Branch view back to the
working tree is not persisted either. Such a tab starts on Branch and shows
the base being resolved until the base is known; it moves to the working tree
only once the branch is known to have no base, so the view never switches
under the person a moment after opening (it used to open on the working tree
and jump to Branch when the base arrived). The Git view and the pull request
view take the same base for a new pull request and for updates
(`useBranchPullRequestBase`): a base chosen for the branch, its open pull
request's target, or the parent it was made on (a lower layer of a stack),
and the worktree's own guess only when none of those answers. Changes, mobile Changes and
Walkthrough each ask for the branch's pull request themselves
(`hooks/useBranchPullRequestRequest.ts`) while shown: the base prefers its
target, and without asking a stacked branch checked out in the same worktree
compared against the default branch until the Git view or the sidebar happened
to ask. Entry points that name what they show keep
their scope: the work-status Changes row counts working-tree changes and opens
`working`, and a file opened from the Git panel or a tool card opens its own
working or staged diff.

A status read re-reads the Branch file list (one request). Each expanded file
re-reads its patch only when its own `revision` from that listing moved
(`branchPathRevisions` into `useRangeKeyedCache`), so an agent's read-only shell
command costs no patch reads, and an edit costs one for the edited file. A
listing without revisions falls back to the status revision for every file.
Desktop Changes and mobile Changes share this.

## Nested repositories

A folder inside the project that holds its own `.git` and is not a submodule
is one `dir/` row in the parent's status; its diff read answers
`nested_repository`. Its Changes entry then reads that repository's own status
and lists its changed files, each diff read from that repository when the row
opens, read-only: no stage, discard or hunk actions. "Open as project" adds the
folder as a project and opens a new session draft in it, where the Git panel
commits. The listing reads again when the entry's `contentRevision` moves.
Mobile Changes still shows only the note for such a row.

## Find in changes

Changes and the walkthrough search their whole changeset from one bar
(`diffFind/`). Cmd/Ctrl+F opens it through the `find_in_file` registration,
which declines while the surface is hidden, while another surface's text field
holds focus, and for a key pressed inside another element marked
`data-find-surface` (Files carries it too); Files, the Markdown preview and the
chat composer then keep the key. A Cmd/Ctrl-click on a word opens the bar on
that word and lands on the next occurrence after the clicked one, told apart by
side, since a deletion and an addition row can share a line number and offset.

`useDiffFind` owns the query, the matches and the reads; `useDiffFindSurface`
connects it to the viewers on screen. Each surface hands it a source per file
whose `load` reads what the viewer shows: the side (staged or unstaged), the
whitespace mode, a file's full contents once its collapsed context was
expanded, a pull request file rebuilt from both sides. A nested repository's row
resolves to that repository's files, read from that repository and keyed by the
row path plus their own path, the key their viewers register under. Reads run
one at a time while the bar is open, but on the local scopes the first one asks
`getGitDiffs` for every file of its side and context in one request
(`diffFind/findDiffBatch.ts`) and the reads after it are answered from that
answer while their revision holds; a failed batch, a path it leaves out, or a
runtime without `getGitDiffs` (VS Code) falls back to the file's own read. The
range and turn scopes already hold their diffs and read nothing new. While
files are still being read the total reads `12+`. The active match is followed by what it
points at, so a file landing or re-read ahead of it does not move the view. A read that fails is counted in the bar
and read again the next time the bar opens, so one unreadable file never turns
into a silent zero. A file Git no longer has, or a folder it keeps as one row,
has nothing to search.

Matches are painted as `<mark>` elements in the viewer's shadow root, tinted
from `--status-warning`. The library replaces rows when it renders, so the marks
are re-applied from `onPostRender` and from the shadow-root observer, and the
surgery drains its own mutation records so it never schedules itself. A jump
moves the line into view only once its row is rendered: a virtualized diff is
first moved to the line's estimated position, then the rendered row is centered.
The jump keeps trying for a few seconds and starts over when the viewer for the
match mounts, so a file that is still loading, or behind the large-diff gate the
jump lifts, is still reached. In the walkthrough a mounted run is reached by the
line scroll alone: the step jump pins the step's header to the top and holds it
there while the stream settles, away from a match deep in a long step. Marks
wrap each text node of a match inside its own syntax token, so clearing them
gives a row back its exact structure.

### Why the search reads files itself and not the viewers' data

Most files of a changeset are collapsed and have never been read, so their
matches have to come from somewhere other than a mounted viewer. Each source's
`revision` names what its data depends on, so the bar re-reads a file exactly
when the viewer would show something different.

`WalkthroughView` gates discovery and source loading while retaining generated
results and any explicitly started generation job.

One walkthrough of one target (reading and generating it, its model and
language, what blocks it, where the reader is) lives in
`walkthrough/useWalkthroughReview.ts`. `WalkthroughView` picks the target in
the context panel; the phone's Changes picks it from its own mode and source
and pushes `MobileWalkthroughScreen` (`apps/`) over its list. Both lay the same
review out with the controls in `walkthrough/WalkthroughControls.tsx`, so a
walkthrough behaves the same on every surface. The panel header never wraps:
`useToolbarFit` collapses it in steps (labels, then the options into "More",
then the step arrows and Generate, then the scope label), with the CSS in
`index.css`.

The walkthrough's stream column has a zero minimum width so long diff lines
cannot widen it beyond the panel. Explanations wrap within that column; code
uses the shared diff wrap preference and scrolls horizontally when wrap is off.

The Git panel header (`git/GitHeader.tsx`) collapses the same way. The
repository picker truncates down to its icon and chevron first, then the
branch picker; their names sit in a grid track with no minimum, so neither
picker shrinks past its icons. Only while the pickers still overflow their slot
does the sync button drop its word, and at the narrowest widths its counts;
its tooltip names both. The panel keeps its 320 px minimum.

The Changes toolbar (`DiffView`) drops its labels first, then, only while the
row still overflows (a picker cut down to its icon does not count), moves its
view options into "More actions" from the end: side-by-side, whitespace, line
wrap, the tree view, and last, when the row still does not fit (a repository
picker at 320 px), the walkthrough, which the rail opens as well. The fit sets
one attribute per moved
control; the menu reads them when it opens and shows a check beside each view
option that is on.

## Large text files

The 200,000-character threshold selects an initial code preview, not read-only
permissions. Users can switch large text files into editing through the normal
view controls. Markdown, HTML, JSON and Draw.io retain their own preview-mode
preferences. Binary, image and outside-workspace restrictions still apply.
`fileEditorContent.ts` preserves the complete normalized text in both the loaded
snapshot and draft, and restores the detected line ending on save. Preview
limits must never truncate a writable draft or its dirty-comparison baseline.
Large code previews render the current draft and hash its full content only
while previewing, so same-length edits in the middle invalidate cached output.

Markdown plan previews use the file preview's local-asset handling. Relative
images resolve from the plan file's directory, including personal plans stored
under the OpenChamber data directory and repository plans in a custom folder.

## JSON tree previews

`FilesView` selects `JsonTreeView`'s JSONC format for `.jsonc` files. That format
accepts comments and trailing commas for preview without changing the source
text. `JsonTreeView` defaults to strict JSON parsing for other callers.

`FilesView` gives `JsonTreeView` the pane's full height. Its toolbar does not shrink, and its flex body has `min-height: 0`, so `JsonTreeViewer` gets the remaining height as its scroll viewport. Above 200 rows, the virtualizer mounts only the visible range and overscan. Chat callers keep their absolute `400px` and `70vh` height caps.

`JsonTreeViewer` (Files, chat tool output) draws its rows with the file
tree's parts, `fileTreeRowPaddingLeft` and `FileTreeIndentGuides`, plus a
copy of `FileTreeChevron`'s look, so nesting reads the same in both trees.
`flattenTree` adds a closing `}` or `]` row after the last child of every
expanded container that has children; collapsed and empty containers stay
one row. The expand arrow stays the
line's size on touch screens: inline `minHeight`/`minWidth` of 0 beat
`mobile.css`'s 36px button floor, which made arrow rows taller than leaf rows
and pushed their keys out of line, and an invisible `::before` covers the
row's full height and part of the indent as the tap area, 26x24px. That is
under the 36px floor on purpose: a 36px arrow is what made the rows uneven. The tree is code,
so it renders `dir="ltr"` in every language; mirrored, it flipped brackets
and showed `"</head>"` as `"<head/>"`. That is why the chevron is a copy:
`FileTreeChevron`'s `rtl:-rotate-90` follows `<html dir>` and would point the
unmirrored arrow up inside the LTR block.

### Why a bounded flex body and not percentage max-height alone

A percentage max-height inside auto-height wrappers let the inner viewport grow to the entire virtual list. The Files pane then scrolled outside the virtualizer, which mounted every row and froze the renderer on large JSON. The flex layout keeps the virtualizer's viewport bounded without changing file limits, preview preferences or saved tabs.

## Pull request comparisons

DiffView, mobile Changes and walkthrough share `PullRequestComparisonSelector`
and the selection owned by `usePullRequestComparison`. PR mode reads the
published patch of a change request through `/api/walkthrough/pr-diff`, always
through the checkout's bound read context, and only for a provider the server
serves (`useSourceControlProviderServing`); for a provider the server does
not serve, PR mode is not offered and reads nothing. While the provider list
is unknown (first visit, the first read out or failed and being retried) PR
mode stays offered and the picker shows loading: an unknown list is never read
as "not served" or "not connected". The mode, picker and messages use the provider's
term (`changeRequestCopy(key, term)`: merge-request wording on GitLab) and
its reference prefix (`!` on GitLab). It includes no local edits
or unpushed commits. `lib/diff/pullRequestDiff.ts` splits the response once;
`useGitComparison` serves file patches from that same snapshot. Snapshot revisions
invalidate the view's patch cache atomically, including edits with unchanged
file names and line counts. Opening a file adds no network request.

PR comparisons retain completed snapshots across panel and mode switches.
`pullRequestSnapshotCache.ts` belongs to the retained view and deduplicates
in-flight reads. The bound context is part of each snapshot's identity, so a
rebind never serves a snapshot read under the previous binding. It keeps at most eight completed snapshots with a 32 MiB
text target, allowing one oversized PR to remain complete. Eviction drops cache
ownership only, never mounted content or pending requests.

`gitPushEvents` fires only after a confirmed push, with the runtime captured at
request start. The HTTP Git adapter emits it, and so do the managed network
operations the Git panel pushes through: publish, sync, and contributor pushes. Matching runtime/directory snapshots are
invalidated synchronously. A visible PR comparison refreshes immediately; a
hidden one waits until activation. Old pre-push reads cannot overwrite the new
snapshot. Explicit Refresh always reads again. Terminal and external-client
pushes require that manual refresh. Local status polls never invalidate PRs.
Walkthrough also retains its last PR read across visibility changes and reloads
after push, source, model or language changes. The PR picker retains its list
on panel switches; opening the picker or changing search still refreshes it.

Working-tree mutations are unavailable for PR snapshots, and "Load full files"
does not apply to them. Expanding collapsed context on one file works: the
expander asks `useGitComparison.fetchFullFile`, which reads both sides of that
file from the provider through `/api/walkthrough/pr-file` (merge base and PR head),
never from disk, so local edits and unfetched fork commits cannot leak in or
block it. Existing inline comment controls still attach selected code to chat.
Changes hands its PR source to walkthrough; walkthrough's Changes action opens
PR mode with the shared selection. Picking a PR never generates a walkthrough.

Web, Electron, hosted mobile and Capacitor use the server route. VS Code keeps
PR comparison unavailable, like the other server-backed comparison modes.

A PR of another project, opened from the Tracker or the board, keeps that
project's folder on its Changes or walkthrough tab (`directory` on both views).
The views then key everything by that folder: the binding the PR is read
through, the selection and the hand-off between them. Changes shows only that
PR there, without the scope switch, the last turn, review or opening files,
which belong to the session on screen. The rail's own Changes and walkthrough
return to the panel's project (`lib/surfaces/DOCUMENTATION.md`, Tracker).

Mobile Changes uses the same expansion for branch, commit and PR files: the
patch opens with 3 lines of context, and expanding reads that file in full once
(git with whole-file context, or both PR sides from the provider), then replays the
expansion. A failed read toasts and keeps the patch. Working-tree files there
already load both full sides, so they expand without a read.

## Hidden whitespace

`diffHideWhitespace` is a synced profile preference, toggled from the DiffView
toolbar and the mobile diff header. `PierreDiffViewer` applies it to whatever
diff it receives, every comparison mode alike, through
`lib/diff/hideWhitespaceChanges.ts`: line pairs equal once all whitespace is
removed become context, each side keeping its own text, and hunks are recut
with 3 lines of context inside the original hunk. A file with nothing left shows
a whitespace-only note. Hunk stage and discard actions are withheld meanwhile,
because they act on the whole hunk, whitespace included. Line numbers do not
move, so comments and context expansion work unchanged.

## Sticky horizontal scrollbar

Pierre scrolls each code column sideways on its own (two in a split diff, one
in a unified one), so the columns' scrollbars sit after the last line. The
inline layout hides them inside the shadow root and draws one track per column
in `DiffStickyScrollbar`, a `sticky bottom-0` strip after the diff: while the
diff runs past the bottom of the panel, its scrollbar stays at that bottom.
Each track and its column copy each other's `scrollLeft`; sizes are read only
in ResizeObserver callbacks, so vertical scrolling does no work for it.

Sticky elements stick to their nearest scroll box and keep clear of its
padding. Everything between a diff and the panel that scrolls it therefore
clips with `overflow: clip`, never `hidden`, and end space below the list is
padding on the content, not on the scroller (the Changes panel's `pb-16`).

### Why mirrored tracks and not a scroll area per diff

A per-diff scroll area with its own horizontal bar would have to be as tall as
the panel to keep the bar on screen, which nests a vertical scroll area inside
the panel's. #213 removed exactly that after nested scroll areas broke
scrolling in the All files view (#215). The tracks scroll sideways only, so the
panel stays the one vertical scroller.

Most focused tests use Bun. `MultiFileDiffEntry.vitest.tsx` exercises the real
diff component through the web workspace's Vitest runner because its transitive
UI imports require Vite asset transforms. The web test configuration includes
UI `*.vitest.tsx` fixtures; the isolated Bun runner intentionally does not.

## Archive page

`ArchiveView` lists archived top-level sessions. A subsession whose parent is
archived too is left out: it comes back when the parent is restored. A
subsession archived while its parent stays active is listed, indented under a
row with the parent's title, and the subsessions of one parent sit together at
the place of the newest of them. Without that row such a session would show
nowhere: the sidebar hides archived sessions, and the parent is not in the
archive. Restore brings it back on its own, under that parent. One rule,
`isRestorableOnItsOwn` in `sync/session-restore-rule.ts`, decides what the page
lists, when the chat header's session menu offers Restore, and what the restore
action accepts, so the three never disagree.
