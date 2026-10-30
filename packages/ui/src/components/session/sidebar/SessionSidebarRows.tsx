import React from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';
import type { SessionSidebarRow, SessionSidebarRowModel } from './sessionSidebarRowModel';
import { SessionTreeGuides } from './sessions/SessionTreeGuides';
import { SESSION_TREE_BASE_PADDING_PX } from './sessions/sessionTreeGeometry';
import { findSessionSidebarDisclosure } from './sessionSidebarDisclosure';
import {
  boundaryClipKeyframes,
  boundaryFadeInKeyframes,
  ROW_DISCLOSURE_EASING,
  ROW_DISCLOSURE_FADE_OUT,
  ROW_DISCLOSURE_MS,
} from '@/lib/motion/rowDisclosure';
import {
  estimateSessionSidebarRowSize,
  findFirstVisibleSessionSidebarRowIndex,
  getInitialSessionSidebarRowIndexes,
  mergeSessionSidebarVirtualIndexes,
  sectionSpacingAfter,
  sectionWrapperClass,
  sessionSidebarRowSizeKey,
  sessionSidebarRowVirtualKey,
} from './sessionSidebarVirtualization';

/** A row a header just hid, drawn where it was while it folds away. */
type GhostRow = { row: SessionSidebarRow; nextRow: SessionSidebarRow | undefined; start: number; end: number };

/**
 * One header opening or closing: the rows under it are clipped above a
 * boundary moving `from` → `to`, and every row from `followingIndex` on slides
 * the same distance.
 */
type DisclosureMotion = {
  id: number;
  revealKeys: ReadonlySet<string>;
  ghosts: readonly GhostRow[];
  followingIndex: number;
  from: number;
  to: number;
  /**
   * Rows that slide down from on screen to past the virtual range: they stay
   * mounted until the motion ends, so the bottom of the list does not blank.
   */
  slidingIndexes: readonly number[];
};

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

type Props = {
  model: SessionSidebarRowModel;
  scrollElement: HTMLElement | null;
  pinnedRowIndexes: ReadonlySet<number>;
  renderRow: (row: SessionSidebarRow, index: number) => React.ReactNode;
  onFirstVisibleIndexChange: (index: number) => void;
  /** Where a level 0 row's slot starts, for the tree guides: the phone's rows sit further in. */
  guideSlotStartPx?: number;
  /** Brings a row to the middle of the list; a new `id` asks again for the same row. */
  scrollRequest?: { index: number; id: number } | null;
};

export function SessionSidebarRows({
  model,
  scrollElement,
  pinnedRowIndexes,
  renderRow,
  onFirstVisibleIndexChange,
  guideSlotStartPx = SESSION_TREE_BASE_PADDING_PX,
  scrollRequest = null,
}: Props): React.ReactNode {
  const rows = model.rows;
  const getScrollElement = React.useCallback(() => scrollElement, [scrollElement]);
  const measuredHeightByKeyRef = React.useRef(new Map<string, number>());
  const measuredGapBySpacingRef = React.useRef(new Map<string, number>());
  const estimateSize = React.useCallback((index: number) => {
    const row = rows[index];
    if (!row) return 32;
    const nextRow = rows[index + 1];
    return estimateSessionSidebarRowSize(row, nextRow, {
      height: measuredHeightByKeyRef.current.get(sessionSidebarRowSizeKey(row)),
      gapBySpacing: measuredGapBySpacingRef.current,
    });
  }, [rows]);
  const measureRow = React.useCallback((
    element: HTMLDivElement,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLElement, HTMLDivElement>,
  ) => {
    const size = measureElement(element, entry, instance);
    const index = instance.indexFromElement(element);
    const row = rows[index];
    if (row) {
      // Kept without the trailing gap, so a header that gains or loses its gap
      // as it closes or opens is estimated exactly the first time too.
      const spacing = sectionSpacingAfter(row, rows[index + 1]);
      const gap = spacing ? Number.parseFloat(getComputedStyle(element).paddingBottom) || 0 : 0;
      if (spacing) measuredGapBySpacingRef.current.set(spacing, gap);
      measuredHeightByKeyRef.current.set(sessionSidebarRowSizeKey(row), size - gap);
    }
    return size;
  }, [rows]);
  const getItemKey = React.useCallback((index: number) => {
    const row = rows[index];
    return row ? sessionSidebarRowVirtualKey(row, rows[index + 1]) : index;
  }, [rows]);
  const motionIdRef = React.useRef(0);
  const [motion, setMotion] = React.useState<DisclosureMotion | null>(null);
  const slidingIndexes = motion?.slidingIndexes;
  const rangeExtractor = React.useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    const pinned = slidingIndexes?.length ? new Set([...pinnedRowIndexes, ...slidingIndexes]) : pinnedRowIndexes;
    return mergeSessionSidebarVirtualIndexes(indexes, pinned, rows.length);
  }, [pinnedRowIndexes, rows.length, slidingIndexes]);

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    enabled: scrollElement !== null,
    getScrollElement,
    estimateSize,
    measureElement: measureRow,
    getItemKey,
    overscan: 8,
    rangeExtractor,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = scrollElement ? virtualizer.getTotalSize() : 0;
  const maximumScrollOffset = scrollElement
    ? Math.max(totalSize - scrollElement.clientHeight, 0)
    : 0;
  const scrollOffset = scrollElement
    ? Math.min(scrollElement.scrollTop, maximumScrollOffset)
    : 0;
  const firstVisibleIndex = findFirstVisibleSessionSidebarRowIndex(virtualItems, scrollOffset);
  React.useLayoutEffect(() => {
    onFirstVisibleIndexChange(firstVisibleIndex);
  }, [firstVisibleIndex, onFirstVisibleIndexChange]);

  React.useEffect(() => {
    if (scrollRequest && scrollElement) virtualizer.scrollToIndex(scrollRequest.index, { align: 'center' });
    // Asked once per request: the rows changing under it must not scroll again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest, scrollElement]);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const lastLayoutRef = React.useRef<{ rows: readonly SessionSidebarRow[]; measurements: readonly VirtualItem[] } | null>(null);

  // A header the user opened or closed: plan the motion from where the rows
  // were to where they are now. Runs before paint, and the state it sets
  // renders before paint too, so the first frame drawn is the motion's start.
  React.useLayoutEffect(() => {
    const last = lastLayoutRef.current;
    if (!last || last.rows === rows || !scrollElement || prefersReducedMotion()) return;
    const disclosure = findSessionSidebarDisclosure(last.rows, rows);
    if (!disclosure) return;
    const before = last.measurements;
    const after = virtualizer.measurementsCache;
    const headerBefore = before[disclosure.previousHeaderIndex];
    const headerAfter = after[disclosure.nextHeaderIndex];
    if (!headerBefore || !headerAfter) return;
    // Rows above the header normally stay put; carry any shift over anyway.
    const shift = headerAfter.start - headerBefore.start;
    const followingBefore = disclosure.opened ? before[disclosure.previousHeaderIndex + 1] : before[disclosure.blockEnd];
    const followingIndex = disclosure.opened ? disclosure.blockEnd : disclosure.nextHeaderIndex + 1;
    const followingAfter = after[followingIndex];
    const from = (followingBefore?.start ?? headerBefore.end) + shift;
    const to = followingAfter?.start ?? headerAfter.end;

    const top = scrollElement.scrollTop - scrollElement.clientHeight;
    const bottom = scrollElement.scrollTop + scrollElement.clientHeight * 2;
    const revealKeys = new Set<string>();
    const ghosts: GhostRow[] = [];
    const slidingIndexes: number[] = [];
    if (disclosure.opened) {
      for (let index = disclosure.blockStart; index < disclosure.blockEnd; index += 1) revealKeys.add(rows[index].key);
      for (let index = followingIndex; index < after.length && after[index].start + from - to < bottom; index += 1) {
        slidingIndexes.push(index);
      }
    } else {
      // Only the hidden rows near the viewport need drawing as they fold.
      for (let index = disclosure.blockStart; index < disclosure.blockEnd; index += 1) {
        const measured = before[index];
        if (!measured || measured.end + shift < top || measured.start + shift > bottom) continue;
        ghosts.push({ row: last.rows[index], nextRow: last.rows[index + 1], start: measured.start + shift, end: measured.end + shift });
      }
    }
    motionIdRef.current += 1;
    setMotion({ id: motionIdRef.current, revealKeys, ghosts, followingIndex, from, to, slidingIndexes });
  }, [rows, scrollElement, virtualizer]);

  // Recorded after the planning effect above reads it, on every commit, so it
  // always holds the layout the user last saw.
  React.useLayoutEffect(() => {
    lastLayoutRef.current = { rows, measurements: virtualizer.measurementsCache };
  });

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!motion || !container) return;
    const timing: KeyframeAnimationOptions = { duration: ROW_DISCLOSURE_MS, easing: ROW_DISCLOSURE_EASING };
    const distance = motion.from - motion.to;
    const animations: Animation[] = [];
    for (const element of container.children) {
      if (!(element instanceof HTMLElement)) continue;
      const key = element.dataset.sidebarRowKey ?? '';
      const start = Number(element.dataset.sidebarVirtualStart);
      if (element.dataset.sidebarGhost === 'true') {
        // Held shut after the end: the ghost unmounts a render later, and
        // unclipped for that frame it would flash over the rows below.
        animations.push(element.animate(boundaryClipKeyframes(start, element.offsetHeight, motion.from, motion.to), { ...timing, fill: 'forwards' }));
        animations.push(element.animate(ROW_DISCLOSURE_FADE_OUT, { ...timing, fill: 'forwards' }));
      } else if (motion.revealKeys.has(key)) {
        animations.push(element.animate(boundaryClipKeyframes(start, element.offsetHeight, motion.from, motion.to), timing));
        animations.push(element.animate(boundaryFadeInKeyframes(start, element.offsetHeight, motion.from, motion.to), timing));
      } else if (Number(element.dataset.index) >= motion.followingIndex && distance !== 0) {
        animations.push(element.animate([
          { transform: `translateY(${start + distance}px)` },
          { transform: `translateY(${start}px)` },
        ], timing));
      }
    }
    let cancelled = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setMotion((current) => (current?.id === motion.id ? null : current));
    }, () => undefined);
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
    };
  }, [motion]);

  // Tree guides draw over the row, so they show on its hover and selection
  // fills too. The box contains the row's margins, so the lines of
  // neighbouring rows meet across the gap between them.
  const renderRowWithGuides = (row: SessionSidebarRow, index: number): React.ReactNode => (row.treeGuides
    ? <div className="relative flow-root">
      {renderRow(row, index)}
      <SessionTreeGuides guides={row.treeGuides} slotStartPx={guideSlotStartPx} />
    </div>
    : renderRow(row, index));

  if (!scrollElement) {
    const indexes = getInitialSessionSidebarRowIndexes(rows.length);
    const renderedHeight = indexes.reduce((total, index) => total + (rows[index]?.estimateSize ?? 0), 0);
    const estimatedTotal = rows.reduce((total, row) => total + row.estimateSize, 0);
    return <div data-sidebar-virtual-pending="true">
      {indexes.map((index) => {
        const row = rows[index];
        return row ? <div key={row.key} className={sectionWrapperClass(row, rows[index + 1])}>{renderRowWithGuides(row, index)}</div> : null;
      })}
      {estimatedTotal > renderedHeight ? <div aria-hidden="true" style={{ height: estimatedTotal - renderedHeight }} /> : null}
    </div>;
  }

  const ghostsEnd = motion?.ghosts.reduce((end, ghost) => Math.max(end, ghost.end), 0) ?? 0;
  return <div ref={containerRef} data-sidebar-virtual-ready="true" style={{ height: Math.max(totalSize, ghostsEnd), position: 'relative' }}>
    {motion?.ghosts.map((ghost) => <div
      key={ghost.row.key}
      aria-hidden="true"
      inert
      className={`[&_[data-session-row-box]]:my-px ${sectionWrapperClass(ghost.row, ghost.nextRow)}`}
      data-sidebar-ghost="true"
      data-sidebar-row-key={ghost.row.key}
      data-sidebar-virtual-start={ghost.start}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        pointerEvents: 'none',
        transform: `translateY(${ghost.start}px)`,
      }}
    >
      {renderRowWithGuides(ghost.row, -1)}
    </div>)}
    {virtualItems.map((item) => {
      const row = rows[item.index];
      if (!row) return null;
      return <div
        key={row.key}
        // Isolated virtual rows cannot collapse neighboring margins: 1px per side preserves the 2px gap.
        // The row box, not the row: a session row in rename keeps the same margins.
        className={`[&_[data-session-row-box]]:my-px ${sectionWrapperClass(row, rows[item.index + 1])}`}
        data-index={item.index}
        data-sidebar-row-key={row.key}
        data-sidebar-virtual-start={item.start}
        ref={virtualizer.measureElement}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${item.start}px)`,
        }}
      >
        {renderRowWithGuides(row, item.index)}
      </div>;
    })}
  </div>;
}
