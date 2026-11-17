# Changes view modules

## Ownership

`DiffView.tsx` composes the retained view's hooks, toolbar, content states and
file list. This folder owns those parts and the per-file entry. The public
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
- The toolbar and content modules add no DOM wrappers. The shared scroll root,
  sticky headers, header-slot placement and review provider keep their hierarchy.

## Decisions

### Why hooks share typed inputs

The comparison, navigation, refresh and find paths depend on the same retained
state. Explicit inputs derived from their owning hooks keep those dependencies
visible without adding a context provider or another state store.
