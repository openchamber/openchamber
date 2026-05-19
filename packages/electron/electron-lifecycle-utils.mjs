import path from 'node:path';

export const shouldRequireQuitConfirmationForPlatform = (platform = process.platform) =>
  platform === 'darwin' || platform === 'linux';

export const shouldInstallExplicitApplicationMenu = (platform = process.platform) =>
  platform === 'darwin' || platform === 'linux';

export const shouldRouteLastWindowCloseThroughQuitConfirmation = (platform = process.platform) =>
  platform === 'linux';

export const nativeNotificationUnsupportedReason = (platform = process.platform) => {
  if (platform === 'linux') {
    return 'Linux notifications require a running desktop notification service compatible with the Desktop Notifications/libnotify specification.';
  }
  return 'Electron Notification.isSupported() returned false for this desktop session.';
};

export const resolveElectronRuntimePaths = ({
  isDev,
  mainDir,
  appPath,
  resourcesPath,
}) => {
  if (!isDev && (typeof resourcesPath !== 'string' || resourcesPath.trim().length === 0)) {
    throw new Error('Electron packaged resources path is not available');
  }
  if (!isDev && (typeof appPath !== 'string' || appPath.trim().length === 0)) {
    throw new Error('Electron packaged app path is not available');
  }

  const resourceRoot = isDev ? path.join(mainDir, 'resources') : resourcesPath;
  return {
    resourceRoot,
    webDistDir: path.join(resourceRoot, 'web-dist'),
    preloadPath: isDev ? path.join(mainDir, 'preload.mjs') : path.join(appPath, 'preload.mjs'),
  };
};

export const stopInProcessWebServer = ({ state, logger } = {}) => {
  const handle = state?.serverHandle;
  if (!state) return false;
  state.serverHandle = null;
  state.sidecarUrl = null;
  if (!handle || typeof handle.stop !== 'function') return false;

  try {
    const result = handle.stop({ exitProcess: false });
    if (result && typeof result.then === 'function') {
      result.catch((error) => logger?.warn?.('[electron] failed to stop in-process web server:', error));
    }
  } catch (error) {
    logger?.warn?.('[electron] failed to stop in-process web server:', error);
  }
  return true;
};

export const menuAccelerator = (platform, key) => `${platform === 'darwin' ? 'Cmd' : 'Ctrl'}+${key}`;

export const buildLinuxMenuTemplate = ({
  appName,
  dispatchAction,
  dispatchCheckForUpdates,
  reloadMenuTargetWindow,
  relaunchFromMenu,
  requestQuitWithConfirmation,
  newWindow,
  clearCache,
  openExternal,
  urls,
}) => [
  {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: menuAccelerator('linux', 'Shift+Alt+N'), click: () => void newWindow() },
      { type: 'separator' },
      { label: 'New Session', accelerator: menuAccelerator('linux', 'N'), click: () => dispatchAction('new-session') },
      { label: 'New Worktree', accelerator: menuAccelerator('linux', 'Shift+N'), click: () => dispatchAction('new-worktree-session') },
      { type: 'separator' },
      { label: 'Add Workspace', click: () => dispatchAction('change-workspace') },
      { type: 'separator' },
      { role: 'close' },
      { label: `Quit ${appName}`, accelerator: menuAccelerator('linux', 'Q'), click: () => void requestQuitWithConfirmation() },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { label: 'Git', accelerator: menuAccelerator('linux', 'G'), click: () => dispatchAction('open-git-tab') },
      { label: 'Diff', accelerator: menuAccelerator('linux', 'E'), click: () => dispatchAction('open-diff-tab') },
      { label: 'Files', click: () => dispatchAction('open-files-tab') },
      { label: 'Terminal', accelerator: menuAccelerator('linux', 'T'), click: () => dispatchAction('open-terminal-tab') },
      { type: 'separator' },
      { label: 'Light Theme', click: () => dispatchAction('theme-light') },
      { label: 'Dark Theme', click: () => dispatchAction('theme-dark') },
      { label: 'System Theme', click: () => dispatchAction('theme-system') },
      { type: 'separator' },
      { label: 'Toggle Session Sidebar', accelerator: menuAccelerator('linux', 'L'), click: () => dispatchAction('toggle-sidebar') },
      { label: 'Toggle Memory Debug', accelerator: menuAccelerator('linux', 'Shift+D'), click: () => dispatchAction('toggle-memory-debug') },
      { type: 'separator' },
      { label: 'Reload Webview', accelerator: menuAccelerator('linux', 'R'), click: () => reloadMenuTargetWindow() },
      { role: 'togglefullscreen' },
    ],
  },
  {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'close' },
    ],
  },
  {
    label: 'Help',
    submenu: [
      { label: 'Keyboard Shortcuts', accelerator: menuAccelerator('linux', '.'), click: () => dispatchAction('help-dialog') },
      { label: 'Show Diagnostics', accelerator: menuAccelerator('linux', 'Shift+L'), click: () => dispatchAction('download-logs') },
      { type: 'separator' },
      { label: 'Settings', accelerator: menuAccelerator('linux', ','), click: () => dispatchAction('settings') },
      { label: 'Check for Updates', click: () => dispatchCheckForUpdates() },
      { label: 'Restart', click: () => relaunchFromMenu() },
      { label: 'Clear Cache', click: () => void clearCache() },
      { type: 'separator' },
      { label: 'Report a Bug', click: () => openExternal(urls.bugReport) },
      { label: 'Request a Feature', click: () => openExternal(urls.featureRequest) },
      { type: 'separator' },
      { label: 'Join Discord', click: () => openExternal(urls.discord) },
    ],
  },
];
