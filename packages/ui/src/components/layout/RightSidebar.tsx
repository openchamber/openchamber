import React from 'react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

const RIGHT_SIDEBAR_MIN_WIDTH = 400;
const RIGHT_SIDEBAR_MAX_WIDTH = 860;

interface RightSidebarProps {
  isOpen: boolean;
  children: React.ReactNode;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({ isOpen, children }) => {
  const rightSidebarWidth = useUIStore((state) => state.rightSidebarWidth);
  const setRightSidebarWidth = useUIStore((state) => state.setRightSidebarWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(rightSidebarWidth || 420);

  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const delta = startXRef.current - event.clientX;
      const nextWidth = Math.min(
        RIGHT_SIDEBAR_MAX_WIDTH,
        Math.max(RIGHT_SIDEBAR_MIN_WIDTH, startWidthRef.current + delta)
      );
      setRightSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizing, setRightSidebarWidth]);

  const appliedWidth = isOpen
    ? Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, rightSidebarWidth || 420))
    : 0;

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!isOpen) {
      return;
    }
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = appliedWidth;
    event.preventDefault();
  };

  return (
    <aside
      className={cn(
        'relative flex h-full overflow-hidden border-l border-border bg-sidebar',
        isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
        !isOpen && 'border-l-0'
      )}
      style={{
        width: `${appliedWidth}px`,
        minWidth: `${appliedWidth}px`,
        maxWidth: `${appliedWidth}px`,
        overflowX: 'clip',
      }}
      aria-hidden={!isOpen || appliedWidth === 0}
    >
      {isOpen && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[4px] cursor-col-resize hover:bg-primary/50 transition-colors',
            isResizing && 'bg-primary'
          )}
          onPointerDown={handlePointerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize right panel"
        />
      )}
      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 w-full flex-col transition-opacity duration-300 ease-in-out',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        aria-hidden={!isOpen}
      >
        {isOpen ? children : null}
      </div>
    </aside>
  );
};
