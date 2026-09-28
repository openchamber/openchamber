import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { TerminalView } from '@/components/views/TerminalView';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  BOTTOM_TERMINAL_MIN_HEIGHT,
  clampBottomTerminalHeight,
  normalizeContextPanelDirectoryKey,
  useUIStore,
} from '@/stores/useUIStore';

/** Space the chat keeps above a resized (not expanded) bottom terminal. */
const CHAT_MIN_HEIGHT = 160;

const maxHeightFor = (columnHeight: number | null): number | null => (
  columnHeight === null ? null : Math.max(BOTTOM_TERMINAL_MIN_HEIGHT, columnHeight - CHAT_MIN_HEIGHT)
);

const clampToColumn = (value: number, maxHeight: number | null): number => {
  const clamped = clampBottomTerminalHeight(value);
  return maxHeight === null ? clamped : Math.min(clamped, maxHeight);
};

type ResizeDrag = { pointerId: number; startY: number; startHeight: number; maxHeight: number | null; height: number };

/**
 * The terminal docked under the chat column (Settings → terminal position).
 * One panel for every directory: it shows the current directory's terminal,
 * honouring the target directory a project action pointed it at. The view
 * stays mounted once opened so hiding it does not rebuild the emulator.
 */
export const BottomTerminalPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';
  const docksAtBottom = useUIStore((state) => state.terminalPosition === 'bottom');
  const isOpen = useUIStore((state) => state.bottomTerminalOpen) && docksAtBottom && Boolean(directoryKey);
  const isExpanded = useUIStore((state) => state.bottomTerminalExpanded) && isOpen;
  const storedHeight = useUIStore((state) => state.bottomTerminalHeight);
  const targetDirectory = useUIStore((state) => (
    directoryKey
      ? state.contextPanelByDirectory[directoryKey]?.tabs.find((tab) => tab.mode === 'terminal')?.targetDirectory ?? null
      : null
  ));
  // Mirrors ContextPanel's `isOpen`: an open side panel paints its own left
  // divider, so this panel only needs one against the icon rail.
  const isContextPanelOpen = useUIStore((state) => {
    const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
    const activeMode = panel?.isOpen ? panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode : undefined;
    return Boolean(activeMode) && activeMode !== 'terminal';
  });
  const closeBottomTerminal = useUIStore((state) => state.closeBottomTerminal);
  const toggleTerminalExpanded = useUIStore((state) => state.toggleTerminalExpanded);
  const setBottomTerminalHeight = useUIStore((state) => state.setBottomTerminalHeight);

  const [hasOpened, setHasOpened] = React.useState(isOpen);
  React.useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);
  // Leaving bottom mode hands the terminal back to the side panel; keeping a
  // hidden view here would attach a second stream to the same PTY.
  React.useEffect(() => {
    if (!docksAtBottom) setHasOpened(false);
  }, [docksAtBottom]);

  const panelRef = React.useRef<HTMLElement | null>(null);
  const [columnHeight, setColumnHeight] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const column = panelRef.current?.parentElement;
    if (!column) {
      return;
    }
    const observer = new ResizeObserver(() => setColumnHeight(column.clientHeight || null));
    observer.observe(column);
    setColumnHeight(column.clientHeight || null);
    return () => observer.disconnect();
  }, [hasOpened]);

  const [dragHeight, setDragHeight] = React.useState<number | null>(null);
  const dragRef = React.useRef<ResizeDrag | null>(null);

  const maxHeight = maxHeightFor(columnHeight);
  const height = clampToColumn(dragHeight ?? storedHeight, maxHeight);

  const handleResizeStart = (event: React.PointerEvent) => {
    if (!isOpen || isExpanded) {
      return;
    }
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, maxHeight, height };
    setDragHeight(height);
    document.documentElement.style.cursor = 'row-resize';
    event.preventDefault();
  };

  const isResizing = dragHeight !== null;

  // Window-level listeners, as in ContextPanel: pointer capture over the
  // terminal canvas or iframes is unreliable and a missed pointerup would
  // leave the drag stuck.
  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const finish = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      document.documentElement.style.cursor = '';
      if (drag) {
        setBottomTerminalHeight(drag.height);
      }
      setDragHeight(null);
    };

    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      drag.height = clampToColumn(drag.startHeight + drag.startY - event.clientY, drag.maxHeight);
      setDragHeight(drag.height);
    };

    const handleUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        finish();
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', finish);
    };
  }, [isResizing, setBottomTerminalHeight]);

  React.useEffect(() => () => {
    document.documentElement.style.cursor = '';
  }, []);

  if (!hasOpened) {
    return null;
  }

  return (
    <section
      ref={panelRef}
      className={cn(
        'flex min-h-0 flex-col border-t border-border bg-background',
        isExpanded ? 'absolute inset-0 z-20' : 'relative shrink-0',
        !isOpen && 'hidden',
      )}
      style={isExpanded ? undefined : { height }}
      aria-label={t('layout.mainTab.terminal')}
    >
      {!isContextPanelOpen && (
        <div aria-hidden="true" className="absolute right-0 top-0 z-40 h-full w-px bg-border" />
      )}
      {!isExpanded && (
        <div
          className={cn(
            'absolute inset-x-0 -top-px z-50 h-[3px] cursor-row-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]',
          )}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('bottomTerminal.actions.resizePanelAria')}
        />
      )}
      <header className="flex h-10 shrink-0 items-stretch border-b border-border">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
          <Icon name="terminal-box" className="h-3.5 w-3.5" />
          <span className="truncate typography-ui-label text-foreground">{t('layout.mainTab.terminal')}</span>
        </div>
        <div className="flex items-center gap-1 px-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => toggleTerminalExpanded(directoryKey)}
            className="h-7 w-7 p-0"
            title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
            aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          >
            {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={closeBottomTerminal}
            className="h-7 w-7 p-0"
            title={t('contextPanel.actions.closePanel')}
            aria-label={t('contextPanel.actions.closePanel')}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <TerminalView visible={isOpen} directory={targetDirectory} />
      </div>
    </section>
  );
};
