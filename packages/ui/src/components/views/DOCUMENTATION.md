# Retained context views

`ContextPanel` keeps file, diff and walkthrough views mounted to preserve
navigation, expanded sections and editor state. Its `visible` prop combines
the panel's open state with the selected tab. Hiding via CSS alone does not
pause React effects.

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
working tree is not persisted either. Entry points that name what they show keep
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

`WalkthroughView` gates discovery and source loading while retaining generated
results and any explicitly started generation job.

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

## JSON tree previews

`FilesView` selects `JsonTreeView`'s JSONC format for `.jsonc` files. That format
accepts comments and trailing commas for preview without changing the source
text. `JsonTreeView` defaults to strict JSON parsing for other callers.

## Pull request comparisons

DiffView, mobile Changes and walkthrough share `PullRequestComparisonSelector`
and the selection owned by `usePullRequestComparison`. PR mode reads the
published patch of a GitHub pull request or a GitLab merge request through
`/api/walkthrough/pr-diff`, always through the checkout's bound read context;
without one, PR mode is not offered and reads nothing. On GitLab projects the
mode, picker and messages use merge-request wording and `!` numbers through
`changeRequestCopy`. It includes no local edits
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
file from GitHub through `/api/walkthrough/pr-file` (merge base and PR head),
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
(git with whole-file context, or both PR sides from GitHub), then replays the
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

Most focused tests use Bun. `MultiFileDiffEntry.vitest.tsx` exercises the real
diff component through the web workspace's Vitest runner because its transitive
UI imports require Vite asset transforms. The web test configuration includes
UI `*.vitest.tsx` fixtures; the isolated Bun runner intentionally does not.
