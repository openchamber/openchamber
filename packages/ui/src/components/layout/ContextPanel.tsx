import React from 'react';
import { RiArrowLeftRightLine, RiChat4Line, RiCloseLine, RiDonutChartFill, RiFileTextLine, RiFullscreenExitLine, RiFullscreenLine, RiGlobalLine, RiRefreshLine, RiExternalLinkLine, RiPlayLine } from '@remixicon/react';

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
import { getProjectActionsState } from '@/lib/openchamberConfig';
import { readPackageJsonScripts, detectDevServerCommand } from '@/lib/detectDevServer';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { connectTerminalStream, createTerminalSession, sendTerminalInput } from '@/lib/terminalApi';
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

const TERMINAL_LOG_TAIL_CHARS = 800;

const collectTerminalTail = (
  tab: { bufferChunks: { data: string }[] } | undefined,
): string => {
  if (!tab?.bufferChunks?.length) return '';
  let combined = '';
  for (let i = tab.bufferChunks.length - 1; i >= 0; i -= 1) {
    combined = tab.bufferChunks[i].data + combined;
    if (combined.length >= TERMINAL_LOG_TAIL_CHARS) break;
  }
  // Strip ANSI escape sequences so the error message stays readable.
  // eslint-disable-next-line no-control-regex
  const stripped = combined.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
  const trimmed = stripped.trim();
  if (trimmed.length <= TERMINAL_LOG_TAIL_CHARS) return trimmed;
  return trimmed.slice(trimmed.length - TERMINAL_LOG_TAIL_CHARS);
};

const formatExitError = (
  tab: { bufferChunks: { data: string }[] } | undefined,
  t: TranslateFn,
): string => {
  const log = collectTerminalTail(tab);
  if (!log) return t('contextPanel.preview.serverExited');
  return t('contextPanel.preview.serverExitedWithLog', { log });
};

const formatNoUrlError = (
  tab: { bufferChunks: { data: string }[] } | undefined,
  t: TranslateFn,
): string => {
  const log = collectTerminalTail(tab);
  if (!log) return t('contextPanel.preview.noUrlDetected');
  return t('contextPanel.preview.noUrlDetectedWithLog', { log });
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

  // Out-of-band upstream probe: iframes don't expose HTTP status to the parent,
  // so when the proxy returns a 502 (upstream dev server is offline) the iframe
  // would just render the raw JSON error body. Probe the proxy URL with a HEAD
  // request and surface a friendly overlay when the upstream is unreachable.
  type UpstreamState = 'unknown' | 'starting' | 'reachable' | 'unreachable';
  const [upstreamState, setUpstreamState] = React.useState<UpstreamState>('unknown');
  const upstreamProbeStartedAtRef = React.useRef<number>(0);
  const upstreamProbeAttemptRef = React.useRef<number>(0);
  const PREVIEW_STARTUP_GRACE_MS = 15_000;

  React.useEffect(() => {
    if (!proxySrc) {
      setUpstreamState('unknown');
      upstreamProbeStartedAtRef.current = 0;
      upstreamProbeAttemptRef.current = 0;
      return;
    }

    let cancelled = false;
    if (!upstreamProbeStartedAtRef.current) {
      upstreamProbeStartedAtRef.current = Date.now();
      upstreamProbeAttemptRef.current = 0;
    }
    setUpstreamState('unknown');

    void (async () => {
      const probe = async (method: 'HEAD' | 'GET'): Promise<Response | null> => {
        try {
          return await fetch(proxySrc, {
            method,
            credentials: 'include',
            cache: 'no-store',
            redirect: 'manual',
          });
        } catch {
          return null;
        }
      };

      let response = await probe('HEAD');
      // Some dev servers reject HEAD with 404/405; fall back to a single GET.
      if (response && (response.status === 404 || response.status === 405)) {
        response = await probe('GET');
      }

      if (cancelled) return;

      if (!response) {
        // Network-level failure (e.g. server itself is down) — treat as unreachable.
        setUpstreamState('unreachable');
        return;
      }

      // The proxy emits 502 when the upstream is unreachable. Anything else
      // (including 4xx from the upstream) means the upstream answered.
      if (response.status !== 502) {
        setUpstreamState('reachable');
        return;
      }

      const startedAt = upstreamProbeStartedAtRef.current || Date.now();
      const elapsed = Date.now() - startedAt;
      if (elapsed < PREVIEW_STARTUP_GRACE_MS) {
        // Dev servers can take a moment to bind. During the grace window,
        // keep retrying and show a softer "starting" state.
        setUpstreamState('starting');
        upstreamProbeAttemptRef.current += 1;
        const attempt = upstreamProbeAttemptRef.current;
        const delay = Math.min(2000, 250 * Math.pow(2, Math.min(4, attempt)));
        setTimeout(() => {
          if (!cancelled) {
            bumpReload();
          }
        }, delay).unref?.();
        return;
      }

      setUpstreamState('unreachable');
    })();

    return () => {
      cancelled = true;
    };
  }, [proxySrc, reloadNonce]);

  const showUpstreamStarting = isLoopback
    && proxyState.status === 'ready'
    && upstreamState === 'starting';

  const showUpstreamUnreachable = isLoopback
    && proxyState.status === 'ready'
    && upstreamState === 'unreachable';

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
        {showUpstreamStarting ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.startingServer')}</div>
            <div className="text-xs opacity-70">{t('contextPanel.preview.startingServerHint')}</div>
          </div>
        ) : showUpstreamUnreachable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.upstreamUnreachable')}</div>
            <div className="text-xs opacity-70">{t('contextPanel.preview.upstreamUnreachableHint')}</div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => bumpReload()}
            >
              {t('contextPanel.preview.actions.retry')}
            </Button>
          </div>
        ) : effectiveSrc ? (
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
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const { themeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);

  // Check if there's a running preview
  const hasRunningPreview = tabs.some(tab => tab.mode === 'preview' && tab.targetPath);

  // Start Preview feature state
  const [isStartingPreview, setIsStartingPreview] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const createTab = useTerminalStore((state) => state.createTab);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabLifecycle = useTerminalStore((state) => state.setTabLifecycle);
  const setConnecting = useTerminalStore((state) => state.setConnecting);

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

  const handleStartPreview = React.useCallback(async () => {
    if (!effectiveDirectory || !directoryKey) return;
    
    setIsStartingPreview(true);
    setPreviewError(null);
    
    try {
      // Load project actions and package.json scripts
      const [actionsState, scripts] = await Promise.all([
        getProjectActionsState({ id: '', path: effectiveDirectory }),
        readPackageJsonScripts(effectiveDirectory),
      ]);
      
      // Detect the dev server command
      const devServer = await detectDevServerCommand(effectiveDirectory, actionsState.actions, scripts);
      
      if (!devServer) {
        setPreviewError(t('contextPanel.preview.noDevServer'));
        setIsStartingPreview(false);
        return;
      }
      
      // Ensure terminal directory exists
      ensureDirectory(effectiveDirectory);
      
      // Create a new terminal tab for the dev server
      const tabId = createTab(effectiveDirectory);
      setTabLabel(effectiveDirectory, tabId, `Preview: ${devServer.label}`);
      
      // Start the terminal session with the dev command
      const session = await createTerminalSession({
        cwd: effectiveDirectory,
      });
      
      setTabSessionId(effectiveDirectory, tabId, session.sessionId);
      setTabLifecycle(effectiveDirectory, tabId, 'running');

      // Ensure output is captured even if the terminal view isn't visible.
      // Without this, preview URL detection won't run and the context tab
      // won't open.
      setConnecting(effectiveDirectory, tabId, true);
      const disconnectStream = connectTerminalStream(
        session.sessionId,
        (event) => {
          if (event.type === 'data' && typeof event.data === 'string' && event.data.length > 0) {
            useTerminalStore.getState().appendToBuffer(effectiveDirectory, tabId, event.data);
          }
          if (event.type === 'exit') {
            setTabLifecycle(effectiveDirectory, tabId, 'exited');
          }
        },
        () => {
          // stream errors are handled by the poll timeout + lifecycle updates
        },
        { maxRetries: 60, initialRetryDelay: 250, maxRetryDelay: 2000, connectionTimeout: 5000 },
      );

      // Actually run the dev server command. Connect the stream first so we
      // don't miss early startup output containing the preview URL.
      await sendTerminalInput(session.sessionId, `${devServer.command}\n`);

      // Probe the hint URL directly so commands that don't print a recognizable
      // URL (or print it slowly) still get a preview tab once the upstream is
      // actually listening. We deliberately do NOT open the tab from the hint
      // alone: opening optimistically when the dev server hasn't bound (e.g.
      // python3 missing, port in use) produces a confusing 502 loop instead of
      // a clear error.
      const probeHintReachable = async (): Promise<boolean> => {
        if (!devServer.previewUrlHint) return false;
        try {
          const response = await fetch(devServer.previewUrlHint, {
            method: 'GET',
            cache: 'no-store',
            redirect: 'follow',
            mode: 'no-cors',
          });
          // `no-cors` returns an opaque response with status 0 on success;
          // any non-network failure indicates the upstream answered.
          return response.type === 'opaque' || response.status > 0;
        } catch {
          return false;
        }
      };

      const checkForPreviewUrl = async (): Promise<boolean> => {
        const state = useTerminalStore.getState().getDirectoryState(effectiveDirectory);
        const tab = state?.tabs.find(t => t.id === tabId);

        if (tab?.previewUrl) {
          openContextPreview(directoryKey, tab.previewUrl);
          setConnecting(effectiveDirectory, tabId, false);
          disconnectStream();
          return true;
        }

        if (await probeHintReachable() && devServer.previewUrlHint) {
          openContextPreview(directoryKey, devServer.previewUrlHint);
          setConnecting(effectiveDirectory, tabId, false);
          disconnectStream();
          return true;
        }

        if (tab?.lifecycle === 'exited') {
          setPreviewError(formatExitError(tab, t));
          setConnecting(effectiveDirectory, tabId, false);
          disconnectStream();
          return true;
        }

        return false;
      };

      // Poll for up to 30 seconds
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (await checkForPreviewUrl()) break;
      }

      // If we timed out without detecting a URL or an exit, show a clear error
      // including a tail of terminal output so the user can see why.
      const finalState = useTerminalStore.getState().getDirectoryState(effectiveDirectory);
      const finalTab = finalState?.tabs.find(t => t.id === tabId);
      if (!finalTab?.previewUrl && finalTab?.lifecycle !== 'exited') {
        setPreviewError(formatNoUrlError(finalTab, t));
      }

      setConnecting(effectiveDirectory, tabId, false);
      disconnectStream();
      
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : t('contextPanel.preview.startFailed'));
    } finally {
      setIsStartingPreview(false);
    }
  }, [effectiveDirectory, directoryKey, ensureDirectory, createTab, setTabLabel, setTabSessionId, setTabLifecycle, setConnecting, openContextPreview, t]);

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

  const showStartPreview = !hasRunningPreview && !isStartingPreview && !previewError;
  
  const activeNonChatContent = activeTab?.mode === 'diff'
    ? <DiffView hideStackedFileSidebar stackedDefaultCollapsedAll hideFileSelector pinSelectedFileHeaderToTopOnNavigate showOpenInEditorAction />
    : activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'plan'
            ? <PlanView targetPath={activeTab.targetPath} />
            : activeTab?.mode === 'preview'
                ? <PreviewPane rawUrl={activeTab.targetPath ?? ''} />
                : showStartPreview
                    ? (
                        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                            <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
                            <div className="space-y-2">
                                <div className="typography-ui-header text-foreground">
                                    {t('contextPanel.preview.title')}
                                </div>
                                <div className="typography-micro text-muted-foreground">
                                    {t('contextPanel.preview.description')}
                                </div>
                            </div>
                            {previewError ? (
                                <div className="typography-micro text-destructive">
                                    {previewError}
                                </div>
                            ) : null}
                            <Button
                                type="button"
                                variant="default"
                                size="sm"
                                onClick={handleStartPreview}
                                disabled={isStartingPreview || !effectiveDirectory}
                                className="gap-2"
                            >
                                <RiPlayLine className="h-3.5 w-3.5" />
                                {isStartingPreview ? t('contextPanel.preview.starting') : t('contextPanel.preview.startPreview')}
                            </Button>
                        </div>
                    )
                    : previewError
                        ? (
                            <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                                <div className="typography-micro text-destructive">
                                    {previewError}
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={handleStartPreview}
                                    disabled={isStartingPreview || !effectiveDirectory}
                                    className="gap-2"
                                >
                                    <RiPlayLine className="h-3.5 w-3.5" />
                                    {t('contextPanel.preview.startPreview')}
                                </Button>
                            </div>
                        )
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
        {!hasRunningPreview && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleStartPreview}
            className="h-7 px-2 gap-1"
            title={t('contextPanel.preview.startPreview')}
            aria-label={t('contextPanel.preview.startPreview')}
            disabled={isStartingPreview || !effectiveDirectory}
          >
            <RiPlayLine className="h-3.5 w-3.5" />
            {isStartingPreview ? t('contextPanel.preview.starting') : t('contextPanel.preview.startPreview')}
          </Button>
        )}
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
