import React from 'react';
import { LegendList, type LegendListRef } from '@legendapp/list/react';

import { resolveTimelineIsAtEnd } from '../lib/scroll/timelineScrollAnchoring';
import { estimateTimelineRowSize, type RowSizeMetrics } from '../lib/turns/rowSizeEstimate';
import { useSelectionRowHold } from '../lib/scroll/selectionRowHold';
import { isTouchLayout, readColumnWidth, readToolLineHeight } from './timelineMetrics';
import { TimelineRow } from './TimelineRow';
import { TimelineRowContext, type TimelineRowContextValue } from './timelineRowContext';
import type { ListMetrics, RenderRow, TimelineScrollContainerProps } from './types';

// --- Timeline virtualization (@legendapp/list) -----------------------------
// The timeline is a single virtualized list on every surface: history turns
// AND the live streaming tail are rows of the same list, so the list owns one
// coherent scroll position instead of arbitrating between a virtualizer and a
// separately-rendered tail.
//
// Scroll behavior the list owns natively, which is why none of it exists here
// any more:
//   • `maintainScrollAtEnd` keeps the live edge pinned as rows grow.
//   • `maintainVisibleContentPosition` preserves the read position when older
//     history is prepended, replacing the manual anchor-hold and the mobile
//     quiet-window prepend deferral.
const TIMELINE_ESTIMATED_ENTRY_SIZE = 320;

const timelineKeyExtractor = (item: RenderRow): string => item.key;

// Row type drives container reuse. Prompts, folds and messages have very
// different shapes, so keeping them in separate pools avoids re-measuring a
// container every time one replaces the other.
const timelineItemType = (item: RenderRow): string => item.kind;

const renderTimelineItem = ({ item }: { item: RenderRow }) => <TimelineRow row={item} />;

type TimelineListProps = {
    rows: RenderRow[];
    stickyRowIndices: number[] | undefined;
    registerList: (list: LegendListRef | null) => void;
    endPinningReleased: boolean;
    composerOverlayHeight: number;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onListMetricsChange: (metrics: ListMetrics) => void;
    onTimelineDataChange: () => void;
    listHeader?: React.ReactNode;
    listFooter?: React.ReactNode;
    scrollContainerProps?: TimelineScrollContainerProps;
    rowContext: TimelineRowContextValue;
    showReasoningTraces: boolean;
    collapsibleThinkingBlocks: boolean;
};

export const TimelineList = React.memo(({
    rows,
    stickyRowIndices,
    registerList,
    endPinningReleased,
    composerOverlayHeight,
    onIsAtEndChange,
    onListMetricsChange,
    onTimelineDataChange,
    listHeader,
    listFooter,
    scrollContainerProps,
    rowContext,
    showReasoningTraces,
    collapsibleThinkingBlocks,
}: TimelineListProps) => {
    const listRef = React.useRef<LegendListRef | null>(null);
    const isAtEndRef = React.useRef(true);
    const [touchLayout] = React.useState(isTouchLayout);

    // Each row is placed at an estimate of its own height until measured
    // (`rowSizeEstimate.ts`).
    const sizeMetricsRef = React.useRef<RowSizeMetrics>({ columnWidth: 0, lineHeight: 32, showReasoningTraces, collapsibleThinkingBlocks });
    sizeMetricsRef.current.showReasoningTraces = showReasoningTraces;
    sizeMetricsRef.current.collapsibleThinkingBlocks = collapsibleThinkingBlocks;
    const sizeMetrics = React.useCallback((): RowSizeMetrics => {
        const metrics = sizeMetricsRef.current;
        if (metrics.columnWidth <= 0) {
            metrics.columnWidth = Math.round(readColumnWidth(listRef.current?.getScrollableNode() ?? null));
            metrics.lineHeight = readToolLineHeight();
        }
        return metrics;
    }, []);
    // The list asks again on every pass over rows it has not measured; a row
    // whose content did not change keeps its object (`buildTimelineRows`).
    const estimatesRef = React.useRef(new WeakMap<RenderRow, { metrics: string; size: number | undefined }>());
    const estimateRowSize = React.useCallback((row: RenderRow): number | undefined => {
        const metrics = sizeMetrics();
        const signature = `${metrics.columnWidth}|${metrics.lineHeight}|${metrics.showReasoningTraces}|${metrics.collapsibleThinkingBlocks}`;
        const cached = estimatesRef.current.get(row);
        if (cached && cached.metrics === signature) return cached.size;
        const size = estimateTimelineRowSize(row, metrics);
        estimatesRef.current.set(row, { metrics: signature, size });
        return size;
    }, [sizeMetrics]);
    const [scrollerNode, setScrollerNode] = React.useState<HTMLElement | null>(null);
    React.useEffect(() => {
        if (!scrollerNode) return;
        const observer = new ResizeObserver(() => {
            sizeMetricsRef.current.columnWidth = Math.round(readColumnWidth(scrollerNode));
        });
        observer.observe(scrollerNode);
        return () => observer.disconnect();
    }, [scrollerNode]);

    const setListRef = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        setScrollerNode(list?.getScrollableNode() ?? null);
        registerList(list);
    }, [registerList]);

    React.useLayoutEffect(() => {
        isAtEndRef.current = true;
    }, []);

    // The list keeps a prompt row on top until the next one reaches the top
    // and covers it. A turn's prompt leaves with its turn instead: once the
    // turn's last row scrolls under it, it is pushed up by as much.
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const pushedHeaderRef = React.useRef<HTMLElement | null>(null);
    const pushStickyHeader = React.useCallback((state: ReturnType<LegendListRef['getState']>) => {
        const active = state.activeStickyIndex;
        const element = active >= 0 ? state.elementAtIndex(active) ?? null : null;
        const pushed = pushedHeaderRef.current;
        if (pushed && pushed !== element) pushed.style.transform = '';
        pushedHeaderRef.current = element;
        if (!element) return;
        const data = rowsRef.current;
        let end = active + 1;
        while (end < data.length && data[end].kind !== 'turn-head' && data[end].kind !== 'ungrouped') end += 1;
        // The turn's end is the top of the row after it; one not mounted is
        // far below, and the prompt stays where it sticks.
        const next = end < data.length ? state.elementAtIndex(end) : null;
        const scroller = listRef.current?.getScrollableNode();
        if (!next || !scroller) {
            element.style.transform = '';
            return;
        }
        const push = Math.min(0, next.getBoundingClientRect().top - scroller.getBoundingClientRect().top - element.offsetHeight);
        element.style.transform = push < 0 ? `translateY(${push}px)` : '';
    }, []);

    // The list reports scroll continuously; only end-crossings are interesting,
    // so the edge is debounced to a state transition here rather than pushing a
    // callback on every frame.
    const handleScroll = React.useCallback(() => {
        const state = listRef.current?.getState();
        if (!state) return;
        if (stickyRowIndices) pushStickyHeader(state);
        const isAtEnd = resolveTimelineIsAtEnd(state);
        if (typeof isAtEnd !== 'boolean' || isAtEnd === isAtEndRef.current) return;
        isAtEndRef.current = isAtEnd;
        onIsAtEndChange(isAtEnd);
    }, [onIsAtEndChange, pushStickyHeader, stickyRowIndices]);

    // Data changes are the only moment an automatic correction can be needed;
    // the owning hook decides whether one actually applies.
    React.useEffect(() => {
        onTimelineDataChange();
    }, [rows, onTimelineDataChange]);

    const header = React.useMemo(() => (listHeader ? <>{listHeader}</> : undefined), [listHeader]);
    const footer = React.useMemo(() => (listFooter ? <>{listFooter}</> : undefined), [listFooter]);

    const alwaysRender = useSelectionRowHold(listRef);

    return (
        <TimelineRowContext.Provider value={rowContext}>
            <LegendList<RenderRow>
                ref={setListRef}
                data={rows}
                keyExtractor={timelineKeyExtractor}
                getItemType={timelineItemType}
                renderItem={renderTimelineItem}
                estimatedItemSize={TIMELINE_ESTIMATED_ENTRY_SIZE}
                getEstimatedItemSize={estimateRowSize}
                initialScrollAtEnd
                // Chat rows own internal state (expanded tool calls, reveal
                // animations); recycling a container into a different row would
                // carry that state across.
                recycleItems={false}
                contentInsetEndAdjustment={composerOverlayHeight}
                // Off: the owning hook (useChatTimelineScroll) is the only
                // writer that keeps the end in view, instantly at rest and as
                // a glide while output streams. With the list following too,
                // two writers issued competing scrolls for every growth step,
                // one of them against a content length the list had not
                // settled yet.
                maintainScrollAtEnd={false}
                // A prepend first positions rows using estimated heights;
                // later measurements must preserve the same visible row too.
                // Keep size compensation active while reading history, including
                // when scrolling mounts older rows above the viewport. A pinned
                // reader is held on the end by the owning hook instead.
                // On touch, a correction for rows measured above the reader
                // waits until the scroll stops (the scroll documentation, "A
                // row is placed at an estimate").
                maintainVisibleContentPosition={{ data: true, size: endPinningReleased, deferSizeWhileScrolling: touchLayout }}
                // The rows a selection spans stay mounted while it lasts.
                alwaysRender={alwaysRender}
                onScroll={handleScroll}
                onMetricsChange={onListMetricsChange}
                stickyHeaderIndices={stickyRowIndices}
                ListHeaderComponent={header}
                ListFooterComponent={footer}
                {...scrollContainerProps}
            />
        </TimelineRowContext.Provider>
    );
});

TimelineList.displayName = 'TimelineList';
