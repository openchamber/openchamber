import React from 'react';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export const useIsTextTruncated = <T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  deps: React.DependencyList = []
): boolean => {
  const [isTruncated, setIsTruncated] = React.useState(false);

  const checkTruncation = React.useCallback(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const next = element.scrollWidth > element.clientWidth + 1;
    setIsTruncated(next);
  }, [ref]);

  useIsomorphicLayoutEffect(() => {
    checkTruncation();
  }, [checkTruncation, ...deps]);

  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      checkTruncation();
    });
    observer.observe(element);
    return () => observer.disconnect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's, as in the layout effect above.
  }, [checkTruncation, ref, ...deps]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleResize = () => checkTruncation();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [checkTruncation]);

  return isTruncated;
};
