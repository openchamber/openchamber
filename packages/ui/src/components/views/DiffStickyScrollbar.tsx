import React from 'react';

import { bindStickyScrollbar } from './stickyScrollbarBinding';

export const DiffStickyScrollbar: React.FC<{ containerRef: React.RefObject<HTMLDivElement | null> }> = ({ containerRef }) => {
  const barRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    const bar = barRef.current;
    if (!container || !bar) return;
    return bindStickyScrollbar(container, bar);
  }, [containerRef]);

  return <div ref={barRef} hidden aria-hidden="true" className="sticky bottom-0 z-10 h-2.5 bg-background" />;
};
