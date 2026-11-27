import { browserPanelWindowOpenTarget } from './browser-panel-security.mjs';

const BROWSER_PANEL_POPUP_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
};

const PRESS_EVENTS = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart', 'gestureTap']);

export const createBrowserPanelWindowOpen = ({ BrowserWindow, log, isBrowsingSession, agentActions }) => {
  const popups = new WeakSet();

  const loadUrlInsideWebContents = (contents, rawUrl, loadOptions) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      if (contents.isDestroyed()) return false;
      void contents.loadURL(url.toString(), loadOptions).catch((error) => {
        log.warn('[webview] failed to load popup URL in place:', error);
      });
      return true;
    } catch {
      return false;
    }
  };

  const openPanelTab = (contents, { url, background, referrer, sessionId }) => {
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) {
      loadUrlInsideWebContents(contents, url, { httpReferrer: referrer });
      return;
    }
    host.send('openchamber:emit', {
      event: 'openchamber:browser-panel-open-tab',
      detail: { webContentsId: contents.id, url, background, referrer, sessionId },
    });
  };

  const trackPopup = (contents, popup) => {
    popups.add(popup);
    popup.webContents.setWindowOpenHandler(({ url }) => {
      loadUrlInsideWebContents(popup.webContents, url);
      return { action: 'deny' };
    });
    const hostWindow = contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null;
    if (!hostWindow) return;
    const closePopup = () => {
      if (!popup.isDestroyed()) popup.close();
    };
    hostWindow.once('closed', closePopup);
    popup.once('closed', () => {
      if (!hostWindow.isDestroyed()) hostWindow.removeListener('closed', closePopup);
    });
  };

  // external: https://github.com/electron/electron/issues/45897 Restart non-POST popup navigation from main so it uses the panel session user agent.
  const loadPopupWithPanelUserAgent = (popup, { url, referrer }) => {
    const contents = popup.webContents;
    contents.once('will-navigate', (event, navigationUrl) => {
      if (navigationUrl !== url) return;
      event.preventDefault();
      setImmediate(() => {
        if (contents.isDestroyed()) return;
        loadUrlInsideWebContents(contents, url, {
          userAgent: contents.session.getUserAgent(),
          httpReferrer: referrer,
        });
      });
    });
  };

  const attach = (contents) => {
    contents.on('input-event', (_event, input) => {
      if (PRESS_EVENTS.has(input.type)) agentActions.userInput(contents);
    });
    contents.setWindowOpenHandler(({ url, disposition, postBody, referrer }) => {
      const agentAction = agentActions.actingSession(contents);
      const target = isBrowsingSession(contents.session)
        ? browserPanelWindowOpenTarget({ url, disposition, hasPostBody: Boolean(postBody), agentActing: agentAction !== null })
        : 'in-place';
      if (target === 'agent-tab') {
        openPanelTab(contents, { url, background: true, referrer, sessionId: agentAction.sessionId ?? undefined });
        return { action: 'deny' };
      }
      if (target === 'popup') {
        const hostWindow = contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null;
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: hostWindow ?? undefined,
            autoHideMenuBar: true,
            webPreferences: BROWSER_PANEL_POPUP_WEB_PREFERENCES,
          },
          createWindow: (options) => {
            const popup = new BrowserWindow(options);
            trackPopup(contents, popup);
            if (!postBody) loadPopupWithPanelUserAgent(popup, { url, referrer });
            return popup.webContents;
          },
        };
      }
      if (target === 'tab' || target === 'background-tab') {
        openPanelTab(contents, { url, background: target === 'background-tab', referrer });
      } else if (target === 'in-place') {
        loadUrlInsideWebContents(contents, url, { httpReferrer: referrer });
      }
      return { action: 'deny' };
    });
  };

  return { attach, isBrowserPanelPopup: (browserWindow) => popups.has(browserWindow) };
};
