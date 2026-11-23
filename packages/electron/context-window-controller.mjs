import { clampWindowBoundsToVisibleWorkArea, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, readSettingsRoot } from './early-startup.mjs';
import { getWindowStateSnapshot } from './window-state.mjs';
import { createWindowGeometryState } from './window-geometry-state.mjs';
import { showWindow } from './window-hide.mjs';
import { buildContextWindowUrl, isContextWindowOwnerId, readContextWindowState } from './context-window.mjs';

const COMMANDS = new Set(['desktop_open_context_window', 'desktop_reveal_context_window', 'desktop_take_context_window_restore']);

export const createContextWindowController = ({
  BrowserWindow,
  createBrowserWindow,
  nextWindowLabel,
  resolveRuntimeConfig,
  mutateSettingsRoot,
  emitToWindow,
  isQuitting,
  isMainWindow,
  isBrowserPanelPopup,
  log,
}) => {
  const panels = new Map();
  let restoreTaken = false;

  const saveState = (patch) => {
    void mutateSettingsRoot((root) => {
      root.desktopContextWindow = { ...readContextWindowState(root.desktopContextWindow), ...patch };
    }).catch((error) => log.warn('[context-window] could not save the panel window state', error));
  };

  const geometry = createWindowGeometryState({
    persist: async (panel) => {
      const bounds = getWindowStateSnapshot(panel, { minWidth: MIN_WINDOW_WIDTH, minHeight: MIN_WINDOW_HEIGHT });
      if (bounds) saveState({ bounds });
    },
  });

  const openOwners = () => [...panels.entries()].filter(([, panel]) => !panel.isDestroyed()).map(([ownerId]) => ownerId);

  const isAppWindow = (browserWindow) => !browserWindow.isDestroyed()
    && !browserWindow.__ocContextWindowOwnerId
    && !browserWindow.__ocMiniChat
    && !isBrowserPanelPopup(browserWindow);

  const followOwner = (owner, ownerId, panel) => {
    const hide = () => {
      if (!panel.isDestroyed()) panel.hide();
    };
    const show = () => {
      if (!panel.isDestroyed() && !panel.isVisible()) panel.showInactive();
    };
    const closeWithOwner = () => {
      if (panel.isDestroyed()) return;
      panel.__ocContextWindowKeepOnRestart = process.platform !== 'darwin'
        && !BrowserWindow.getAllWindows().some((window) => window !== owner && isAppWindow(window));
      panel.close();
    };
    owner.on('hide', hide);
    owner.on('show', show);
    owner.once('closed', closeWithOwner);
    panel.once('closed', () => {
      geometry.cancel(panel);
      if (panels.get(ownerId) === panel) panels.delete(ownerId);
      if (!owner.isDestroyed()) {
        owner.removeListener('hide', hide);
        owner.removeListener('show', show);
        owner.removeListener('closed', closeWithOwner);
      }
      if (isQuitting() || panel.__ocContextWindowKeepOnRestart) return;
      saveState({ owners: openOwners() });
      if (!owner.isDestroyed()) emitToWindow(owner, 'openchamber:context-window-closed', { ownerId });
    });
  };

  const open = (owner, ownerId, args) => {
    const existing = panels.get(ownerId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      showWindow(existing);
      existing.focus();
      return;
    }
    const saved = readContextWindowState(readSettingsRoot().desktopContextWindow);
    const panel = createBrowserWindow({
      label: nextWindowLabel(),
      restoreGeometry: false,
      url: buildContextWindowUrl(owner.webContents.getURL(), ownerId),
      runtimeConfig: { ...resolveRuntimeConfig(owner, args), explicitRuntime: true },
    });
    panel.__ocContextWindowOwnerId = ownerId;
    if (saved.bounds) {
      panel.setBounds(clampWindowBoundsToVisibleWorkArea(saved.bounds));
      if (saved.bounds.maximized) panel.maximize();
    }
    for (const event of ['resize', 'move']) panel.on(event, () => geometry.schedule(panel));
    panel.on('close', () => geometry.schedule(panel, true));
    panels.set(ownerId, panel);
    followOwner(owner, ownerId, panel);
    saveState({ owners: openOwners() });
  };

  const reveal = (ownerId) => {
    const panel = panels.get(ownerId);
    if (!panel || panel.isDestroyed()) return;
    if (panel.isMinimized()) panel.restore();
    else if (!panel.isVisible()) panel.showInactive();
    panel.moveTop();
  };

  const invoke = (browserWindow, command, args) => {
    const ownerId = isContextWindowOwnerId(args?.ownerId) ? args.ownerId : '';
    if (command === 'desktop_take_context_window_restore') {
      if (restoreTaken || !browserWindow || !isMainWindow(browserWindow)) return [];
      restoreTaken = true;
      return readContextWindowState(readSettingsRoot().desktopContextWindow).owners;
    }
    if (!isContextWindowOwnerId(ownerId)) throw new Error('A main window id is required');
    if (command === 'desktop_reveal_context_window') reveal(ownerId);
    else if (browserWindow && !browserWindow.isDestroyed()) open(browserWindow, ownerId, args);
    return null;
  };

  return { handles: (command) => COMMANDS.has(command), invoke };
};
