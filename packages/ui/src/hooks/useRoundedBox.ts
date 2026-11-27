import React from 'react';

export type RoundedBox = {
  width: number;
  height: number;
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
};

const sameBox = (a: RoundedBox | null, b: RoundedBox): boolean => (
  a !== null
  && a.width === b.width
  && a.height === b.height
  && a.topLeft === b.topLeft
  && a.topRight === b.topRight
  && a.bottomRight === b.bottomRight
  && a.bottomLeft === b.bottomLeft
);

export function useRoundedBox<T extends HTMLElement>(): [React.RefCallback<T>, RoundedBox | null] {
  const [box, setBox] = React.useState<RoundedBox | null>(null);
  const ref = React.useCallback((element: T | null) => {
    if (!element) return;
    const measure = (width: number, height: number) => {
      const style = getComputedStyle(element);
      const next: RoundedBox = {
        width,
        height,
        topLeft: parseFloat(style.borderTopLeftRadius) || 0,
        topRight: parseFloat(style.borderTopRightRadius) || 0,
        bottomRight: parseFloat(style.borderBottomRightRadius) || 0,
        bottomLeft: parseFloat(style.borderBottomLeftRadius) || 0,
      };
      setBox((previous) => (sameBox(previous, next) ? previous : next));
    };
    measure(element.offsetWidth, element.offsetHeight);
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0];
      if (size) measure(size.inlineSize, size.blockSize);
    });
    observer.observe(element, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}
