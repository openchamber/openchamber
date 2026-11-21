import React from 'react';

type ElementSize = { width: number; height: number };

export function useElementSize<T extends HTMLElement>(): [React.RefCallback<T>, ElementSize | null] {
  const [size, setSize] = React.useState<ElementSize | null>(null);
  const ref = React.useCallback((element: T | null) => {
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
