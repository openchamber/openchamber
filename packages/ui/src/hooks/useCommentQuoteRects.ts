import React from 'react';

import { collectSelectionOverlayRects } from '@/lib/selectionOverlayRects';

export const useCommentQuoteRects = (quoteRef: React.RefObject<{ range?: Range } | null>, commentOpen: boolean) => {
  const [commentRects, setCommentRects] = React.useState<DOMRect[] | null>(null);
  const updateCommentRects = React.useCallback(() => {
    const range = quoteRef.current?.range;
    setCommentRects(range ? collectSelectionOverlayRects(range) : null);
  }, [quoteRef]);

  React.useEffect(() => {
    if (!commentOpen) return;
    let frame: number | null = null;
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateCommentRects();
      });
    };
    document.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', scheduleUpdate, { capture: true });
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [commentOpen, updateCommentRects]);

  return { commentRects, setCommentRects, updateCommentRects };
};
