import React from 'react';
import { RiCloseLine, RiFullscreenExitLine, RiFullscreenLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { DiffView, FilesView, PlanView } from '@/components/views';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanelContent } from './ContextSidebarTab';

const CONTEXT_PANEL_MIN_WIDTH = 360;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

export const ContextPanel: React.FC = () => {
  const { t } = useLanguage();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);

  const isOpen = Boolean(panelState?.isOpen && panelState?.mode);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  React.useEffect(() => {
    if (!isResizing || !directoryKey) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const delta = startXRef.current - event.clientX;
      setContextPanelWidth(directoryKey, startWidthRef.current + delta);
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
  }, [directoryKey, isResizing, setContextPanelWidth]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    event.preventDefault();
  }, [directoryKey, isExpanded, isOpen, width]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeContextPanel(directoryKey);
  }, [closeContextPanel, directoryKey]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey);
  }, [directoryKey, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose]);

  const activeFilePath = useFilesViewTabsStore((state) => (directoryKey ? (state.byRoot[directoryKey]?.selectedPath ?? null) : null));

  const panelTitle = panelState?.mode === 'diff'
    ? t('contextPanel.mode.diff')
    : panelState?.mode === 'file'
      ? t('contextPanel.mode.file')
      : panelState?.mode === 'context'
        ? t('contextPanel.mode.context')
        : panelState?.mode === 'plan'
          ? t('contextPanel.mode.plan')
          : t('contextPanel.mode.panel');
  const effectivePath = panelState?.mode === 'file' ? (activeFilePath ?? panelState?.targetPath ?? null) : panelState?.mode === 'context' ? null : (panelState?.targetPath ?? null);
  const pathLabel = getRelativePathLabel(effectivePath, effectiveDirectory);

  const content = panelState?.mode === 'diff'
    ? <DiffView hideStackedFileSidebar stackedDefaultCollapsedAll hideFileSelector pinSelectedFileHeaderToTopOnNavigate />
    : panelState?.mode === 'file'
      ? <FilesView mode="editor-only" />
      : panelState?.mode === 'context'
        ? <ContextPanelContent />
        : panelState?.mode === 'plan'
          ? <PlanView />
          : null;

  const header = (
    <header className="flex h-10 items-center gap-2 border-b border-border/40 px-2.5">
      <div className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
        <span>{panelTitle}</span>
        {pathLabel ? <span className="ml-2 text-muted-foreground">{pathLabel}</span> : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleToggleExpanded}
        className="h-6 w-6 p-0"
        title={isExpanded ? t('contextPanel.collapsePanel') : t('contextPanel.expandPanel')}
        aria-label={isExpanded ? t('contextPanel.collapsePanel') : t('contextPanel.expandPanel')}
      >
        {isExpanded ? <RiFullscreenExitLine className="h-3.5 w-3.5" /> : <RiFullscreenLine className="h-3.5 w-3.5" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleClose}
        className="h-6 w-6 p-0"
        title={t('contextPanel.closePanel')}
        aria-label={t('contextPanel.closePanel')}
      >
        <RiCloseLine className="h-3.5 w-3.5" />
      </Button>
    </header>
  );

  if (!isOpen) {
    return null;
  }

  const panelStyle: React.CSSProperties = isExpanded
    ? {
        ['--oc-context-panel-width' as string]: '100vw',
      }
    : {
        width: `${width}px`,
        minWidth: `${width}px`,
        maxWidth: `${width}px`,
        ['--oc-context-panel-width' as string]: `${width}px`,
      };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      tabIndex={-1}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        !isExpanded && 'border-l border-border/40',
        isExpanded
          ? 'absolute inset-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        isResizing ? 'transition-none' : 'transition-[width] duration-200 ease-in-out'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {!isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[4px] cursor-col-resize transition-colors hover:bg-primary/50',
            isResizing && 'bg-primary'
          )}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.resizeContextPanel')}
        />
      )}
      {header}
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </aside>
  );
};
