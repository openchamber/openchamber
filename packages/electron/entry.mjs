/**
 * Desktop entry module. Electron holds the `ready` event until this module's
 * whole import graph has evaluated, so it stays small on purpose: the
 * configuration that must precede `ready`, the single-instance lock, and the
 * first window. The rest of the main process (`main.mjs`, the server, the
 * updater, IPC) is imported only after `ready`, so the window is on screen
 * while that loads. Starting the import earlier would delay `ready` itself:
 * module evaluation runs on the thread Chromium needs to finish initialising.
 */

// Keep first: it sets OPENCHAMBER_DATA_DIR before anything reads the data
// directory (early-startup only resolves it lazily, main.mjs loads after ready).
import './turbo2-data-dir-apply.mjs';
import { app, protocol } from 'electron';
import path from 'node:path';
import { enableMainProcessCompileCache } from './compile-cache.mjs';
import fs from 'node:fs';
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
// ~/Library/Logs/OpenChamber Turbo 2/ (not ~/Library/Logs/@openchamber/electron/).
const versionBeforeRename = app.getVersion();
app.setName('OpenChamber Turbo 2');
// An unpackaged run on Linux reports version "0.0" after the rename, and
// electron-updater refuses a version that is not semver, so the dev app quit
// before its first window. Restoring the version from before the rename gives
// it Electron's own version, as on macOS. `setVersion` is undocumented;
// Electron's default app uses it to apply a package.json version.
if (app.getVersion() !== versionBeforeRename) {
  app.setVersion(versionBeforeRename);
}
process.env.OPENCHAMBER_UPDATE_REPO = 'rubimpassos/openchamber';
if (process.platform === 'linux') {
  app.setDesktopName('openchamber-turbo2.desktop');
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
// Seed the fork profile before Chromium or electron-log opens it. Never copy
// into an explicitly isolated profile (including startup profiling runs).
if (!isDev && !userDataOverride) {
  const target = app.getPath('userData');
  const source = path.join(path.dirname(target), 'OpenChamber Turbo');
  const volatileEntries = new Set([
    'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache',
    'DawnWebGPUCache', 'Crashpad', 'logs', 'Partitions', 'Service Worker',
    'blob_storage', 'Network',
  ]);
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    try {
      fs.cpSync(source, target, {
        recursive: true,
        filter: (entry) => !(path.dirname(entry) === source && volatileEntries.has(path.basename(entry))),
      });
    } catch (error) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('[electron] could not remove partial imported profile', cleanupError);
      }
      console.warn('[electron] could not import official OpenChamber user data; starting on a clean profile', error);
    }
  }
}
// After the userData path is final, before main.mjs and the server load.
enableMainProcessCompileCache({ packaged: app.isPackaged, userDataDir: app.getPath('userData') });
app.setAppUserModelId(APP_USER_MODEL_ID);
// Resolve preview names in Chromium, not through the configured proxy.
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>;openchamber-preview.localhost');
// Lift Chromium's per-host cap only for bundled UI. Applying this to Vite HMR
// lets the renderer request most of the module graph at once, overwhelming the
// dev server's transform pipeline and leaving the HTML splash visible for up
// to a minute before React mounts.
// Keep localhost out: Electron also matches its subdomains, including the
// browser panel's forwarded previews.
if (shouldIgnoreLoopbackConnectionLimit({
  development: isDev,
  packagedUi: process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1',
})) {
  app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1');
}
// A browser panel tab the agent works runs unthrottled (BrowserPane), but a
// hidden page's renderer is still lowered in priority on its own; without this
// that tab ran its timers at an eighth of the speed while out of sight. The
// user's hidden tabs keep their timer throttling, so they stay cheap.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Development only: lets a debugger or an agent attach to the dev window over
// CDP. Chromium binds the port to loopback.
const devRemoteDebuggingPort = String(process.env.OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT || '').trim();
if (isDev && /^\d+$/.test(devRemoteDebuggingPort)) {
  app.commandLine.appendSwitch('remote-debugging-port', devRemoteDebuggingPort);
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
