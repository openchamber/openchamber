import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net as electronNet, Notification, powerMonitor, powerSaveBlocker, protocol, screen, session, shell, webContents } from 'electron';
import contextMenu from 'electron-context-menu';
import log from 'electron-log/main.js';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import updaterPkg from 'electron-updater';
import { ElectronSshManager } from './ssh-manager.mjs';
import { createTrayController } from './tray.mjs';
import { resolveManagedOpenCodeCwd } from './opencode-cwd.mjs';
import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';
import { assertUpdaterCapability } from './updater-capability.mjs';
import { checkForDesktopUpdate } from './updater-check.mjs';
import { resolveUpdaterFeed } from './updater-feed.mjs';
import { buildStoredHostEntry as sanitizeStoredHostEntry } from './host-storage-sanitizer.mjs';
import { writeSecureAtomicJson } from './secure-json-file.mjs';
import { buildDesktopAdditionalArguments, resolveRuntimeBootstrap } from './runtime-bootstrap.mjs';
import { resolveDesktopHostsForSender } from './host-public-config.mjs';
import { decidePairingV2DeepLink } from './pairing-deep-link.mjs';
import { mintOutsideFileGrant } from '@openchamber/web/server/lib/fs/routes.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.OPENCHAMBER_ELECTRON_DEV === '1' || !app.isPackaged;

const DEEP_LINK_PROTOCOL = 'openchamber';
const UI_PROTOCOL = 'openchamber-ui';
const PACKAGED_APP_USER_MODEL_ID = 'dev.openchamber.desktop';
const DEV_APP_USER_MODEL_ID = 'dev.openchamber.desktop.dev';
const APP_USER_MODEL_ID = app.isPackaged ? PACKAGED_APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
const BACKGROUND_START_ARG = '--background';

const getLoginItemOptions = () => {
  if (process.platform === 'win32') {
    return {
      path: process.execPath,
      args: [BACKGROUND_START_ARG],
      name: APP_USER_MODEL_ID,
    };
  }
  return {};
};

const readLoginItemSettings = () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    return app.getLoginItemSettings(getLoginItemOptions());
  } catch {
    return null;
  }
};

const shouldStartInBackground = (loginItemSettings = readLoginItemSettings()) => {
  return (
    process.argv.includes(BACKGROUND_START_ARG) ||
    loginItemSettings?.wasOpenedAtLogin === true ||
    loginItemSettings?.wasOpenedAsHidden === true
  );
};

// Set the product name early so electron-log derives its log directory as
// ~/Library/Logs/OpenChamber/ (not ~/Library/Logs/@openchamber/electron/).
app.setName('OpenChamber');
if (process.platform === 'linux') {
  app.setDesktopName('openchamber.desktop');
}
if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'OpenChamber Dev'));
}
app.setAppUserModelId(APP_USER_MODEL_ID);
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');

protocol.registerSchemesAsPrivileged([
  {
    scheme: UI_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

try {
  process.chdir(os.homedir());
} catch {
}

log.initialize();
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';

// The in-process web server runs in this same Node process and uses plain
// `console.log/warn/error`. Without piping console through electron-log,
// that output never lands in ~/Library/Logs/OpenChamber/main.log and we
// can't diagnose issues (e.g. OpenCode lifecycle, SSE disconnects) after
// the fact. Route all console calls through electron-log so server-side
// diagnostics are persisted.
Object.assign(console, log.functions);

const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
try {
  const logPath = log.transports.file.getFile().path;
  const logDir = path.dirname(logPath);
  const cutoff = Date.now() - LOG_MAX_AGE_MS;
  for (const entry of fs.readdirSync(logDir)) {
    const candidate = path.join(logDir, entry);
    try {
      const info = fs.statSync(candidate);
      if (info.isFile() && info.mtimeMs < cutoff) {
        fs.unlinkSync(candidate);
      }
    } catch {
    }
  }
} catch {
}

try {
  if (!app.isDefaultProtocolClient(DEEP_LINK_PROTOCOL)) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
  }
} catch (error) {
  // log.* not yet initialized at this point; fall back to console.
  console.warn('[electron] failed to register deep-link protocol:', error);
}

const readAppMetadata = () => {
  const candidates = [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json'),
    path.join(app.getAppPath?.() || '', 'package.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.name === '@openchamber/electron' && typeof parsed.version === 'string') {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
    }
  }
  return { name: '@openchamber/electron', version: app.getVersion() };
};

const APP_METADATA = readAppMetadata();
const APP_VERSION = APP_METADATA.version;

const DEFAULT_DESKTOP_PORT = 57123;
const LOOPBACK_BIND_HOST = '127.0.0.1';
const LAN_BIND_HOST = '0.0.0.0';
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 520;
const MIN_RESTORE_WINDOW_WIDTH = 900;
const MIN_RESTORE_WINDOW_HEIGHT = 560;
const MINI_CHAT_WINDOW_WIDTH = 520;
const MINI_CHAT_WINDOW_HEIGHT = 760;
const MINI_CHAT_MIN_WINDOW_WIDTH = 360;
const MINI_CHAT_MIN_WINDOW_HEIGHT = 480;
const MAX_CAPTURE_PAGE_RECT_AREA = 4_000_000;
const LOCAL_HOST_ID = 'local';
const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';
// Remote hosts get a regular 'desktop' client (NOT 'desktop-local' — that kind
// grants whole-server device management and must never be issued to a desktop
// connecting to someone else's server).
const REMOTE_DESKTOP_CLIENT_KIND = 'desktop';
const ENV_OVERRIDE_HOST_ID = '__env';
const CHANGELOG_URL = 'https://raw.githubusercontent.com/openchamber/openchamber/main/CHANGELOG.md';
const GITHUB_BUG_REPORT_URL = 'https://github.com/openchamber/openchamber/issues/new?template=bug_report.yml';
const GITHUB_FEATURE_REQUEST_URL = 'https://github.com/openchamber/openchamber/issues/new?template=feature_request.yml';
const DISCORD_INVITE_URL = 'https://discord.gg/ZYRSdnwwKA';
const INSTALLED_APPS_CACHE_TTL_SECS = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE = 'discovered-apps.json';
const OPENCODE_SHUTDOWN_GRACE_MS = 100;

const { autoUpdater } = updaterPkg;

const state = {
  serverHandle: null,
  sidecarUrl: null,
  localOrigin: null,
  apiBaseUrl: null,
  clientToken: null,
  requestHeaders: {},
  bootOutcome: null,
  initScript: null,
  mainWindow: null,
  quitRequested: false,
  quitConfirmed: false,
  quitInProgress: false,
  quitConfirmationPending: false,
  backgroundShutdownComplete: false,
  sshShutdownPromise: null,
  installingUpdate: false,
  pendingUpdate: null,
  unreachableHosts: new Set(),
  windowCounter: 1,
  focusedWindowIds: new Set(),
  windowGeometryRevisions: new Map(),
  windowGeometryTimers: new Map(),
  miniChatWindowsBySession: new Map(),
  sshStatuses: new Map(),
  sshLogs: new Map(),
  trayController: null,
  lastFocusedWindowId: null,
  keepAwakeBlockerId: null,
};

const setDesktopKeepAwakeActive = (enabled) => {
  const currentId = state.keepAwakeBlockerId;
  const isActive = Number.isInteger(currentId) && powerSaveBlocker.isStarted(currentId);

  if (enabled) {
    if (!isActive) {
      state.keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return Number.isInteger(state.keepAwakeBlockerId) && powerSaveBlocker.isStarted(state.keepAwakeBlockerId);
  }

  if (isActive) {
    powerSaveBlocker.stop(currentId);
  }
  state.keepAwakeBlockerId = null;
  return false;
};

const readDesktopKeepAwakeStatus = () => {
  const enabled = readSettingsRoot().desktopKeepAwakeEnabled === true;
  const currentId = state.keepAwakeBlockerId;
  const active = Number.isInteger(currentId) && powerSaveBlocker.isStarted(currentId);
  return { supported: true, enabled, active };
};

const readDesktopMinimizeToTrayStatus = () => {
  const supported = process.platform === 'win32';
  return {
    supported,
    enabled: supported && readSettingsRoot().desktopMinimizeToTrayEnabled === true,
  };
};

const shouldHideMainWindowToTray = (browserWindow) => {
  if (process.platform !== 'win32') return false;
  if (!state.trayController) return false;
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  if (browserWindow.__ocMiniChat === true) return false;
  return readSettingsRoot().desktopMinimizeToTrayEnabled === true;
};

const quitRisk = {
  hasActiveTunnel: false,
  hasRunningScheduledTasks: false,
  hasEnabledScheduledTasks: false,
  runningScheduledTasksCount: 0,
  enabledScheduledTasksCount: 0,
};

const shouldRequireQuitConfirmation = () =>
  quitRisk.hasActiveTunnel
  || quitRisk.hasRunningScheduledTasks
  || quitRisk.hasEnabledScheduledTasks;

const quitConfirmationMessage = () => {
  const reasons = [];
  if (quitRisk.hasActiveTunnel) {
    reasons.push('an active tunnel');
  }
  if (quitRisk.runningScheduledTasksCount > 0) {
    reasons.push(`${quitRisk.runningScheduledTasksCount} running scheduled task${quitRisk.runningScheduledTasksCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.enabledScheduledTasksCount > 0) {
    reasons.push(`${quitRisk.enabledScheduledTasksCount} enabled scheduled task${quitRisk.enabledScheduledTasksCount === 1 ? '' : 's'}`);
  }
  if (reasons.length === 0) {
    return 'Background processes (sidecar, SSH sessions) will be stopped.';
  }
  return `OpenChamber detected ${reasons.join(', ')}. Quitting now will stop sidecar/background processes and may interrupt pending work.`;
};

const shutdownBackgroundServices = () => {
  if (state.backgroundShutdownComplete) return;
  state.backgroundShutdownComplete = true;
  setDesktopKeepAwakeActive(false);
  if (state.installingUpdate) return;
  killSidecar();
  setImmediate(() => {
    void shutdownSshSessions();
  });
};

const shutdownSshSessions = async () => {
  if (state.sshShutdownPromise) {
    await state.sshShutdownPromise;
    return;
  }

  state.sshShutdownPromise = sshManager.shutdownAll().catch((error) => {
    log.warn('[electron] failed to stop SSH sessions:', error);
  }).finally(() => {
    state.sshShutdownPromise = null;
  });

  await state.sshShutdownPromise;
};

const prepareForQuit = ({ installingUpdate = false } = {}) => {
  state.quitRequested = true;
  state.quitConfirmed = true;
  state.installingUpdate = installingUpdate;
  state.quitConfirmationPending = false;

  if (state.trayController) {
    try {
      state.trayController.destroy();
    } catch {
    }
    state.trayController = null;
  }

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      debounceWindowStatePersist(state.mainWindow, true);
    } catch {
    }
  }

  setDesktopKeepAwakeActive(false);

  if (installingUpdate) {
    state.backgroundShutdownComplete = true;
    return;
  }

  shutdownBackgroundServices();
};

const performConfirmedQuit = () => {
  if (state.quitInProgress) return;
  state.quitInProgress = true;

  prepareForQuit();
  app.exit(0);
};

// Hard-stop signals (`Ctrl+C` on `electron:dev`, an external `kill`/SIGTERM,
// terminal close) bypass the normal app-quit flow — which would orphan the
// in-process web server's managed OpenCode child. Run the same background
// teardown the quit path uses (which kills the sidecar), then exit. The startup
// reaper remains the backstop for an unhandled hard crash (SIGKILL).
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      shutdownBackgroundServices();
    } catch (error) {
      log.warn(`[electron] ${signal} shutdown failed:`, error);
    }
    app.exit(0);
  });
}

const requestQuitWithConfirmation = async () => {
  await refreshQuitRiskFlags();

  if (!shouldRequireQuitConfirmation()) {
    performConfirmedQuit();
    return;
  }

  if (state.quitConfirmationPending) {
    return;
  }
  state.quitConfirmationPending = true;

  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  const visible = windows.find((window) => window.isVisible());
  if (!visible) {
    const hidden = windows.find((window) => !window.isVisible());
    if (hidden) {
      hidden.show();
      hidden.focus();
    }
  }

  try {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Quit OpenChamber?',
      message: 'Quit OpenChamber?',
      detail: quitConfirmationMessage(),
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    state.quitConfirmationPending = false;
    if (result.response === 0) {
      performConfirmedQuit();
    }
  } catch (error) {
    state.quitConfirmationPending = false;
    log.warn('[electron] quit confirmation dialog failed:', error);
  }
};

const refreshQuitRiskFlags = async () => {
  if (state.serverHandle && typeof state.serverHandle.getQuitRiskStatus === 'function') {
    try {
      const status = await state.serverHandle.getQuitRiskStatus();
      const scheduled = status?.scheduledTasks;
      if (scheduled && typeof scheduled === 'object') {
        const enabledCount = Number(scheduled.enabledScheduledTasksCount ?? 0);
        const runningCount = Number(scheduled.runningScheduledTasksCount ?? 0);
        quitRisk.enabledScheduledTasksCount = Number.isFinite(enabledCount) ? enabledCount : 0;
        quitRisk.runningScheduledTasksCount = Number.isFinite(runningCount) ? runningCount : 0;
        quitRisk.hasEnabledScheduledTasks = Boolean(scheduled.hasEnabledScheduledTasks) || quitRisk.enabledScheduledTasksCount > 0;
        quitRisk.hasRunningScheduledTasks = Boolean(scheduled.hasRunningScheduledTasks) || quitRisk.runningScheduledTasksCount > 0;
      }
      quitRisk.hasActiveTunnel = Boolean(status?.tunnel?.active);
      return;
    } catch {
    }
  }

  const base = typeof state.sidecarUrl === 'string' ? state.sidecarUrl.trim().replace(/\/$/, '') : '';
  if (!base) return;

  const scheduledUrl = `${base}/api/openchamber/scheduled-tasks/status`;
  const tunnelUrl = `${base}/api/openchamber/tunnel/status`;

  const fetchJson = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  };

  const [scheduled, tunnel] = await Promise.all([fetchJson(scheduledUrl), fetchJson(tunnelUrl)]);

  if (scheduled && typeof scheduled === 'object') {
    const enabledCount = Number(scheduled.enabledScheduledTasksCount ?? 0);
    const runningCount = Number(scheduled.runningScheduledTasksCount ?? 0);
    quitRisk.enabledScheduledTasksCount = Number.isFinite(enabledCount) ? enabledCount : 0;
    quitRisk.runningScheduledTasksCount = Number.isFinite(runningCount) ? runningCount : 0;
    quitRisk.hasEnabledScheduledTasks = Boolean(scheduled.hasEnabledScheduledTasks) || quitRisk.enabledScheduledTasksCount > 0;
    quitRisk.hasRunningScheduledTasks = Boolean(scheduled.hasRunningScheduledTasks) || quitRisk.runningScheduledTasksCount > 0;
  }

  if (tunnel && typeof tunnel === 'object') {
    quitRisk.hasActiveTunnel = Boolean(tunnel.active);
  }
};

const settingsFilePath = () => {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()) {
    return path.join(process.env.OPENCHAMBER_DATA_DIR.trim(), 'settings.json');
  }
  return path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
};

const sshManager = new ElectronSshManager({
  settingsFilePath: settingsFilePath(),
  appVersion: APP_VERSION,
  emit: (event, detail) => emitToAllWindows(event, detail),
});

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    // Parse errors can happen if a concurrent writer just truncated the file
    // and hasn't finished writing yet. Log loudly so we notice, then return
    // {} as before. Writes are atomic (tmp + rename) so this race is rare.
    log.warn?.('[electron] failed to read JSON file', filePath, error);
    return {};
  }
};

const writeJsonFile = async (filePath, data) => {
  const isDefaultSettingsFile = !process.env.OPENCHAMBER_DATA_DIR && filePath === settingsFilePath();
  await writeSecureAtomicJson(filePath, data, { privateDirectory: isDefaultSettingsFile });
};

const readSettingsRoot = () => {
  const root = readJsonFile(settingsFilePath());
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
};

// Serializes read-modify-write of the settings file within this process.
// Multiple call sites (spawnLocalServer, writeDesktopHostsConfig, theme
// preference saves, ssh manager imports, etc.) would otherwise have their
// RMW pairs interleave across awaits, letting one writer's stale copy
// overwrite another writer's just-persisted changes.
let settingsMutationChain = Promise.resolve();
const mutateSettingsRoot = (mutator) => {
  const next = settingsMutationChain.then(async () => {
    const current = readSettingsRoot();
    const result = await mutator(current);
    const nextRoot = result ?? current;
    await writeJsonFile(settingsFilePath(), nextRoot);
  });
  // Keep the chain alive even if one mutator throws.
  settingsMutationChain = next.catch(() => {});
  return next;
};

const writeSettingsRoot = async (root) => writeJsonFile(settingsFilePath(), root);

// Stable per-install identifier for this desktop, persisted in settings. Used as
// the client dedupe key on remote hosts so re-authenticating (e.g. after a login
// session expires) reuses the same "OpenChamber Desktop" record instead of
// piling up a new one each time. Different desktops get different ids.
// Display-only device metadata shown in a server's device list ("macOS",
// app version). Never used for auth decisions.
const desktopDeviceMetadata = () => {
  const platformMap = { darwin: 'macos', win32: 'windows', linux: 'linux' };
  const devicePlatform = platformMap[process.platform];
  let appVersion;
  try {
    appVersion = app.getVersion();
  } catch {
    appVersion = undefined;
  }
  return {
    ...(devicePlatform ? { devicePlatform } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
};

const getOrCreateDesktopInstallId = async () => {
  const existing = readSettingsRoot().desktopInstallId;
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  const generated = globalThis.crypto.randomUUID();
  await mutateSettingsRoot((root) => {
    // Race guard: keep an id another writer may have already persisted.
    if (typeof root.desktopInstallId === 'string' && root.desktopInstallId.trim()) return root;
    root.desktopInstallId = generated;
    return root;
  });
  const after = readSettingsRoot().desktopInstallId;
  return typeof after === 'string' && after.trim() ? after.trim() : generated;
};

const normalizeHostUrl = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const sanitizeHostUrlForStorage = (raw) => normalizeHostUrl(raw);
const sanitizeClientTokenForStorage = (raw) => {
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length > 0 ? token : null;
};

const sameOrigin = (left, right) => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

const shouldUseSameOriginDevProxy = (uiUrl, apiBaseUrl) => (
  isDev
  && uiUrl
  && apiBaseUrl
  && !shouldUsePackagedUi()
  && !sameOrigin(uiUrl, apiBaseUrl)
  && isLocalRuntimeUrl(apiBaseUrl)
);

const buildRendererRuntimeConfig = (uiUrl, runtimeConfig = {}) => {
  const apiBaseUrl = typeof runtimeConfig.apiBaseUrl === 'string' ? runtimeConfig.apiBaseUrl : (state.apiBaseUrl || '');
  const clientToken = typeof runtimeConfig.clientToken === 'string' ? runtimeConfig.clientToken : (state.clientToken || '');
  const requestHeaders = sanitizeRuntimeRequestHeaders(runtimeConfig.requestHeaders || state.requestHeaders || {});
  // Relay-capable hosts have no injectable HTTP base: the renderer reads this
  // host id, probes the direct leg, and falls back to the E2EE tunnel itself.
  const relayHostId = typeof runtimeConfig.relayHostId === 'string' ? runtimeConfig.relayHostId : '';
  if (shouldUseSameOriginDevProxy(uiUrl, apiBaseUrl)) {
    return { apiBaseUrl: '', clientToken: '', requestHeaders: {}, relayHostId };
  }
  return { apiBaseUrl, clientToken, requestHeaders, relayHostId };
};

const readDesktopLocalClientToken = () => {
  return sanitizeClientTokenForStorage(readSettingsRoot().desktopLocalClientToken) || '';
};

const isMachineLocalHostname = (hostname) => {
  const clean = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0' || clean === '::') {
    return true;
  }
  try {
    return Object.values(os.networkInterfaces()).some((entries) =>
      (entries || []).some((entry) => entry?.address === clean));
  } catch {
    return false;
  }
};

const isLocalRuntimeUrl = (targetUrl) => {
  const localUrl = state.sidecarUrl || state.localOrigin || '';
  if (!localUrl) return false;
  if (sameOrigin(targetUrl, localUrl)) return true;
  // The embedded server bound to 0.0.0.0 for LAN access is still THIS
  // machine's server when addressed via any of its own interfaces on the same
  // port — the minted client token must carry the desktop-local kind, or the
  // server's client-create gate rejects it (the "Local — Auth required" +
  // unreachable-screen regression).
  try {
    const target = new URL(targetUrl);
    const local = new URL(localUrl);
    const portOf = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');
    return portOf(target) === portOf(local) && isMachineLocalHostname(target.hostname);
  } catch {
    return false;
  }
};

// Shared storage shape for a persisted host. A host may carry a direct HTTP
// transport, a relay transport, or BOTH (a multi-transport device: direct on
// the home network, relay away — mirrors the mobile connection model). Returns
// null for entries that can't be stored (missing id, reserved 'local', or no
// usable transport at all).
const buildStoredHostEntry = (entry) => {
  return sanitizeStoredHostEntry(entry, {
    localHostId: LOCAL_HOST_ID,
    sanitizeHostUrl: sanitizeHostUrlForStorage,
    sanitizeClientToken: sanitizeClientTokenForStorage,
    sanitizeRequestHeaders: sanitizeRuntimeRequestHeaders,
  });
};

const readDesktopHostsConfig = () => {
  const root = readSettingsRoot();
  const hostsRaw = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
  const hosts = hostsRaw
    .map(buildStoredHostEntry)
    .filter(Boolean);

  return {
    hosts,
    defaultHostId: typeof root.desktopDefaultHostId === 'string' && root.desktopDefaultHostId.trim()
      ? root.desktopDefaultHostId.trim()
      : null,
    initialHostChoiceCompleted: root.desktopInitialHostChoiceCompleted === true,
  };
};

const writeDesktopHostsConfig = async (config) => {
  await mutateSettingsRoot((root) => {
    root.desktopHosts = Array.isArray(config?.hosts)
      ? config.hosts
          .map(buildStoredHostEntry)
          .filter(Boolean)
      : [];
    root.desktopDefaultHostId = typeof config?.defaultHostId === 'string' && config.defaultHostId.trim()
      ? config.defaultHostId.trim()
      : null;
    if (typeof config?.initialHostChoiceCompleted === 'boolean') {
      root.desktopInitialHostChoiceCompleted = config.initialHostChoiceCompleted;
    }
    if (Object.prototype.hasOwnProperty.call(config || {}, 'localClientToken')) {
      const localClientToken = sanitizeClientTokenForStorage(config.localClientToken);
      if (localClientToken) {
        root.desktopLocalClientToken = localClientToken;
      } else {
        delete root.desktopLocalClientToken;
      }
    }
  });
};

const readWindowState = () => {
  const stateValue = readSettingsRoot().desktopWindowState;
  return stateValue && typeof stateValue === 'object' ? stateValue : null;
};

const clampWindowBoundsToVisibleWorkArea = (bounds) => {
  const width = Math.max(MIN_RESTORE_WINDOW_WIDTH, Math.round(Number(bounds?.width) || 0));
  const height = Math.max(MIN_RESTORE_WINDOW_HEIGHT, Math.round(Number(bounds?.height) || 0));
  const x = Math.round(Number(bounds?.x));
  const y = Math.round(Number(bounds?.y));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { width, height };
  }

  try {
    const display = screen.getDisplayMatching({ x, y, width, height }) || screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const clampedWidth = Math.min(width, Math.max(MIN_WINDOW_WIDTH, workArea.width));
    const clampedHeight = Math.min(height, Math.max(MIN_WINDOW_HEIGHT, workArea.height));
    const maxX = workArea.x + workArea.width - clampedWidth;
    const maxY = workArea.y + workArea.height - clampedHeight;

    return {
      x: clampedWidth >= workArea.width ? workArea.x : Math.min(Math.max(x, workArea.x), maxX),
      y: clampedHeight >= workArea.height ? workArea.y : Math.min(Math.max(y, workArea.y), maxY),
      width: clampedWidth,
      height: clampedHeight,
    };
  } catch {
    return { x, y, width, height };
  }
};

const writeWindowState = async (browserWindow) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  if (!state.mainWindow || browserWindow.id !== state.mainWindow.id) return;

  const bounds = browserWindow.getBounds();
  await mutateSettingsRoot((root) => {
    if (!browserWindow || browserWindow.isDestroyed()) return root;
    root.desktopWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, MIN_WINDOW_WIDTH),
      height: Math.max(bounds.height, MIN_WINDOW_HEIGHT),
      maximized: browserWindow.isMaximized(),
      fullscreen: browserWindow.isFullScreen(),
    };
  });
};

const debounceWindowStatePersist = (browserWindow, immediate = false) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const key = String(browserWindow.id);
  const revision = (state.windowGeometryRevisions.get(key) || 0) + 1;
  state.windowGeometryRevisions.set(key, revision);

  const existingTimer = state.windowGeometryTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    state.windowGeometryTimers.delete(key);
  }

  const persist = async () => {
    if (state.windowGeometryRevisions.get(key) !== revision) return;
    state.windowGeometryTimers.delete(key);
    await writeWindowState(browserWindow);
  };

  if (immediate) {
    void persist();
    return;
  }

  const timer = setTimeout(() => {
    void persist();
  }, 300);
  state.windowGeometryTimers.set(key, timer);
};

const buildHealthUrl = (url) => {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}/health`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const buildVersionUrl = (url) => {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}/api/version`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const classifyVersionPayload = (payload) => {
  const compatibility = payload?.compatibility;
  if (!payload || payload.status !== 'ok' || !compatibility || typeof compatibility !== 'object') {
    return 'wrong-service';
  }

  if (!Array.isArray(compatibility.capabilities) || !compatibility.capabilities.includes('api.runtime-url.v1')) {
    return 'incompatible';
  }

  if (compatibility.apiVersion !== 1 || compatibility.minClientApiVersion > 1) {
    return 'update-recommended';
  }

  return 'ok';
};

const fetchVersionPayload = async (versionUrl, { headers, timeoutMs }) => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(versionUrl, { signal: timeoutSignal, headers });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw error;
    }
    return await Promise.race([
      electronNet.fetch(versionUrl, { headers }),
      new Promise((_, reject) => setTimeout(() => reject(error), timeoutMs)),
    ]);
  }
};

const probeHostWithTimeout = async (url, timeoutMs, clientToken = '', requestHeaders = {}, expectedServerId = '') => {
  const versionUrl = buildVersionUrl(url);
  if (!versionUrl) {
    throw new Error('Invalid URL');
  }

  const started = Date.now();

  // Identity gate for learned/untrusted addresses: verify the UNAUTHENTICATED
  // /health identity before the token-carrying version fetch, so the bearer
  // token is never sent to a re-assigned address that now belongs to a
  // different machine. Older servers omit serverId from /health; only an
  // explicit mismatch rejects.
  if (typeof expectedServerId === 'string' && expectedServerId.trim()) {
    const healthUrl = buildHealthUrl(url);
    if (healthUrl) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          const reported = typeof payload?.serverId === 'string' ? payload.serverId.trim() : '';
          if (reported && reported !== expectedServerId.trim()) {
            return { status: 'wrong-service', latencyMs: Date.now() - started };
          }
        }
      } catch {
        // Unreachable/timeout surfaces in the version fetch below.
      }
    }
  }

  try {
    const headers = { ...sanitizeRuntimeRequestHeaders(requestHeaders), Accept: 'application/json' };
    const token = typeof clientToken === 'string' ? clientToken.trim() : '';
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchVersionPayload(versionUrl, { headers, timeoutMs });
    const status = response.status;
    if (status === 401 || status === 403) {
      return { status: 'auth', latencyMs: Date.now() - started };
    }
    if (status < 200 || status >= 300) {
      return { status: 'unreachable', latencyMs: Date.now() - started };
    }
    const payload = await response.json().catch(() => null);
    return {
      status: classifyVersionPayload(payload),
      latencyMs: Date.now() - started,
    };
  } catch {
    return { status: 'unreachable', latencyMs: Date.now() - started };
  }
};

const resolveStoredClientTokenForUrl = (targetUrl, config = readDesktopHostsConfig()) => {
  const normalizedTarget = normalizeHostUrl(targetUrl);
  if (!normalizedTarget) return '';
  if (isLocalRuntimeUrl(normalizedTarget)) {
    return readDesktopLocalClientToken();
  }
  for (const host of config.hosts || []) {
    const hostUrl = normalizeHostUrl(host?.url || '');
    const apiUrl = normalizeHostUrl(host?.apiUrl || host?.url || '');
    if (normalizedTarget === hostUrl || normalizedTarget === apiUrl) {
      return sanitizeClientTokenForStorage(host?.clientToken);
    }
  }
  return '';
};

const waitForHealth = async (url, timeoutMs = 20_000, initialPollMs = 250, maxPollMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  let pollMs = initialPollMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(buildHealthUrl(url), { signal: AbortSignal.timeout(Math.min(pollMs * 4, 1500)) });
      if (response.ok) {
        return true;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(pollMs * 2, maxPollMs);
  }
  return false;
};

const pickUnusedPort = async (host = '127.0.0.1') => {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
};

const isPortFree = async (port, host = '127.0.0.1') => {
  if (!Number.isFinite(port) || port <= 0) return false;
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const test = net.createServer();
    const done = (value) => {
      try { test.close(); } catch {}
      resolve(value);
    };
    test.once('error', () => done(false));
    test.listen(port, host, () => done(true));
  });
};

// Return the LAN IPv4 of the interface that routes to the public internet.
// UDP "connect" is a kernel-side route lookup — no packet actually goes out —
// and it picks the same interface as a real outbound connection, which is what
// a phone on the same Wi-Fi needs to reach us. Falls back to scanning
// os.networkInterfaces() if the socket trick fails (e.g. no default route).
const detectLanIPv4Address = async () => {
  const ip = await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (value) => {
      try { socket.close(); } catch {}
      resolve(value);
    };
    socket.once('error', () => finish(null));
    try {
      socket.connect(80, '8.8.8.8', (error) => {
        if (error) return finish(null);
        try {
          const addr = socket.address();
          finish(addr && typeof addr.address === 'string' ? addr.address : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
  if (ip && ip !== '0.0.0.0' && !ip.startsWith('127.')) return ip;

  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }
  return null;
};

const buildLocalUrl = (port) => `http://127.0.0.1:${port}`;

const resourceRoot = () => isDev ? path.join(__dirname, 'resources') : process.resourcesPath;
const resolveWebDistDir = () => path.join(resourceRoot(), 'web-dist');
const shouldUsePackagedUi = () => {
  if (process.env.OPENCHAMBER_ELECTRON_LOAD_SERVER_UI === '1') return false;
  if (process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1') return true;
  return app.isPackaged;
};
const packagedUiOrigin = () => `${UI_PROTOCOL}://app`;
const buildPackagedUiUrl = (pathname = '/index.html') => new URL(pathname, `${packagedUiOrigin()}/`).toString();

const injectRuntimeConfigIntoHtml = (html) => {
  const apiBaseUrl = state.apiBaseUrl || state.sidecarUrl || '';
  const localOrigin = state.localOrigin || state.sidecarUrl || '';
  const initScript = `<script>if(window.__OPENCHAMBER_LOCAL_ORIGIN__===undefined){window.__OPENCHAMBER_LOCAL_ORIGIN__=${JSON.stringify(localOrigin)};}if(window.__OPENCHAMBER_API_BASE_URL__===undefined){window.__OPENCHAMBER_API_BASE_URL__=${JSON.stringify(apiBaseUrl)};}if(window.__OPENCHAMBER_CLIENT_TOKEN__===undefined&&${JSON.stringify(state.clientToken || '')}){window.__OPENCHAMBER_CLIENT_TOKEN__=${JSON.stringify(state.clientToken || '')};}</script>`;
  if (html.includes('<head>')) return html.replace('<head>', `<head>${initScript}`);
  if (html.includes('</head>')) return html.replace('</head>', `${initScript}</head>`);
  return `${initScript}${html}`;
};

const registerPackagedUiProtocol = () => {
  if (!shouldUsePackagedUi()) return;
  protocol.handle(UI_PROTOCOL, async (request) => {
    const distPath = resolveWebDistDir();
    let requestedPath = '/index.html';
    try {
      const url = new URL(request.url);
      requestedPath = decodeURIComponent(url.pathname || '/index.html');
    } catch {
      requestedPath = '/index.html';
    }
    const normalized = path.normalize(requestedPath).replace(/^([/\\])+/, '');
    const candidate = path.join(distPath, normalized || 'index.html');
    const relative = path.relative(distPath, candidate);
    const isInsideDist = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const filePath = isInsideDist ? candidate : path.join(distPath, 'index.html');
    try {
      const info = await fsp.stat(filePath);
      if (info.isFile()) {
        if (filePath.endsWith('.html')) {
          const html = await fsp.readFile(filePath, 'utf8');
          const body = injectRuntimeConfigIntoHtml(html);
          return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return electronNet.fetch(pathToFileURL(filePath).toString());
      }
    } catch {
    }
    const indexPath = path.join(distPath, 'index.html');
    const html = await fsp.readFile(indexPath, 'utf8');
    const body = injectRuntimeConfigIntoHtml(html);
    return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
};

const normalizeNotificationInput = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  // UI IPC path wraps in { payload: {...} }; sidecar stdout path is flat.
  if (raw.payload && typeof raw.payload === 'object') {
    return { ...raw, ...raw.payload };
  }
  return raw;
};

const isAnyWindowFocused = () =>
  BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );

const focusForegroundWindow = () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length === 0) return;
  const target = state.mainWindow && !state.mainWindow.isDestroyed()
    ? state.mainWindow
    : windows.find((window) => window.isVisible()) || windows[0];
  // macOS: bring the app to foreground FIRST. When the window is minimized
  // to the Dock or hidden via Cmd+H, the app is in the background, and
  // subsequent window.show/restore/focus calls won't pull it forward
  // unless app.focus runs first.
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (typeof target.moveTop === 'function') target.moveTop();
};

// Keep references to live notifications so they aren't garbage-collected
// before the OS fires click/close. On macOS, losing the JS reference causes
// click events to silently stop firing after ~1 min.
// See https://blog.bloomca.me/2025/02/22/electron-mac-notifications
const activeNotifications = new Set();
const nativeNotificationClaims = new Map();
const NATIVE_NOTIFICATION_DEDUPE_TTL_MS = 5000;

const getNativeNotificationClaimKey = (payload) => {
  const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
  if (tag) return tag;
  return [payload?.sessionId, payload?.kind, payload?.title, payload?.body]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('|');
};

const claimNativeNotification = (payload) => {
  const key = getNativeNotificationClaimKey(payload);
  if (!key) return true;

  const now = Date.now();
  for (const [claimKey, claimedAt] of nativeNotificationClaims) {
    if (now - claimedAt > NATIVE_NOTIFICATION_DEDUPE_TTL_MS) {
      nativeNotificationClaims.delete(claimKey);
    }
  }

  const claimedAt = nativeNotificationClaims.get(key) ?? 0;
  if (now - claimedAt < NATIVE_NOTIFICATION_DEDUPE_TTL_MS) {
    return false;
  }

  nativeNotificationClaims.set(key, now);
  return true;
};

const maybeShowNativeNotification = (rawInput) => {
  const payload = normalizeNotificationInput(rawInput);
  const requireHidden = Boolean(payload.requireHidden ?? payload.require_hidden);

  if (requireHidden && isAnyWindowFocused()) {
    return;
  }

  if (!Notification.isSupported()) {
    return;
  }

  if (!claimNativeNotification(payload)) {
    return;
  }

  const title = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'OpenChamber';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : null;
  const directory = typeof payload.directory === 'string' && payload.directory.trim()
    ? payload.directory.trim()
    : null;

  const notification = new Notification({
    title,
    body,
    silent: false,
    ...(process.platform === 'darwin' ? { sound: 'Glass' } : {}),
  });

  activeNotifications.add(notification);
  const release = () => { activeNotifications.delete(notification); };

  notification.on('click', () => {
    focusForegroundWindow();
    if (sessionId) {
      emitToAllWindows('openchamber:open-session', { sessionId, directory });
    }
    release();
  });
  notification.on('close', release);
  notification.on('failed', release);

  notification.show();
};

const mapUpdaterProgressEvent = (payload) => ({
  event: payload.event,
  data: payload.data,
});

const SHELL_ENV_TIMEOUT_MS = 5_000;
let cachedShellEnv = null;
let shellEnvProbed = false;

const isNushell = (shell) => {
  const name = path.basename(shell).toLowerCase();
  return name === 'nu' || name === 'nu.exe';
};

const parseShellEnv = (buf) => {
  const result = {};
  for (const line of buf.toString('utf8').split('\0')) {
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
};

const probeShellEnv = (shell, mode) => {
  const result = spawnSync(shell, [mode, '-c', 'env -0'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: SHELL_ENV_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const env = parseShellEnv(result.stdout);
  return Object.keys(env).length > 0 ? env : null;
};

const queryWindowsRegistryValue = (key, name) => {
  const result = spawnSync('reg.exe', ['query', key, '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return '';
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith(name.toLowerCase()));
  if (!line) return '';
  const match = line.match(/^\S+\s+REG_\S+\s+(.+)$/);
  return match?.[1]?.trim() || '';
};

const expandWindowsEnvRefs = (value) => String(value || '').replace(/%([^%]+)%/g, (_match, key) => process.env[key] || '');

const loadWindowsEnv = () => {
  const machinePath = queryWindowsRegistryValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
  const userPath = queryWindowsRegistryValue('HKCU\\Environment', 'Path');
  const homeDir = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const commonPaths = [
    path.join(homeDir, '.opencode', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin'),
    path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'bin'),
    path.join(appData, 'npm'),
  ];
  return {
    PATH: [machinePath, userPath, process.env.PATH, ...commonPaths]
      .map(expandWindowsEnvRefs)
      .filter(Boolean)
      .join(path.delimiter),
  };
};

// Finder-launched apps on macOS inherit a minimal PATH (no /opt/homebrew, mise, asdf, etc.).
// Probe the user's login shell once so the sidecar sees the same PATH / tool env as `$SHELL -il`.
const loadShellEnv = () => {
  if (shellEnvProbed) return cachedShellEnv;
  shellEnvProbed = true;
  if (process.platform === 'win32') {
    cachedShellEnv = loadWindowsEnv();
    return cachedShellEnv;
  }
  const shell = process.env.SHELL || '/bin/sh';
  if (isNushell(shell)) return null;
  cachedShellEnv = probeShellEnv(shell, '-il') || probeShellEnv(shell, '-l');
  return cachedShellEnv;
};

// Merge the user's login-shell env (PATH, etc.) into this process before we
import { pathLooksUserConfigured, mergePathValues } from '@openchamber/web/server/lib/opencode/path-utils.js';

// import/start the server in-process. The server and its children (opencode
// CLI, git, etc.) inherit process.env directly now — there is no sidecar
// subprocess to hand a custom env to.
const inheritUserShellEnv = () => {
  const shellEnv = loadShellEnv();
  if (!shellEnv) return;

  const homeDir = os.homedir();
  const currentPath = process.env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const currentPathLooksUserConfigured = pathLooksUserConfigured(currentPath, homeDir, delimiter);

  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH') continue;
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }

  const shellPath = typeof shellEnv.PATH === 'string' ? shellEnv.PATH : '';
  if ((process.platform === 'win32' || !currentPathLooksUserConfigured) && shellPath) {
    process.env.PATH = mergePathValues(shellPath, currentPath, delimiter);
  }
};

const spawnLocalServer = async () => {
  inheritUserShellEnv();

  const settings = readSettingsRoot();
  const storedPort = Number.isFinite(settings.desktopLocalPort) ? settings.desktopLocalPort : null;
  // When the user enables "Desktop Network Access" we bind on all interfaces
  // so phones/tablets on the same Wi-Fi can reach the app. UI shows a clear
  // warning and persists the flag via /api/config/settings.
  const lanAccessEnabled = settings.desktopLanAccessEnabled === true;
  setDesktopKeepAwakeActive(settings.desktopKeepAwakeEnabled === true);
  const desktopUiPassword = typeof settings.desktopUiPassword === 'string' ? settings.desktopUiPassword.trim() : '';
  const lanAccessBlockedByMissingPassword = lanAccessEnabled && !desktopUiPassword;
  const effectiveLanAccessEnabled = lanAccessEnabled && !lanAccessBlockedByMissingPassword;
  const bindHost = effectiveLanAccessEnabled ? LAN_BIND_HOST : LOOPBACK_BIND_HOST;
  if (lanAccessBlockedByMissingPassword) {
    log.warn('[desktop] LAN access was requested without a desktop UI password; starting on loopback only.');
  }

  // Probe before starting the server — main() in the server module sets up a
  // lot of global state before binding, and calling it twice after a listen
  // failure would double-wire runtimes. Pick a known-free port in one shot.
  const candidates = [storedPort, DEFAULT_DESKTOP_PORT].filter((v) => Number.isFinite(v) && v > 0);
  let chosenPort = 0;
  for (const candidate of candidates) {
    if (await isPortFree(candidate, bindHost)) {
      chosenPort = candidate;
      break;
    }
  }
  if (chosenPort === 0) {
    chosenPort = await pickUnusedPort(bindHost);
  }

  // The server module reads ENV_DESKTOP_NOTIFY / OPENCHAMBER_DIST_DIR /
  // OPENCHAMBER_RUNTIME at import time (top-level const), so these must be
  // set before the first import. After this point, the same env is used by
  // both the Electron main and the server running inside it.
  process.env.OPENCHAMBER_HOST = bindHost;
  process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE = effectiveLanAccessEnabled ? 'true' : 'false';
  if (lanAccessBlockedByMissingPassword) {
    process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON = 'missing-password';
  } else {
    delete process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON;
  }
  process.env.OPENCHAMBER_DIST_DIR = resolveWebDistDir();
  process.env.OPENCHAMBER_RUNTIME = 'desktop';
  // OpenCode uses process cwd as a fallback directory; app userData would make
  // packaged desktop look like a separate empty workspace.
  process.env.OPENCHAMBER_OPENCODE_CWD = resolveManagedOpenCodeCwd({
    env: process.env,
    homedir: () => os.homedir(),
  });
  process.env.OPENCHAMBER_DESKTOP_NOTIFY = 'true';
  if (desktopUiPassword) {
    process.env.OPENCHAMBER_UI_PASSWORD = desktopUiPassword;
  } else {
    delete process.env.OPENCHAMBER_UI_PASSWORD;
  }
  process.env.OPENCHAMBER_SKIP_API_COMPRESSION = process.env.OPENCHAMBER_SKIP_API_COMPRESSION || 'true';
  process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1';
  process.env.no_proxy = process.env.no_proxy || 'localhost,127.0.0.1';

  const { startWebUiServer } = await import('@openchamber/web/server/index.js');

  const handle = await startWebUiServer({
    port: chosenPort,
    host: bindHost,
    uiPassword: desktopUiPassword || null,
    attachSignals: false,
    exitOnShutdown: false,
    apiOnly: false,
    onDesktopNotification: (payload) => maybeShowNativeNotification(payload),
    getIsWindowFocused: isAnyWindowFocused,
    getDesktopRuntimeConfig: () => ({
      apiBaseUrl: state.apiBaseUrl || '',
      requestHeaders: sanitizeRuntimeRequestHeaders(state.requestHeaders || {}),
    }),
  });

  const port = handle.getPort();
  const url = buildLocalUrl(port);

  state.serverHandle = handle;
  state.sidecarUrl = url;

  await mutateSettingsRoot((root) => {
    root.desktopLocalPort = port;
  });

  return url;
};

const launchDetachedOpenCodeKiller = (processInfo) => {
  if (!processInfo?.managed) return;
  const pid = Number(processInfo.pid);
  const port = Number(processInfo.port);
  const hasPid = Number.isFinite(pid) && pid > 0;
  const hasPort = Number.isFinite(port) && port > 0;
  if (!hasPid && !hasPort) return;
  const normalizedPid = hasPid ? String(Math.trunc(pid)) : '0';
  const normalizedPort = Number.isFinite(port) && port > 0 ? String(Math.trunc(port)) : '0';

  if (process.platform === 'win32') {
    if (!hasPid) return;
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$targetPid = ${normalizedPid}
$graceMs = ${Math.max(0, Math.trunc(OPENCODE_SHUTDOWN_GRACE_MS))}
function Stop-ProcessTree([int]$processId, [bool]$force) {
  if ($processId -le 0) { return }
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId"
  foreach ($child in $children) {
    Stop-ProcessTree ([int]$child.ProcessId) $force
  }
  if ($force) {
    Stop-Process -Id $processId -Force
  } else {
    Stop-Process -Id $processId
  }
}
Stop-ProcessTree $targetPid $false
Start-Sleep -Milliseconds $graceMs
Stop-ProcessTree $targetPid $true
`;
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedScript,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  if (hasPid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
    }
  }

  const script = [
    'pid="$1"',
    'port="$2"',
    'grace="$3"',
    'if [ "$pid" -gt 0 ] 2>/dev/null; then kill -TERM "$pid" 2>/dev/null; kill -TERM "-$pid" 2>/dev/null; fi',
    'sleep "$grace"',
    'if [ "$pid" -gt 0 ] 2>/dev/null; then kill -KILL "-$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; fi',
    'if [ "$port" -gt 0 ] 2>/dev/null && command -v lsof >/dev/null 2>&1; then for target in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null; lsof -ti ":$port" 2>/dev/null); do [ "$target" = "$$" ] || kill -KILL "$target" 2>/dev/null; done; fi',
  ].join('; ');
  const child = spawn('/bin/sh', ['-c', script, 'openchamber-opencode-killer', normalizedPid, normalizedPort, String(OPENCODE_SHUTDOWN_GRACE_MS / 1000)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
};

const killSidecar = () => {
  const handle = state.serverHandle;
  state.serverHandle = null;
  state.sidecarUrl = null;
  if (!handle) return;

  try {
    launchDetachedOpenCodeKiller(handle.getOpenCodeProcessInfo?.());
  } catch (error) {
    log.warn('[electron] failed to launch OpenCode killer:', error);
  }
};

const macosMajorVersion = () => {
  if (process.platform !== 'darwin') return 0;
  const result = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  const raw = (result.stdout || '').trim();
  const [majorRaw, minorRaw] = raw.split('.');
  const major = Number.parseInt(majorRaw || '0', 10);
  const minor = Number.parseInt(minorRaw || '0', 10);
  return major === 10 ? minor : major;
};

const buildInitScript = (localOrigin, bootOutcome, apiBaseUrl = '', clientToken = '', requestHeaders = {}) => {
  const home = JSON.stringify(os.homedir() || '');
  const local = JSON.stringify(localOrigin || '');
  const apiBase = JSON.stringify(apiBaseUrl || '');
  const token = JSON.stringify(clientToken || '');
  const headers = JSON.stringify(sanitizeRuntimeRequestHeaders(requestHeaders));
  const packagedOrigin = JSON.stringify(packagedUiOrigin());
  const macVersion = macosMajorVersion();
  const outcome = JSON.stringify(bootOutcome ?? null);
  return [
    '(function(){',
    `try{var __oc_local=${local};var __oc_api=${apiBase};var __oc_headers=${headers};var __oc_packaged=${packagedOrigin};var __oc_origin=window.location&&window.location.origin||'';var __oc_is_packaged=__oc_origin===__oc_packaged;var __oc_is_local=__oc_local&&__oc_origin===new URL(__oc_local).origin;window.__OPENCHAMBER_MACOS_MAJOR__=${macVersion};window.__OPENCHAMBER_LOCAL_ORIGIN__=__oc_local;window.__OPENCHAMBER_API_BASE_URL__=__oc_api;if(__oc_is_local||__oc_is_packaged){window.__OPENCHAMBER_HOME__=${home};window.__OPENCHAMBER_RUNTIME_HEADERS__=__oc_headers;}if((__oc_is_local||__oc_is_packaged)&&${token}){window.__OPENCHAMBER_CLIENT_TOKEN__=${token};}var __oc_bo=${outcome};if(__oc_bo){window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}}catch(_e){}`,
    '}())',
  ].join('');
};

const computeBootOutcome = ({ envTargetUrl, probe, config, localAvailable }) => {
  if (envTargetUrl) {
    const status = probe?.status === 'unreachable'
      ? 'unreachable'
      : probe?.status === 'incompatible'
        ? 'incompatible'
        : probe?.status === 'wrong-service'
          ? 'wrong-service'
          : 'ok';
    return { target: 'remote', status, hostId: ENV_OVERRIDE_HOST_ID, url: envTargetUrl };
  }

  const defaultId = config.defaultHostId || '';
  if (!defaultId) {
    return { target: null, status: 'not-configured' };
  }

  if (defaultId === LOCAL_HOST_ID) {
    return localAvailable
      ? { target: 'local', status: 'ok' }
      : { target: 'local', status: 'unreachable' };
  }

  const host = config.hosts.find((entry) => entry.id === defaultId);
  if (!host) {
    return { target: 'remote', status: 'missing', hostId: defaultId };
  }

  const status = probe?.status === 'unreachable'
    ? 'unreachable'
    : probe?.status === 'incompatible'
      ? 'incompatible'
      : probe?.status === 'wrong-service'
        ? 'wrong-service'
        : 'ok';
  return { target: 'remote', status, hostId: host.id, url: host.apiUrl || host.url };
};

const buildStartupSplashHtml = () => {
  const settings = readSettingsRoot();
  const splashBgLight = typeof settings.splashBgLight === 'string' ? settings.splashBgLight.trim() : '#f5f5f4';
  const splashFgLight = typeof settings.splashFgLight === 'string' ? settings.splashFgLight.trim() : '#1c1917';
  const splashBgDark = typeof settings.splashBgDark === 'string' ? settings.splashBgDark.trim() : '#0c0a09';
  const splashFgDark = typeof settings.splashFgDark === 'string' ? settings.splashFgDark.trim() : '#fafaf9';

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      :root {
        --splash-background: ${splashBgLight};
        --splash-stroke: ${splashFgLight};
        --splash-face-fill: rgba(0, 0, 0, 0.15);
        --splash-cell-fill: rgba(0, 0, 0, 0.4);
        --splash-logo-fill: var(--splash-stroke);
      }
      body {
        margin: 0;
        font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        display: grid;
        place-items: center;
        height: 100vh;
        background: var(--splash-background);
        color: var(--splash-stroke);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --splash-background: ${splashBgDark};
          --splash-stroke: ${splashFgDark};
          --splash-face-fill: rgba(255, 255, 255, 0.15);
          --splash-cell-fill: rgba(255, 255, 255, 0.35);
        }
      }
      @supports (color: color-mix(in srgb, white 50%, transparent)) {
        :root {
          --splash-face-fill: color-mix(in srgb, var(--splash-stroke) 15%, transparent);
          --splash-cell-fill: color-mix(in srgb, var(--splash-stroke) 35%, transparent);
        }
      }
      .stack {
        display: grid;
        justify-items: center;
      }
    </style>
  </head>
  <body>
    <div class="stack">
      <svg width="120" height="120" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OpenChamber loading icon">
        <path d="M50 50 L8.432 26 L8.432 74 L50 98 Z" fill="var(--splash-face-fill)" stroke="var(--splash-stroke)" stroke-width="2" stroke-linejoin="round"/>
        <path d="M50 50 L39.608 44 L39.608 56 L50 62 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
        <path d="M39.608 44 L29.216 38 L29.216 50 L39.608 56 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
        <path d="M29.216 38 L18.824 32 L18.824 44 L29.216 50 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
        <path d="M18.824 32 L8.432 26 L8.432 38 L18.824 44 Z" fill="var(--splash-cell-fill)" opacity="0.55"/>
        <path d="M50 62 L39.608 56 L39.608 68 L50 74 Z" fill="var(--splash-cell-fill)" opacity="0.35"/>
        <path d="M39.608 56 L29.216 50 L29.216 62 L39.608 68 Z" fill="var(--splash-cell-fill)" opacity="0.1"/>
        <path d="M29.216 50 L18.824 44 L18.824 56 L29.216 62 Z" fill="var(--splash-cell-fill)" opacity="0.5"/>
        <path d="M18.824 44 L8.432 38 L8.432 50 L18.824 56 Z" fill="var(--splash-cell-fill)" opacity="0.25"/>
        <path d="M50 74 L39.608 68 L39.608 80 L50 86 Z" fill="var(--splash-cell-fill)" opacity="0.4"/>
        <path d="M39.608 68 L29.216 62 L29.216 74 L39.608 80 Z" fill="var(--splash-cell-fill)" opacity="0.3"/>
        <path d="M29.216 62 L18.824 56 L18.824 68 L29.216 74 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
        <path d="M18.824 56 L8.432 50 L8.432 62 L18.824 68 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
        <path d="M50 86 L39.608 80 L39.608 92 L50 98 Z" fill="var(--splash-cell-fill)" opacity="0.55"/>
        <path d="M39.608 80 L29.216 74 L29.216 86 L39.608 92 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
        <path d="M29.216 74 L18.824 68 L18.824 80 L29.216 86 Z" fill="var(--splash-cell-fill)" opacity="0.35"/>
        <path d="M18.824 68 L8.432 62 L8.432 74 L18.824 80 Z" fill="var(--splash-cell-fill)" opacity="0.1"/>
        <path d="M50 50 L91.568 26 L91.568 74 L50 98 Z" fill="var(--splash-face-fill)" stroke="var(--splash-stroke)" stroke-width="2" stroke-linejoin="round"/>
        <path d="M50 50 L60.392 44 L60.392 56 L50 62 Z" fill="var(--splash-cell-fill)" opacity="0.3"/>
        <path d="M60.392 44 L70.784 38 L70.784 50 L60.392 56 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
        <path d="M70.784 38 L81.176 32 L81.176 44 L70.784 50 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
        <path d="M81.176 32 L91.568 26 L91.568 38 L81.176 44 Z" fill="var(--splash-cell-fill)" opacity="0.25"/>
        <path d="M50 62 L60.392 56 L60.392 68 L50 74 Z" fill="var(--splash-cell-fill)" opacity="0.5"/>
        <path d="M60.392 56 L70.784 50 L70.784 62 L60.392 68 Z" fill="var(--splash-cell-fill)" opacity="0.35"/>
        <path d="M70.784 50 L81.176 44 L81.176 56 L70.784 62 Z" fill="var(--splash-cell-fill)" opacity="0.1"/>
        <path d="M81.176 44 L91.568 38 L91.568 50 L81.176 56 Z" fill="var(--splash-cell-fill)" opacity="0.4"/>
        <path d="M50 74 L60.392 68 L60.392 80 L50 86 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
        <path d="M60.392 68 L70.784 62 L70.784 74 L60.392 80 Z" fill="var(--splash-cell-fill)" opacity="0.55"/>
        <path d="M70.784 62 L81.176 56 L81.176 68 L70.784 74 Z" fill="var(--splash-cell-fill)" opacity="0.3"/>
        <path d="M81.176 56 L91.568 50 L91.568 62 L81.176 68 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
        <path d="M50 86 L60.392 80 L60.392 92 L50 98 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
        <path d="M60.392 80 L70.784 74 L70.784 86 L60.392 92 Z" fill="var(--splash-cell-fill)" opacity="0.25"/>
        <path d="M70.784 74 L81.176 68 L81.176 80 L70.784 86 Z" fill="var(--splash-cell-fill)" opacity="0.4"/>
        <path d="M81.176 68 L91.568 62 L91.568 74 L81.176 80 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
        <path d="M50 2 L8.432 26 L50 50 L91.568 26 Z" fill="none" stroke="var(--splash-stroke)" stroke-width="2" stroke-linejoin="round"/>
        <g transform="matrix(0.866, 0.5, -0.866, 0.5, 50, 26) scale(0.75)">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M-16 -20 L16 -20 L16 20 L-16 20 Z M-8 -12 L-8 12 L8 12 L8 -12 Z" fill="var(--splash-logo-fill)"/>
          <path d="M-8 -4 L8 -4 L8 12 L-8 12 Z" fill="var(--splash-logo-fill)" fill-opacity="0.4"/>
        </g>
      </svg>
    </div>
  </body>
  </html>`;
};

const isBenignNavigationAbort = (error) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (error.errno === -3) {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  return message.includes('ERR_ABORTED') || message.includes(' (-3) loading ');
};

const navigateWindow = async (browserWindow, url, { allowAbort = false } = {}) => {
  try {
    await browserWindow.loadURL(url);
  } catch (error) {
    if (allowAbort && isBenignNavigationAbort(error)) {
      return;
    }
    throw error;
  }
};

const extractCookieHeader = (response) => {
  const getSetCookie = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie.bind(response.headers)
    : null;
  const cookies = getSetCookie ? getSetCookie() : [];
  const rawCookies = cookies.length > 0
    ? cookies
    : String(response.headers?.get?.('set-cookie') || '').split(/,(?=\s*[^;,=]+=[^;,]+)/);
  return rawCookies
    .map((cookie) => String(cookie || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
};

const loginRemoteAndIssueClientToken = async ({ url, password, trustDevice, requestHeaders }) => {
  const baseUrl = normalizeHostUrl(String(url || ''));
  const candidatePassword = typeof password === 'string' ? password : '';
  const safeRequestHeaders = sanitizeRuntimeRequestHeaders(requestHeaders || {});
  if (!baseUrl) throw new Error('Invalid URL');
  if (!candidatePassword) throw new Error('Password is required');

  // Stable client identity so re-login reuses the same device record. Local
  // uses the fixed desktop-local identity; remote uses this install's id with a
  // regular 'desktop' kind.
  const clientIdentity = isLocalRuntimeUrl(baseUrl)
    ? { clientKind: LOCAL_DESKTOP_CLIENT_KIND, dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY, ...desktopDeviceMetadata() }
    : { clientKind: REMOTE_DESKTOP_CLIENT_KIND, dedupeKey: `desktop:${await getOrCreateDesktopInstallId()}`, ...desktopDeviceMetadata() };

  const loginResponse = await fetch(new URL('/auth/session', `${baseUrl}/`).toString(), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...safeRequestHeaders,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      password: candidatePassword,
      trustDevice: trustDevice === true,
      issueClientToken: true,
      clientLabel: 'OpenChamber Desktop',
      ...clientIdentity,
    }),
  });
  if (!loginResponse.ok) {
    return { ok: false, status: loginResponse.status };
  }

  const loginPayload = await loginResponse.json().catch(() => null);
  if (typeof loginPayload?.clientToken === 'string' && loginPayload.clientToken.trim()) {
    return { ok: true, token: loginPayload.clientToken.trim() };
  }

  const cookie = extractCookieHeader(loginResponse);
  if (!cookie) {
    return { ok: false, status: 401 };
  }

  const tokenResponse = await fetch(new URL('/api/client-auth/clients', `${baseUrl}/`).toString(), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...safeRequestHeaders,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      label: 'OpenChamber Desktop',
      ...clientIdentity,
    }),
  });
  if (!tokenResponse.ok) {
    return { ok: false, status: tokenResponse.status };
  }
  const tokenPayload = await tokenResponse.json().catch(() => null);
  const token = typeof tokenPayload?.token === 'string' ? tokenPayload.token.trim() : '';
  return token ? { ok: true, token } : { ok: false, status: 500 };
};

const emitToWindow = (browserWindow, event, detail) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  browserWindow.webContents.send('openchamber:emit', { event, detail });
};

const emitToAllWindows = (event, detail) => {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    emitToWindow(browserWindow, event, detail);
  }
};

// macOS vibrancy: the native NSVisualEffectView needs a moment to settle after
// the window is shown/restored. Until then the renderer keeps the sidebar solid
// to avoid a flash of raw transparency; once ready it switches to the
// translucent overlay. We toggle this readiness over the same IPC bridge.
// Apply vibrancy to a live, on-screen window. Done after show (not in the
// BrowserWindow constructor) because macOS otherwise leaves the material
// uncomposited on a cold launch until the window gets a state change.
const applyMacVibrancy = (browserWindow) => {
  if (process.platform !== 'darwin' || !browserWindow || browserWindow.isDestroyed()) return;
  try {
    browserWindow.setVibrancy('sidebar');
  } catch {}
};

const setMacVibrancyReady = (browserWindow, ready) => {
  if (process.platform !== 'darwin' || !browserWindow || browserWindow.isDestroyed()) return;
  emitToWindow(browserWindow, 'openchamber:vibrancy-ready', { ready });
};

const scheduleMacVibrancyReady = (browserWindow, delayMs = 160) => {
  if (process.platform !== 'darwin' || !browserWindow || browserWindow.isDestroyed()) return;
  setMacVibrancyReady(browserWindow, false);
  const timer = setTimeout(() => {
    if (browserWindow.isDestroyed() || browserWindow.isMinimized() || !browserWindow.isVisible()) return;
    setMacVibrancyReady(browserWindow, true);
  }, delayMs);
  if (typeof timer?.unref === 'function') timer.unref();
};


const setTaskbarProgress = (value) => {
  if (process.platform !== 'win32') return;
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.setProgressBar(value);
    }
  }
};

const pendingDeepLinks = [];

const parseDeepLink = (raw) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;
    const type = url.hostname;
    if (!type) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const value = segments.length > 0
      ? decodeURIComponent(segments.join('/'))
      : '';
    return { type, value, raw: trimmed };
  } catch {
    return null;
  }
};

const importConnectDeepLink = async (payload) => {
  if (!payload?.serverUrl || !payload?.token) return null;
  const serverUrl = normalizeHostUrl(payload.serverUrl);
  if (!serverUrl) return null;
  const config = readDesktopHostsConfig();
  const existing = config.hosts.find((host) => {
    const hostUrl = normalizeHostUrl(host?.url || '');
    const apiUrl = normalizeHostUrl(host?.apiUrl || host?.url || '');
    return serverUrl === hostUrl || serverUrl === apiUrl;
  });

  const id = existing?.id || `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const importedHost = {
    ...(existing || {}),
    id,
    label: payload.label || existing?.label || serverUrl,
    url: serverUrl,
    apiUrl: serverUrl,
    clientToken: payload.token,
  };
  const hosts = existing
    ? config.hosts.map((host) => (host.id === existing.id ? importedHost : host))
    : [importedHost, ...config.hosts];
  await writeDesktopHostsConfig({
    ...config,
    hosts,
    defaultHostId: config.defaultHostId || id,
    initialHostChoiceCompleted: true,
  });
  return id;
};

const requestJsonWithTimeout = async (url, init = {}, timeoutMs = 8000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
};

const selectPairingCandidateUrl = async (payload) => {
  for (const candidate of payload.candidates || []) {
    try {
      const health = await requestJsonWithTimeout(`${candidate.url.replace(/\/+$/g, '')}/health`, { method: 'GET' }, 3500);
      if (health.ok) return candidate.url.replace(/\/+$/g, '');
    } catch {
      // Health check failed for this candidate; try the next one.
      // Transient network errors, timeouts, and unreachable hosts are expected
      // when probing multiple plain HTTP(S) candidates (deep-link payloads contain
      // only direct HTTP/HTTPS URLs; relay and direct-E2EE candidates are rejected).
    }
  }
  return null;
};

const redeemConnectPairingDeepLink = async (payload, serverUrl) => {
  const response = await requestJsonWithTimeout(`${serverUrl.replace(/\/+$/g, '')}/api/client-auth/pairing/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      pairingId: payload.pairingId,
      secret: payload.secret,
      clientLabel: 'OpenChamber Desktop',
      clientKind: 'desktop',
      deviceName: 'OpenChamber Desktop',
      ...desktopDeviceMetadata(),
      dedupeKey: `desktop:${await getOrCreateDesktopInstallId()}`,
    }),
  });
  if (!response.ok || !response.data || typeof response.data.clientToken !== 'string') return null;
  return {
    serverUrl,
    token: sanitizeClientTokenForStorage(response.data.clientToken),
    label: payload.label || response.data?.server?.label || serverUrl,
  };
};

const switchToHostById = async (rawId) => {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) return;
  const config = readDesktopHostsConfig();
  let targetUrl = null;
  let apiBaseUrl = null;
  let clientToken = '';
  let requestHeaders = {};
  if (id === LOCAL_HOST_ID) {
    targetUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
    apiBaseUrl = state.sidecarUrl;
    clientToken = readDesktopLocalClientToken();
    requestHeaders = {};
  } else {
    const host = config.hosts.find((entry) => entry.id === id);
    if (!host) {
      log.warn('[electron] deep-link host not found:', id);
      return;
    }
    targetUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : host.url;
    apiBaseUrl = host.apiUrl || host.url;
    clientToken = host.clientToken || '';
    requestHeaders = sanitizeRuntimeRequestHeaders(host.requestHeaders || {});
  }
  if (!targetUrl || !apiBaseUrl) {
    log.warn('[electron] deep-link host has no target URL:', id);
    return;
  }
  const bootOutcome = id === LOCAL_HOST_ID
    ? { target: 'local', status: 'ok' }
    : { target: 'remote', status: 'ok', hostId: id, url: apiBaseUrl };
  log.info('[electron] switching to host', { id, bootOutcome });
  await activateMainWindow(targetUrl, state.localOrigin, bootOutcome, { apiBaseUrl, clientToken, requestHeaders });
};

const confirmConnectDeepLink = async (payload) => {
  // A connect deep-link can be triggered from a browser/email/chat with no
  // in-app interaction. Importing it stores a client token and points all of
  // this app's API traffic at the given server, so require explicit consent
  // BEFORE writing anything to the hosts config. Never surface the token.
  const visible = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
  if (visible) {
    visible.show();
    visible.focus();
  }
  const options = {
    type: 'warning',
    title: 'Connect to OpenChamber server?',
    message: `Connect to "${payload.label}"?`,
    detail:
      `This will add ${payload.serverUrl} as a remote instance and route this app's activity ` +
      'through it. Only continue if you trust this server and started the connection yourself.',
    buttons: ['Connect', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  };
  try {
    const result = visible
      ? await dialog.showMessageBox(visible, options)
      : await dialog.showMessageBox(options);
    return result.response === 0;
  } catch (error) {
    log.warn('[electron] connect deep-link confirmation failed:', error);
    return false;
  }
};

const dispatchDeepLink = (link) => {
  if (!link) return;
  log.info('[electron] dispatching deep-link', { type: link.type, valueLen: link.value?.length || 0 });
  if (link.type === 'connect') {
    const decision = decidePairingV2DeepLink(link.raw);
    if (decision.kind === 'accept') {
      const pairingPayload = decision.payload;
      const previewUrl = pairingPayload.candidates[0].url;
      void confirmConnectDeepLink({
        serverUrl: previewUrl,
        token: 'pairing-v2',
        label: pairingPayload.fingerprint ? `${pairingPayload.label} (${pairingPayload.fingerprint})` : pairingPayload.label,
      }).then(async (confirmed) => {
        if (!confirmed) {
          log.info('[electron] connect pairing deep-link declined by user');
          return;
        }
        const serverUrl = await selectPairingCandidateUrl(pairingPayload);
        if (!serverUrl) {
          log.warn('[electron] connect pairing deep-link has no reachable candidate');
          return;
        }
        const importedPayload = await redeemConnectPairingDeepLink(pairingPayload, serverUrl).catch((error) => {
          log.warn('[electron] connect pairing redeem failed:', error);
          return null;
        });
        if (!importedPayload?.token) {
          log.warn('[electron] connect pairing redeem returned no client token');
          return;
        }
        const id = await importConnectDeepLink(importedPayload);
        if (id) void switchToHostById(id);
      });
      return;
    }
    log.warn(`[electron] connect pairing deep-link rejected: ${decision.reason}`);
    return;
  }
  if (link.type === 'session' && link.value) {
    emitToAllWindows('openchamber:open-session', { sessionId: link.value });
    return;
  }
  if (link.type === 'host' && link.value) {
    void switchToHostById(link.value);
    return;
  }
  log.warn('[electron] unknown deep-link action:', link.type);
};

const flushPendingDeepLinks = () => {
  while (pendingDeepLinks.length > 0) {
    dispatchDeepLink(pendingDeepLinks.shift());
  }
};

const isMainWindowReadyForDeepLink = () =>
  Boolean(state.mainWindow)
  && !state.mainWindow.isDestroyed()
  && !state.mainWindow.webContents.isLoading();

const handleDeepLinks = (urls) => {
  for (const raw of urls) {
    const parsed = parseDeepLink(raw);
    if (!parsed) continue;
    if (isMainWindowReadyForDeepLink()) {
      dispatchDeepLink(parsed);
    } else {
      pendingDeepLinks.push(parsed);
    }
  }
};

const extractInitialDeepLinks = () =>
  process.argv.filter((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`));

const dispatchDomEventToWindow = (browserWindow, event, detail) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;

  const eventLiteral = JSON.stringify(event);
  const script = detail === undefined
    ? `window.dispatchEvent(new Event(${eventLiteral}));`
    : `window.dispatchEvent(new CustomEvent(${eventLiteral}, { detail: ${JSON.stringify(detail)} }));`;

  void browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
};

const getMenuTargetWindow = () => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) return state.mainWindow;
  const [firstWindow] = BrowserWindow.getAllWindows();
  return firstWindow && !firstWindow.isDestroyed() ? firstWindow : null;
};

const dispatchMenuAction = (action) => {
  const target = getMenuTargetWindow();
  emitToWindow(target, 'openchamber:menu-action', action);
  dispatchDomEventToWindow(target, 'openchamber:menu-action', action);
};

// Mini-chat draft windows are not deduplicated, so this must reach the renderer
// exactly once — emitToWindow alone (no DOM-event double dispatch). The renderer
// resolves the active directory/project and opens the window.
const dispatchOpenMiniChat = (browserWindow) => {
  const target = browserWindow && !browserWindow.isDestroyed() ? browserWindow : getMenuTargetWindow();
  if (target) emitToWindow(target, 'openchamber:open-mini-chat');
};

const dispatchCheckForUpdates = () => {
  emitToAllWindows('openchamber:check-for-updates');
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    dispatchDomEventToWindow(browserWindow, 'openchamber:check-for-updates');
  }
};

const reloadMenuTargetWindow = () => {
  const target = getMenuTargetWindow();
  if (!target || target.isDestroyed()) return;
  target.webContents.reload();
};

const openDevToolsForMenuTarget = () => {
  const target = getMenuTargetWindow();
  if (!target || target.isDestroyed()) return;
  target.webContents.toggleDevTools();
};

const relaunchFromMenu = () => {
  prepareForQuit();
  app.relaunch();
  app.exit(0);
};

const nextWindowLabel = () => {
  const value = state.windowCounter++;
  return value === 1 ? 'main' : `main-${value}`;
};

const readThemeSource = () => {
  const settings = readSettingsRoot();
  // themeMode is the user's intent; themeVariant is only the resolved
  // concrete appearance at persist time. When mode === 'system', we must
  // follow the OS even if variant was saved as a specific value.
  if (settings.themeMode === 'system' || settings.useSystemTheme === true) return 'system';
  if (settings.themeMode === 'light') return 'light';
  if (settings.themeMode === 'dark') return 'dark';
  if (settings.themeVariant === 'light') return 'light';
  if (settings.themeVariant === 'dark') return 'dark';
  return 'system';
};

const getWindowIconPath = () => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const iconFileName = process.platform === 'linux' ? 'icon.png' : 'icon.ico';
  const iconPath = isDev
    ? path.join(__dirname, 'resources', 'icons', iconFileName)
    : path.join(process.resourcesPath, 'icons', iconFileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
};

const canUseTitleBarOverlay = (browserWindow) => (
  process.platform === 'win32' &&
  Boolean(browserWindow?.__ocTitleBarOverlayEnabled) &&
  typeof browserWindow.setTitleBarOverlay === 'function' &&
  !browserWindow.isDestroyed()
);

const createBrowserWindow = ({ label, restoreGeometry, url, runtimeConfig = {} }) => {
  const saved = restoreGeometry ? readWindowState() : null;
  const useSaved = saved && typeof saved.width === 'number' && typeof saved.height === 'number';
  const restoredBounds = useSaved ? clampWindowBoundsToVisibleWorkArea(saved) : null;
  const desktopLocalOrigin = state.localOrigin || state.sidecarUrl || '';
  const rendererRuntimeConfig = buildRendererRuntimeConfig(url, runtimeConfig);
  const desktopApiBaseUrl = rendererRuntimeConfig.apiBaseUrl;
  const desktopClientToken = rendererRuntimeConfig.clientToken;
  const desktopRequestHeaders = rendererRuntimeConfig.requestHeaders || {};
  const desktopHome = os.homedir() || '';
  const desktopMacosMajor = String(macosMajorVersion());
  const usesFramelessChrome = process.platform === 'win32' || process.platform === 'linux';
  const usesCustomTitleBar = process.platform === 'darwin' || usesFramelessChrome;
  // macOS vibrancy, on by default; users can disable it (Appearance settings).
  const useVibrancy = process.platform === 'darwin' && readSettingsRoot().desktopVibrancy !== false;
  const titleBarOverlayEnabled = false;
  const autoHidesNativeMenuBar = process.platform !== 'darwin';
  const windowIconPath = getWindowIconPath();
  const options = {
    title: 'OpenChamber',
    ...(Number.isFinite(restoredBounds?.x) && Number.isFinite(restoredBounds?.y)
      ? { x: restoredBounds.x, y: restoredBounds.y }
      : {}),
    width: restoredBounds?.width ?? 1280,
    height: restoredBounds?.height ?? 800,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: windowIconPath,
    show: false,
    backgroundColor: useVibrancy ? '#00000000' : '#151313',
    // Vibrancy is applied after the window is shown (see applyMacVibrancy), not
    // here: setting it in the constructor leaves the material uncomposited on a
    // cold launch until a window event. No `transparent: true` either — vibrancy
    // alone is enough and composites reliably once applied to a live window.
    frame: usesFramelessChrome ? false : undefined,
    autoHideMenuBar: autoHidesNativeMenuBar,
    // Electron's hiddenInset adds its own extra inset, which leaves the controls
    // visibly lower than the app header. Use a plain hidden title bar instead.
    titleBarStyle: usesCustomTitleBar ? 'hidden' : 'default',
    titleBarOverlay: titleBarOverlayEnabled,
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      additionalArguments: buildDesktopAdditionalArguments({
        localOrigin: desktopLocalOrigin,
        homeDirectory: desktopHome,
        macosMajor: desktopMacosMajor,
        macVibrancy: useVibrancy,
        bootOutcome: state.bootOutcome || null,
      }),
      preload: isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // sandbox must stay off: the preload uses contextBridge + ipcRenderer
      // from Electron's Node layer. contextIsolation + nodeIntegration:false
      // keep the renderer world walled off from Node. Do NOT flip to true —
      // the preload would fail to load and the desktop bridge would be unavailable.
      sandbox: false,
    },
  };

  const browserWindow = new BrowserWindow(options);
  browserWindow.__ocLabel = label || nextWindowLabel();
  browserWindow.__ocRuntimeConfig = {
    apiBaseUrl: desktopApiBaseUrl,
    clientToken: desktopClientToken,
    requestHeaders: desktopRequestHeaders,
    relayHostId: rendererRuntimeConfig.relayHostId || '',
  };
  browserWindow.__ocInitScript = buildInitScript(desktopLocalOrigin, state.bootOutcome, desktopApiBaseUrl, desktopClientToken, desktopRequestHeaders);
  browserWindow.__ocTitleBarOverlayEnabled = titleBarOverlayEnabled;

  if (useSaved && saved.maximized) {
    browserWindow.maximize();
  }

  browserWindow.on('focus', () => {
    state.focusedWindowIds.add(browserWindow.id);
  });
  browserWindow.on('blur', () => {
    state.focusedWindowIds.delete(browserWindow.id);
  });

  // Traffic lights disappear during dock-restore animation when using
  // titleBarStyle:'hidden' + custom trafficLightPosition. macOS caches a
  // snapshot of the window at miniaturize time and plays it during the
  // genie-restore animation. We re-assert button position on 'minimize'
  // (before the snapshot) and 'restore'/'show'/'focus' to cover other
  // transient reset states AppKit puts the buttons in.
  if (process.platform === 'darwin') {
    const refreshTrafficLights = () => {
      if (browserWindow.isDestroyed()) return;
      try {
        browserWindow.setWindowButtonVisibility(true);
        browserWindow.setTrafficLightPosition({ x: 16, y: 17 });
      } catch {}
    };
    browserWindow.on('minimize', () => {
      refreshTrafficLights();
      setMacVibrancyReady(browserWindow, false);
    });
    browserWindow.on('restore', () => {
      refreshTrafficLights();
      setTimeout(refreshTrafficLights, 250);
      scheduleMacVibrancyReady(browserWindow, 180);
    });
    // Only suppress vibrancy around the minimize/restore cycle (it flashes raw
    // transparency during the genie animation). A plain show — cold launch from
    // the dock, un-hide — must NOT suppress, or the sidebar gets stuck solid
    // when the post-show `ready` re-enable is skipped while the window is still
    // animating in.
    browserWindow.on('show', refreshTrafficLights);
    browserWindow.on('focus', refreshTrafficLights);
  }

  browserWindow.on('resize', () => {
    if (process.platform === 'darwin') {
      emitToWindow(browserWindow, 'openchamber:window-resized');
    }
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('maximize', () => {
    emitToWindow(browserWindow, 'openchamber:window-maximized-changed', { maximized: true });
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('unmaximize', () => {
    emitToWindow(browserWindow, 'openchamber:window-maximized-changed', { maximized: false });
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('move', () => {
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('minimize', (event) => {
    if (!shouldHideMainWindowToTray(browserWindow)) return;
    debounceWindowStatePersist(browserWindow, true);
    event.preventDefault();
    browserWindow.hide();
  });
  browserWindow.on('close', (event) => {
    if (!state.quitRequested && shouldHideMainWindowToTray(browserWindow)) {
      debounceWindowStatePersist(browserWindow, true);
      event.preventDefault();
      browserWindow.hide();
      return;
    }

    if (process.platform === 'darwin' && !state.quitRequested) {
      const remainingVisible = BrowserWindow.getAllWindows().filter(
        (window) => !window.isDestroyed() && window.isVisible(),
      ).length;

      if (remainingVisible <= 1) {
        debounceWindowStatePersist(browserWindow, true);
        event.preventDefault();
        browserWindow.hide();
        return;
      }
    }

    debounceWindowStatePersist(browserWindow, true);
  });
  browserWindow.on('closed', () => {
    state.focusedWindowIds.delete(browserWindow.id);
    if (state.mainWindow && browserWindow.id === state.mainWindow.id) {
      state.mainWindow = null;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      if (process.platform !== 'darwin') {
        if (state.installingUpdate) {
          app.quit();
        } else {
          performConfirmedQuit();
        }
      }
    }
  });

  // Any navigation target that isn't our own UI (local server / configured
  // desktop hosts) should open in the user's default browser, not spawn
  // another Electron window loading arbitrary web content.
  const isAllowedNavigationUrl = (raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol === 'devtools:') return true;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      if (state.localOrigin) {
        try {
          if (new URL(state.localOrigin).origin === url.origin) return true;
        } catch {
        }
      }
      if (state.sidecarUrl) {
        try {
          if (new URL(state.sidecarUrl).origin === url.origin) return true;
        } catch {
        }
      }
      const hosts = readDesktopHostsConfig()?.hosts || [];
      for (const entry of hosts) {
        if (typeof entry?.url !== 'string') continue;
        try {
          if (new URL(entry.url).origin === url.origin) return true;
        } catch {
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigationUrl(url)) {
      return { action: 'allow' };
    }
    void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url).catch(() => {});
  });

  browserWindow.webContents.setZoomFactor(1);
  browserWindow.webContents.on('zoom-changed', () => {
    browserWindow.webContents.setZoomFactor(1);
  });

  browserWindow.webContents.on('dom-ready', () => {
    const initScript = browserWindow.__ocInitScript || state.initScript;
    if (initScript) {
      void browserWindow.webContents.executeJavaScript(initScript).catch(() => {});
    }
  });

  browserWindow.webContents.on('did-finish-load', () => {
    browserWindow.webContents.setZoomFactor(1);
    if (state.mainWindow && browserWindow.id === state.mainWindow.id && pendingDeepLinks.length > 0) {
      const timer = setTimeout(flushPendingDeepLinks, 400);
      if (typeof timer?.unref === 'function') timer.unref();
    }
  });

  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
    browserWindow.focus();
    if (useVibrancy) applyMacVibrancy(browserWindow);
  });

  if (url) {
    void navigateWindow(browserWindow, url);
  } else {
    void navigateWindow(
      browserWindow,
      `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupSplashHtml())}`,
      { allowAbort: true },
    );
  }

  return browserWindow;
};

const activateMainWindow = async (url, localOrigin, bootOutcome, runtimeConfig = {}) => {
  state.localOrigin = localOrigin;
  state.apiBaseUrl = typeof runtimeConfig.apiBaseUrl === 'string' ? runtimeConfig.apiBaseUrl : state.apiBaseUrl;
  state.clientToken = typeof runtimeConfig.clientToken === 'string' ? runtimeConfig.clientToken : '';
  state.requestHeaders = sanitizeRuntimeRequestHeaders(runtimeConfig.requestHeaders || {});
  state.bootOutcome = bootOutcome ?? null;
  const rendererRuntimeConfig = buildRendererRuntimeConfig(url, {
    apiBaseUrl: state.apiBaseUrl || '',
    clientToken: state.clientToken || '',
    requestHeaders: state.requestHeaders || {},
    relayHostId: typeof runtimeConfig.relayHostId === 'string' ? runtimeConfig.relayHostId : '',
  });
  state.initScript = buildInitScript(
    localOrigin,
    state.bootOutcome,
    rendererRuntimeConfig.apiBaseUrl,
    rendererRuntimeConfig.clientToken,
    rendererRuntimeConfig.requestHeaders,
  );

  const mainWindow = state.mainWindow;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.__ocRuntimeConfig = rendererRuntimeConfig;
    mainWindow.__ocInitScript = state.initScript;
    await navigateWindow(mainWindow, url, { allowAbort: true });
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  state.mainWindow = createBrowserWindow({
    label: 'main',
    restoreGeometry: true,
    url,
    runtimeConfig,
  });
  return state.mainWindow;
};

const openMainWindow = async () => {
  if (!state.localOrigin) {
    const { initialUrl, localOrigin, bootOutcome, apiBaseUrl, clientToken, requestHeaders } = await resolveInitialUrl();
    return activateMainWindow(initialUrl, localOrigin, bootOutcome, { apiBaseUrl, clientToken, requestHeaders });
  }

  const config = readDesktopHostsConfig();
  const localUiUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
  const host = config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID
    ? config.hosts.find((entry) => entry.id === config.defaultHostId)
    : null;
  const relayHost = host && ((host.relay && typeof host.relay === 'object') || (host.directE2ee && typeof host.directE2ee === 'object')) ? host : null;
  if (relayHost) {
    // Relay hosts have no reachable HTTP base. Boot the LOCAL UI with the local
    // runtime; the renderer re-opens the E2EE tunnel on startup by reading the
    // relay descriptor + token from desktopHosts and calling
    // switchRuntimeEndpoint({ relay }).
    const localApiBaseUrl = state.sidecarUrl || state.apiBaseUrl || state.localOrigin || '';
    const localToken = resolveStoredClientTokenForUrl(localApiBaseUrl, config) || state.clientToken || '';
    return activateMainWindow(localUiUrl, state.localOrigin, state.bootOutcome, {
      apiBaseUrl: localApiBaseUrl,
      clientToken: localToken,
      requestHeaders: {},
      relayHostId: relayHost.id,
    });
  }
  const apiBaseUrl = host?.apiUrl || host?.url || state.sidecarUrl || state.apiBaseUrl || '';
  const clientToken = host?.clientToken || resolveStoredClientTokenForUrl(apiBaseUrl, config) || state.clientToken || '';
  const requestHeaders = sanitizeRuntimeRequestHeaders(host?.requestHeaders || {});
  const targetUrl = host?.url && apiBaseUrl && !state.unreachableHosts.has(apiBaseUrl)
    ? (shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : host.url)
    : localUiUrl;
  return activateMainWindow(targetUrl, state.localOrigin, state.bootOutcome, { apiBaseUrl, clientToken, requestHeaders });
};

const createAdditionalWindow = async (url, runtimeConfig = {}) => {
  if (!state.localOrigin) {
    return null;
  }
  const browserWindow = createBrowserWindow({
    label: nextWindowLabel(),
    restoreGeometry: false,
    url,
    runtimeConfig,
  });
  return browserWindow;
};

const buildMiniChatUrl = ({ mode, sessionId, directory, projectId }) => {
  const base = state.localOrigin || state.sidecarUrl;
  if (!base) {
    throw new Error('Local UI is not available');
  }

  const url = new URL(shouldUsePackagedUi() ? buildPackagedUiUrl('/mini-chat.html') : '/mini-chat.html', base);
  url.searchParams.set('mode', mode === 'session' ? 'session' : 'draft');
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (directory) url.searchParams.set('directory', directory);
  if (projectId) url.searchParams.set('projectId', projectId);
  return url.toString();
};

const miniChatSessionWindowKey = (runtimeConfig, sessionId) => {
  const runtimeKey = normalizeHostUrl(runtimeConfig?.apiBaseUrl || state.apiBaseUrl || state.localOrigin || state.sidecarUrl || '') || 'local';
  return `${runtimeKey}\n${sessionId}`;
};

const getWindowRuntimeConfig = (browserWindow) => {
  const fallback = {
    apiBaseUrl: state.apiBaseUrl || state.localOrigin || state.sidecarUrl || '',
    clientToken: state.clientToken || '',
    requestHeaders: state.requestHeaders || {},
    relayHostId: '',
  };
  if (!browserWindow || browserWindow.isDestroyed()) return fallback;
  const config = browserWindow.__ocRuntimeConfig;
  return {
    apiBaseUrl: typeof config?.apiBaseUrl === 'string' ? config.apiBaseUrl : fallback.apiBaseUrl,
    clientToken: typeof config?.clientToken === 'string' ? config.clientToken : fallback.clientToken,
    requestHeaders: sanitizeRuntimeRequestHeaders(config?.requestHeaders || fallback.requestHeaders),
    relayHostId: typeof config?.relayHostId === 'string' ? config.relayHostId : fallback.relayHostId,
  };
};

const createMiniChatWindow = async ({ mode, sessionId = '', directory = '', projectId = '', runtimeConfig = {} } = {}) => {
  const effectiveRuntimeConfig = {
    apiBaseUrl: normalizeHostUrl(runtimeConfig.apiBaseUrl || state.apiBaseUrl || state.localOrigin || state.sidecarUrl || ''),
    clientToken: sanitizeClientTokenForStorage(runtimeConfig.clientToken || state.clientToken || ''),
    requestHeaders: sanitizeRuntimeRequestHeaders(runtimeConfig.requestHeaders || state.requestHeaders || {}),
    relayHostId: typeof runtimeConfig.relayHostId === 'string' ? runtimeConfig.relayHostId : '',
  };
  const sessionWindowKey = mode === 'session' && sessionId ? miniChatSessionWindowKey(effectiveRuntimeConfig, sessionId) : '';
  if (mode === 'session' && sessionId) {
    const existing = state.miniChatWindowsBySession.get(sessionWindowKey);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    state.miniChatWindowsBySession.delete(sessionWindowKey);
  }

  const desktopLocalOrigin = state.localOrigin || '';
  const desktopApiBaseUrl = effectiveRuntimeConfig.apiBaseUrl || '';
  const desktopClientToken = effectiveRuntimeConfig.clientToken || '';
  const desktopRequestHeaders = effectiveRuntimeConfig.requestHeaders || {};
  const desktopHome = os.homedir() || '';
  const desktopMacosMajor = String(macosMajorVersion());
  const usesFramelessChrome = process.platform === 'win32' || process.platform === 'linux';
  // macOS vibrancy, on by default; users can disable it (Appearance settings).
  const useVibrancy = process.platform === 'darwin' && readSettingsRoot().desktopVibrancy !== false;
  const browserWindow = new BrowserWindow({
    title: 'OpenChamber Mini Chat',
    width: MINI_CHAT_WINDOW_WIDTH,
    height: MINI_CHAT_WINDOW_HEIGHT,
    minWidth: MINI_CHAT_MIN_WINDOW_WIDTH,
    minHeight: MINI_CHAT_MIN_WINDOW_HEIGHT,
    icon: getWindowIconPath(),
    show: false,
    backgroundColor: useVibrancy ? '#00000000' : '#151313',
    // Vibrancy is applied after the window is shown (see applyMacVibrancy), not
    // here: setting it in the constructor leaves the material uncomposited on a
    // cold launch until a window event. No `transparent: true` either — vibrancy
    // alone is enough and composites reliably once applied to a live window.
    frame: usesFramelessChrome ? false : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' || usesFramelessChrome ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      additionalArguments: buildDesktopAdditionalArguments({
        localOrigin: desktopLocalOrigin,
        homeDirectory: desktopHome,
        macosMajor: desktopMacosMajor,
      }),
      preload: isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // sandbox must stay off
      sandbox: false,
    },
  });
  browserWindow.__ocLabel = nextWindowLabel();
  browserWindow.__ocRuntimeConfig = effectiveRuntimeConfig;
  browserWindow.__ocInitScript = buildInitScript(desktopLocalOrigin, state.bootOutcome, desktopApiBaseUrl, desktopClientToken, desktopRequestHeaders);
  browserWindow.__ocMiniChat = true;
  browserWindow.__ocMiniChatSessionId = sessionWindowKey;
  browserWindow.__ocPinned = false;

  if (sessionWindowKey) {
    state.miniChatWindowsBySession.set(sessionWindowKey, browserWindow);
  }

  browserWindow.on('closed', () => {
    if (browserWindow.__ocMiniChatSessionId) {
      const existing = state.miniChatWindowsBySession.get(browserWindow.__ocMiniChatSessionId);
      if (existing?.id === browserWindow.id) {
        state.miniChatWindowsBySession.delete(browserWindow.__ocMiniChatSessionId);
      }
    }
  });

  if (process.platform === 'darwin') {
    const refreshTrafficLights = () => {
      if (browserWindow.isDestroyed()) return;
      try {
        browserWindow.setWindowButtonVisibility(true);
        browserWindow.setTrafficLightPosition({ x: 16, y: 17 });
      } catch {}
    };
    // Suppress vibrancy only around minimize/restore, never on a plain show.
    browserWindow.on('show', refreshTrafficLights);
    browserWindow.on('focus', refreshTrafficLights);
    browserWindow.on('minimize', () => setMacVibrancyReady(browserWindow, false));
    browserWindow.on('restore', () => scheduleMacVibrancyReady(browserWindow, 180));
  }

  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
    browserWindow.focus();
    if (useVibrancy) applyMacVibrancy(browserWindow);
  });

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const local = new URL(shouldUsePackagedUi() ? packagedUiOrigin() : (state.localOrigin || state.sidecarUrl || ''));
      if (target.origin === local.origin) return;
    } catch {
    }
    event.preventDefault();
    void shell.openExternal(url).catch(() => {});
  });
  browserWindow.webContents.on('dom-ready', () => {
    const initScript = browserWindow.__ocInitScript || state.initScript;
    if (initScript) {
      void browserWindow.webContents.executeJavaScript(initScript).catch(() => {});
    }
  });

  await navigateWindow(browserWindow, buildMiniChatUrl({ mode, sessionId, directory, projectId }));
  return browserWindow;
};

const setMiniChatPinned = (browserWindow, pinned) => {
  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error('Window is not available');
  }
  if (browserWindow.__ocMiniChat !== true) {
    throw new Error('Pinning is only available for Mini Chat windows');
  }
  const nextPinned = pinned === true;
  browserWindow.__ocPinned = nextPinned;
  if (nextPinned) {
    browserWindow.setAlwaysOnTop(true, 'floating');
  } else {
    browserWindow.setAlwaysOnTop(false);
    if (process.platform === 'darwin') {
      browserWindow.setVisibleOnAllWorkspaces(false);
    }
  }
  return { pinned: nextPinned };
};

const resolveMiniChatRuntimeConfig = (browserWindow, args = {}) => {
  const windowConfig = getWindowRuntimeConfig(browserWindow);
  const argApiBaseUrl = typeof args.apiBaseUrl === 'string' ? args.apiBaseUrl : '';
  const targetUrl = normalizeHostUrl(argApiBaseUrl || windowConfig.apiBaseUrl || state.apiBaseUrl || state.localOrigin || state.sidecarUrl || '');
  const providedToken = sanitizeClientTokenForStorage(args.clientToken);
  const storedToken = targetUrl ? resolveStoredClientTokenForUrl(targetUrl) : '';
  const windowToken = targetUrl && sameOrigin(windowConfig.apiBaseUrl, targetUrl) ? windowConfig.clientToken : '';
  const windowHeaders = targetUrl && sameOrigin(windowConfig.apiBaseUrl, targetUrl) ? windowConfig.requestHeaders : {};
  return {
    apiBaseUrl: targetUrl,
    clientToken: providedToken || windowToken || storedToken || '',
    requestHeaders: sanitizeRuntimeRequestHeaders(args.requestHeaders || windowHeaders || {}),
  };
};

const resolveInitialUrl = async () => {
  const hmrApiPort = process.env.OPENCHAMBER_HMR_API_PORT || '3901';
  const hmrUiPort = process.env.OPENCHAMBER_HMR_UI_PORT || '5173';
  const hmrApiUrl = `http://127.0.0.1:${hmrApiPort}`;
  const hmrUiUrl = `http://127.0.0.1:${hmrUiPort}`;
  const localUrl = isDev && await waitForHealth(hmrApiUrl, 5_000, 100)
    ? hmrApiUrl
    : await spawnLocalServer();

  const localUiUrl = shouldUsePackagedUi()
    ? buildPackagedUiUrl('/index.html')
    : isDev && await waitForHealth(hmrUiUrl, 8_000, 100)
    ? hmrUiUrl
    : localUrl;

  state.sidecarUrl = localUrl;
  const localAvailable = Boolean(localUrl);

  const localOrigin = new URL(localUrl).origin;
  let initialUrl = localUiUrl;
  let apiBaseUrl = localUrl;
  let clientToken = readDesktopLocalClientToken();
  let requestHeaders = {};
  let remoteProbe = null;

  const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
  const config = readDesktopHostsConfig();
  if (envTarget) {
    apiBaseUrl = envTarget;
    clientToken = '';
    requestHeaders = {};
    initialUrl = shouldUsePackagedUi() ? localUiUrl : envTarget;
  } else if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID) {
    const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
    if (host?.url) {
      apiBaseUrl = host.apiUrl || host.url;
      clientToken = host.clientToken || '';
      requestHeaders = sanitizeRuntimeRequestHeaders(host.requestHeaders || {});
      initialUrl = shouldUsePackagedUi() ? localUiUrl : host.url;
    }
  }

  if (apiBaseUrl && apiBaseUrl !== localUrl) {
    remoteProbe = await probeHostWithTimeout(apiBaseUrl, 2_000, clientToken, requestHeaders);
    if (remoteProbe.status === 'unreachable') {
      remoteProbe = await probeHostWithTimeout(apiBaseUrl, 10_000, clientToken, requestHeaders);
    }
    if (remoteProbe.status === 'unreachable') {
      state.unreachableHosts.add(apiBaseUrl);
      apiBaseUrl = localUrl;
      clientToken = readDesktopLocalClientToken();
      requestHeaders = {};
      initialUrl = localUiUrl;
    }
  }

  const bootOutcome = computeBootOutcome({
    envTargetUrl: envTarget || null,
    probe: remoteProbe,
    config,
    localAvailable,
  });

  return { initialUrl, localOrigin, localUiUrl, bootOutcome, apiBaseUrl, clientToken, requestHeaders };
};

const compareSemver = (left, right) => {
  const a = String(left || '').replace(/^v/, '').split('.').map((value) => Number.parseInt(value || '0', 10));
  const b = String(right || '').replace(/^v/, '').split('.').map((value) => Number.parseInt(value || '0', 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const setupAutoUpdater = () => {
  if (!app.isPackaged) {
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.fullChangelog = true;
  autoUpdater.disableWebInstaller = false;
  autoUpdater.logger = log;

  const testBuild = typeof __OPENCHAMBER_UPDATER_E2E_BUILD__ !== 'undefined'
    && __OPENCHAMBER_UPDATER_E2E_BUILD__ === true;
  const feed = resolveUpdaterFeed({ testBuild });
  autoUpdater.setFeedURL(feed);
  log.info('[electron] updater feed configured', {
    provider: feed.provider,
    target: feed.provider === 'github' ? `${feed.owner}/${feed.repo}` : feed.url,
  });

  autoUpdater.on('download-progress', (progress) => {
    const total = Number(progress.total || 0);
    const transferred = Number(progress.transferred || 0);
    setTaskbarProgress(total > 0 ? Math.max(0, Math.min(1, transferred / total)) : 0.01);
    emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
      event: 'Progress',
      data: {
        chunkLength: Math.max(0, Math.round(progress.bytesPerSecond || 0)),
        downloaded: Math.round(progress.transferred || 0),
        total: Math.round(progress.total || 0),
      },
    }));
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[electron] update-downloaded version=${info?.version || 'unknown'}`);
    setTaskbarProgress(-1);
    if (state.pendingUpdate) {
      state.pendingUpdate.downloaded = true;
    }
  });

  autoUpdater.on('error', (err) => {
    setTaskbarProgress(-1);
    log.error('[electron] autoUpdater error', err);
  });
};

const parseRelevantChangelogNotes = async (fromVersion, toVersion) => {
  try {
    const response = await fetch(CHANGELOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const changelog = await response.text();
    const sections = changelog.split(/^##\s+\[/m).slice(1);
    const relevant = [];
    for (const section of sections) {
      const version = section.split(']')[0];
      if (compareSemver(version, fromVersion) > 0 && compareSemver(version, toVersion) <= 0) {
        relevant.push(`## [${section}`.trim());
      }
    }
    return relevant.length > 0 ? relevant.join('\n\n') : null;
  } catch {
    return null;
  }
};

const buildInstalledAppsCachePath = () => path.join(path.dirname(settingsFilePath()), INSTALLED_APPS_CACHE_FILE);

// Async variants. sips + mdfind via spawnSync blocked the Electron main event
// loop for 2-3s on boot (22 OPEN_IN_APPS × ~200 ms each). Use execFile promises
// so each child-process wait yields to the loop and the UI stays responsive.
const pathExists = async (candidate) => {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const resolveAppBundlePath = async (appName) => {
  if (process.platform !== 'darwin') return null;
  const bundleName = appName.endsWith('.app') ? appName : `${appName}.app`;
  const candidates = [
    `/Applications/${bundleName}`,
    `/System/Applications/${bundleName}`,
    `/System/Applications/Utilities/${bundleName}`,
    path.join(os.homedir(), 'Applications', bundleName),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync('mdfind', ['-name', bundleName], { encoding: 'utf8' });
    const first = (stdout || '').split('\n').map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
};

const isAppBundleInstalled = async (appName) => Boolean(await resolveAppBundlePath(appName));

const iconToDataUrl = async (iconPath, appName) => {
  if (!iconPath || !(await pathExists(iconPath))) return null;
  const safeName = String(appName || 'app').replace(/[^a-z0-9]/gi, '_');
  const tempPath = path.join(os.tmpdir(), `openchamber-icon-${safeName}-${Date.now()}.png`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '32', iconPath, '--out', tempPath], { stdio: 'ignore' });
  } catch {
    return null;
  }
  if (!(await pathExists(tempPath))) return null;
  try {
    const bytes = await fsp.readFile(tempPath);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
};

const resolveAppIconPath = async (appPath) => {
  if (!appPath || !(await pathExists(appPath))) return null;
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  if (!(await pathExists(resourcesPath))) return null;
  let entries;
  try {
    entries = await fsp.readdir(resourcesPath);
  } catch {
    return null;
  }
  const icon = entries.find((entry) => entry.toLowerCase().endsWith('.icns'));
  return icon ? path.join(resourcesPath, icon) : null;
};

const buildInstalledApps = async (apps) => {
  const seen = new Set();
  const names = apps
    .map((raw) => String(raw || '').trim())
    .filter((raw) => raw && !seen.has(raw) && seen.add(raw));
  const results = [];
  for (const name of names) {
    const appPath = await resolveAppBundlePath(name);
    if (!appPath) continue;
    const iconDataUrl = await iconToDataUrl(await resolveAppIconPath(appPath), name);
    results.push({ name, iconDataUrl });
  }
  return results;
};

const parseSshConfigImports = () => {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(sshConfigPath)) return [];
  const lines = fs.readFileSync(sshConfigPath, 'utf8').split(/\r?\n/);
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.toLowerCase().startsWith('host ')) {
      continue;
    }
    const hosts = trimmed.slice(5).trim().split(/\s+/).filter(Boolean);
    for (const host of hosts) {
      results.push({
        host,
        pattern: /[*?]/.test(host),
        source: sshConfigPath,
        sshCommand: `ssh ${host}`,
      });
    }
  }
  return results;
};

const readDesktopSshInstances = () => {
  const root = readSettingsRoot();
  return { instances: Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [] };
};

const writeDesktopSshInstances = async (config) => {
  const nextInstances = Array.isArray(config?.instances) ? config.instances : [];
  await mutateSettingsRoot((root) => {
    root.desktopSshInstances = nextInstances;
  });
  return { instances: nextInstances };
};

const updateHostUrlForSshInstance = async (id, label, localUrl) => {
  const config = readDesktopHostsConfig();
  const nextHosts = config.hosts.filter((entry) => entry.id !== id);
  nextHosts.push({ id, label, url: localUrl });
  await writeDesktopHostsConfig({ hosts: nextHosts, defaultHostId: config.defaultHostId });
};

const JETBRAINS_APP_IDS = new Set([
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rider',
  'rustrover',
  'android-studio',
]);

const CLI_BY_APP_ID = {
  vscode: 'code',
  cursor: 'cursor',
  vscodium: 'codium',
  windsurf: 'windsurf',
  zed: 'zed',
};

const WINDOWS_CLI_BY_APP_ID = {
  vscode: 'code.cmd',
  cursor: 'cursor.cmd',
  vscodium: 'codium.cmd',
  windsurf: 'windsurf.cmd',
  zed: 'zed.cmd',
};

const WINDOWS_APP_EXECUTABLES = {
  terminal: ['wt.exe', 'WindowsTerminal.exe'],
  vscode: ['code.exe', 'code.cmd'],
  cursor: ['cursor.exe', 'cursor.cmd'],
  vscodium: ['codium.exe', 'codium.cmd'],
  windsurf: ['windsurf.exe', 'windsurf.cmd'],
  zed: ['zed.exe', 'zed.cmd'],
  'visual-studio': ['devenv.exe'],
  'sublime-text': ['subl.exe', 'sublime_text.exe'],
};

const WINDOWS_APP_ID_BY_NAME = new Map([
  ['finder', 'finder'],
  ['file explorer', 'finder'],
  ['terminal', 'terminal'],
  ['windows terminal', 'terminal'],
  ['visual studio code', 'vscode'],
  ['cursor', 'cursor'],
  ['vscodium', 'vscodium'],
  ['windsurf', 'windsurf'],
  ['zed', 'zed'],
  ['visual studio', 'visual-studio'],
  ['sublime text', 'sublime-text'],
]);

const getWindowsAppIdForName = (appName) => WINDOWS_APP_ID_BY_NAME.get(String(appName || '').trim().toLowerCase()) || '';

const runWhere = (program) => {
  const result = spawnSync('where.exe', [program], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const first = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
};

const findWindowsExecutable = (appId) => {
  for (const program of WINDOWS_APP_EXECUTABLES[appId] || []) {
    const resolved = runWhere(program);
    if (resolved) return resolved;
  }
  return null;
};

const resolveWindowsScriptIconExecutable = (scriptPath) => {
  if (!scriptPath || !/\.(?:cmd|bat)$/i.test(scriptPath)) return null;
  let source = '';
  try {
    source = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return null;
  }
  const scriptDir = path.dirname(scriptPath);
  const matches = [...source.matchAll(/(?:(?:%~dp0|%~dp0\\|%~dp0\/|\.\.\\|\.\.\/|[A-Za-z]:\\|[A-Za-z]:\/)[^"'\r\n]*?\.exe)/gi)];
  for (const match of matches) {
    const raw = String(match[0] || '').replace(/^%~dp0[\\/]?/i, '').trim();
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(scriptDir, raw);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

let windowsTerminalPackagePathCache;

const resolveWindowsTerminalPackagePath = () => {
  if (windowsTerminalPackagePathCache !== undefined) return windowsTerminalPackagePathCache;

  const powershell = runWhere('powershell.exe') || runWhere('pwsh.exe');
  if (powershell) {
    const command = '$packages = @(' +
      'Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue;' +
      'Get-AppxPackage -Name Microsoft.WindowsTerminalPreview -ErrorAction SilentlyContinue' +
      ') | Where-Object { $_.InstallLocation } | Sort-Object Version -Descending; ' +
      'if ($packages) { $packages[0].InstallLocation }';
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      const packagePath = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (packagePath && fs.existsSync(packagePath)) {
        windowsTerminalPackagePathCache = packagePath;
        return windowsTerminalPackagePathCache;
      }
    }
  }

  const programFilesRoots = [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files']
    .filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
  for (const root of programFilesRoots) {
    const windowsAppsPath = path.join(root, 'WindowsApps');
    let entries = [];
    try {
      entries = fs.readdirSync(windowsAppsPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const packageNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^Microsoft\.WindowsTerminal(?:Preview)?_.*__8wekyb3d8bbwe$/i.test(name))
      .sort()
      .reverse();
    const stable = packageNames.find((name) => /^Microsoft\.WindowsTerminal_/i.test(name));
    const selected = stable || packageNames[0];
    if (selected) {
      windowsTerminalPackagePathCache = path.join(windowsAppsPath, selected);
      return windowsTerminalPackagePathCache;
    }
  }

  windowsTerminalPackagePathCache = null;
  return windowsTerminalPackagePathCache;
};

const resolveWindowsTerminalIconPath = () => {
  const packagePath = resolveWindowsTerminalPackagePath();
  if (!packagePath) return null;
  const candidates = [
    path.join(packagePath, 'Images', 'Square44x44Logo.targetsize-96_altform-unplated.png'),
    path.join(packagePath, 'Images', 'Square44x44Logo.targetsize-96.png'),
    path.join(packagePath, 'Images', 'StoreLogo.scale-200.png'),
    path.join(packagePath, 'Images', 'StoreLogo.scale-100.png'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

const resolveWindowsTerminalExecutable = () => {
  const packagePath = resolveWindowsTerminalPackagePath();
  if (packagePath) {
    const executable = path.join(packagePath, 'WindowsTerminal.exe');
    if (fs.existsSync(executable)) return executable;
  }
  return findWindowsExecutable('terminal');
};

const imageFileToDataUrl = (filePath) => {
  if (!filePath) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return null;
  }
};

const resolveWindowsAppIconExecutable = ({ appId, appName }) => {
  if (appId === 'finder') {
    const explorerPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    return fs.existsSync(explorerPath) ? explorerPath : 'explorer.exe';
  }
  if (appId === 'terminal') {
    return resolveWindowsTerminalExecutable();
  }

  const executable = findWindowsExecutable(appId) || findWindowsAppNameExecutable(appName);
  if (!executable) return null;
  if (/\.exe$/i.test(executable)) return executable;
  return resolveWindowsScriptIconExecutable(executable) || executable;
};

const windowsIconToDataUrl = async (executablePath) => {
  if (!executablePath) return null;
  try {
    const image = await app.getFileIcon(executablePath, { size: 'normal' });
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch {
    return null;
  }
};

const findWindowsAppNameExecutable = (appName) => {
  const program = `${String(appName || '').trim()}.exe`.replace(/\s+/g, '');
  return program === '.exe' ? null : runWhere(program);
};

const isWindowsAppInstalled = ({ appId, appName }) => {
  if (appId === 'finder') return true;
  if (appId === 'terminal') return Boolean(findWindowsExecutable('terminal'));
  if (findWindowsExecutable(appId)) return true;
  return Boolean(findWindowsAppNameExecutable(appName));
};

const buildWindowsInstalledApps = async (apps) => {
  const seen = new Set();
  const names = (Array.isArray(apps) ? apps : [])
    .map((appName) => String(appName || '').trim())
    .filter((appName) => appName && !seen.has(appName) && seen.add(appName))
    .filter((appName) => isWindowsAppInstalled({ appId: getWindowsAppIdForName(appName), appName }));
  const results = [];
  for (const name of names) {
    const appId = getWindowsAppIdForName(name);
    const executablePath = resolveWindowsAppIconExecutable({ appId, appName: name });
    const iconDataUrl = appId === 'terminal'
      ? imageFileToDataUrl(resolveWindowsTerminalIconPath()) || await windowsIconToDataUrl(executablePath)
      : await windowsIconToDataUrl(executablePath);
    results.push({ name, iconDataUrl });
  }
  return results;
};

const buildWindowsOpenProjectSpecs = ({ projectPath, appId, appName }) => {
  if (appId === 'finder') {
    return [{ program: 'explorer.exe', args: [projectPath] }];
  }
  if (appId === 'terminal') {
    const specs = [];
    const terminal = findWindowsExecutable('terminal');
    if (terminal) {
      specs.push({ program: terminal, args: ['-d', projectPath] });
    }
    const shell = runWhere('pwsh.exe') || runWhere('powershell.exe');
    if (shell) {
      specs.push({ program: shell, args: ['-NoExit', '-Command', `Set-Location -LiteralPath ${JSON.stringify(projectPath)}`], shellStart: true });
    }
    const commandPrompt = process.env.ComSpec || runWhere('cmd.exe');
    if (commandPrompt) {
      specs.push({ program: commandPrompt, args: ['/k', 'cd', '/d', projectPath], shellStart: true });
    }
    return specs;
  }
  const specs = [];
  const cli = WINDOWS_CLI_BY_APP_ID[appId];
  if (cli) {
    const resolvedCli = runWhere(cli);
    if (resolvedCli) {
      specs.push({ program: resolvedCli, args: [projectPath] });
    }
  }
  const exe = findWindowsExecutable(appId);
  if (exe) {
    specs.push({ program: exe, args: [projectPath] });
  }
  const namedExe = findWindowsAppNameExecutable(appName);
  if (namedExe && !specs.some((spec) => spec.program === namedExe)) {
    specs.push({ program: namedExe, args: [projectPath] });
  }
  return specs;
};

const buildWindowsOpenFileSpecs = ({ filePath, appId, appName }) => {
  if (appId === 'finder') {
    return [{ program: 'explorer.exe', args: ['/select,', filePath] }];
  }
  if (appId === 'terminal') {
    return buildWindowsOpenProjectSpecs({ projectPath: path.dirname(filePath), appId, appName });
  }
  const specs = [];
  const cli = WINDOWS_CLI_BY_APP_ID[appId];
  if (cli) {
    const resolvedCli = runWhere(cli);
    if (resolvedCli) {
      specs.push({ program: resolvedCli, args: [filePath] });
    }
  }
  const exe = findWindowsExecutable(appId);
  if (exe) {
    specs.push({ program: exe, args: [filePath] });
  }
  const namedExe = findWindowsAppNameExecutable(appName);
  if (namedExe && !specs.some((spec) => spec.program === namedExe)) {
    specs.push({ program: namedExe, args: [filePath] });
  }
  return specs;
};

const buildOpenProjectSpecs = ({ projectPath, appId, appName }) => {
  if (appId === 'finder') {
    return [{ program: 'open', args: [projectPath] }];
  }

  if (appId === 'terminal' || appId === 'iterm2' || appId === 'ghostty') {
    return [{ program: 'open', args: ['-a', appName, projectPath] }];
  }

  const specs = [];

  const cli = CLI_BY_APP_ID[appId];
  if (cli) {
    specs.push({ program: cli, args: ['-n', projectPath] });
  }

  if (JETBRAINS_APP_IDS.has(appId)) {
    specs.push({ program: 'open', args: ['-na', appName, '--args', projectPath] });
  }

  specs.push({ program: 'open', args: ['-a', appName, projectPath] });
  return specs;
};

const buildOpenFileSpecs = ({ filePath, appId, appName }) => {
  if (appId === 'finder') {
    return [{ program: 'open', args: ['-R', filePath] }];
  }

  const parentDir = path.dirname(filePath);
  if (appId === 'terminal' || appId === 'iterm2' || appId === 'ghostty') {
    return [{ program: 'open', args: ['-a', appName, parentDir] }];
  }

  const specs = [];

  const cli = CLI_BY_APP_ID[appId];
  if (cli) {
    specs.push({ program: cli, args: [filePath] });
  }

  specs.push({ program: 'open', args: ['-a', appName, filePath] });
  return specs;
};

const quoteWindowsCommandArg = (value) => `"${String(value).replace(/"/g, '""')}"`;

const resolveWindowsLaunchProgram = (program) => {
  if (path.isAbsolute(program)) {
    return fs.existsSync(program) ? program : null;
  }
  return runWhere(program);
};

const launchWindowsCommandScript = (spec, program) => {
  const commandLine = ['call', quoteWindowsCommandArg(program), ...spec.args.map(quoteWindowsCommandArg)].join(' ');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
  child.unref();
};

const launchWindowsSpec = (spec) => {
  const program = resolveWindowsLaunchProgram(spec.program);
  if (!program) {
    throw new Error('program not found');
  }

  if (spec.shellStart) {
    const commandLine = ['start', '""', quoteWindowsCommandArg(program), ...spec.args.map(quoteWindowsCommandArg)].join(' ');
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }

  if (/\.(cmd|bat)$/i.test(program)) {
    launchWindowsCommandScript(spec, program);
    return;
  }

  const child = spawn(program, spec.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
};

const runSpecChain = (specs, appName) => {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(`Failed to open in ${appName}: no launch candidates`);
  }

  if (process.platform === 'win32') {
    const failures = [];
    for (const spec of specs) {
      try {
        launchWindowsSpec(spec);
        return;
      } catch (error) {
        failures.push(`${spec.program}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
  }

  const failures = [];
  for (const spec of specs) {
    const result = spawnSync(spec.program, spec.args, { stdio: 'ignore', windowsHide: true });
    if (result.error) {
      failures.push(`${spec.program}: ${result.error.message}`);
      continue;
    }
    if (result.status === 0) {
      return;
    }
    failures.push(`${spec.program} exited ${result.status}`);
  }
  throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
};

const handleInvoke = async (browserWindow, command, args = {}) => {
  switch (command) {
    case 'desktop_start_window_drag':
      return null;

    case 'desktop_is_window_fullscreen':
      return Boolean(browserWindow?.isFullScreen());

    case 'desktop_set_window_title':
      if (browserWindow && typeof args.title === 'string') {
        browserWindow.setTitle(args.title);
      }
      return null;

    case 'desktop_get_app_version':
      return APP_VERSION;

    case 'desktop_get_launch_at_login': {
      if (process.platform !== 'darwin' && process.platform !== 'win32') return { supported: false, enabled: false };
      const settings = app.getLoginItemSettings(getLoginItemOptions());
      return { supported: true, enabled: settings.openAtLogin === true };
    }

    case 'desktop_set_launch_at_login': {
      if (process.platform !== 'darwin' && process.platform !== 'win32') return { supported: false, enabled: false };
      const enabled = args.enabled === true;
      const settingsArgs = {
        openAtLogin: enabled,
        ...(process.platform === 'darwin' ? { openAsHidden: enabled } : {}),
        ...(process.platform === 'win32' ? getLoginItemOptions() : { args: enabled ? [BACKGROUND_START_ARG] : [] }),
        ...(process.platform === 'win32' ? { enabled } : {}),
      };
      app.setLoginItemSettings(settingsArgs);
      const settings = app.getLoginItemSettings(getLoginItemOptions());
      return { supported: true, enabled: settings.openAtLogin === true };
    }

    case 'desktop_get_minimize_to_tray': {
      return readDesktopMinimizeToTrayStatus();
    }

    case 'desktop_set_minimize_to_tray': {
      if (process.platform !== 'win32') return { supported: false, enabled: false };
      const enabled = args.enabled === true;
      await mutateSettingsRoot((root) => {
        root.desktopMinimizeToTrayEnabled = enabled;
      });
      setupTray();
      return readDesktopMinimizeToTrayStatus();
    }

    case 'desktop_get_keep_awake': {
      return readDesktopKeepAwakeStatus();
    }

    case 'desktop_set_keep_awake': {
      const enabled = args.enabled === true;
      await mutateSettingsRoot((root) => {
        root.desktopKeepAwakeEnabled = enabled;
      });
      const active = setDesktopKeepAwakeActive(enabled);
      return { supported: true, enabled, active };
    }

    case 'desktop_browser_capture_page': {
      const wcId = Number.isFinite(args.webContentsId) ? Math.trunc(args.webContentsId) : null;
      if (wcId === null || wcId < 0) throw new Error('webContentsId is required');
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) throw new Error('WebContents not found');
      const image = await wc.capturePage();
      const buffer = image.toJPEG(82);
      return {
        mime: 'image/jpeg',
        base64: buffer.toString('base64'),
        width: image.getSize().width,
        height: image.getSize().height,
      };
    }

    case 'desktop_capture_page_rect': {
      if (!browserWindow || browserWindow.isDestroyed()) {
        throw new Error('Window is not available');
      }

      const bounds = browserWindow.getContentBounds();
      const x = Number.isFinite(args.x) ? Math.max(0, Math.floor(args.x)) : 0;
      const y = Number.isFinite(args.y) ? Math.max(0, Math.floor(args.y)) : 0;
      const width = Number.isFinite(args.width) ? Math.max(1, Math.floor(args.width)) : 1;
      const height = Number.isFinite(args.height) ? Math.max(1, Math.floor(args.height)) : 1;
      const clampedX = Math.min(x, Math.max(0, bounds.width - 1));
      const clampedY = Math.min(y, Math.max(0, bounds.height - 1));
      const rect = {
        x: clampedX,
        y: clampedY,
        width: Math.min(width, Math.max(1, bounds.width - clampedX)),
        height: Math.min(height, Math.max(1, bounds.height - clampedY)),
      };
      if (rect.width * rect.height > MAX_CAPTURE_PAGE_RECT_AREA) {
        throw new Error('Capture area is too large');
      }

      const image = await browserWindow.webContents.capturePage(rect);
      const buffer = image.toJPEG(82);
      return {
        mime: 'image/jpeg',
        base64: buffer.toString('base64'),
        width: image.getSize().width,
        height: image.getSize().height,
      };
    }

    case 'desktop_save_markdown_file': {
      const defaultPath = typeof args.defaultFileName === 'string' ? args.defaultFileName.trim() : '';
      if (!defaultPath) {
        throw new Error('Default file name is required');
      }

      const content = typeof args.content === 'string' ? args.content : '';
      const result = await dialog.showSaveDialog(browserWindow || undefined, {
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }

      await fsp.writeFile(result.filePath, content, 'utf8');
      return result.filePath;
    }

    case 'desktop_read_file': {
      const rawPath = typeof args.path === 'string' ? args.path : '';
      if (!rawPath) throw new Error('Path is required');
      // Defense in depth behind the IPC origin gate: even our own UI (or a
      // prompt-injected agent) can't read credential stores. Resolve the
      // path, require it under $HOME or tmpdir, and refuse known secret dirs
      // / dotfiles commonly holding keys.
      const filePath = path.resolve(rawPath);
      const home = os.homedir() || '';
      const tmp = os.tmpdir() || '';
      const underHome = home && (filePath === home || filePath.startsWith(home + path.sep));
      const underTmp = tmp && (filePath === tmp || filePath.startsWith(tmp + path.sep));
      if (!underHome && !underTmp) {
        throw new Error('File is outside the allowed workspace');
      }
      const DENIED_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.gpg', '.config/gh', '.config/openchamber/credentials'];
      const relFromHome = underHome ? filePath.slice(home.length + 1) : '';
      const relNormalized = relFromHome.split(path.sep).join('/');
      if (DENIED_SEGMENTS.some((segment) => relNormalized === segment || relNormalized.startsWith(`${segment}/`))) {
        throw new Error('Access to this path is not allowed');
      }
      const basename = path.basename(filePath).toLowerCase();
      if (basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.pem') || basename.endsWith('.key')) {
        throw new Error('Access to this path is not allowed');
      }
      const stats = await fsp.stat(filePath);
      if (stats.size > 50 * 1024 * 1024) {
        throw new Error('File is too large. Maximum size is 50MB.');
      }
      const bytes = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.tsx': 'text/typescript-jsx',
        '.jsx': 'text/javascript-jsx',
        '.html': 'text/html',
        '.css': 'text/css',
        '.py': 'text/x-python',
      })[ext] || 'application/octet-stream';
      return { mime, base64: bytes.toString('base64'), size: bytes.length };
    }

    case 'desktop_notify':
      maybeShowNativeNotification(args);
      return null;

    case 'desktop_tray_update':
      if (state.trayController) {
        try {
          state.trayController.update(args || {});
        } catch (error) {
          log.warn('[electron] tray update failed', error);
        }
      }
      // Dock badge: count of chats with unseen activity (0 = cleared, also when
      // the user disabled the badge). setBadgeCount drives the macOS dock badge.
      try {
        const rawCount = args && typeof args.dockBadgeCount === 'number' ? args.dockBadgeCount : 0;
        const badgeCount = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0;
        if (typeof app.setBadgeCount === 'function') {
          app.setBadgeCount(badgeCount);
        }
      } catch (error) {
        log.warn('[electron] dock badge update failed', error);
      }
      return null;

    case 'desktop_clear_cache':
      await session.defaultSession.clearStorageData();
      for (const browserWindow of BrowserWindow.getAllWindows()) {
        browserWindow.webContents.reload();
      }
      return null;

    case 'desktop_open_path': {
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      const appName = typeof args.app === 'string' ? args.app.trim() : '';
      if (!targetPath) throw new Error('Path is required');
      if (process.platform === 'darwin') {
        const openArgs = appName ? ['-a', appName, targetPath] : [targetPath];
        spawn('open', openArgs, { detached: true, stdio: 'ignore' }).unref();
        return null;
      }
      await shell.openPath(targetPath);
      return null;
    }

    case 'desktop_open_external_url': {
      const target = typeof args.url === 'string' ? args.url.trim() : '';
      if (!target) throw new Error('URL is required');

      const parsed = new URL(target);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTP URLs can be opened externally');
      }

      await shell.openExternal(parsed.toString());
      return null;
    }

    case 'desktop_reveal_path': {
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!targetPath) {
        throw new Error('Path is required');
      }

      const stats = await fsp.stat(targetPath).catch(() => null);
      if (stats?.isDirectory()) {
        await shell.openPath(targetPath);
        return null;
      }

      shell.showItemInFolder(targetPath);
      return null;
    }

    case 'desktop_open_in_app': {
      const projectPath = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!projectPath || !appId || !appName) {
        throw new Error('Project path, app id, and app name are required');
      }
      if (process.platform === 'win32') {
        if (appId === 'finder') {
          const error = await shell.openPath(projectPath);
          if (error) throw new Error(error);
          return null;
        }
        runSpecChain(buildWindowsOpenProjectSpecs({ projectPath, appId, appName }), appName);
        return null;
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_open_in_app is only supported on macOS and Windows');
      }
      runSpecChain(buildOpenProjectSpecs({ projectPath, appId, appName }), appName);
      return null;
    }

    case 'desktop_open_file_in_app': {
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!filePath || !appId || !appName) {
        throw new Error('File path, app id, and app name are required');
      }
      if (process.platform === 'win32') {
        runSpecChain(buildWindowsOpenFileSpecs({ filePath, appId, appName }), appName);
        return null;
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_open_file_in_app is only supported on macOS and Windows');
      }
      runSpecChain(buildOpenFileSpecs({ filePath, appId, appName }), appName);
      return null;
    }

    case 'desktop_filter_installed_apps': {
      if (process.platform === 'win32') {
        return (await buildWindowsInstalledApps(args.apps)).map((app) => app.name);
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_filter_installed_apps is only supported on macOS');
      }
      if (!Array.isArray(args.apps)) return [];
      const results = await Promise.all(
        args.apps.map(async (appName) => (await isAppBundleInstalled(String(appName))) ? String(appName) : null)
      );
      return results.filter(Boolean);
    }

    case 'desktop_fetch_app_icons': {
      if (process.platform === 'win32') {
        const names = Array.isArray(args.apps) ? args.apps : [];
        const results = [];
        for (const name of names) {
          const appName = String(name || '').trim();
          if (!appName) continue;
          const appId = getWindowsAppIdForName(appName);
          const dataUrl = appId === 'terminal'
            ? imageFileToDataUrl(resolveWindowsTerminalIconPath()) || await windowsIconToDataUrl(resolveWindowsAppIconExecutable({ appId, appName }))
            : await windowsIconToDataUrl(resolveWindowsAppIconExecutable({ appId, appName }));
          if (dataUrl) results.push({ app: appName, data_url: dataUrl });
        }
        return results;
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_fetch_app_icons is only supported on macOS');
      }
      const names = Array.isArray(args.apps) ? args.apps : [];
      const results = [];
      for (const name of names) {
        const appPath = await resolveAppBundlePath(String(name));
        if (!appPath) continue;
        const dataUrl = await iconToDataUrl(await resolveAppIconPath(appPath), String(name));
        if (dataUrl) results.push({ app: String(name), dataUrl });
      }
      return results;
    }

    case 'desktop_get_installed_apps': {
      const cachePath = buildInstalledAppsCachePath();
      const now = Math.floor(Date.now() / 1000);
      let cache = null;
      try {
        cache = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      } catch {
      }
      const cachedApps = Array.isArray(cache?.apps) ? cache.apps : [];
      const hasCache = Boolean(cache);
      const isCacheStale = !cache || (now - Number(cache.updatedAt || 0)) > INSTALLED_APPS_CACHE_TTL_SECS;
      const refresh = async () => {
        const apps = process.platform === 'win32'
          ? await buildWindowsInstalledApps(args.apps)
          : await buildInstalledApps(Array.isArray(args.apps) ? args.apps : []);
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, JSON.stringify({ updatedAt: now, apps }, null, 2));
        emitToAllWindows('openchamber:installed-apps-updated', apps);
      };
      if (process.platform !== 'darwin' && process.platform !== 'win32') {
        return { apps: [], hasCache: false, isCacheStale: false, supported: false };
      }
      if (!hasCache || isCacheStale || args.force === true) {
        void refresh();
      }
      return { apps: cachedApps, hasCache, isCacheStale };
    }

    case 'desktop_hosts_get':
      return {
        ...readDesktopHostsConfig(),
        localOrigin: state.localOrigin || state.sidecarUrl || null,
      };

    case 'desktop_hosts_set': {
      const nextConfigInput = args.input || args.config || {};
      await writeDesktopHostsConfig(nextConfigInput);
      const updatedConfig = readDesktopHostsConfig();
      const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
      if (Object.prototype.hasOwnProperty.call(nextConfigInput, 'localClientToken') && isLocalRuntimeUrl(state.apiBaseUrl || state.sidecarUrl || state.localOrigin || '')) {
        state.clientToken = readDesktopLocalClientToken();
      }
      state.bootOutcome = computeBootOutcome({
        envTargetUrl: envTarget || null,
        probe: null,
        config: updatedConfig,
        localAvailable: Boolean(state.sidecarUrl || state.localOrigin),
      });
      state.initScript = buildInitScript(state.localOrigin, state.bootOutcome, state.apiBaseUrl, state.clientToken, state.requestHeaders || {});
      log.info('[electron] hosts config updated, recomputed bootOutcome', state.bootOutcome);
      return null;
    }

    case 'desktop_local_client_token_get':
      return readDesktopLocalClientToken();

    case 'desktop_install_id_get':
      return getOrCreateDesktopInstallId();

    case 'desktop_host_probe':
      return probeHostWithTimeout(String(args.url || ''), 2_000, String(args.clientToken || ''), args.requestHeaders || {}, String(args.expectedServerId || ''));

    case 'desktop_remote_password_login':
      return loginRemoteAndIssueClientToken({
        url: args.url,
        password: args.password,
        trustDevice: args.trustDevice === true,
        requestHeaders: args.requestHeaders || {},
      });

    case 'desktop_set_window_theme': {
      const mode = typeof args.themeMode === 'string' ? args.themeMode : '';
      const variant = typeof args.themeVariant === 'string' ? args.themeVariant : '';
      // Priority order: themeMode expresses the user's intent (including
      // "follow OS"). Variant is just the resolved variant at send time;
      // when mode === 'system' with variant === 'dark' (because OS is
      // currently dark), we must still pin themeSource to 'system' so
      // Chromium keeps reacting to OS theme changes.
      if (mode === 'system') {
        nativeTheme.themeSource = 'system';
      } else if (mode === 'light') {
        nativeTheme.themeSource = 'light';
      } else if (mode === 'dark') {
        nativeTheme.themeSource = 'dark';
      } else if (variant === 'light') {
        nativeTheme.themeSource = 'light';
      } else if (variant === 'dark') {
        nativeTheme.themeSource = 'dark';
      } else {
        nativeTheme.themeSource = 'system';
      }
      if (canUseTitleBarOverlay(browserWindow)) {
        const useDark = nativeTheme.shouldUseDarkColors;
        browserWindow.setTitleBarOverlay({
          color: useDark ? '#151313' : '#f5f5f4',
          symbolColor: useDark ? '#fafaf9' : '#1c1917',
          height: 48,
        });
      }
      return null;
    }

    case 'desktop_set_vibrancy': {
      // Vibrancy + transparent backing are window-creation options, so the
      // change only takes effect on a fresh launch. Persist the preference,
      // then relaunch the app.
      const enabled = args.enabled === true;
      await mutateSettingsRoot((root) => {
        root.desktopVibrancy = enabled;
      });
      setImmediate(() => {
        try {
          prepareForQuit();
          app.relaunch();
          app.exit(0);
        } catch (err) {
          log.error('[electron] desktop_set_vibrancy relaunch failed', err);
        }
      });
      return { enabled, requiresRestart: true };
    }

    case 'desktop_check_for_updates': {
      assertUpdaterCapability({ packaged: app.isPackaged });
      const currentVersion = APP_VERSION;
      const { available, updateInfo, updateResult, nextVersion, pendingUpdate } = await checkForDesktopUpdate({
        autoUpdater,
        currentVersion,
        pendingUpdate: state.pendingUpdate,
        compareVersions: compareSemver,
      });
      const body =
        (typeof updateInfo?.releaseNotes === 'string' && updateInfo.releaseNotes.trim() ? updateInfo.releaseNotes : null) ||
        await parseRelevantChangelogNotes(currentVersion, nextVersion);
      state.pendingUpdate = pendingUpdate;
      return {
        available,
        currentVersion,
        version: available ? nextVersion : null,
        body: body || null,
        date:
          (typeof updateInfo?.releaseDate === 'string' && updateInfo.releaseDate) ||
          null,
      };
    }

    case 'desktop_download_and_install_update':
      assertUpdaterCapability({ packaged: app.isPackaged });
      if (!state.pendingUpdate) {
        throw new Error('No pending update');
      }
      setTaskbarProgress(0.01);
      emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
        event: 'Started',
        data: {
          contentLength: null,
        },
      }));
      try {
        if (!state.pendingUpdate.electronUpdate) {
          throw new Error('Electron updater metadata is not available for this build');
        }
        if (!state.pendingUpdate.downloaded) {
          await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
              autoUpdater.off('update-downloaded', onDownloaded);
              autoUpdater.off('error', onError);
            };
            const finish = (callback, value) => {
              if (settled) return;
              settled = true;
              cleanup();
              callback(value);
            };
            const onDownloaded = () => finish(resolve, null);
            const onError = (error) => finish(reject, error);
            autoUpdater.on('update-downloaded', onDownloaded);
            autoUpdater.on('error', onError);
            Promise.resolve(autoUpdater.downloadUpdate()).catch((error) => finish(reject, error));
          });
        }
        emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
          event: 'Finished',
          data: {},
        }));
        return null;
      } finally {
        setTaskbarProgress(-1);
      }

    case 'desktop_restart': {
      const applyUpdate = Boolean(state.pendingUpdate?.downloaded && app.isPackaged);
      if (applyUpdate) assertUpdaterCapability({ packaged: app.isPackaged });
      log.info(`[electron] desktop_restart applyUpdate=${applyUpdate} packaged=${app.isPackaged}`);
      if (applyUpdate && process.platform === 'darwin' && typeof app.isInApplicationsFolder === 'function') {
        try {
          if (!app.isInApplicationsFolder()) {
            throw new Error('Desktop update requires OpenChamber.app to be installed in /Applications');
          }
        } catch (error) {
          log.warn('[electron] desktop_restart blocked', error);
          throw error;
        }
      }
      if (applyUpdate) {
        // Match the working updater pattern closely: only bypass the macOS
        // hide-on-close / quit-confirmation guards, leave the rest of the
        // updater-driven quit/install sequence alone.
        state.quitRequested = true;
        state.installingUpdate = true;
        state.quitConfirmationPending = false;
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          try {
            debounceWindowStatePersist(state.mainWindow, true);
          } catch {
          }
        }
      }
      // Defer so the IPC reply flushes before the app starts shutting down.
      // Without this, quitAndInstall() can race with the renderer's pending
      // invoke and the restart appears to do nothing from the UI side.
      setImmediate(() => {
        try {
          if (applyUpdate) {
            killSidecar();
            autoUpdater.quitAndInstall();
          } else {
            prepareForQuit();
            app.relaunch();
            app.exit(0);
          }
        } catch (err) {
          log.error('[electron] desktop_restart failed', err);
        }
      });
      return null;
    }

    case 'desktop_get_lan_address':
      return await detectLanIPv4Address();

    case 'desktop_new_window': {
      const config = readDesktopHostsConfig();
      const localUiUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
      let targetUrl = localUiUrl;
      let runtimeConfig = {
        apiBaseUrl: state.sidecarUrl || state.localOrigin || '',
        clientToken: readDesktopLocalClientToken(),
        requestHeaders: {},
      };
      if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID) {
        const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
        const apiUrl = host?.apiUrl || host?.url;
        if (host?.url && apiUrl && !state.unreachableHosts.has(apiUrl)) {
          targetUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : host.url;
          runtimeConfig = {
            apiBaseUrl: normalizeHostUrl(apiUrl),
            clientToken: sanitizeClientTokenForStorage(host.clientToken),
            requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders),
          };
        }
      }
      await createAdditionalWindow(targetUrl, runtimeConfig);
      return null;
    }

    case 'desktop_new_window_for_host': {
      // Open a saved host in a new window. Hosts with a relay leg boot the
      // LOCAL UI and let the renderer pick the transport (direct first, E2EE
      // tunnel fallback) via the injected relay host id — a fixed apiBaseUrl
      // would strand the window when the direct leg is unreachable.
      const hostId = typeof args.hostId === 'string' ? args.hostId.trim() : '';
      if (hostId === LOCAL_HOST_ID) {
        const localUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
        if (!localUrl) throw new Error('Local UI is not available');
        await createAdditionalWindow(localUrl, {
          apiBaseUrl: state.sidecarUrl || state.localOrigin || '',
          clientToken: readDesktopLocalClientToken(),
          requestHeaders: {},
        });
        return null;
      }
      const config = readDesktopHostsConfig();
      const host = config.hosts.find((entry) => entry.id === hostId);
      if (!host) throw new Error('Host not found');
       if (host.relay || host.directE2ee) {
        const windowUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
        await createAdditionalWindow(windowUrl, {
          apiBaseUrl: '',
          clientToken: host.clientToken || '',
          requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
          relayHostId: host.id,
        });
        return null;
      }
      const targetUrl = normalizeHostUrl(host.apiUrl || host.url);
      if (!targetUrl) throw new Error('Invalid URL');
      const windowUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : targetUrl;
      await createAdditionalWindow(windowUrl, {
        apiBaseUrl: targetUrl,
        clientToken: host.clientToken || '',
        requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
      });
      return null;
    }

    case 'desktop_new_window_at_url': {
      const targetUrl = normalizeHostUrl(String(args.url || ''));
      if (!targetUrl) {
        throw new Error('Invalid URL');
      }
      const config = readDesktopHostsConfig();
      const providedToken = typeof args.clientToken === 'string' ? args.clientToken : '';
      const clientToken = sanitizeClientTokenForStorage(providedToken) || resolveStoredClientTokenForUrl(targetUrl, config);
      const requestHeaders = sanitizeRuntimeRequestHeaders(args.requestHeaders || config.hosts.find((host) => normalizeHostUrl(host.apiUrl || host.url) === targetUrl)?.requestHeaders || {});
      let windowUrl = targetUrl;
      const runtimeConfig = { apiBaseUrl: targetUrl, clientToken, requestHeaders };
      if (shouldUsePackagedUi()) {
        windowUrl = buildPackagedUiUrl('/index.html');
      }
      await createAdditionalWindow(windowUrl, runtimeConfig);
      return null;
    }

    case 'desktop_open_session_mini_chat_window': {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      if (!sessionId) throw new Error('Session id is required');
      const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
      await createMiniChatWindow({ mode: 'session', sessionId, directory, runtimeConfig: resolveMiniChatRuntimeConfig(browserWindow, args) });
      return null;
    }

    case 'desktop_open_draft_mini_chat_window': {
      const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
      const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      await createMiniChatWindow({ mode: 'draft', directory, projectId, runtimeConfig: resolveMiniChatRuntimeConfig(browserWindow, args) });
      return null;
    }

    case 'desktop_set_window_pinned':
      return setMiniChatPinned(browserWindow, args.pinned === true);

    case 'desktop_get_window_pinned':
      return { pinned: Boolean(browserWindow?.__ocPinned) };

    case 'desktop_focus_main_window': {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
      const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
      const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      const hasMainWindow = state.mainWindow && !state.mainWindow.isDestroyed();

      // No live main window (e.g. "Open in main window" from a mini-chat after
      // the main window was closed): create one and open the session in it. A
      // fresh window can't take an immediate emit, so queue the session as a
      // pending deep-link and let did-finish-load flush it once ready.
      if (!hasMainWindow) {
        if (sessionId) pendingDeepLinks.push({ type: 'session', value: sessionId });
        await openMainWindow();
        return { focused: true };
      }

      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.show();
      state.mainWindow.focus();
      if (sessionId) {
        emitToWindow(state.mainWindow, 'openchamber:open-session', { sessionId, directory });
      } else if (mode === 'draft') {
        emitToWindow(state.mainWindow, 'openchamber:open-draft-session', { directory, projectId });
      }
      return { focused: true };
    }

    case 'desktop_close_current_window':
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.close();
      }
      return null;

    case 'desktop_minimize_current_window':
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.minimize();
      }
      return null;

    case 'desktop_toggle_current_window_maximized':
      if (browserWindow && !browserWindow.isDestroyed()) {
        if (browserWindow.isMaximized()) {
          browserWindow.unmaximize();
        } else {
          browserWindow.maximize();
        }
        return { maximized: browserWindow.isMaximized() };
      }
      return { maximized: false };

    case 'desktop_get_current_window_state':
      return { maximized: Boolean(browserWindow && !browserWindow.isDestroyed() && browserWindow.isMaximized()) };

    case 'desktop_show_app_menu': {
      if (!browserWindow || browserWindow.isDestroyed()) {
        return null;
      }

      const menu = Menu.getApplicationMenu() || buildAutoHiddenMenu();
      const x = Number.isFinite(Number(args.x)) ? Math.max(0, Math.round(Number(args.x))) : undefined;
      const y = Number.isFinite(Number(args.y)) ? Math.max(0, Math.round(Number(args.y))) : undefined;
      menu.popup({ window: browserWindow, x, y });
      return null;
    }

    case 'desktop_ssh_instances_get':
      return sshManager.readInstances();

    case 'desktop_ssh_instances_set':
      await sshManager.setInstances(args.config || {});
      return null;

    case 'desktop_ssh_import_hosts':
      return await sshManager.importHosts();

    case 'desktop_ssh_connect': {
      const id = String(args.id || '').trim();
      await sshManager.connect(id);
      return null;
    }

    case 'desktop_ssh_disconnect': {
      const id = String(args.id || '').trim();
      await sshManager.disconnect(id);
      return null;
    }

    case 'desktop_ssh_status': {
      const id = String(args.id || '').trim();
      return await sshManager.statusesWithDefaults(id || undefined);
    }

    case 'desktop_ssh_logs':
      return sshManager.logsForInstance(String(args.id || '').trim(), Number(args.limit) || 200);

    case 'desktop_ssh_logs_clear':
      sshManager.clearLogsForInstance(String(args.id || '').trim());
      return null;

    default:
      throw new Error(`Unknown desktop command: ${command}`);
  }
};

const buildMacMenu = () => {
  const dispatchAction = (action) => dispatchMenuAction(action);
  const handleCopyAction = () => {
    BrowserWindow.getFocusedWindow()?.webContents.copy();
    dispatchAction('copy');
  };

  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: 'About OpenChamber', click: () => dispatchAction('about') },
        {
          label: 'Check for Updates',
          click: () => dispatchCheckForUpdates(),
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'Cmd+,', click: () => dispatchAction('settings') },
        { label: 'Reload Webview', click: () => reloadMenuTargetWindow() },
        { label: 'Restart', click: () => relaunchFromMenu() },
        { label: 'Command Palette', accelerator: 'Cmd+P', click: () => dispatchAction('command-palette') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Cmd+Shift+Alt+N', click: () => void handleInvoke(null, 'desktop_new_window') },
        { type: 'separator' },
        { label: 'New Session', accelerator: 'Cmd+N', click: () => dispatchAction('new-session') },
        { label: 'New Worktree', accelerator: 'Cmd+Shift+N', click: () => dispatchAction('new-worktree-session') },
        // registerAccelerator:false → show the shortcut hint but let the
        // renderer own the (customizable) key binding, avoiding a double open.
        { label: 'New Mini Chat', accelerator: 'Cmd+Alt+N', registerAccelerator: false, click: () => dispatchOpenMiniChat() },
        { type: 'separator' },
        { label: 'Add Workspace', click: () => dispatchAction('change-workspace') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Copy', accelerator: 'Cmd+C', click: () => handleCopyAction() },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Right Sidebar', accelerator: 'Cmd+B', click: () => dispatchAction('toggle-right-sidebar') },
        { label: 'Open Git Sidebar', accelerator: 'Cmd+Shift+G', click: () => dispatchAction('open-right-sidebar-git') },
        { label: 'Open Files Sidebar', accelerator: 'Cmd+Shift+F', click: () => dispatchAction('open-right-sidebar-files') },
        { type: 'separator' },
        { label: 'Toggle Terminal Dock', accelerator: 'Cmd+J', click: () => dispatchAction('toggle-terminal') },
        { label: 'Toggle Terminal Expanded', accelerator: 'Cmd+Shift+J', click: () => dispatchAction('toggle-terminal-expanded') },
        { type: 'separator' },
        { label: 'Light Theme', click: () => dispatchAction('theme-light') },
        { label: 'Dark Theme', click: () => dispatchAction('theme-dark') },
        { label: 'System Theme', click: () => dispatchAction('theme-system') },
        { type: 'separator' },
        { label: 'Toggle Session Sidebar', accelerator: 'Cmd+L', click: () => dispatchAction('toggle-sidebar') },
        { label: 'Toggle Memory Debug', accelerator: 'Cmd+Shift+D', click: () => dispatchAction('toggle-memory-debug') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Cmd+.', click: () => dispatchAction('help-dialog') },
        { label: 'Show Diagnostics', accelerator: 'Cmd+Shift+L', click: () => dispatchAction('download-logs') },
        { label: 'Toggle Developer Tools', accelerator: 'Cmd+Alt+I', click: () => openDevToolsForMenuTarget() },
        { type: 'separator' },
        { label: 'Clear Cache', click: () => void handleInvoke(null, 'desktop_clear_cache') },
        { type: 'separator' },
        { label: 'Report a Bug', click: () => shell.openExternal(GITHUB_BUG_REPORT_URL) },
        { label: 'Request a Feature', click: () => shell.openExternal(GITHUB_FEATURE_REQUEST_URL) },
        { type: 'separator' },
        { label: 'Join Discord', click: () => shell.openExternal(DISCORD_INVITE_URL) },
      ],
    },
  ]);
};

const buildAutoHiddenMenu = () => {
  const dispatchAction = (action) => dispatchMenuAction(action);
  const handleCopyAction = () => {
    BrowserWindow.getFocusedWindow()?.webContents.copy();
    dispatchAction('copy');
  };

  return Menu.buildFromTemplate([
    {
      label: 'OpenChamber',
      submenu: [
        { label: 'About OpenChamber', click: () => dispatchAction('about') },
        {
          label: 'Check for Updates',
          click: () => dispatchCheckForUpdates(),
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'Ctrl+,', click: () => dispatchAction('settings') },
        { label: 'Reload Webview', click: () => reloadMenuTargetWindow() },
        { label: 'Restart', click: () => relaunchFromMenu() },
        { label: 'Command Palette', accelerator: 'Ctrl+P', click: () => dispatchAction('command-palette') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Ctrl+Shift+Alt+N', click: () => void handleInvoke(null, 'desktop_new_window') },
        { type: 'separator' },
        { label: 'New Session', accelerator: 'Ctrl+N', click: () => dispatchAction('new-session') },
        { label: 'New Worktree', accelerator: 'Ctrl+Shift+N', click: () => dispatchAction('new-worktree-session') },
        { type: 'separator' },
        { label: 'Add Workspace', click: () => dispatchAction('change-workspace') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Copy', accelerator: 'Ctrl+C', click: () => handleCopyAction() },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { label: 'Toggle Developer Tools', accelerator: 'Ctrl+Alt+I', click: () => openDevToolsForMenuTarget() },
        { type: 'separator' },
        { label: 'Toggle Right Sidebar', accelerator: 'Ctrl+B', click: () => dispatchAction('toggle-right-sidebar') },
        { label: 'Open Git Sidebar', accelerator: 'Ctrl+Shift+G', click: () => dispatchAction('open-right-sidebar-git') },
        { label: 'Open Files Sidebar', accelerator: 'Ctrl+Shift+F', click: () => dispatchAction('open-right-sidebar-files') },
        { type: 'separator' },
        { label: 'Toggle Terminal Dock', accelerator: 'Ctrl+J', click: () => dispatchAction('toggle-terminal') },
        { label: 'Toggle Terminal Expanded', accelerator: 'Ctrl+Shift+J', click: () => dispatchAction('toggle-terminal-expanded') },
        { type: 'separator' },
        { label: 'Light Theme', click: () => dispatchAction('theme-light') },
        { label: 'Dark Theme', click: () => dispatchAction('theme-dark') },
        { label: 'System Theme', click: () => dispatchAction('theme-system') },
        { type: 'separator' },
        { label: 'Toggle Session Sidebar', accelerator: 'Ctrl+L', click: () => dispatchAction('toggle-sidebar') },
        { label: 'Toggle Memory Debug', accelerator: 'Ctrl+Shift+D', click: () => dispatchAction('toggle-memory-debug') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: 'Ctrl+[', click: () => dispatchAction('go-back') },
        { label: 'Forward', accelerator: 'Ctrl+]', click: () => dispatchAction('go-forward') },
        { type: 'separator' },
        { label: 'Previous Session', accelerator: 'Alt+Up', click: () => dispatchAction('previous-session') },
        { label: 'Next Session', accelerator: 'Alt+Down', click: () => dispatchAction('next-session') },
        { type: 'separator' },
        { label: 'Previous Project', accelerator: 'Ctrl+Alt+Up', click: () => dispatchAction('previous-project') },
        { label: 'Next Project', accelerator: 'Ctrl+Alt+Down', click: () => dispatchAction('next-project') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Ctrl+.', click: () => dispatchAction('help-dialog') },
        { label: 'Show Diagnostics', accelerator: 'Ctrl+Shift+L', click: () => dispatchAction('download-logs') },
        { type: 'separator' },
        { label: 'Clear Cache', click: () => void handleInvoke(null, 'desktop_clear_cache') },
        { type: 'separator' },
        { label: 'Report a Bug', click: () => shell.openExternal(GITHUB_BUG_REPORT_URL) },
        { label: 'Request a Feature', click: () => shell.openExternal(GITHUB_FEATURE_REQUEST_URL) },
        { type: 'separator' },
        { label: 'Join Discord', click: () => shell.openExternal(DISCORD_INVITE_URL) },
      ],
    },
  ]);
};

contextMenu({
  showInspectElement: isDev,
  showSaveImageAs: true,
  showCopyImage: true,
  showCopyLink: true,
});

const loadUrlInsideWebContents = (contents, rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (contents.isDestroyed()) return false;
    void contents.loadURL(url.toString()).catch((error) => {
      log.warn('[webview] failed to load popup URL in place:', error);
    });
    return true;
  } catch {
    return false;
  }
};

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(({ url }) => {
    loadUrlInsideWebContents(contents, url);
    return { action: 'deny' };
  });
});

// All desktop_* IPC and dialog:open run with full Electron main privileges
// (fs access, shell.openPath, spawn, app.relaunch, …). The preload shim is
// injected into every webContents in the window, including remote hosts the
// user switches to via DesktopHostSwitcher. Without a gate, a malicious
// remote page could read arbitrary local files, open arbitrary apps, etc.
//
// Strategy: commands fall into two buckets by capability, not by origin.
// Window/host-switcher operations (probe a URL, open a new window, set
// title, read a credential-free hosts list) are safe for any renderer. Local
// pages receive the full host config; remote pages receive only display-safe
// metadata and public transport descriptors selected by main. Filesystem,
// shell.openPath, installed-app scans, app relaunch, and file dialogs
// are gated to local senders — even the user's own remote UI shouldn't
// need them, and a compromised remote can't use them either.
const isLocalSender = (webContents) => {
  try {
    const raw = typeof webContents?.getURL === 'function' ? webContents.getURL() : '';
    if (!raw) return false;
    const url = new URL(raw);
    if (url.protocol === `${UI_PROTOCOL}:` && url.hostname === 'app') return true;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (state.localOrigin) {
      try {
        const allowed = new URL(state.localOrigin);
        if (allowed.origin === url.origin) return true;
      } catch {
      }
    }
    if (state.sidecarUrl) {
      try {
        const allowed = new URL(state.sidecarUrl);
        if (allowed.origin === url.origin) return true;
      } catch {
      }
    }
    return false;
  } catch {
    return false;
  }
};

const COMMANDS_SAFE_FOR_REMOTE = new Set([
  'desktop_hosts_get',
  'desktop_host_probe',
  'desktop_new_window',
  'desktop_new_window_at_url',
  'desktop_new_window_for_host',
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_minimize_current_window',
  'desktop_toggle_current_window_maximized',
  'desktop_close_current_window',
  'desktop_get_current_window_state',
  'desktop_get_app_version',
  'desktop_get_lan_address',
  'desktop_capture_page_rect',
  'desktop_tray_update',
]);

ipcMain.handle('openchamber:invoke', async (event, command, args) => {
  const localSender = isLocalSender(event.sender);
  if (!localSender && !COMMANDS_SAFE_FOR_REMOTE.has(command)) {
    log.warn(`[ipc] rejected ${command} from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  if (command === 'desktop_hosts_get') {
    const fullConfig = {
      ...readDesktopHostsConfig(),
      localOrigin: state.localOrigin || state.sidecarUrl || null,
    };
    return resolveDesktopHostsForSender(event.sender?.getURL?.() || '', fullConfig, {
      localOrigin: state.localOrigin,
      sidecarUrl: state.sidecarUrl,
    });
  }
  return handleInvoke(browserWindow, command, args);
});

// Synchronous by design: preload runs at document start and the web runtime
// reads these globals during module initialization. Main chooses both the
// sender and its BrowserWindow config; the renderer supplies no target.
ipcMain.on('openchamber:runtime-bootstrap', (event) => {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const config = browserWindow && !browserWindow.isDestroyed() ? browserWindow.__ocRuntimeConfig : null;
  event.returnValue = resolveRuntimeBootstrap(event.sender?.getURL?.() || '', config, {
    localOrigin: state.localOrigin,
    sidecarUrl: state.sidecarUrl,
  });
});

ipcMain.handle('openchamber:dialog:open', async (event, options) => {
  // Native file dialogs expose absolute local paths; never grant to remote.
  if (!isLocalSender(event.sender)) {
    log.warn(`[ipc] rejected dialog:open from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(browserWindow || undefined, {
    title: typeof options?.title === 'string' ? options.title : undefined,
    defaultPath: typeof options?.defaultPath === 'string' && options.defaultPath.trim().length > 0
      ? options.defaultPath.trim()
      : undefined,
    filters: Array.isArray(options?.filters)
      ? options.filters
          .filter((filter) => filter && typeof filter === 'object')
          .map((filter) => ({
            name: typeof filter.name === 'string' && filter.name.trim().length > 0 ? filter.name : 'Files',
            extensions: Array.isArray(filter.extensions)
              ? filter.extensions.filter((extension) => typeof extension === 'string' && extension.trim().length > 0)
              : [],
          }))
      : undefined,
    properties: [
      options?.directory ? 'openDirectory' : 'openFile',
      options?.multiple ? 'multiSelections' : null,
      'createDirectory',
    ].filter(Boolean),
  });
  if (result.canceled) return null;
  const grantFilePath = async (filePath) => {
    if (options?.directory) return { path: filePath };
    try {
      const grant = await mintOutsideFileGrant(filePath, { scopes: ['stat', 'read', 'raw'], fsPromises: fsp, path });
      return { path: grant.path, outsideFileGrant: grant.outsideFileGrant, expiresAt: grant.expiresAt };
    } catch (error) {
      log.warn(`[ipc] failed to mint outside file grant: ${error?.message || error}`);
      return { path: filePath };
    }
  };
  if (options?.returnGrant) {
    if (options?.multiple) {
      return Promise.all(result.filePaths.map((filePath) => grantFilePath(filePath)));
    }
    return result.filePaths[0] ? grantFilePath(result.filePaths[0]) : null;
  }
  if (options?.multiple) return result.filePaths;
  return result.filePaths[0] || null;
});

ipcMain.handle('openchamber:file:grant-existing', async (event, filePath) => {
  if (!isLocalSender(event.sender)) {
    log.warn(`[ipc] rejected file:grant-existing from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }

  const targetPath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!targetPath) {
    throw new Error('Path is required');
  }

  const grant = await mintOutsideFileGrant(targetPath, { scopes: ['stat', 'read', 'raw'], fsPromises: fsp, path });
  return {
    path: grant.path,
    outsideFileGrant: grant.outsideFileGrant,
    expiresAt: grant.expiresAt,
  };
});

// --- Native tray / menu bar ---------------------------------------------------
// Tray lives on macOS and Windows; the renderer streams a compact state snapshot via
// the `desktop_tray_update` IPC command (see the command switch). Tray clicks
// flow back through dispatchTrayAction → renderer (focus/respond) or native
// handlers (show window / quit).

// Icon assets: a calm outline (idle), a statically filled cube (a finished
// session left unread), and an eased sequence the busy state breathes through.
const TRAY_BREATH_FRAME_COUNT = 16;
// Track the most recently focused window (main or mini-chat) so tray actions
// can target the surface the user was last using, even when the tray menu is
// open and nothing is focused right now.
app.on('browser-window-focus', (_event, browserWindow) => {
  if (browserWindow && !browserWindow.isDestroyed()) {
    state.lastFocusedWindowId = browserWindow.id;
  }
});

// The window the user is "on" for tray routing: the focused one, else the last
// focused that is still alive.
const resolveTraySurface = () => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (state.lastFocusedWindowId != null) {
    const remembered = BrowserWindow.fromId(state.lastFocusedWindowId);
    if (remembered && !remembered.isDestroyed()) return remembered;
  }
  return null;
};

const trayIconAssets = () => {
  const dir = path.join(resourceRoot(), 'icons', 'tray');
  const statusDir = path.join(dir, 'status');
  if (process.platform === 'win32') {
    const iconPath = getWindowIconPath() || path.join(resourceRoot(), 'icons', 'icon.ico');
    return {
      idleIconPath: iconPath,
      unseenIconPath: iconPath,
      breathIconPaths: [iconPath],
      statusIconPaths: {
        busy: path.join(statusDir, 'busy.png'),
        retry: path.join(statusDir, 'retry.png'),
        error: path.join(statusDir, 'error.png'),
        unseen: path.join(statusDir, 'unseen.png'),
        blank: path.join(statusDir, 'blank.png'),
      },
    };
  }
  return {
    idleIconPath: path.join(dir, 'trayTemplate-idle.png'),
    unseenIconPath: path.join(dir, 'trayTemplate-unseen.png'),
    breathIconPaths: Array.from({ length: TRAY_BREATH_FRAME_COUNT }, (_, i) =>
      path.join(dir, `trayTemplate-breath-${String(i).padStart(2, '0')}.png`)),
    // Per-session status icons shown in the menu rows (left, vertically centred
    // across the title + sublabel). 'blank' reserves the gutter for idle rows.
    statusIconPaths: {
      busy: path.join(statusDir, 'busy.png'),
      retry: path.join(statusDir, 'retry.png'),
      error: path.join(statusDir, 'error.png'),
      unseen: path.join(statusDir, 'unseen.png'),
      blank: path.join(statusDir, 'blank.png'),
    },
  };
};

const setupTray = () => {
  if (!['darwin', 'win32'].includes(process.platform) || state.trayController) return;
  const assets = trayIconAssets();
  if (!fs.existsSync(assets.idleIconPath)) {
    log.warn('[electron] tray icon missing, skipping tray setup', { iconPath: assets.idleIconPath });
    return;
  }
  try {
    state.trayController = createTrayController({
      ...assets,
      onAction: (action) => { void dispatchTrayAction(action); },
    });
    // Seed an empty snapshot so the icon appears immediately; the renderer
    // pushes the real state once the sync stores are mounted.
    state.trayController.update({ sessions: [], approvals: [] });
  } catch (error) {
    log.warn('[electron] failed to set up tray', error);
    state.trayController = null;
  }
};

// Bring the existing main window forward WITHOUT re-navigating it. Only when
// no live window exists (truly closed) do we recreate one — recreation reloads,
// but showing an existing window must not. This mirrors desktop_focus_main_window
// and the notification "open session" path; calling openMainWindow on a live
// window navigates it (full reload), which is the bug we're avoiding here.
const revealMainWindow = async () => {
  let target = state.mainWindow;
  if (!target || target.isDestroyed()) {
    target = await openMainWindow().catch(() => null) || state.mainWindow;
  }
  if (target && !target.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
  return target;
};

// Open a session in the main window, creating one first if none is alive. A
// freshly created window can't receive an immediate emit (its renderer hasn't
// mounted its listeners yet), so we queue the session as a pending deep-link —
// the did-finish-load handler flushes it once the window is ready.
const focusMainWindowWithSession = async (sessionId, directory) => {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    state.mainWindow.show();
    state.mainWindow.focus();
    if (sessionId) {
      emitToWindow(state.mainWindow, 'openchamber:open-session', { sessionId, directory: directory || '' });
    }
    return;
  }
  if (sessionId) pendingDeepLinks.push({ type: 'session', value: sessionId });
  await openMainWindow();
};

const dispatchTrayAction = async (action) => {
  if (!action || typeof action !== 'object') return;

  if (action.type === 'quit') {
    app.quit();
    return;
  }

  // Responding to a permission doesn't need to steal focus — just deliver it.
  if (action.type === 'respond-permission') {
    const target = (state.mainWindow && !state.mainWindow.isDestroyed())
      ? state.mainWindow
      : await revealMainWindow();
    emitToWindow(target, 'openchamber:tray-action', action);
    return;
  }

  // Mini chat opens its own small window; we only need a renderer with context,
  // not to surface the main window.
  if (action.type === 'new-mini-chat') {
    let target = getMenuTargetWindow();
    if (!target) target = await revealMainWindow();
    dispatchOpenMiniChat(target);
    return;
  }

  // Open a session on the surface the user was last on: if that's a mini-chat,
  // switch THAT window to the session in place (no new window); otherwise use
  // the main window.
  if (action.type === 'focus-session') {
    const surface = resolveTraySurface();
    if (surface && surface.__ocMiniChat === true && action.sessionId) {
      if (surface.isMinimized()) surface.restore();
      surface.show();
      surface.focus();
      emitToWindow(surface, 'openchamber:open-session', {
        sessionId: action.sessionId,
        directory: action.directory || '',
      });
      return;
    }
    await focusMainWindowWithSession(action.sessionId, action.directory || '');
    return;
  }

  const target = await revealMainWindow();
  if (!target || target.isDestroyed()) return;

  if (action.type === 'new-session') {
    emitToWindow(target, 'openchamber:open-draft-session', { directory: '', projectId: '' });
  }
  // show-main-window: revealing the window above is the whole action.
};

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !state.quitRequested) {
    return;
  }

  if (process.platform !== 'darwin') {
    if (state.installingUpdate) {
      app.quit();
    } else {
      performConfirmedQuit();
    }
  }
});

app.on('before-quit', (event) => {
  state.quitRequested = true;

  if (state.installingUpdate) {
    return;
  }

  if (process.platform === 'darwin' && !state.quitConfirmed) {
    event.preventDefault();
    void requestQuitWithConfirmation();
    return;
  }

  if (!state.backgroundShutdownComplete) {
    event.preventDefault();
    performConfirmedQuit();
  }
});

app.on('second-instance', (_event, argv) => {
  const urls = Array.isArray(argv)
    ? argv.filter((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`))
    : [];
  if (urls.length > 0) handleDeepLinks(urls);
  if (BrowserWindow.getAllWindows().length > 0) {
    focusForegroundWindow();
  } else {
    void openMainWindow();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinks([url]);
  if (BrowserWindow.getAllWindows().length === 0) {
    void openMainWindow();
  }
});

app.on('activate', async () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  // Only spawn a main window when there is genuinely nothing to come back to.
  if (windows.length === 0) {
    await openMainWindow();
    return;
  }

  // Otherwise bring back the surface the user was last on — restoring it if
  // minimized — instead of surfacing a hidden window or creating a new one.
  // This covers e.g. "only a minimized mini-chat remains": it should un-minimize
  // rather than open the main window.
  const remembered = resolveTraySurface();
  const targetWindow = (remembered && !remembered.isDestroyed())
    ? remembered
    : (windows.find((window) => window.isVisible() && !window.isMinimized()) || windows[0]);
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
});

app.whenReady().then(async () => {
  const loginItemSettings = readLoginItemSettings();
  const isBackgroundStart = shouldStartInBackground(loginItemSettings);
  log.info('[electron] app starting', {
    version: APP_VERSION,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    argv: process.argv,
    isBackgroundStart,
    loginItemSettings,
  });
  nativeTheme.themeSource = readThemeSource();
  registerPackagedUiProtocol();
  setupAutoUpdater();

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(buildMacMenu());
  } else {
    Menu.setApplicationMenu(buildAutoHiddenMenu());
  }
  setupTray();

  if ((process.platform === 'darwin' || process.platform === 'win32') && app.isPackaged) {
    const openAtLogin = loginItemSettings?.openAtLogin === true;
    app.setLoginItemSettings({
      openAtLogin,
      ...(process.platform === 'darwin' ? { openAsHidden: openAtLogin, args: openAtLogin ? [BACKGROUND_START_ARG] : [] } : {}),
      ...(process.platform === 'win32' ? { ...getLoginItemOptions(), enabled: openAtLogin } : {}),
    });
  }

  if (isBackgroundStart) {
    const { localOrigin, bootOutcome, requestHeaders } = await resolveInitialUrl();
    state.localOrigin = localOrigin;
    state.bootOutcome = bootOutcome ?? null;
    state.requestHeaders = sanitizeRuntimeRequestHeaders(requestHeaders || {});
    state.initScript = buildInitScript(localOrigin, state.bootOutcome, '', '', state.requestHeaders);
    log.info('[electron] started in background without window');
    return;
  }

  state.mainWindow = createBrowserWindow({
    label: 'main',
    restoreGeometry: true,
    url: null,
  });

  const initial = extractInitialDeepLinks();
  if (initial.length > 0) handleDeepLinks(initial);

  const { initialUrl, localOrigin, bootOutcome, apiBaseUrl, clientToken, requestHeaders } = await resolveInitialUrl();
  await activateMainWindow(initialUrl, localOrigin, bootOutcome, { apiBaseUrl, clientToken, requestHeaders });

  // Notify renderer on OS wake-from-sleep so the SSE event pipeline can
  // reconnect immediately instead of waiting for the heartbeat watchdog.
  powerMonitor.on('resume', () => {
    emitToAllWindows('openchamber:system-resume', { timestamp: Date.now() });
  });
}).catch((error) => {
  log.error('[electron] startup failed:', error);
  app.exit(1);
});
