# Chat hooks

## Ownership

These hooks coordinate timeline history, turn projection, hash navigation and
the column-local quote-mark registry. The sync layer owns history retrieval,
[turn projection](../lib/turns/DOCUMENTATION.md) owns turn construction, and
[chat scroll](../lib/scroll/DOCUMENTATION.md) owns list positioning and follow.

## Invariants

- Derived timeline models use weak message-array keys so trimming or eviction
  can release transcripts.
- Prepend compensation captures geometry before fetching and applies it in a
  layout effect before paint. Background prepends require the same preservation;
  retaining the old first message identifies a prepend even when a tail append
  lands in the same commit.
- Loading-state commits keep a pending prepend snapshot armed and refresh its
  geometry so the eventual height delta counts only newly prepended rows.
- Bottom-pinned prepends return through `goToBottom`. Ordinary appends remain
  owned by auto-follow, because competing writes can produce viewport jiggle.
- Virtualized history owns its keyed prepend and measurement corrections.
  Controller anchor restoration is allowed once when virtualization first turns
  on, because that commit has no previous virtualized key state. Additional
  restoration can double the prepend delta or target changed indexes.
- Non-virtualized history preserves the anchor or added height itself. Its
  mobile momentum watchdog corrects only upward drift and stops on a new touch,
  leaving downward movement and content growth free to move the viewport.
- While pinned, the latest model turn determines the active rail entry before
  its DOM node is measurable. Navigation holds the target indicator through
  intermediate smooth-scroll spy reports until arrival or the timeout, which
  allows long session scrolls to finish.
- Message-history search uses mounted-list row availability when a list exists:
  a page can end within a turn and leave a stored reply without its prompt row.
  Search is bounded because deleted or reverted targets may never arrive, and
  waits for a competing history load because it can occupy the only load slot.
- Scroll-triggered history demand requires upward reader movement outside the
  interaction guard. Prepend compensation and settling events cannot demand
  another page.
- Hash navigation retries as turns load, but a reached hash applies only once
  per session visit so sending another turn cannot replay it. The session-reset
  effect precedes the hash effect so revisiting applies the hash again in the
  same commit.
- A notice after the last turn retires that turn from the live tail so it stays
  in history above the notice.

## Decisions

### Why desktop history loads before the top

The lead distance lets a fetched page land above the viewport while keyed
compensation remains precise. Waiting until the reader reaches the estimated
height region near the absolute top makes restoration visibly less precise.

### Why mobile history uses an explicit button

A prepend during an active touch gesture can race native momentum scrolling.
An explicit load from the natural top lets insertion start from a resting state.

### Why an underfilled desktop viewport loads one batch

A short initial window cannot scroll far enough to request history. One
automatic batch makes progress while the load-older button covers further demand.

### Why quote marks live outside column React state

The composer publishes marks to a stable column-local store read by the highlight
layer. Publishing marks, hovering chips and using their popovers therefore leave
the chat column's render unchanged.
