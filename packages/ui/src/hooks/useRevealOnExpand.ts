import * as React from 'react';

const isScroller = (node: HTMLElement): boolean => {
  const overflowY = getComputedStyle(node).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll';
};

export function useRevealOnExpand<T extends HTMLElement>(expanded: boolean): React.RefObject<T | null> {
  const ref = React.useRef<T | null>(null);
  React.useLayoutEffect(() => {
    if (!expanded) return;
    let scroller: HTMLElement | null = ref.current;
    while (scroller && !isScroller(scroller)) scroller = scroller.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [expanded]);
  return ref;
}
