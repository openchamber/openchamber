import React from 'react';
import { measureElement, useVirtualizer } from '@tanstack/react-virtual';

import type { SkillsCatalogItem } from '@/lib/api/types';

// A source or a search can hold thousands of skills (one repository has 8,451),
// and mounting every row froze the page for half a minute on a source click
// and on each search keystroke. Lists this long mount only the rows near the
// viewport; shorter ones, most built-in catalogs among them, render plainly.
const VIRTUAL_CATALOG_MIN_ROWS = 100;
// A row with a two-line description at the default font size; every mounted
// row is measured, so this only places the rows not yet seen.
const ESTIMATED_ROW_HEIGHT = 84;

interface SkillsCatalogRowsProps {
  items: SkillsCatalogItem[];
  itemKey: (item: SkillsCatalogItem) => string;
  renderRow: (item: SkillsCatalogItem) => React.ReactNode;
}

const ROWS_CLASS = 'divide-y divide-[var(--surface-subtle)]';

export const SkillsCatalogRows: React.FC<SkillsCatalogRowsProps> = ({ items, itemKey, renderRow }) => {
  if (items.length < VIRTUAL_CATALOG_MIN_ROWS) {
    return (
      <div className={ROWS_CLASS}>
        {items.map((item) => <React.Fragment key={itemKey(item)}>{renderRow(item)}</React.Fragment>)}
      </div>
    );
  }
  return <VirtualSkillsCatalogRows items={items} itemKey={itemKey} renderRow={renderRow} />;
};

const VirtualSkillsCatalogRows: React.FC<SkillsCatalogRowsProps> = ({ items, itemKey, renderRow }) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = React.useState(0);
  // The list scrolls with the whole settings page, so the scroller is an
  // ancestor, found from the DOM like the model picker's sections do. The
  // virtualizer waits for it and starts from its current position: one that
  // attaches without it starts at offset 0 and scrolls a page the user had
  // already scrolled back to the top.
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    setScrollElement(listRef.current?.closest<HTMLElement>('.overlay-scrollbar-target') ?? null);
  }, []);
  const getScrollElement = React.useCallback(() => scrollElement, [scrollElement]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: items.length,
    enabled: scrollElement !== null,
    initialOffset: () => scrollElement?.scrollTop ?? 0,
    getScrollElement,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    // A hidden page measures every row at 0, which would fit the whole list
    // into the viewport and mount all of it; such a row keeps the estimate.
    measureElement: (element, entry, instance) => measureElement(element, entry, instance) || ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    scrollMargin,
    getItemKey: (index) => (items[index] ? itemKey(items[index]) : index),
  });

  // The list's offset in the page moves when the source cards or the error
  // banner above it change height.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    const content = scrollElement?.firstElementChild;
    if (!list || !scrollElement) return;
    const measure = () => {
      const next = list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
      setScrollMargin((previous) => (Math.abs(previous - next) < 0.5 ? previous : next));
    };
    measure();
    if (!content) return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollElement]);

  return (
    <div
      ref={listRef}
      className={`${ROWS_CLASS} relative w-full [overflow-anchor:none]`}
      // Before the scroller is found the list still takes its estimated
      // height: an empty list would shorten the page for that render and the
      // browser would clamp the user's scroll position.
      style={{ height: scrollElement ? virtualizer.getTotalSize() : items.length * ESTIMATED_ROW_HEIGHT }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            className="absolute inset-s-0 top-0 w-full"
            style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
          >
            {renderRow(item)}
          </div>
        );
      })}
    </div>
  );
};
