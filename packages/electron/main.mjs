import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, session, shell } from 'electron';
import contextMenu from 'electron-context-menu';
import log from 'electron-log/main.js';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import updaterPkg from 'electron-updater';
import { ElectronSshManager } from './ssh-manager.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.OPENCHAMBER_ELECTRON_DEV === '1' || !app.isPackaged;

const DEEP_LINK_PROTOCOL = 'openchamber';
const APP_USER_MODEL_ID = 'dev.openchamber.desktop';

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

// Set the product name early so electron-log derives its log directory as
// ~/Library/Logs/OpenChamber/ (not ~/Library/Logs/@openchamber/electron/).
app.setName('OpenChamber');
app.setAppUserModelId(APP_USER_MODEL_ID);
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');

try {
  process.chdir(os.homedir());
} catch {
}

log.initialize();
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';

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
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 520;
const MIN_RESTORE_WINDOW_WIDTH = 900;
const MIN_RESTORE_WINDOW_HEIGHT = 560;
const LOCAL_HOST_ID = 'local';
const ENV_OVERRIDE_HOST_ID = '__env';
const CHANGELOG_URL = 'https://raw.githubusercontent.com/btriapitsyn/openchamber/main/CHANGELOG.md';
const UPDATE_METADATA_URL = 'https://github.com/btriapitsyn/openchamber/releases/latest/download/latest.json';
const GITHUB_BUG_REPORT_URL = 'https://github.com/btriapitsyn/openchamber/issues/new?template=bug_report.yml';
const GITHUB_FEATURE_REQUEST_URL = 'https://github.com/btriapitsyn/openchamber/issues/new?template=feature_request.yml';
const DISCORD_INVITE_URL = 'https://discord.gg/ZYRSdnwwKA';
const INSTALLED_APPS_CACHE_TTL_SECS = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE = 'discovered-apps.json';

const { autoUpdater } = updaterPkg;

const state = {
  serverHandle: null,
  sidecarUrl: null,
  localOrigin: null,
  bootOutcome: null,
  initScript: null,
  mainWindow: null,
  quitRequested: false,
  quitConfirmed: false,
  quitConfirmationPending: false,
  quitRiskPollerStarted: false,
  pendingUpdate: null,
  unreachableHosts: new Set(),
  windowCounter: 1,
  focusedWindowIds: new Set(),
  windowGeometryRevisions: new Map(),
  sshStatuses: new Map(),
  sshLogs: new Map(),
};

const QUIT_RISK_POLL_INTERVAL_MS = 5_000;
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

const performConfirmedQuit = () => {
  if (state.quitConfirmed) return;
  state.quitConfirmed = true;
  state.quitRequested = true;

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      debounceWindowStatePersist(state.mainWindow, true);
    } catch {
    }
  }

  try {
    killSidecar();
  } catch {
  }
  void sshManager.shutdownAll().catch(() => {});

  // Safety net: force-exit if normal quit sequence stalls (e.g. background
  // handles in electron-updater / fetch refs) after a short grace period.
  const safety = setTimeout(() => {
    app.exit(0);
  }, 1500);
  if (typeof safety?.unref === 'function') safety.unref();

  app.quit();
};

const requestQuitWithConfirmation = async () => {
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

const startQuitRiskPoller = () => {
  if (process.platform !== 'darwin') return;
  if (state.quitRiskPollerStarted) return;
  state.quitRiskPollerStarted = true;

  const loop = async () => {
    while (!state.quitConfirmed && !state.quitRequested) {
      await refreshQuitRiskFlags();
      if (state.quitConfirmed || state.quitRequested) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, QUIT_RISK_POLL_INTERVAL_MS);
        if (typeof timer?.unref === 'function') timer.unref();
      });
    }
  };
  void loop();
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
  } catch {
    return {};
  }
};

const writeJsonFile = async (filePath, data) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
};

const readSettingsRoot = () => {
  const root = readJsonFile(settingsFilePath());
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
};

const writeSettingsRoot = async (root) => writeJsonFile(settingsFilePath(), root);

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

const readDesktopHostsConfig = () => {
  const root = readSettingsRoot();
  const hostsRaw = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
  const hosts = hostsRaw
    .map((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      const url = sanitizeHostUrlForStorage(entry?.url);
      if (!id || id === LOCAL_HOST_ID || !url) return null;
      const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : url;
      return { id, label, url };
    })
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
  const root = readSettingsRoot();
  root.desktopHosts = Array.isArray(config?.hosts)
    ? config.hosts
        .map((entry) => {
          const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
          const url = sanitizeHostUrlForStorage(entry?.url);
          if (!id || id === LOCAL_HOST_ID || !url) return null;
          return {
            id,
            label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : url,
            url,
          };
        })
        .filter(Boolean)
    : [];
  root.desktopDefaultHostId = typeof config?.defaultHostId === 'string' && config.defaultHostId.trim()
    ? config.defaultHostId.trim()
    : null;
  if (typeof config?.initialHostChoiceCompleted === 'boolean') {
    root.desktopInitialHostChoiceCompleted = config.initialHostChoiceCompleted;
  }
  await writeSettingsRoot(root);
};

const readWindowState = () => {
  const stateValue = readSettingsRoot().desktopWindowState;
  return stateValue && typeof stateValue === 'object' ? stateValue : null;
};

const writeWindowState = async (browserWindow) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  if (!state.mainWindow || browserWindow.id !== state.mainWindow.id) return;

  const bounds = browserWindow.getBounds();
  const root = readSettingsRoot();
  root.desktopWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(bounds.width, MIN_WINDOW_WIDTH),
    height: Math.max(bounds.height, MIN_WINDOW_HEIGHT),
    maximized: browserWindow.isMaximized(),
    fullscreen: browserWindow.isFullScreen(),
  };
  await writeSettingsRoot(root);
};

const debounceWindowStatePersist = (browserWindow, immediate = false) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const key = String(browserWindow.id);
  const revision = (state.windowGeometryRevisions.get(key) || 0) + 1;
  state.windowGeometryRevisions.set(key, revision);

  const persist = async () => {
    if (state.windowGeometryRevisions.get(key) !== revision) return;
    await writeWindowState(browserWindow);
  };

  if (immediate) {
    void persist();
    return;
  }

  setTimeout(() => {
    void persist();
  }, 300);
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

const probeHostWithTimeout = async (url, timeoutMs) => {
  const healthUrl = buildHealthUrl(url);
  if (!healthUrl) {
    throw new Error('Invalid URL');
  }

  const started = Date.now();
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const status = response.status;
    return {
      status: status >= 200 && status < 300 ? 'ok' : (status === 401 || status === 403 ? 'auth' : 'unreachable'),
      latencyMs: Date.now() - started,
    };
  } catch {
    return { status: 'unreachable', latencyMs: Date.now() - started };
  }
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

const pickUnusedPort = async () => {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
};

const isPortFree = async (port) => {
  if (!Number.isFinite(port) || port <= 0) return false;
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const test = net.createServer();
    const done = (value) => {
      try { test.close(); } catch {}
      resolve(value);
    };
    test.once('error', () => done(false));
    test.listen(port, '127.0.0.1', () => done(true));
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
  if (target.isMinimized()) target.restore();
  if (!target.isVisible()) target.show();
  target.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
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

  const title = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'OpenChamber';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : null;

  const notification = new Notification({
    title,
    body,
    silent: false,
    ...(process.platform === 'darwin' ? { sound: 'Glass' } : {}),
  });

  notification.on('click', () => {
    focusForegroundWindow();
    if (sessionId) {
      emitToAllWindows('openchamber:open-session', { sessionId });
    }
  });

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

// Finder-launched apps on macOS inherit a minimal PATH (no /opt/homebrew, mise, asdf, etc.).
// Probe the user's login shell once so the sidecar sees the same PATH / tool env as `$SHELL -il`.
const loadShellEnv = () => {
  if (shellEnvProbed) return cachedShellEnv;
  shellEnvProbed = true;
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/sh';
  if (isNushell(shell)) return null;
  cachedShellEnv = probeShellEnv(shell, '-il') || probeShellEnv(shell, '-l');
  return cachedShellEnv;
};

// Merge the user's login-shell env (PATH, etc.) into this process before we
// import/start the server in-process. The server and its children (opencode
// CLI, git, etc.) inherit process.env directly now — there is no sidecar
// subprocess to hand a custom env to.
const inheritUserShellEnv = () => {
  const shellEnv = loadShellEnv();
  if (!shellEnv) return;

  const homeDir = os.homedir();
  const shellPathSegments = typeof shellEnv.PATH === 'string' ? shellEnv.PATH.split(':') : [];
  const processPathSegments = typeof process.env.PATH === 'string' ? process.env.PATH.split(':') : [];
  const pathSegments = [
    ...shellPathSegments,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(homeDir, '.opencode', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    path.join(homeDir, 'bin'),
    ...processPathSegments,
  ].filter(Boolean);
  const uniquePath = Array.from(new Set(pathSegments)).join(':');

  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH') continue;
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }
  process.env.PATH = uniquePath;
};

const spawnLocalServer = async () => {
  inheritUserShellEnv();

  const settings = readSettingsRoot();
  const storedPort = Number.isFinite(settings.desktopLocalPort) ? settings.desktopLocalPort : null;
  // When the user enables "Desktop Network Access" we bind on all interfaces
  // so phones/tablets on the same Wi-Fi can reach the app. UI shows a clear
  // warning and persists the flag via /api/config/settings.
  const lanAccessEnabled = settings.desktopLanAccessEnabled === true;
  const bindHost = lanAccessEnabled ? '0.0.0.0' : '127.0.0.1';

  // Probe before starting the server — main() in the server module sets up a
  // lot of global state before binding, and calling it twice after a listen
  // failure would double-wire runtimes. Pick a known-free port in one shot.
  const candidates = [storedPort, DEFAULT_DESKTOP_PORT].filter((v) => Number.isFinite(v) && v > 0);
  let chosenPort = 0;
  for (const candidate of candidates) {
    if (await isPortFree(candidate)) {
      chosenPort = candidate;
      break;
    }
  }
  if (chosenPort === 0) {
    chosenPort = await pickUnusedPort();
  }

  // The server module reads ENV_DESKTOP_NOTIFY / OPENCHAMBER_DIST_DIR /
  // OPENCHAMBER_RUNTIME at import time (top-level const), so these must be
  // set before the first import. After this point, the same env is used by
  // both the Electron main and the server running inside it.
  process.env.OPENCHAMBER_HOST = bindHost;
  process.env.OPENCHAMBER_DIST_DIR = resolveWebDistDir();
  process.env.OPENCHAMBER_RUNTIME = 'desktop';
  process.env.OPENCHAMBER_DESKTOP_NOTIFY = 'true';
  process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1';
  process.env.no_proxy = process.env.no_proxy || 'localhost,127.0.0.1';

  const { startWebUiServer } = await import('@openchamber/web/server/index.js');

  const handle = await startWebUiServer({
    port: chosenPort,
    host: bindHost,
    attachSignals: false,
    exitOnShutdown: false,
    onDesktopNotification: (payload) => maybeShowNativeNotification(payload),
  });

  const port = handle.getPort();
  const url = buildLocalUrl(port);

  state.serverHandle = handle;
  state.sidecarUrl = url;

  const root = readSettingsRoot();
  root.desktopLocalPort = port;
  await writeSettingsRoot(root);

  return url;
};

const killSidecar = () => {
  if (state.serverHandle) {
    try {
      const result = state.serverHandle.stop({ exitProcess: false });
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
    } catch {
    }
    state.serverHandle = null;
  }
  state.sidecarUrl = null;
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

const buildInitScript = (localOrigin, bootOutcome) => {
  const home = JSON.stringify(os.homedir() || '');
  const local = JSON.stringify(localOrigin || '');
  const macVersion = macosMajorVersion();
  const outcome = JSON.stringify(bootOutcome ?? null);
  return [
    '(function(){',
    `try{window.__OPENCHAMBER_HOME__=${home};window.__OPENCHAMBER_MACOS_MAJOR__=${macVersion};window.__OPENCHAMBER_LOCAL_ORIGIN__=${local};var __oc_bo=${outcome};if(__oc_bo){window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}}catch(_e){}`,
    '}())',
  ].join('');
};

const computeBootOutcome = ({ envTargetUrl, probe, config, localAvailable }) => {
  if (envTargetUrl) {
    const status = probe && probe.status === 'unreachable' ? 'unreachable' : 'ok';
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

  const status = probe && probe.status === 'unreachable' ? 'unreachable' : 'ok';
  return { target: 'remote', status, hostId: host.id, url: host.url };
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
      body {
        margin: 0;
        font-family: "IBM Plex Sans", sans-serif;
        display: grid;
        place-items: center;
        height: 100vh;
        background: ${splashBgLight};
        color: ${splashFgLight};
      }
      @media (prefers-color-scheme: dark) {
        body { background: ${splashBgDark}; color: ${splashFgDark}; }
      }
      .mark {
        font-size: 20px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        opacity: 0.88;
      }
    </style>
  </head>
  <body>
    <div class="mark">OpenChamber</div>
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

const emitToWindow = (browserWindow, event, detail) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  browserWindow.webContents.send('openchamber:emit', { event, detail });
};

const emitToAllWindows = (event, detail) => {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    emitToWindow(browserWindow, event, detail);
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
    return { type, value };
  } catch {
    return null;
  }
};

const switchToHostById = async (rawId) => {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) return;
  const config = readDesktopHostsConfig();
  let targetUrl = null;
  if (id === LOCAL_HOST_ID) {
    targetUrl = state.sidecarUrl || state.localOrigin;
  } else {
    const host = config.hosts.find((entry) => entry.id === id);
    if (!host) {
      log.warn('[electron] deep-link host not found:', id);
      return;
    }
    targetUrl = host.url;
  }
  if (!targetUrl) {
    log.warn('[electron] deep-link host has no target URL:', id);
    return;
  }
  const bootOutcome = id === LOCAL_HOST_ID
    ? { target: 'local', status: 'ok' }
    : { target: 'remote', status: 'ok', hostId: id, url: targetUrl };
  log.info('[electron] switching to host', { id, bootOutcome });
  await activateMainWindow(targetUrl, state.localOrigin, bootOutcome);
};

const dispatchDeepLink = (link) => {
  if (!link) return;
  log.info('[electron] dispatching deep-link', { type: link.type, valueLen: link.value?.length || 0 });
  if (link.type === 'session' && link.value) {
    emitToAllWindows('openchamber:open-session', { sessionId: link.value });
    return;
  }
  if (link.type === 'project' && link.value) {
    emitToAllWindows('openchamber:open-project', { projectPath: link.value });
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

const dispatchCheckForUpdates = () => {
  emitToAllWindows('openchamber:check-for-updates');
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    dispatchDomEventToWindow(browserWindow, 'openchamber:check-for-updates');
  }
};

const nextWindowLabel = () => {
  const value = state.windowCounter++;
  return value === 1 ? 'main' : `main-${value}`;
};

const readThemeSource = () => {
  const settings = readSettingsRoot();
  if (settings.useSystemTheme === true) return 'system';
  if (settings.themeMode === 'light' || settings.themeVariant === 'light') return 'light';
  if (settings.themeMode === 'dark' || settings.themeVariant === 'dark') return 'dark';
  return 'system';
};

const createBrowserWindow = ({ label, restoreGeometry, url }) => {
  const saved = restoreGeometry ? readWindowState() : null;
  const useSaved = saved && typeof saved.width === 'number' && typeof saved.height === 'number';
  const desktopLocalOrigin = state.localOrigin || '';
  const desktopHome = os.homedir() || '';
  const desktopMacosMajor = String(macosMajorVersion());
  const options = {
    title: 'OpenChamber',
    width: useSaved ? Math.max(saved.width, MIN_RESTORE_WINDOW_WIDTH) : 1280,
    height: useSaved ? Math.max(saved.height, MIN_RESTORE_WINDOW_HEIGHT) : 800,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: '#151313',
    // Tauri used an overlay title bar with explicit traffic-light placement.
    // Electron's hiddenInset adds its own extra inset, which leaves the controls
    // visibly lower than the app header. Use a plain hidden title bar instead.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      additionalArguments: [
        `--openchamber-local-origin=${desktopLocalOrigin}`,
        `--openchamber-home=${desktopHome}`,
        `--openchamber-macos-major=${desktopMacosMajor}`,
        `--openchamber-boot-outcome=${JSON.stringify(state.bootOutcome || null)}`,
      ],
      preload: isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: true,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox must stay off: the preload uses contextBridge + ipcRenderer
      // from Electron's Node layer. contextIsolation + nodeIntegration:false
      // keep the renderer world walled off from Node. Do NOT flip to true —
      // the preload would fail to load and __TAURI__ would go undefined.
      sandbox: false,
    },
  };

  const browserWindow = new BrowserWindow(options);
  browserWindow.__ocLabel = label || nextWindowLabel();

  if (useSaved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    browserWindow.setPosition(saved.x, saved.y);
  }

  if (useSaved && saved.maximized) {
    browserWindow.maximize();
  }

  browserWindow.on('focus', () => {
    state.focusedWindowIds.add(browserWindow.id);
  });
  browserWindow.on('blur', () => {
    state.focusedWindowIds.delete(browserWindow.id);
  });
  browserWindow.on('resize', () => {
    emitToWindow(browserWindow, 'openchamber:window-resized');
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('move', () => {
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('close', (event) => {
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
      killSidecar();
      if (process.platform !== 'darwin') {
        app.quit();
      }
    }
  });

  browserWindow.webContents.setZoomFactor(1);
  browserWindow.webContents.on('zoom-changed', () => {
    browserWindow.webContents.setZoomFactor(1);
  });

  browserWindow.webContents.on('dom-ready', () => {
    if (state.initScript) {
      void browserWindow.webContents.executeJavaScript(state.initScript).catch(() => {});
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

const activateMainWindow = async (url, localOrigin, bootOutcome) => {
  state.localOrigin = localOrigin;
  state.bootOutcome = bootOutcome ?? null;
  state.initScript = buildInitScript(localOrigin, state.bootOutcome);

  const mainWindow = state.mainWindow;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await navigateWindow(mainWindow, url, { allowAbort: true });
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  state.mainWindow = createBrowserWindow({
    label: 'main',
    restoreGeometry: true,
    url,
  });
  return state.mainWindow;
};

const createAdditionalWindow = async (url) => {
  if (!state.localOrigin) {
    return null;
  }
  const browserWindow = createBrowserWindow({
    label: nextWindowLabel(),
    restoreGeometry: false,
    url,
  });
  return browserWindow;
};

const resolveInitialUrl = async () => {
  const localUrl = isDev && await waitForHealth('http://127.0.0.1:3901', 5_000, 100)
    ? 'http://127.0.0.1:3901'
    : await spawnLocalServer();

  const localUiUrl = isDev && await waitForHealth('http://127.0.0.1:5173', 8_000, 100)
    ? 'http://127.0.0.1:5173'
    : localUrl;

  state.sidecarUrl = localUrl;
  const localAvailable = Boolean(localUrl);

  const localOrigin = new URL(localUiUrl).origin;
  let initialUrl = localUiUrl;
  let remoteProbe = null;

  const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
  const config = readDesktopHostsConfig();
  if (envTarget) {
    initialUrl = envTarget;
  } else if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID) {
    const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
    if (host?.url) {
      initialUrl = host.url;
    }
  }

  if (initialUrl !== localUiUrl) {
    remoteProbe = await probeHostWithTimeout(initialUrl, 2_000);
    if (remoteProbe.status === 'unreachable') {
      remoteProbe = await probeHostWithTimeout(initialUrl, 10_000);
    }
    if (remoteProbe.status === 'unreachable') {
      state.unreachableHosts.add(initialUrl);
      initialUrl = localUiUrl;
    }
  }

  const bootOutcome = computeBootOutcome({
    envTargetUrl: envTarget || null,
    probe: remoteProbe,
    config,
    localAvailable,
  });

  return { initialUrl, localOrigin, localUiUrl, bootOutcome };
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

const parseGithubRepo = () => {
  return { owner: 'btriapitsyn', repo: 'openchamber' };
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

  const { owner, repo } = parseGithubRepo();
  autoUpdater.setFeedURL({
    provider: 'github',
    owner,
    repo,
  });

  autoUpdater.on('download-progress', (progress) => {
    emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
      event: 'Progress',
      data: {
        chunkLength: Math.max(0, Math.round(progress.bytesPerSecond || 0)),
        downloaded: Math.round(progress.transferred || 0),
        total: Math.round(progress.total || 0),
      },
    }));
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
  const root = readSettingsRoot();
  root.desktopSshInstances = Array.isArray(config?.instances) ? config.instances : [];
  await writeSettingsRoot(root);
  return { instances: root.desktopSshInstances };
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

const runSpecChain = (specs, appName) => {
  const failures = [];
  for (const spec of specs) {
    const result = spawnSync(spec.program, spec.args, { stdio: 'ignore' });
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
      if (process.platform !== 'darwin') {
        throw new Error('desktop_open_in_app is only supported on macOS');
      }
      const projectPath = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!projectPath || !appId || !appName) {
        throw new Error('Project path, app id, and app name are required');
      }
      runSpecChain(buildOpenProjectSpecs({ projectPath, appId, appName }), appName);
      return null;
    }

    case 'desktop_open_file_in_app': {
      if (process.platform !== 'darwin') {
        throw new Error('desktop_open_file_in_app is only supported on macOS');
      }
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!filePath || !appId || !appName) {
        throw new Error('File path, app id, and app name are required');
      }
      runSpecChain(buildOpenFileSpecs({ filePath, appId, appName }), appName);
      return null;
    }

    case 'desktop_filter_installed_apps': {
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
      if (process.platform !== 'darwin') {
        throw new Error('desktop_get_installed_apps is only supported on macOS');
      }
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
        const apps = await buildInstalledApps(Array.isArray(args.apps) ? args.apps : []);
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, JSON.stringify({ updatedAt: now, apps }, null, 2));
        emitToAllWindows('openchamber:installed-apps-updated', apps);
      };
      if (!hasCache || isCacheStale || args.force === true) {
        void refresh();
      }
      return { apps: cachedApps, hasCache, isCacheStale };
    }

    case 'desktop_hosts_get':
      return readDesktopHostsConfig();

    case 'desktop_hosts_set': {
      await writeDesktopHostsConfig(args.input || args.config || {});
      const updatedConfig = readDesktopHostsConfig();
      const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
      state.bootOutcome = computeBootOutcome({
        envTargetUrl: envTarget || null,
        probe: null,
        config: updatedConfig,
        localAvailable: Boolean(state.sidecarUrl || state.localOrigin),
      });
      state.initScript = buildInitScript(state.localOrigin, state.bootOutcome);
      log.info('[electron] hosts config updated, recomputed bootOutcome', state.bootOutcome);
      return null;
    }

    case 'desktop_host_probe':
      return probeHostWithTimeout(String(args.url || ''), 2_000);

    case 'desktop_set_window_theme': {
      const mode = typeof args.themeMode === 'string' ? args.themeMode : '';
      const variant = typeof args.themeVariant === 'string' ? args.themeVariant : '';
      nativeTheme.themeSource = mode === 'dark' || variant === 'dark'
        ? 'dark'
        : (mode === 'light' || variant === 'light' ? 'light' : 'system');
      return null;
    }

    case 'desktop_set_vibrancy': {
      // Vibrancy (macOS blur) is not supported in the Electron shell — the
      // Tauri build used NSVisualEffectView via Tauri plugin, Electron has
      // no equivalent for our titleBarStyle:'hidden' setup. Persist the
      // disabled state so settings UI reflects it; args.enabled is ignored.
      const root = readSettingsRoot();
      root.desktopVibrancy = false;
      await writeSettingsRoot(root);
      return { enabled: false, requiresRestart: false };
    }

    case 'desktop_check_for_updates': {
      const currentVersion = APP_VERSION;
      let payload = null;
      try {
        const response = await fetch(UPDATE_METADATA_URL, { signal: AbortSignal.timeout(10_000) });
        payload = await response.json();
      } catch {
      }

      let updateResult = null;
      try {
        updateResult = await autoUpdater.checkForUpdates();
      } catch {
      }

      const updateInfo = updateResult?.updateInfo;
      const nextVersion =
        (typeof updateInfo?.version === 'string' && updateInfo.version) ||
        (typeof payload?.version === 'string' && payload.version) ||
        currentVersion;
      const available = compareSemver(nextVersion, currentVersion) > 0;
      const body =
        (typeof payload?.notes === 'string' && payload.notes.trim() ? payload.notes : null) ||
        (typeof updateInfo?.releaseNotes === 'string' && updateInfo.releaseNotes.trim() ? updateInfo.releaseNotes : null) ||
        await parseRelevantChangelogNotes(currentVersion, nextVersion);
      state.pendingUpdate = available ? { version: nextVersion, metadata: payload, electronUpdate: updateResult } : null;
      return {
        available,
        currentVersion,
        version: available ? nextVersion : null,
        body: body || null,
        date:
          (typeof updateInfo?.releaseDate === 'string' && updateInfo.releaseDate) ||
          (typeof payload?.pub_date === 'string' ? payload.pub_date : null),
      };
    }

    case 'desktop_download_and_install_update':
      if (!state.pendingUpdate) {
        throw new Error('No pending update');
      }
      emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
        event: 'Started',
        data: {
          contentLength: null,
        },
      }));
      if (!state.pendingUpdate.electronUpdate) {
        throw new Error('Electron updater metadata is not available for this build');
      }
      await autoUpdater.downloadUpdate();
      state.pendingUpdate.downloaded = true;
      emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
        event: 'Finished',
        data: {},
      }));
      return null;

    case 'desktop_restart':
      if (state.pendingUpdate?.downloaded && app.isPackaged) {
        autoUpdater.quitAndInstall(false, true);
        return null;
      }
      app.relaunch();
      app.exit(0);
      return null;

    case 'desktop_get_lan_address':
      return await detectLanIPv4Address();

    case 'desktop_new_window': {
      const config = readDesktopHostsConfig();
      const localUiUrl = state.sidecarUrl || state.localOrigin;
      let targetUrl = localUiUrl;
      if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID) {
        const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
        if (host?.url && !state.unreachableHosts.has(host.url)) {
          targetUrl = host.url;
        }
      }
      await createAdditionalWindow(targetUrl);
      return null;
    }

    case 'desktop_new_window_at_url': {
      const targetUrl = normalizeHostUrl(String(args.url || ''));
      if (!targetUrl) {
        throw new Error('Invalid URL');
      }
      await createAdditionalWindow(targetUrl);
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
        { role: 'about' },
        {
          label: 'Check for Updates',
          click: () => dispatchCheckForUpdates(),
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'Cmd+,', click: () => dispatchAction('settings') },
        { label: 'Command Palette', accelerator: 'Cmd+K', click: () => dispatchAction('command-palette') },
        { label: 'Quick Open…', accelerator: 'Cmd+P', click: () => dispatchAction('quick-open') },
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
        { label: 'Git', accelerator: 'Cmd+G', click: () => dispatchAction('open-git-tab') },
        { label: 'Diff', accelerator: 'Cmd+E', click: () => dispatchAction('open-diff-tab') },
        { label: 'Files', click: () => dispatchAction('open-files-tab') },
        { label: 'Terminal', accelerator: 'Cmd+T', click: () => dispatchAction('open-terminal-tab') },
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

// All desktop_* IPC and dialog:open run with full Electron main privileges
// (fs access, shell.openPath, spawn, app.relaunch, …). The preload shim is
// injected into every webContents in the window, including remote hosts the
// user switches to via DesktopHostSwitcher. Without a gate, a malicious
// remote page could read arbitrary local files, open arbitrary apps, etc.
//
// Strategy: commands fall into two buckets by capability, not by origin.
// Window/host-switcher operations (probe a URL, open a new window, set
// title, read the hosts list) are safe for any renderer. Filesystem,
// shell.openPath, installed-app scans, app relaunch, and file dialogs
// are gated to local senders — even the user's own remote UI shouldn't
// need them, and a compromised remote can't use them either.
const isLocalSender = (webContents) => {
  try {
    const raw = typeof webContents?.getURL === 'function' ? webContents.getURL() : '';
    if (!raw) return false;
    if (raw.startsWith('file://') || raw === 'about:blank') return true;
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (state.localOrigin) {
      try {
        const allowed = new URL(state.localOrigin);
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
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_get_app_version',
  'desktop_get_lan_address',
]);

ipcMain.handle('openchamber:invoke', async (event, command, args) => {
  if (!isLocalSender(event.sender) && !COMMANDS_SAFE_FOR_REMOTE.has(command)) {
    log.warn(`[ipc] rejected ${command} from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  return handleInvoke(browserWindow, command, args);
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
  if (options?.multiple) return result.filePaths;
  return result.filePaths[0] || null;
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !state.quitRequested) {
    return;
  }

  killSidecar();
  void sshManager.shutdownAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (state.quitConfirmed || process.platform !== 'darwin') {
    state.quitRequested = true;
    return;
  }
  event.preventDefault();
  void requestQuitWithConfirmation();
});

app.on('second-instance', (_event, argv) => {
  const urls = Array.isArray(argv)
    ? argv.filter((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`))
    : [];
  if (urls.length > 0) handleDeepLinks(urls);
  focusForegroundWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinks([url]);
});

app.on('activate', async () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length > 0) {
    const visibleWindow = windows.find((window) => window.isVisible());
    const targetWindow = visibleWindow || state.mainWindow || windows[0];
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
    return;
  }

  if (state.localOrigin) {
    const config = readDesktopHostsConfig();
    const localUiUrl = state.sidecarUrl || state.localOrigin;
    const host = config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID
      ? config.hosts.find((entry) => entry.id === config.defaultHostId)
      : null;
    const targetUrl = host?.url && !state.unreachableHosts.has(host.url) ? host.url : localUiUrl;
    await createAdditionalWindow(targetUrl);
  }
});

app.whenReady().then(async () => {
  log.info('[electron] app starting', {
    version: APP_VERSION,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  nativeTheme.themeSource = readThemeSource();
  setupAutoUpdater();

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(buildMacMenu());
  }

  const initial = extractInitialDeepLinks();
  if (initial.length > 0) handleDeepLinks(initial);

  const { initialUrl, localOrigin, bootOutcome } = await resolveInitialUrl();
  await activateMainWindow(initialUrl, localOrigin, bootOutcome);
  startQuitRiskPoller();
}).catch((error) => {
  log.error('[electron] startup failed:', error);
  app.exit(1);
});
