import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { DiffView } from '@/components/views/DiffView';
import { FilesView } from '@/components/views/FilesView';
import { PlanView } from '@/components/views/PlanView';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { openExternalUrl } from '@/lib/url';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore, type ContextPanelMode, type ContextPanelTab, type PendingDiffScope } from '@/stores/useUIStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession, useDirectoryStore } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { EmbeddedSessionFrames } from './EmbeddedSessionFrames';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { Icon } from "@/components/icon/Icon";
import { OpenChamberLogo } from "@/components/ui/OpenChamberLogo";
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { getOrCreateEmbeddedSessionChatURL, type EmbeddedSessionChatURLCacheEntry } from './contextPanelEmbeddedChat';
import {
  type PreviewElementMetadata,
  isPreviewElementMetadata,
  formatPreviewAnnotationMarkdown,
  renderPreviewScreenshot,
  desktopAnnotationToFile,
  getCachedProxyTarget,
  getBrowserProxyTargetKey,
  previewProxyTargetCache,
} from '@/lib/preview/screenshot-capture';

const CONTEXT_PANEL_MIN_WIDTH = 380;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];
const EMPTY_SESSION_TITLE_MAP = new Map<string, string>();

type PreviewConsoleEvent = {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'resource' | 'runtime';
  message: string;
  details?: string;
  ts: number;
};

type PreviewConsoleFilter = 'all' | 'errors' | 'warnings' | 'logs';

type PreviewBridgeMessage = {
  source?: string;
  version?: number;
  type?: string;
  level?: PreviewConsoleEvent['level'];
  args?: unknown[];
  message?: unknown;
  stack?: unknown;
  filename?: unknown;
  line?: unknown;
  column?: unknown;
  tag?: unknown;
  url?: unknown;
  outerHTML?: unknown;
  title?: unknown;
  ts?: unknown;
  target?: unknown;
  navigation?: unknown;
};


const PREVIEW_CONSOLE_EVENT_LIMIT = 200;

const getPreviewConsoleFilterMatch = (event: PreviewConsoleEvent, filter: PreviewConsoleFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'errors') return event.level === 'error' || event.level === 'runtime' || event.level === 'resource';
  if (filter === 'warnings') return event.level === 'warn';
  return event.level === 'log' || event.level === 'info' || event.level === 'debug';
};


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

const getAvailablePanelWidth = (panel: HTMLElement | null): number | null => {
  const parentWidth = panel?.parentElement?.clientWidth;
  if (!parentWidth || parentWidth <= 0) {
    return null;
  }

  return parentWidth;
};

const clampWidthToAvailableSpace = (width: number, panel: HTMLElement | null): number => {
  const clampedWidth = clampWidth(width);
  const availableWidth = getAvailablePanelWidth(panel);
  if (availableWidth === null) {
    return clampedWidth;
  }

  return Math.min(clampedWidth, Math.max(1, availableWidth));
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
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'preview') return t('contextPanel.mode.preview');
  if (mode === 'browser') return t('contextPanel.mode.browser');
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
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; dedupeKey?: string; sessionTitleFallback?: string | null; stagedDiff?: boolean },
  sessionTitleById: ReadonlyMap<string, string>,
  t: TranslateFn
): string => {
  if (tab.mode === 'chat') {
    const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
    if (sessionID) {
      const sessionTitle = sessionTitleById.get(sessionID)?.trim();
      if (sessionTitle) {
        return sessionTitle;
      }
    }

    const sessionTitleFallback = tab.sessionTitleFallback?.trim();
    if (sessionTitleFallback) {
      return sessionTitleFallback;
    }

    return t('contextPanel.mode.chat');
  }

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

  if (tab.mode === 'diff') {
    return t('contextPanel.mode.diff');
  }

  return getModeLabel(tab.mode, t);
};

const getTabIcon = (tab: { mode: ContextPanelMode; targetPath: string | null }): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <Icon name="arrow-left-right" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <Icon name="file-text" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'preview') {
    return <Icon name="global" className="h-3.5 w-3.5 text-[var(--status-info)]" />;
  }

  if (tab.mode === 'browser') {
    return <Icon name="global" className="h-3.5 w-3.5" />;
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

const areTitleMapsEqual = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

const buildSessionTitleMap = (sessions: Array<{ id: string; title?: string | null }>, sessionIDs: readonly string[]): Map<string, string> => {
  if (sessionIDs.length === 0) return EMPTY_SESSION_TITLE_MAP;
  const wanted = new Set(sessionIDs);
  const next = new Map<string, string>();
  for (const session of sessions) {
    if (!wanted.has(session.id)) continue;
    const title = session.title?.trim();
    if (title) next.set(session.id, title);
  }
  return next.size === 0 ? EMPTY_SESSION_TITLE_MAP : next;
};

const useSessionTitleMap = (directory: string | undefined, sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const store = useDirectoryStore(directory);
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;

  return React.useSyncExternalStore(
    store.subscribe,
    React.useCallback(() => {
      const next = buildSessionTitleMap(store.getState().session, sessionIDsRef.current);
      if (areTitleMapsEqual(snapshotRef.current, next)) {
        return snapshotRef.current;
      }
      snapshotRef.current = next;
      return next;
    }, [store]),
    () => EMPTY_SESSION_TITLE_MAP,
  );
};

const DESKTOP_BROWSER_INSPECT_SCRIPT = `new Promise((resolve) => {
  const existing = document.getElementById('__openchamber_desktop_browser_overlay');
  if (existing) existing.remove();
  if (typeof window.__openchamberDesktopBrowserCancelInspect === 'function') {
    try { window.__openchamberDesktopBrowserCancelInspect(); } catch { /* webview not ready */ }
  }
  const overlay = document.createElement('div');
  overlay.id = '__openchamber_desktop_browser_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #60a5fa;background:rgba(96,165,250,.24);border-radius:3px;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);
  const cssEscape = (value) => {
    try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
  };
  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return tag + '#' + cssEscape(element.id);
    const className = String(element.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((part) => '.' + cssEscape(part)).join('');
    return tag + className;
  };
  const metadata = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
      ancestry.unshift({ tag: current.tagName.toLowerCase(), id: current.id || undefined, className: typeof current.className === 'string' ? current.className : undefined, selectorPart: selectorPart(current) });
      current = current.parentElement;
    }
    const attrs = {};
    for (const attr of Array.from(element.attributes || []).slice(0, 16)) attrs[attr.name] = attr.value.slice(0, 300);
    const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      selector: element.id ? '#' + cssEscape(element.id) : path,
      path,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes: attrs,
      computedStyle: { display: style.display, position: style.position, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily, color: style.color, backgroundColor: style.backgroundColor, zIndex: style.zIndex },
      ancestry,
    };
  };
  const move = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay || element === document.documentElement || element === document.body) return;
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };
  const cleanup = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', keydown, true);
    if (window.__openchamberDesktopBrowserCancelInspect === cancel) {
      delete window.__openchamberDesktopBrowserCancelInspect;
    }
  };
  const cancel = () => {
    cleanup();
    overlay.remove();
    resolve(null);
  };
  const click = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const result = element ? metadata(element) : null;
    cleanup();
    overlay.remove();
    resolve(result);
  };
  const keydown = (event) => {
    if (event.key !== 'Escape') return;
    cancel();
  };
  window.__openchamberDesktopBrowserCancelInspect = cancel;
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', keydown, true);
});`;

const DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT = `(() => {
  if (typeof window.__openchamberDesktopBrowserCancelInspect === 'function') {
    window.__openchamberDesktopBrowserCancelInspect();
    return;
  }
  const overlay = document.getElementById('__openchamber_desktop_browser_overlay');
  if (overlay) overlay.remove();
})()`;

const DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT = `(() => {
  if (window.__openchamberSameWebviewNavigationInstalled) return;
  window.__openchamberSameWebviewNavigationInstalled = true;

  const navigate = (rawUrl) => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      window.location.assign(url.href);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (navigate(url)) return null;
    return originalOpen(url, target, features);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[target="_blank"][href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!navigate(anchor.href)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})()`;

const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'about:blank';
    return parsed.toString();
  } catch {
    return 'about:blank';
  }
};

const runIframeScript = async <T,>(iframe: HTMLIFrameElement, script: string): Promise<T> => {
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    throw new Error('Iframe window is not available');
  }

  const evaluate = (frameWindow as Window & { eval: (code: string) => unknown }).eval;
  const result = evaluate.call(frameWindow, script) as unknown;
  return await Promise.resolve(result) as T;
};


const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

type PreviewPaneProps = {
  rawUrl: string;
  onNavigate: (url: string) => void;
};

type PreviewProxyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; proxyBasePath: string; previewToken?: string; expiresAt: number }
  | { status: 'error'; message: string };

const getPreviewProxyOrigin = (proxySrc: string): string => {
  if (typeof window === 'undefined') return '';
  try {
    return new URL(proxySrc || window.location.href, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
};

const postPreviewBridgeMessage = (frameWindow: Window, proxySrc: string, payload: Record<string, unknown>): void => {
  const targetOrigin = getPreviewProxyOrigin(proxySrc);
  frameWindow.postMessage(payload, targetOrigin);
};

const stripPreviewTokenFromUrl = (value: string): string => {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('oc_preview_token');
    parsed.searchParams.delete('oc_client_token');
    parsed.searchParams.delete('oc_url_token');
    return parsed.toString();
  } catch {
    return value;
  }
};

const stripPreviewQueryParams = (value: string): string => {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('ocPreview');
    parsed.searchParams.delete('oc_preview_token');
    parsed.searchParams.delete('oc_client_token');
    parsed.searchParams.delete('oc_url_token');
    return parsed.toString();
  } catch {
    return value;
  }
};

const PreviewPane: React.FC<PreviewPaneProps> = ({ rawUrl, onNavigate }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [reloadNonce, bumpReload] = React.useReducer((x: number) => x + 1, 0);
  const [proxyRegistrationNonce, bumpProxyRegistration] = React.useReducer((x: number) => x + 1, 0);
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });
  const [urlAuthReadyKey, setUrlAuthReadyKey] = React.useState('');
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const nextConsoleEventIdRef = React.useRef(1);
  const [bridgeReady, setBridgeReady] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [consoleFilter, setConsoleFilter] = React.useState<PreviewConsoleFilter>('all');
  const [consoleEvents, setConsoleEvents] = React.useState<PreviewConsoleEvent[]>([]);
  const [inspectMode, setInspectMode] = React.useState(false);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

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
  const proxyCacheKey = targetKey ? `${getRuntimeApiBaseUrl() || 'same-origin'}|${targetKey}` : '';
  const previewColorScheme = currentTheme.metadata.variant;

  React.useEffect(() => {
    if (!targetKey || !isLoopback) {
      setProxyState({ status: 'idle' });
      return;
    }

    const cached = getCachedProxyTarget(proxyCacheKey);
    if (cached?.previewToken) {
      setProxyState({ status: 'ready', proxyBasePath: cached.proxyBasePath, previewToken: cached.previewToken, expiresAt: cached.expiresAt });
      return;
    }
    if (cached) {
      previewProxyTargetCache.delete(proxyCacheKey);
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });

    void (async () => {
      try {
        const response = await runtimeFetch('/api/preview/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: targetKey }),
        });

        if (!response.ok) {
          previewProxyTargetCache.delete(proxyCacheKey);
          const errorBody = await response.json().catch(() => ({}));
          const message = typeof errorBody?.error === 'string'
            ? errorBody.error
            : `HTTP ${response.status}`;
          if (!cancelled) {
            setProxyState({ status: 'error', message });
          }
          return;
        }

        const body = await response.json() as { proxyBasePath?: unknown; previewToken?: unknown; expiresAt?: unknown };
        const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
        const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
        if (!proxyBasePath || !previewToken) {
          previewProxyTargetCache.delete(proxyCacheKey);
          if (!cancelled) {
            setProxyState({ status: 'error', message: t('contextPanel.preview.proxyError') });
          }
          return;
        }

        previewProxyTargetCache.set(proxyCacheKey, { proxyBasePath, previewToken, expiresAt });
        if (!cancelled) {
          setProxyState({ status: 'ready', proxyBasePath, previewToken, expiresAt });
        }
      } catch (error) {
        previewProxyTargetCache.delete(proxyCacheKey);
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setProxyState({ status: 'error', message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoopback, proxyCacheKey, proxyRegistrationNonce, t, targetKey]);

  const directSrc = normalizedUrl
    && (normalizedUrl.protocol === 'http:' || normalizedUrl.protocol === 'https:')
    ? normalizedUrl.toString()
    : '';

  const proxyUrlAuthKey = isLoopback && proxyState.status === 'ready'
    ? `${proxyState.proxyBasePath}|${proxyState.previewToken || ''}|${reloadNonce}`
    : '';

  React.useEffect(() => {
    if (!proxyUrlAuthKey) {
      setUrlAuthReadyKey('');
      return;
    }

    let cancelled = false;
    setUrlAuthReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setUrlAuthReadyKey(proxyUrlAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [proxyUrlAuthKey]);

  const proxySrc = isLoopback && proxyState.status === 'ready' && normalizedUrl && urlAuthReadyKey === proxyUrlAuthKey
    ? (() => {
      const path = normalizedUrl.pathname || '/';
      const searchParams = new URLSearchParams(normalizedUrl.search);
      searchParams.delete('oc_url_token');
      searchParams.delete('oc_client_token');
      searchParams.set('ocPreview', String(reloadNonce));
      searchParams.set('oc_preview_token', proxyState.previewToken || '');
      const search = searchParams.toString();
      const hash = normalizedUrl.hash || '';
      return getRuntimeUrlResolver().authenticatedAsset(`${proxyState.proxyBasePath}${path}${search ? `?${search}` : ''}${hash}`);
    })()
    : '';

  const effectiveSrc = isLoopback ? proxySrc : directSrc;
  const headerSrc = isLoopback ? stripPreviewTokenFromUrl(proxySrc) : directSrc;
  const showLoading = isLoopback && (proxyState.status === 'loading' || proxyState.status === 'idle' || urlAuthReadyKey !== proxyUrlAuthKey);
  const showError = isLoopback && proxyState.status === 'error';

  const attachPreviewAnnotation = React.useCallback((target: PreviewElementMetadata) => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }

    const pageUrl = rawUrl || effectiveSrc || '';
    const viewport = typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 0, height: 0 };
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

    void (async () => {
      let attachedScreenshot = false;
      try {
        const iframe = iframeRef.current;
        const screenshot = iframe ? await renderPreviewScreenshot(iframe, target) : null;
        if (screenshot) {
          await addAttachedFile(screenshot);
          attachedScreenshot = true;
        }
      } catch {
        attachedScreenshot = false;
      }

      addInlineCommentDraft({
        sessionKey,
        source: 'preview-annotation',
        fileLabel: pageUrl || 'preview',
        startLine: 1,
        endLine: 1,
        code: formatPreviewAnnotationMarkdown({
          pageUrl,
          viewport,
          devicePixelRatio,
          target,
          screenshotAttached: attachedScreenshot,
          intro: t('contextPanel.preview.inspect.attachAnnotation'),
        }),
        language: 'markdown',
        text: '',
      });
      toast.success(t('contextPanel.preview.inspect.attached'));
    })();
  }, [addAttachedFile, addInlineCommentDraft, currentSessionId, effectiveSrc, newSessionDraftOpen, rawUrl, t]);

  React.useEffect(() => {
    setBridgeReady(false);
    setConsoleEvents([]);
    setConsoleOpen(false);
    setConsoleFilter('all');
    setInspectMode(false);
    setHoverTarget(null);
    nextConsoleEventIdRef.current = 1;
  }, [effectiveSrc]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!bridgeReady || !frameWindow) {
      return;
    }
    postPreviewBridgeMessage(frameWindow, proxySrc, {
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled: inspectMode,
    });
  }, [bridgeReady, inspectMode, proxySrc]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!bridgeReady || !frameWindow) {
      return;
    }
    postPreviewBridgeMessage(frameWindow, proxySrc, {
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-color-scheme',
      scheme: previewColorScheme,
    });
  }, [bridgeReady, previewColorScheme, proxySrc]);

  React.useEffect(() => {
    if (!inspectMode || typeof window === 'undefined') return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setInspectMode(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [inspectMode]);

  React.useEffect(() => {
    if (!isLoopback || typeof window === 'undefined') {
      return;
    }

    const stringify = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const pushConsoleEvent = (event: Omit<PreviewConsoleEvent, 'id'>) => {
      const id = nextConsoleEventIdRef.current;
      nextConsoleEventIdRef.current += 1;
      setConsoleEvents((current) => {
        const next = [...current, { ...event, id }];
        return next.length > PREVIEW_CONSOLE_EVENT_LIMIT
          ? next.slice(next.length - PREVIEW_CONSOLE_EVENT_LIMIT)
          : next;
      });
    };

    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== 'openchamber-preview-bridge' || data.version !== 1) {
        return;
      }

      if (data.type === 'ready') {
        setBridgeReady(true);
        return;
      }

      if (data.type === 'console') {
        const level = data.level === 'error' || data.level === 'warn' || data.level === 'info' || data.level === 'debug'
          ? data.level
          : 'log';
        const args = Array.isArray(data.args) ? data.args.map(stringify).filter(Boolean) : [];
        pushConsoleEvent({
          level,
          message: args.join(' '),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'runtime-error') {
        const filename = stringify(data.filename);
        const line = typeof data.line === 'number' ? data.line : null;
        const column = typeof data.column === 'number' ? data.column : null;
        const location = filename
          ? `${filename}${line !== null ? `:${line}${column !== null ? `:${column}` : ''}` : ''}`
          : '';
        const stack = stringify(data.stack);
        pushConsoleEvent({
          level: 'runtime',
          message: stringify(data.message) || t('contextPanel.preview.console.runtimeError'),
          details: [location, stack].filter(Boolean).join('\n'),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'resource-error') {
        const tag = stringify(data.tag) || 'resource';
        const url = stringify(data.url);
        pushConsoleEvent({
          level: 'resource',
          message: url ? `${tag}: ${url}` : tag,
          details: stringify(data.outerHTML),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }

      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        setHoverTarget(data.target);
        setInspectMode(false);
        attachPreviewAnnotation(data.target);
        return;
      }

      if (data.type === 'navigate-preview') {
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        const navigation = data.navigation === 'external' ? 'external' : 'proxy';
        if (nextUrl && navigation === 'external') {
          void openExternalUrl(nextUrl);
          return;
        }
        if (nextUrl) {
          onNavigate(nextUrl);
        }
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, [attachPreviewAnnotation, isLoopback, onNavigate, t]);

  const consoleErrorCount = consoleEvents.filter((event) => event.level === 'error' || event.level === 'runtime' || event.level === 'resource').length;
  const filteredConsoleEvents = consoleEvents.filter((event) => getPreviewConsoleFilterMatch(event, consoleFilter));

  const copyConsoleEvents = React.useCallback(() => {
    const header = [
      `Preview URL: ${rawUrl || effectiveSrc || ''}`,
      `Events: ${consoleEvents.length}`,
      '',
    ].join('\n');
    const text = consoleEvents.map((event) => {
      const timestamp = new Date(event.ts).toISOString();
      const details = event.details ? `\n${event.details}` : '';
      return `[${timestamp}] [${event.level}] ${event.message}${details}`;
    }).join('\n');

    void copyTextToClipboard(`${header}${text}`).then((result) => {
      if (result.ok) {
        toast.success(t('contextPanel.preview.console.copied'));
      } else {
        toast.error(t('contextPanel.preview.console.copyFailed'));
      }
    });
  }, [consoleEvents, effectiveSrc, rawUrl, t]);

  const attachConsoleEvents = React.useCallback(() => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.console.attachNoSession'));
      return;
    }

    const header = [
      `Preview URL: ${rawUrl || effectiveSrc || ''}`,
      `Events: ${consoleEvents.length}`,
      '',
    ].join('\n');
    const text = consoleEvents.map((event) => {
      const timestamp = new Date(event.ts).toISOString();
      const details = event.details ? `\n${event.details}` : '';
      return `[${timestamp}] [${event.level}] ${event.message}${details}`;
    }).join('\n');

    addInlineCommentDraft({
      sessionKey,
      source: 'preview-console',
      fileLabel: rawUrl || effectiveSrc || 'preview',
      startLine: 1,
      endLine: Math.max(1, consoleEvents.length),
      code: `${header}${text}`,
      language: 'text',
      text: t('contextPanel.preview.console.attachAnnotation'),
    });
    toast.success(t('contextPanel.preview.console.attached'));
  }, [addInlineCommentDraft, consoleEvents, currentSessionId, effectiveSrc, newSessionDraftOpen, rawUrl, t]);

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
      const probe = async (): Promise<Response | null> => {
        try {
          return await runtimeFetch(proxySrc, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'manual',
          });
        } catch {
          return null;
        }
      };

      const response = await probe();

      if (cancelled) return;

      if (!response) {
        // Network-level failure (e.g. server itself is down) — treat as unreachable.
        setUpstreamState('unreachable');
        return;
      }

      if (response.status === 403 || response.status === 404) {
        previewProxyTargetCache.delete(proxyCacheKey);
        setProxyState({ status: 'loading' });
        bumpProxyRegistration();
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
  }, [proxyCacheKey, proxySrc, reloadNonce]);

  const showUpstreamStarting = isLoopback
    && proxyState.status === 'ready'
    && (upstreamState === 'unknown' || upstreamState === 'starting');

  const showUpstreamUnreachable = isLoopback
    && proxyState.status === 'ready'
    && upstreamState === 'unreachable';

  const handlePreviewFrameLoad = React.useCallback((event: React.SyntheticEvent<HTMLIFrameElement>) => {
    if (!isLoopback || proxyState.status !== 'ready') {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const frameWindow = event.currentTarget.contentWindow;
    if (!frameWindow) {
      return;
    }

    try {
      const location = frameWindow.location;
      const proxyOrigin = getPreviewProxyOrigin(proxySrc);
      if (location.origin !== proxyOrigin) {
        return;
      }
      if (location.pathname.startsWith(proxyState.proxyBasePath)) {
        return;
      }

      const nextPath = `${proxyState.proxyBasePath}${location.pathname}${location.search}${location.hash}`;
      frameWindow.location.replace(nextPath);
    } catch {
      // Cross-origin frames are expected for non-loopback/direct previews.
    }
  }, [isLoopback, proxySrc, proxyState]);

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
          <Icon name="refresh" className="h-3.5 w-3.5" />
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
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
        {isLoopback ? (
          <Button
            type="button"
            size="sm"
            variant={inspectMode ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2"
            onClick={() => setInspectMode((value) => !value)}
            title={t('contextPanel.preview.inspect.toggle')}
            aria-label={t('contextPanel.preview.inspect.toggle')}
            disabled={!bridgeReady}
          >
            <Icon name="cursor" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {isLoopback ? (
          <Button
            type="button"
            size="sm"
            variant={consoleOpen ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2"
            onClick={() => setConsoleOpen((value) => !value)}
            title={bridgeReady ? t('contextPanel.preview.console.open') : t('contextPanel.preview.console.waiting')}
            aria-label={bridgeReady ? t('contextPanel.preview.console.open') : t('contextPanel.preview.console.waiting')}
            disabled={!bridgeReady && consoleEvents.length === 0}
          >
            <Icon name="terminal-box" className="h-3.5 w-3.5" />
            {consoleErrorCount > 0 ? (
              <span className="typography-micro text-status-error">{consoleErrorCount}</span>
            ) : null}
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
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
        ) : effectiveSrc && (!isLoopback || upstreamState === 'reachable') ? (
          <div className="relative h-full w-full">
            <iframe
              ref={iframeRef}
              key={`${effectiveSrc}:${reloadNonce}`}
              src={effectiveSrc}
              title={t('contextPanel.preview.iframeTitle')}
              className="h-full w-full border-0"
              style={{ colorScheme: previewColorScheme }}
              onLoad={handlePreviewFrameLoad}
              sandbox={isLoopback
                ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
                : 'allow-scripts allow-forms'}
            />
            {inspectMode && hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hoverTarget.bounds.x,
                  top: hoverTarget.bounds.y,
                  width: hoverTarget.bounds.width,
                  height: hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hoverTarget.tag}{hoverTarget.text ? ` · ${hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
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
        {consoleOpen ? (
          <div className="absolute inset-x-3 bottom-3 z-10 max-h-[45%] overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] shadow-lg">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.preview.console.title')}</div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={attachConsoleEvents}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.attach')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={copyConsoleEvents}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.copy')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setConsoleEvents([])}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.clear')}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-1 border-b border-border/30 px-3 py-1.5">
              {(['all', 'errors', 'warnings', 'logs'] as const).map((filter) => (
                <Button
                  key={filter}
                  type="button"
                  size="xs"
                  variant={consoleFilter === filter ? 'secondary' : 'ghost'}
                  onClick={() => setConsoleFilter(filter)}
                >
                  {filter === 'all'
                    ? t('contextPanel.preview.console.filter.all')
                    : filter === 'errors'
                      ? t('contextPanel.preview.console.filter.errors')
                      : filter === 'warnings'
                        ? t('contextPanel.preview.console.filter.warnings')
                        : t('contextPanel.preview.console.filter.logs')}
                </Button>
              ))}
            </div>
            <div className="max-h-64 overflow-auto p-2 typography-code text-xs">
              {consoleEvents.length === 0 ? (
                <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.empty')}</div>
              ) : filteredConsoleEvents.length === 0 ? (
                <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.noFilteredEvents')}</div>
              ) : filteredConsoleEvents.map((event) => (
                <div key={event.id} className="border-b border-border/30 px-2 py-1 last:border-b-0">
                  <div className="flex gap-2">
                    <span className={cn(
                      'shrink-0 uppercase',
                      event.level === 'error' || event.level === 'runtime' || event.level === 'resource'
                        ? 'text-status-error'
                        : event.level === 'warn'
                          ? 'text-status-warning'
                          : 'text-muted-foreground'
                    )}>
                      {event.level}
                    </span>
                    <span className="min-w-0 break-words text-foreground">{event.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

type DesktopBrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
};

const isElectronBrowserRuntime = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__);
};

const IframeBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID }) => {
  const { t } = useI18n();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [loadedUrl, setLoadedUrl] = React.useState(startUrl);
  const [history, setHistory] = React.useState<string[]>(() => startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(() => startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);
  const [isLoading, setIsLoading] = React.useState(Boolean(startUrl));
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });
  const [urlAuthReadyKey, setUrlAuthReadyKey] = React.useState('');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const applyUrl = React.useCallback((url: string, options?: { replaceHistory?: boolean; inFrame?: boolean }) => {
    const normalizedUrl = normalizeBrowserUrl(url);
    const nextUrl = normalizedUrl !== 'about:blank' ? normalizedUrl : '';
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    if (!options?.inFrame) {
      setLoadedUrl(nextUrl);
      setIsLoading(Boolean(nextUrl));
    } else {
      setIsLoading(false);
    }
    persistUrl(nextUrl);

    setHistory((current) => {
      if (!nextUrl) {
        setHistoryIndex(-1);
        return [];
      }

      if (options?.replaceHistory) {
        return current;
      }

      const kept = historyIndex >= 0 ? current.slice(0, historyIndex + 1) : [];
      const previous = kept[kept.length - 1];
      if (previous === nextUrl) {
        setHistoryIndex(kept.length - 1);
        return kept;
      }

      const nextHistory = [...kept, nextUrl];
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [historyIndex, persistUrl]);

  const goToHistory = React.useCallback((nextIndex: number) => {
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setCurrentUrl(nextUrl);
    setLoadedUrl(nextUrl);
    setUrlInput(nextUrl);
    setIsLoading(true);
    persistUrl(nextUrl);
  }, [history, persistUrl]);

  const handleReload = React.useCallback(() => {
    if (!currentUrl) return;
    setIsLoading(true);
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      bumpReload();
    }
  }, [currentUrl]);

  React.useEffect(() => {
    if (!loadedUrl) {
      setProxyState({ status: 'idle' });
      return;
    }

    const proxyTargetKey = getBrowserProxyTargetKey(loadedUrl);
    const cached = getCachedProxyTarget(proxyTargetKey);
    if (cached?.previewToken) {
      setProxyState({ status: 'ready', proxyBasePath: cached.proxyBasePath, previewToken: cached.previewToken, expiresAt: cached.expiresAt });
      return;
    }
    if (cached) {
      previewProxyTargetCache.delete(proxyTargetKey);
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });
    setIsLoading(true);

    void (async () => {
      try {
        const response = await runtimeFetch('/api/preview/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: loadedUrl, allowExternal: true }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message = typeof errorBody?.error === 'string'
            ? errorBody.error
            : `HTTP ${response.status}`;
          if (!cancelled) {
            setProxyState({ status: 'error', message });
          }
          return;
        }

        const body = await response.json() as { proxyBasePath?: unknown; previewToken?: unknown; expiresAt?: unknown };
        const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
        const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
        if (!proxyBasePath || !previewToken) {
          if (!cancelled) {
            setProxyState({ status: 'error', message: t('contextPanel.preview.proxyError') });
          }
          return;
        }

        previewProxyTargetCache.set(proxyTargetKey, { proxyBasePath, previewToken, expiresAt });
        if (!cancelled) {
          setProxyState({ status: 'ready', proxyBasePath, previewToken, expiresAt });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setProxyState({ status: 'error', message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadedUrl, t]);

  const proxyUrlAuthKey = loadedUrl && proxyState.status === 'ready'
    ? `${proxyState.proxyBasePath}|${proxyState.previewToken || ''}|${reloadNonce}`
    : '';

  React.useEffect(() => {
    if (!proxyUrlAuthKey) {
      setUrlAuthReadyKey('');
      return;
    }

    let cancelled = false;
    setUrlAuthReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setUrlAuthReadyKey(proxyUrlAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [proxyUrlAuthKey]);

  const proxySrc = React.useMemo(() => {
    if (urlAuthReadyKey !== proxyUrlAuthKey) return '';
    if (!loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsed = new URL(loadedUrl);
      const path = parsed.pathname || '/';
      const searchParams = new URLSearchParams(parsed.search);
      searchParams.delete('oc_url_token');
      searchParams.delete('oc_client_token');
      searchParams.set('ocPreview', String(reloadNonce));
      searchParams.set('oc_preview_token', proxyState.previewToken || '');
      const search = searchParams.toString();
      return getRuntimeUrlResolver().authenticatedAsset(`${proxyState.proxyBasePath}${path}${search ? `?${search}` : ''}${parsed.hash}`);
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState, proxyUrlAuthKey, reloadNonce, urlAuthReadyKey]);

  const iframeSrc = proxySrc || (proxyState.status === 'error' ? loadedUrl : '');

  const getCurrentUrlFromFrameUrl = React.useCallback((frameUrl: string): string => {
    if (!frameUrl || !loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsedFrameUrl = new URL(frameUrl, window.location.origin);
      const proxyBasePath = proxyState.proxyBasePath.endsWith('/')
        ? proxyState.proxyBasePath.slice(0, -1)
        : proxyState.proxyBasePath;
      if (parsedFrameUrl.origin !== window.location.origin || !parsedFrameUrl.pathname.startsWith(proxyBasePath)) {
        return '';
      }

      const rest = parsedFrameUrl.pathname.slice(proxyBasePath.length) || '/';
      const upstreamOrigin = new URL(loadedUrl).origin;
      return stripPreviewQueryParams(new URL(`${rest}${parsedFrameUrl.search}${parsedFrameUrl.hash}`, upstreamOrigin).toString());
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState]);

  const getUpstreamUrlFromLocalFrameUrl = React.useCallback((frameUrl: string): string => {
    if (!frameUrl || !loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsedFrameUrl = new URL(frameUrl, window.location.origin);
      const upstreamOrigin = new URL(loadedUrl).origin;
      if (parsedFrameUrl.origin !== window.location.origin || upstreamOrigin === window.location.origin) {
        return '';
      }

      const proxyBasePath = proxyState.proxyBasePath.endsWith('/')
        ? proxyState.proxyBasePath.slice(0, -1)
        : proxyState.proxyBasePath;
      if (parsedFrameUrl.pathname.startsWith(proxyBasePath)) {
        return '';
      }

      return stripPreviewQueryParams(new URL(`${parsedFrameUrl.pathname}${parsedFrameUrl.search}${parsedFrameUrl.hash}`, upstreamOrigin).toString());
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState]);

  const postInspectMode = React.useCallback((enabled: boolean) => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return;
    frameWindow.postMessage({
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled,
    }, window.location.origin);
  }, []);

  const attachBrowserAnnotation = React.useCallback(async (target: PreviewElementMetadata) => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }

    const iframe = iframeRef.current;
    const frameWindow = iframe?.contentWindow;
    const rect = iframe?.getBoundingClientRect();
    const viewport = {
      width: Number.isFinite(frameWindow?.innerWidth) ? frameWindow?.innerWidth ?? rect?.width ?? 0 : rect?.width ?? 0,
      height: Number.isFinite(frameWindow?.innerHeight) ? frameWindow?.innerHeight ?? rect?.height ?? 0 : rect?.height ?? 0,
    };

    const file = iframe ? await renderPreviewScreenshot(iframe, target) : null;
    const screenshotAttached = Boolean(file);
    if (file) {
      await addAttachedFile(file);
    }

    addInlineCommentDraft({
      sessionKey,
      source: 'preview-annotation',
      fileLabel: currentUrl || 'browser',
      startLine: 1,
      endLine: 1,
      code: formatPreviewAnnotationMarkdown({
        pageUrl: currentUrl,
        viewport,
        devicePixelRatio: window.devicePixelRatio || 1,
        target,
        screenshotAttached,
        intro: t(screenshotAttached
          ? 'contextPanel.preview.inspect.attachAnnotationWithScreenshot'
          : 'contextPanel.preview.inspect.attachAnnotation'),
      }),
      language: 'markdown',
      text: '',
    });
    toast.success(t('contextPanel.preview.inspect.attached'));
  }, [addAttachedFile, addInlineCommentDraft, currentSessionId, currentUrl, newSessionDraftOpen, t]);

  const cancelInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    setHoverTarget(null);
    postInspectMode(false);
    if (!iframe) return;
    void runIframeScript<unknown>(iframe, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {});
  }, [postInspectMode]);

  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      cancelInspect();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [cancelInspect, isInspecting]);

  React.useEffect(() => () => cancelInspect(), [cancelInspect]);

  React.useEffect(() => {
    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== 'openchamber-preview-bridge' || data.version !== 1) return;

      if (data.type === 'ready') {
        const frameUrl = typeof data.url === 'string' ? data.url : '';
        const nextUrl = getCurrentUrlFromFrameUrl(frameUrl);
        if (nextUrl && nextUrl !== currentUrl) {
          applyUrl(nextUrl, { inFrame: true });
        }
        return;
      }

      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }

      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        setHoverTarget(null);
        setIsInspecting(false);
        postInspectMode(false);
        void attachBrowserAnnotation(data.target);
        return;
      }

      if (data.type === 'navigate-preview') {
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        const upstreamUrl = getUpstreamUrlFromLocalFrameUrl(nextUrl);
        if (upstreamUrl) {
          applyUrl(upstreamUrl);
          return;
        }
        if (nextUrl) {
          applyUrl(nextUrl);
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [applyUrl, attachBrowserAnnotation, currentUrl, getCurrentUrlFromFrameUrl, getUpstreamUrlFromLocalFrameUrl, postInspectMode]);

  const handleInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !currentUrl) return;

    if (isInspecting) {
      setIsInspecting(false);
      cancelInspect();
      return;
    }

    if (proxySrc) {
      setHoverTarget(null);
      setIsInspecting(true);
      postInspectMode(true);
      return;
    }

    setIsInspecting(true);
    void (async () => {
      try {
        const target = await runIframeScript<unknown>(iframe, DESKTOP_BROWSER_INSPECT_SCRIPT);
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;
        await attachBrowserAnnotation(target);
      } catch {
        setIsInspecting(false);
        toast.error(t('contextPanel.browser.inspectUnavailable'));
      }
    })();
  }, [attachBrowserAnnotation, cancelInspect, currentUrl, isInspecting, postInspectMode, proxySrc, t]);

  const handleIframeLoad = React.useCallback(() => {
    try {
      const frameUrl = iframeRef.current?.contentWindow?.location.href || '';
      const upstreamUrl = getUpstreamUrlFromLocalFrameUrl(frameUrl);
      if (upstreamUrl) {
        applyUrl(upstreamUrl, { inFrame: true });
        return;
      }
    } catch {
      // Cross-origin direct iframe fallback; regular load handling still applies.
    }

    setIsLoading(false);
    if (isInspecting && proxySrc) {
      postInspectMode(true);
    }
  }, [applyUrl, getUpstreamUrlFromLocalFrameUrl, isInspecting, postInspectMode, proxySrc]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex <= 0} onClick={() => goToHistory(historyIndex - 1)}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => goToHistory(historyIndex + 1)}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={handleReload}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); applyUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
          />
        </form>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!currentUrl}
          onClick={handleInspect}
          title={t('contextPanel.preview.inspect.toggle')}
          aria-label={t('contextPanel.preview.inspect.toggle')}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {iframeSrc ? (
          <div className="absolute inset-0">
            <iframe
              key={`${tabID}:${reloadNonce}`}
              ref={iframeRef}
              src={iframeSrc}
              title={t('contextPanel.browser.empty')}
              className="absolute inset-0 h-full w-full border-0 bg-background"
              allow="clipboard-read; clipboard-write; fullscreen"
              allowFullScreen
              onLoad={handleIframeLoad}
            />
            {isInspecting && hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hoverTarget.bounds.x,
                  top: hoverTarget.bounds.y,
                  width: hoverTarget.bounds.width,
                  height: hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hoverTarget.tag}{hoverTarget.text ? ` · ${hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <OpenChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{t('contextPanel.browser.empty')}</span>
            <span className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
            <span className="max-w-md typography-micro leading-relaxed text-status-warning/70">{t('contextPanel.browser.trustNotice')}</span>
          </div>
        )}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const DesktopBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID }) => {
  const { t } = useI18n();
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const initialWebviewSrcRef = React.useRef(normalizeBrowserUrl(initialUrl));
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const loadingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLoading = isLoading;

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  // Listen to webview navigation events
  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const syncUrl = () => {
      try {
        const url = webview.getURL();
        if (url && url !== 'about:blank') {
          setCurrentUrl(url);
          setUrlInput(url);
          persistUrl(url);
        }
      } catch { /* webview not ready */ }
    };

    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string }>).detail;
      if (typeof detail?.url === 'string' && detail.url) {
        setCurrentUrl(detail.url);
        setUrlInput(detail.url);
        persistUrl(detail.url);
      }
    };

    const onStartLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => setIsLoading(true), 200);
    };
    const onStopLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      setIsLoading(false);
      syncUrl();
    };

    const onNewWindow = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; disposition: string }>).detail;
      if (detail?.disposition === 'new-window' || detail?.disposition === 'foreground-tab' || detail?.disposition === 'background-tab') {
        event.preventDefault();
        const w = webviewRef.current;
        if (typeof w?.loadURL === 'function' && detail.url) {
          w.loadURL(detail.url);
        }
      }
    };

    const installSameWebviewNavigation = () => {
      try {
        webview.executeJavaScript?.(DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, true).catch(() => {});
      } catch { /* webview not ready */ }
    };

    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('new-window', onNewWindow);
    webview.addEventListener('dom-ready', installSameWebviewNavigation);

    // Check current loading state imperatively — we may have missed the event
    try {
      if (!webview.isLoading()) {
        setIsLoading(false);
        syncUrl();
      }
    } catch { /* webview not ready */ }
    installSameWebviewNavigation();

    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('new-window', onNewWindow);
      webview.removeEventListener('dom-ready', installSameWebviewNavigation);
    };
  }, [persistUrl]);

  // Safety timeout: hide loading overlay after 30s even if events fire late
  React.useEffect(() => {
    const safety = setTimeout(() => setIsLoading(false), 30_000);
    return () => clearTimeout(safety);
  }, []);

  // Escape key cancels inspect mode
  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      const webview = webviewRef.current;
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isInspecting]);

  // Cancel inspect on unmount
  React.useEffect(() => {
    const webview = webviewRef.current;
    return () => {
      try {
        const url = webview?.getURL?.();
        if (url && url !== 'about:blank') {
          setContextPanelTabTargetPath(directory, tabID, url);
        }
      } catch { /* webview not ready */ }
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const loadUrl = React.useCallback((value: string) => {
    const webview = webviewRef.current;
    if (typeof webview?.loadURL !== 'function') return;
    const nextUrl = normalizeBrowserUrl(value);
    try { webview.loadURL(nextUrl); } catch { /* webview may not be ready */ }
  }, []);

  const handleInspect = React.useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (isInspecting) {
      setIsInspecting(false);
      try { webview.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
      return;
    }

    setIsInspecting(true);
    webview.executeJavaScript?.(DESKTOP_BROWSER_INSPECT_SCRIPT, true)
      .then(async (target: unknown) => {
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;

        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
        if (!sessionKey) {
          toast.error(t('contextPanel.preview.inspect.attachNoSession'));
          return;
        }

        const wcId = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (wcId === null || wcId === undefined) return;

        const capture = await invokeDesktopCommand<{ mime: string; base64: string; width: number; height: number }>(
          'desktop_browser_capture_page', { webContentsId: wcId }
        );

        const cssViewport = await webview.executeJavaScript?.(
          '({ width: window.innerWidth, height: window.innerHeight })', true
        ).catch(() => null) as { width: number; height: number } | null | undefined;

        const cssWidth = Number.isFinite(cssViewport?.width) ? (cssViewport as { width: number }).width : capture.width;
        const cssHeight = Number.isFinite(cssViewport?.height) ? (cssViewport as { height: number }).height : capture.height;

        const file = await desktopAnnotationToFile(capture.base64, capture.width, capture.height, cssWidth, cssHeight, target);
        const screenshotAttached = Boolean(file);
        if (file) {
          await addAttachedFile(file);
        }

        addInlineCommentDraft({
          sessionKey,
          source: 'preview-annotation',
          fileLabel: currentUrl || 'browser',
          startLine: 1,
          endLine: 1,
          code: formatPreviewAnnotationMarkdown({
            pageUrl: currentUrl,
            viewport: { width: cssWidth, height: cssHeight },
            devicePixelRatio: window.devicePixelRatio || 1,
            target,
            screenshotAttached,
            intro: t('contextPanel.preview.inspect.attachAnnotationWithScreenshot'),
          }),
          language: 'markdown',
          text: '',
        });
        toast.success(t('contextPanel.preview.inspect.attached'));
      })
      .catch(() => setIsInspecting(false));
  }, [addAttachedFile, addInlineCommentDraft, currentSessionId, currentUrl, isInspecting, newSessionDraftOpen, t]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goBack?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goForward?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.reload?.(); } catch { /* webview not ready */ } }}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); loadUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
          />
        </form>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleInspect}
          title={t('contextPanel.preview.inspect.toggle')}
          aria-label={t('contextPanel.preview.inspect.toggle')}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        <webview
          ref={webviewRef}
          src={initialWebviewSrcRef.current}
          partition="persist:openchamber-browser"
          allowpopups
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
        {(!currentUrl || currentUrl === 'about:blank') && !isLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <OpenChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{t('contextPanel.browser.empty')}</span>
          </div>
        ) : null}
        {showLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

type ContextTileBodyProps = {
  tabs: ContextPanelTab[];
  activeTab: ContextPanelTab | null;
  directoryKey: string;
  effectiveDirectory: string;
  visibleTileIds?: ReadonlySet<string>;
  className?: string;
  renderChatFrames?: boolean;
};

// Shared tile renderer (ContextPanel legacy path + tiled TabGroupRegion). Mirrors
// ContextPanel's own render body so a tiled region shows the same content; chat
// frames are hosted at the TiledPanel level, so tiled regions pass renderChatFrames=false.
export const ContextTileBody: React.FC<ContextTileBodyProps> = ({
  tabs,
  activeTab,
  directoryKey,
  effectiveDirectory,
  visibleTileIds,
  className,
  renderChatFrames = true,
}) => {
  const { t } = useI18n();
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const activeChatTabID = activeTab?.mode === 'chat' ? activeTab.id : null;

  React.useEffect(() => {
    if (!directoryKey || !activeTab) {
      return;
    }
    if (activeTab.mode === 'file' && activeTab.targetPath) {
      setSelectedFilePath(directoryKey, activeTab.targetPath);
    }
  }, [activeTab, directoryKey, setSelectedFilePath]);

  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || activeTab?.mode !== 'diff') {
      return;
    }
    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: activeTab.targetPath,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [activeTab, directoryKey, openContextPanelTab]);

  const browserTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'browser'), [tabs]);
  const diffTabs = React.useMemo(() => tabs.filter((tab) => tab.mode === 'diff'), [tabs]);
  const BrowserPane = isElectronBrowserRuntime() ? DesktopBrowserPane : IframeBrowserPane;
  const hasFileTabs = React.useMemo(() => tabs.some((tab) => tab.mode === 'file'), [tabs]);
  const isFileTabActive = activeTab?.mode === 'file';

  const activeNonChatContent = activeTab?.mode === 'context'
    ? <ContextPanelContent />
    : activeTab?.mode === 'plan'
        ? <PlanView targetPath={activeTab.targetPath} />
        : activeTab?.mode === 'preview'
            ? <PreviewPane rawUrl={activeTab.targetPath ?? ''} onNavigate={(url) => openContextPreview(effectiveDirectory, url)} />
            : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <Icon name="global" className="h-12 w-12 text-muted-foreground/50" />
                <div className="typography-ui-header text-foreground">{t('contextPanel.preview.title')}</div>
                <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.preview.description')}</div>
              </div>
            );

  return (
    <div className={cn('relative min-h-0 flex-1 overflow-hidden', className)}>
      {hasFileTabs ? (
        <div className={cn('absolute inset-0', isFileTabActive ? 'block' : 'hidden')}>
          <FilesView mode="editor-only" />
        </div>
      ) : null}
      {renderChatFrames ? (
        <EmbeddedSessionFrames
          mode="contained"
          tabs={tabs}
          activeTabID={activeChatTabID}
          directoryKey={directoryKey}
          visibleTileIds={visibleTileIds}
        />
      ) : null}
      {browserTabs.map((tab) => (
        <div
          key={tab.id}
          className={cn('absolute inset-0', activeTab?.id !== tab.id && 'hidden')}
        >
          <BrowserPane initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} />
        </div>
      ))}
      {diffTabs.map((tab) => (
        <div
          key={tab.id}
          className={cn('absolute inset-0', activeTab?.id !== tab.id && 'hidden')}
        >
          <DiffView
            hideStackedFileSidebar
            stackedDefaultCollapsedAll
            pinSelectedFileHeaderToTopOnNavigate
            showOpenInEditorAction
            diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : 'working')}
            onDiffScopeChange={handleDiffScopeChange}
            targetFilePath={tab.targetPath}
            flushContent
          />
        </div>
      ))}
      {activeTab?.mode !== 'chat' && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' ? activeNonChatContent : null}
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
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const { themeMode, setThemeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [tabs]);
  const sessionTitleById = useSessionTitleMap(directoryKey || undefined, chatSessionIDs);

  const [isResizing, setIsResizing] = React.useState(false);
  const [suppressWidthTransition, setSuppressWidthTransition] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
  const chatFrameSrcByTabIDRef = React.useRef<Map<string, EmbeddedSessionChatURLCacheEntry>>(new Map());
  const wasOpenRef = React.useRef(false);
  const previousIsOpenRef = React.useRef(isOpen);
  const suppressWidthTransitionFrameRef = React.useRef<number | null>(null);

  const suppressWidthTransitionForFrame = React.useCallback(() => {
    setSuppressWidthTransition(true);
    if (suppressWidthTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressWidthTransitionFrameRef.current);
    }
    suppressWidthTransitionFrameRef.current = window.requestAnimationFrame(() => {
      suppressWidthTransitionFrameRef.current = null;
      setSuppressWidthTransition(false);
    });
  }, []);

  React.useEffect(() => () => {
    if (suppressWidthTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressWidthTransitionFrameRef.current);
    }
  }, []);

  React.useLayoutEffect(() => {
    const wasOpen = previousIsOpenRef.current;
    previousIsOpenRef.current = isOpen;

    if (!isOpen) {
      setSuppressWidthTransition(false);
      return;
    }

    if (wasOpen) {
      return;
    }

    suppressWidthTransitionForFrame();
  }, [isOpen, suppressWidthTransitionForFrame]);

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

    panel.style.setProperty('--oc-context-panel-width', `${clampWidthToAvailableSpace(nextWidth, panel)}px`);
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
    const nextWidth = clampWidthToAvailableSpace(startWidthRef.current + delta, panelRef.current);
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

    const finalWidth = clampWidthToAvailableSpace(resizingWidthRef.current ?? width, panelRef.current);
    suppressWidthTransitionForFrame();
    applyLiveWidth(finalWidth);
    resizingWidthRef.current = finalWidth;
    setContextPanelWidth(directoryKey, finalWidth);
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [applyLiveWidth, directoryKey, setContextPanelWidth, suppressWidthTransitionForFrame, width]);

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
      setSelectedFilePath(directoryKey, activeTab.targetPath, { allowOutsideRoot: true });
      return;
    }

  }, [activeTab, directoryKey, setSelectedFilePath]);

  const activeChatTabID = activeTab?.mode === 'chat' ? activeTab.id : null;
  const activeChatSessionID = activeTab?.mode === 'chat' ? getSessionIDFromDedupeKey(activeTab.dedupeKey) : null;

  React.useEffect(() => {
    if (!isOpen || !directoryKey || !activeChatSessionID || typeof window === 'undefined') {
      return;
    }

    const markActiveChatViewed = () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        setExternallyViewedSession(directoryKey, activeChatSessionID, false);
        return;
      }

      markSessionViewed(activeChatSessionID);
      setExternallyViewedSession(directoryKey, activeChatSessionID, true);
    };

    markActiveChatViewed();
    const interval = window.setInterval(markActiveChatViewed, 10_000);
    window.addEventListener('focus', markActiveChatViewed);
    window.addEventListener('blur', markActiveChatViewed);
    document.addEventListener('visibilitychange', markActiveChatViewed);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', markActiveChatViewed);
      window.removeEventListener('blur', markActiveChatViewed);
      document.removeEventListener('visibilitychange', markActiveChatViewed);
      setExternallyViewedSession(directoryKey, activeChatSessionID, false);
    };
  }, [activeChatSessionID, directoryKey, isOpen]);

  const getEmbeddedChatSrc = React.useCallback((tabID: string, sessionID: string, readOnly: boolean): string => {
    return getOrCreateEmbeddedSessionChatURL(chatFrameSrcByTabIDRef.current, tabID, sessionID, directoryKey || null, readOnly, {
      mode: themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    });
  }, [currentTheme, darkThemeId, directoryKey, lightThemeId, themeMode]);

  React.useEffect(() => {
    const liveTabIDs = new Set(tabs.map((tab) => tab.id));
    for (const tabID of chatFrameSrcByTabIDRef.current.keys()) {
      if (!liveTabIDs.has(tabID)) {
        chatFrameSrcByTabIDRef.current.delete(tabID);
      }
    }
  }, [tabs]);

  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || activeTab?.mode !== 'diff') {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: activeTab.targetPath,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [activeTab, directoryKey, openContextPanelTab]);

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

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const isKnownChatFrame = Array.from(chatFrameRefs.current.values())
        .some((frame) => frame.contentWindow === event.source);
      if (!isKnownChatFrame) {
        return;
      }

      const data = event.data as { type?: unknown };
      if (data?.type !== 'openchamber:cycle-theme-request') {
        return;
      }

      const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
      const currentIndex = modes.indexOf(themeMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      setThemeMode(modes[nextIndex]);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [setThemeMode, themeMode]);

  React.useLayoutEffect(() => {
    const hasAnyChatTab = tabs.some((tab) => tab.mode === 'chat');
    if (!hasAnyChatTab) {
      return;
    }

    postThemeSyncToEmbeddedChat();
    postEmbeddedVisibilityToChats();
  }, [darkThemeId, lightThemeId, postEmbeddedVisibilityToChats, postThemeSyncToEmbeddedChat, tabs, themeMode]);

  const tabItems = React.useMemo(() => tabs.map((tab) => {
    const rawLabel = getTabLabel(tab, sessionTitleById, t);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
    };
  }), [effectiveDirectory, sessionTitleById, t, tabs]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'plan'
            ? <PlanView targetPath={activeTab.targetPath} />
            : activeTab?.mode === 'preview'
                ? <PreviewPane rawUrl={activeTab.targetPath ?? ''} onNavigate={(url) => openContextPreview(effectiveDirectory, url)} />
                : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <Icon name="global" className="h-12 w-12 text-muted-foreground/50" />
                    <div className="typography-ui-header text-foreground">{t('contextPanel.preview.title')}</div>
                    <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.preview.description')}</div>
                  </div>
                );

  const chatTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat'),
    [tabs],
  );
  const browserTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'browser'),
    [tabs],
  );
  const diffTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'diff'),
    [tabs],
  );
  const BrowserPane = isElectronBrowserRuntime() ? DesktopBrowserPane : IframeBrowserPane;
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';

  const header = (
    <header className="flex h-10 items-stretch border-b border-transparent">
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
          {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
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
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--oc-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
        width: 0,
        minWidth: 0,
        maxWidth: 0,
        opacity: 0,
        overflow: 'hidden',
        visibility: 'hidden',
      }
    : isExpanded
      ? {
          ['--oc-context-panel-width' as string]: '100%',
          width: '100%',
          minWidth: '100%',
          maxWidth: '100%',
        }
      : {
          width: 'min(var(--oc-context-panel-width), 100%)',
          minWidth: `min(${CONTEXT_PANEL_MIN_WIDTH}px, 100%)`,
          maxWidth: '100%',
          ['--oc-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
        };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      tabIndex={-1}
      inert={!isOpen || undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        !isExpanded && 'border-l border-border/40',
        isExpanded
          ? 'absolute inset-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        !isOpen && 'pointer-events-none',
        isResizing || !isOpen || suppressWidthTransition ? 'transition-none' : 'transition-[width] duration-200 ease-in-out'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {!isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-50 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
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

          const src = getEmbeddedChatSrc(tab.id, sessionID, tab.readOnly);
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
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <BrowserPane initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} />
          </div>
        ))}
        {diffTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <DiffView
              hideStackedFileSidebar
              stackedDefaultCollapsedAll
              pinSelectedFileHeaderToTopOnNavigate
              showOpenInEditorAction
              diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : 'working')}
              onDiffScopeChange={handleDiffScopeChange}
              targetFilePath={tab.targetPath}
              flushContent
            />
          </div>
        ))}
        {activeTab?.mode !== 'chat' && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' ? activeNonChatContent : null}
      </div>
    </aside>
  );
};
