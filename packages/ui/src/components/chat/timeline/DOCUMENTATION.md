# Chat timeline

## Ownership

This module owns the shared virtualized transcript, row rendering, live-tail subscriptions and the navigation handle exposed by `MessageList`. Turn projection and row construction belong to `../lib/turns`. Scroll intent, end-following and viewport persistence belong to `../lib/scroll` and the owning chat hooks. The [scroll documentation](../lib/scroll/DOCUMENTATION.md) describes their shared scroll contract.

## Invariants

- History and the live tail share one virtualized list on every surface. A separate small-list path remounts history when a prepend crosses its threshold.
- Rows keep their React component identity when entering or leaving the live tail. A remount resets expansion state for a commit and lets the list measure a transient height that leaves following rows misplaced.
- Row containers do not recycle into other rows because expanded tools and reveal animations hold row-local state. Row types keep prompts, folds and messages in separate sizing pools to avoid repeated measurement across different shapes.
- `useChatTimelineScroll` owns end-following. The list's automatic end-following stays disabled because concurrent writers compete against unsettled content lengths. Visible-content compensation preserves the reader's row through prepends and subsequent measurements while end pinning is released; touch layouts defer size corrections until scrolling stops.
- Rows spanned by a selection stay mounted for the selection's lifetime. A sticky prompt leaves with its own turn, including when the next sticky prompt is further below.
- Scroll-container props expose presentation, focus and click handling only. The list retains ownership of scroll and layout callbacks. End-state callbacks report transitions so continuous scroll events do not propagate a callback every frame.
- Live parts overlay every assistant message in the tail, including completed steps whose base records can lag the part store. Otherwise a handoff to the next step can briefly unmount completed tool parts. The live entry is set during render before rows read it, and subscribers are notified after commit; only tail rows subscribe to this shared entry.
- In Grouped the tail's rows are built from the live parts too, not from message records alone: a record lands after its call is on screen, and the call would first stand outside its group. Rows read only the parts' kinds and states (`liveRowParts.ts`), so streamed text does not rebuild them.
- History entries depend on the tail's stable first message so streaming updates do not recreate static entries. List-facing callback identities stay stable to avoid re-rendering every mounted row. Height estimates are cached by unchanged row identity and layout metrics because the list repeatedly requests estimates before measuring.
- Duplicate messages retain the first occurrence's chronological position and the last occurrence's value, since prepended history can overlap newer live data.
- Activity expansion outlives the list so a restored reading position inside an open fold remains meaningful. Turn IDs are globally unique message IDs; changing the activity mode clears the bounded expansion cache.
- Navigation and anchor capture resolve only the list's own scroll container, including for retained hidden lists. Handle installation runs during layout so a parent's session-entry restore reaches the current list.
- A loaded reply can lack a row while its opening prompt remains in unloaded history. Navigation includes the live tail, maps folded messages to their fold or prompt, and opens folded Activity before alignment. Reasoning targets reveal the reasoning block, including reasoning in the final assistant message. Hoisted pages render once at turn level even when messages render under a fold.
- Anchors name a message slice when available and fall back to the message's first row if that slice disappears. Alignment reports `moved` after a scroll toward a potentially estimated position, `aligned` at the requested position or a clamped boundary, and `missing` when no row or container is available. `restoreViewportAnchor` accepts both available alignment states. `isHistoryVirtualized` remains available for callers that branch on it.
- Height estimates use the chat column's text content width and the layout's tool-line height. The fallback width calculation must track `.chat-message-column` in `typography.css`, and touch line heights must track the raised targets in `mobile.css`.

## Decisions

### Why navigation settles across frames and not in one scroll

Unmounted rows start at estimated offsets, and mounted targets can move when neighbours finish measuring. Navigation re-aligns until layout stabilizes within its frame limit and yields immediately to user input or a navigation-release event; scrolling an unmounted index is unanimated because a smooth scroll would finish at a stale estimate.

### Why the end fallback overshoots and not uses scrollHeight exactly

`scrollHeight` is integer-rounded while the true maximum can be fractional. Overshooting lets the browser clamp to the exact end.

### Why send animation is detected during render and not in an effect

A new user message needs its animation flag on its first render so it starts at zero opacity. An effect sets the flag after a visible frame and causes a flash.

### Why the variant comes from an early assistant step and not the prompt

The assistant message carries the variant used to run the turn. The first available assistant variant represents the selection shared by later steps and is available before the final answer exists.

### Why folds move rows and not a height

A fold's content is separate list rows, so no element's height can be animated.
`foldMotion.ts` compares row positions before the toggle and one frame after, once
the list has placed the new rows, then glides the rows below and clips the opened
ones along the same edge. Closed rows are unmounted at once, so inert copies
without identity attributes or embeds are clipped away in an overlay outside the
scroller, and the content clips its overflow meanwhile: neither may add scroll range. It animates the
list's row containers, because their `contain: paint` cuts off moved content.
Every animation shares one start time and holds its end until all are removed
together, or a copy that ends a frame early is drawn whole under a closed fold.
A group that closes itself when its work ends moves the same way: `RowsSnapshot`
reads the old positions in `getSnapshotBeforeUpdate`, the only point after the new
rows are known and before the DOM changes. Following the end shifts the fold line
itself then, so closing glides every row from where it was.

### Why the nesting indent is an inherited property and not a descendant selector

A row that becomes nested while mounted changed only its wrapper's class, and
Chrome left the column inside at its old indent.
