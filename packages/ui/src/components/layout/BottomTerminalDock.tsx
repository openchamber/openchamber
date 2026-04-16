import React from 'react';
import { RiCloseLine, RiFullscreenExitLine, RiFullscreenLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { m } from '@/lib/i18n/messages';

const BOTTOM_DOCK_MIN_HEIGHT = 180;
const BOTTOM_DOCK_MAX_HEIGHT = 640;
const BOTTOM_DOCK_COLLAPSE_THRESHOLD = 110;

interface BottomTerminalDockProps {
  isOpen: boolean;
  isMobile: boolean;
  children: React.ReactNode;
}

export const BottomTerminalDock: React.FC<BottomTerminalDockProps> = ({ isOpen, isMobile, children }) => {
  const bottomTerminalHeight = useUIStore((state) => state.bottomTerminalHeight);
  const isFullscreen = useUIStore((state) => state.isBottomTerminalExpanded);
  const setBottomTerminalHeight = useUIStore((state) => state.setBottomTerminalHeight);
  const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
  const setBottomTerminalExpanded = useUIStore((state) => state.setBottomTerminalExpanded);
  const [fullscreenHeight, setFullscreenHeight] = React.useState<number | null>(null);
  const [isResizing, setIsResizing] = React.useState(false);
  const dockRef = React.useRef<HTMLElement | null>(null);
  const startYRef = React.useRef(0);
  const startHeightRef = React.useRef(bottomTerminalHeight || 300);
  const previousHeightRef = React.useRef(bottomTerminalHeight || 300);

  const standardHeight = React.useMemo(
    () => Math.min(BOTTOM_DOCK_MAX_HEIGHT, Math.max(BOTTOM_DOCK_MIN_HEIGHT, bottomTerminalHeight || 300)),
    [bottomTerminalHeight],
  );

  React.useEffect(() => {
    if (!isOpen) {
      setFullscreenHeight(null);
      setIsResizing(false);
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (isMobile || !isOpen || !isFullscreen) {
      return;
    }

    const updateFullscreenHeight = () => {
      const parentHeight = dockRef.current?.parentElement?.getBoundingClientRect().height;
      if (!parentHeight || parentHeight <= 0) {
        return;
      }
      const next = Math.max(0, Math.round(parentHeight));
      setFullscreenHeight((prev) => (prev === next ? prev : next));
    };

    updateFullscreenHeight();

    const parent = dockRef.current?.parentElement;
    if (!parent) {
      return;
    }

    const observer = new ResizeObserver(updateFullscreenHeight);
    observer.observe(parent);

    return () => {
      observer.disconnect();
    };
  }, [isFullscreen, isMobile, isOpen]);

  React.useEffect(() => {
    if (isMobile || !isResizing || isFullscreen) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const delta = startYRef.current - event.clientY;
      const nextHeight = Math.min(
        BOTTOM_DOCK_MAX_HEIGHT,
        Math.max(BOTTOM_DOCK_MIN_HEIGHT, startHeightRef.current + delta)
      );
      setBottomTerminalHeight(nextHeight);
    };

    const handlePointerUp = () => {
      setIsResizing(false);
      const latestState = useUIStore.getState();
      if (latestState.bottomTerminalHeight <= BOTTOM_DOCK_COLLAPSE_THRESHOLD) {
        setBottomTerminalOpen(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isFullscreen, isMobile, isResizing, setBottomTerminalHeight, setBottomTerminalOpen]);

  if (isMobile) {
    return null;
  }

  const appliedHeight = isOpen
    ? (isFullscreen ? Math.max(0, fullscreenHeight ?? standardHeight) : standardHeight)
    : 0;

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!isOpen || isFullscreen) return;
    setIsResizing(true);
    startYRef.current = event.clientY;
    startHeightRef.current = appliedHeight;
    event.preventDefault();
  };

  const toggleFullscreen = () => {
    if (!isOpen) return;

    if (isFullscreen) {
      setBottomTerminalExpanded(false);
      const restoreHeight = Math.min(BOTTOM_DOCK_MAX_HEIGHT, Math.max(BOTTOM_DOCK_MIN_HEIGHT, previousHeightRef.current));
      setBottomTerminalHeight(restoreHeight);
      return;
    }

    previousHeightRef.current = standardHeight;
    setBottomTerminalExpanded(true);
  };

  return (
    <section
      ref={dockRef}
      className={cn(
        'relative flex overflow-hidden border-t border-border bg-sidebar',
        isResizing ? 'transition-none' : 'transition-[height] duration-300 ease-in-out',
        !isOpen && 'border-t-0'
      )}
      style={{
        height: `${appliedHeight}px`,
        minHeight: `${appliedHeight}px`,
        maxHeight: `${appliedHeight}px`,
      }}
      aria-hidden={!isOpen || appliedHeight === 0}
    >
      {isOpen && !isFullscreen && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-[3px] w-full cursor-row-resize hover:bg-[var(--interactive-border)]/80 transition-colors',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handlePointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label={m.lyResizeTerminalPanel()}
        />
      )}

      {isOpen && (
        <div className="absolute right-2 top-2 z-30 inline-flex items-center gap-1">
          <button
            type="button"
            onClick={toggleFullscreen}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title={isFullscreen ? m.lyRestoreTerminalPanelHeight() : m.lyExpandTerminalPanel()}
            aria-label={isFullscreen ? m.lyRestoreTerminalPanelHeight() : m.lyExpandTerminalPanel()}
          >
            {isFullscreen ? <RiFullscreenExitLine className="h-5 w-5" /> : <RiFullscreenLine className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={() => setBottomTerminalOpen(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title={m.lyCloseTerminalPanel()}
            aria-label={m.lyCloseTerminalPanel()}
          >
            <RiCloseLine className="h-6 w-6" />
          </button>
        </div>
      )}

      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 w-full flex-col transition-opacity duration-300 ease-in-out',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        aria-hidden={!isOpen}
      >
        {children}
      </div>
    </section>
  );
};
