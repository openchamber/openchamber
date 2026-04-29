import React from 'react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

const BOTTOM_DOCK_MIN_HEIGHT = 180;
const BOTTOM_DOCK_MAX_HEIGHT = 640;
const BOTTOM_DOCK_COLLAPSE_THRESHOLD = 110;

interface BottomTerminalDockProps {
  isOpen: boolean;
  isMobile: boolean;
  children: React.ReactNode;
}

export const BottomTerminalDock: React.FC<BottomTerminalDockProps> = ({ isOpen, isMobile, children }) => {
  const { t } = useI18n();
  const bottomTerminalHeight = useUIStore((state) => state.bottomTerminalHeight);
  const isFullscreen = useUIStore((state) => state.isBottomTerminalExpanded);
  const setBottomTerminalHeight = useUIStore((state) => state.setBottomTerminalHeight);
  const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
  const [fullscreenHeight, setFullscreenHeight] = React.useState<number | null>(null);
  const [isResizing, setIsResizing] = React.useState(false);
  const dockRef = React.useRef<HTMLElement | null>(null);
  const startYRef = React.useRef(0);
  const startHeightRef = React.useRef(bottomTerminalHeight || 300);

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

  return (
    <section
      ref={dockRef}
      className={cn(
        'flex overflow-hidden border-t border-border bg-sidebar',
        isFullscreen ? 'absolute inset-x-0 bottom-0 z-40' : 'relative',
        isResizing ? 'transition-none' : 'transition-[height] duration-300 ease-in-out',
        !isOpen && 'border-t-0'
      )}
      style={isFullscreen ? {
        top: 'var(--oc-header-height, 48px)',
      } : {
        height: `${appliedHeight}px`,
        minHeight: `${appliedHeight}px`,
        maxHeight: `${appliedHeight}px`,
      }}
      aria-hidden={!isOpen || (!isFullscreen && appliedHeight === 0)}
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
          aria-label={t('terminalView.bottomDock.resizeAria')}
        />
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
