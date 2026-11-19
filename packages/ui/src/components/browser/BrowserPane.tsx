import { isIMECompositionEvent } from '@/lib/ime';
import React from 'react';
import { z } from 'zod';

import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';
import { cn, isMacOS } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { BLANK_URL, browserUrlLabel, isLoopbackUrl, normalizeBrowserUrl } from '@/lib/browser/url';
import {
  acceptsBrowserTabLoadRequest,
  forgetBrowserTabOpenedWithAddress,
  subscribeBrowserTabLoadRequests,
  wasBrowserTabOpenedWithAddress,
} from '@/lib/browser/devServerWait';
import {
  cancelAnnotationSession,
  runAnnotationSession,
  type AnnotationHost,
  type PageCapture,
} from '@/lib/browser/annotationSession';
import { resolveAnnotationOverlayTheme } from '@/lib/browser/overlayTheme';
import { openBrowserTabForSession, registerBrowserController } from '@/lib/browser/controlClient';
import { suggestFromHistory } from '@/lib/browser/history';
import { selectBrowserHistory, useBrowserHistoryStore } from '@/stores/useBrowserHistoryStore';
import {
  DevTunnelUnavailableError,
  isRemoteWebLoopbackUrl,
  resolveBrowsableUrl,
  resolveIframeBrowserUrl,
  shouldTunnelLoopbackUrl,
  toDisplayUrl,
} from '@/lib/browser/devTunnel';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { isCapacitorApp } from '@/lib/platform';
import { isPreviewFrameGuard, pushPreviewFrameGuard } from '@/lib/router/backGuard';
import { useSpaceMarkLabel } from '@/lib/spaces/space-mark';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { useDevServerWait } from '@/hooks/useDevServerWait';
import { buildQuietScript } from '@/lib/browser/pageActions';
import { createPageDriver, pageActionParametersSchema, type DriveStep, type JsonObject } from '@/lib/browser/pageDriver';
import type { JsonValue } from '@openchamber/sdk';
import { stageBrowserUpload, type UploadTicket } from '@/lib/browser/uploads';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserDeviceBar, type BrowserColorScheme } from './BrowserDeviceBar';
import {
  FILL_VIEWPORT,
  fitViewport,
  isViewportMode,
  viewportForMode,
  viewportSummary,
  type BrowserViewport,
  viewportSize,
} from '@/lib/browser/viewport';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useAnnotationAttach, useAnnotationOverlayLabels } from './useAnnotationAttach';
import { AnnotationDictation, type AnnotationVoiceChannel } from './AnnotationDictation';
import { useAnnotationVoice } from './useAnnotationVoice';
import type { AnnotationOverlayMessage } from '@/lib/browser/annotationOverlay';
import { readEventPayload, useWebviewNavigation } from './useWebviewNavigation';
import { useSteadyStage } from './useSteadyStage';
import { deepActiveElement, isStageShown, useWebviewFocusGuard, type HoldPageFocus } from './useWebviewFocusGuard';

export type BrowserPaneProps = {
  initialUrl: string;
  directory: string;
  siteDirectory: string;
  tabID: string;
  ownerSessionId: string | null;
  showHome?: boolean;
  registerBackHandler?: (handler: (() => boolean) | null) => void;
  visible: boolean;
};

const isChromiumHost = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__)
);

// external: https://www.electronjs.org/docs/latest/api/web-contents#contentssetzoomlevellevel Chromium maps zoom level to factor as 1.2 ^ level.
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
const BROWSER_PARTITION = 'persist:openchamber-browser';
const addressMarkOf = (directory: string, address: string, label: string): { icon: 'instance'; label: string } | undefined => (
  spaceIdOfDirectory(directory) !== null && isLoopbackUrl(address) ? { icon: 'instance', label } : undefined
);

const AGENT_BROWSER_PARTITION = 'persist:openchamber-browser-agent';

const browserPartitionOf = (directory: string, agentProfile = false): string => {
  const spaceId = spaceIdOfDirectory(directory);
  if (spaceId) return `openchamber-space-preview:${spaceId}`;
  return agentProfile ? AGENT_BROWSER_PARTITION : BROWSER_PARTITION;
};
const BROWSER_OPEN_TAB_EVENT = 'openchamber:browser-panel-open-tab';
const browserTabRequestSchema = z.object({
  webContentsId: z.number(),
  url: z.string().min(1),
  background: z.boolean(),
});
const CONSOLE_PROBLEM_LIMIT = 20;
const VIEW_READY_TIMEOUT_MS = 15_000;
const PAGE_QUIET_MS = 500;
const OPEN_QUIET_MAX_MS = 5_000;
const OPEN_SETTLE_BUDGET_MS = 30_000;
const CAPTURE_QUIET_MAX_MS = 3_000;
const INPUT_TIMEOUT_MS = 12_000;
const CAPTURE_FRAME_WAIT_MAX_MS = 1_000;
const CAPTURE_FRAME_TIMER_LATE_MS = 250;
const quietResultSchema = z.object({ quiet: z.boolean() });
const answeredDialogsSchema = z.array(z.object({ answer: z.string() }).catchall(z.json()));
const jsonObjectSchema = z.record(z.string(), z.json());
const annotateReplySchema = z.object({ value: z.json().nullable() });
const annotationMessageReplySchema = z.object({ ended: z.boolean().optional(), message: z.string().nullable().optional() });
const overlayMessageSchema = z.object({ type: z.literal('voice'), action: z.enum(['start', 'finish', 'cancel']) });

// external: https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_surface-request-frame A compositor may withhold frame callbacks for an invisible surface.
const waitForTwoFrames = (): Promise<boolean> => new Promise((resolve) => {
  let frames = 0;
  let framesAtArm = 0;
  let due = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (drawn: boolean) => {
    clearTimeout(timer);
    resolve(drawn);
  };
  const onFrame = () => {
    frames += 1;
    if (frames >= 2) finish(true);
    else requestAnimationFrame(onFrame);
  };
  const arm = () => {
    framesAtArm = frames;
    due = performance.now() + CAPTURE_FRAME_WAIT_MAX_MS;
    timer = setTimeout(check, CAPTURE_FRAME_WAIT_MAX_MS);
  };
  const check = () => {
    if (frames > framesAtArm || performance.now() - due > CAPTURE_FRAME_TIMER_LATE_MS) arm();
    else finish(false);
  };
  requestAnimationFrame(onFrame);
  arm();
});

const revealStage = (stage: HTMLElement | null, purpose: 'capture' | 'input'): (() => void) => {
  if (!stage || isStageShown(stage)) return () => {};
  const rect = stage.getBoundingClientRect();
  const previousStyle = stage.style.cssText;
  Object.assign(stage.style, {
    position: 'fixed',
    top: `${rect.top}px`,
    left: `${Math.max(0, Math.min(rect.left, window.innerWidth - rect.width))}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    visibility: 'visible',
    opacity: '0',
    ...(purpose === 'input' ? { pointerEvents: 'auto', zIndex: '-1' } : { pointerEvents: 'none' }),
  });
  return () => { stage.style.cssText = previousStyle; };
};

const WebviewBrowser: React.FC<BrowserPaneProps> = ({ initialUrl, directory: tabsDirectory, siteDirectory: directory, tabID, ownerSessionId, visible }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const [webviewElement, setWebviewElement] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => {
    webviewRef.current = node;
    setWebviewElement(node);
  }, []);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const agentBrowserSharesLogins = useUIStore((state) => state.agentBrowserSharesLogins);
  const partition = browserPartitionOf(directory, ownerSessionId !== null && !agentBrowserSharesLogins);

  const initialUrlRef = React.useRef(normalizeBrowserUrl(initialUrl));
  const startUrl = initialUrlRef.current !== BLANK_URL ? initialUrlRef.current : '';

  const [initialSrc, setInitialSrc] = React.useState<string | null>(startUrl ? null : BLANK_URL);
  const spaceMark = useSpaceMarkLabel(directory);

  const [address, setAddress] = React.useState(startUrl);
  const [isAnnotating, setIsAnnotating] = React.useState(false);
  const [zoomLevel, setZoomLevel] = React.useState(0);
  const zoomLevelRef = React.useRef(0);
  const [showDeviceBar, setShowDeviceBar] = React.useState(false);
  const [viewport, setViewport] = React.useState<BrowserViewport>(FILL_VIEWPORT);
  const viewportRef = React.useRef(viewport);
  viewportRef.current = viewport;
  const consoleProblemsRef = React.useRef<Array<{ level: string; message: string; source: string }>>([]);
  const [colorScheme, setColorScheme] = React.useState<BrowserColorScheme>('system');
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const tabDirectory = normalizeContextPanelDirectoryKey(tabsDirectory);
  const restoredLoadRef = React.useRef(Boolean(startUrl) && !wasBrowserTabOpenedWithAddress(tabDirectory, tabID));
  React.useEffect(() => {
    forgetBrowserTabOpenedWithAddress(tabDirectory, tabID);
  }, [tabDirectory, tabID]);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === BLANK_URL || !tabsDirectory || !tabID) return;
    setContextPanelTabTargetPath(tabsDirectory, tabID, url);
  }, [tabsDirectory, tabID, setContextPanelTabTargetPath]);

  const navigation = useWebviewNavigation(webviewElement, {
    initialUrl: startUrl,
    onUrlChange: React.useCallback((url: string) => {
      const display = toDisplayUrl(url);
      setAddress(display);
      persistUrl(display);
    }, [persistUrl]),
  });

  const [tunnelFailedUrl, setTunnelFailedUrl] = React.useState<string | null>(null);
  const [sessionReady, setSessionReady] = React.useState(spaceIdOfDirectory(directory) === null);
  React.useEffect(() => {
    const spaceId = spaceIdOfDirectory(directory);
    if (spaceId === null) { setSessionReady(true); return; }
    let active = true;
    setSessionReady(false);
    void invokeDesktopCommand('desktop_space_preview_prepare', { spaceId })
      .then(() => { if (active) setSessionReady(true); })
      .catch(() => { if (active) setTunnelFailedUrl(startUrl || 'http://localhost/'); });
    return () => { active = false; };
  }, [directory, startUrl]);
  const attachAnnotation = useAnnotationAttach(tabsDirectory);
  const overlayLabels = useAnnotationOverlayLabels();
  const annotationVoice = useAnnotationVoice();
  const isLoading = navigation.status.kind === 'loading';

  const history = useBrowserHistoryStore(selectBrowserHistory(directory));
  const recordHistoryVisit = useBrowserHistoryStore((state) => state.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((state) => state.forget);
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
    restoredLoadRef.current = false;
    setAddress(next);
    setTunnelFailedUrl(null);
    void resolveBrowsableUrl(next, directory).then((target) => {
      const webview = webviewRef.current;
      if (!webview) {
        setInitialSrc(target);
        return;
      }
      try {
        webview.loadURL(target);
      } catch {
        setInitialSrc(target);
      }
    }).catch((error: unknown) => {
      if (error instanceof DevTunnelUnavailableError) setTunnelFailedUrl(next);
    });
  }, [directory]);

  React.useEffect(() => {
    if (!startUrl) return;
    let active = true;
    void resolveBrowsableUrl(startUrl, directory)
      .then((target) => { if (active) setInitialSrc(target); })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DevTunnelUnavailableError) {
          setTunnelFailedUrl(startUrl);
          restoredLoadRef.current = false;
          setInitialSrc(BLANK_URL);
          return;
        }
        setInitialSrc(startUrl);
      });
    return () => { active = false; };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageReachedRef = React.useRef(false);
  React.useEffect(() => {
    if (!webviewElement) return;
    const onSettled = () => { pageReachedRef.current = true; };
    webviewElement.addEventListener('dom-ready', onSettled);
    webviewElement.addEventListener('did-fail-load', onSettled);
    return () => {
      webviewElement.removeEventListener('dom-ready', onSettled);
      webviewElement.removeEventListener('did-fail-load', onSettled);
    };
  }, [webviewElement]);

  const waitForView = React.useCallback(async (): Promise<WebviewElement | null> => {
    const deadline = Date.now() + VIEW_READY_TIMEOUT_MS;
    while (!(webviewRef.current && pageReachedRef.current) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return webviewRef.current;
  }, []);

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
      if (Date.now() - startedAt > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }, []);

  const waitForQuiet = React.useCallback(async (webview: WebviewElement, maxMs: number): Promise<boolean> => {
    const script = buildQuietScript({ quietMs: PAGE_QUIET_MS, maxMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hostLimit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), maxMs + 1_000); });
    try {
      const result = quietResultSchema.safeParse(await Promise.race([webview.executeJavaScript(script, false), hostLimit]));
      return result.success && result.data.quiet;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const settlePage = React.useCallback(async (webview: WebviewElement, budgetMs = OPEN_SETTLE_BUDGET_MS): Promise<{ title: string; settled: boolean }> => {
    const startedAt = Date.now();
    const loaded = await waitForIdle(Math.min(25_000, Math.max(0, budgetMs - OPEN_QUIET_MAX_MS)));
    const left = budgetMs - (Date.now() - startedAt);
    const settled = loaded && left > PAGE_QUIET_MS && await waitForQuiet(webview, Math.min(OPEN_QUIET_MAX_MS, left));
    let title = '';
    try {
      title = webview.getTitle() || '';
    } catch {
      title = '';
    }
    return { title, settled };
  }, [waitForIdle, waitForQuiet]);

  const driveStep: DriveStep = React.useCallback(async (op, args = {}) => {
    const webview = webviewRef.current;
    if (!webview) throw new Error('The browser panel is not ready');
    try {
      return await invokeDesktopCommand<JsonValue>('desktop_browser_drive', { ...args, webContentsId: webview.getWebContentsId(), op });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error))
        .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
      if (message.includes('Unknown desktop command')) {
        throw new Error('This OpenChamber desktop app is older than its server and cannot run this browser action. Update the desktop app.');
      }
      throw new Error(message);
    }
  }, []);

  const withPageDrawn = React.useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    const restoreStage = revealStage(stageRef.current, 'input');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!await waitForTwoFrames()) {
        throw new Error('The OpenChamber window is not being drawn (minimized, on a workspace or tab that is not shown, or the screen is locked or off), so the page takes no input. browser.snapshot still reads the page.');
      }
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The page did not take the input in time. Take a snapshot to see its state.')), INPUT_TIMEOUT_MS);
      });
      const userFocus = webviewRef.current && document.activeElement !== webviewRef.current ? deepActiveElement() : null;
      let userActed = false;
      const onUserInput = (event: Event) => { if (event.isTrusted) userActed = true; };
      document.addEventListener('pointerdown', onUserInput, true);
      document.addEventListener('keydown', onUserInput, true);
      try {
        return await Promise.race([run(), late]);
      } finally {
        document.removeEventListener('pointerdown', onUserInput, true);
        document.removeEventListener('keydown', onUserInput, true);
        if (!userActed && userFocus?.isConnected && userFocus !== document.body && deepActiveElement() !== userFocus && document.activeElement !== webviewRef.current) {
          userFocus.focus({ preventScroll: true });
        }
      }
    } finally {
      clearTimeout(timer);
      restoreStage();
    }
  }, []);

  const pageDriver = React.useMemo(() => createPageDriver({ drive: driveStep, withInput: withPageDrawn }), [driveStep, withPageDrawn]);

  const runOverlayIsolated = React.useCallback(async (script: string, sessionId: number) => (
    annotateReplySchema.parse(await driveStep('annotate', { expression: script, sessionId })).value
  ), [driveStep]);

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

  const [voiceChannel, setVoiceChannel] = React.useState<AnnotationVoiceChannel | null>(null);

  const listenToOverlay = React.useCallback(async (listeners: Set<(message: AnnotationOverlayMessage) => void>, session: { id: number; done: boolean }) => {
    while (!session.done) {
      let reply: z.infer<typeof annotationMessageReplySchema>;
      try {
        reply = annotationMessageReplySchema.parse(await driveStep('annotationMessage', { sessionId: session.id, timeoutMs: 20_000 }));
      } catch {
        return;
      }
      if (reply.ended) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      if (!reply.message) continue;
      let parsed: z.infer<typeof overlayMessageSchema> | null = null;
      try {
        parsed = overlayMessageSchema.parse(JSON.parse(reply.message));
      } catch {
        continue;
      }
      for (const listener of [...listeners]) listener(parsed);
    }
  }, [driveStep]);

  type AnnotationRun = { id: number; done: boolean; cancelled: boolean };
  const annotationRunRef = React.useRef<AnnotationRun | null>(null);
  const annotationRunsRef = React.useRef(0);

  const cancelAnnotation = React.useCallback(() => {
    const run = annotationRunRef.current;
    annotationRunRef.current = null;
    setIsAnnotating(false);
    setVoiceChannel(null);
    if (run) {
      run.cancelled = true;
      void driveStep('annotationCancel', { sessionId: run.id }).catch(() => undefined);
    }
    void cancelAnnotationSession(annotationHost);
  }, [annotationHost, driveStep]);

  const handleAnnotate = React.useCallback(() => {
    if (isAnnotating) {
      cancelAnnotation();
      return;
    }
    if (!navigation.url) {
      toast.error(t('contextPanel.browser.annotate.noPage'));
      return;
    }

    const theme = resolveAnnotationOverlayTheme(
      currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    );

    annotationRunsRef.current += 1;
    const run: AnnotationRun = { id: annotationRunsRef.current, done: false, cancelled: false };
    annotationRunRef.current = run;
    const owns = () => annotationRunRef.current === run;
    setIsAnnotating(true);

    const listeners = new Set<(message: AnnotationOverlayMessage) => void>();
    if (annotationVoice) {
      setVoiceChannel({
        send: async (message) => { await driveStep('annotationSend', { message }); },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      });
    }
    const host: AnnotationHost = {
      ...annotationHost,
      runIsolated: async (script) => {
        if (annotationVoice) void listenToOverlay(listeners, run);
        try {
          return await runOverlayIsolated(script, run.id);
        } catch (error) {
          run.done = true;
          if (run.cancelled) return null;
          if (owns()) setVoiceChannel(null);
          throw error;
        }
      },
    };
    void runAnnotationSession({
      host,
      theme,
      labels: overlayLabels,
      voice: annotationVoice,
    })
      .finally(() => {
        run.done = true;
        if (!owns()) return;
        annotationRunRef.current = null;
        setVoiceChannel(null);
        setIsAnnotating(false);
      })
      .then(async (result) => {
        if (!result || run.cancelled) return;
        await attachAnnotation(result);
      })
      .catch(() => {
        if (!run.cancelled) toast.error(t('contextPanel.browser.annotate.failed'));
      });
  }, [annotationHost, annotationVoice, attachAnnotation, cancelAnnotation, currentTheme, driveStep, isAnnotating, listenToOverlay, navigation.url, overlayLabels, runOverlayIsolated, t]);

  React.useEffect(() => {
    if (!isAnnotating) return;
    const handler = (event: KeyboardEvent) => {
      if (isIMECompositionEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelAnnotation();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [cancelAnnotation, isAnnotating]);

  const stageUpload = React.useCallback((ticket: UploadTicket): Promise<string[]> => stageBrowserUpload(ticket, (files) => (
    invokeDesktopCommand<{ paths: string[] }>('desktop_browser_stage_upload', { files }).then((reply) => reply.paths)
  )), []);

  const performControlAction = React.useCallback(async (
    action: string,
    parameters: Record<string, unknown>,
    holdPageFocus: HoldPageFocus,
  ): Promise<unknown> => {
    const webview = await waitForView();
    if (!webview) throw new Error('The browser panel is not ready');

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
      const restoreStage = revealStage(stageRef.current, 'capture');
      try {
        if (!await waitForTwoFrames()) {
          throw new Error('The OpenChamber window is not being drawn (minimized, on a workspace or tab that is not shown, or the screen is locked or off), so nothing can be captured. browser.snapshot still reads the page.');
        }
        if (await waitForIdle()) await waitForQuiet(webview, CAPTURE_QUIET_MAX_MS);
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
      } finally {
        restoreStage();
      }
    }

    if (action === 'browser.resize') {
      if (!isViewportMode(parameters.viewport)) throw new Error('viewport is required');
      applyViewportParameter();
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
      return {
        url: normalizeBrowserUrl(url),
        ...await settlePage(webview),
        opened: true,
        viewport: viewportSummary(viewportRef.current),
      };
    }

    if (action === 'browser.settle') {
      const budget = z.number().safeParse(parameters.budgetMs);
      return settlePage(webview, budget.success ? budget.data : undefined);
    }

    await waitForIdle();

    const page = pageActionParametersSchema.parse(parameters);
    if (action === 'browser.dialog') return pageDriver.answerDialog(page);

    if (action !== 'browser.snapshot') await pageDriver.ensureNoDialog();

    const takesInput = ['browser.click', 'browser.type', 'browser.press', 'browser.hover', 'browser.drag'].includes(action);
    let releasePageFocus = (): void => {};
    if (takesInput) {
      const emulated = await invokeDesktopCommand<{ focused: boolean }>('desktop_browser_keep_page_focused', {
        webContentsId: webview.getWebContentsId(),
      }).then((reply) => reply.focused === true).catch(() => false);
      if (!emulated) {
        releasePageFocus = holdPageFocus();
        webview.focus({ preventScroll: true });
      }
    }
    let result: JsonObject;
    try {
      switch (action) {
        case 'browser.snapshot': {
          const problems = consoleProblemsRef.current;
          const answer = await pageDriver.snapshot(page);
          answer.viewport = viewportSummary(viewportRef.current);
          if (problems.length > 0) answer.consoleProblems = [...problems];
          return answer;
        }
        case 'browser.click': result = await pageDriver.click(page); break;
        case 'browser.hover': result = await pageDriver.hover(page); break;
        case 'browser.drag': result = await pageDriver.drag(page); break;
        case 'browser.type': result = await pageDriver.type(page); break;
        case 'browser.press': result = await pageDriver.press(page); break;
        case 'browser.select': result = await pageDriver.select(page); break;
        case 'browser.scroll': return pageDriver.scroll(page);
        case 'browser.inspect': return pageDriver.inspect(page);
        case 'browser.upload': {
          if (!page.upload) throw new Error('The upload came without its files');
          return pageDriver.upload(page, await stageUpload(page.upload));
        }
        case 'browser.wait':
          return pageDriver.wait(page, (ms) => new Promise((resolve) => setTimeout(resolve, ms)), () => Date.now());
        default:
          throw new Error(`Unsupported browser action: ${action}`);
      }
    } finally {
      releasePageFocus();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    await waitForIdle();
    return { url: toDisplayUrl(webview.getURL()), ...result };
  }, [annotationHost, loadUrl, pageDriver, settlePage, stageUpload, waitForIdle, waitForQuiet, waitForView]);

  React.useEffect(() => {
    if (!webviewElement || ownerSessionId === null) return;
    const answerOwnDialogs = () => { void driveStep('dialogPolicy', { auto: true }).catch(() => undefined); };
    webviewElement.addEventListener('did-attach', answerOwnDialogs);
    webviewElement.addEventListener('did-start-loading', answerOwnDialogs);
    webviewElement.addEventListener('dom-ready', answerOwnDialogs);
    return () => {
      webviewElement.removeEventListener('did-attach', answerOwnDialogs);
      webviewElement.removeEventListener('did-start-loading', answerOwnDialogs);
      webviewElement.removeEventListener('dom-ready', answerOwnDialogs);
    };
  }, [driveStep, ownerSessionId, webviewElement]);

  const guardAgentAction = useWebviewFocusGuard(webviewElement, stageRef);
  const [agentDriven, setAgentDriven] = React.useState(false);
  const answeringOwnDialogs = React.useCallback(async <T,>(action: string, acceptDialogs: boolean, run: () => Promise<T>): Promise<T | JsonObject> => {
    if (ownerSessionId === null) return run();
    if (action === 'browser.dialog') {
      throw new Error('This tab answers its dialogs as they open, no by default. To answer yes, repeat the action that opened it with dialog: "accept".');
    }
    const deadline = Date.now() + VIEW_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await driveStep('dialogPolicy', { auto: true });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await driveStep('armDialog', { accept: acceptDialogs });
    let outcome: T;
    try {
      outcome = await run();
    } finally {
      await driveStep('armDialog', { accept: false }).catch(() => null);
    }
    const answered = answeredDialogsSchema.safeParse(await driveStep('takeAnsweredDialogs').catch(() => []));
    const reported = jsonObjectSchema.safeParse(outcome);
    if (!answered.success || answered.data.length === 0 || !reported.success) return outcome;
    const answer: JsonObject = { ...reported.data, dialogs: answered.data };
    if (answered.data.some((dialog) => dialog.answer === 'dismissed')) {
      answer.note = 'The page showed a dialog and it was answered no. To answer yes, repeat the action with dialog: "accept".';
    }
    return answer;
  }, [driveStep, ownerSessionId]);

  const actionQueueRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const runControlAction = React.useCallback((action: string, parameters: Record<string, unknown>) => {
    setAgentDriven(true);
    const next = actionQueueRef.current.catch(() => undefined).then(() => guardAgentAction((holdPageFocus) => (
      answeringOwnDialogs(action, parameters.dialog === 'accept', () => performControlAction(action, parameters, holdPageFocus))
    )));
    actionQueueRef.current = next;
    return next;
  }, [answeringOwnDialogs, guardAgentAction, performControlAction]);

  const describeTab = React.useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return { title: '', url: '' };
    let title = '';
    let url = '';
    try { title = webview.getTitle() || ''; } catch { title = ''; }
    try { url = toDisplayUrl(webview.getURL()); } catch { url = ''; }
    return { title, url };
  }, []);

  React.useEffect(
    () => registerBrowserController({
      tabId: tabID,
      directory: tabDirectory,
      ownerSessionId,
      describe: describeTab,
      run: runControlAction,
    }),
    [describeTab, ownerSessionId, runControlAction, tabDirectory, tabID],
  );

  React.useEffect(() => {
    const host = annotationHost;
    return () => { void cancelAnnotationSession(host); };
  }, [annotationHost]);

  React.useEffect(() => {
    if (!webviewElement) return;
    const onConsoleMessage = (event: Event) => {
      const detail = event as unknown as { level?: number; message?: string; sourceId?: string; line?: number };
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
    const onStartLoading = () => { consoleProblemsRef.current = []; };

    webviewElement.addEventListener('console-message', onConsoleMessage);
    webviewElement.addEventListener('did-start-loading', onStartLoading);
    return () => {
      webviewElement.removeEventListener('console-message', onConsoleMessage);
      webviewElement.removeEventListener('did-start-loading', onStartLoading);
    };
  }, [webviewElement]);

  const retunneledUrlsRef = React.useRef(new Set<string>());
  const loadUrlFromUser = React.useCallback((value: string) => {
    retunneledUrlsRef.current.clear();
    loadUrl(value);
  }, [loadUrl]);
  const navStatusRef = React.useRef(navigation.status);
  navStatusRef.current = navigation.status;
  const reloadView = React.useCallback(() => {
    try {
      webviewRef.current?.reload();
    } catch {
      // View went away; the next mount starts over.
    }
  }, []);
  const { isWaitingForServer, rearm: rearmServerWait } = useDevServerWait({
    status: navigation.status,
    directory,
    visible,
    watchedOutOfSight: ownerSessionId !== null || agentDriven,
    restoredLoadRef,
    reload: reloadView,
  });
  const hasShownPageRef = React.useRef(false);
  if (navigation.status.kind === 'ready' && navigation.status.url) hasShownPageRef.current = true;
  React.useEffect(
    () => subscribeBrowserTabLoadRequests(tabDirectory, tabID, (url) => {
      if (!acceptsBrowserTabLoadRequest(navStatusRef.current, hasShownPageRef.current)) return;
      rearmServerWait();
      loadUrlFromUser(url);
    }),
    [loadUrlFromUser, rearmServerWait, tabDirectory, tabID],
  );
  React.useEffect(() => {
    if (!webviewElement) return;

    const onWillNavigate = (event: Event) => {
      const detail = readEventPayload<{ url?: string }>(event);
      const target = typeof detail.url === 'string' ? detail.url : '';
      if (!target || !shouldTunnelLoopbackUrl(target, directory)) return;
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
      if (detail.errorCode === -3) return;
      const target = typeof detail.validatedURL === 'string' ? detail.validatedURL : '';
      if (!target || !shouldTunnelLoopbackUrl(target, directory)) return;
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
  }, [directory, loadUrl, webviewElement]);

  React.useEffect(() => {
    if (!webviewElement) return;
    const onOpenTab = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const request = browserTabRequestSchema.safeParse(event.detail);
      if (!request.success) return;
      let ownId = -1;
      try {
        ownId = webviewElement.getWebContentsId();
      } catch {
        return;
      }
      if (request.data.webContentsId !== ownId) return;
      if (ownerSessionId !== null) {
        openBrowserTabForSession(request.data.url, { directory: tabDirectory, sessionId: ownerSessionId });
        return;
      }
      useUIStore.getState().openContextBrowser(tabDirectory, request.data.url, { reveal: !request.data.background });
    };
    window.addEventListener(BROWSER_OPEN_TAB_EVENT, onOpenTab);
    return () => window.removeEventListener(BROWSER_OPEN_TAB_EVENT, onOpenTab);
  }, [ownerSessionId, tabDirectory, webviewElement]);

  const applyZoom = React.useCallback((level: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
    zoomLevelRef.current = next;
    setZoomLevel(next);
    try {
      webviewRef.current?.setZoomLevel(next);
    } catch {
      // Not attached yet; the next change applies it.
    }
  }, []);

  React.useEffect(() => {
    const handleZoom = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const action = event.detail;
      const webview = webviewRef.current;
      if (!webview || document.activeElement !== webview) return;
      if (action === 'zoom-in') applyZoom(zoomLevelRef.current + ZOOM_STEP);
      else if (action === 'zoom-out') applyZoom(zoomLevelRef.current - ZOOM_STEP);
      else if (action === 'zoom-reset') applyZoom(0);
    };
    window.addEventListener('openchamber:zoom', handleZoom);
    return () => window.removeEventListener('openchamber:zoom', handleZoom);
  }, [applyZoom]);

  const clearBrowsingData = React.useCallback((what: 'cookies' | 'cache') => {
    void invokeDesktopCommand('desktop_browser_clear_data', {
      partition,
      cookies: what === 'cookies',
      cache: what === 'cache',
    })
      .then(() => {
        toast.success(t(what === 'cookies'
          ? 'contextPanel.browser.clearedCookies'
          : 'contextPanel.browser.clearedCache'));
        try { webviewRef.current?.reloadIgnoringCache(); } catch { /* not attached */ }
      })
      .catch(() => toast.error(t('contextPanel.browser.clearFailed')));
  }, [partition, t]);

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

  const failed = navigation.status.kind === 'failed' && !isWaitingForServer ? navigation.status : null;
  const stageSize = useSteadyStage(stageRef, webviewRef, viewportSize(viewport) !== null);
  const layout = fitViewport(viewport, stageSize);

  const handleReloadShortcut = (event: React.KeyboardEvent): void => {
    const mod = isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!mod || event.altKey || event.repeat || event.key.toLowerCase() !== 'r') return;
    event.preventDefault();
    try {
      if (event.shiftKey) webviewRef.current?.reloadIgnoringCache();
      else webviewRef.current?.reload();
    } catch {
      // Not attached yet.
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-background" onKeyDown={handleReloadShortcut}>
      {voiceChannel ? <AnnotationDictation channel={voiceChannel} /> : null}
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
        addressMark={addressMarkOf(directory, address, spaceMark ?? t('contextPanel.browser.spaceAddress'))}
        canOpenExternal={spaceIdOfDirectory(directory) === null}
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
          panelSize={stageSize}
        />
      ) : null}
      <div
        ref={stageRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-background',
          layout && 'flex items-center justify-center overflow-hidden bg-[var(--surface-muted)]',
        )}
      >
        {initialSrc !== null && sessionReady ? (
          <webview
            ref={attachWebview}
            src={initialSrc}
            partition={partition}
            // @ts-expect-error @types/react's WebViewHTMLAttributes requires boolean, which React omits from the DOM.
            allowpopups="true"
            // external: https://www.electronjs.org/docs/latest/api/browser-window#new-browserwindowoptions Background throttling slows hidden agent pages, so only agent tabs disable it.
            webpreferences={ownerSessionId !== null ? 'backgroundThrottling=no' : undefined}
            style={layout
              ? {
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
          <BrowserEmptyState onOpen={loadUrlFromUser} directory={directory} visible={visible} />
        ) : null}
        {isWaitingForServer ? (
          <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <Spinner className="mb-1 size-5 text-muted-foreground" aria-hidden />
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.waitingForServer')}</span>
            <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.waitingForServerHint')}</span>
          </div>
        ) : null}
        {tunnelFailedUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            {spaceIdOfDirectory(directory) !== null ? (
              <Icon name="instance" className="size-8 text-muted-foreground opacity-70" aria-hidden="true" />
            ) : null}
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.tunnelFailed')}</span>
            <span className="typography-micro text-muted-foreground">
              {t(spaceIdOfDirectory(directory) !== null
                ? 'contextPanel.browser.spaceTunnelFailedHint'
                : 'contextPanel.browser.tunnelFailedHint', { url: tunnelFailedUrl })}
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
            <div className="h-full w-1/3 bg-[var(--primary)]" />
          </div>
        ) : null}
      </div>
    </div>
  );
};

const IframeBrowser: React.FC<BrowserPaneProps> = ({ initialUrl, directory: tabsDirectory, siteDirectory: directory, tabID, visible, showHome = false, registerBackHandler }) => {
  const { t } = useI18n();
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== BLANK_URL ? normalized : '';

  const [address, setAddress] = React.useState(startUrl);
  const [loadedUrl, setLoadedUrl] = React.useState(resolveIframeBrowserUrl(startUrl, directory));
  const [unreachableUrl, setUnreachableUrl] = React.useState(
    !isCapacitorApp() && isRemoteWebLoopbackUrl(startUrl, directory) ? startUrl : '',
  );
  const [tunnelFailedUrl, setTunnelFailedUrl] = React.useState('');
  const [resolvingTunnel, setResolvingTunnel] = React.useState(false);
  const navigationId = React.useRef(0);
  const frameGuard = React.useRef<{ id: string; url: string } | null>(null);
  const insideSpace = spaceIdOfDirectory(directory) !== null;
  const spaceMark = useSpaceMarkLabel(directory);
  const [history, setHistory] = React.useState<string[]>(startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    forgetBrowserTabOpenedWithAddress(normalizeContextPanelDirectoryKey(tabsDirectory), tabID);
  }, [tabsDirectory, tabID]);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === BLANK_URL || !tabsDirectory || !tabID) return;
    setContextPanelTabTargetPath(tabsDirectory, tabID, url);
  }, [tabsDirectory, tabID, setContextPanelTabTargetPath]);

  const visitedAddresses = useBrowserHistoryStore(selectBrowserHistory(directory));
  const recordHistoryVisit = useBrowserHistoryStore((state) => state.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((state) => state.forget);
  const suggestions = React.useMemo(
    () => suggestFromHistory(visitedAddresses, address),
    [visitedAddresses, address],
  );

  const loadAddress = React.useCallback((url: string) => {
    const requestId = ++navigationId.current;
    setLoadedUrl('');
    setUnreachableUrl('');
    setTunnelFailedUrl('');
    setResolvingTunnel(false);
    if (!isCapacitorApp() || !isRemoteWebLoopbackUrl(url, directory)) {
      const resolved = resolveIframeBrowserUrl(url, directory);
      setLoadedUrl(resolved);
      setUnreachableUrl(resolved ? '' : url);
      return;
    }
    setResolvingTunnel(true);
    void resolveBrowsableUrl(url, directory).then((resolved) => {
      if (requestId !== navigationId.current) return;
      setLoadedUrl(resolved);
      setResolvingTunnel(false);
    }).catch(() => {
      if (requestId !== navigationId.current) return;
      setTunnelFailedUrl(url);
      setResolvingTunnel(false);
    });
  }, [directory]);

  React.useEffect(() => {
    if (startUrl && isCapacitorApp() && isRemoteWebLoopbackUrl(startUrl, directory)) {
      loadAddress(startUrl);
    }
    return () => { navigationId.current += 1; };
  }, [directory, loadAddress, startUrl]);

  const navigate = React.useCallback((value: string) => {
    const next = normalizeBrowserUrl(value);
    if (next === BLANK_URL) return;
    setAddress(next);
    loadAddress(next);
    persistUrl(next);
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
  }, [directory, historyIndex, loadAddress, persistUrl, recordHistoryVisit]);

  const goHome = React.useCallback(() => {
    navigationId.current += 1;
    frameGuard.current = null;
    setAddress('');
    setLoadedUrl('');
    setUnreachableUrl('');
    setTunnelFailedUrl('');
    setResolvingTunnel(false);
    setHistoryIndex(-1);
    if (tabsDirectory && tabID) setContextPanelTabTargetPath(tabsDirectory, tabID, '');
  }, [setContextPanelTabTargetPath, tabID, tabsDirectory]);

  const goTo = React.useCallback((index: number) => {
    const next = history[index];
    if (!next) return;
    setHistoryIndex(index);
    setAddress(next);
    loadAddress(next);
    persistUrl(next);
  }, [history, loadAddress, persistUrl]);

  const stepBack = React.useCallback(() => {
    if (showHome && historyIndex === 0) goHome();
    else goTo(historyIndex - 1);
  }, [goHome, goTo, historyIndex, showHome]);

  const tracksFrameHistory = Boolean(registerBackHandler);
  const stepBackRef = React.useRef(stepBack);
  React.useEffect(() => {
    stepBackRef.current = stepBack;
  }, [stepBack]);

  React.useEffect(() => {
    if (!tracksFrameHistory || !loadedUrl) return;
    const current = frameGuard.current;
    if (current?.url === loadedUrl && isPreviewFrameGuard(current.id)) return;
    const id = crypto.randomUUID();
    pushPreviewFrameGuard(id);
    frameGuard.current = { id, url: loadedUrl };
  }, [loadedUrl, tracksFrameHistory]);

  React.useEffect(() => {
    if (!tracksFrameHistory) return;
    const handlePopState = () => {
      if (!frameGuard.current) return;
      frameGuard.current = null;
      stepBackRef.current();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [tracksFrameHistory]);

  const goBack = React.useCallback(() => {
    const current = frameGuard.current;
    if (loadedUrl && current && isPreviewFrameGuard(current.id)) {
      window.history.back();
      return;
    }
    stepBack();
  }, [loadedUrl, stepBack]);

  const reload = React.useCallback(() => {
    const current = history[historyIndex];
    if (current && isCapacitorApp() && isRemoteWebLoopbackUrl(current, directory)) loadAddress(current);
    else bumpReload();
  }, [directory, history, historyIndex, loadAddress]);

  React.useEffect(() => {
    if (!registerBackHandler) return;
    registerBackHandler(() => {
      if (historyIndex < 0) return false;
      goBack();
      return true;
    });
    return () => registerBackHandler(null);
  }, [goBack, historyIndex, registerBackHandler]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={navigate}
        onHome={showHome ? goHome : undefined}
        suggestions={suggestions}
        onForgetSuggestion={(url) => forgetHistoryVisit(directory, url)}
        onBack={goBack}
        onForward={() => goTo(historyIndex + 1)}
        onReload={reload}
        onOpenExternal={() => void openExternalUrl(loadedUrl || address)}
        addressMark={addressMarkOf(directory, address, spaceMark ?? t('contextPanel.browser.spaceAddress'))}
        canOpenExternal={!unreachableUrl && !tunnelFailedUrl && !(isCapacitorApp() && isRemoteWebLoopbackUrl(address, directory))}
        canGoBack={historyIndex > 0 || (showHome && historyIndex === 0)}
        canGoForward={historyIndex < history.length - 1}
        isLoading={false}
      />
      <div className="relative min-h-0 flex-1 bg-background">
        {tunnelFailedUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.tunnelFailed')}</span>
            <span className="typography-micro text-muted-foreground">
              {t(insideSpace ? 'contextPanel.browser.spaceTunnelFailedHint' : 'contextPanel.browser.tunnelFailedHint', { url: tunnelFailedUrl })}
            </span>
          </div>
        ) : resolvingTunnel ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <Spinner className="size-5 text-muted-foreground" aria-label={t('common.loading')} />
          </div>
        ) : unreachableUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            {insideSpace ? (
              <Icon name="instance" className="size-8 text-muted-foreground opacity-70" aria-hidden="true" />
            ) : null}
            <span className="typography-ui-header text-foreground">
              {t(insideSpace ? 'contextPanel.browser.spaceLoopback.title' : 'contextPanel.browser.remoteLoopback.title', { url: browserUrlLabel(unreachableUrl) })}
            </span>
            <span className="typography-micro text-muted-foreground">
              {t('contextPanel.browser.remoteLoopback.hint')}
            </span>
          </div>
        ) : loadedUrl ? (
          <iframe
            key={`${loadedUrl}|${reloadNonce}`}
            src={loadedUrl}
            title={t('contextPanel.browser.frameTitle')}
            className="h-full w-full border-none bg-white"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          />
        ) : (
          <BrowserEmptyState onOpen={navigate} directory={directory} visible={visible} />
        )}
      </div>
    </div>
  );
};

export const BrowserPane: React.FC<BrowserPaneProps> = (props) => {
  const [chromium] = React.useState(isChromiumHost);
  return chromium ? <WebviewBrowser {...props} /> : <IframeBrowser {...props} />;
};
