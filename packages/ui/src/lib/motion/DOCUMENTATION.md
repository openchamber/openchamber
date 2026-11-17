# Shared motion

## Ownership

This module owns spring timing, row disclosure geometry and content-size morphs. Components own their layout, and development tuning overrides only device-local development values.

## Invariants

- Size morphs measure layout dimensions because popup scale transforms distort bounding rectangles. The first reported layout establishes what the user actually saw after positioning caps the popup; later moves start at the last laid-out size, not a stale mount measurement.
- A content update with the same target continues the current move so virtualized row mounting cannot restart growth. Content changes retarget from the visible position, and clipping suppresses transient ellipses and overflow while the box moves.
- Callback refs start observation when portaled or conditional nodes arrive; ordinary refs are checked after commits because the node may mount after its owner. Hidden elements, unchanged dimensions and reduced-motion preferences produce no move.
- Disclosure fades follow the reveal boundary instead of an independent clock so the first visible rows appear as the gap opens. Closing text fades before the boundary crosses it to avoid overlapping readable rows.
- CSS times accept seconds as well as milliseconds because production minification changes units. Springs use their settle duration, and development tuning never changes production storage or runtime values.
