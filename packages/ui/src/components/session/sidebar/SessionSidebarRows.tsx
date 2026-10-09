import React from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import type { SessionSidebarRow, SessionSidebarRowModel } from './sessionSidebarRowModel';
import {
  estimateSessionSidebarRowSize,
  findFirstVisibleSessionSidebarRowIndex,
  getInitialSessionSidebarRowIndexes,
  mergeSessionSidebarVirtualIndexes,
  sectionSpacingAfter,
  sessionSidebarRowSizeKey,
} from './sessionSidebarVirtualization';

type Props = {
  model: SessionSidebarRowModel;
  scrollElement: HTMLElement | null;
  pinnedRowIndexes: ReadonlySet<number>;
  renderRow: (row: SessionSidebarRow, index: number) => React.ReactNode;
  onFirstVisibleIndexChange: (index: number) => void;
};

export function SessionSidebarRows({
  model,
  scrollElement,
  pinnedRowIndexes,
  renderRow,
  onFirstVisibleIndexChange,
}: Props): React.ReactNode {
  const rows = model.rows;
  const getScrollElement = React.useCallback(() => scrollElement, [scrollElement]);
  const measuredSizeByKeyRef = React.useRef(new Map<string, number>());
  const estimateSize = React.useCallback((index: number) => {
    const row = rows[index];
    if (!row) return 32;
    const nextRow = rows[index + 1];
    return measuredSizeByKeyRef.current.get(sessionSidebarRowSizeKey(row, nextRow))
      ?? estimateSessionSidebarRowSize(row, nextRow);
  }, [rows]);
  const measureRow = React.useCallback((
    element: HTMLDivElement,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLElement, HTMLDivElement>,
  ) => {
    const size = measureElement(element, entry, instance);
    const index = instance.indexFromElement(element);
    const row = rows[index];
    if (row) measuredSizeByKeyRef.current.set(sessionSidebarRowSizeKey(row, rows[index + 1]), size);
    return size;
  }, [rows]);
  const getItemKey = React.useCallback((index: number) => rows[index]?.key ?? index, [rows]);
  const rangeExtractor = React.useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    return mergeSessionSidebarVirtualIndexes(defaultRangeExtractor(range), pinnedRowIndexes, rows.length);
  }, [pinnedRowIndexes, rows.length]);

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

  if (!scrollElement) {
    const indexes = getInitialSessionSidebarRowIndexes(rows.length);
    const renderedHeight = indexes.reduce((total, index) => total + (rows[index]?.estimateSize ?? 0), 0);
    const estimatedTotal = rows.reduce((total, row) => total + row.estimateSize, 0);
    return <div data-sidebar-virtual-pending="true">
      {indexes.map((index) => {
        const row = rows[index];
        return row ? <div key={row.key} className={sectionSpacingAfter(row, rows[index + 1])}>{renderRow(row, index)}</div> : null;
      })}
      {estimatedTotal > renderedHeight ? <div aria-hidden="true" style={{ height: estimatedTotal - renderedHeight }} /> : null}
    </div>;
  }

  return <div data-sidebar-virtual-ready="true" style={{ height: totalSize, position: 'relative' }}>
    {virtualItems.map((item) => {
      const row = rows[item.index];
      if (!row) return null;
      return <div
        key={row.key}
        // Isolated virtual rows cannot collapse neighboring margins: 1px per side preserves the 2px gap.
        className={`[&_[data-session-row]]:my-px ${sectionSpacingAfter(row, rows[item.index + 1]) ?? ''}`}
        data-index={item.index}
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
        {renderRow(row, item.index)}
      </div>;
    })}
  </div>;
}
