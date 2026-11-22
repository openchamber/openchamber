
import { app, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { plainChromeUserAgent } from './browser-panel-security.mjs';
import { enableMainProcessCompileCache } from './compile-cache.mjs';
import { shouldIgnoreLoopbackConnectionLimit } from './startup-url-selection.mjs';
import { configureDevDataDir } from './dev-data-dir.mjs';
import { assignInjectedEnv } from '@openchamber/web/server/lib/injected-env.js';
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

const versionBeforeRename = app.getVersion();
app.setName('OpenChamber');
// external: https://github.com/electron/electron/blob/main/default_app/main.ts Preserve the version before renaming an unpackaged app; Electron default_app uses setVersion for package versions.
if (app.getVersion() !== versionBeforeRename) {
  app.setVersion(versionBeforeRename);
}
if (process.platform === 'linux') {
  app.setDesktopName('openchamber.desktop');
  // external: https://www.electronjs.org/docs/latest/api/command-line-switches#enable-speech-dispatcher-linux Linux speech synthesis requires the opt-in speech-dispatcher backend.
  app.commandLine.appendSwitch('enable-speech-dispatcher');
}
// external: https://www.electronjs.org/docs/latest/api/app#appuseragentfallback Set the worker user agent before any window loads so workers and panel pages present the same browser identity.
app.userAgentFallback = plainChromeUserAgent(app.userAgentFallback);
if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'OpenChamber Dev'));
}
const userDataOverride = String(process.env.OPENCHAMBER_DESKTOP_USER_DATA_DIR || '').trim();
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}
enableMainProcessCompileCache({ packaged: app.isPackaged, userDataDir: app.getPath('userData') });
app.setAppUserModelId(APP_USER_MODEL_ID);
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>;openchamber-preview.localhost');
// external: https://www.electronjs.org/docs/latest/api/command-line-switches#ignore-connections-limitdomains Lift connection limits only for bundled UI; uncapped Vite requests overwhelm transforms, and localhost also matches preview subdomains.
if (shouldIgnoreLoopbackConnectionLimit({
  development: isDev,
  packagedUi: process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1',
})) {
  app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1');
}
// external: https://www.electronjs.org/docs/latest/api/command-line-switches#disable-renderer-backgrounding Keep agent tabs at foreground renderer priority while user tabs retain timer throttling.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (!app.commandLine.hasSwitch('js-flags')) {
  app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=4');
}
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
      codeCache: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

deferAppEventsUntilMainLoads();

app.whenReady().then(async () => {
  recordEarlyStartupMark('electron.app.ready');
  if (!shellEnvironmentProbeBlocksMainThread) void startShellEnvironmentProbe().catch(() => {});
  if (!shouldStartInBackground()) {
    await createEarlyWindow().whenShown;
  }
  if (shellEnvironmentProbeBlocksMainThread) void startShellEnvironmentProbe().catch(() => {});
  const hmrStartFile = process.env.OPENCHAMBER_ELECTRON_HMR_START_FILE;
  if (!app.isPackaged && hmrStartFile) {
    const deadline = Date.now() + 75_000;
    while (!fs.existsSync(hmrStartFile)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the HMR server to start');
      await delay(50);
    }
    const data = JSON.parse(fs.readFileSync(hmrStartFile, 'utf8'));
    if (!data.directory?.trim()) throw new Error('Invalid HMR data directory');
    if (data.injected) assignInjectedEnv(process.env, { OPENCHAMBER_DATA_DIR: data.directory });
    else process.env.OPENCHAMBER_DATA_DIR = data.directory;
    delete process.env.OPENCHAMBER_ELECTRON_HMR_START_FILE;
  }
  if (!app.isPackaged && !process.env.OPENCHAMBER_DATA_DIR?.trim()) {
    const shellEnv = await startShellEnvironmentProbe();
    if (shellEnv?.OPENCHAMBER_DATA_DIR?.trim()) {
      process.env.OPENCHAMBER_DATA_DIR = shellEnv.OPENCHAMBER_DATA_DIR;
    }
    configureDevDataDir(process.env, false);
  }
  return import('./main.mjs');
}).catch((error) => {
  console.error('[electron] startup failed before the main module loaded:', error);
  app.exit(1);
});
