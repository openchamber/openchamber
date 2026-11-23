
import { app, BrowserWindow, nativeTheme, protocol, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createShellEnvironmentLoader } from './shell-environment.mjs';
import { isSplashColor } from './remote-page-policy.mjs';
import { clearAppImageArgv0FromProcessEnv } from '@openchamber/web/server/lib/inherited-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const isDev = process.env.OPENCHAMBER_ELECTRON_DEV === '1' || !app.isPackaged;

export const DEEP_LINK_PROTOCOL = 'openchamber';
export const UI_PROTOCOL = 'openchamber-ui';
const PACKAGED_APP_USER_MODEL_ID = 'dev.openchamber.desktop';
const DEV_APP_USER_MODEL_ID = 'dev.openchamber.desktop.dev';
export const APP_USER_MODEL_ID = app.isPackaged ? PACKAGED_APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
export const BACKGROUND_START_ARG = '--background';

export const getLoginItemOptions = () => {
  if (process.platform === 'win32') {
    return {
      path: process.execPath,
      args: [BACKGROUND_START_ARG],
      name: APP_USER_MODEL_ID,
    };
  }
  return {};
};

export const readLoginItemSettings = () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    return app.getLoginItemSettings(getLoginItemOptions());
  } catch {
    return null;
  }
};

export const shouldStartInBackground = (loginItemSettings = readLoginItemSettings()) => {
  return (
    process.argv.includes(BACKGROUND_START_ARG) ||
    loginItemSettings?.wasOpenedAtLogin === true
  );
};

export const startupStartedAt = performance.now();

const pendingStartupMarks = [];
let startupMarkSink = null;
export const recordEarlyStartupMark = (phase, details = {}) => {
  const mark = {
    phase,
    at: Date.now(),
    totalDurationMs: Math.max(0, performance.now() - startupStartedAt),
    ...details,
  };
  if (startupMarkSink) startupMarkSink(mark);
  else pendingStartupMarks.push(mark);
};
export const installStartupMarkSink = (sink) => {
  startupMarkSink = sink;
  for (const mark of pendingStartupMarks.splice(0)) sink(mark);
};

export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 520;
const MIN_RESTORE_WINDOW_WIDTH = 900;
const MIN_RESTORE_WINDOW_HEIGHT = 560;
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;

export const settingsFilePath = () => {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()) {
    return path.join(process.env.OPENCHAMBER_DATA_DIR.trim(), 'settings.json');
  }
  return path.join(os.homedir(), '.config', app.isPackaged ? 'openchamber' : 'openchamber-dev', 'settings.json');
};

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    console.warn('[electron] failed to read JSON file', filePath, error);
    return {};
  }
};

export const readSettingsRoot = () => {
  const root = readJsonFile(settingsFilePath());
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
};

const readPreferencesValues = () => {
  const root = readJsonFile(path.join(path.dirname(settingsFilePath()), 'preferences.json'));
  const fields = root && typeof root === 'object' && root.version === 1 && root.fields && typeof root.fields === 'object'
    ? root.fields
    : {};
  const values = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (!entry || typeof entry !== 'object') continue;
    const own = entry.surfaces && typeof entry.surfaces === 'object' ? entry.surfaces.desktop : undefined;
    if (own && typeof own === 'object' && 'value' in own) {
      values[key] = own.value;
    } else if ('value' in entry) {
      values[key] = entry.value;
    }
  }
  return values;
};

export const readThemeSource = () => {
  const settings = { ...readSettingsRoot(), ...readPreferencesValues() };
  if (settings.themeMode === 'system' || settings.useSystemTheme === true) return 'system';
  if (settings.themeMode === 'light') return 'light';
  if (settings.themeMode === 'dark') return 'dark';
  if (settings.themeVariant === 'light') return 'light';
  if (settings.themeVariant === 'dark') return 'dark';
  return 'system';
};

export const readPreferredLocale = () => {
  const settings = { ...readSettingsRoot(), ...readPreferencesValues() };
  return typeof settings.locale === 'string' ? settings.locale : 'en';
};

export const getWindowIconPath = () => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const devWindowsIcon = isDev && process.platform === 'win32';
  const iconFileName = devWindowsIcon ? 'dev-icon.ico' : process.platform === 'linux' ? 'icon.png' : 'icon.ico';
  const iconPath = isDev
    ? path.join(__dirname, 'resources', 'icons', iconFileName)
    : path.join(process.resourcesPath, 'icons', iconFileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
};

const readWindowState = () => {
  const stateValue = readSettingsRoot().desktopWindowState;
  return stateValue && typeof stateValue === 'object' ? stateValue : null;
};

export const clampWindowBoundsToVisibleWorkArea = (bounds) => {
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

let cachedMacosMajorVersion = null;

export const macosMajorVersion = () => {
  if (process.platform !== 'darwin') return 0;
  if (cachedMacosMajorVersion !== null) return cachedMacosMajorVersion;
  const raw = typeof process.getSystemVersion === 'function'
    ? process.getSystemVersion()
    : (spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout || '').trim();
  const [majorRaw, minorRaw] = raw.split('.');
  const major = Number.parseInt(majorRaw || '0', 10);
  const minor = Number.parseInt(minorRaw || '0', 10);
  cachedMacosMajorVersion = major === 10 ? minor : major;
  return cachedMacosMajorVersion;
};

let cachedMacTrafficLightPosition = null;

export const macTrafficLightPosition = () => {
  if (!cachedMacTrafficLightPosition) {
    cachedMacTrafficLightPosition = Object.freeze(macosMajorVersion() >= 26 ? { x: 14, y: 15 } : { x: 16, y: 17 });
  }
  return cachedMacTrafficLightPosition;
};

const SPLASH_DEFAULTS = { bgLight: '#FFFCF0', fgLight: '#100F0F', bgDark: '#151313', fgDark: '#CECDC3' };

const readSplashColor = (settings, key, fallback) => {
  const owned = settings.desktopSplashColors && typeof settings.desktopSplashColors === 'object'
    ? settings.desktopSplashColors[key]
    : undefined;
  const legacy = settings[`splash${key.charAt(0).toUpperCase()}${key.slice(1)}`];
  const value = typeof owned === 'string' ? owned : legacy;
  return isSplashColor(value) ? value : fallback;
};

const buildStartupSplashHtml = () => {
  const settings = readSettingsRoot();
  const splashBgLight = readSplashColor(settings, 'bgLight', SPLASH_DEFAULTS.bgLight);
  const splashFgLight = readSplashColor(settings, 'fgLight', SPLASH_DEFAULTS.fgLight);
  const splashBgDark = readSplashColor(settings, 'bgDark', SPLASH_DEFAULTS.bgDark);
  const splashFgDark = readSplashColor(settings, 'fgDark', SPLASH_DEFAULTS.fgDark);

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
        }
      }
      .stack {
        display: grid;
        justify-items: center;
        /* The window is on screen in the theme colour before this document
           paints; the logo eases in over the same 0.3s the application's own
           splash takes to ease out. */
        animation: splash-logo-in 0.3s ease-out both;
      }
      @keyframes splash-logo-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    </style>
  </head>
  <body>
    <div class="stack">
      <svg width="120" height="120" viewBox="-50 -50 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="OpenChamber loading icon">
        <!-- brand:flat-logo:start --><defs><linearGradient id="oc-logo-l" gradientUnits="userSpaceOnUse" x1="-42" y1="-20" x2="-2" y2="12"><stop offset="0" stop-color="currentColor" stop-opacity="0.025"/><stop offset="0.72" stop-color="currentColor" stop-opacity="0.143"/><stop offset="1" stop-color="currentColor" stop-opacity="0.198"/></linearGradient><linearGradient id="oc-logo-r" gradientUnits="userSpaceOnUse" x1="40" y1="3" x2="3" y2="-16"><stop offset="0" stop-color="currentColor" stop-opacity="0.071"/><stop offset="0.68" stop-color="currentColor" stop-opacity="0.174"/><stop offset="1" stop-color="currentColor" stop-opacity="0.223"/></linearGradient></defs><path d="M-41.568 -24 L-41.568 24 L0 0 Z" fill="url(#oc-logo-l)"/><path d="M41.568 -24 L0 0 L41.568 24 Z" fill="url(#oc-logo-r)"/><path d="M0 -48 L41.568 -24 L0 0 L-41.568 -24 Z" fill="currentColor" fill-opacity="0.08"/><path data-tier="0" data-rest="0.12" data-lit="0.55" d="M0 -43.2 L33.254 -24 L0 -4.8 L-33.254 -24 Z" fill="currentColor" fill-opacity="0.22"/><path data-tier="1" data-rest="0.15" data-lit="0.48" d="M0 -37.92 L24.109 -24 L0 -10.08 L-24.109 -24 Z" fill="currentColor" fill-opacity="0.27"/><path data-tier="2" data-rest="0.38" data-lit="0.85" d="M0 -32.64 L14.964 -24 L0 -15.36 L-14.964 -24 Z" fill="currentColor" fill-opacity="0.85"/><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M0 -48 L-41.568 -24 L0 0 L41.568 -24 Z"/><path d="M-41.568 -24 L-41.568 24 L0 48 L41.568 24 L41.568 -24"/><path d="M0 0 L0 48"/></g><!-- brand:flat-logo:end -->
      </svg>
    </div>
  </body>
  </html>`;
};


export const resolveMainWindowBounds = () => {
  const saved = readWindowState();
  const useSaved = Boolean(saved && typeof saved.width === 'number' && typeof saved.height === 'number');
  return {
    bounds: useSaved ? clampWindowBoundsToVisibleWorkArea(saved) : null,
    maximized: useSaved && saved.maximized === true,
  };
};

export const resolveSplashBackgroundColor = (themeSource = nativeTheme.themeSource) => {
  const settings = readSettingsRoot();
  const dark = themeSource === 'dark' || (themeSource !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark
    ? readSplashColor(settings, 'bgDark', SPLASH_DEFAULTS.bgDark)
    : readSplashColor(settings, 'bgLight', SPLASH_DEFAULTS.bgLight);
};

export const isMacMenuBarEnabled = () => (
  process.platform !== 'darwin' || readSettingsRoot().desktopMacMenuBarEnabled !== false
);

export const resolvePreloadPath = () => (
  isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs')
);

export const resolveBrowserPanelPreloadPath = () => (
  isDev ? path.join(__dirname, 'browser-panel-preload.cjs') : path.join(app.getAppPath(), 'browser-panel-preload.cjs')
);

const resolveDevUiOrigin = () => (
  isDev ? `http://127.0.0.1:${process.env.OPENCHAMBER_HMR_UI_PORT || '5173'}` : ''
);

export const buildRendererAdditionalArguments = ({
  localOrigin = '',
  devUiOrigin = resolveDevUiOrigin(),
  apiBaseUrl = '',
  clientToken = '',
  requestHeaders = {},
  bootOutcome = null,
  relayHostId = '',
  explicitRuntime = false,
  trayEnabled = isMacMenuBarEnabled(),
  nativeFrame = usesLinuxNativeFrame(),
} = {}) => [
  `--openchamber-local-origin=${localOrigin}`,
  `--openchamber-dev-ui-origin=${devUiOrigin}`,
  `--openchamber-api-base-url=${apiBaseUrl}`,
  `--openchamber-client-token=${clientToken}`,
  `--openchamber-runtime-headers=${JSON.stringify(requestHeaders)}`,
  `--openchamber-home=${os.homedir() || ''}`,
  `--openchamber-macos-major=${String(macosMajorVersion())}`,
  `--openchamber-tray-enabled=${trayEnabled ? '1' : '0'}`,
  `--openchamber-boot-outcome=${JSON.stringify(bootOutcome)}`,
  `--openchamber-relay-host-id=${relayHostId}`,
  `--openchamber-explicit-runtime=${explicitRuntime ? '1' : '0'}`,
  `--openchamber-native-frame=${nativeFrame ? '1' : '0'}`,
];

export const usesLinuxNativeFrame = () => (
  process.platform === 'linux' && readSettingsRoot().desktopLinuxNativeFrame === true
);

export const usesFramelessChrome = () => (
  process.platform === 'win32' || (process.platform === 'linux' && !usesLinuxNativeFrame())
);

export const buildMainWindowOptions = ({ bounds, backgroundColor, additionalArguments }) => {
  const usesCustomTitleBar = process.platform === 'darwin' || usesFramelessChrome();
  const options = {
    title: 'OpenChamber',
    width: bounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: bounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: getWindowIconPath(),
    show: false,
    backgroundColor,
    frame: usesLinuxNativeFrame(),
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: usesCustomTitleBar ? 'hidden' : 'default',
    titleBarOverlay: false,
    trafficLightPosition: process.platform === 'darwin' ? macTrafficLightPosition() : undefined,
    acceptFirstMouse: true,
    webPreferences: {
      additionalArguments,
      preload: resolvePreloadPath(),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  };
  if (Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y)) {
    options.x = bounds.x;
    options.y = bounds.y;
  }
  return options;
};

export const shouldUsePackagedUi = () => {
  if (process.env.OPENCHAMBER_ELECTRON_LOAD_SERVER_UI === '1') return false;
  if (process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1') return true;
  return app.isPackaged;
};

const SPLASH_PATHNAME = '/__splash';
let packagedUiRequestHandler = null;
let packagedUiSchemeRegistered = false;

const registerPackagedUiScheme = () => {
  if (packagedUiSchemeRegistered) return;
  packagedUiSchemeRegistered = true;
  protocol.handle(UI_PROTOCOL, (request) => {
    if (new URL(request.url).pathname === SPLASH_PATHNAME) {
      return new Response(buildStartupSplashHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (!packagedUiRequestHandler) return new Response('', { status: 503 });
    return packagedUiRequestHandler(request);
  });
};

export const installPackagedUiRequestHandler = (handler) => {
  packagedUiRequestHandler = handler;
  registerPackagedUiScheme();
};

export const buildStartupSplashUrl = () => (
  shouldUsePackagedUi()
    ? `${UI_PROTOCOL}://app${SPLASH_PATHNAME}`
    : `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupSplashHtml())}`
);

export const isStartupSplashUrl = (url) => url.startsWith('data:') || url.endsWith(SPLASH_PATHNAME);

const EARLY_WINDOW_SHOW_WAIT_MS = 500;
let pendingEarlyWindow = null;
let earlyWindowClosed = false;

export const wasEarlyWindowClosed = () => earlyWindowClosed;

export const createEarlyWindow = () => {
  nativeTheme.themeSource = readThemeSource();
  if (shouldUsePackagedUi()) registerPackagedUiScheme();
  const { bounds, maximized } = resolveMainWindowBounds();
  const browserWindow = new BrowserWindow(buildMainWindowOptions({
    bounds,
    backgroundColor: resolveSplashBackgroundColor(),
    additionalArguments: buildRendererAdditionalArguments(),
  }));
  recordEarlyStartupMark('electron.window.created');
  if (maximized) browserWindow.maximize();
  browserWindow.show();
  browserWindow.focus();
  let markShown;
  const early = {
    browserWindow,
    maximized,
    whenShown: new Promise((resolve) => {
      const timer = setTimeout(resolve, EARLY_WINDOW_SHOW_WAIT_MS);
      markShown = () => {
        clearTimeout(timer);
        resolve();
      };
    }),
  };
  browserWindow.once('ready-to-show', () => {
    recordEarlyStartupMark('electron.window.ready-to-show', { documentClass: 'splash' });
    markShown();
  });
  browserWindow.once('closed', () => {
    if (pendingEarlyWindow !== early) return;
    pendingEarlyWindow = null;
    earlyWindowClosed = true;
    app.quit();
  });
  recordEarlyStartupMark('electron.navigation.start', { documentClass: 'splash' });
  browserWindow.loadURL(buildStartupSplashUrl()).then(() => {
    recordEarlyStartupMark('electron.navigation.ready', { documentClass: 'splash' });
  }).catch(() => {
    // The main module navigates the window to the application as soon as the
    // backend resolves, which aborts a splash still loading.
  });
  pendingEarlyWindow = early;
  return early;
};

export const takeEarlyWindow = () => {
  const early = pendingEarlyWindow;
  pendingEarlyWindow = null;
  return early && !early.browserWindow.isDestroyed() ? early : null;
};

const deferredAppEvents = [];
const onEarlyOpenUrl = (event, url) => {
  event.preventDefault();
  deferredAppEvents.push({ type: 'open-url', url });
};
const onEarlySecondInstance = (_event, argv) => {
  deferredAppEvents.push({ type: 'second-instance', argv });
};

export const deferAppEventsUntilMainLoads = () => {
  app.on('open-url', onEarlyOpenUrl);
  app.on('second-instance', onEarlySecondInstance);
};

export const takeDeferredAppEvents = () => {
  app.off('open-url', onEarlyOpenUrl);
  app.off('second-instance', onEarlySecondInstance);
  return deferredAppEvents.splice(0);
};

const queryWindowsRegistryValue = (key, name) => {
  const result = spawnSync('reg.exe', ['query', key, '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
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

export const shellEnvironmentAbort = new AbortController();
const loadShellEnv = createShellEnvironmentLoader({ loadWindowsEnv, signal: shellEnvironmentAbort.signal });

export const shellEnvironmentProbeBlocksMainThread = process.platform === 'win32';

// external: #2588 Clear AppImage ARGV0 before shell discovery because zsh applies it to child argv[0].
export const startShellEnvironmentProbe = () => {
  clearAppImageArgv0FromProcessEnv();
  return loadShellEnv();
};
