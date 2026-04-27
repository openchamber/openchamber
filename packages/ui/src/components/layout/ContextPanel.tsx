import React from 'react';
import { RiArrowLeftRightLine, RiChat4Line, RiCloseLine, RiDonutChartFill, RiFileTextLine, RiFullscreenExitLine, RiFullscreenLine, RiGlobalLine, RiRefreshLine, RiExternalLinkLine } from '@remixicon/react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { DiffView, FilesView, PlanView } from '@/components/views';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { openExternalUrl } from '@/lib/url';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanelContent } from './ContextSidebarTab';

const CONTEXT_PANEL_MIN_WIDTH = 360;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];

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

const getModeLabel = (
  mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview',
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'preview') return t('contextPanel.mode.preview');
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview'; label: string | null; targetPath: string | null },
  t: TranslateFn
): string => {
  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'preview') {
    const url = tab.targetPath;
    if (url) {
      try {
        const parsed = new URL(url);
        return parsed.host || parsed.hostname || t('contextPanel.mode.preview');
      } catch {
        // ignore invalid URL
      }
    }
    return t('contextPanel.mode.preview');
  }

  return getModeLabel(tab.mode, t);
};

const getTabIcon = (tab: { mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview'; targetPath: string | null }): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <RiArrowLeftRightLine className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <RiFileTextLine className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <RiDonutChartFill className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <RiChat4Line className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'preview') {
    return <RiGlobalLine className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) {
    return null;
  }

  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

const buildEmbeddedSessionChatURL = (sessionID: string, directory: string | null): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('ocPanel', 'session-chat');
  url.searchParams.set('sessionId', sessionID);
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('directory', directory);
  } else {
    url.searchParams.delete('directory');
  }

  url.hash = '';
  return url.toString();
};

const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

type PreviewPaneProps = {
  rawUrl: string;
};

type PreviewProxyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; proxyBasePath: string; expiresAt: number }
  | { status: 'error'; message: string };

// Module-scoped, in-memory cache of registered proxy targets keyed by the
// fully-qualified upstream URL. Survives PreviewPane unmount/remount and tab
// switches, but intentionally does NOT survive a full page reload: the server
// holds the target map in memory and the auth cookie is HttpOnly + scoped to
// the proxy id, so a stale persisted entry would 404 after a server restart.
// Entries are evicted on registration error (refetched) or when the upstream
// returns 403 (cookie expired) / 404 (target unknown) at iframe load time.
type CachedProxyTarget = { proxyBasePath: string; expiresAt: number };
const previewProxyTargetCache = new Map<string, CachedProxyTarget>();
const PREVIEW_PROXY_CACHE_SAFETY_MS = 30_000;

const getCachedProxyTarget = (url: string): CachedProxyTarget | null => {
  const entry = previewProxyTargetCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt - Date.now() <= PREVIEW_PROXY_CACHE_SAFETY_MS) {
    previewProxyTargetCache.delete(url);
    return null;
  }
  return entry;
};

const PreviewPane: React.FC<PreviewPaneProps> = ({ rawUrl }) => {
  const { t } = useI18n();
  const [reloadNonce, bumpReload] = React.useReducer((x: number) => x + 1, 0);
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = rawUrl ? new URL(rawUrl) : null;
  } catch {
    parsedUrl = null;
  }

  const isLoopback = parsedUrl
    ? (parsedUrl.hostname === 'localhost'
        || parsedUrl.hostname === '127.0.0.1'
        || parsedUrl.hostname === '::1'
        || parsedUrl.hostname === '[::1]'
        || parsedUrl.hostname === '0.0.0.0')
    : false;

  const normalizedUrl = parsedUrl
    ? (parsedUrl.hostname === '0.0.0.0'
        ? new URL(parsedUrl.toString().replace('0.0.0.0', '127.0.0.1'))
        : parsedUrl)
    : null;

  const targetKey = normalizedUrl ? normalizedUrl.toString() : '';

  React.useEffect(() => {
    if (!targetKey || !isLoopback) {
      setProxyState({ status: 'idle' });
      return;
    }

    const cached = getCachedProxyTarget(targetKey);
    if (cached) {
      setProxyState({ status: 'ready', proxyBasePath: cached.proxyBasePath, expiresAt: cached.expiresAt });
      return;
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });

    void (async () => {
      try {
        const response = await fetch('/api/preview/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: targetKey }),
        });

        if (!response.ok) {
          previewProxyTargetCache.delete(targetKey);
          const errorBody = await response.json().catch(() => ({}));
          const message = typeof errorBody?.error === 'string'
            ? errorBody.error
            : `HTTP ${response.status}`;
          if (!cancelled) {
            setProxyState({ status: 'error', message });
          }
          return;
        }

        const body = await response.json() as { proxyBasePath?: unknown; expiresAt?: unknown };
        const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
        if (!proxyBasePath) {
          previewProxyTargetCache.delete(targetKey);
          if (!cancelled) {
            setProxyState({ status: 'error', message: t('contextPanel.preview.proxyError') });
          }
          return;
        }

        previewProxyTargetCache.set(targetKey, { proxyBasePath, expiresAt });
        if (!cancelled) {
          setProxyState({ status: 'ready', proxyBasePath, expiresAt });
        }
      } catch (error) {
        previewProxyTargetCache.delete(targetKey);
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setProxyState({ status: 'error', message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoopback, t, targetKey]);

  const directSrc = normalizedUrl
    && (normalizedUrl.protocol === 'http:' || normalizedUrl.protocol === 'https:')
    ? normalizedUrl.toString()
    : '';

  const proxySrc = isLoopback && proxyState.status === 'ready' && normalizedUrl
    ? (() => {
      const path = normalizedUrl.pathname || '/';
      const search = normalizedUrl.search || '';
      const hash = normalizedUrl.hash || '';
      return `${proxyState.proxyBasePath}${path}${search}${hash}`;
    })()
    : '';

  const effectiveSrc = isLoopback ? proxySrc : directSrc;
  const headerSrc = effectiveSrc || directSrc;
  const showLoading = isLoopback && (proxyState.status === 'loading' || proxyState.status === 'idle');
  const showError = isLoopback && proxyState.status === 'error';

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <div className="min-w-0 flex-1 truncate typography-micro text-muted-foreground" title={headerSrc || rawUrl}>
          {headerSrc || rawUrl || t('contextPanel.preview.empty')}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => bumpReload()}
          title={t('contextPanel.preview.actions.reload')}
          aria-label={t('contextPanel.preview.actions.reload')}
          disabled={!effectiveSrc}
        >
          <RiRefreshLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => {
            if (!directSrc) return;
            void openExternalUrl(directSrc);
          }}
          title={t('contextPanel.preview.actions.openExternal')}
          aria-label={t('contextPanel.preview.actions.openExternal')}
          disabled={!directSrc}
        >
          <RiExternalLinkLine className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-background">
        {effectiveSrc ? (
          <iframe
            key={`${effectiveSrc}:${reloadNonce}`}
            src={effectiveSrc}
            title={t('contextPanel.preview.iframeTitle')}
            className="h-full w-full border-0"
            sandbox={isLoopback
              ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
              : 'allow-scripts allow-forms'}
          />
        ) : showLoading ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {t('contextPanel.preview.loading')}
          </div>
        ) : showError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.proxyError')}</div>
            {proxyState.status === 'error' ? (
              <div className="text-center text-xs opacity-70">{proxyState.message}</div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {t('contextPanel.preview.invalidUrl')}
          </div>
        )}
      </div>
    </div>
  );
};

export const ContextPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const { themeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
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

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    panel.style.setProperty('--oc-context-panel-width', `${nextWidth}px`);
  }, []);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore; fallback listeners still handle drag
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    resizingWidthRef.current = width;
    applyLiveWidth(width);
    event.preventDefault();
  }, [applyLiveWidth, directoryKey, isExpanded, isOpen, width]);

  const handleResizeMove = React.useCallback((event: React.PointerEvent) => {
    if (!isResizing || activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    const delta = startXRef.current - event.clientX;
    const nextWidth = clampWidth(startWidthRef.current + delta);
    if (resizingWidthRef.current === nextWidth) {
      return;
    }

    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  }, [applyLiveWidth, isResizing]);

  const handleResizeEnd = React.useCallback((event: React.PointerEvent) => {
    if (activeResizePointerIDRef.current !== event.pointerId || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const finalWidth = resizingWidthRef.current ?? width;
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
    resizingWidthRef.current = null;
    setContextPanelWidth(directoryKey, finalWidth);
  }, [directoryKey, setContextPanelWidth, width]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
    }
  }, [isResizing]);

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

  React.useEffect(() => {
    if (!directoryKey || !activeTab) {
      return;
    }

    if (activeTab.mode === 'file' && activeTab.targetPath) {
      setSelectedFilePath(directoryKey, activeTab.targetPath);
      return;
    }

    if (activeTab.mode === 'diff' && activeTab.targetPath) {
      setPendingDiffFile(activeTab.targetPath);
    }
  }, [activeTab, directoryKey, setPendingDiffFile, setSelectedFilePath]);

  const activeChatTabID = activeTab?.mode === 'chat' ? activeTab.id : null;

  const postThemeSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const payload = {
      themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    };

    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const directThemeSync = (frameWindow as unknown as {
        __openchamberApplyThemeSync?: (themePayload: typeof payload) => void;
      }).__openchamberApplyThemeSync;

      if (typeof directThemeSync === 'function') {
        try {
          directThemeSync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage(
        {
          type: 'openchamber:theme-sync',
          payload,
        },
        window.location.origin,
      );
    }
  }, [currentTheme, darkThemeId, lightThemeId, themeMode]);

  const postEmbeddedVisibilityToChats = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    for (const [tabID, frame] of chatFrameRefs.current.entries()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const payload = { visible: activeChatTabID === tabID };
      const directVisibilitySync = (frameWindow as unknown as {
        __openchamberSetEmbeddedVisibility?: (visibilityPayload: typeof payload) => void;
      }).__openchamberSetEmbeddedVisibility;

      if (typeof directVisibilitySync === 'function') {
        try {
          directVisibilitySync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage(
        {
          type: 'openchamber:embedded-visibility',
          payload,
        },
        window.location.origin,
      );
    }
  }, [activeChatTabID]);

  React.useLayoutEffect(() => {
    const hasAnyChatTab = tabs.some((tab) => tab.mode === 'chat');
    if (!hasAnyChatTab) {
      return;
    }

    postThemeSyncToEmbeddedChat();
    postEmbeddedVisibilityToChats();
  }, [darkThemeId, lightThemeId, postEmbeddedVisibilityToChats, postThemeSyncToEmbeddedChat, tabs, themeMode]);

  const tabItems = React.useMemo(() => tabs.map((tab) => {
    const rawLabel = getTabLabel(tab, t);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
    };
  }), [effectiveDirectory, t, tabs]);

  const activeNonChatContent = activeTab?.mode === 'diff'
    ? <DiffView hideStackedFileSidebar stackedDefaultCollapsedAll hideFileSelector pinSelectedFileHeaderToTopOnNavigate showOpenInEditorAction />
    : activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'plan'
          ? <PlanView targetPath={activeTab.targetPath} />
          : activeTab?.mode === 'preview'
            ? <PreviewPane rawUrl={activeTab.targetPath ?? ''} />
            : null;

  const chatTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat'),
    [tabs],
  );
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';

  const header = (
    <header className="flex h-8 items-stretch border-b border-transparent">
      <SortableTabsStrip
        items={tabItems}
        activeId={activeTab?.id ?? null}
        onSelect={(tabID) => {
          if (!directoryKey) {
            return;
          }
          setActiveContextPanelTab(directoryKey, tabID);
        }}
        onClose={(tabID) => {
          if (!directoryKey) {
            return;
          }
          closeContextPanelTab(directoryKey, tabID);
        }}
        onReorder={(activeTabID, overTabID) => {
          if (!directoryKey) {
            return;
          }
          reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
        }}
        layoutMode="scrollable"
        variant="default"
      />
      <div className="flex items-center gap-1 px-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleToggleExpanded}
          className="h-7 w-7 p-0"
          title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
        >
          {isExpanded ? <RiFullscreenExitLine className="h-3.5 w-3.5" /> : <RiFullscreenLine className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.actions.closePanel')}
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <RiCloseLine className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  if (!isOpen) {
    return null;
  }

  const panelStyle: React.CSSProperties = isExpanded
    ? {
        ['--oc-context-panel-width' as string]: '100%',
        width: '100%',
        minWidth: '100%',
        maxWidth: '100%',
      }
    : {
        width: 'var(--oc-context-panel-width)',
        minWidth: 'var(--oc-context-panel-width)',
        maxWidth: 'var(--oc-context-panel-width)',
        ['--oc-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
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
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      {header}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {hasFileTabs ? (
          <div className={cn('absolute inset-0', isFileTabActive ? 'block' : 'hidden')}>
            <FilesView mode="editor-only" />
          </div>
        ) : null}
        {chatTabs.map((tab) => {
          const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
          if (!sessionID) {
            return null;
          }

          const src = buildEmbeddedSessionChatURL(sessionID, directoryKey || null);
          if (!src) {
            return null;
          }

          return (
            <iframe
              key={tab.id}
              ref={(node) => {
                if (!node) {
                  chatFrameRefs.current.delete(tab.id);
                  return;
                }
                chatFrameRefs.current.set(tab.id, node);
              }}
              src={src}
              title={t('contextPanel.iframe.sessionChatTitle', { sessionID })}
              className={cn(
                'absolute inset-0 h-full w-full border-0 bg-background',
                activeChatTabID === tab.id ? 'block' : 'hidden'
              )}
              onLoad={() => {
                postThemeSyncToEmbeddedChat();
                postEmbeddedVisibilityToChats();
              }}
            />
          );
        })}
        {activeTab?.mode !== 'chat' && !isFileTabActive ? activeNonChatContent : null}
      </div>
    </aside>
  );
};
