# Files view composition

## Ownership

`FilesView.tsx` composes the file surface from this folder. Runtime adapters,
the tab store, shared editor helpers and artifact implementations remain owned
by their existing modules.

Each operation owns its state. Directory listing owns its request coordinator
and snapshots; file operations own create, rename and delete dialogs and
mutations; comments own selection and comment UI; tabs own selection and their
overflow observer. Saving, canvases, preview modes, editor configuration and
navigation each declare their state in their owning module. The loaded
document model holds the read baseline shared by opening, saving and freshness.

`FilesView` passes named domain dependencies explicitly. A consumer takes only
the part of each domain it uses, with no combined surface-state object.
File-kind derivation performs no reads, navigation or editor-panel effects.
Image-folder navigation owns its own listing, and pending navigation owns its
editor mask. Mobile keyboard clearance and editor shortcuts are independent
of pending line navigation.

The toolbar composes mode actions, source tools, clipboard feedback, speech,
open-in-app items and save status. The docked viewer composes rendered slots;
Markdown, HTML, source editing, tabs and the discard dialog have their own
render functions.

## Invariants

- Hooks run unconditionally in the order shown in `FilesView`, including mode
  defaults before pending navigation.
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

### Why state declarations precede the operations that use them

Opening, saving and freshness share the loaded document and draft. Canvas
handoff also calls saving through the existing ref. Their state declarations
run before those operations, in the module that owns each state, so the split
keeps that lifecycle without introducing a surface-wide state container.

### Why the keybind reads Markdown mode through a callback

The keybind registration precedes file-kind and preview-mode derivation.
Its callback reads those values only when a key is pressed, preserving the
original closure's evaluation time without moving the registration.

### Why lazy artifacts have a separate module

Lazy component identities are created once per module load. Keeping them out
of the preview hook preserves their lifetime and React Fast Refresh's
component-only module boundary.
