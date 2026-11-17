# Files view composition

## Ownership

`FilesView.tsx` composes the file surface from this folder. Runtime adapters,
the tab store, shared editor helpers and artifact implementations remain owned
by their existing modules.

The state hook owns the surface's subscriptions, local state and refs. The
other hooks consume typed subsets of those values and own the named operation:
directory reads, saving, opening, freshness, closing, comments, navigation,
editor configuration, assets, preview modes or rendering. Their result types
define the dependencies between these operations.

## Invariants

- Hooks run unconditionally in the order shown in `FilesView`. Their effects
  retain the original order, including mode defaults before pending navigation.
- State, refs, effect dependencies, editor keys and lazy preview lifetimes
  survive the split unchanged.
- Docked and fullscreen render functions return the existing element trees.
  Exactly one guest canvas mounts, with its existing handoff and remount keys.
- The file position cache remains module-scoped and bounded to 100 entries.
- Runtime and directory guards still belong to the operation performing the
  read or write. Moving an operation does not change its authority.

## Decisions

### Why render functions preserve the element tree

The docked viewer, fullscreen viewer and tree panel are render functions.
Adding component boundaries would change the editor's position in React's
tree and could remount it during a file or mode switch.

### Why the keybind reads Markdown mode through a callback

The keybind registration precedes file-kind and preview-mode derivation.
Its callback reads those values only when a key is pressed, preserving the
original closure's evaluation time without moving the registration.

### Why lazy artifacts have a separate module

Lazy component identities are created once per module load. Keeping them out
of the preview hook preserves their lifetime and React Fast Refresh's
component-only module boundary.
