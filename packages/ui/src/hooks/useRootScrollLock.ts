import React from 'react';

/**
 * The document root (`html`, `body`, `#root`) is `overflow: hidden` and must
 * never scroll — every scrollable area lives in a dedicated container. Chromium
 * still scrolls hidden-overflow ancestors programmatically, most visibly when
 * a textarea caret moves out of view (PageUp/PageDown in the prompt box, or a
 * long prompt being typed) and the browser scrolls it into view. Once that
 * happens the whole app shifts up, hides the title bar, and nothing the user
 * does with the wheel or keyboard can scroll it back.
 *
 * Snap every root scroll straight back to zero.
 */

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
    // Capture: the root's own scroll events don't bubble to inner listeners,
    // and scroll events from inner containers are filtered out above.
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    resetRootScroll();
    return () => document.removeEventListener('scroll', handleScroll, { capture: true });
  }, []);
};
