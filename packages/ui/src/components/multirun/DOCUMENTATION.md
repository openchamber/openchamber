# Multi-run controls and overview

## Ownership

This module owns multi-run selectors, lane cards and overview interactions. `lib/multirun` owns membership, lane data, launch, Keep and fusion operations and documents their contracts in its `DOCUMENTATION.md`.

## Invariants

- A branch list seeded from persisted cache contains only local branches. A positive fetch timestamp is required before the selector treats the list as fetched and skips loading remote branches.
- Variant captions retain the first prompt once loaded. Session updates do not change that prompt, so they do not trigger caption reads.
- Blocked-state glyphs and colors match the sidebar so waiting for user input has the same meaning in both places. A normal finish stays grey because a completed turn does not establish the quality of its work.
- Lane cards prioritize requests for user input and failures over reply previews. A stopped lane keeps its existing reply visible.
- Mobile supports the overview, fusion and Keep but does not launch lanes. Its overview supplies its own back button because the header has none.

## Decisions

### Why portal pickers and not container-only popups

The composer clips its contents, so its model picker mounts over the page through a portal. The popup anchors to the trigger's start edge, including its right edge in RTL layouts.

### Why separate popup height bounds and not one container bound

The multi-run launcher opens upward inside a scroller, while fusion opens downward and may extend beyond the dialog. Upward inline pickers respect the nearest dialog or overflow ancestor; downward and portal pickers use viewport space, reserving room for search and keyboard hints outside the scrollable model list.

### Why open new fusions and not existing results

A manual or automatic fusion that starts while the overview is open immediately opens its session because the user is waiting for that answer. Fusions present when the overview opens do not navigate away from it.

### Why one mobile card column and not the desktop grid

Two 280px card columns do not fit on a phone. Narrower cards clip their actions, so mobile keeps one card per row.
