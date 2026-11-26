import React from 'react';
import { LegendList, type LegendListRef } from '@legendapp/list/react';

import { resolveTimelineIsAtEnd } from '../lib/scroll/timelineScrollAnchoring';
import { estimateTimelineRowSize, type RowSizeMetrics } from '../lib/turns/rowSizeEstimate';
import { useSelectionRowHold } from '../lib/scroll/selectionRowHold';
import { isTouchLayout, readColumnWidth, readToolLineHeight } from './timelineMetrics';
import { TimelineRow } from './TimelineRow';
import { TimelineRowContext, type TimelineRowContextValue } from './timelineRowContext';
import type { ListMetrics, RenderRow, TimelineScrollContainerProps } from './types';

const TIMELINE_ESTIMATED_ENTRY_SIZE = 320;

const timelineKeyExtractor = (item: RenderRow): string => item.key;

const timelineItemType = (item: RenderRow): string => item.kind;

const renderTimelineItem = ({ item }: { item: RenderRow }) => <div data-list-row={item.key}><TimelineRow row={item} /></div>;

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
        const next = end < data.length ? state.elementAtIndex(end) : null;
        const scroller = listRef.current?.getScrollableNode();
        if (!next || !scroller) {
            element.style.transform = '';
            return;
        }
        const push = Math.min(0, next.getBoundingClientRect().top - scroller.getBoundingClientRect().top - element.offsetHeight);
        element.style.transform = push < 0 ? `translateY(${push}px)` : '';
    }, []);

    const handleScroll = React.useCallback(() => {
        const state = listRef.current?.getState();
        if (!state) return;
        if (stickyRowIndices) pushStickyHeader(state);
        const isAtEnd = resolveTimelineIsAtEnd(state);
        if (typeof isAtEnd !== 'boolean' || isAtEnd === isAtEndRef.current) return;
        isAtEndRef.current = isAtEnd;
        onIsAtEndChange(isAtEnd);
    }, [onIsAtEndChange, pushStickyHeader, stickyRowIndices]);

    React.useEffect(() => {
        onTimelineDataChange();
    }, [rows, onTimelineDataChange]);

    const header = React.useMemo(() => (listHeader ? <>{listHeader}</> : undefined), [listHeader]);
    const footer = React.useMemo(() => (listFooter ? <div data-list-row="footer">{listFooter}</div> : undefined), [listFooter]);

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
                recycleItems={false}
                contentInsetEndAdjustment={composerOverlayHeight}
                maintainScrollAtEnd={false}
                maintainVisibleContentPosition={{ data: true, size: endPinningReleased, deferSizeWhileScrolling: touchLayout }}
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
