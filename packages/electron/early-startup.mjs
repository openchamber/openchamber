/**
 * What the entry module needs before `main.mjs` loads: app identity, the
 * first window on the splash, the login-shell probe, and the marks and app
 * events that main picks up later. Imported by the entry before the rest of
 * the main process, so it must stay small: Electron, Node built-ins and the
 * two tiny helpers below, no electron-log, no server code.
 *
 * Electron holds `ready` until the entry module's whole graph has evaluated,
 * and the main bundle takes a few hundred milliseconds of main-thread time to
 * load and set up. The entry module creates the window on the splash the
 * moment `ready` fires; `main.mjs` adopts it through `takeEarlyWindow()` and
 * attaches everything else. Both bundles must share this one module instance
 * (it stays external in `scripts/bundle-main.mjs`), or the handoff slots
 * below would be two different objects.
 *
 * The helpers here are also the main bundle's only copy: settings reading,
 * window state, splash markup and window options live here so the early
 * window and a later main window cannot drift apart.
 */

import { app, BrowserWindow, nativeTheme, protocol, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createShellEnvironmentLoader } from './shell-environment.mjs';
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
    loginItemSettings?.wasOpenedAtLogin === true ||
    loginItemSettings?.wasOpenedAsHidden === true
  );
};

// Startup clock shared by every process-lifetime mark: the entry module
// evaluates this import first, so this is as close to "our code started" as
// the main process can observe.
export const startupStartedAt = performance.now();

// Marks recorded before the logger exists are held until `main.mjs` installs
// its `[startup-performance]` sink; later marks (a splash that becomes ready
// after main loaded) go straight to it.
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
  return path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
};

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    // Parse errors can happen if a concurrent writer just truncated the file
    // and hasn't finished writing yet. Log loudly so we notice, then return
    // {} as before. Writes are atomic (tmp + rename) so this race is rare.
    console.warn('[electron] failed to read JSON file', filePath, error);
    return {};
  }
};

export const readSettingsRoot = () => {
  const root = readJsonFile(settingsFilePath());
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
};

// The user's profile (theme mode among it) lives in preferences.json beside
// settings.json since the settings split; each entry is { value, updatedAt }.
// Installs that predate the split still carry those keys in settings.json, so
// readers merge both, preferences winning.
const readPreferencesValues = () => {
  const root = readJsonFile(path.join(path.dirname(settingsFilePath()), 'preferences.json'));
  const fields = root && typeof root === 'object' && root.version === 1 && root.fields && typeof root.fields === 'object'
    ? root.fields
    : {};
  // Per-surface keys (theme mode among them) are resolved for the desktop
  // shell: its own value first, the base value otherwise.
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

export const getWindowIconPath = () => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const iconFileName = process.platform === 'linux' ? 'icon.png' : 'icon.ico';
  const iconPath = isDev
    ? path.join(__dirname, 'resources', 'icons', iconFileName)
    : path.join(process.resourcesPath, 'icons', iconFileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
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

export const macosMajorVersion = () => {
  if (process.platform !== 'darwin') return 0;
  const result = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  const raw = (result.stdout || '').trim();
  const [majorRaw, minorRaw] = raw.split('.');
  const major = Number.parseInt(majorRaw || '0', 10);
  const minor = Number.parseInt(minorRaw || '0', 10);
  return major === 10 ? minor : major;
};

const SPLASH_DEFAULTS = { bgLight: '#FFFCF0', fgLight: '#100F0F', bgDark: '#151313', fgDark: '#CECDC3' };

const readSplashColor = (settings, key, fallback) => {
  // The renderer hands the colours over IPC (desktop_set_window_theme) and
  // main stores them under `desktopSplashColors`; the flat `splash*` keys are
  // what builds before the settings split wrote and are read as a fallback.
  const owned = settings.desktopSplashColors && typeof settings.desktopSplashColors === 'object'
    ? settings.desktopSplashColors[key]
    : undefined;
  const legacy = settings[`splash${key.charAt(0).toUpperCase()}${key.slice(1)}`];
  const value = typeof owned === 'string' ? owned : legacy;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

const buildStartupSplashHtml = () => {
  const settings = readSettingsRoot();
  // Defaults match packages/web/index.html, which shows the same logo next
  // and must not look different: the renderer overwrites both from the theme.
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
        --splash-face-fill: rgba(0, 0, 0, 0.15);
        --splash-cell-fill: rgba(0, 0, 0, 0.35);
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


export const resolveMainWindowBounds = () => {
  const saved = readWindowState();
  const useSaved = Boolean(saved && typeof saved.width === 'number' && typeof saved.height === 'number');
  return {
    bounds: useSaved ? clampWindowBoundsToVisibleWorkArea(saved) : null,
    maximized: useSaved && saved.maximized === true,
  };
};

// The splash background for the theme the window will open in, so the frame
// Chromium paints before the splash never flashes a foreign colour.
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

// Arguments the preload reads from process.argv. They are fixed at window
// creation: the main window is created before the backend resolves, so it
// carries empty runtime values and receives them through the init script.
export const buildRendererAdditionalArguments = ({
  localOrigin = '',
  apiBaseUrl = '',
  clientToken = '',
  requestHeaders = {},
  bootOutcome = null,
  relayHostId = '',
  trayEnabled = isMacMenuBarEnabled(),
} = {}) => [
  `--openchamber-local-origin=${localOrigin}`,
  `--openchamber-api-base-url=${apiBaseUrl}`,
  `--openchamber-client-token=${clientToken}`,
  `--openchamber-runtime-headers=${JSON.stringify(requestHeaders)}`,
  `--openchamber-home=${os.homedir() || ''}`,
  `--openchamber-macos-major=${String(macosMajorVersion())}`,
  `--openchamber-tray-enabled=${trayEnabled ? '1' : '0'}`,
  `--openchamber-boot-outcome=${JSON.stringify(bootOutcome)}`,
  `--openchamber-relay-host-id=${relayHostId}`,
];

export const usesFramelessChrome = process.platform === 'win32' || process.platform === 'linux';

export const buildMainWindowOptions = ({ bounds, backgroundColor, additionalArguments }) => {
  const usesCustomTitleBar = process.platform === 'darwin' || usesFramelessChrome;
  const options = {
    title: 'OpenChamber',
    width: bounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: bounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: getWindowIconPath(),
    show: false,
    backgroundColor,
    frame: usesFramelessChrome ? false : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    // Electron's hiddenInset adds its own extra inset, which leaves the controls
    // visibly lower than the app header. Use a plain hidden title bar instead.
    titleBarStyle: usesCustomTitleBar ? 'hidden' : 'default',
    titleBarOverlay: false,
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      additionalArguments,
      preload: resolvePreloadPath(),
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
  // Without a saved position Electron centers the window on the primary display.
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

// The splash lives on the application's own origin whenever the application
// is served from it. A splash on a data: URL is a different origin, so the
// navigation to the application swaps renderer processes and Chromium may
// show an empty frame in between; within one origin it keeps the previous
// frame until the new document has painted.
const SPLASH_PATHNAME = '/__splash';
let packagedUiRequestHandler = null;
let packagedUiSchemeRegistered = false;

// Registered once, by whichever comes first: the early window (it loads the
// splash from this scheme) or main.mjs installing the application handler
// (a background start has no early window). The splash is answered here,
// everything else goes to that handler; nothing asks for the application
// before main is loaded, because the splash has no subresources.
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

const EARLY_WINDOW_SHOW_WAIT_MS = 500;
let pendingEarlyWindow = null;
let earlyWindowClosed = false;

// True once the user closed the first window before main.mjs adopted it: the
// app is quitting, and main must not open another window on its way out.
export const wasEarlyWindowClosed = () => earlyWindowClosed;

// Creates and shows the main window on the splash. Called from the entry
// module the moment Electron is ready; `main.mjs` adopts it later.
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
  // Shown at once in the theme colour, so the first thing on screen appears
  // before the splash document has painted; the logo then fades in.
  browserWindow.show();
  browserWindow.focus();
  let markShown;
  const early = {
    browserWindow,
    maximized,
    // Resolves once the splash document has painted; bounded, because a
    // renderer that never reports ready-to-show must not hold the rest of startup.
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
  // Closing the only window before the rest of the app has adopted it is a quit.
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

// App events that can fire before `main.mjs` has registered its handlers: a
// deep link the app was launched with, or a second launch during startup.
// Buffered here and replayed by the main module once it takes them.
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
// One shared probe that the backend awaits before it starts. The entry module
// starts it as early as it can so the user's shell startup files run while
// the window comes up instead of on the critical path; on Windows the loader
// is synchronous registry reads, so it waits until the splash is on screen.
export const shellEnvironmentAbort = new AbortController();
const loadShellEnv = createShellEnvironmentLoader({ loadWindowsEnv, signal: shellEnvironmentAbort.signal });

export const shellEnvironmentProbeBlocksMainThread = process.platform === 'win32';

// Clear before probing/merging so login-shell snapshots and children never
// inherit the AppImage path as argv[0] via zsh's ARGV0 parameter (#2588).
export const startShellEnvironmentProbe = () => {
  clearAppImageArgv0FromProcessEnv();
  return loadShellEnv();
};
