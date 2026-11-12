import React from 'react';

import { bindStickyScrollbar } from './stickyScrollbarBinding';

/**
 * The horizontal scrollbar of a diff wider than its panel, kept at the bottom
 * of the visible part of the diff while the diff is taller than the panel
 * (#4850). Without it the code columns' own scrollbars sit after the last
 * line, so a mouse user scrolls the whole file down to scroll sideways. It
 * adds no scroll area of its own to the panel's vertical scrolling (#213).
 */
export const DiffStickyScrollbar: React.FC<{ containerRef: React.RefObject<HTMLDivElement | null> }> = ({ containerRef }) => {
  const barRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    const bar = barRef.current;
    if (!container || !bar) return;
    return bindStickyScrollbar(container, bar);
  }, [containerRef]);

  // The tracks repeat the code columns' scrolling for the pointer only. The
  // strip is opaque: it takes the clicks along the panel's bottom edge, so it
  // must not look like the code it covers.
  return <div ref={barRef} hidden aria-hidden="true" className="sticky bottom-0 z-10 h-2.5 bg-background" />;
};
