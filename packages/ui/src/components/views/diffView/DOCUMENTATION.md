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
