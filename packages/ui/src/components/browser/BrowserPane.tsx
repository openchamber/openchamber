import React from 'react';

import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';
import { BLANK_URL, isLoopbackUrl, isStartingServerFailure, normalizeBrowserUrl } from '@/lib/browser/url';
import { probeLoopbackStatus } from '@/lib/browser/devServers';
import {
  cancelAnnotationSession,
  runAnnotationSession,
  type AnnotationHost,
  type PageCapture,
} from '@/lib/browser/annotationSession';
import { resolveAnnotationOverlayTheme } from '@/lib/browser/overlayTheme';
import { registerBrowserController } from '@/lib/browser/controlClient';
import { suggestFromHistory } from '@/lib/browser/history';
import { selectBrowserHistory, useBrowserHistoryStore } from '@/stores/useBrowserHistoryStore';
import {
  DevTunnelUnavailableError,
  resolveBrowsableUrl,
  shouldTunnelLoopbackUrl,
  toDisplayUrl,
} from '@/lib/browser/devTunnel';
import {
  buildClickScript,
  buildInspectScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
} from '@/lib/browser/pageActions';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserDeviceBar, type BrowserColorScheme } from './BrowserDeviceBar';
import {
  FILL_VIEWPORT,
  fitViewport,
  isViewportMode,
  viewportForMode,
  viewportSummary,
  type BrowserViewport,
} from '@/lib/browser/viewport';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useAnnotationAttach, useAnnotationOverlayLabels } from './useAnnotationAttach';
import { readEventPayload, useWebviewNavigation } from './useWebviewNavigation';

export type BrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
};

/**
 * Chromium is the only host that can give us a real page: cookies, service
 * workers, HMR sockets, DevTools, and same-document access for annotation. When
 * it is unavailable the surface degrades to a plain iframe that can display a
 * page but cannot inspect one, rather than pretending otherwise.
 */
const isChromiumHost = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__)
);

/** How long to keep waiting for a dev server that is still coming up. */
const DEV_SERVER_WAIT_MS = 40_000;
/** Chromium's zoom is exponential: factor = 1.2 ^ level. */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
const BROWSER_PARTITION = 'persist:openchamber-browser';
/** Kept small: this rides along with every snapshot. */
const CONSOLE_PROBLEM_LIMIT = 20;
const DEV_SERVER_RETRY_DELAY_MS = 600;
/**
 * A shorter budget for a server that *answers* but with a 5xx, which is what a
 * dev gateway does while the app behind it is still starting. Kept short and
 * applied only before the first good load, so a genuine server error — a build
 * failure page, say — is shown promptly instead of being hidden behind a
 * spinner.
 */
const GATEWAY_WAIT_MS = 20_000;

const WebviewBrowser: React.FC<BrowserPaneProps> = ({ initialUrl, directory, tabID }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const webviewRef = React.useRef<WebviewElement | null>(null);
  // Tracked in state as well as a ref: effects that attach listeners must re-run
  // when the view appears, which a stable ref cannot tell them.
  const [webviewElement, setWebviewElement] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => {
    webviewRef.current = node;
    setWebviewElement(node);
  }, []);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);

  // Captured once: the webview owns its history from here on, and re-deriving
  // this from props would drag the view back to where the tab started.
  const initialUrlRef = React.useRef(normalizeBrowserUrl(initialUrl));
  const startUrl = initialUrlRef.current !== BLANK_URL ? initialUrlRef.current : '';

  // The view is created with its final URL already in `src`, never navigated
  // into place afterwards. A tab opened in the background renders hidden, where
  // an imperative navigation is lost, and mutating `src` after the element
  // exists is not reliably honoured either — both leave a panel that never
  // loads. `null` means "still resolving", and the view is not rendered yet.
  const [initialSrc, setInitialSrc] = React.useState<string | null>(startUrl ? null : BLANK_URL);

  const [address, setAddress] = React.useState(startUrl);
  const [isAnnotating, setIsAnnotating] = React.useState(false);
  const [isWaitingForServer, setIsWaitingForServer] = React.useState(false);
  const [zoomLevel, setZoomLevel] = React.useState(0);
  const [showDeviceBar, setShowDeviceBar] = React.useState(false);
  const [viewport, setViewport] = React.useState<BrowserViewport>(FILL_VIEWPORT);
  // Read inside agent actions, which are not re-created when the viewport
  // changes and would otherwise report whatever it was when they were built.
  const viewportRef = React.useRef(viewport);
  viewportRef.current = viewport;
  /**
   * Errors and warnings the page logged, reported with the next snapshot.
   *
   * A page that looks right and is throwing looks identical to one that is
   * fine, and finding out otherwise used to mean opening DevTools by hand.
   */
  const consoleProblemsRef = React.useRef<Array<{ level: string; message: string; source: string }>>([]);
  const [colorScheme, setColorScheme] = React.useState<BrowserColorScheme>('system');
  const [stageSize, setStageSize] = React.useState({ width: 0, height: 0 });
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  /** When the current run of retries began, per URL. */
  const retryRef = React.useRef<{ url: string; startedAt: number } | null>(null);
  /** Set once this tab has seen a page that was not a startup error. */
  const servedOkRef = React.useRef(false);
  const openedAtRef = React.useRef(Date.now());

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === BLANK_URL || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const navigation = useWebviewNavigation(webviewElement, {
    initialUrl: startUrl,
    onUrlChange: React.useCallback((url: string) => {
      const display = toDisplayUrl(url);
      setAddress(display);
      persistUrl(display);
    }, [persistUrl]),
  });

  /** Set when a remote dev server could not be reached from this machine. */
  const [tunnelFailedUrl, setTunnelFailedUrl] = React.useState<string | null>(null);
  const attachAnnotation = useAnnotationAttach(directory);
  const overlayLabels = useAnnotationOverlayLabels();
  const isLoading = navigation.status.kind === 'loading';

  const history = useBrowserHistoryStore(selectBrowserHistory(directory));
  const recordHistoryVisit = useBrowserHistoryStore((state) => state.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((state) => state.forget);
  // Recorded once a page has actually loaded, and with the title it reported:
  // an address that failed to open is not somewhere to offer going back to.
  React.useEffect(() => {
    if (navigation.status.kind !== 'ready') return;
    recordHistoryVisit(directory, {
      url: toDisplayUrl(navigation.status.url),
      title: navigation.status.title,
    });
  }, [directory, navigation.status, recordHistoryVisit]);
  const suggestions = React.useMemo(
    () => suggestFromHistory(history, address),
    [history, address],
  );

  const loadUrl = React.useCallback((value: string) => {
    const next = normalizeBrowserUrl(value);
    if (next === BLANK_URL) return;
    // The address bar shows what the user asked for; a tunnel only changes
    // where the bytes come from, and surfacing 127.0.0.1:<random> would be
    // confusing and useless to copy.
    setAddress(next);
    setTunnelFailedUrl(null);
    void resolveBrowsableUrl(next).then((target) => {
      const webview = webviewRef.current;
      if (!webview) {
        setInitialSrc(target);
        return;
      }
      try {
        webview.loadURL(target);
      } catch {
        // Not attached yet: hand the navigation to the attribute, which
        // Chromium applies once the view attaches.
        setInitialSrc(target);
      }
    }).catch((error: unknown) => {
      // Loading the address here anyway would answer from this machine while
      // showing the remote one's address. Say what happened instead.
      if (error instanceof DevTunnelUnavailableError) setTunnelFailedUrl(next);
    });
  }, []);

  // Resolving through the tunnel is what lets a persisted loopback URL reach a
  // dev server on a remote host; locally it returns the URL unchanged.
  React.useEffect(() => {
    if (!startUrl) return;
    let active = true;
    void resolveBrowsableUrl(startUrl)
      .then((target) => { if (active) setInitialSrc(target); })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DevTunnelUnavailableError) {
          // The view still needs a src or the panel stays blank forever; it
          // gets a blank one, with the failure stated over it.
          setTunnelFailedUrl(startUrl);
          setInitialSrc(BLANK_URL);
          return;
        }
        setInitialSrc(startUrl);
      });
    return () => { active = false; };
    // Only ever the initial navigation; later changes come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const annotationHost = React.useMemo<AnnotationHost>(() => ({
    executeJavaScript: async (code: string, userGesture?: boolean) => {
      const webview = webviewRef.current;
      if (!webview) throw new Error('Browser view is not available');
      return webview.executeJavaScript(code, userGesture);
    },
    capturePage: async (): Promise<PageCapture | null> => {
      const webview = webviewRef.current;
      if (!webview) return null;
      const webContentsId = webview.getWebContentsId();
      if (!Number.isFinite(webContentsId)) return null;
      return await invokeDesktopCommand<PageCapture>('desktop_browser_capture_page', { webContentsId });
    },
  }), []);

  const handleAnnotate = React.useCallback(() => {
    if (isAnnotating) {
      setIsAnnotating(false);
      void cancelAnnotationSession(annotationHost);
      return;
    }
    if (!navigation.url) {
      toast.error(t('contextPanel.browser.annotate.noPage'));
      return;
    }

    const theme = resolveAnnotationOverlayTheme(
      currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    );

    setIsAnnotating(true);
    void runAnnotationSession({
      host: annotationHost,
      theme,
      labels: overlayLabels,
    })
      .then(async (result) => {
        setIsAnnotating(false);
        if (!result) return;
        await attachAnnotation(result);
      })
      .catch(() => {
        setIsAnnotating(false);
        toast.error(t('contextPanel.browser.annotate.failed'));
      });
  }, [annotationHost, attachAnnotation, currentTheme, isAnnotating, navigation.url, overlayLabels, t]);

  // Escape leaves annotation mode from the app side too: the overlay owns the
  // in-page Escape, but the panel can be focused instead.
  React.useEffect(() => {
    if (!isAnnotating) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsAnnotating(false);
      void cancelAnnotationSession(annotationHost);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [annotationHost, isAnnotating]);

  // Agent-driven actions. Waiting for the page to settle after a navigation is
  // deliberate: a snapshot taken mid-load describes a page that no longer
  // exists by the time the agent reads it.
  const waitForIdle = React.useCallback(async (timeoutMs = 8_000): Promise<boolean> => {
    const startedAt = Date.now();
    for (;;) {
      const webview = webviewRef.current;
      if (!webview) return false;
      let busy = false;
      try {
        busy = webview.isLoading();
      } catch {
        return false;
      }
      if (!busy) return true;
      // A page with a looping video or a long-lived stream can report loading
      // indefinitely. Give up waiting and act on it anyway rather than letting
      // the whole action expire.
      if (Date.now() - startedAt > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }, []);

  const runControlAction = React.useCallback(async (
    action: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> => {
    const webview = webviewRef.current;
    if (!webview) throw new Error('The browser panel is not ready');

    // Showing the bar when the agent sizes the page keeps the change visible:
    // the user should see which layout is being looked at, not just that it
    // suddenly narrowed.
    const applyViewportParameter = (): void => {
      if (!isViewportMode(parameters.viewport)) return;
      setViewport(viewportForMode(parameters.viewport));
      setShowDeviceBar(true);
    };

    if (action === 'browser.back' || action === 'browser.forward') {
      const goingBack = action === 'browser.back';
      const canMove = goingBack ? webview.canGoBack() : webview.canGoForward();
      if (!canMove) {
        throw new Error(goingBack
          ? 'There is nothing to go back to in this tab'
          : 'There is nothing to go forward to in this tab');
      }
      if (goingBack) webview.goBack();
      else webview.goForward();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await waitForIdle();
      let title = '';
      try { title = webview.getTitle() || ''; } catch { title = ''; }
      return { url: toDisplayUrl(webview.getURL()), title };
    }

    if (action === 'browser.capture') {
      // Wait for a settled page first: a screenshot of a half-painted layout is
      // worse than none, because it looks like a finished one.
      await waitForIdle();
      const capture = await annotationHost.capturePage();
      if (!capture) throw new Error('The page could not be captured');
      let title = '';
      try { title = webview.getTitle() || ''; } catch { title = ''; }
      return {
        ...capture,
        url: toDisplayUrl(webview.getURL()),
        title,
        viewport: viewportSummary(viewportRef.current),
      };
    }

    if (action === 'browser.resize') {
      if (!isViewportMode(parameters.viewport)) throw new Error('viewport is required');
      applyViewportParameter();
      // Let the resize land before reporting it, so a snapshot that follows
      // describes the new layout rather than the old one.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await waitForIdle();
      return { viewport: viewportSummary(viewportForMode(parameters.viewport)) };
    }

    if (action === 'browser.open') {
      const url = typeof parameters.url === 'string' ? parameters.url : '';
      if (!url) throw new Error('url is required');
      applyViewportParameter();
      loadUrl(url);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const settled = await waitForIdle(25_000);
      let title = '';
      try {
        title = webview.getTitle() || '';
      } catch {
        title = '';
      }
      // `settled: false` means the page is still fetching, not that opening
      // failed — the agent can snapshot it and decide for itself.
      return {
        url: normalizeBrowserUrl(url),
        title,
        opened: true,
        settled,
        viewport: viewportSummary(viewportRef.current),
      };
    }

    await waitForIdle();

    const asOptionalString = (value: unknown): string | undefined => (
      typeof value === 'string' && value ? value : undefined
    );

    const buildScript = (): string | null => {
      switch (action) {
        case 'browser.snapshot':
          return buildSnapshotScript({ selector: asOptionalString(parameters.selector) });
        case 'browser.click':
          return buildClickScript({
            selector: asOptionalString(parameters.selector),
            text: asOptionalString(parameters.text),
          });
        case 'browser.type':
          return buildTypeScript({
            selector: String(parameters.selector ?? ''),
            value: String(parameters.value ?? ''),
            submit: parameters.submit === true,
          });
        case 'browser.inspect':
          return buildInspectScript({ selector: String(parameters.selector ?? '') });
        case 'browser.scroll':
          return buildScrollScript({
            selector: asOptionalString(parameters.selector),
            direction: asOptionalString(parameters.direction),
          });
        default:
          return null;
      }
    };

    const script = buildScript();

    if (!script) throw new Error(`Unsupported browser action: ${action}`);

    const result = await webview.executeJavaScript(script, true);
    if (!result || typeof result !== 'object') {
      throw new Error('The page returned no result');
    }
    const record = result as Record<string, unknown>;
    if (record.ok !== true) {
      throw new Error(typeof record.error === 'string' && record.error ? record.error : 'Browser action failed');
    }
    // A snapshot has to say which layout it describes, or the agent cannot tell
    // a mobile rendering from a desktop one.
    if (action === 'browser.snapshot') {
      const problems = consoleProblemsRef.current;
      return {
        ...record,
        viewport: viewportSummary(viewportRef.current),
        ...(problems.length > 0 ? { consoleProblems: [...problems] } : {}),
      };
    }
    // A click or a submit commonly starts a navigation; let it land so the
    // agent's next snapshot sees the page the action produced.
    if (action === 'browser.click' || (action === 'browser.type' && parameters.submit === true)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await waitForIdle();
    }
    return result;
  }, [annotationHost, loadUrl, waitForIdle]);

  React.useEffect(
    () => registerBrowserController({ run: runControlAction }),
    [runControlAction],
  );

  // Leaving the tab must not strand an overlay or live style overrides on the page.
  React.useEffect(() => {
    const host = annotationHost;
    return () => { void cancelAnnotationSession(host); };
  }, [annotationHost]);

  React.useEffect(() => {
    if (!webviewElement) return;
    const onConsoleMessage = (event: Event) => {
      const detail = event as unknown as { level?: number; message?: string; sourceId?: string; line?: number };
      // 2 is warning, 3 is error; anything quieter is the page talking to itself.
      if (typeof detail.level !== 'number' || detail.level < 2) return;
      const source = detail.sourceId ? `${detail.sourceId}${detail.line ? `:${detail.line}` : ''}` : '';
      consoleProblemsRef.current.push({
        level: detail.level >= 3 ? 'error' : 'warning',
        message: String(detail.message ?? '').slice(0, 400),
        source,
      });
      if (consoleProblemsRef.current.length > CONSOLE_PROBLEM_LIMIT) {
        consoleProblemsRef.current.splice(0, consoleProblemsRef.current.length - CONSOLE_PROBLEM_LIMIT);
      }
    };
    // Each page gets its own record; carrying the last one over would blame a
    // new page for the previous page's failures.
    const onStartLoading = () => { consoleProblemsRef.current = []; };

    webviewElement.addEventListener('console-message', onConsoleMessage);
    webviewElement.addEventListener('did-start-loading', onStartLoading);
    return () => {
      webviewElement.removeEventListener('console-message', onConsoleMessage);
      webviewElement.removeEventListener('did-start-loading', onStartLoading);
    };
  }, [webviewElement]);

  /**
   * Keeps loopback navigations on the machine the page came from.
   *
   * A tunnelled page can send the view to another local port — a docs server
   * behind a dev gateway, an API on its own port. That navigation happens
   * inside the view, so nothing resolved it, and it would be looked for on this
   * machine instead of the host.
   *
   * A link or a script navigation is caught before it happens. A server
   * redirect cannot be: by the time the view reports it, it is already loading.
   * That one is recovered from its failure instead, once per address, so a port
   * that genuinely is not there still fails honestly.
   */
  const retunneledUrlsRef = React.useRef(new Set<string>());
  // Asking for an address again is a fresh request, so the recovery budget
  // comes back with it. The automatic retry deliberately does not reset it.
  const loadUrlFromUser = React.useCallback((value: string) => {
    retunneledUrlsRef.current.clear();
    loadUrl(value);
  }, [loadUrl]);
  React.useEffect(() => {
    if (!webviewElement) return;

    const onWillNavigate = (event: Event) => {
      const detail = readEventPayload<{ url?: string }>(event);
      const target = typeof detail.url === 'string' ? detail.url : '';
      if (!target || !shouldTunnelLoopbackUrl(target)) return;
      event.preventDefault();
      loadUrl(target);
    };

    const onFailLoad = (event: Event) => {
      const detail = readEventPayload<{
        errorCode?: number;
        validatedURL?: string;
        isMainFrame?: boolean;
      }>(event);
      if (detail.isMainFrame === false) return;
      // Superseded navigations are not failures.
      if (detail.errorCode === -3) return;
      const target = typeof detail.validatedURL === 'string' ? detail.validatedURL : '';
      if (!target || !shouldTunnelLoopbackUrl(target)) return;
      if (retunneledUrlsRef.current.has(target)) return;
      retunneledUrlsRef.current.add(target);
      loadUrl(target);
    };

    webviewElement.addEventListener('will-navigate', onWillNavigate);
    webviewElement.addEventListener('did-fail-load', onFailLoad);
    return () => {
      webviewElement.removeEventListener('will-navigate', onWillNavigate);
      webviewElement.removeEventListener('did-fail-load', onFailLoad);
    };
  }, [loadUrl, webviewElement]);

  // Popups open in place; a detached window would escape the panel entirely.
  React.useEffect(() => {
    if (!webviewElement) return;
    const onNewWindow = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string }>).detail;
      event.preventDefault();
      if (detail?.url) loadUrl(detail.url);
    };
    webviewElement.addEventListener('new-window', onNewWindow);
    return () => webviewElement.removeEventListener('new-window', onNewWindow);
  }, [loadUrl, webviewElement]);

  const applyZoom = React.useCallback((level: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
    setZoomLevel(next);
    try {
      webviewRef.current?.setZoomLevel(next);
    } catch {
      // Not attached yet; the next change applies it.
    }
  }, []);

  const clearBrowsingData = React.useCallback((what: 'cookies' | 'cache') => {
    void invokeDesktopCommand('desktop_browser_clear_data', {
      partition: BROWSER_PARTITION,
      cookies: what === 'cookies',
      cache: what === 'cache',
    })
      .then(() => {
        toast.success(t(what === 'cookies'
          ? 'contextPanel.browser.clearedCookies'
          : 'contextPanel.browser.clearedCache'));
        // Cleared storage only shows in a page that reloads without it.
        try { webviewRef.current?.reloadIgnoringCache(); } catch { /* not attached */ }
      })
      .catch(() => toast.error(t('contextPanel.browser.clearFailed')));
  }, [t]);

  // The stage is measured rather than assumed: the panel is resizable, and a
  // viewport that fitted a moment ago may not fit now.
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ width: rect.width, height: rect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const applyColorScheme = React.useCallback((scheme: BrowserColorScheme) => {
    setColorScheme(scheme);
    const webview = webviewRef.current;
    if (!webview) return;
    let webContentsId = -1;
    try {
      webContentsId = webview.getWebContentsId();
    } catch {
      return;
    }
    void invokeDesktopCommand('desktop_browser_set_color_scheme', { webContentsId, scheme })
      .catch((error: unknown) => {
        setColorScheme('system');
        toast.error(error instanceof Error ? error.message : t('contextPanel.browser.device.schemeFailed'));
      });
  }, [t]);

  const handleReload = React.useCallback(() => {
    try {
      if (isLoading) webviewRef.current?.stop();
      else webviewRef.current?.reload();
    } catch {
      // Not attached yet.
    }
  }, [isLoading]);

  // A page opened the moment its dev server launched is not ready twice over:
  // first nothing is listening at all, then a gateway answers while the app
  // behind it is still starting. Neither is an error the user can act on, and
  // both used to leave them pressing reload. Both are waited out here.
  const status = navigation.status;
  React.useEffect(() => {
    const reloadSoon = (): (() => void) => {
      setIsWaitingForServer(true);
      const timer = setTimeout(() => {
        try {
          webviewRef.current?.reload();
        } catch {
          // View went away; the next mount starts over.
        }
      }, DEV_SERVER_RETRY_DELAY_MS);
      return () => clearTimeout(timer);
    };

    // Nothing is listening yet.
    if (status.kind === 'failed') {
      if (!isStartingServerFailure(status.code, status.url)) {
        setIsWaitingForServer(false);
        return;
      }
      const now = Date.now();
      const run = retryRef.current?.url === status.url
        ? retryRef.current
        : { url: status.url, startedAt: now };
      retryRef.current = run;
      if (now - run.startedAt > DEV_SERVER_WAIT_MS) {
        setIsWaitingForServer(false);
        return;
      }
      return reloadSoon();
    }

    // Mid-navigation: leave whatever state the previous decision set, so a
    // retry does not flash the page behind the waiting screen and back.
    if (status.kind === 'loading') return;

    retryRef.current = null;

    if (status.kind !== 'ready' || !status.url || !isLoopbackUrl(status.url)) {
      servedOkRef.current = true;
      setIsWaitingForServer(false);
      return;
    }
    if (servedOkRef.current || Date.now() - openedAtRef.current > GATEWAY_WAIT_MS) {
      servedOkRef.current = true;
      setIsWaitingForServer(false);
      return;
    }

    // The page loaded, but a 5xx here means the server answered on behalf of an
    // app that is not up yet. Checked by status rather than by reading the page:
    // guessing from its contents would mean encoding what each dev server's
    // error page looks like, which is exactly the trap this panel came out of.
    let cancelled = false;
    let cancelReload: (() => void) | null = null;
    // Probe the address on the host, not the local tunnel port: the check runs
    // on the server, where our ephemeral port means nothing. Asking about it
    // failed every time, which read as "settled" and left the page on the error
    // until a manual reload.
    void probeLoopbackStatus(toDisplayUrl(status.url)).then((httpStatus) => {
      if (cancelled) return;
      if (httpStatus === null || httpStatus < 500) {
        servedOkRef.current = true;
        setIsWaitingForServer(false);
        return;
      }
      cancelReload = reloadSoon();
    });
    return () => {
      cancelled = true;
      cancelReload?.();
    };
  }, [status]);

  const failed = navigation.status.kind === 'failed' && !isWaitingForServer ? navigation.status : null;
  const layout = fitViewport(viewport, stageSize);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={loadUrlFromUser}
        suggestions={suggestions}
        onForgetSuggestion={(url) => forgetHistoryVisit(directory, url)}
        onBack={() => { try { webviewRef.current?.goBack(); } catch { /* not attached */ } }}
        onForward={() => { try { webviewRef.current?.goForward(); } catch { /* not attached */ } }}
        onReload={handleReload}
        onOpenExternal={() => void openExternalUrl(navigation.url || address)}
        canGoBack={navigation.canGoBack}
        canGoForward={navigation.canGoForward}
        isLoading={isLoading}
        onAnnotate={handleAnnotate}
        isAnnotating={isAnnotating}
        onOpenDevTools={() => { try { webviewRef.current?.openDevTools(); } catch { /* not attached */ } }}
        onHardReload={() => { try { webviewRef.current?.reloadIgnoringCache(); } catch { /* not attached */ } }}
        onZoomIn={() => applyZoom(zoomLevel + ZOOM_STEP)}
        onZoomOut={() => applyZoom(zoomLevel - ZOOM_STEP)}
        onZoomReset={() => applyZoom(0)}
        zoomPercent={Math.round(Math.pow(1.2, zoomLevel) * 100)}
        onClearCookies={() => clearBrowsingData('cookies')}
        onClearCache={() => clearBrowsingData('cache')}
        onToggleDeviceBar={() => setShowDeviceBar((current) => !current)}
        isDeviceBarOpen={showDeviceBar}
      />
      {showDeviceBar ? (
        <BrowserDeviceBar
          viewport={viewport}
          onViewportChange={setViewport}
          colorScheme={colorScheme}
          onColorSchemeChange={applyColorScheme}
          scale={layout?.scale ?? 1}
        />
      ) : null}
      <div
        ref={stageRef}
        className={cn(
          'relative min-h-0 flex-1 bg-background',
          // A sized viewport sits on a backdrop so its edges are visible; at
          // fill there is nothing to frame.
          layout && 'flex items-center justify-center overflow-hidden bg-[var(--surface-muted)]',
        )}
      >
        {initialSrc !== null ? (
          <webview
            ref={attachWebview}
            src={initialSrc}
            partition="persist:openchamber-browser"
            allowpopups
            style={layout
              ? {
                // Laid out at the chosen size and scaled visually: the page must
                // measure itself at the width being tested, not at the panel's.
                width: `${layout.width}px`,
                height: `${layout.height}px`,
                transform: `scale(${layout.scale})`,
                border: 'none',
                flex: 'none',
                boxShadow: '0 2px 18px rgba(0,0,0,.28)',
              }
              : { width: '100%', height: '100%', border: 'none' }}
          />
        ) : null}
        {initialSrc !== null && !startUrl && !navigation.url && !isLoading ? (
          <BrowserEmptyState onOpen={loadUrlFromUser} directory={directory} />
        ) : null}
        {isWaitingForServer ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.waitingForServer')}</span>
            <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.waitingForServerHint')}</span>
          </div>
        ) : null}
        {tunnelFailedUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.tunnelFailed')}</span>
            <span className="typography-micro text-muted-foreground">
              {t('contextPanel.browser.tunnelFailedHint', { url: tunnelFailedUrl })}
            </span>
          </div>
        ) : null}
        {failed && !tunnelFailedUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">
              {failed.crashed ? t('contextPanel.browser.crashed') : t('contextPanel.browser.loadFailed')}
            </span>
            <span className="typography-micro text-muted-foreground">
              {failed.crashed
                ? t('contextPanel.browser.crashedHint')
                : failed.description || t('contextPanel.browser.loadFailedUnknown')}
            </span>
          </div>
        ) : null}
        {isLoading ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
            <div className="h-full w-1/3 animate-[browser-progress_1.1s_ease-in-out_infinite] bg-[var(--primary)]" />
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Non-Chromium runtimes get a plain iframe. Same-origin policy makes the page
 * opaque to us here: no navigation events, no annotation, no console. The
 * toolbar reflects that instead of offering controls that would silently fail.
 */
const IframeBrowser: React.FC<BrowserPaneProps> = ({ initialUrl, directory, tabID }) => {
  const { t } = useI18n();
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== BLANK_URL ? normalized : '';

  const [address, setAddress] = React.useState(startUrl);
  const [loadedUrl, setLoadedUrl] = React.useState(startUrl);
  const [history, setHistory] = React.useState<string[]>(startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === BLANK_URL || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const visitedAddresses = useBrowserHistoryStore(selectBrowserHistory(directory));
  const recordHistoryVisit = useBrowserHistoryStore((state) => state.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((state) => state.forget);
  const suggestions = React.useMemo(
    () => suggestFromHistory(visitedAddresses, address),
    [visitedAddresses, address],
  );

  const navigate = React.useCallback((value: string) => {
    const next = normalizeBrowserUrl(value);
    if (next === BLANK_URL) return;
    setAddress(next);
    setLoadedUrl(next);
    persistUrl(next);
    // The page is opaque here, so there is no load event and no title to wait
    // for; what was asked for is the only thing this runtime can record.
    recordHistoryVisit(directory, { url: next });
    setHistory((current) => {
      const kept = historyIndex >= 0 ? current.slice(0, historyIndex + 1) : [];
      if (kept[kept.length - 1] === next) {
        setHistoryIndex(kept.length - 1);
        return kept;
      }
      setHistoryIndex(kept.length);
      return [...kept, next];
    });
  }, [directory, historyIndex, persistUrl, recordHistoryVisit]);

  const goTo = React.useCallback((index: number) => {
    const next = history[index];
    if (!next) return;
    setHistoryIndex(index);
    setAddress(next);
    setLoadedUrl(next);
    persistUrl(next);
  }, [history, persistUrl]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={navigate}
        suggestions={suggestions}
        onForgetSuggestion={(url) => forgetHistoryVisit(directory, url)}
        onBack={() => goTo(historyIndex - 1)}
        onForward={() => goTo(historyIndex + 1)}
        onReload={bumpReload}
        onOpenExternal={() => void openExternalUrl(loadedUrl || address)}
        canGoBack={historyIndex > 0}
        canGoForward={historyIndex >= 0 && historyIndex < history.length - 1}
        isLoading={false}
      />
      <div className="relative min-h-0 flex-1 bg-background">
        {loadedUrl ? (
          <iframe
            key={`${loadedUrl}|${reloadNonce}`}
            src={loadedUrl}
            title={t('contextPanel.browser.frameTitle')}
            className="h-full w-full border-none bg-white"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          />
        ) : (
          <BrowserEmptyState onOpen={navigate} />
        )}
      </div>
    </div>
  );
};

export const BrowserPane: React.FC<BrowserPaneProps> = (props) => {
  const [chromium] = React.useState(isChromiumHost);
  return chromium ? <WebviewBrowser {...props} /> : <IframeBrowser {...props} />;
};
