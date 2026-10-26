import React from 'react';

import { Toaster } from '@/components/ui/sonner';

// Below sonner's 600px breakpoint `mobileOffset` replaces `offset`, so both
// carry the same top: under the notch, inside the visible part of the screen.
const TOP_OFFSET = 'calc(var(--oc-safe-area-top, 0px) + var(--oc-visual-viewport-offset-top, 0px) + 16px)';

/**
 * Sonner fixes its toaster to the layout viewport. iOS Safari does not shrink
 * that viewport for the keyboard; it pans the visible area down over it, so a
 * top-anchored toast ended up above the screen while the keyboard was open
 * (#3763). The pan is mirrored into a CSS variable the offset adds. Where
 * nothing pans (Capacitor moves its own shell, resizing browsers) it stays 0.
 *
 * The variable lives on the toaster's wrapper: written on the root, every
 * frame of the keyboard animation would restyle the whole chat.
 */
function useVisualViewportOffsetTop(wrapperRef: React.RefObject<HTMLDivElement | null>): void {
  React.useEffect(() => {
    const viewport = window.visualViewport;
    const wrapper = wrapperRef.current;
    if (!viewport || !wrapper) return;
    let current = '';
    const apply = () => {
      const next = `${Math.max(0, Math.round(viewport.offsetTop))}px`;
      if (next === current) return;
      current = next;
      wrapper.style.setProperty('--oc-visual-viewport-offset-top', next);
    };
    apply();
    viewport.addEventListener('scroll', apply);
    viewport.addEventListener('resize', apply);
    return () => {
      viewport.removeEventListener('scroll', apply);
      viewport.removeEventListener('resize', apply);
    };
  }, [wrapperRef]);
}

export function MobileToaster() {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  useVisualViewportOffsetTop(wrapperRef);
  return (
    <div ref={wrapperRef} className="contents">
      <Toaster position="top-center" layout="banner" offset={TOP_OFFSET} mobileOffset={{ top: TOP_OFFSET }} />
    </div>
  );
}
