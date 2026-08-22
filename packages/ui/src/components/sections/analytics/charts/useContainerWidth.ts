import { useEffect, useRef, useState } from 'react';

/**
 * Measures a container's pixel width via ResizeObserver. The container keeps
 * normal document flow (unlike @visx/responsive ParentSize, which can collapse
 * height when its inner layer is absolutely positioned). Width is 0 until the
 * first measure, so callers should reserve height via the parent.
 */
export function useContainerWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
