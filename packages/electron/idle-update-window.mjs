import { BrowserWindow } from 'electron';

import { createIdleUpdateQueue } from './idle-update.mjs';
import { countdownText, idleUpdateWindowHtml } from './idle-update-locales.mjs';

export const createDesktopIdleUpdate = ({
  state,
  emitToAllWindows,
  isLocalRuntimeUrl,
  install,
  locale,
}) => {
  let idleUpdateWindow = null;
  let idleUpdateWindowSuppressClose = false;

  const windowRuntimeUnverified = (window) => {
    if (!window || window.isDestroyed() || window.__ocIdleUpdate) return false;
    const config = window.__ocRuntimeConfig;
    const url = typeof config?.apiBaseUrl === 'string' ? config.apiBaseUrl : state.apiBaseUrl;
    return Boolean(config?.relayHostId || (url && !isLocalRuntimeUrl(url)));
  };

  const readIdle = async () => {
    const status = await state.serverHandle?.getUpdateIdleStatus?.();
    return status?.state === 'idle' && BrowserWindow.getAllWindows().some(windowRuntimeUnverified)
      ? { state: 'unknown' }
      : status;
  };

  const closeCountdown = () => {
    if (!idleUpdateWindow || idleUpdateWindow.isDestroyed()) {
      idleUpdateWindow = null;
      return;
    }
    idleUpdateWindowSuppressClose = true;
    idleUpdateWindow.destroy();
    idleUpdateWindowSuppressClose = false;
    idleUpdateWindow = null;
  };

  const paint = (snapshot, { reload = false } = {}) => {
    const window = idleUpdateWindow;
    if (!window || window.isDestroyed()) return;
    const seconds = Math.ceil(snapshot.remainingMs / 1000);
    const load = () => {
      if (window.isDestroyed()) return;
      const html = idleUpdateWindowHtml({ locale: locale(), seconds });
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    };
    if (reload || window.webContents.isLoading()) return load();
    void window.webContents.executeJavaScript(
      `document.getElementById('countdown').textContent = ${JSON.stringify(countdownText(locale(), seconds))}`,
    ).catch(load);
  };

  const openCountdown = (snapshot) => {
    if (!idleUpdateWindow || idleUpdateWindow.isDestroyed()) {
      idleUpdateWindow = new BrowserWindow({
        width: 420,
        height: 230,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        title: 'OpenChamber',
        backgroundColor: '#1c1c1c',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      idleUpdateWindow.__ocIdleUpdate = true;
      idleUpdateWindow.setMenuBarVisibility(false);
      idleUpdateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      idleUpdateWindow.webContents.on('will-navigate', (event, url) => {
        if (typeof url === 'string' && url.startsWith('data:')) return;
        event.preventDefault();
        if (typeof url === 'string' && url.startsWith('https://idle-update.invalid/cancel')) void controller.cancel();
      });
      idleUpdateWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault();
          void controller.cancel();
        }
      });
      idleUpdateWindow.on('close', (event) => {
        if (idleUpdateWindowSuppressClose) return;
        event.preventDefault();
        void controller.cancel();
      });
    }
    paint(snapshot, { reload: true });
    if (!idleUpdateWindow.isVisible()) idleUpdateWindow.show();
    idleUpdateWindow.focus();
  };

  const controller = createIdleUpdateQueue({
    readIdle,
    onChange: (snapshot) => emitToAllWindows('openchamber:idle-update', snapshot),
    openCountdown,
    updateCountdown: paint,
    closeCountdown,
    install,
  });
  return { ...controller, isClosingCountdown: () => idleUpdateWindowSuppressClose };
};
