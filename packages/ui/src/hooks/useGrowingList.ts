import * as React from 'react';

const findScrollableAncestor = (start: HTMLElement | null): HTMLElement | null => {
  let node = start;
  while (node && node !== document.body) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
};

export function useGrowingList({ step, open, query }: { step: number; open: boolean; query: string }) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [limit, setLimit] = React.useState(step);

  const reset = React.useCallback(() => setLimit(step), [step]);

  const listEndRef = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined;
    const root = node.closest<HTMLElement>('[data-slot="command-list"]') ?? findScrollableAncestor(node.parentElement);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((current) => current + step);
    }, { root, rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [step]);

  React.useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    const scroller = content?.querySelector<HTMLElement>('[data-slot="command-list"]') ?? findScrollableAncestor(content);
    if (scroller) scroller.scrollTop = 0;
  }, [open, query]);

  return { limit, reset, listEndRef, contentRef };
}
