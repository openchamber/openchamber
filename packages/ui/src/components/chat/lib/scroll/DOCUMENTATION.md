# Chat scroll

The transcript is a LegendList (`@legendapp/list`) owned by `useChatTimelineScroll`. These files hold the scroll logic that list does not do on its own: anchoring, end-keeping, restore and the mobile keyboard glide.

## Keeping the end

- **While rows re-wrap after a width change, LegendList's `totalSize` / `contentLength` lag a frame** (they still hold pre-wrap row sizes). Scrolling to "the end" from them, or from `scrollHeight`, lands on a blank tail or short. Use the measured bottom of the last real row: `resolveRealContentEndOffset` in `timelineScrollAnchoring.ts`.
- **The list footer counts.** `list.getState()` does not expose `footerSize`; the footer ends with a spacer (10vh on desktop, 40px on mobile), and its size arrives through the list's `onMetricsChange`. Ignoring it leaves the viewport about 80px short of the end.
- **End-keeping is ours, not the list's.** `MessageList` passes `maintainScrollAtEnd={false}`: the library's option did not keep the viewport pinned while one tail row grew during streaming. The hook's pin (a same-frame `scrollTop` write) keeps the chat at the end and holds the measured end through a width resize. Write `scrollTop` directly: `list.scrollToEnd()` per chunk goes through the library's programmatic-scroll bookkeeping and roughly doubles frame production.

## Measuring

Scroll measurements from a background or occluded tab lie: such a tab runs about one frame per 500 ms. Measure with a headless CDP probe that logs `scrollTop`, the maximum and the last row's bottom per frame (see `scripts/perf/DOCUMENTATION.md`, "Running An Isolated Copy"); a resize fix holds when `scrollTop` equals the maximum on every logged frame. For streaming cost, `profile:session` compares builds; also sample the distance from the end, because a build that stopped following looks faster.

The mobile keyboard side (`keyboardFollowGlide.ts`) is documented with the composer: `components/chat/composer/DOCUMENTATION.md`, "Mobile".
