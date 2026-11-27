# Retained context views

## Ownership

This folder owns shared context views and their page-level composition. Child
modules document file browsing, diff entries, Pierre integration, Git controls,
usage reports and walkthroughs. Runtime adapters own reads and mutations;
stores own durable state and shared caches.

## Invariants

### Archive loading and admission

- Archive selectors depend on archived membership and parent titles. Subscribing
  to the entire session entity map would rerender the archive for active chats.
- A session in a missing worktree becomes eligible only after the server confirms
  its folder is gone. An existing unregistered folder stays behind admission.
- Message search always has an explicit set of admitted folders. Without a
  folder restriction its request would search the entire index.
- An empty archive becomes authoritative only after the session list loads.
  Pending and failed loads retain their own presentation.

### Plan identity and writes

- A saved plan carries its owner explicitly. An open plan can outlive a directory
  switch, and a managed-chat owner has no registered project to infer by folder.
- Load and save effects use primitive document identity. Rebuilding an equivalent
  owner object cannot reload the document or flush its buffer.
- Managed-chat plans cannot start Improve or Implement through `createSession`.
  That path cannot prepare the per-session directories managed chats require.
- Pending saves track the newest buffer synchronously in refs. An edit and
  unmount can share a batch before passive effects run; editor echoes of supplied
  text do not count as edits.
- Debounced saves and close-time flushes share a per-document queue. A successful
  write marks only its captured edit revision saved, leaving newer edits dirty.
- Every queued write captures document and runtime identity. A write waiting
  through a runtime switch cannot send one host's buffer to another host.
- Switching plans or unmounting flushes the outgoing buffer before replacing its
  bookkeeping. Reopening waits for that document's queued writes before reading,
  so debounce cancellation cannot lose typing or race the reload.
- A plan missing on initial read stays unsaveable so the editor cannot recreate
  a deleted document. External updates replace clean text; unsaved edits retain
  priority. A move waits for a successfully written revision before proceeding.
- Plan sends use the owner's project and prompts, including in a new worktree.
  Comments identify the full plan path. If a server omits that path, the message
  includes the plan content so the agent still receives its instructions.
- Only Implement can run as a goal. Each send explicitly sets its armed state,
  and the objective includes the plan substance for progress auditing. The shared
  goal path distills oversized objectives; linking the session back to its plan
  is best-effort and cannot hold up the send.
- Sharing stays in the plan list because a move changes the plan ID; an open
  view's pending saves and todos still refer to its current ID.

### Terminal ownership and geometry

- Emulator identity belongs to the tab. Resolving its PTY session cannot remount
  the WASM viewport. Inactive tabs retain their viewports, and only the active
  tab holds a stream; scrollback updates stay in the leaf subscription.
- A visible tab waits for Ghostty's fitted grid before spawning its shell.
  Starting wider and correcting later leaves zsh's end-of-line mark above the
  prompt. Hidden tabs use an estimate and resize when first fitted; running
  PTYs never resize from container estimates.
- Parent close callbacks are read through a ref so a parent render cannot
  reconnect the stream. Closing an exited tab removes it before server cleanup,
  so an action rerun cannot lose a tab it reuses while cleanup waits.
- A force-killed action can have no exit event and no remaining server session.
  Exit ownership accepts the cleared session left by the action runner too.
- Portless's named address for a loopback port takes precedence over the server's
  announcement of the same port, preserving the usable named address.
- Touch copy and paste live in the toolbar because touch terminals have no
  corresponding context menu or keyboard shortcuts. Clipboard reads begin in
  the click, and touch keys omit tooltips because long presses swallow clicks.

### Catalog installation and authentication

- Selectors use stable empty collections. Fresh empty arrays or objects can
  produce an unending external-store render loop.
- Installed skills belong to the catalog only in the user's OpenCode skills
  folder. Matching a frontmatter name can identify an installed skill, but
  deletion uses its folder basename and never touches same-named copies elsewhere.
- Installation groups skills from one source into one clone and selects paths
  relative to its repository root. Existing components are skipped; skill
  conflicts skip all and plugin confirmation remains explicit.
- An entry's primary component determines setup, while its runtime status takes
  priority over missing optional bundle parts. A sign-in in progress keeps its
  panel through reconnection. Failed and connected OAuth transports both permit
  fresh authorization because neither proves the stored grant authorizes tools.
- After an MCP configuration write, a best-effort reload makes the new integration
  available for OAuth. Failed connection attempts refresh status so `needs_auth`
  can open sign-in; transport failures retain their failed state.

### Settings navigation and tracker reads

- Mobile Settings seeds deep-link handling from the mount-time slug. Reopening
  or returning to navigation cannot re-enter a remembered page. Header Back and
  Android Back follow the same page-list-item ladder; the shell handles only a
  press at its root when it owns Back.
- The phone Settings list keeps its offset per instance while a page replaces
  it. Its search results are their own list, so clearing the search returns the
  list where it was. A split page keeps its item list mounted under the open
  item instead of unmounting it, so Back returns to the item list where it was.
- Settings links and search open the owning page before revealing an item. The
  reveal retries for a bounded number of frames because detail pages load late.
- Tracker lookup accepts only the linked item. When issue and change-request
  numbers share a namespace, a missing issue can resolve as a change request;
  remembering the missing issue prevents background refreshes swapping the item.
- A linked item outside a project's fork network is read-only through a matching
  host account. A new unreadable tab opens externally and closes; restored tabs
  and failed reads of owned items keep an in-place explanation and retry.
- Tracker tabs refresh their clocks while mounted and invalidate their own
  server answers on explicit refresh, so long-lived activity timestamps and
  host-side changes do not remain stale.

### Comparison caches and file freshness

- Submodule summaries compare HEAD to index for staged changes and index to
  checkout for unstaged changes. Only the checkout side includes uncommitted
  and untracked work inside the submodule; there is no ordinary file to render.
- Sticky-scrollbar binding observes column structure without observing the deeper
  virtualized rows, so vertical scrolling does no measurement work. Geometry
  reads finish before writes, and mirrored scroll updates suppress their echoes.
- Git mutations act on the selected repository while session and panel tabs stay
  keyed to their root. Authoritative session-worktree attachment controls repair
  fields even when detected worktree metadata disagrees.
- Reintegrating commits applies to local scratch branches. Fork pull-request
  branches tracking a non-origin remote do not offer that operation.
- Reverts use limited concurrency because the server serializes them per
  repository; extra POSTs would occupy browser connections needed for reads.
- Mutation controls wait for fresh status before settling. Branch lists and
  history refresh in the background because neither establishes staged files or
  ahead/behind counts. Status paths are unique by server contract; local
  deduplication would hide a broken response.
- A dirty-switch push failure leaves the committed branch selected so its
  failure remains visible. A switch leaving a local-only commit says so in its
  toast; partial reverts never permit checkout until the tree is verified clean.
- Conflict recovery state and commit drafts belong to the effective repository,
  including nested selections. A pull conflict retains merge-in-progress state;
  cherry-pick and revert conflicts require manual resolution outside the shared
  conflict dialog.
- Pull-request remotes cache by runtime and directory so remounts can use the
  same status key without flashing through a remote-less loading state.
- Branch-scope coercion waits for confirmed unavailability. Null status before
  the first request is unknown even if its loading flag is false; metadata retry
  exhaustion and settled missing bases end resolution without an endless spinner.
- Bounded metadata retries advance only on external request-state transitions.
  Attempt counters and inline starter functions cannot retrigger the effect;
  changing directories resets exhaustion in the first render.
- Range-cache reservations prevent duplicate reads, release when their path
  leaves the request and reject stale completions by request identity. Range
  changes hide old values immediately with a stable empty map; equivalent path
  revisions cannot cancel pending reads. Completed entries whose path is no
  longer requested are kept up to `RANGE_CACHE_IDLE_ENTRIES`, oldest dropped
  first, so scrolling an expanded list does not retain every patch it read.
  A hidden view requests nothing and keeps what it holds until it shows again.
- Content polling confirms changed text with a second read before applying it,
  so a half-written file stays out of the editor. A failed read leaves the change
  pending for retry; metadata comparison tolerates sub-millisecond mtime jitter.

## Decisions

### Why archive rows mount in batches and not a virtual list

Batching bounds the initial DOM work for hundreds of archives while preserving
the grouped list's ordinary layout and responsiveness.

### Why Markdown search uses ranges and not DOM replacement

React owns the preview's text, so search paints DOM Ranges without mutating it.
Search and outline controls stay outside the searched container to exclude their
own text. Content rescans preserve the active index, lowercase matching maps
expanded UTF-16 units back to whole source characters, and unsupported highlight
APIs still permit counts and navigation.
Keystrokes are debounced because each query walks the whole rendered preview.

### Why floating editor panels ignore their toggle in outside-click handlers

The toggle handles its own close. Treating its press as an outside click closes
the panel first and lets the subsequent toggle reopen it. Preview focus stays
available for the find shortcut when the outline navigates.

### Why toolbars measure content and not fixed breakpoints

Scope controls and translations change the required width. Fitting measures only
after mount or content changes, with resize and font events handling later size
changes; fixed breakpoints can hide labels that fit or leave overlapping icons.

## Retained view lifecycle

Archive session rows apply the shared session-admission directory rule before
search, counts and grouping. Unregistered host destinations stay hidden without
removing their records from the global archive cache. Managed chats, live spaces
and catalogued read-only space archives retain their existing ownership. Opening
an archive row still passes through the shared session-selection gate.

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
so `FilesView` and `PlanView` keep their line-number config's identity across
renders.

The go-to-line field takes focus in its opening layout effect. Deferring that
handoff to an animation frame leaves the closing toolbar menu focused: fast
typing can be lost, and Enter can activate the menu item again and close the
field before the jump.

## Selecting lines for a comment

In `FilesView` and `PlanView` a press on a line number starts a line range for
a comment, Shift+press extends it, and a press on the only selected line
clears it. `comments/useLineNumberDragSelection.ts` owns this for both, with
the gutter config they pass to the editor. After the press the drag is
followed on the window: the range ends at the line at the pointer's height
wherever the pointer is, and while it is held at the editor's top or bottom
edge, or past it, the editor scrolls and the range follows. The click that
ends a drag lands on whatever the pointer ended over, so each view's
click-outside handler skips it (`isDragReleaseClick`) and the range stays.

A text selection in the `FilesView` editor gets a Comment action from
`comments/useCodeSelectionComment.tsx`: `useFileComments` passes the Files
view's visibility as the scope that closes the action when it changes.
`useFileEditorExtensions` adds the stable extension to the editor, so a scope
change does not reconfigure the editor.

### Why a comment's annotation keeps one DOM node

Pierre keys its annotation wrappers by index in the list, so an annotation that comes or goes rebuilds every one after it. A card is portalled into its annotation's node, so a new node would unmount the card and drop its height for a frame, which moves the diff and the scroll. `renderAnnotation` hands back the same node per annotation id, and the open comment field goes last in the list, so opening or closing it shifts nothing.

### Why the open comment field gets its focus back after a render

A render that rebuilds the rows or the annotations takes the open comment field out of the rendered tree for a moment, and the browser drops its focus. It happens under a person who is typing: an agent's write refreshes the diff, and the virtualized diff is reset for the new content. `PierreDiffViewer` records the focused field before each render it starts and focuses it again in Pierre's post-render callback, only while nothing else has taken the focus since. `CodeMirrorEditor` does the same for a field in a block widget when an update redraws the lines around it, such as a reload from disk in `FilesView`. Keeping the node attached through the render was not available: Pierre resets its container when the content changes, and CodeMirror redraws a widget's node with the lines next to it.

### Why a line comment follows its code and not its line number

A pending comment in `FilesView` and `PierreDiffViewer`, the open field and a saved unsent one, is stored with its line numbers, and an agent's write shifts the lines under it. `useInlineCommentController` finds the lines again each time the content changes (`lib/commentAnchor.ts`): by the text of the commented lines, with the line before and after them telling repeated code apart. It writes the new numbers to the draft store, so the card, the composer row and the prompt all show where the comment is now. When the code is gone the comment stays by a neighbour that survived, the draft carries `changedCode`, the card says so, and the prompt quotes both the code the comment was written on and the code there now.

The search needs only what the draft already stores, so it works after a restart and for a file that changed while it was closed. Mapping old line numbers to new ones through a diff of the two versions was rejected for that reason: it needs the old text at the moment of the change, which a closed file or a patch-only diff does not have.

Each view says which lines it knows. `FilesView` gives none until the file is loaded and non-empty, and a patch says it is partial, so a comment outside its hunks is left alone. An empty or missing side never reads as "the code is gone". A viewer with comments off (a commit in History) gives no lines at all: it shows other content under the same path. A comment the patch does not hold moves into a hunk only when a stored neighbour stands beside the match, since the text alone may be any closing brace. A comment is re-anchored only while its file is shown in one of these views; sent before that, it carries the numbers it had, with its code.

### Why the comment field stays in view when the editor scrolls sideways

With wrapping off a CodeMirror block widget is as wide as the longest line. `CodeMirrorEditor` publishes the visible width as `--oc-editor-width` beside the gutter width, the comment field and cards size to it, and `.oc-block-widget > *` is sticky past the fixed gutter. Sizing from the context panel's width overflowed by the width of the file tree.

`PierreDiffViewer.tsx` is the viewer's shell: the whitespace-only gate, the options Pierre gets and the markup. The mechanics sit in `pierreDiff/`, one hook or helper module per concern (comments and selection, line gestures, annotations, the Pierre instance lifecycle, find marks, context expansion, theme variables, the shared virtualizer), and the shell calls those hooks in one fixed order. Effects run in call order, and the instance hook's effects depend on the annotation and selection refs the earlier hooks set, so a hook moves only together with its position in that sequence.

### Why Pierre owns diff line-number selection

`PierreDiffViewer` receives number-column selections through Pierre's
`onLineSelected`, including clearing a single line, Shift+click ranges and
touch taps. A separate click listener would run after Pierre's pointerup,
reopen a cleared comment editor and replace a range with the clicked line.
Pierre toggles a single selection by number without checking its side. A
capture-phase pointerdown clears that selection before a same-number press
on the other side, so Pierre starts a normal selection there. Shift+press
and unfinished comments keep their existing paths.
The gutter "+" keeps its own `onGutterUtilityClick` path. An unfinished
comment still prevents an accidental deselection from closing its editor.

### Why the window follows the drag and not the gutter

The gutter only sees the pointer while it is over the line-number column,
about 40 px wide. Extending on gutter `mouseover` froze the range as soon as a
hand drifted into the code, never scrolled, and the click after a release that
was not over the pressed line number often cleared the range (#5556).

File tree ownership and request rules are in `files/DOCUMENTATION.md`.
`DiffView.tsx` composes the modules in `diffView/`; their ownership and
hook-order invariants are in `diffView/DOCUMENTATION.md`.
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
view take the same base for a new pull request, for updates and for the
target Re-integrate commits starts on (`useBranchPullRequestBase`): a base
chosen for the branch, its open pull request's target, or the parent the
server recorded or detected (a lower layer of a stack, the branch a restack
landed on), and the worktree's own guess only when none of those answers. The Git view,
Changes, mobile Changes and Walkthrough each ask for the branch's pull request
themselves (`hooks/useBranchPullRequestRequest.ts`) while shown: the base
prefers its target, and the Git header's pull request chip reads the same
status. Without asking, a stacked branch checked out in the same worktree
compared against the default branch, and a project's own checkout (which has no
sidebar worktree row) showed no chip, until some other surface happened to ask. Entry points that name what they show keep
their scope: the work-status Changes row counts working-tree changes and opens
`working`, and a file opened from the Git panel or a tool card opens its own
working or staged diff.

The comparison picker puts the bound remote's default branch first, without
changing automatic base detection. Other remotes' defaults keep their place:
a base on a remote other than the bound one is rejected.

The pull request picker (`git/PullRequestComparisonSelector.tsx`: Changes,
Walkthrough and mobile Changes) and the Git panel's list
(`git/PullRequestListPanel.tsx`) share one filter icon,
`git/PullRequestFilterButton.tsx`, over the panel in
`components/references/referenceFilterPanel.tsx`. The filter and its list read
belong to `usePullRequestComparison`. Both start at Open, so the default read
asks for open pull requests only; All, Closed and Merged read `state=all`, and
every page of that list keeps the state (`pullRequestListState`). On a provider
with `advancedSearch`, a status qualifier in the search text decides the status
as it does on the board: the host ignores the state sent with it, so the status
group is disabled and names the qualifier, and no loaded row is dropped for its
status. The filter
narrows the loaded rows on the client, so a page can hold no match: Load more,
a failed page's error and its Retry stay reachable then. Repository, author and
label choices come from the loaded rows, and a chosen one stays listed after
the rows that carried it are gone. The filter belongs to the folder, branch and
repository it was chosen in, and the picker drops it with its search text when
it closes. The filter sits inside the picker's `Command`, so the picker stops
its key presses there: Enter on the icon would otherwise pick the highlighted
pull request.

A status read re-reads the Branch file list (one request). Each expanded file
re-reads its patch only when its own `revision` from that listing moved
(`branchPathRevisions` into `useRangeKeyedCache`), so an agent's read-only shell
command costs no patch reads, and an edit costs one for the edited file. A
listing without revisions falls back to the status revision for every file.
Desktop Changes and mobile Changes share this.

## Pushing for review

Where the repository's host creates changes by pushing for review
(`features.createByPush`), the Git panel's change section replaces the pull
request form: the tip commit's subject read only (the commit message is the
description), topic, hashtags, work in progress (sharing the draft choice's
remembered value) and private, and one action, Push for review. It shows on
the target branch itself too, the usual way to work on such a host. Before it
is enabled the commits between the target and HEAD are read
(`git/changeIdPreflight.ts`): none to send, or an older commit without a
Change-Id, holds it back; the checked-out commit alone without one offers Add
Change-Id, which amends it after a confirmation (`GitAPI.addChangeIdToHead`).
With an open change, a strip above it offers Upload patchset while the
status's `localRevision.uploadedAs` is null. The push is a tracked network
operation through `useBranchPush().pushForReview`, never Publish. The Git
header's change chip shows its place in the status's chain
(`stacks.preview.position`).

## Nested repositories

A folder inside the project that holds its own `.git` and is not a submodule
is one `dir/` row in the parent's status; its diff read answers
`nested_repository`. Its Changes entry then reads that repository's own status
and lists its changed files, each diff read from that repository when the row
opens, read-only: no stage, discard or hunk actions. "Open as project" adds the
folder as a project and opens a new session draft in it, where the Git panel
commits. A repository row inside that listing keeps the separate-repository
note without recursively reading its changes. The listing reads again when
the entry's `contentRevision` moves. Mobile Changes still shows
only the note for such a row.

Git, Changes, Walkthrough, pull requests and mobile Changes use the shared
repository picker. Selection, discovery refresh and persistence belong to
[`useGitStore`](../../stores/DOCUMENTATION.md#usegitstorets) and
`useNestedGitDirectory`; diff rows do not change that selection. A changed-file
chip falling back to Changed does (*Last turn scope*), since the chip names a
file and only its own repository can show it.

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
batch reader forgets a rejected request so the next read can retry it. The
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

### Invariants

- Source loads run serially so opening find on a large changeset does not start
  every host read at once. Closing stops new reads and retains resolved diffs
  for reopening.
- A layout change re-runs matching without invalidating the loaded diff.
  Source revisions describe the data, independently of layout.
- Callers memoize `sources` so its identity changes only with the file list,
  layout or data revision.
- Search uses the viewer's whitespace-filtered diff so every counted match
  has a line navigation can reach. "No matches" waits for reads to settle.
- An anchor jump waits for its file to load, then selects the following match.
  A settled search without the anchor falls back to the first match. Closing,
  opening normally or editing the query clears the intent to prevent stale jumps.
- Shortcut ownership follows current DOM focus and the event's find surface.
  Pointer history cannot change which surface owns Cmd/Ctrl+F.
- Escape leaves IME composition, other fields and focused controls outside the
  surface alone. Claimed Escape events are default-prevented so another
  surface's window listener cannot close a second bar.
- The bar stays above sticky file headers and below panel resize handles so
  each control receives its own pointer events.
- The failed-read note wraps within the controls' width so its text cannot
  widen the floating bar.
- A jump uses the match's location and index as its key because arriving files
  rebuild match objects. Its job survives the retry deadline so a viewer that
  mounts later can restart the wait and finish navigation.

### Why a shared empty match list and not a fresh array

The index synchronizes against match-list identity during render. A closed bar
or empty query uses `NO_MATCHES` because allocating a new array on every render
would keep that synchronization rendering forever.

### Why resolved reads use state and refs

State publishes each completed read to consumers. The serial loader also reads
the same resolved and failed maps through refs so it can continue from its
latest progress without waiting for React to render.

### Why Escape uses capture and not a bubble listener

The zone frame handles Escape in React capture and stops native propagation.
The find surface listens on window capture so it can close the bar before that
handler closes the panel; a bubble listener cannot receive the event.

### Why a plus sign and not a loading spinner

The growing total carries a `+` while files load. A spinner appearing and
disappearing beside the count moves the navigation arrows.

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

### Why the changes list shares one tooltip and not a Tooltip per button

The changes list is not virtualized below 1000 rows and keeps its stage,
unstage and folder buttons mounted, so a Tooltip per button would mount
thousands of them. `DelegatedTooltip` (`ui/row-tooltip.tsx`) listens on the
list and shows the `data-row-tooltip` label of the button under the pointer.
Its state stays in its own component because a re-render of `ChangesPanel`
re-renders every row.

## Files toolbar

The Files editor's row (`renderFileToolbar`, an `ActionToolbar`) has the actions
the open file's type allows, the same in every mode. The row itself keeps save
state, the mode toggle (and HTML annotation), find and comment on the file;
go to line, symbols, line wrap, read aloud, the file's own actions
(open in app, copy contents, copy path, download) and auto-save live in "More
actions". With every action on the row it ran to a dozen icons, most of them
rarely used (maintainer, 2026-10-28). A tool the current mode cannot run opens
the source editor first: go to line from a preview switches to the editor and
opens the field there. Find in a Markdown preview searches the preview. A
read-only code file has no editor, so it gets no source tools. Go to line and
symbols close when a preview replaces the editor.

Save state keeps one slot as wide as its widest text, also in previews, so
saving moves nothing beside it; a canvas or draw.io preview puts its own save
button there. HTML annotation
from the source switches to the preview and starts once the page has loaded.

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

## Code size in files and diffs

The editor, the Files view's code preview and every `PierreDiffViewer` (Changes,
walkthrough, history) render code at the Editor font size with rows of
`editorCodeLineHeight(size)` (`lib/editorCodeMetrics.ts`), so the same line
sits the same way in each. A virtualized diff's `lineHeight` metric must equal
the CSS row height (`--oc-code-line-height` on `diffs-container` in index.css),
or long diffs jump while scrolling. On phones and tablets Pierre views keep the
code size mobile.css pins and their default rows: `useEditorCodeMetrics()`
returns null there. The CodeMirror editor follows the Editor font size on every
device, rows included.

### Why 12px code with 1.7 rows and not 13px with 1.5

At 13/20 code in the side panel read large and cramped next to the old Changes
look (12/24). The default is 12px with 20px rows. The store's v28 migration
moves a persisted 13, the old default, to 12; a 13 the user chose comes back
from the synced settings. The Markdown preview is sized at +2/+0 from the
setting, so at the default it keeps its 14px body and 12px code.

### Why the CodeMirror line height sits on `.cm-scroller`

CodeMirror's base theme sets `line-height: 1.4` on the scroller, which beats a
value set on the editor root. The theme's row height was on the root once and
never applied.

### Why a font size change calls `setMetrics` and not a new diff instance

A new instance replaces the `diffs-container` host, and the effects that set
its attributes and observers (expand-on-demand separators, find marks) run
only on their own dependencies, so a rebuilt diff lost them until the file
changed. `VirtualizedFileDiff.setMetrics` updates the row height on the same
host.

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

## Last turn scope

`useLastTurnDiff` reads a turn's per-file diff from OpenCode
(`GET /api/session/:id/diff`), which compares the turn's first and last step
snapshots. It reads the newest turn by default; a historical selection passes
that turn's user-message ID as `from`. The newest turn's answer moves when a
step is added, when the newest step finishes
(its end snapshot is recorded then) and when the session goes idle, so those
three key the refetch. The desktop Diff view reads it in every scope while
shown, so the scope picker's Last turn count is current before the user picks
it; mobile Changes has no counts and reads it only in that scope. Outside the
scope a running turn is not read, and its count shows as unknown until the
turn ends. A failed read keeps its own error and retry, and another session's
turn never shows while this one's loads.

A changed-file chip under a completed reply opens that reply's turn diff,
scoped to its session and directory. Under the newest reply that is Last turn
itself; an older reply's chip opens a selection of its own, labelled with the
chip row's title (Changed files) and its own count, while Last turn in the
picker keeps the latest turn's count. The chip comes from the turn's tool calls
and the diff from its snapshots, so they can disagree: snapshots are off, the
project folder is no git repository (a nested repository still gets the edits),
or a step took no snapshot. Each click asks once (`pendingTurnDiffFile`)
whether the file is in the selected turn's diff. The request carries the
originating session even when another session is on screen (a pinned chat), and
the selection persists after the request is consumed. The originating session
only reads the turn; the panel's own session at the click owns the request and
the selection it leaves, so a panel that moves to another session drops both,
and the fallback to Changed below keeps going after the scope leaves the turn.
Picking a scope drops a pending chip request as well as the selection, on
desktop and mobile; so does picking a repository in mobile Changes. OpenCode
reads a turn's range only from a user message, so an older reply whose display
group a notice opened (a compaction, a wake) keeps static chips. Until the list answers the
selected turn's state the view shows loading; a failed read keeps its error
and retry. A listed file is expanded and scrolled to on every click, since
the chip's absolute path only matches the relative list through this request.

On desktop, a file missing from the turn diff opens Changed in the repository
holding it, read afresh and expanded. Only a file inside a project that is not a
repository, once discovery finds no repository in the project holding it, opens
in the editor instead (`files/openChangedFileWithoutRepository.ts`): there is no
working-tree diff for it. Unknown or failed discovery, a file outside the
project and a repository-owned file the list misses (a staged-only entry) keep
the Changed path. The open checks the file with a stat first, since the
optional read answers a deleted file with an empty success: a deleted file
shows the not-found toast, an empty one opens. The read belongs to the click
that started it, from the click through discovery to the read: a newer chip
click, leaving the session or the runtime (even to return) drops it without
a tab, focus change or toast. A repository the picker drops again ends the
attempt on the repository left on screen.

Picking Last turn by hand clears the historical selection and shows the newest
turn, empty or not. The phone's Changes surface (`apps/MobileChangesSurface.tsx`)
opens the selected turn's file diff when a repository holds it. When the status
read for the directory succeeds and the working list still has no entry, the
phone opens a file inside the chip's session folder itself, scoped to that
folder, and brings the Files surface forward: a project that is no repository
and a repository-owned file the working list misses (a committed file) land
there. A failed status read, failed repository discovery in a project that is no
repository (its Retry stays reachable), a file outside the session folder and a file the
open refuses end on the working-tree Changes list. The status answer and the
file read belong to the tap that started them: a newer tap, hiding or leaving
Changes, or picking a scope or repository drops them without a tab, toast or
switch to Files; an iPad side panel counts as hidden once it starts closing.
A failed status read the tap started ends on the list; a failed one it joined
in flight is followed by one more read, since the joined one belongs to an
earlier caller. VS Code has no
Diff view panel: the chip reads its turn's diff once with full context and
opens the file in the editor's own diff (`editor.openDiff` with `patch` and
`snapshot`), both sides built from that patch, so later edits or a later
deletion on disk never change what an older chip shows. A file the list does
not hold opens as it is, and a failed read shows an error toast.

### Why the click is a one-shot request and not derived from the tab

A tab keeps its target across scope changes, so a tab opened from a chip and a
tab where the person picked Last turn by hand look the same. Deriving the
fallback from the tab would send that person back to Changed every time.

### Why the count waits for the turn to end outside the scope

A read of a running step makes OpenCode capture a fresh working-copy snapshot.
Reading on every step only to keep a count current would cost one capture per
step of every turn while the panel is open on another scope.

### Why the phone opens the file itself

Desktop opens the editor only for a non-repository project whose file no
repository holds, because its Changed view can read the repository's working
tree afresh and show the file there. The phone's Changes surface shows a
working-tree or turn diff and has no view of the file itself for a file neither
list holds, so a repository-owned committed file would land on a list without
it. The phone opens the file in the Files surface and comes forward with it,
only when the open actually happened: a file the open refuses, such as a
deleted one or binary content or one too large, shows its toast over the
Changes list. Until the answer is known the chip's screen stays on loading,
since showing the working list first flashed it before the file appeared.

## Where a review comment reopens

A comment's opener in the chat (`components/comments/useOpenCommentSource.ts`)
sends a comparison comment to the git tab as a `CommentLocationRequest`
(`lib/commentLocation.ts`): runtime, repository folder, file, line, side and
the comparison itself. `GitView` takes it the moment the tab is on screen for
that folder (`hooks/useTakenCommentLocation.ts`), so it leaves the shared store
at once and never fires on a later visit, and hands it to
`UnifiedReviewScopeView`, which answers it (`git/useReviewScopeCommentJump.ts`):
it opens the change request, the commit by hash (past the history's first page
too) or the branch against the recorded base, waits until that comparison is on
screen, reveals the file and scrolls its viewer to the line. The file is loaded
whole, because a comment's line can sit outside the hunks a patch carries.

The jump ends when the line is reached, and drops instead of guessing when the
comparison cannot be shown: the tab shows another repository than the one the
comment was read in (the origin's `directory`; older comments name only the
chat's folder), another branch is checked out, the recorded base is gone (no
other base stands in for it), the change request's head moved on a host that
serves only its current patch, the scope changes, the person picks another
comparison, the tab is hidden, or the comparison fails or answers without the
file. A recorded head is sent as a revision read only to hosts that keep
revisions; elsewhere it only identifies the patch. A recorded base stays on screen while the person stays on the branch
scope and is never written as the branch's saved base. Mobile Changes answers
the same request through `hooks/useMobileChangesCommentNavigation.ts`, and
shows the nested-repository state when the comment's repository is not the one
on screen. `DiffView`, which only renders another folder's comparison, takes no
such request.

## Pull request comparisons

DiffView, mobile Changes and walkthrough share `PullRequestComparisonSelector`
and the selection owned by `usePullRequestComparison`. PR mode reads the
published patch of a change request through `/api/walkthrough/pr-diff`, always
through the checkout's bound read context, and only for a provider the server
serves (`useSourceControlProviderServing`); for a provider the server does
not serve, PR mode is not offered and reads nothing. While the provider list
is unknown (first visit, the first read out or failed and being retried) PR
mode stays offered and the picker shows loading: an unknown list is never read
as "not served" or "not connected". A served provider whose descriptor has
`features.changeRequestPatch` off lists and opens its change requests but does
not serve their diff (`usePullRequestComparison().diffUnavailable`): Changes
and mobile Changes keep the PR mode and picker, read no diff and say so with
`ChangeRequestDiffUnavailable` (no retry, since nothing failed); the Walkthrough
does not offer the PR scope, and a PR handed to it shows that note in place of
generation and loads nothing; the board's Changes and Walkthrough links are
left out. The scope picker shows a count only once it is known, so an unread
PR never reads as one with 0 files. The mode, picker and messages use the provider's
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

A comment on a comparison (a pull request, a commit, a branch against its
base) carries the diff it was written on (`lib/diffCommentOrigin.ts`): Changes,
mobile Changes and walkthrough each derive it from the source they show. The
model reads where the lines come from ("in GitHub pull request #5543 at commit
…"), because a pull request that is not checked out has other lines on disk,
and the chip names it beside the file. Drafts show only on the diff they were
written on, so a comment on a pull request's `app.ts` does not appear on the
working tree's. A comment on uncommitted changes has no origin: its lines are
the files on disk.

A file's header in Changes, mobile Changes and the walkthrough also takes a
comment on the whole file (`components/comments/useWholeFileComment.tsx`): a
diff draft with lines 0-0, the same origin, and no code. Its saved cards
render under the header, never inside the diff, so the viewer filters those
drafts out of its line annotations. Its editor renders inside the sticky
header itself (mobile's header is fixed above the scroller anyway): opened
from a file scrolled far down, an editor under the header in the flow sat at
the file's top, out of view. The trigger is always visible, like
the header's other actions, and toggles the editor: a second click closes it
unsaved, so an empty editor never stays stuck open.
Files view takes the same comment from its toolbar, as a `file` draft beside
its line comments. Its editor and cards sit between the toolbar and the
scroller, so they stay on screen at any scroll; the CodeMirror line widgets
filter those drafts out.
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

## Hunk actions

A hunk's stage and discard buttons float over the end of its last changed
line, positioned from a zero-height line annotation after that line. They
show while the pointer is on the hunk (Pierre's `onLineEnter`, matched to the
hunk's line span on either side), on their own hover and keyboard focus, and
while their action runs; touch screens without hover keep them shown.

### Why an overlay shown on hover and not a row of its own

A row under each hunk covered no code, but it striped the diff with empty
bands and cost 2.25rem per hunk. An overlay shown at rest covered the code it
acts on. Shown only while the user points at the hunk, it covers that line's
end only then, and the diff keeps its rhythm.

### Why the hovered line outlives its hunk anchors

A refresh withdraws the anchors while the old diff stays on screen, then
rebuilds the Pierre instance, which reports no line for a resting pointer. The
viewer therefore listens for line hover without anchors too, keeps the line and
matches it again when anchors arrive. Listening only while anchors exist lost
a pointer that came to rest during the refresh: the buttons stayed hidden until
it moved. The viewer's wrapper clears the line on pointer leave, because the
rebuilt instance reports no leave for a line it never saw entered.

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

Archive search keeps browsing separate from searching. An empty field preserves
the archived-worktree groups and archive actions. A typed query uses the shared
conversation search for title metadata and indexed message excerpts, over
archived conversations only: an active session is never a result here.
Opening a title selects the session, and an excerpt uses `openSessionLink` to
focus its message. Neither path restores an archived session.

The search is one field. While it holds text, the field itself carries the
message-search mark (`SearchStatusMark`) and the Search in menu
(`SearchInMenu`: titles and messages, titles only, one author's messages).
The count has one place, beside the field (under the group chips on the
phone): what the list holds while browsing, what the search found while
searching. It never moves into the field, so the field keeps its width when
typing starts. The count is absent while the server cannot report an exact
total. On the phone a failed message search also says so in words under the
field, since nothing there has a tooltip.

The search state is the text and the Search in choice, held by the page.
Clearing the text resets the choice, closing the page drops both, and nothing
is written to storage. Everything typed is words to find: `in:active` or
`project:x` are searched as text.

The group column on the left is the one way to narrow a search by place. A
group picked during a search limits both the title matches and the message
request to that group (a project's root, its worktrees and the folders of
sessions it owns; a deleted space's folder; the Other group's own folders), and
"All archives" releases it. A new search starts across the whole archive, so a
group picked while browsing does not carry into it. Group counts during a
search come from the search, and are absent without an exact total. The phone
keeps its group chips while searching, for the same narrowing.

### Why the group column narrows a search and not a filter in the field

The column is already on screen and already means "this group". A second
project control inside the field (a chip, a typed flag, a menu) repeated it,
could disagree with it, and needed its own way to be cleared.

### Why the search remembers nothing

A filter kept from an earlier visit made a later search come back narrower
than the user expected, and keeping it visible and removable is what put chips
into the field. Each search starts wide.

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

On desktop the panel on the left groups by project, not by folder: a session
belongs to its project the way the sidebar decides it (by folder, then by
OpenCode's project, which still places a session whose worktree is gone).
The chats of a deleted isolated space keep their own groups, and everything
outside a project is one Other group. A project's archived worktrees
(`lib/worktrees/worktreeArchive.ts`, read from the repository each time the
page opens) head its list, each a tile with Restore and Delete for good and
its own sessions inside; the project's other sessions follow. The archive records
which sessions it holds, so a folder name that repeats across repositories or
over time never mixes them up. Restoring one session of an archived worktree
restores the whole worktree (`lib/worktrees/relocateRestoredSession.ts`), since
in the project root it would miss the changes it worked on; a session whose
folder is gone without an archive still moves to the project root. Restores of one archive are
joined, not repeated: a session's subsessions come back one by one, and each
would start it. Deleting an archive for good deletes only its sessions still in
the archive that no other archive of the project holds.

A right-click on a desktop row opens a menu of three items named as in the
sidebar: Copy session ID, Restore where the row offers it, and Delete. The
session ID is otherwise reachable only by opening the session.

The phone shows the same page in one column: the groups are a row of chips
that scrolls sideways (hidden while searching, since a search spans them
all), and a selected project's archived worktrees are tiles above its other
sessions, as on the desktop. Restore and a worktree's Delete are always shown,
as nothing hovers; rows name their group only in the lists that mix groups.
Deleting a session stays on the desktop, whose confirmation dialog the mobile
shell does not mount.

## Terminal tabs whose shell exits

When the process of a terminal tab exits (`exit`, Ctrl-D, a project action that
ends or is stopped), `TerminalView` closes the tab and releases its server
session, the same as clicking its close button; the last tab closes the panel.
The `terminalCloseOnExit` setting turns this off, and the tab then stays with
its output and the exit line, which is how a dev server's log stays readable
after it stops. The check runs on the live `exit` event and on a snapshot that
reports `exited`, so a tab whose process ended while the panel was closed goes
away when it is shown. VS Code has neither tabs nor the setting and keeps the
exited terminal.

A tab started from a command in a reply (a `terminal` tab in command mode) is
the exception: it never closes on its own, whatever the setting, since its
output is the point of running it. When its server session is gone (a server
restart, a close from another client), the tab stays exited with its command mode and output instead of
going back to idle, which would start an interactive shell in it; a reload
restores it exited too (`stores/DOCUMENTATION.md`).

In the desktop app Cmd/Ctrl+W closes the shown terminal tab the same way,
without asking, so a command still running in it ends. The key goes through
`lib/closeTabTarget.ts`: Settings or a full page covering the chat closes
first, whatever was clicked last; otherwise the registered tab target whose
zone was clicked or focused last closes, so the terminal gets the key when its
zone was. With no target registered the window closes.

## A terminal that cannot connect

The terminal socket (`lib/terminalApi.ts`) retries forever, 0.5 s doubling to
8 s, and reports each failure as a `reconnecting` event with its attempt
number. `TerminalView` covers the pane with "Terminal couldn't connect" and a
Try again button once five attempts in a row have failed, about 8 s, and keeps
it there until a snapshot arrives. Try again drops the subscription and opens a
new one, which dials at once; its own failures start the count over without
hiding the error.

### Why a count of failed attempts and not the retry giving up

The retry never gives up: after a server restart or a dropped network it has to
come back on its own, so ending it would trade a blank pane for a dead one. A
browser WebSocket also never sees the upgrade's 401 or 403, so a refused token
cannot be told apart from a server that is down. Five attempts span a typical
server restart, so a short outage shows nothing, and an outage that lasts shows
the error while the retry goes on underneath.

## Office documents in a diff

`getFileDiff` and `getCommitFileDiff` return docx, xlsx, pptx, odt, ods and odp as
two data URLs, the way images travel, because a text patch of a zip says nothing.
`OfficeDocumentDiff` reads them in the app: a workbook lists changed cells, a
text document goes through the regular viewer as its extracted text, so comments
work there, and layout changes do not show. Branch and pull request comparisons
ask for the two versions apart from their patches: `useGitComparison.fetchVersions`
reads them from `GET /api/git/range-file-versions` or from the change request
route with `binary=true`. A provider that ignores the flag, as an extension
provider may, answers text that is no data URL, and the diff keeps the binary
placeholder.

## What a surface does while its zone animates

A context zone opens, closes, expands and is dragged over an animation
(`lib/layoutAnimation.ts`). Work a surface does inside it shows as dropped
frames, so the heavy part waits for the end or is spread over frames.

### Why the stacked diff list mounts entries in batches or near the viewport

An 88-file change took a 100 to 120 ms frame when all entries mounted together.
Smaller lists spread that one-time cost over frames. At 1,000 files and above,
mounting every full entry can exhaust renderer memory even if every file is
collapsed. The list keeps lightweight rows for scroll and keyboard navigation
and mounts full entries near the viewport or while their state is in use.

### Why a file that arrives mid-animation renders after it

`FilesView` waits for the layout to settle (`whenLayoutSettled`) before it
applies a file it has just read, and checks again that the load is still the
current one. A long Markdown file's first render takes 50 to 60 ms; applied
when the read returned, about 70 ms into the opening animation, it stopped the
panel halfway. The cost is the same after the animation, where nothing moves.

### Why a file surface leaves `inert` on open only with an editor showing

Taking a zone's card out of `inert` restyles everything in it. A CodeMirror
editor is re-attached as the zone opens, so its exit from `inert` is cheap in
that commit and expensive later (`zoneInteractiveContext.ts`). A file shown
rendered re-attaches nothing: leaving `inert` at once restyled the whole card
in the frame of the click (25 ms for a long Markdown file), so it follows the
other surfaces and leaves `inert` when the animation ends. `FilesView` says
which case it is by rendering `DetachableEditorMarker` beside its editor.

### Why the browser page keeps its width while its stage moves

A `<webview>` page is drawn by another process, and the app's frame waits for
it at every new size. `useSteadyStage` pins the page's width for as long as a
side column animates or is dragged and lets the stage clip it: unchanged while
the stage shrinks, one step (`GROW_STEP`) wider when the stage outgrows it,
and the stage's width again once the layout settles. Following the stage on
every frame, an expand with a site open drew 3 to 5 of the animation's 15
frames in the desktop app. A zone that grows to a size it already knows (an
expand) publishes it as `data-zone-size`, and the page takes its final width
before the animation starts, so nothing snaps at the end. A drag has no final
size: there the page takes the stage's width whenever the stage rests for
`DRAG_REST_MS`, since a page held wider than its panel until the release read
as broken.
