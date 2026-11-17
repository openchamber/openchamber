import React from 'react';

const rootScrollTargets = (): HTMLElement[] => {
  const targets = [document.documentElement, document.body];
  const appRoot = document.getElementById('root');
  if (appRoot) targets.push(appRoot);
  return targets;
};

export const resetRootScroll = (): boolean => {
  let reset = false;
  for (const target of rootScrollTargets()) {
    if (target.scrollTop !== 0) {
      target.scrollTop = 0;
      reset = true;
    }
    if (target.scrollLeft !== 0) {
      target.scrollLeft = 0;
      reset = true;
    }
  }
  return reset;
};

export const isRootScrollTarget = (target: EventTarget | null): boolean =>
  target === document || rootScrollTargets().some((element) => element === target);

export const useRootScrollLock = (): void => {
  React.useEffect(() => {
    const handleScroll = (event: Event) => {
      if (isRootScrollTarget(event.target)) resetRootScroll();
    };
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    resetRootScroll();
    return () => document.removeEventListener('scroll', handleScroll, { capture: true });
  }, []);
};
