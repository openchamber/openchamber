# Changes view modules

## Ownership

`DiffView.tsx` owns the retained view state and composes its hooks, content
states, file list and toolbar actions. This folder owns the comparison,
refresh, navigation, selection, viewport, mounting, tree sizing and find
mechanics, the toolbar's fit and options menu, and the per-file entry. The public
`DiffView` and `MultiFileDiffEntry` exports remain at the original import path.
Pierre rendering, comparison transports, file-tree rows and find mechanics
remain in their existing neighbouring modules.

## Invariants

- Hunk mutations require live working-tree or index data. Turn snapshots and
  comparison ranges never authorize stage or discard actions.
- A changed-file chip under an older reply carries its user-turn ID into
  Changes; the newest reply's chip opens Last turn itself. A selected turn stays
  scoped to its session, directory and user message after the navigation
  request is consumed; choosing a scope in the picker resets it. Last turn
  always means, and counts, the latest turn. A new range never displays the
  previous turn's diffs or fetch error.
- A live diff's refresh revision includes changes that preserve its status row's
  line counts. Refresh keeps the previous diff visible until replacement, but
  switching between staged and unstaged clears that side's old content even
  while the entry is hidden or collapsed.
- Tree mode expands its selected file for fetching as well as rendering.
  Otherwise its default first file can wait forever for an unrequested patch.
- Find uses the viewer's exact index-to-working or HEAD-to-index side. The
  combined HEAD-to-working fallback cache cannot supply those search results,
  and renames read their source separately from destination-only batch reads.
- Find source identity stays stable across unrelated scope data and file
  selection changes. Layout rematches existing content; side, whitespace,
  context and data revisions invalidate only the reads they affect.
- File-action widths come from ResizeObserver's completed layout. Synchronous
  width reads during entry mounting would force one layout per file.
- File wrappers use `overflow: clip` so they do not create a scroll box that
  captures the sticky horizontal scrollbar. Action masks clear the measured
  control area without reserving width; touch actions stay in normal flow.
- Stacked expansion limits bound simultaneous Pierre instances and their DOM.
  Visibility callbacks retain identity so opening the panel cannot rerender
  every collapsed entry in a long change.
- View hooks run in the order shown by `DiffView`. Their effects retain the
  original ordering, including expansion initialization before pending navigation.
- State and refs belong to the retained view instance. Passing them between
  hooks preserves their identities, cache scope and hidden-view lifecycle.
- An entry keeps its own loading, context expansion and hunk-mutation state.
  A nested repository reads its own status and exposes read-only file diffs.
- The toolbar adds no DOM wrappers. The shared scroll root,
  sticky headers, header-slot placement and review provider keep their hierarchy.

## Decisions

### Why content and file rendering stay in the view

The content states and file list use the view's closure as inline render calls.
Splitting them into components added fibers and a render prop whose only purpose
was to pass the closure through dozens of props.

### Why the toolbar accepts action children

Repository, comparison and review actions are composed where their state lives.
The toolbar owns its row, fit measurement and options menu. Its props describe
those controls directly, so it has no type dependency on the view hooks.

### Why hook inputs use domain contracts

The hooks accept the values and actions they use. Deriving their inputs from
another view hook's entire return type tied unrelated responsibilities together
and made the setup hook a second copy of the component's prologue.

### Why stable setters and refs stay out of dependency lists

State setters, store actions and the refs passed by the retained view keep their
identities for its lifetime. The lists retain the original reactive dependencies;
including stable inputs would suggest changes that never occur.
