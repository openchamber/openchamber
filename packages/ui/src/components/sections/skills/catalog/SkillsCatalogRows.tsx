import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { shownRowsOf } from '@/lib/measure-shown-row';

import type { SkillsCatalogItem } from '@/lib/api/types';

const VIRTUAL_CATALOG_MIN_ROWS = 100;
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
    ...shownRowsOf(ESTIMATED_ROW_HEIGHT),
    overscan: 8,
    scrollMargin,
    getItemKey: (index) => (items[index] ? itemKey(items[index]) : index),
  });

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
