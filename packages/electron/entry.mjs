/**
 * Desktop entry module. Electron holds the `ready` event until this module's
 * whole import graph has evaluated, so it stays small on purpose: the
 * configuration that must precede `ready`, the single-instance lock, and the
 * first window. The rest of the main process (`main.mjs`, the server, the
 * updater, IPC) is imported only after `ready`, so the window is on screen
 * while that loads. Starting the import earlier would delay `ready` itself:
 * module evaluation runs on the thread Chromium needs to finish initialising.
 */

import { app, protocol } from 'electron';
import path from 'node:path';
import { shouldIgnoreLoopbackConnectionLimit } from './startup-url-selection.mjs';
import {
  APP_USER_MODEL_ID,
  UI_PROTOCOL,
  createEarlyWindow,
  deferAppEventsUntilMainLoads,
  isDev,
  recordEarlyStartupMark,
  shellEnvironmentProbeBlocksMainThread,
  shouldStartInBackground,
  startShellEnvironmentProbe,
} from './early-startup.mjs';

recordEarlyStartupMark('electron.entry');

// Set the product name early so electron-log derives its log directory as
// ~/Library/Logs/OpenChamber/ (not ~/Library/Logs/@openchamber/electron/).
app.setName('OpenChamber');
if (process.platform === 'linux') {
  app.setDesktopName('openchamber.desktop');
}
if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'OpenChamber Dev'));
}
// Test hook for scripts/profile-startup.mjs: a packaged launch that must not
// share the single-instance lock or the Chromium profile with the installed
// app. macOS resolves the home directory from the user record, not $HOME, so
// an environment-only isolation cannot move these.
const userDataOverride = String(process.env.OPENCHAMBER_DESKTOP_USER_DATA_DIR || '').trim();
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}
app.setAppUserModelId(APP_USER_MODEL_ID);
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
// Lift Chromium's per-host cap only for bundled UI. Applying this to Vite HMR
// lets the renderer request most of the module graph at once, overwhelming the
// dev server's transform pipeline and leaving the HTML splash visible for up
// to a minute before React mounts.
if (shouldIgnoreLoopbackConnectionLimit({
  development: isDev,
  packagedUi: process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1',
})) {
  app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1,localhost');
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: UI_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // Keep V8 bytecode for the packaged renderer bundle between launches.
      codeCache: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

// Deep links and second launches can arrive before main.mjs has its handlers.
deferAppEventsUntilMainLoads();

app.whenReady().then(async () => {
  recordEarlyStartupMark('electron.app.ready');
  // The login shell runs in its own process; only its spawn touches this thread.
  if (!shellEnvironmentProbeBlocksMainThread) void startShellEnvironmentProbe().catch(() => {});
  // A login-item or --background launch has no window to show. Otherwise the
  // splash gets the main thread to itself until it is on screen: loading the
  // main module and the server behind it would starve its first paint.
  if (!shouldStartInBackground()) {
    await createEarlyWindow().whenShown;
  }
  if (shellEnvironmentProbeBlocksMainThread) void startShellEnvironmentProbe().catch(() => {});
  return import('./main.mjs');
}).catch((error) => {
  console.error('[electron] startup failed before the main module loaded:', error);
  app.exit(1);
});
