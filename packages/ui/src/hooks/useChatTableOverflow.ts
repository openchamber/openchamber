import React from 'react';
import { isRightToLeft } from '@/lib/i18n';

export function useChatTableOverflow(
  wrapper: React.RefObject<HTMLDivElement | null>,
  scrollArea: React.RefObject<HTMLElement | null>,
  table: React.RefObject<HTMLTableElement | null>,
  enabled: boolean,
): void {
  React.useLayoutEffect(() => {
    const scroller = scrollArea.current;
    const tableWrapper = wrapper.current;
    if (!enabled || !scroller || !tableWrapper || !tableWrapper.closest('[data-message-id]') || !tableWrapper.closest('[data-scrollbar="chat"]')) return;

    const updateOverflow = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const distanceFromStart = isRightToLeft(scroller) ? Math.abs(scroller.scrollLeft) : scroller.scrollLeft;
      const clampedDistance = Math.max(0, Math.min(maxScroll, distanceFromStart));
      if (clampedDistance > 1) tableWrapper.dataset.tableOverflowStart = 'true';
      else delete tableWrapper.dataset.tableOverflowStart;
      if (maxScroll - clampedDistance > 1) tableWrapper.dataset.tableOverflowEnd = 'true';
      else delete tableWrapper.dataset.tableOverflowEnd;
    };

    tableWrapper.dataset.chatTable = 'true';
    updateOverflow();
    scroller.addEventListener('scroll', updateOverflow, { passive: true });
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(scroller);
    if (table.current) observer.observe(table.current);
    return () => {
      scroller.removeEventListener('scroll', updateOverflow);
      observer.disconnect();
      delete tableWrapper.dataset.chatTable;
      delete tableWrapper.dataset.tableOverflowStart;
      delete tableWrapper.dataset.tableOverflowEnd;
    };
  }, [enabled, scrollArea, table, wrapper]);
}
