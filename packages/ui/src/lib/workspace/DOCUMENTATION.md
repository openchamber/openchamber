# Workspace zone state

## Ownership

This module owns pure zone placement, sizing decisions and drag-target geometry. The surface registry and mounted layout own availability and rendering; their contract is in `../surfaces/DOCUMENTATION.md`.

## Invariants

- Drag targets are measured once per drag and never overlap. The bottom target covers the chat column, while side targets cover their full-height columns or a narrow chat-edge strip when no column exists. In the context panel window the bottom target is the whole center column between the side targets, which are then full height (`computeCenterDropTargets`).
- Right is the unstored placement default and retains the legacy top-level view fields. Left and bottom use nested views; every resolved tab must still exist and belong to that zone.
- Moving the visible surface opens its destination and closes its source instead of choosing an unrelated tab. Empty zones close, and tree-only file zones suspend expansion without losing the saved flag.
- Opening a side zone preserves the chat minimum by folding the session sidebar before closing the opposite zone, because navigation is easier to recover. Expand targets focus first, then right, left and bottom; a closed zone's stale flag cannot turn an explicit expand into collapse.
