import React from 'react';

import { browserTabRequestSchema, openBrowserTabFromLink } from '@/hooks/useBrowserTabReferrer';
import { openBrowserTabForSession } from '@/lib/browser/controlClient';
import { useUIStore } from '@/stores/useUIStore';

const BROWSER_OPEN_TAB_EVENT = 'openchamber:browser-panel-open-tab';

export const useBrowserOpenTabRequests = (
  webviewElement: WebviewElement | null,
  tabDirectory: string,
  ownerSessionId: string | null,
  usesUserLogins: boolean,
): void => {
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
      const sessionId = request.data.sessionId ?? ownerSessionId;
      openBrowserTabFromLink(tabDirectory, request.data.referrer, () => (sessionId !== null
        ? openBrowserTabForSession(request.data.url, { directory: tabDirectory, sessionId }, { usesUserLogins: ownerSessionId === null || usesUserLogins })
        : useUIStore.getState().openContextBrowser(tabDirectory, request.data.url, { reveal: !request.data.background })));
    };
    window.addEventListener(BROWSER_OPEN_TAB_EVENT, onOpenTab);
    return () => window.removeEventListener(BROWSER_OPEN_TAB_EVENT, onOpenTab);
  }, [ownerSessionId, tabDirectory, usesUserLogins, webviewElement]);
};
