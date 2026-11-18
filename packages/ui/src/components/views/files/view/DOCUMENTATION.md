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

- Position memory retains coordinates only, without editor instances or file
  contents. Editor positions are read before DOM teardown collapses offsets;
  preview cleanup keeps the last scroll event's coordinates.
- Local open-in-app actions exist only for paths on this machine. Remote hosts,
  including WSL, cannot hand their paths to this machine's default application.
- The unavailable-HTML action changes only the current file's mode. It cannot
  persist a code-first preference that follows the user to a direct connection.
- Markdown preview containers accept programmatic focus without entering the
  tab order, so their scoped find shortcut works after opening or clicking them.
  The find controls mount with the row even when their trigger moves into More.
- Mobile line comments collapse native text selection while the comment bar is
  open because the system copy/paste toolbar would cover it. The line-range
  decoration preserves the selected range; desktop keeps native selection.
- Git gutters accept an empty baseline only for a status-listed new file.
  Ignored and untracked-by-HEAD files can also return an empty original and must
  not appear wholly added. Refetch keys include the file's own status and branch,
  so unrelated status refreshes do not reload the baseline.
- Shiki token colors replace Lezer colors when enabled, while Lezer's language
  remains for indentation and folding. Competing highlighters cannot both color
  the same source.
- Phone search clears match options unavailable in its compact find bar, so a
  desktop option cannot silently narrow results without a way to change it.
- A file's freshness baseline advances only after an observed read. Unsaved
  text or draw.io edits and failed reads leave it pending. Text that becomes
  binary takes the full reload path so binary guards run before rendering.
- Known binaries never load as UTF-8 because a later autosave could corrupt
  them. Enterprise mode shows draw.io XML because its external frame would
  receive document contents.
- Virtualized code-preview keys include worker readiness and row height. The
  worker becoming ready or metrics changing must remount the file because Pierre
  reads those inputs at mount; pending highlights cannot stay on the main thread.
- The unsaved-change prompt stays modal without a separate Cancel action.
  Guarded save or discard permits one navigation without reopening the prompt.
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
