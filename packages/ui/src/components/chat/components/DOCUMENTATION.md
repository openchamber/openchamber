# Chat turn controls

## Ownership

This module owns turn headers, activity-fold presentation and motion, prompt navigation, and the scroll-to-bottom pill. [Turn projection](../lib/turns/DOCUMENTATION.md) owns row construction and final-answer selection. [Chat scroll](../lib/scroll/DOCUMENTATION.md) owns viewport positioning, and [chat column](../column/DOCUMENTATION.md) owns session binding and placement around the composer.

## Invariants

- The prompt header alone names the turn in the DOM and supplies its sticky row. The fold and final answer occupy separate list rows, so the fold's `aria-controls` includes both content IDs when an answer exists.
- Final-answer identity comes from the projected rows. Live parts can finish an answer before the turn record supplies its row, so independently detecting completion here can fold content before an answer row exists.
- Shown pages remain visible through folding, including turns that end without an answer. Hoisted pages suppress their original tool rows to avoid duplicates; the final answer's text stays in the answer. While work continues, steps after the last page remain below it, even when trimming removes the page's original message from the preview.
- The collapsed preview uses one latest-row window across the content above and below shown pages. Expanding the fold keeps its header at the reader's click position.
- The sticky header's fade stays inside the user row's reserved gap so it cannot wash over following assistant content. The page and header background tokens agree; the desktop fade fits the 44 px reply gap and leaves 8 px of solid background below the bubble, while the mobile fade clears the always-visible actions.
- Mobile sticky-header spacing lets taps reach content underneath the gap. Header data variants restyle the user row so changing the sticky setting rerenders turns without rerendering every message.
- Pinned navigators leave the main chat's shortcut state unchanged. An open navigator retains browsing history because loading earlier prompts can otherwise trigger trimming while the reader uses the list.
- Opening the navigator centers the current prompt once. Later active-prompt updates leave the open list stationary, and prepending history preserves the previous first row's screen position and the highlighted prompt.
- Navigator row offsets are relative to its positioned list. Keyboard movement scrolls that list directly because `scrollIntoView` can also move the chat; loading earlier prompts preserves list focus.
- Picking a prompt suppresses hover reopening until the pointer leaves the corner. Pointer departure leaves a keyboard-opened panel available until selection, Escape, or blur.
- The navigator overlay lets pointer events through outside its indicator and panel so unused navigation space cannot block the transcript.
- The scroll pill shares the composer's input column and replaces the hidden status row away from the live edge. Its background-work action remains a sibling of the scroll button so the actions remain separate buttons, and both status presentations share the action label and shortcut.
- The pill's desktop height includes its border and matches the 28 px status row. Minimum height permits the mobile 36 px touch-target floor to grow the pill, and the flexible arrow container keeps a bare widened button's icon centered. The status label keeps a 20 px line box because truncation at 16 px clips tall font descenders.

## Decisions

### Why parse activity diffs after settling and not during streaming

The activity report appears only after the turn settles, so diff parsing stays off token-frequency updates. Later authoritative tool metadata can refine the settled report.

### Why collapse immediately and not animate row heights

The virtualized list preserves the reader's position when rows above change size. Immediate collapse leaves that positioning to the list.

### Why glide transforms and not layout positions

Transform-only motion replays rows moving upward without changing layout or scroll following. The last child supplies a growing, persistent anchor; relative rectangles cancel the shared running transform, and a disconnected anchor cannot establish a reliable movement delta.

### Why hold preview height and not follow every row shrink

Different row heights otherwise make an end-following reader alternate between moving down and being pulled up. The height floor leaves spare space below the latest row, grows before paint, resets after width changes, and releases shrinkage beyond 96 px so a departing large row cannot leave hundreds of empty pixels.

### Why use a fixed navigator glyph and not scale it with prompt count

A bounded tick indicator gives approximate session position while the panel owns prompt selection. Its footprint stays stable as history grows, and a hover delay avoids opening it when the pointer merely crosses the corner.

### Why give the navigator an opaque backing and not blur

The backing keeps transcript text from crossing through the ticks. Blur would redraw as content streams beneath the indicator.

### Why mirror status text and not reuse status-row animation

The scroll pill keeps a compact one-line status presentation because the status row's animation machinery does not fit its 28 px height.

### Why delay the background-work tooltip and not show it immediately

The button sits beside status text the reader follows while the agent works. The delay keeps passing pointer movement from covering that text with a tooltip.
