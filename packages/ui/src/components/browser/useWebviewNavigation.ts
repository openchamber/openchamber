import React from 'react';
import { z } from 'zod';

import { IDLE_NAV_STATUS, type BrowserNavStatus } from '@/lib/browser/contract';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import {
  INITIAL_CRASH_RECOVERY_STATE,
  planCrashRecovery,
  type CrashRecoveryState,
} from '@/lib/browser/crashRecovery';


// external: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h ERR_ABORTED (-3) marks a cancelled navigation.
const ERR_ABORTED = -3;

const documentAnswerSchema = z.object({ httpResponseCode: z.number().int().positive() });

const isRealPageUrl = (url: unknown): url is string => (
  typeof url === 'string' && url.length > 0 && url !== 'about:blank'
);

type FailLoadDetail = {
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  isMainFrame?: boolean;
};

// external: https://www.electronjs.org/docs/latest/api/webview-tag#event-did-fail-load Electron webview events expose payload fields directly on the event.
export const readEventPayload = <T extends object>(event: Event): Partial<T> => {
  const record = event as unknown as { detail?: unknown };
  if (record.detail && typeof record.detail === 'object') return record.detail as Partial<T>;
  return event as unknown as Partial<T>;
};

export type WebviewNavigation = {
  readonly status: BrowserNavStatus;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
};

export const useWebviewNavigation = (
  webview: WebviewElement | null,
  { initialUrl, onUrlChange }: { initialUrl: string; onUrlChange: (url: string) => void },
): WebviewNavigation => {
  const [status, setStatus] = React.useState<BrowserNavStatus>(
    initialUrl ? { kind: 'loading', url: initialUrl } : IDLE_NAV_STATUS,
  );
  const [url, setUrl] = React.useState(initialUrl);
  const [title, setTitle] = React.useState('');
  const [canGoBack, setCanGoBack] = React.useState(false);
  const [canGoForward, setCanGoForward] = React.useState(false);

  const urlChangeRef = React.useRef(onUrlChange);
  urlChangeRef.current = onUrlChange;

  const crashStateRef = React.useRef<CrashRecoveryState>(INITIAL_CRASH_RECOVERY_STATE);

  React.useEffect(() => {
    if (!webview) return;

    let documentStatus: number | undefined;

    const readCurrentUrl = (): string => {
      try {
        const value = webview.getURL();
        return isRealPageUrl(value) ? value : '';
      } catch {
        return '';
      }
    };

    const syncHistory = () => {
      try {
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
      } catch {
        // Webview not attached yet; the next event resyncs.
      }
    };

    const commitUrl = (next: string) => {
      if (!isRealPageUrl(next)) return;
      setUrl(next);
      urlChangeRef.current(next);
    };

    const onStartLoading = () => {
      const current = readCurrentUrl();
      setStatus({ kind: 'loading', url: current });
    };

    const onStopLoading = () => {
      const current = readCurrentUrl();
      let pageTitle = '';
      try {
        pageTitle = webview.getTitle() || '';
      } catch {
        pageTitle = '';
      }
      setTitle(pageTitle);
      commitUrl(current);
      syncHistory();
      setStatus((previous) => (
        previous.kind === 'failed'
          ? previous
          : { kind: 'ready', url: current, title: pageTitle, httpStatus: documentStatus }
      ));
    };

    const onNavigate = (event: Event) => {
      const detail = readEventPayload<{ url?: string }>(event);
      if (isRealPageUrl(detail.url)) {
        commitUrl(detail.url);
        syncHistory();
      }
    };

    const onDocumentNavigate = (event: Event) => {
      // external: https://www.electronjs.org/docs/latest/api/webview-tag#event-did-navigate httpResponseCode is -1 for non-HTTP navigations.
      const answer = documentAnswerSchema.safeParse(readEventPayload(event));
      documentStatus = answer.success ? answer.data.httpResponseCode : undefined;
      onNavigate(event);
    };

    const onFaviconUpdated = (event: Event) => {
      const detail = readEventPayload<{ favicons?: string[] }>(event);
      const icon = Array.isArray(detail.favicons) ? detail.favicons.find(Boolean) : '';
      const page = readCurrentUrl();
      if (!icon || !page) return;
      let webContentsId = -1;
      try { webContentsId = webview.getWebContentsId(); } catch { return; }
      if (!Number.isFinite(webContentsId) || webContentsId < 0) return;
      useBrowserFaviconStore.getState().resolve(page, icon, webContentsId);
    };

    const onTitleUpdated = (event: Event) => {
      const detail = readEventPayload<{ title?: string }>(event);
      if (typeof detail.title === 'string') setTitle(detail.title);
    };

    const onFailLoad = (event: Event) => {
      const detail = readEventPayload<FailLoadDetail>(event);
      if (detail.isMainFrame === false) return;
      const code = typeof detail.errorCode === 'number' ? detail.errorCode : 0;
      if (code === ERR_ABORTED) return;
      setStatus({
        kind: 'failed',
        url: isRealPageUrl(detail.validatedURL) ? detail.validatedURL : readCurrentUrl(),
        code,
        description: typeof detail.errorDescription === 'string' ? detail.errorDescription : '',
      });
    };

    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const onCrashed = () => {
      const target = readCurrentUrl();
      const plan = planCrashRecovery(crashStateRef.current, Date.now());
      if (!plan) {
        setStatus({ kind: 'failed', url: target, code: 0, description: '', crashed: true });
        return;
      }
      crashStateRef.current = plan.state;
      setStatus({ kind: 'loading', url: target });
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        try {
          webview.reload();
        } catch {
          setStatus({ kind: 'failed', url: target, code: 0, description: '', crashed: true });
        }
      }, plan.delayMs);
    };

    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('did-navigate', onDocumentNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('page-title-updated', onTitleUpdated);
    webview.addEventListener('page-favicon-updated', onFaviconUpdated);
    webview.addEventListener('did-fail-load', onFailLoad);
    // external: https://www.electronjs.org/docs/latest/breaking-changes#removed-crashed-event Keep the legacy crashed event alongside render-process-gone for older hosts.
    webview.addEventListener('render-process-gone', onCrashed);
    webview.addEventListener('crashed', onCrashed);

    try {
      if (!webview.isLoading() && readCurrentUrl()) onStopLoading();
    } catch {
      // Not attached yet.
    }

    return () => {
      if (recoveryTimer !== null) clearTimeout(recoveryTimer);
      webview.removeEventListener('render-process-gone', onCrashed);
      webview.removeEventListener('crashed', onCrashed);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('did-navigate', onDocumentNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('page-title-updated', onTitleUpdated);
      webview.removeEventListener('page-favicon-updated', onFaviconUpdated);
      webview.removeEventListener('did-fail-load', onFailLoad);
    };
  }, [webview]);

  return { status, url, title, canGoBack, canGoForward };
};
