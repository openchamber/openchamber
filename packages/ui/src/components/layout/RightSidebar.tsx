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
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const sidebarRef = React.useRef<HTMLElement | null>(null);

  const clampRightSidebarWidth = React.useCallback((value: number) => {
    return Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, value));
  }, []);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const sidebar = sidebarRef.current;
    if (!sidebar) {
      return;
    }

    sidebar.style.setProperty('--oc-right-sidebar-width', `${nextWidth}px`);
  }, []);

  const appliedWidth = isOpen
    ? Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, rightSidebarWidth || 420))
    : 0;

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!isOpen) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = appliedWidth;
    resizingWidthRef.current = appliedWidth;
    applyLiveWidth(appliedWidth);
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    const delta = startXRef.current - event.clientX;
    const nextWidth = clampRightSidebarWidth(startWidthRef.current + delta);
    if (resizingWidthRef.current === nextWidth) {
      return;
    }

    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const finalWidth = clampRightSidebarWidth(resizingWidthRef.current ?? appliedWidth);
    activeResizePointerIDRef.current = null;
    resizingWidthRef.current = null;
    setIsResizing(false);
    setRightSidebarWidth(finalWidth);
  };

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
      activeResizePointerIDRef.current = null;
    }
  }, [isResizing]);

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'relative flex h-full overflow-hidden border-l border-border/40 bg-sidebar/50',
        isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
        !isOpen && 'border-l-0'
      )}
      style={{
        width: 'var(--oc-right-sidebar-width)',
        minWidth: 'var(--oc-right-sidebar-width)',
        maxWidth: 'var(--oc-right-sidebar-width)',
        ['--oc-right-sidebar-width' as string]: `${isResizing ? (resizingWidthRef.current ?? appliedWidth) : appliedWidth}px`,
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
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize right panel"
        />
      )}
      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 w-full flex-col transition-opacity duration-300 ease-in-out',
          isResizing && 'pointer-events-none',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        aria-hidden={!isOpen}
      >
        {isOpen ? children : null}
      </div>
    </aside>
  );
};
