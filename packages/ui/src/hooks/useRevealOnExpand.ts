import * as React from 'react';

export function useRevealOnExpand<T extends HTMLElement>(expanded: boolean, selector: string): React.RefObject<T | null> {
  const ref = React.useRef<T | null>(null);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!expanded || !node) return;
    const target = node.querySelector<HTMLElement>(selector);
    if (!target) return;
    node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
  }, [expanded, selector]);
  return ref;
}
