import React from 'react';
import { z } from 'zod';

import { readEventPayload } from '@/components/browser/useWebviewNavigation';
import {
  browserTabFirstLoadReferrer,
  noteBrowserTabFirstLoadReferrer,
  openWithBrowserTabLinkReferrer,
  wasBrowserTabOpenedWithAddress,
  type BrowserTabReferrer,
} from '@/lib/browser/devServerWait';
import { BLANK_URL } from '@/lib/browser/url';
import { useUIStore } from '@/stores/useUIStore';

export const browserTabRequestSchema = z.object({
  webContentsId: z.number(),
  url: z.string().min(1),
  background: z.boolean(),
  referrer: z.object({ url: z.string(), policy: z.string() }).optional(),
});

const ERR_ABORTED = -3;

const guestCrashed = (webview: WebviewElement): boolean => {
  try {
    return webview.isCrashed();
  } catch {
    return true;
  }
};

const browserTabIDs = (directory: string): Set<string> => new Set(
  useUIStore.getState().contextPanelByDirectory[directory]?.tabs.map((tab) => tab.id),
);

export const openBrowserTabFromLink = (directory: string, referrer: BrowserTabReferrer | undefined, open: () => void): void => {
  const tabsBefore = browserTabIDs(directory);
  openWithBrowserTabLinkReferrer(referrer, open);
  if (!referrer) return;
  for (const tabID of browserTabIDs(directory)) {
    if (!tabsBefore.has(tabID) && wasBrowserTabOpenedWithAddress(directory, tabID)) noteBrowserTabFirstLoadReferrer(directory, tabID, referrer);
  }
};

export const useBrowserTabReferrer = (
  webview: WebviewElement | null,
  directory: string,
  tabID: string,
  url: string | null,
  linkTarget: string | null,
  onFirstPage: () => void,
): BrowserTabReferrer | undefined => {
  const linkReferrer = React.useRef(browserTabFirstLoadReferrer(directory, tabID)).current;
  const referrer = url !== null && url === linkTarget ? linkReferrer : undefined;
  React.useEffect(() => {
    if (!webview || !referrer || !url || url === BLANK_URL) return;
    const firstLoad = new AbortController();
    const { signal } = firstLoad;
    let firstLoadState: 'load' | 'requested' | 'started' | 'ended' = 'load';
    const dropBlankHistoryEntry = (event: Event) => {
      const { isMainFrame, errorCode, url: committedUrl } = readEventPayload<{ isMainFrame?: boolean; errorCode?: number; url?: string }>(event);
      if (isMainFrame === false || errorCode === ERR_ABORTED || committedUrl === BLANK_URL) return;
      firstLoad.abort();
      webview.clearHistory();
      onFirstPage();
    };
    webview.addEventListener('did-navigate', dropBlankHistoryEntry, { capture: true, signal });
    webview.addEventListener('did-fail-load', dropBlankHistoryEntry, { capture: true, signal });
    webview.addEventListener('dom-ready', () => {
      if (firstLoadState !== 'load') return;
      firstLoadState = 'requested';
      webview.loadURL(url, { httpReferrer: referrer }).catch(() => undefined);
    }, { signal });
    webview.addEventListener('did-start-navigation', () => {
      if (firstLoadState === 'requested') firstLoadState = 'started';
      else if (firstLoadState === 'ended') firstLoad.abort();
    }, { signal });
    webview.addEventListener('did-stop-loading', () => {
      if (firstLoadState === 'started' && !guestCrashed(webview)) firstLoadState = 'ended';
    }, { signal });
    const reloadAfterCrash = () => {
      if (firstLoadState !== 'ended') firstLoadState = 'load';
    };
    webview.addEventListener('render-process-gone', reloadAfterCrash, { signal });
    webview.addEventListener('crashed', reloadAfterCrash, { signal });
    return () => firstLoad.abort();
  }, [webview, referrer, url, onFirstPage]);
  return referrer;
};
