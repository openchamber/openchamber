import { describe, expect, test } from 'bun:test';
import { Virtualizer } from '@tanstack/react-virtual';

// The model picker virtualizes long provider sections inside one shared
// scroller, so each section's virtualizer carries a scrollMargin. The local
// virtual-core patch clamps the scroll offset; that clamp must work in the
// same scroller-absolute space as the offset, or a section sitting lower in
// the menu than its own height renders only its first rows (issue #4067).
const ROW = 31;
const COUNT = 49;
const VIEWPORT = 400;
const SECTION_TOP = 1500;

// SAFETY: the core touches the scroll element only through the observers
// below, which report fixed sizes, so an empty object stands in for it.
const scroller = {} as HTMLDivElement;

const visibleIndexes = (scrollTop: number): number[] => {
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: COUNT,
    getScrollElement: () => scroller,
    estimateSize: () => ROW,
    overscan: 0,
    scrollMargin: SECTION_TOP,
    scrollToFn: () => {},
    observeElementRect: (_instance, callback) => {
      callback({ width: 300, height: VIEWPORT });
      return () => {};
    },
    observeElementOffset: (_instance, callback) => {
      callback(scrollTop, false);
      return () => {};
    },
  });
  virtualizer._willUpdate();
  return virtualizer.getVirtualItems().map((item) => item.index);
};

describe('virtualized section below other content', () => {
  test('renders the rows under the viewport at every scroll position', () => {
    const middle = visibleIndexes(SECTION_TOP + 20 * ROW);
    expect(middle[0]).toBe(20);

    const bottom = visibleIndexes(SECTION_TOP + COUNT * ROW - VIEWPORT);
    expect(bottom.at(-1)).toBe(COUNT - 1);
  });
});
