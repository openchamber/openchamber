import React from 'react';

import { Toaster } from '@/components/ui/sonner';

const TOP_OFFSET = 'calc(var(--oc-safe-area-top, 0px) + var(--oc-visual-viewport-offset-top, 0px) + 16px)';
const MOBILE_OFFSET = {
  top: TOP_OFFSET,
  left: 'calc(var(--oc-safe-area-left, 0px) + 16px)',
  right: 'calc(var(--oc-safe-area-right, 0px) + 16px)',
};

// external: #3763 iOS Safari pans the visual viewport over the keyboard; the toaster offset tracks that pan on its wrapper to avoid restyling the chat.
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
      <Toaster position="top-center" layout="banner" offset={TOP_OFFSET} mobileOffset={MOBILE_OFFSET} />
    </div>
  );
}
