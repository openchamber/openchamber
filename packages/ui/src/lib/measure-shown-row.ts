import { measureElement, type Virtualizer } from '@tanstack/react-virtual';

const measureShownRow = <Scroller extends Element, Row extends Element>(
  row: Row,
  entry: ResizeObserverEntry | undefined,
  list: Virtualizer<Scroller, Row>,
): number => {
  const size = measureElement(row, entry, list);
  if (size > 0) return size;
  const index = list.indexFromElement(row);
  return list.itemSizeCache.get(list.options.getItemKey(index)) || list.options.estimateSize(index);
};

export const shownRowsOf = (height: number) => ({ estimateSize: () => height, measureElement: measureShownRow });
