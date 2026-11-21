import { BrowserWindow } from 'electron';

import { createIdleUpdateQueue } from './idle-update.mjs';
import { idleUpdateText, idleUpdateWindowHtml } from './idle-update-locales.mjs';

export const createDesktopIdleUpdate = ({
  state,
  emitToAllWindows,
  isLocalRuntimeUrl,
  install,
  locale,
}) => {
  let idleUpdateWindow = null;
  let idleUpdateWindowSuppressClose = false;
  let controller = null;

  const windowRuntimeUnverified = (browserWindow) => {
    if (!browserWindow || browserWindow.isDestroyed() || browserWindow.__ocIdleUpdate) return false;
    const config = browserWindow.__ocRuntimeConfig;
    if (config?.relayHostId) return true;
    const api = typeof config?.apiBaseUrl === 'string' ? config.apiBaseUrl : (state.apiBaseUrl || '');
    if (!api) return false;
    return !isLocalRuntimeUrl(api);
  };

  const readIdle = async () => {
    try {
      const status = typeof state.serverHandle?.getUpdateIdleStatus === 'function'
        ? await state.serverHandle.getUpdateIdleStatus()
        : { state: 'unknown', reason: 'unreadable' };
      if (!status || (status.state !== 'idle' && status.state !== 'busy' && status.state !== 'unknown')) {
        return { state: 'unknown', reason: 'unreadable' };
      }
      if (status.state !== 'idle') return status;
      if (BrowserWindow.getAllWindows().some(windowRuntimeUnverified)) {
        return { state: 'unknown', reason: 'other-runtime' };
      }
      return status;
    } catch {
      return { state: 'unknown', reason: 'unreadable' };
    }
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
    if (!idleUpdateWindow || idleUpdateWindow.isDestroyed()) return;
    const seconds = Math.max(0, Math.ceil(Number(snapshot?.remainingMs || 0) / 1000));
    const countKey = seconds === 1 ? 'countdownOne' : 'countdown';
    const body = idleUpdateText(locale(), countKey, { seconds });
    const detail = snapshot?.reason ? idleUpdateText(locale(), snapshot.reason) : '';
    if (reload || idleUpdateWindow.webContents.isLoading()) {
      const html = idleUpdateWindowHtml({ locale: locale(), seconds, reason: snapshot?.reason || null });
      void idleUpdateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return;
    }
    void idleUpdateWindow.webContents.executeJavaScript(
      `(() => { const countdown = document.getElementById('countdown'); const detail = document.getElementById('detail'); if (countdown) countdown.textContent = ${JSON.stringify(body)}; if (detail) detail.textContent = ${JSON.stringify(detail)}; })()`,
    ).catch(() => {
      const html = idleUpdateWindowHtml({ locale: locale(), seconds, reason: snapshot?.reason || null });
      void idleUpdateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    });
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

  controller = createIdleUpdateQueue({
    readIdle,
    onChange: (snapshot) => emitToAllWindows('openchamber:idle-update', {
      phase: snapshot.phase,
      reason: snapshot.reason,
      remainingMs: snapshot.remainingMs,
      version: snapshot.version,
      channel: snapshot.channel,
    }),
    openCountdown,
    updateCountdown: paint,
    closeCountdown,
    install,
  });
  return { ...controller, isClosingCountdown: () => idleUpdateWindowSuppressClose };
};
