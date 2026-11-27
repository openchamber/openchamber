import { canReuseManagedOpenCodePreflight } from './opencode-readiness.mjs';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, MessageChannelMain, nativeTheme, net as electronNet, Notification, powerMonitor, powerSaveBlocker, protocol, screen, session, shell, systemPreferences, webContents } from 'electron';
import contextMenu from 'electron-context-menu';
import log from 'electron-log/main.js';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import updaterPkg from 'electron-updater';
import { createDesktopIdleUpdate } from './idle-update-window.mjs';
import { installDownloadedDesktopUpdate } from './update-install.mjs';
import { z } from 'zod';
import { ElectronSshManager } from './ssh-manager.mjs';
import { collectLocalFileDiagnostics, collectSshBufferDiagnostics } from '@openchamber/web/server/lib/diagnostics/local-files.js';
import { readJsonObjectForUpdate, replaceFileWithRetry } from './windows-file-replace.mjs';
import { persistMainWindowState } from './window-state.mjs';
import { createContextWindowController } from './context-window-controller.mjs';
import { createWindowGeometryState } from './window-geometry-state.mjs';
import { attachWindowEvents, isNativeWindowVisible } from './window-events.mjs';
import { createTrayController, createTrayLocaleRouter } from './tray.mjs';
import { buildDockMenuTemplate, buildUnreadJumpList, isJumpListSessionId } from './dock-menu.mjs';
import { createSessionLinkGate } from './session-link-gate.mjs';
import { applyDevDockIdentity, applyDockBadge } from './dev-dock-identity.mjs';
import { attachDevWindowTape } from './dev-window-tape.mjs';
import { resolveManagedOpenCodeCwd } from './opencode-cwd.mjs';
import { stopEmbeddedServer } from './server-shutdown.mjs';
import { describeStartupEnvironmentOverrides, resolveStartupUrlProbePlan } from './startup-url-selection.mjs';
import { clearAppCache } from './app-cache.mjs';
import { hideWindow, isWindowHidePending, showWindow } from './window-hide.mjs';
import { parseExternalUrl } from './external-url-policy.mjs';
import { createBrowserPanelDriver } from './browser-panel-driver.mjs';
import {
  BACKGROUND_START_ARG,
  DEEP_LINK_PROTOCOL,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  UI_PROTOCOL,
  buildMainWindowOptions,
  buildRendererAdditionalArguments,
  buildStartupSplashUrl,
  isStartupSplashUrl,
  getLoginItemOptions,
  getWindowIconPath,
  installPackagedUiRequestHandler,
  installStartupMarkSink,
  isDev,
  isMacMenuBarEnabled,
  macTrafficLightPosition,
  macosMajorVersion,
  readLoginItemSettings,
  readSettingsRoot,
  readPreferredLocale,
  readThemeSource,
  resolveMainWindowBounds,
  resolveBrowserPanelPreloadPath,
  resolvePreloadPath,
  resolveSplashBackgroundColor,
  settingsFilePath,
  shellEnvironmentAbort,
  shouldStartInBackground,
  shouldUsePackagedUi,
  startShellEnvironmentProbe,
  startupStartedAt,
  takeDeferredAppEvents,
  takeEarlyWindow,
  usesFramelessChrome,
  usesLinuxNativeFrame,
  wasEarlyWindowClosed,
} from './early-startup.mjs';
import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';
import {
  LOCAL_HOST_ID,
  buildStoredHostEntry,
  normalizeHostUrl,
  sanitizeClientTokenForStorage,
  sanitizeHostRelayForStorage,
} from './desktop-hosts-storage.mjs';
import { createBrowserPanelAgentActions } from './browser-panel-agent-actions.mjs';
import { createBrowserPanelWindowOpen } from './browser-panel-window-open.mjs';
import { COMMANDS_SAFE_FOR_REMOTE, isSplashColor, parseTrayLocale, redactHostsConfigForRemote } from './remote-page-policy.mjs';
import { connectDefaultSshInstanceAtStartup, resolveDefaultSshInstanceId } from './startup-ssh.mjs';
import { findReusableHostWindowIndex, normalizeNotificationInput, readTrimmedString, resolveHostEntryForRuntimeKey, resolveWindowHostId, runtimeKeyForDeepLinkHost, stampForwardedNotification } from './notification-host-routing.mjs';
import { isPackagedUiRuntimeRequest } from './packaged-ui-routing.mjs';
import { openWindowProjectInSshEditor } from './ssh-editor-url.mjs';
import { RUNTIME_CONFIG_SCRIPT, RUNTIME_CONFIG_SCRIPT_PATHNAME, createRuntimeConfigGate, injectRuntimeConfig, isRuntimeConfigFrame } from './packaged-runtime-config.mjs';
import { settleMainProcessCompileCache } from './compile-cache.mjs';
import { probeDirectHostWithRetry } from './host-probe-policy.mjs';
import { probeElectronHostWithDeadline } from './electron-host-probe.mjs';
import { requestRemoteHostUpdate } from './remote-host-update.mjs';
import { assertUpdaterCapability, enableMacosDirectContentsUpdates, readLinuxPackageType } from './updater-capability.mjs';
import { relaunchAfterExit } from './linux-relaunch.mjs';
import { installLinuxPackage } from './linux-package-install.mjs';
import { checkForDesktopUpdate, markDesktopUpdateDownloaded } from './updater-check.mjs';
import { downloadDesktopUpdateWithProgress, handleDesktopUpdatePreferenceCommand, isAutoUpdateSupported, readAutoUpdateEnabled, startBackgroundDesktopUpdateDownload, tryInstallUpdateOnQuit } from './auto-update.mjs';
import { resolveUpdaterChannel } from './updater-channel.mjs';
import { convertShortcutComboToAccelerator, MINI_CHAT_GLOBAL_SHORTCUT_SETTING_KEY, normalizeStoredShortcutCombo, selectMiniChatGlobalShortcutAction } from './mini-chat-global-shortcut.mjs';
import {
  computeQuakeBounds,
  getQuakeDisplayBounds,
  parseQuakeHeightFraction,
  QUAKE_MODE_ENABLED_KEY,
  QUAKE_MODE_HEIGHT_KEY,
  QUAKE_MODE_SHORTCUT_KEY,
  QUAKE_MODE_UNASSIGNED,
  readQuakeModeSettings,
  selectQuakeToggleAction,
} from './quake-mode.mjs';
import { createContextMenuLabels, menuLabel, normalizeMenuLocale, roleMenuItem } from './menu-locales.mjs';
import { menuAccelerator, normalizeMenuShortcuts } from './menu-shortcuts.mjs';
import { createCopyLinkMenuHook } from './context-menu-clipboard.mjs';
import { createCopyMenuAction } from './menu-copy-action.mjs';
import {
  CANARY_MIRROR_UPDATER_FEED,
  CANARY_UPDATER_FEED,
  PRODUCTION_UPDATER_FEED,
  STABLE_MIRROR_UPDATER_FEED,
  isCanaryVersion,
  isUpdateChannel,
  normalizeUpdateChannel,
  pickUpdaterSource,
  resolveUpdaterFeed,
} from './updater-feed.mjs';
import {
  buildLinuxInstalledApps,
  buildLinuxOpenSpecs,
  runLinuxSpecChain,
  fetchLinuxAppIcons,
  filterLinuxInstalledApps,
  readLinuxDesktopEntries,
} from './linux-app-discovery.mjs';
import { createWindowsAppDiscovery } from './windows-app-discovery.mjs';
import {
  readLinuxAutostartEnabled,
  setLinuxAutostartEnabled,
} from './linux-autostart.mjs';
import { reconcileAppImageDesktopEntry } from './linux-desktop-entry.mjs';
import { unsupportedAppSpecificOpenError, validateLocalPath } from './path-open-utils.mjs';
import { keepSessionCookies } from './browser-panel-cookies.mjs';
import {
  applyBrowserPanelUserAgent,
  browserPanelPermissionAuditDetails,
  shouldAllowBrowserPanelCertificateError,
  shouldAllowBrowserPanelPermission,
} from './browser-panel-security.mjs';
import { browserPanelKeyAction, browserPanelMouseAction, runBrowserPanelAction } from './browser-panel-navigation.mjs';
import { isSpaceId, spaceIdOfPreviewPartition, spacePreviewPartition, spacePreviewProxyConfig } from './space-preview.mjs';
import { attachWindowNavigationGuards } from './window-navigation-guards.mjs';
import { createRelayDevTunnelBridge } from './relay-dev-tunnel.mjs';
import { parsePairingDeepLink } from './pairing-deep-link.mjs';
import { attachRendererRecovery, takeSafeStart } from './renderer-recovery.mjs';
import { createLoadFailureWarningFilter } from './load-failure-warnings.mjs';
import { mintOutsideFileGrant } from '@openchamber/web/server/lib/fs/routes.js';
import { openWindowsFolder } from '@openchamber/web/server/lib/fs/windows-shell-open.js';
import { fetchUpdateNotes } from '@openchamber/web/server/lib/changelog/update-notes.js';
import { compareVersions } from '@openchamber/web/server/lib/version-order.js';
import { applyConnectAttemptTimeout } from '@openchamber/web/server/lib/network-defaults.js';
import { isNetworkAccessBlocked } from '@openchamber/web/server/lib/enterprise-mode.js';
import { assignInjectedEnv } from '@openchamber/web/server/lib/injected-env.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// external: #3399 Increase Node auto-family connection timeout because 250 ms aborts handshakes to distant providers.
applyConnectAttemptTimeout();

try {
  process.chdir(os.homedir());
} catch {
}

log.initialize();
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';

Object.assign(console, log.functions);

const printProcessWarning = process.listeners('warning').find((listener) => listener.name === 'onWarning');
if (printProcessWarning) {
  const shouldReportWarning = createLoadFailureWarningFilter();
  process.off('warning', printProcessWarning);
  process.on('warning', (warning) => {
    if (shouldReportWarning(warning)) printProcessWarning(warning);
    else log.debug(`electron: ${warning.message}`);
  });
}

const STARTUP_PERF_ENABLED_VALUES = new Set(['1', 'true']);
const ELECTRON_STARTUP_PERF_PHASES = new Set([
  'electron.entry',
  'electron.app.ready',
  'electron.window.created',
  'electron.main.loaded',
  'electron.server.start',
  'electron.server.ready',
  'electron.navigation.start',
  'electron.navigation.ready',
  'electron.renderer.dom-ready',
  'electron.renderer.loaded',
  'electron.window.ready-to-show',
]);
const ELECTRON_STARTUP_DOCUMENT_CLASSES = new Set(['splash', 'application']);
const logElectronStartupEvent = ({ phase, at, totalDurationMs, durationMs, documentClass }) => {
  const enabled = STARTUP_PERF_ENABLED_VALUES.has(String(process.env.OPENCHAMBER_STARTUP_PERF ?? '').toLowerCase());
  if (!enabled || !ELECTRON_STARTUP_PERF_PHASES.has(phase)) return;
  const event = { phase, at, totalDurationMs };
  if (Number.isFinite(durationMs) && durationMs >= 0) event.durationMs = durationMs;
  if (ELECTRON_STARTUP_DOCUMENT_CLASSES.has(documentClass)) event.documentClass = documentClass;
  log.info('[startup-performance]', event);
};
const recordElectronStartupPerformance = (phase, details = {}) => {
  logElectronStartupEvent({
    phase,
    at: Date.now(),
    totalDurationMs: Math.max(0, performance.now() - startupStartedAt),
    durationMs: details.durationMs,
    documentClass: details.documentClass,
  });
};
installStartupMarkSink(logElectronStartupEvent);
recordElectronStartupPerformance('electron.main.loaded');
const classifyStartupDocument = (url) => String(url || '').startsWith('data:') ? 'splash' : 'application';

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
const MINI_CHAT_WINDOW_WIDTH = 520;
const MINI_CHAT_WINDOW_HEIGHT = 760;
const MINI_CHAT_MIN_WINDOW_WIDTH = 360;
const MINI_CHAT_MIN_WINDOW_HEIGHT = 480;
const MAX_CAPTURE_PAGE_RECT_AREA = 4_000_000;
const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';
const REMOTE_DESKTOP_CLIENT_KIND = 'desktop';
const ENV_OVERRIDE_HOST_ID = '__env';
const GITHUB_BUG_REPORT_URL = 'https://github.com/openchamber/openchamber/issues/new?template=bug_report.yml';
const GITHUB_FEATURE_REQUEST_URL = 'https://github.com/openchamber/openchamber/issues/new?template=feature_request.yml';
const DISCORD_INVITE_URL = 'https://discord.gg/ZYRSdnwwKA';
const INSTALLED_APPS_CACHE_TTL_SECS = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE = 'discovered-apps.json';
const INSTALLED_APPS_CACHE_VERSION = 3;
const LINUX_DESKTOP_ENTRIES_CACHE_TTL_MS = 30_000;
const OPENCODE_SHUTDOWN_GRACE_MS = 100;
const { autoUpdater } = updaterPkg;

const state = {
  serverHandle: null,
  sidecarUrl: null,
  localUiUrl: null,
  localOrigin: null,
  apiBaseUrl: null,
  clientToken: null,
  requestHeaders: {},
  bootOutcome: null,
  startupResolved: false,
  initScript: null,
  earlyNavigation: null,
  mainWindow: null,
  quitRequested: false,
  quitConfirmed: false,
  quitInProgress: false,
  quitConfirmationPending: false,
  backgroundShutdownComplete: false,
  backgroundShutdownPromise: null,
  sshShutdownPromise: null,
  installingUpdate: false,
  updateInstallPending: false,
  pendingUpdate: null,
  updaterChannel: null,
  updaterSource: null,
  updaterMirrorFailedAt: null,
  updateCheck: null,
  updateDownloadPromise: null,
  updateDownloadVersion: null,
  unreachableHosts: new Set(),
  windowCounter: 1,
  quakeActive: false,
  quakeNormalBounds: null,
  quakeNormalMaximized: false,
  focusedWindowIds: new Set(),
  miniChatWindowsBySession: new Map(),
  sshStatuses: new Map(),
  sshLogs: new Map(),
  trayController: null,
  trayFocusListener: null,
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
  const supported = process.platform === 'win32' || process.platform === 'linux';
  return {
    supported,
    enabled: supported && readSettingsRoot().desktopMinimizeToTrayEnabled === true,
  };
};

const shouldHideMainWindowToTray = (browserWindow) => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return false;
  if (!state.trayController) return false;
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  if (browserWindow.__ocMiniChat === true || browserWindow.__ocContextWindowOwnerId) return false;
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
  if (!state.backgroundShutdownPromise) {
    setDesktopKeepAwakeActive(false);
    shellEnvironmentAbort.abort();
    state.backgroundShutdownPromise = Promise.all([
      startShellEnvironmentProbe().catch(() => {}),
      killSidecar(),
      shutdownSshSessions(),
    ]).finally(() => {
      state.backgroundShutdownComplete = true;
    });
  }
  return state.backgroundShutdownPromise;
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

const RENDERER_STORAGE_FLUSH_TIMEOUT_MS = 500;

const flushRendererStorage = async () => {
  const pages = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => window.webContents
      .executeJavaScript("window.dispatchEvent(new Event('openchamber:flush-persisted-state'))", true)
      .catch(() => undefined));
  const browsingSessions = BROWSING_PARTITIONS.map((partition) => session.fromPartition(partition));
  const panelCookies = browsingSessions.map((browsingSession) => keepSessionCookies(browsingSession.cookies, {
    onError: (error) => log.warn('[electron] could not keep a browser panel session cookie:', error?.message || error),
  })
    .then(() => browsingSession.cookies.flushStore())
    .catch((error) => {
      log.warn('[electron] browser panel cookie flush before quit failed:', error);
    }));
  await Promise.race([
    Promise.all([...pages, ...panelCookies]),
    new Promise((resolve) => setTimeout(resolve, RENDERER_STORAGE_FLUSH_TIMEOUT_MS)),
  ]);
  for (const storageSession of [session.defaultSession, ...browsingSessions]) {
    try {
      storageSession.flushStorageData();
    } catch (error) {
      log.warn('[electron] storage flush before quit failed:', error);
    }
  }
};

const prepareForQuit = () => {
  void idleUpdateController.stop();
  state.quitRequested = true;
  state.quitConfirmed = true;
  state.installingUpdate = false;
  state.quitConfirmationPending = false;

  if (state.trayController) {
    try {
      state.trayController.destroy();
    } catch {
    }
    state.trayController = null;
  }
  if (state.trayFocusListener) {
    app.removeListener('browser-window-focus', state.trayFocusListener);
    state.trayFocusListener = null;
  }
  try {
    globalShortcut.unregisterAll();
  } catch {
  }
  if (state.miniChatFocusListener) {
    app.removeListener('browser-window-focus', state.miniChatFocusListener);
    state.miniChatFocusListener = null;
  }

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      debounceWindowStatePersist(state.mainWindow, true);
    } catch {
    }
  }

  setDesktopKeepAwakeActive(false);

  return Promise.all([flushRendererStorage(), shutdownBackgroundServices()]);
};

const isLinuxPackageInstall = () => process.platform === 'linux'
  && app.isPackaged
  && ['deb', 'rpm'].includes(readLinuxPackageType());

const devRelaunchExitCode = Number(process.env.OPENCHAMBER_ELECTRON_DEV_RELAUNCH_EXIT_CODE) || null;

const relaunchApp = () => {
  if (devRelaunchExitCode) return devRelaunchExitCode;
  if (isLinuxPackageInstall()) relaunchAfterExit();
  else app.relaunch();
  return 0;
};

const performConfirmedQuit = async ({ relaunch = false, installOnQuit = true } = {}) => {
  if (state.updateInstallPending) {
    log.info('[electron] quit suppressed: update install owns the exit');
    return;
  }
  if (state.quitInProgress) return;
  state.quitInProgress = true;

  try {
    await prepareForQuit();
  } catch (error) {
    log.warn('[electron] background shutdown failed:', error);
  } finally {
    if (!relaunch && installOnQuit && tryInstallUpdateOnQuit({
      app, autoUpdater, state, log, readAutoUpdateEnabled: isDesktopAutoUpdateEnabled, isLinuxPackageInstall,
      onFallbackExit: () => app.exit(0),
    })) {
      return;
    }
    app.exit(relaunch ? relaunchApp() : 0);
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void performConfirmedQuit({ installOnQuit: false });
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
      showWindow(hidden);
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

const sshManager = new ElectronSshManager({
  settingsFilePath: settingsFilePath(),
  appVersion: APP_VERSION,
  emit: (event, detail) => emitToAllWindows(event, detail),
});

const writeJsonFile = async (filePath, data) => {
  const directory = path.dirname(filePath);
  const created = await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (created && process.platform !== 'win32') await fsp.chmod(directory, 0o700);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') await fsp.chmod(tmp, 0o600);
    await replaceFileWithRetry(tmp, filePath);
    if (process.platform !== 'win32') await fsp.chmod(filePath, 0o600);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

let settingsMutationChain = Promise.resolve();
const mutateSettingsRoot = (mutator) => {
  const next = settingsMutationChain.then(async () => {
    const current = await readJsonObjectForUpdate(settingsFilePath());
    const result = await mutator(current);
    const nextRoot = result ?? current;
    await writeJsonFile(settingsFilePath(), nextRoot);
  });
  settingsMutationChain = next.catch(() => {});
  return next;
};

const writeSettingsRoot = async (root) => writeJsonFile(settingsFilePath(), root);

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
    if (typeof root.desktopInstallId === 'string' && root.desktopInstallId.trim()) return root;
    root.desktopInstallId = generated;
    return root;
  });
  const after = readSettingsRoot().desktopInstallId;
  return typeof after === 'string' && after.trim() ? after.trim() : generated;
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
  try {
    const target = new URL(targetUrl);
    const local = new URL(localUrl);
    const portOf = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');
    return portOf(target) === portOf(local) && isMachineLocalHostname(target.hostname);
  } catch {
    return false;
  }
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

const writeWindowState = async (browserWindow) => {
  await persistMainWindowState({
    browserWindow,
    mainWindowId: state.mainWindow?.id,
    quakeActive: state.quakeActive,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    mutateSettingsRoot,
  });
};

const windowGeometryState = createWindowGeometryState({ persist: writeWindowState });
const debounceWindowStatePersist = (browserWindow, immediate = false) => {
  windowGeometryState.schedule(browserWindow, immediate);
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

const probeHostWithTimeout = async (url, timeoutMs, clientToken = '', requestHeaders = {}, expectedServerId = '') => {
  return probeElectronHostWithDeadline({
    url,
    timeoutMs,
    clientToken,
    requestHeaders,
    expectedServerId,
    chromiumFetch: (requestUrl, options) => electronNet.fetch(requestUrl, options),
    isReady: () => app.isReady(),
  });
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
const packagedUiOrigin = () => `${UI_PROTOCOL}://app`;
const buildPackagedUiUrl = (pathname = '/index.html') => new URL(pathname, `${packagedUiOrigin()}/`).toString();

const runtimeConfigGate = createRuntimeConfigGate();

const initialStartup = Promise.withResolvers();

const injectRuntimeConfigIntoHtml = (html) => injectRuntimeConfig(html, { pending: runtimeConfigGate.isHeld() });

const BROWSER_PANEL_PARTITION = 'persist:openchamber-browser';
const BROWSER_AGENT_PARTITION = 'persist:openchamber-browser-agent';
const BROWSING_PARTITIONS = [BROWSER_PANEL_PARTITION, BROWSER_AGENT_PARTITION];
const isBrowsingSession = (candidate) => BROWSING_PARTITIONS.some((partition) => candidate === session.fromPartition(partition));

const MAX_FAVICON_BYTES = 512 * 1024;
const FAVICON_MIME_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const resolveBrowserPanelContents = (rawId) => {
  const id = Number.isFinite(rawId) ? Math.trunc(rawId) : null;
  if (id === null || id < 0) throw new Error('webContentsId is required');
  const target = webContents.fromId(id);
  if (!target || target.isDestroyed()) throw new Error('WebContents not found');
  if (!isPanelSession(target.session)) {
    throw new Error('That view is not a browser panel page');
  }
  return target;
};

const browserPanelDriver = createBrowserPanelDriver();

const browserPanelAgentActions = createBrowserPanelAgentActions();
const browserPanelWindowOpen = createBrowserPanelWindowOpen({ BrowserWindow, log, isBrowsingSession, agentActions: browserPanelAgentActions });
const isBrowserPanelPopup = browserPanelWindowOpen.isBrowserPanelPopup;
const browserAgentActionSchema = z.object({ active: z.boolean(), sessionId: z.string().min(1).max(256).nullable().optional() });

const BROWSER_UPLOAD_ROOT = path.join(app.getPath('temp'), 'openchamber-browser-uploads');
const BROWSER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const BROWSER_UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
let browserUploadsPruned = false;

const pruneBrowserUploads = async () => {
  if (browserUploadsPruned) return;
  browserUploadsPruned = true;
  const entries = await fsp.readdir(BROWSER_UPLOAD_ROOT).catch(() => []);
  const cutoff = Date.now() - BROWSER_UPLOAD_KEEP_MS;
  await Promise.all(entries.map(async (entry) => {
    const folder = path.join(BROWSER_UPLOAD_ROOT, entry);
    const stat = await fsp.stat(folder).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
  }));
};

const stagedUploadFilesSchema = z.array(z.object({ name: z.string(), base64: z.string() }));
const browserDriveRequestSchema = z.object({ op: z.string(), files: z.array(z.string()).optional() }).passthrough();

const isStagedBrowserUpload = (filePath) => {
  const relative = path.relative(BROWSER_UPLOAD_ROOT, path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const stageBrowserUpload = async (files) => {
  await pruneBrowserUploads();
  const folder = path.join(BROWSER_UPLOAD_ROOT, globalThis.crypto.randomUUID());
  await fsp.mkdir(folder, { recursive: true });
  let total = 0;
  const paths = [];
  const parsed = stagedUploadFilesSchema.safeParse(files);
  if (!parsed.success) throw new Error('Every file needs a name and its data');
  for (const [index, file] of parsed.data.entries()) {
    const name = path.basename(file.name);
    if (!name || name === '.' || name === '..') throw new Error('Every file needs a name');
    const bytes = Buffer.from(file.base64, 'base64');
    total += bytes.length;
    if (total > BROWSER_UPLOAD_MAX_BYTES) throw new Error('The files are larger than an upload may be (25 MB)');
    await fsp.mkdir(path.join(folder, String(index)));
    const target = path.join(folder, String(index), name);
    await fsp.writeFile(target, bytes);
    paths.push(target);
  }
  return paths;
};

const panelSessions = new Set();
const isPanelSession = (candidate) => panelSessions.has(candidate);

const hardenPanelSession = (panelSession) => {
  if (panelSessions.has(panelSession)) return;
  panelSessions.add(panelSession);
  applyBrowserPanelUserAgent(panelSession, process.versions.electron);

  panelSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = shouldAllowBrowserPanelPermission({
      permission,
      requestingUrl: details?.requestingUrl || '',
      isFocused: contents.isFocused(),
    });
    if (allowed) {
      callback(true);
      return;
    }
    log.info('[electron] browser panel denied a permission request', browserPanelPermissionAuditDetails({
      permission,
      requestingUrl: details?.requestingUrl || '',
    }));
    callback(false);
  });

  panelSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => (
    shouldAllowBrowserPanelPermission({
      permission,
      requestingUrl: requestingOrigin,
      isFocused: contents?.isFocused() === true,
    })
  ));

  panelSession.setDevicePermissionHandler(() => false);
};

const hardenBrowserPanelSession = () => {
  for (const partition of BROWSING_PARTITIONS) {
    const panelSession = session.fromPartition(partition);
    hardenPanelSession(panelSession);
    panelSession.registerPreloadScript({ type: 'frame', filePath: resolveBrowserPanelPreloadPath() });
  }

  app.on('certificate-error', (event, contents, url, error, _certificate, callback) => {
    if (isPanelSession(contents.session) && shouldAllowBrowserPanelCertificateError({ url, error })) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
};

const spacePreviews = new Map();
let deadProxyPortPromise = null;
const getDeadProxyPort = () => {
  if (!deadProxyPortPromise) {
    deadProxyPortPromise = new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.destroy());
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address()?.port;
        if (!port) {
          reject(new Error('Failed to bind the dead proxy'));
          return;
        }
        server.unref();
        resolve(port);
      });
    }).catch((error) => {
      deadProxyPortPromise = null;
      throw error;
    });
  }
  return deadProxyPortPromise;
};

const spacePreviewOf = (spaceId) => {
  let entry = spacePreviews.get(spaceId);
  if (!entry) {
    entry = { ports: new Set(), chain: Promise.resolve() };
    spacePreviews.set(spaceId, entry);
  }
  return entry;
};

const applySpacePreviewProxy = (spaceId) => {
  const entry = spacePreviewOf(spaceId);
  entry.chain = entry.chain.catch(() => {}).then(async () => {
    const panelSession = session.fromPartition(spacePreviewPartition(spaceId));
    hardenPanelSession(panelSession);
    const deadProxyPort = await getDeadProxyPort();
    await panelSession.setProxy(spacePreviewProxyConfig({ deadProxyPort, localPorts: [...entry.ports] }));
  });
  return entry.chain;
};

const openSpacePreviewPort = (spaceId, localPort) => {
  spacePreviewOf(spaceId).ports.add(localPort);
  return applySpacePreviewProxy(spaceId);
};

const closeSpacePreviewPort = (spaceId, localPort) => {
  const entry = spacePreviews.get(spaceId);
  if (!entry || !entry.ports.delete(localPort)) return Promise.resolve();
  return applySpacePreviewProxy(spaceId);
};

const closeAllSpacePreviewPorts = () => {
  for (const [spaceId, entry] of spacePreviews) {
    if (entry.ports.size === 0) continue;
    entry.ports.clear();
    applySpacePreviewProxy(spaceId).catch((error) => {
      log.warn(`[electron] could not reset the preview proxy of space ${spaceId}: ${error?.message || error}`);
    });
  }
};

const guardAttachedWebviews = (contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    const partition = String(webPreferences.partition || params?.partition || '');
    if (BROWSING_PARTITIONS.includes(partition)) return;
    const spaceId = spaceIdOfPreviewPartition(partition);
    if (spaceId) {
      applySpacePreviewProxy(spaceId).catch((error) => {
        log.warn(`[electron] could not apply the preview proxy of space ${spaceId}: ${error?.message || error}`);
      });
      return;
    }
    log.warn('[electron] refused a webview outside the browser panel sessions');
    event.preventDefault();
  });
};

const registerPackagedUiProtocol = () => {
  if (!shouldUsePackagedUi()) return;
  installPackagedUiRequestHandler(async (request) => {
    if (isPackagedUiRuntimeRequest(request.url)) {
      return Response.json(
        { error: { code: 'runtime_unavailable' } },
        { status: 503, headers: { 'x-openchamber-error': 'runtime-unavailable' } },
      );
    }

    if (new URL(request.url).pathname === RUNTIME_CONFIG_SCRIPT_PATHNAME) {
      await runtimeConfigGate.whenReleased();
      return new Response(RUNTIME_CONFIG_SCRIPT, {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

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
          return new Response(body, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          });
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
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (target.isMinimized()) target.restore();
  showWindow(target);
  target.focus();
  if (typeof target.moveTop === 'function') target.moveTop();
};

// external: https://blog.bloomca.me/2025/02/22/electron-mac-notifications Keep notifications referenced until click or close so macOS click events survive garbage collection.
const activeNotifications = new Set();
const nativeNotificationClaims = new Map();
const NATIVE_NOTIFICATION_DEDUPE_TTL_MS = 5000;
const deliveredNotificationIdsBySession = new Map();

const clearSessionNotifications = (sessionId) => {
  const ids = deliveredNotificationIdsBySession.get(sessionId);
  if (!ids) return;
  deliveredNotificationIdsBySession.delete(sessionId);
  Notification.remove(ids);
};

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
  const runtimeKey = readTrimmedString(payload.runtimeKey) || null;

  const notificationId = globalThis.crypto.randomUUID();
  const notification = new Notification({
    id: notificationId,
    title,
    body,
    silent: false,
    ...(process.platform === 'darwin' ? { sound: 'Glass' } : {}),
  });
  if (process.platform === 'darwin' && sessionId) {
    const ids = deliveredNotificationIdsBySession.get(sessionId) ?? [];
    ids.push(notificationId);
    deliveredNotificationIdsBySession.set(sessionId, ids);
  }

  activeNotifications.add(notification);
  const release = () => { activeNotifications.delete(notification); };

  notification.on('click', () => {
    const receivingKey = readTrimmedString(primaryEventWindow()?.__ocRuntimeKey);
    if (!runtimeKey || !receivingKey || runtimeKey === receivingKey) {
      focusForegroundWindow();
    } else if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    if (sessionId) {
      const openSessionPayload = { sessionId, directory };
      if (runtimeKey) openSessionPayload.runtimeKey = runtimeKey;
      emitToPrimaryWindow('openchamber:open-session', openSessionPayload);
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

import { pathLooksUserConfigured, mergePathValues } from '@openchamber/web/server/lib/opencode/path-utils.js';
import { provideLoginShellEnvSnapshot } from '@openchamber/web/server/lib/opencode/login-shell-env.js';

const inheritUserShellEnv = async () => {
  const shellEnv = await startShellEnvironmentProbe();
  provideLoginShellEnvSnapshot(shellEnv);
  if (!shellEnv) return;

  const homeDir = os.homedir();
  const currentPath = process.env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const currentPathLooksUserConfigured = pathLooksUserConfigured(currentPath, homeDir, delimiter);

  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH' || key === 'ARGV0') continue;
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }

  const shellPath = typeof shellEnv.PATH === 'string' ? shellEnv.PATH : '';
  if ((process.platform === 'win32' || !currentPathLooksUserConfigured) && shellPath) {
    process.env.PATH = mergePathValues(shellPath, currentPath, delimiter);
  }
};

const shouldSkipLocalServer = async () => {
  await inheritUserShellEnv();
  return process.env.OPENCHAMBER_SKIP_LOCAL_SERVER === '1';
};

const spawnLocalServer = async () => {
  const serverStartedAt = performance.now();
  recordElectronStartupPerformance('electron.server.start');
  await inheritUserShellEnv();

  const settings = readSettingsRoot();
  const storedPort = Number.isFinite(settings.desktopLocalPort) ? settings.desktopLocalPort : null;
  const lanAccessEnabled = settings.desktopLanAccessEnabled === true;
  setDesktopKeepAwakeActive(settings.desktopKeepAwakeEnabled === true);
  const desktopUiPassword = typeof settings.desktopUiPassword === 'string' ? settings.desktopUiPassword.trim() : '';
  const lanAccessBlockedByEnterprise = lanAccessEnabled && isNetworkAccessBlocked();
  const lanAccessBlockedByMissingPassword = lanAccessEnabled && !lanAccessBlockedByEnterprise && !desktopUiPassword;
  const effectiveLanAccessEnabled = lanAccessEnabled && !lanAccessBlockedByEnterprise && !lanAccessBlockedByMissingPassword;
  const bindHost = effectiveLanAccessEnabled ? LAN_BIND_HOST : LOOPBACK_BIND_HOST;
  if (lanAccessBlockedByEnterprise) {
    log.warn('[desktop] LAN access is turned off by enterprise mode; starting on loopback only.');
  } else if (lanAccessBlockedByMissingPassword) {
    log.warn('[desktop] LAN access was requested without a desktop UI password; starting on loopback only.');
  }

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

  if (!lanAccessBlockedByEnterprise && !lanAccessBlockedByMissingPassword) {
    delete process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON;
  }
  if (!desktopUiPassword) {
    delete process.env.OPENCHAMBER_UI_PASSWORD;
  }
  assignInjectedEnv(process.env, {
    OPENCHAMBER_HOST: bindHost,
    OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE: effectiveLanAccessEnabled ? 'true' : 'false',
    OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON: lanAccessBlockedByEnterprise
      ? 'enterprise-mode'
      : lanAccessBlockedByMissingPassword ? 'missing-password' : undefined,
    OPENCHAMBER_DIST_DIR: resolveWebDistDir(),
    OPENCHAMBER_RUNTIME: 'desktop',
    OPENCHAMBER_OPENCODE_CWD: resolveManagedOpenCodeCwd({
      env: process.env,
      homedir: () => os.homedir(),
    }),
    OPENCHAMBER_DESKTOP_NOTIFY: 'true',
    OPENCHAMBER_UI_PASSWORD: desktopUiPassword || undefined,
    OPENCHAMBER_SKIP_API_COMPRESSION: process.env.OPENCHAMBER_SKIP_API_COMPRESSION || 'true',
    NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1',
    no_proxy: process.env.no_proxy || 'localhost,127.0.0.1',
  });

  const { startWebUiServer } = await import('@openchamber/web/server/index.js');

  const handle = await startWebUiServer({
    port: chosenPort,
    host: bindHost,
    uiPassword: desktopUiPassword || null,
    attachSignals: false,
    exitOnShutdown: false,
    apiOnly: false,
    builtInExtensionsDir: app.isPackaged
      ? path.join(app.getAppPath().endsWith('.asar') ? `${app.getAppPath()}.unpacked` : app.getAppPath(), 'node_modules/@openchamber/web/build/server/built-in-extensions')
      : undefined,
    onDesktopNotification: (payload) => maybeShowNativeNotification({ ...payload, runtimeKey: 'local' }),
    getIsWindowFocused: isAnyWindowFocused,
    getDesktopRuntimeConfig: () => ({
      apiBaseUrl: state.apiBaseUrl || '',
      requestHeaders: sanitizeRuntimeRequestHeaders(state.requestHeaders || {}),
    }),
    desktopUpdater: {
      check: async () => {
        const updateInfo = await handleInvoke(null, 'desktop_check_for_updates');
        return isLinuxPackageInstall() ? { ...updateInfo, installBlocked: 'desktop-host' } : updateInfo;
      },
      install: async () => {
        const updateInfo = await handleInvoke(null, 'desktop_check_for_updates');
        if (!updateInfo.available) return updateInfo;
        if (isLinuxPackageInstall()) return { ...updateInfo, installBlocked: 'desktop-host' };
        await handleInvoke(null, 'desktop_download_and_install_update');
        return updateInfo;
      },
      restart: () => handleInvoke(null, 'desktop_restart'),
    },
  });

  const port = handle.getPort();
  const url = buildLocalUrl(port);

  state.serverHandle = handle;
  state.sidecarUrl = url;
  recordElectronStartupPerformance('electron.server.ready', {
    durationMs: performance.now() - serverStartedAt,
  });

  await mutateSettingsRoot((root) => {
    root.desktopLocalPort = port;
  }).catch((error) => log.warn('[electron] could not save the local server port:', error));

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

const killSidecar = async () => {
  const handle = state.serverHandle;
  state.serverHandle = null;
  state.sidecarUrl = null;
  if (!handle) return;

  await stopEmbeddedServer(handle, {
    launchFallback: launchDetachedOpenCodeKiller,
    warn: (error) => log.warn('[electron] embedded server shutdown failed:', error),
  });
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
  const sshForwardedApiUrl = JSON.stringify(sshManager.isForwardedApiUrl(apiBaseUrl) ? apiBaseUrl : '');
  return [
    '(function(){',
    `try{var __oc_local=${local};var __oc_api=${apiBase};var __oc_headers=${headers};var __oc_packaged=${packagedOrigin};var __oc_origin=window.location&&window.location.origin||'';var __oc_is_packaged=__oc_origin===__oc_packaged;var __oc_is_local=__oc_local&&__oc_origin===new URL(__oc_local).origin;window.__OPENCHAMBER_MACOS_MAJOR__=${macVersion};window.__OPENCHAMBER_LOCAL_ORIGIN__=__oc_local;window.__OPENCHAMBER_API_BASE_URL__=__oc_api;window.__OPENCHAMBER_SSH_FORWARD_API_URL__=${sshForwardedApiUrl};if(__oc_is_local||__oc_is_packaged){window.__OPENCHAMBER_HOME__=${home};window.__OPENCHAMBER_RUNTIME_HEADERS__=__oc_headers;}if((__oc_is_local||__oc_is_packaged)&&${token}){window.__OPENCHAMBER_CLIENT_TOKEN__=${token};}var __oc_bo=${outcome};if(__oc_bo){window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}}catch(_e){}`,
    '}())',
  ].join('');
};

const syncMainWindowInitScript = (initScript = state.initScript) => {
  if (!initScript) return;
  const mainWindow = state.mainWindow;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.__ocInitScript = initScript;
  }
};

const computeBootOutcome = ({ envTargetUrl, probe, config, localAvailable }) => {
  const availability = { localAvailable };
  if (envTargetUrl) {
    const status = probe?.status === 'unreachable'
      ? 'unreachable'
      : probe?.status === 'incompatible'
        ? 'incompatible'
        : probe?.status === 'wrong-service'
          ? 'wrong-service'
          : 'ok';
    return { target: 'remote', status, hostId: ENV_OVERRIDE_HOST_ID, url: envTargetUrl, ...availability };
  }

  const defaultId = config.defaultHostId || '';
  if (!defaultId) {
    return { target: null, status: 'not-configured', ...availability };
  }

  if (defaultId === LOCAL_HOST_ID) {
    return localAvailable
      ? { target: 'local', status: 'ok', ...availability }
      : { target: 'local', status: 'unreachable', ...availability };
  }

  const host = config.hosts.find((entry) => entry.id === defaultId);
  if (!host) {
    return { target: 'remote', status: 'missing', hostId: defaultId, ...availability };
  }

  const status = probe?.status === 'unreachable'
    ? 'unreachable'
    : probe?.status === 'incompatible'
      ? 'incompatible'
      : probe?.status === 'wrong-service'
        ? 'wrong-service'
        : 'ok';
  if (status !== 'ok' && sanitizeHostRelayForStorage(host.relay)) {
    return { target: 'remote', status: 'ok', hostId: host.id, url: host.apiUrl || host.url, ...availability };
  }
  return { target: 'remote', status, hostId: host.id, url: host.apiUrl || host.url, ...availability };
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
  const navigationStartedAt = performance.now();
  const documentClass = classifyStartupDocument(url);
  if (browserWindow.__ocLabel === 'main') {
    recordElectronStartupPerformance('electron.navigation.start', { documentClass });
  }
  try {
    await browserWindow.loadURL(url);
    if (browserWindow.__ocLabel === 'main') {
      recordElectronStartupPerformance('electron.navigation.ready', {
        documentClass,
        durationMs: performance.now() - navigationStartedAt,
      });
    }
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

  const clientIdentity = isLocalRuntimeUrl(baseUrl)
    ? { clientKind: LOCAL_DESKTOP_CLIENT_KIND, dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY, ...desktopDeviceMetadata() }
    : { clientKind: REMOTE_DESKTOP_CLIENT_KIND, dedupeKey: `desktop:${await getOrCreateDesktopInstallId()}`, ...desktopDeviceMetadata() };

  const loginUrl = new URL(baseUrl);
  loginUrl.pathname = `${loginUrl.pathname.replace(/\/+$/, '')}/auth/session`;
  loginUrl.search = '';
  const loginResponse = await fetch(loginUrl.toString(), {
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

const primaryEventWindow = () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length === 0) return null;
  return (state.mainWindow && !state.mainWindow.isDestroyed())
    ? state.mainWindow
    : windows.find((window) => window.isFocused()) || windows.find((window) => window.isVisible()) || windows[0];
};

const emitToPrimaryWindow = (event, detail) => {
  emitToWindow(primaryEventWindow(), event, detail);
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
let pendingMarkAllRead = process.platform === 'win32' && process.argv.includes('--mark-all-read');
let mainWindowTrayActionsReady = false;
let lastJumpListKey = '';
const PENDING_SESSION_LINK_FALLBACK_MS = 10_000;

const sessionDeepLinkTarget = (link) => {
  const target = { sessionId: link.value };
  if (readDeepLinkQueryParam(link.raw, 'source') === 'jump-list') target.requireKnownSession = true;
  const messageId = readDeepLinkQueryParam(link.raw, 'message');
  if (messageId) target.messageId = messageId;
  const runtimeKey = runtimeKeyForDeepLinkHost(readDeepLinkQueryParam(link.raw, 'host'));
  if (runtimeKey) target.runtimeKey = runtimeKey;
  return target;
};

const takePendingSessionDeepLinks = () => {
  const taken = [];
  for (let index = pendingDeepLinks.length - 1; index >= 0; index -= 1) {
    const link = pendingDeepLinks[index];
    if (link.type !== 'session' || !link.value) continue;
    pendingDeepLinks.splice(index, 1);
    taken.unshift(sessionDeepLinkTarget(link));
  }
  return taken;
};

const extensionInstallUrl = (link) => {
  if (link.value !== 'install') return null;
  const value = readDeepLinkQueryParam(link.raw, 'url');
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

const takePendingExtensionInstalls = () => {
  const taken = [];
  for (let index = pendingDeepLinks.length - 1; index >= 0; index -= 1) {
    const link = pendingDeepLinks[index];
    if (link.type !== 'extensions') continue;
    pendingDeepLinks.splice(index, 1);
    const url = extensionInstallUrl(link);
    if (url) taken.unshift(url);
  }
  return taken;
};

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
    if (url.searchParams.get('source') === 'jump-list'
      && (type !== 'session' || !isJumpListSessionId(value) || segments.length !== 1)) return null;
    return { type, value, raw: trimmed };
  } catch {
    return null;
  }
};

const readDeepLinkQueryParam = (raw, name) => {
  if (typeof raw !== 'string') return null;
  try {
    const value = new URL(raw).searchParams.get(name);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
};

const pendingHostActions = [];

const queueHostAction = (action) => {
  pendingHostActions.push(action);
  emitToWindow(state.mainWindow, 'openchamber:host-actions-ready');
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
    if (sanitizeHostRelayForStorage(host.relay)) {
      log.info('[electron] activating relay-capable host in renderer', { id });
      queueHostAction({ type: 'host', hostId: id });
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
  const visible = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
  if (visible) {
    showWindow(visible);
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
    const pairing = parsePairingDeepLink(link.raw, { protocol: DEEP_LINK_PROTOCOL });
    if (pairing) {
      void confirmConnectDeepLink({
        serverUrl: pairing.target,
        label: pairing.fingerprint ? `${pairing.label} (${pairing.fingerprint})` : pairing.label,
      }).then((confirmed) => {
        if (!confirmed) {
          log.info('[electron] connect pairing deep-link declined by user');
          return;
        }
        queueHostAction({ type: 'pairing', link: link.raw.trim() });
      });
      return;
    }
    log.warn('[electron] invalid connect deep-link payload');
    return;
  }
  if (link.type === 'focus') {
    const target = state.mainWindow && !state.mainWindow.isDestroyed()
      ? state.mainWindow
      : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (target) {
      if (target.isMinimized()) target.restore();
      showWindow(target);
      target.focus();
    }
    emitToAllWindows('openchamber:deep-link-focus', { reason: link.value || null });
    return;
  }

  if (link.type === 'session' && link.value) {
    focusForegroundWindow();
    emitToPrimaryWindow('openchamber:open-session', sessionDeepLinkTarget(link));
    return;
  }
  if (link.type === 'extensions') {
    const url = extensionInstallUrl(link);
    if (!url) {
      log.warn('[electron] invalid extension install link');
      return;
    }
    focusForegroundWindow();
    emitToPrimaryWindow('openchamber:install-extension', { url });
    return;
  }
  if (link.type === 'host' && link.value) {
    void switchToHostById(link.value);
    return;
  }
  log.warn('[electron] unknown deep-link action:', link.type);
};

const flushPendingDeepLinks = ({ includeSessions }) => {
  const kept = [];
  while (pendingDeepLinks.length > 0) {
    const link = pendingDeepLinks.shift();
    if ((link.type === 'session' || link.type === 'extensions') && !includeSessions) {
      kept.push(link);
      continue;
    }
    dispatchDeepLink(link);
  }
  pendingDeepLinks.push(...kept);
};

const mainWindowSessionLinkGate = createSessionLinkGate({
  fallbackMs: PENDING_SESSION_LINK_FALLBACK_MS,
  onFallback: () => flushPendingDeepLinks({ includeSessions: true }),
});

const isMainWindowReadyForDeepLink = () =>
  Boolean(state.mainWindow)
  && !state.mainWindow.isDestroyed()
  && !state.mainWindow.webContents.isLoading();

const handleDeepLinks = (urls) => {
  for (const raw of urls) {
    const parsed = parseDeepLink(raw);
    if (!parsed) continue;
    if (isMainWindowReadyForDeepLink() && ((parsed.type !== 'session' && parsed.type !== 'extensions') || mainWindowSessionLinkGate.isListening())) {
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

const closeTabTargets = new WeakSet();
const closeTabWatched = new WeakSet();

const closeTabOrWindow = () => {
  const target = BrowserWindow.getFocusedWindow();
  if (!target || target.isDestroyed()) return;
  if (closeTabTargets.has(target.webContents)) {
    dispatchDomEventToWindow(target, 'openchamber:close-tab');
    return;
  }
  target.close();
};

let menuShortcuts = {};
let appMenuLocale = 'en';
const menuKey = (id, fallback) => menuAccelerator(menuShortcuts, id, fallback);

const applyApplicationMenu = () => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? buildMacMenu(appMenuLocale) : buildAutoHiddenMenu());
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
  if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') {
    dispatchDomEventToWindow(target, 'openchamber:zoom', action);
    return;
  }
  dispatchDomEventToWindow(target, 'openchamber:menu-action', action);
};

const dispatchAddSelectionToChat = () => dispatchMenuAction('add-selection-to-chat');

const handleCopyAction = createCopyMenuAction({
  getFocusedWebContents: () => webContents.getFocusedWebContents(),
  getAppWindows: () => BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !isBrowserPanelPopup(window),
  ),
  dispatchAppCopy: (window) => dispatchDomEventToWindow(window, 'openchamber:menu-action', 'copy'),
});

const dispatchOpenMiniChat = (browserWindow) => {
  const target = browserWindow && !browserWindow.isDestroyed() ? browserWindow : getMenuTargetWindow();
  if (target) emitToWindow(target, 'openchamber:open-mini-chat');
};

let registeredMiniChatGlobalShortcutAccelerator = null;

const readDesktopMiniChatGlobalShortcutStatus = () => {
  const combo = normalizeStoredShortcutCombo(readSettingsRoot()[MINI_CHAT_GLOBAL_SHORTCUT_SETTING_KEY]);
  return { supported: true, combo, active: registeredMiniChatGlobalShortcutAccelerator !== null };
};

const ensureMiniChatFocusStampListener = () => {
  if (state.miniChatFocusListener) return;
  state.miniChatFocusListener = (_event, browserWindow) => {
    if (browserWindow && !browserWindow.isDestroyed() && browserWindow.__ocMiniChat === true) {
      browserWindow.__ocMiniChatFocusedAt = Date.now();
    }
  };
  app.on('browser-window-focus', state.miniChatFocusListener);
};

const handleMiniChatGlobalShortcut = () => {
  const action = selectMiniChatGlobalShortcutAction(
    BrowserWindow.getAllWindows().map((browserWindow) => ({
      id: browserWindow.id,
      isMiniChat: browserWindow.__ocMiniChat === true,
      isFocused: browserWindow.isFocused(),
      focusedAt: browserWindow.__ocMiniChatFocusedAt ?? 0,
    })),
    { hasRendererWindow: getMenuTargetWindow() !== null },
  );
  if (action.type === 'hide' || action.type === 'focus') {
    const target = BrowserWindow.fromId(action.windowId);
    if (!target || target.isDestroyed()) return;
    if (action.type === 'hide' && !isWindowHidePending(target)) {
      hideWindow(target);
    } else {
      showWindow(target);
      target.focus();
    }
    return;
  }
  if (action.type === 'reveal-main') {
    void revealMainWindow();
    return;
  }
  dispatchOpenMiniChat();
};

const applyDesktopMiniChatGlobalShortcut = () => {
  if (registeredMiniChatGlobalShortcutAccelerator !== null) {
    try {
      globalShortcut.unregister(registeredMiniChatGlobalShortcutAccelerator);
    } catch {
    }
    registeredMiniChatGlobalShortcutAccelerator = null;
  }
  const { combo } = readDesktopMiniChatGlobalShortcutStatus();
  if (!combo) return;
  const accelerator = convertShortcutComboToAccelerator(combo);
  if (!accelerator) {
    log.warn('[electron] mini chat global shortcut: unsupported combo', { combo });
    return;
  }
  if (registeredQuakeModeAccelerator !== null && accelerator === registeredQuakeModeAccelerator) {
    log.warn('[electron] mini chat global shortcut: combo collides with Quake Mode', { combo, accelerator });
    return;
  }
  try {
    globalShortcut.register(accelerator, handleMiniChatGlobalShortcut);
    if (globalShortcut.isRegistered(accelerator)) {
      registeredMiniChatGlobalShortcutAccelerator = accelerator;
      ensureMiniChatFocusStampListener();
    } else {
      log.warn('[electron] mini chat global shortcut: combo is taken by another app', { combo, accelerator });
    }
  } catch (error) {
    log.warn('[electron] mini chat global shortcut: registration failed', error);
  }
};

let registeredQuakeModeAccelerator = null;

const readDesktopQuakeModeStatus = () => {
  const { enabled, storedCombo, combo, heightFraction } = readQuakeModeSettings(readSettingsRoot());
  return {
    supported: true,
    enabled,
    combo,
    storedCombo,
    active: registeredQuakeModeAccelerator !== null,
    heightFraction,
  };
};

const shouldHideMainWindowToQuake = (browserWindow) => {
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  if (browserWindow.__ocMiniChat === true || browserWindow.__ocContextWindowOwnerId) return false;
  if (registeredQuakeModeAccelerator === null) return false;
  return readSettingsRoot()[QUAKE_MODE_ENABLED_KEY] === true;
};

const showQuakeWindow = (browserWindow, heightFraction) => {
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  if (!state.quakeActive) {
    try {
      state.quakeNormalBounds = browserWindow.getBounds();
    } catch {
      state.quakeNormalBounds = null;
    }
    state.quakeNormalMaximized = (() => {
      try {
        return browserWindow.isMaximized();
      } catch {
        return false;
      }
    })();
  }
  try {
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (browserWindow.isMinimized()) browserWindow.restore();
    if (state.quakeNormalMaximized) browserWindow.unmaximize();
    const displayBounds = getQuakeDisplayBounds(screen);
    if (displayBounds) {
      browserWindow.setBounds(computeQuakeBounds(displayBounds, heightFraction));
    }
    showWindow(browserWindow);
    browserWindow.focus();
    browserWindow.moveTop();
    state.quakeActive = true;
    return true;
  } catch (error) {
    log.warn('[electron] quake mode: show failed', error);
    return false;
  }
};

const hideQuakeWindow = (browserWindow, { restoreFullScreen = true } = {}) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  try {
    debounceWindowStatePersist(browserWindow, true);
  } catch {
    // Persist is best-effort; hiding must not fail because of it.
  }
  hideWindow(browserWindow, process.platform, { restoreFullScreen });
};

const restoreNormalWindowFromQuake = () => {
  const target = state.mainWindow;
  if (!state.quakeActive) return target;
  state.quakeActive = false;
  if (!target || target.isDestroyed()) return target;
  try {
    if (state.quakeNormalBounds) {
      target.setBounds(state.quakeNormalBounds);
    }
    if (state.quakeNormalMaximized) target.maximize();
  } catch (error) {
    log.warn('[electron] quake mode: restore failed', error);
  }
  state.quakeNormalBounds = null;
  state.quakeNormalMaximized = false;
  return target;
};

const handleQuakeModeGlobalShortcut = () => {
  const { heightFraction } = readQuakeModeSettings(readSettingsRoot());
  const mainWindow = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null;
  const action = selectQuakeToggleAction({
    windowExists: mainWindow !== null,
    isVisible: mainWindow?.isVisible() === true && !isWindowHidePending(mainWindow),
    isMinimized: mainWindow?.isMinimized() === true,
    isFocused: mainWindow?.isFocused() === true,
  });
  if (action === 'hide' && mainWindow) {
    hideQuakeWindow(mainWindow);
    return;
  }
  if (mainWindow) {
    showQuakeWindow(mainWindow, heightFraction);
    return;
  }
  void openMainWindow().then((created) => {
    const target = created && !created.isDestroyed() ? created : state.mainWindow;
    if (target && !target.isDestroyed()) showQuakeWindow(target, heightFraction);
  }).catch((error) => {
    log.warn('[electron] quake mode: open failed', error);
  });
};

const applyDesktopQuakeModeShortcut = () => {
  if (registeredQuakeModeAccelerator !== null) {
    try {
      globalShortcut.unregister(registeredQuakeModeAccelerator);
    } catch {
    }
    registeredQuakeModeAccelerator = null;
  }
  const { enabled, combo } = readDesktopQuakeModeStatus();
  if (!enabled || !combo) return;
  const accelerator = convertShortcutComboToAccelerator(combo);
  if (!accelerator) {
    log.warn('[electron] quake mode: unsupported combo', { combo });
    return;
  }
  if (accelerator === registeredMiniChatGlobalShortcutAccelerator) {
    log.warn('[electron] quake mode: combo collides with the Mini Chat shortcut', { combo, accelerator });
    return;
  }
  try {
    globalShortcut.register(accelerator, handleQuakeModeGlobalShortcut);
    if (globalShortcut.isRegistered(accelerator)) {
      registeredQuakeModeAccelerator = accelerator;
    } else {
      log.warn('[electron] quake mode: combo is taken by another app', { combo, accelerator });
    }
  } catch (error) {
    log.warn('[electron] quake mode: registration failed', error);
  }
};

const dispatchCheckForUpdates = () => {
  emitToAllWindows('openchamber:check-for-updates');
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
  void performConfirmedQuit({ relaunch: true });
};

const nextWindowLabel = () => {
  const value = state.windowCounter++;
  return value === 1 ? 'main' : `main-${value}`;
};

const canUseTitleBarOverlay = (browserWindow) => (
  process.platform === 'win32' &&
  Boolean(browserWindow?.__ocTitleBarOverlayEnabled) &&
  typeof browserWindow.setTitleBarOverlay === 'function' &&
  !browserWindow.isDestroyed()
);

const isAppUiNavigationTarget = (raw) => {
  if (!raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === `${UI_PROTOCOL}:`) return true;
  for (const base of [state.localUiUrl, state.localOrigin, state.sidecarUrl]) {
    if (!base) continue;
    try {
      if (new URL(base).origin === url.origin) return true;
    } catch {
      // A malformed configured base cannot match anything.
    }
  }
  return false;
};

const createBrowserWindow = ({ label, restoreGeometry, url, runtimeConfig = {}, adopt = null }) => {
  const { bounds, maximized } = adopt
    ? { bounds: null, maximized: adopt.maximized }
    : restoreGeometry ? resolveMainWindowBounds() : { bounds: null, maximized: false };
  const desktopLocalOrigin = state.localOrigin || state.sidecarUrl || '';
  const rendererRuntimeConfig = buildRendererRuntimeConfig(url, runtimeConfig);
  const desktopApiBaseUrl = rendererRuntimeConfig.apiBaseUrl;
  const desktopClientToken = rendererRuntimeConfig.clientToken;
  const desktopRequestHeaders = rendererRuntimeConfig.requestHeaders || {};
  const titleBarOverlayEnabled = false;

  const browserWindow = adopt?.browserWindow ?? new BrowserWindow(buildMainWindowOptions({
    bounds,
    backgroundColor: resolveSplashBackgroundColor(),
    additionalArguments: buildRendererAdditionalArguments({
      localOrigin: desktopLocalOrigin,
      apiBaseUrl: desktopApiBaseUrl,
      clientToken: desktopClientToken,
      requestHeaders: desktopRequestHeaders,
      bootOutcome: state.bootOutcome || null,
      relayHostId: rendererRuntimeConfig.relayHostId || '',
      explicitRuntime: runtimeConfig.explicitRuntime === true,
      trayEnabled: isMacMenuBarEnabled(),
    }),
  }));
  browserWindow.__ocLabel = label || nextWindowLabel();
  browserWindow.__ocRuntimeConfig = { apiBaseUrl: desktopApiBaseUrl, clientToken: desktopClientToken, requestHeaders: desktopRequestHeaders };
  browserWindow.__ocInitScript = buildInitScript(desktopLocalOrigin, state.bootOutcome, desktopApiBaseUrl, desktopClientToken, desktopRequestHeaders);
  browserWindow.__ocTitleBarOverlayEnabled = titleBarOverlayEnabled;
  browserWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward') event.preventDefault();
  });

  if (!adopt && maximized) {
    browserWindow.maximize();
  }

  browserWindow.on('focus', () => {
    state.focusedWindowIds.add(browserWindow.id);
  });
  browserWindow.on('blur', () => {
    state.focusedWindowIds.delete(browserWindow.id);
  });
  attachWindowEvents(browserWindow, emitToWindow);

  if (process.platform === 'darwin') {
    const refreshTrafficLights = () => {
      if (browserWindow.isDestroyed()) return;
      try {
        browserWindow.setWindowButtonVisibility(true);
        browserWindow.setTrafficLightPosition(macTrafficLightPosition());
      } catch {}
    };
    browserWindow.on('minimize', () => {
      refreshTrafficLights();
    });
    browserWindow.on('restore', () => {
      refreshTrafficLights();
      setTimeout(refreshTrafficLights, 250);
    });
    browserWindow.on('show', refreshTrafficLights);
    browserWindow.on('focus', refreshTrafficLights);
  }

  browserWindow.on('resize', () => {
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
  browserWindow.on('close', (event) => {
    if (!state.quitRequested && shouldHideMainWindowToTray(browserWindow)) {
      debounceWindowStatePersist(browserWindow, true);
      event.preventDefault();
      hideWindow(browserWindow, process.platform, { restoreFullScreen: false });
      return;
    }

    if (!state.quitRequested && shouldHideMainWindowToQuake(browserWindow)) {
      event.preventDefault();
      hideQuakeWindow(browserWindow, { restoreFullScreen: false });
      return;
    }

    if (process.platform === 'darwin' && !state.quitRequested && !browserWindow.__ocContextWindowOwnerId) {
      const remainingVisible = BrowserWindow.getAllWindows().filter(
        (window) => !window.isDestroyed() && window.isVisible() && !window.__ocIdleUpdate && !isBrowserPanelPopup(window) && !window.__ocContextWindowOwnerId,
      ).length;

      if (remainingVisible <= 1) {
        debounceWindowStatePersist(browserWindow, true);
        event.preventDefault();
        hideWindow(browserWindow, process.platform, { restoreFullScreen: false });
        return;
      }
    }

    debounceWindowStatePersist(browserWindow, true);
  });
  browserWindow.on('closed', () => {
    windowGeometryState.cancel(browserWindow);
    state.focusedWindowIds.delete(browserWindow.id);
    if (state.mainWindow && browserWindow.id === state.mainWindow.id) {
      mainWindowTrayActionsReady = false;
      mainWindowSessionLinkGate.documentReplaced();
      state.mainWindow = null;
    }
    if (BrowserWindow.getAllWindows().every((window) => window.__ocIdleUpdate)) {
      if (process.platform !== 'darwin') {
        if (state.updateInstallPending) {
          log.info('[electron] last window closed while an update install is pending; leaving the exit to the installer');
        } else if (state.installingUpdate) {
          log.info('[electron] last window closed after the installer took over; quitting');
          app.quit();
        } else {
          performConfirmedQuit();
        }
      }
    }
  });

  attachWindowNavigationGuards({
    webContents: browserWindow.webContents,
    uiProtocol: UI_PROTOCOL,
    getAllowedOrigins: () => [state.localOrigin, state.sidecarUrl],
    findConfiguredHostForUrl,
    sessionRouteFromUrl,
    openHostWindow,
    onOpenSession: (route) => emitToWindow(browserWindow, 'openchamber:open-session', route),
    openExternal: (target) => shell.openExternal(target),
    log,
  });

  browserWindow.webContents.on('did-navigate', (_event, url) => {
    if (!isAppUiNavigationTarget(url)) browserWindow.__ocRuntimeKey = null;
    if (browserWindow === state.mainWindow) mainWindowSessionLinkGate.documentReplaced();
  });
  browserWindow.webContents.on('did-start-navigation', (details) => {
    if (browserWindow === state.mainWindow && details.isMainFrame && !details.isSameDocument) {
      mainWindowTrayActionsReady = false;
    }
  });

  browserWindow.webContents.setZoomMode('disabled');
  attachRendererRecovery(browserWindow, { log, label: 'window' });
  attachDevWindowTape(app, browserWindow);

  browserWindow.webContents.on('dom-ready', () => {
    if (browserWindow.__ocLabel === 'main') {
      recordElectronStartupPerformance('electron.renderer.dom-ready', {
        documentClass: classifyStartupDocument(browserWindow.webContents.getURL()),
      });
    }
    const initScript = browserWindow.__ocInitScript;
    if (initScript) {
      void browserWindow.webContents.executeJavaScript(initScript).catch(() => {});
    }
  });

  browserWindow.webContents.on('did-finish-load', () => {
    if (browserWindow.__ocLabel === 'main') {
      recordElectronStartupPerformance('electron.renderer.loaded', {
        documentClass: classifyStartupDocument(browserWindow.webContents.getURL()),
      });
    }
    if (state.mainWindow && browserWindow.id === state.mainWindow.id) {
      if (pendingDeepLinks.length > 0) {
        const timer = setTimeout(() => flushPendingDeepLinks({ includeSessions: mainWindowSessionLinkGate.isListening() }), 400);
        if (typeof timer?.unref === 'function') timer.unref();
      }
      if (!isStartupSplashUrl(browserWindow.webContents.getURL())) mainWindowSessionLinkGate.applicationDocumentLoaded();
    }
  });

  if (!adopt) {
    browserWindow.once('ready-to-show', () => {
      if (browserWindow.__ocLabel === 'main') {
        recordElectronStartupPerformance('electron.window.ready-to-show', {
          documentClass: classifyStartupDocument(browserWindow.webContents.getURL()),
        });
      }
      showWindow(browserWindow);
      browserWindow.focus();
    });
  }

  if (url) {
    void navigateWindow(browserWindow, url);
  } else if (!adopt) {
    void navigateWindow(browserWindow, buildStartupSplashUrl(), { allowAbort: true });
  }

  return browserWindow;
};

const startEarlyMainNavigation = (url) => {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  runtimeConfigGate.hold();
  const loaded = navigateWindow(mainWindow, url, { allowAbort: true });
  loaded.catch(() => {});
  state.earlyNavigation = { window: mainWindow, url, loaded };
};

const SPLASH_SHOW_WAIT_MS = 500;

const showMainWindowWithSplash = () => {
  const early = takeEarlyWindow();
  const browserWindow = createBrowserWindow({
    label: 'main',
    restoreGeometry: true,
    url: null,
    adopt: early,
  });
  state.mainWindow = browserWindow;
  if (early) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SPLASH_SHOW_WAIT_MS);
    browserWindow.once('ready-to-show', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const activateMainWindow = async (url, localOrigin, bootOutcome, runtimeConfig = {}) => {
  state.startupResolved = true;
  state.localOrigin = localOrigin;
  state.apiBaseUrl = typeof runtimeConfig.apiBaseUrl === 'string' ? runtimeConfig.apiBaseUrl : state.apiBaseUrl;
  state.clientToken = typeof runtimeConfig.clientToken === 'string' ? runtimeConfig.clientToken : '';
  state.requestHeaders = sanitizeRuntimeRequestHeaders(runtimeConfig.requestHeaders || {});
  state.bootOutcome = bootOutcome ?? null;
  const rendererRuntimeConfig = buildRendererRuntimeConfig(url, {
    apiBaseUrl: state.apiBaseUrl || '',
    clientToken: state.clientToken || '',
    requestHeaders: state.requestHeaders || {},
  });
  state.initScript = buildInitScript(
    localOrigin,
    state.bootOutcome,
    rendererRuntimeConfig.apiBaseUrl,
    rendererRuntimeConfig.clientToken,
    rendererRuntimeConfig.requestHeaders,
  );
  syncMainWindowInitScript(state.initScript);

  const mainWindow = state.mainWindow;
  const earlyNavigation = state.earlyNavigation;
  state.earlyNavigation = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.__ocRuntimeConfig = rendererRuntimeConfig;
    mainWindow.__ocInitScript = state.initScript;
  }
  runtimeConfigGate.release();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (earlyNavigation?.window === mainWindow && earlyNavigation.url === url) {
      await earlyNavigation.loaded;
    } else {
      await navigateWindow(mainWindow, url, { allowAbort: true });
    }
    showWindow(mainWindow);
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
  if (!state.startupResolved) {
    await initialStartup.promise;
    if (state.mainWindow && !state.mainWindow.isDestroyed()) return state.mainWindow;
  }

  if (!state.startupResolved) {
    const { initialUrl, localOrigin, bootOutcome, apiBaseUrl, clientToken, requestHeaders } = await resolveInitialUrl();
    return activateMainWindow(initialUrl, localOrigin, bootOutcome, { apiBaseUrl, clientToken, requestHeaders });
  }

  const config = readDesktopHostsConfig();
  const localUiUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
  const host = config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID
    ? config.hosts.find((entry) => entry.id === config.defaultHostId)
    : null;
  if (host && state.bootOutcome?.sshStartupFallbackHostId === host.id) {
    return activateMainWindow(localUiUrl, state.localOrigin, state.bootOutcome, {
      apiBaseUrl: state.sidecarUrl || state.localOrigin || '',
      clientToken: readDesktopLocalClientToken(),
      requestHeaders: {},
    });
  }
  const relayHost = host && host.relay && typeof host.relay === 'object' ? host : null;
  if (relayHost) {
    const localApiBaseUrl = state.sidecarUrl || state.apiBaseUrl || state.localOrigin || '';
    const localToken = resolveStoredClientTokenForUrl(localApiBaseUrl, config) || state.clientToken || '';
    return activateMainWindow(localUiUrl, state.localOrigin, state.bootOutcome, {
      apiBaseUrl: localApiBaseUrl,
      clientToken: localToken,
      requestHeaders: {},
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

const SESSION_ROUTE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const parseSessionRoute = (rawSessionId, rawMessageId) => {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  if (!SESSION_ROUTE_ID_RE.test(sessionId)) return null;
  const messageId = typeof rawMessageId === 'string' ? rawMessageId.trim() : '';
  return SESSION_ROUTE_ID_RE.test(messageId) ? { sessionId, messageId } : { sessionId };
};

const sessionRouteFromUrl = (raw) => {
  try {
    const url = new URL(raw);
    return parseSessionRoute(url.searchParams.get('session'), url.searchParams.get('message'));
  } catch {
    return null;
  }
};

const withSessionRoute = (windowUrl, route) => {
  if (!route) return windowUrl;
  try {
    const url = new URL(windowUrl);
    url.searchParams.set('session', route.sessionId);
    if (route.messageId) url.searchParams.set('message', route.messageId);
    return url.toString();
  } catch {
    return windowUrl;
  }
};

const findConfiguredHostForUrl = (raw) => {
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  if (origin === 'null') return null;
  const hosts = readDesktopHostsConfig()?.hosts || [];
  return hosts.find((entry) => [entry?.url, entry?.apiUrl].some((candidate) => {
    if (typeof candidate !== 'string' || !candidate) return false;
    try {
      return new URL(candidate).origin === origin;
    } catch {
      return false;
    }
  })) || null;
};

const hostRoutingContext = () => ({
  hosts: readDesktopHostsConfig()?.hosts || [],
  localUrl: state.sidecarUrl || null,
  localClientToken: readDesktopLocalClientToken(),
});

const openHostWindow = async (host, route = null, { reuseOpenWindow = false } = {}) => {
  const allWindows = reuseOpenWindow ? BrowserWindow.getAllWindows() : [];
  const reusableIndex = reuseOpenWindow
    ? findReusableHostWindowIndex(
      allWindows.map((window) => (window.isDestroyed() ? null : {
        runtimeKey: window.__ocRuntimeKey,
        hostWindowId: window.__ocHostWindowId,
      })),
      host.id,
      hostRoutingContext(),
    )
    : -1;
  const existing = reusableIndex >= 0 ? allWindows[reusableIndex] : null;
  if (existing) {
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (existing.isMinimized()) existing.restore();
    showWindow(existing);
    existing.focus();
    if (!route) return;
    if (existing.webContents.isLoading() && existing.__ocHostWindowBaseUrl) {
      await navigateWindow(existing, withSessionRoute(existing.__ocHostWindowBaseUrl, route), { allowAbort: true });
      return;
    }
    emitToWindow(existing, 'openchamber:open-session', route);
    return;
  }

  let windowUrl;
  let runtimeConfig;
  if (host.relay) {
    windowUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : (state.sidecarUrl || state.localOrigin);
    runtimeConfig = {
      apiBaseUrl: '',
      clientToken: host.clientToken || '',
      requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
      relayHostId: host.id,
    };
  } else {
    const targetUrl = normalizeHostUrl(host.apiUrl || host.url);
    if (!targetUrl) throw new Error('Invalid URL');
    windowUrl = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : targetUrl;
    runtimeConfig = {
      apiBaseUrl: targetUrl,
      clientToken: host.clientToken || '',
      requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
    };
  }
  const browserWindow = await createAdditionalWindow(withSessionRoute(windowUrl, route), { ...runtimeConfig, explicitRuntime: true });
  if (browserWindow) {
    browserWindow.__ocHostWindowId = host.id;
    browserWindow.__ocHostWindowBaseUrl = windowUrl;
  }
};

const createAdditionalWindow = async (url, runtimeConfig = {}) => {
  if (!state.startupResolved || !url) return null;
  return createBrowserWindow({ label: nextWindowLabel(), restoreGeometry: false, url, runtimeConfig });
};

const buildMiniChatUrl = ({ mode, sessionId, directory, projectId }) => {
  const base = shouldUsePackagedUi()
    ? buildPackagedUiUrl('/mini-chat.html')
    : state.localUiUrl || state.localOrigin || state.sidecarUrl;
  if (!base) {
    throw new Error('Local UI is not available');
  }

  const url = new URL(shouldUsePackagedUi() ? base : '/mini-chat.html', base);
  url.searchParams.set('mode', mode === 'session' ? 'session' : 'draft');
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (directory) url.searchParams.set('directory', directory);
  if (projectId) url.searchParams.set('projectId', projectId);
  return url.toString();
};

const miniChatSessionWindowKey = (runtimeConfig, sessionId) => {
  const runtimeKey = runtimeConfig?.relayHostId
    ? `host:${runtimeConfig.relayHostId}`
    : normalizeHostUrl(runtimeConfig?.apiBaseUrl || state.apiBaseUrl || state.localOrigin || state.sidecarUrl || '') || 'local';
  return `${runtimeKey}\n${sessionId}`;
};

const getWindowRuntimeConfig = (browserWindow) => {
  const fallback = {
    apiBaseUrl: state.apiBaseUrl || state.localOrigin || state.sidecarUrl || '',
    clientToken: state.clientToken || '',
    requestHeaders: state.requestHeaders || {},
  };
  if (!browserWindow || browserWindow.isDestroyed()) return fallback;
  const config = browserWindow.__ocRuntimeConfig;
  return {
    apiBaseUrl: typeof config?.apiBaseUrl === 'string' ? config.apiBaseUrl : fallback.apiBaseUrl,
    clientToken: typeof config?.clientToken === 'string' ? config.clientToken : fallback.clientToken,
    requestHeaders: sanitizeRuntimeRequestHeaders(config?.requestHeaders || fallback.requestHeaders),
  };
};

const createMiniChatWindow = async ({ mode, sessionId = '', directory = '', projectId = '', runtimeConfig = {} } = {}) => {
  const relayHostId = typeof runtimeConfig.relayHostId === 'string' ? runtimeConfig.relayHostId : '';
  const effectiveRuntimeConfig = relayHostId
    ? {
      apiBaseUrl: '',
      clientToken: sanitizeClientTokenForStorage(runtimeConfig.clientToken || ''),
      requestHeaders: sanitizeRuntimeRequestHeaders(runtimeConfig.requestHeaders || {}),
      relayHostId,
    }
    : {
      apiBaseUrl: normalizeHostUrl(runtimeConfig.apiBaseUrl || state.apiBaseUrl || state.localOrigin || state.sidecarUrl || ''),
      clientToken: sanitizeClientTokenForStorage(runtimeConfig.clientToken || state.clientToken || ''),
      requestHeaders: sanitizeRuntimeRequestHeaders(runtimeConfig.requestHeaders || state.requestHeaders || {}),
      relayHostId: '',
    };
  const sessionWindowKey = mode === 'session' && sessionId ? miniChatSessionWindowKey(effectiveRuntimeConfig, sessionId) : '';
  if (mode === 'session' && sessionId) {
    const existing = state.miniChatWindowsBySession.get(sessionWindowKey);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      showWindow(existing);
      existing.focus();
      return existing;
    }
    state.miniChatWindowsBySession.delete(sessionWindowKey);
  }

  const desktopLocalOrigin = state.localOrigin || '';
  const desktopApiBaseUrl = effectiveRuntimeConfig.apiBaseUrl || '';
  const desktopClientToken = effectiveRuntimeConfig.clientToken || '';
  const desktopRequestHeaders = effectiveRuntimeConfig.requestHeaders || {};
  const browserWindow = new BrowserWindow({
    title: 'OpenChamber Mini Chat',
    width: MINI_CHAT_WINDOW_WIDTH,
    height: MINI_CHAT_WINDOW_HEIGHT,
    minWidth: MINI_CHAT_MIN_WINDOW_WIDTH,
    minHeight: MINI_CHAT_MIN_WINDOW_HEIGHT,
    icon: getWindowIconPath(),
    show: false,
    backgroundColor: resolveSplashBackgroundColor(),
    frame: usesLinuxNativeFrame(),
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' || usesFramelessChrome() ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? macTrafficLightPosition() : undefined,
    acceptFirstMouse: true,
    webPreferences: {
      additionalArguments: buildRendererAdditionalArguments({
        localOrigin: desktopLocalOrigin,
        apiBaseUrl: desktopApiBaseUrl,
        clientToken: desktopClientToken,
        requestHeaders: desktopRequestHeaders,
        relayHostId: effectiveRuntimeConfig.relayHostId || '',
        explicitRuntime: true,
      }),
      preload: resolvePreloadPath(),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });
  browserWindow.__ocLabel = nextWindowLabel();
  browserWindow.__ocRuntimeConfig = effectiveRuntimeConfig;
  browserWindow.__ocInitScript = buildInitScript(desktopLocalOrigin, state.bootOutcome, desktopApiBaseUrl, desktopClientToken, desktopRequestHeaders);
  browserWindow.__ocMiniChat = true;
  browserWindow.__ocMiniChatSessionId = sessionWindowKey;
  setMiniChatPinned(browserWindow, true);

  attachRendererRecovery(browserWindow, { log, label: 'mini chat' });
  attachDevWindowTape(app, browserWindow);

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
    if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().some((window) => window.__ocIdleUpdate) &&
      BrowserWindow.getAllWindows().every((window) => window.__ocIdleUpdate)) performConfirmedQuit();
  });

  if (process.platform === 'darwin') {
    const refreshTrafficLights = () => {
      if (browserWindow.isDestroyed()) return;
      try {
        browserWindow.setWindowButtonVisibility(true);
        browserWindow.setTrafficLightPosition(macTrafficLightPosition());
      } catch {}
    };
    browserWindow.on('show', refreshTrafficLights);
    browserWindow.on('focus', refreshTrafficLights);
  }

  attachWindowNavigationGuards({
    webContents: browserWindow.webContents,
    uiProtocol: UI_PROTOCOL,
    getAllowedOrigins: () => [shouldUsePackagedUi() ? packagedUiOrigin() : (state.localOrigin || state.sidecarUrl)],
    findConfiguredHostForUrl,
    sessionRouteFromUrl,
    openHostWindow,
    onOpenSession: () => {},
    openExternal: (target) => shell.openExternal(target),
    log,
    routeLinks: false,
  });
  browserWindow.webContents.on('dom-ready', () => {
    const initScript = browserWindow.__ocInitScript;
    if (initScript) {
      void browserWindow.webContents.executeJavaScript(initScript).catch(() => {});
    }
  });

  showWindow(browserWindow);
  browserWindow.focus();

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

  const runtimeKey = typeof args.runtimeKey === 'string' ? args.runtimeKey.trim() : '';
  const hostId = runtimeKey.startsWith('host:') ? runtimeKey.slice('host:'.length) : '';
  const relayHost = hostId
    ? (readDesktopHostsConfig().hosts || []).find((entry) => entry.id === hostId && entry.relay) || null
    : null;
  if (relayHost) {
    return {
      apiBaseUrl: '',
      clientToken: sanitizeClientTokenForStorage(relayHost.clientToken) || '',
      requestHeaders: sanitizeRuntimeRequestHeaders(relayHost.requestHeaders || {}),
      relayHostId: relayHost.id,
    };
  }

  const providedToken = sanitizeClientTokenForStorage(args.clientToken);
  const storedToken = targetUrl ? resolveStoredClientTokenForUrl(targetUrl) : '';
  const windowToken = targetUrl && sameOrigin(windowConfig.apiBaseUrl, targetUrl) ? windowConfig.clientToken : '';
  const windowHeaders = targetUrl && sameOrigin(windowConfig.apiBaseUrl, targetUrl) ? windowConfig.requestHeaders : {};
  return {
    apiBaseUrl: targetUrl,
    clientToken: providedToken || windowToken || storedToken || '',
    requestHeaders: sanitizeRuntimeRequestHeaders(args.requestHeaders || windowHeaders || {}),
    relayHostId: '',
  };
};

const showSplashStatus = (text) => {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isStartupSplashUrl(mainWindow.webContents.getURL())) return;
  const script = `(() => {
    const show = () => {
    const stack = document.querySelector('.stack');
    if (!stack) return;
    let line = document.getElementById('oc-splash-status');
    if (!line) {
      line = document.createElement('div');
      line.id = 'oc-splash-status';
      line.style.cssText = 'margin-top:16px;font-size:13px;opacity:0.7;max-width:80vw;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      stack.appendChild(line);
    }
    line.textContent = ${JSON.stringify(text)};
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
  })();`;
  mainWindow.webContents.executeJavaScript(script).catch(() => {});
};

const showSplashConnecting = (hostLabel) => {
  showSplashStatus(menuLabel(normalizeMenuLocale(readPreferredLocale()), 'splash.connectingTo').replace('{host}', hostLabel));
};

const isPlainLocalBoot = () => {
  if (normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '')) return false;
  const { defaultHostId } = readDesktopHostsConfig();
  return !defaultHostId || defaultHostId === LOCAL_HOST_ID;
};

const resolveInitialUrl = async ({ onPlainLocalBoot = null } = {}) => {
  const hmrApiPort = process.env.OPENCHAMBER_HMR_API_PORT || '3901';
  const hmrUiPort = process.env.OPENCHAMBER_HMR_UI_PORT || '5173';
  const hmrApiUrl = `http://127.0.0.1:${hmrApiPort}`;
  const hmrUiUrl = `http://127.0.0.1:${hmrUiPort}`;
  const usePackagedUi = shouldUsePackagedUi();
  const skipLocalServer = await shouldSkipLocalServer();
  for (const line of describeStartupEnvironmentOverrides({
    skipLocalServer,
    serverUrl: process.env.OPENCHAMBER_SERVER_URL,
  })) {
    log.warn(`[startup] ${line}`);
  }
  const startupProbePlan = resolveStartupUrlProbePlan({
    development: isDev,
    packagedUi: usePackagedUi,
    skipLocalServer,
  });
  if (onPlainLocalBoot && usePackagedUi && !skipLocalServer && isPlainLocalBoot()) {
    onPlainLocalBoot(buildPackagedUiUrl('/index.html'));
  }
  const localUrl = skipLocalServer
    ? null
    : startupProbePlan.probeHmrApi && await waitForHealth(hmrApiUrl, 5_000, 100)
      ? hmrApiUrl
      : await spawnLocalServer();

  const localUiUrl = usePackagedUi
    ? buildPackagedUiUrl('/index.html')
    : startupProbePlan.probeHmrUi && await waitForHealth(hmrUiUrl, 8_000, 100)
    ? hmrUiUrl
    : localUrl;

  if (localUiUrl === hmrUiUrl) {
    await session.defaultSession.clearCache();
  }

  state.sidecarUrl = localUrl;
  state.localUiUrl = localUiUrl;
  const localAvailable = Boolean(localUrl);

  const localOrigin = localUrl ? new URL(localUrl).origin : null;
  let initialUrl = localUiUrl;
  let apiBaseUrl = localUrl || '';
  let clientToken = localUrl ? readDesktopLocalClientToken() : '';
  let requestHeaders = {};
  let remoteProbe = null;

  const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
  let config = readDesktopHostsConfig();
  let sshStartupFallbackHostId = null;
  const defaultSshInstanceId = envTarget
    ? null
    : resolveDefaultSshInstanceId(config.defaultHostId, sshManager.readInstances().instances);
  if (defaultSshInstanceId) {
    const sshHostLabel = config.hosts.find((entry) => entry.id === defaultSshInstanceId)?.label
      || sshManager.readInstances().instances.find((entry) => entry?.id === defaultSshInstanceId)?.nickname
      || defaultSshInstanceId;
    showSplashConnecting(sshHostLabel);
    const connected = await connectDefaultSshInstanceAtStartup({ sshManager, instanceId: defaultSshInstanceId });
    if (connected.ok) {
      config = readDesktopHostsConfig();
    } else if (localAvailable) {
      console.warn(`[startup] default SSH instance did not connect (${connected.reason}); opening Local`);
      sshStartupFallbackHostId = defaultSshInstanceId;
    }
  }
  if (envTarget) {
    apiBaseUrl = envTarget;
    clientToken = '';
    requestHeaders = {};
    initialUrl = usePackagedUi ? localUiUrl : envTarget;
  } else if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID && !sshStartupFallbackHostId) {
    const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
    if (host?.url) {
      apiBaseUrl = host.apiUrl || host.url;
      clientToken = host.clientToken || '';
      requestHeaders = sanitizeRuntimeRequestHeaders(host.requestHeaders || {});
      initialUrl = usePackagedUi ? localUiUrl : host.url;
    }
  }

  const defaultHostRelayCapable = Boolean(
    config.defaultHostId
    && config.defaultHostId !== LOCAL_HOST_ID
    && sanitizeHostRelayForStorage(config.hosts.find((entry) => entry.id === config.defaultHostId)?.relay),
  );
  if (apiBaseUrl && apiBaseUrl !== localUrl) {
    const remoteLabel = envTarget
      ? null
      : config.hosts.find((entry) => entry.id === config.defaultHostId)?.label;
    let remoteHostName = '';
    try {
      remoteHostName = new URL(apiBaseUrl).host;
    } catch {
      // A malformed stored URL fails the probe below; the label is cosmetic.
    }
    showSplashConnecting(remoteLabel || remoteHostName || apiBaseUrl);
    remoteProbe = await probeHostWithTimeout(apiBaseUrl, 2_000, clientToken, requestHeaders);
    if (remoteProbe.status === 'unreachable' && !defaultHostRelayCapable) {
      remoteProbe = await probeHostWithTimeout(apiBaseUrl, 10_000, clientToken, requestHeaders);
    }
    if (remoteProbe.status !== 'ok' && defaultHostRelayCapable) {
      apiBaseUrl = localUrl || '';
      clientToken = localUrl ? readDesktopLocalClientToken() : '';
      requestHeaders = {};
      initialUrl = localUiUrl;
    } else if (remoteProbe.status === 'unreachable') {
      state.unreachableHosts.add(apiBaseUrl);
      apiBaseUrl = localUrl || '';
      clientToken = localUrl ? readDesktopLocalClientToken() : '';
      requestHeaders = {};
      initialUrl = localUiUrl;
    }
  }

  if (!initialUrl && apiBaseUrl && remoteProbe?.status !== 'unreachable') {
    initialUrl = apiBaseUrl;
  }
  if (!initialUrl) {
    throw new Error(
      'OPENCHAMBER_SKIP_LOCAL_SERVER=1 requires bundled UI, a running desktop HMR UI, or a reachable remote instance.',
    );
  }

  const bootOutcome = sshStartupFallbackHostId
    ? { target: 'local', status: 'ok', localAvailable, sshStartupFallbackHostId }
    : computeBootOutcome({
      envTargetUrl: envTarget || null,
      probe: remoteProbe,
      config,
      localAvailable,
    });

  return { initialUrl, localOrigin, localUiUrl, bootOutcome, apiBaseUrl, clientToken, requestHeaders };
};

const UPDATER_E2E_BUILD = typeof __OPENCHAMBER_UPDATER_E2E_BUILD__ !== 'undefined'
  && __OPENCHAMBER_UPDATER_E2E_BUILD__ === true;

const readUpdateChannel = () => normalizeUpdateChannel(readSettingsRoot().desktopUpdateChannel, APP_VERSION);
const isDesktopAutoUpdateEnabled = () => readAutoUpdateEnabled(readSettingsRoot);
const maybeDownloadUpdateInBackground = () => {
  void startBackgroundDesktopUpdateDownload({
    app, autoUpdater, state, log, readAutoUpdateEnabled: isDesktopAutoUpdateEnabled, isLinuxPackageInstall,
  });
};

const applyUpdaterChannel = (channel, source = pickUpdaterSource({ mirrorFailedAt: state.updaterMirrorFailedAt })) => {
  if (state.updaterChannel === channel && state.updaterSource === source) return;
  if (state.updaterChannel !== null && state.updaterChannel !== channel) {
    state.pendingUpdate = null;
    void idleUpdateController.noteRelease(null);
  }
  const feed = resolveUpdaterFeed({ testBuild: UPDATER_E2E_BUILD, channel, source });
  const updaterChannel = [PRODUCTION_UPDATER_FEED, CANARY_UPDATER_FEED, STABLE_MIRROR_UPDATER_FEED, CANARY_MIRROR_UPDATER_FEED].includes(feed)
    ? resolveUpdaterChannel({ platform: process.platform, architecture: process.arch })
    : null;
  if (updaterChannel) {
    autoUpdater.channel = updaterChannel;
  }
  autoUpdater.setFeedURL(feed);
  autoUpdater.allowDowngrade = channel === 'stable' && isCanaryVersion(APP_VERSION);
  state.updaterChannel = channel;
  state.updaterSource = source;
  log.info('[electron] updater feed configured', {
    channel,
    source,
    provider: feed.provider,
    target: feed.provider === 'github' ? `${feed.owner}/${feed.repo}` : feed.url,
    manifest: updaterChannel || 'latest',
    allowDowngrade: autoUpdater.allowDowngrade,
  });
};

const setupAutoUpdater = () => {
  if (!app.isPackaged) return;
  enableMacosDirectContentsUpdates({ app, systemPreferences });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.fullChangelog = true;
  autoUpdater.disableWebInstaller = false;
  autoUpdater.logger = log;
  applyUpdaterChannel(readUpdateChannel());

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
    markDesktopUpdateDownloaded(state.pendingUpdate, info);
    if (state.pendingUpdate?.downloaded && state.pendingUpdate.version === info?.version) {
      const release = { version: state.pendingUpdate.version, channel: state.updaterChannel };
      void idleUpdateController.noteRelease(release);
      emitToAllWindows('openchamber:update-downloaded', release);
    }
  });

  autoUpdater.on('error', (err) => {
    setTaskbarProgress(-1);
    log.error('[electron] autoUpdater error', err);
  });
};

const assertDownloadedUpdateReady = () => {
  assertUpdaterCapability({ packaged: app.isPackaged });
  if (!state.pendingUpdate?.downloaded) throw new Error('No downloaded update');
  if (process.platform === 'darwin' && typeof app.isInApplicationsFolder === 'function' && !app.isInApplicationsFolder()) {
    throw new Error('Desktop update requires OpenChamber.app to be installed in /Applications');
  }
};

const installDownloadedUpdate = () => {
  assertDownloadedUpdateReady();
  if (state.updateInstallPending || state.installingUpdate) return null;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      debounceWindowStatePersist(state.mainWindow, true);
    } catch {
    }
  }
  return installDownloadedDesktopUpdate({
    state,
    autoUpdater,
    log,
    shutdownBackgroundServices: () => Promise.all([flushRendererStorage(), shutdownBackgroundServices()]),
    isLinuxPackageInstall,
    installLinuxPackage,
    readLinuxPackageType,
    performConfirmedQuit,
  });
};

const idleUpdateController = createDesktopIdleUpdate({
  state,
  emitToAllWindows,
  isLocalRuntimeUrl,
  install: installDownloadedUpdate,
  locale: () => appMenuLocale,
});

const parseRelevantChangelogNotes = (fromVersion, toVersion) => fetchUpdateNotes(fromVersion, toVersion, compareVersions);

const buildInstalledAppsCachePath = () => path.join(path.dirname(settingsFilePath()), INSTALLED_APPS_CACHE_FILE);

let installedAppsRefresh = null;

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

let linuxDesktopEntriesCache = { expiresAt: 0, entries: null };

const getLinuxDesktopEntries = async () => {
  const now = Date.now();
  if (linuxDesktopEntriesCache.entries && linuxDesktopEntriesCache.expiresAt > now) {
    return linuxDesktopEntriesCache.entries;
  }
  const entries = await readLinuxDesktopEntries();
  linuxDesktopEntriesCache = { entries, expiresAt: now + LINUX_DESKTOP_ENTRIES_CACHE_TTL_MS };
  return entries;
};

const buildPlatformInstalledApps = async (apps) => {
  if (process.platform === 'linux') {
    return buildLinuxInstalledApps(apps);
  }
  if (process.platform === 'win32') {
    return buildWindowsInstalledApps(apps);
  }
  return buildInstalledApps(apps);
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

const {
  runWhere,
  buildWindowsInstalledApps,
  fetchWindowsAppIcons,
  buildWindowsOpenProjectSpecs,
  buildWindowsOpenFileSpecs,
} = createWindowsAppDiscovery({ getFileIcon: (filePath, options) => app.getFileIcon(filePath, options) });

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

const resolveWindowsLaunchProgram = async (program) => {
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

const launchWindowsSpec = async (spec) => {
  const program = await resolveWindowsLaunchProgram(spec.program);
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

const runSpecChain = async (specs, appName) => {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(`Failed to open in ${appName}: no launch candidates`);
  }

  if (process.platform === 'win32') {
    const failures = [];
    for (const spec of specs) {
      try {
        await launchWindowsSpec(spec);
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

let devTunnelClientPromise = null;
const relayDevTunnelBridge = createRelayDevTunnelBridge({
  createMessageChannel: () => new MessageChannelMain(),
  logger: log,
  onClosed: ({ spaceId, localPort }) => {
    if (!spaceId) return;
    closeSpacePreviewPort(spaceId, localPort).catch((error) => {
      log.warn(`[electron] could not drop a preview port of space ${spaceId}: ${error?.message || error}`);
    });
  },
});
const getDevTunnelClient = async () => {
  if (!devTunnelClientPromise) {
    devTunnelClientPromise = import('@openchamber/web/server/lib/dev-tunnel/client.js')
      .then(({ createDevTunnelClient }) => createDevTunnelClient({ logger: log }))
      .catch((error) => {
        devTunnelClientPromise = null;
        throw error;
      });
  }
  return devTunnelClientPromise;
};

const closeAllDevTunnels = () => {
  relayDevTunnelBridge.closeAll();
  closeAllSpacePreviewPorts();
  if (!devTunnelClientPromise) return;
  const pending = devTunnelClientPromise;
  devTunnelClientPromise = null;
  pending.then((client) => client.closeAll()).catch(() => {});
};

const trayLocaleRouter = createTrayLocaleRouter((locale) => state.trayController?.setLocale(locale));

const contextWindows = createContextWindowController({ BrowserWindow, createBrowserWindow, nextWindowLabel, resolveRuntimeConfig: resolveMiniChatRuntimeConfig, mutateSettingsRoot, emitToWindow, isQuitting: () => state.quitRequested, isMainWindow: (browserWindow) => browserWindow === state.mainWindow, isBrowserPanelPopup: (browserWindow) => isBrowserPanelPopup(browserWindow), log });

const handleInvoke = async (browserWindow, command, args = {}) => {
  if (contextWindows.handles(command)) return contextWindows.invoke(browserWindow, command, args);
  switch (command) {
    case 'desktop_collect_local_diagnostics':
      {
        const ssh = collectSshBufferDiagnostics(sshManager.diagnosticLogSnapshots());
        let files;
        try {
          files = await collectLocalFileDiagnostics({ electronLogPath: log.transports.file.getFile().path });
        } catch {
          files = { events: [], coverage: [{ source: 'local files', status: 'unavailable' }] };
        }
        return { events: [...files.events, ...ssh.events], coverage: [...files.coverage, ...ssh.coverage] };
      }
    case 'desktop_set_close_tab_target': {
      const contents = browserWindow && !browserWindow.isDestroyed() ? browserWindow.webContents : null;
      if (!contents) return null;
      if (args?.active === true) {
        closeTabTargets.add(contents);
        if (!closeTabWatched.has(contents)) {
          closeTabWatched.add(contents);
          const forget = () => closeTabTargets.delete(contents);
          contents.on('did-navigate', forget);
          contents.on('render-process-gone', forget);
        }
      } else {
        closeTabTargets.delete(contents);
      }
      return null;
    }
    case 'desktop_pick_theme_file': {
      const { pickThemeFile } = await import('./theme-file-picker.mjs');
      return pickThemeFile({ showDialog: (options) => dialog.showOpenDialog(browserWindow || undefined, options) });
    }
    case 'desktop_start_window_drag':
      return null;

    case 'desktop_focus_window': {
      const target = browserWindow && !browserWindow.isDestroyed()
        ? browserWindow
        : (state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null);
      if (!target) return false;
      if (target.isMinimized()) target.restore();
      showWindow(target);
      target.focus();
      app.focus?.({ steal: true });
      return true;
    }

    case 'desktop_is_window_fullscreen':
      return Boolean(browserWindow?.isFullScreen());

    case 'desktop_set_window_title':
      if (browserWindow && typeof args.title === 'string') {
        browserWindow.setTitle(args.title);
      }
      return null;

    case 'desktop_managed_opencode_compatible':
      return canReuseManagedOpenCodePreflight({
        apiBaseUrl: args.apiBaseUrl,
        localOrigin: state.localOrigin,
        server: state.serverHandle,
      });

    case 'desktop_get_app_version':
      return APP_VERSION;

    case 'desktop_get_launch_at_login': {
      if (process.platform === 'linux') {
        return { supported: true, enabled: await readLinuxAutostartEnabled() };
      }
      if (process.platform !== 'darwin' && process.platform !== 'win32') return { supported: false, enabled: false };
      const settings = app.getLoginItemSettings(getLoginItemOptions());
      return { supported: true, enabled: settings.openAtLogin === true };
    }

    case 'desktop_set_launch_at_login': {
      if (process.platform === 'linux') {
        const enabled = args.enabled === true;
        return setLinuxAutostartEnabled({
          enabled,
          appName: app.getName(),
          backgroundArg: BACKGROUND_START_ARG,
        });
      }
      if (process.platform !== 'darwin' && process.platform !== 'win32') return { supported: false, enabled: false };
      const enabled = args.enabled === true;
      const settingsArgs = {
        openAtLogin: enabled,
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
      if (process.platform !== 'win32' && process.platform !== 'linux') return { supported: false, enabled: false };
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

    case 'desktop_get_mini_chat_global_shortcut': {
      return readDesktopMiniChatGlobalShortcutStatus();
    }

    case 'desktop_set_mini_chat_global_shortcut': {
      const combo = normalizeStoredShortcutCombo(args.combo);
      if (combo !== null && convertShortcutComboToAccelerator(combo) === null) {
        return { ...readDesktopMiniChatGlobalShortcutStatus(), error: 'unsupported-combo' };
      }
      await mutateSettingsRoot((root) => {
        if (combo === null) delete root[MINI_CHAT_GLOBAL_SHORTCUT_SETTING_KEY];
        else root[MINI_CHAT_GLOBAL_SHORTCUT_SETTING_KEY] = combo;
      });
      applyDesktopMiniChatGlobalShortcut();
      applyDesktopQuakeModeShortcut();
      return readDesktopMiniChatGlobalShortcutStatus();
    }

    case 'desktop_get_quake_mode': {
      return readDesktopQuakeModeStatus();
    }

    case 'desktop_set_quake_mode_enabled': {
      const enabled = args.enabled === true;
      await mutateSettingsRoot((root) => {
        root[QUAKE_MODE_ENABLED_KEY] = enabled;
      });
      if (!enabled) restoreNormalWindowFromQuake();
      applyDesktopQuakeModeShortcut();
      applyDesktopMiniChatGlobalShortcut();
      return readDesktopQuakeModeStatus();
    }

    case 'desktop_set_quake_mode_shortcut': {
      if (args.combo === QUAKE_MODE_UNASSIGNED) {
        await mutateSettingsRoot((root) => {
          root[QUAKE_MODE_SHORTCUT_KEY] = QUAKE_MODE_UNASSIGNED;
        });
        applyDesktopQuakeModeShortcut();
        applyDesktopMiniChatGlobalShortcut();
        return readDesktopQuakeModeStatus();
      }
      const combo = normalizeStoredShortcutCombo(args.combo);
      if (combo !== null && convertShortcutComboToAccelerator(combo) === null) {
        return { ...readDesktopQuakeModeStatus(), error: 'unsupported-combo' };
      }
      await mutateSettingsRoot((root) => {
        if (combo === null) delete root[QUAKE_MODE_SHORTCUT_KEY];
        else root[QUAKE_MODE_SHORTCUT_KEY] = combo;
      });
      applyDesktopQuakeModeShortcut();
      applyDesktopMiniChatGlobalShortcut();
      return readDesktopQuakeModeStatus();
    }

    case 'desktop_set_quake_mode_height': {
      const heightFraction = parseQuakeHeightFraction(args.heightFraction);
      await mutateSettingsRoot((root) => {
        root[QUAKE_MODE_HEIGHT_KEY] = heightFraction;
      });
      return readDesktopQuakeModeStatus();
    }

    case 'desktop_dev_tunnel_open': {
      const baseUrl = typeof args.baseUrl === 'string' ? args.baseUrl.trim() : '';
      const port = Number.isFinite(args.port) ? Math.trunc(args.port) : 0;
      if (!baseUrl) throw new Error('baseUrl is required');
      if (!(port > 0 && port <= 65535)) throw new Error('A valid port is required');
      const spaceId = args.spaceId ?? null;
      if (spaceId !== null && !isSpaceId(spaceId)) throw new Error('A valid space id is required');

      if (args.relay === true) {
        const targetKey = typeof args.targetKey === 'string' ? args.targetKey.trim() : '';
        const opened = await relayDevTunnelBridge.open({ targetKey, remotePort: port, spaceId, webContents: browserWindow?.webContents });
        if (spaceId) await openSpacePreviewPort(spaceId, opened.localPort);
        return opened;
      }

      const headers = {};
      const requestHeaders = args.requestHeaders && typeof args.requestHeaders === 'object' ? args.requestHeaders : {};
      for (const [name, value] of Object.entries(requestHeaders)) {
        if (typeof value === 'string' && value) headers[name] = value;
      }
      if (typeof args.clientToken === 'string' && args.clientToken) {
        headers.Authorization = `Bearer ${args.clientToken}`;
      }

      const client = await getDevTunnelClient();
      const result = await client.open({ baseUrl, port, headers, spaceId });
      if (spaceId) await openSpacePreviewPort(spaceId, result.localPort);
      return { localPort: result.localPort, reused: result.reused, url: `http://openchamber-preview.localhost:${result.localPort}/` };
    }

    case 'desktop_dev_tunnel_close': {
      const baseUrl = typeof args.baseUrl === 'string' ? args.baseUrl.trim() : '';
      const port = Number.isFinite(args.port) ? Math.trunc(args.port) : 0;
      if (!baseUrl || !(port > 0)) return { closed: false };
      const spaceId = isSpaceId(args.spaceId) ? args.spaceId : null;
      const client = await getDevTunnelClient();
      const tunnel = client.list().find((entry) => entry.baseUrl === baseUrl && entry.remotePort === port && entry.spaceId === spaceId);
      const closed = client.close({ baseUrl, port, spaceId });
      if (closed && spaceId && tunnel) await closeSpacePreviewPort(spaceId, tunnel.localPort);
      return { closed };
    }

    case 'desktop_relay_dev_tunnel_close_all':
      return { closed: relayDevTunnelBridge.closeForWebContents(browserWindow?.webContents.id) };

    case 'desktop_space_preview_prepare': {
      if (!isSpaceId(args.spaceId)) throw new Error('A valid space id is required');
      await applySpacePreviewProxy(args.spaceId);
      return { ready: true };
    }

    case 'desktop_browser_set_color_scheme': {
      const scheme = args.scheme === 'light' || args.scheme === 'dark' ? args.scheme : 'system';
      const target = resolveBrowserPanelContents(args.webContentsId);
      try {
        await browserPanelDriver.run(target, 'emulate', { colorScheme: scheme });
      } catch {
        throw new Error('This page could not be reached to change its appearance');
      }
      return { scheme };
    }

    case 'desktop_browser_keep_page_focused': {
      const target = resolveBrowserPanelContents(args.webContentsId);
      try {
        await browserPanelDriver.run(target, 'emulate', { focus: true });
      } catch {
        return { focused: false };
      }
      return { focused: true };
    }

    case 'desktop_browser_agent_action': {
      const target = resolveBrowserPanelContents(args.webContentsId);
      const request = browserAgentActionSchema.safeParse(args);
      if (!request.success) throw new Error('An agent action mark needs active and a session id or null');
      if (request.data.active) browserPanelAgentActions.start(target, request.data.sessionId ?? null);
      else browserPanelAgentActions.end(target);
      return { active: request.data.active };
    }

    case 'desktop_browser_drive': {
      const target = resolveBrowserPanelContents(args.webContentsId);
      const request = browserDriveRequestSchema.safeParse(args);
      if (!request.success) throw new Error('A browser driver step needs its operation');
      const { op } = request.data;
      if (op === 'setFiles') {
        const files = request.data.files ?? [];
        if (!files.every((file) => isStagedBrowserUpload(file))) {
          throw new Error('Only files staged for this upload can be attached');
        }
      }
      return browserPanelDriver.run(target, op, args);
    }

    case 'desktop_browser_stage_upload': {
      const files = Array.isArray(args.files) ? args.files : [];
      if (files.length === 0) throw new Error('No files to stage');
      return { paths: await stageBrowserUpload(files) };
    }

    case 'desktop_browser_fetch_favicon': {
      const view = resolveBrowserPanelContents(args.webContentsId);
      if (!isBrowsingSession(view.session)) {
        throw new Error('A space page has no favicon to fetch');
      }
      const target = typeof args.url === 'string' ? args.url.trim() : '';
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        throw new Error('A favicon URL is required');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Unsupported favicon URL');
      }

      const response = await view.session.fetch(parsed.toString());
      if (!response.ok) throw new Error(`Favicon request failed (${response.status})`);

      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!FAVICON_MIME_TYPES.has(mime)) throw new Error('Favicon is not an image');

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_FAVICON_BYTES) {
        throw new Error('Favicon is not a usable size');
      }
      return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    }

    case 'desktop_browser_clear_data': {
      const partition = typeof args.partition === 'string' ? args.partition.trim() : '';
      if (!BROWSING_PARTITIONS.includes(partition) && spaceIdOfPreviewPartition(partition) === null) {
        throw new Error('Unsupported browser partition');
      }
      const storages = [];
      if (args.cookies === true) storages.push('cookies');
      if (args.cache === true) storages.push('localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage');
      if (storages.length === 0) return { cleared: false };

      const browserSession = session.fromPartition(partition);
      await browserSession.clearStorageData({ storages });
      if (args.cache === true) await browserSession.clearCache();
      return { cleared: true };
    }

    case 'desktop_browser_capture_page': {
      const wc = resolveBrowserPanelContents(args.webContentsId);
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

    case 'desktop_notify': {
      maybeShowNativeNotification(stampForwardedNotification(args, resolveWindowHostId(browserWindow, hostRoutingContext())));
      return null;
    }

    case 'desktop_set_window_runtime_key': {
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.__ocRuntimeKey = readTrimmedString(args.runtimeKey);
      }
      return null;
    }

    case 'desktop_clear_session_notifications': {
      const sessionId = readTrimmedString(args?.sessionId);
      if (sessionId) clearSessionNotifications(sessionId);
      return null;
    }

    case 'desktop_clipboard_read_selection':
      if (process.platform !== 'linux' || !clipboard.selection) return '';
      return clipboard.selection.readText();

    case 'desktop_clipboard_write_selection': {
      if (process.platform !== 'linux' || !clipboard.selection) return false;
      const text = z.string().safeParse(args?.text);
      if (!text.success) return false;
      await clipboard.selection.writeText(text.data);
      return true;
    }

    case 'desktop_tray_actions_ready':
      if (browserWindow !== state.mainWindow) return null;
      mainWindowTrayActionsReady = true;
      if (pendingMarkAllRead) {
        pendingMarkAllRead = false;
        void dispatchTrayAction({ type: 'mark-all-read' });
      }
      return null;

    case 'desktop_tray_update':
      if (state.trayController) {
        try {
          trayLocaleRouter.publish(browserWindow);
          state.trayController.update(args || {});
        } catch (error) {
          log.warn('[electron] tray update failed', error);
        }
      }
      try {
        const rawCount = args && typeof args.dockBadgeCount === 'number' ? args.dockBadgeCount : 0;
        const badgeCount = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0;
        applyDockBadge(app, badgeCount);
        if (process.platform === 'darwin' && app.dock) {
          const template = buildDockMenuTemplate(args, {
            locale: normalizeMenuLocale(readPreferredLocale()),
            onAction: (action) => { void dispatchTrayAction(action); },
          });
          // external: https://www.electronjs.org/docs/latest/api/dock#docksetmenumenu Use an empty menu to clear it; Electron 45 rejects null.
          app.dock.setMenu(Menu.buildFromTemplate(template));
        }
        if (process.platform === 'win32' && app.isPackaged) {
          const jumpList = buildUnreadJumpList(args, {
            execPath: process.execPath, locale: normalizeMenuLocale(readPreferredLocale()),
            removedItems: app.getJumpListSettings().removedItems,
          });
          const key = JSON.stringify(jumpList);
          if (key !== lastJumpListKey) {
            const result = app.setJumpList(jumpList);
            if (result === 'ok') lastJumpListKey = key;
            else log.warn('[electron] unread jump list update failed', { result });
          }
        }
      } catch (error) {
        log.warn('[electron] dock badge update failed', error);
      }
      return null;

    case 'desktop_clear_cache':
      await clearAppCache({ session: session.defaultSession, windows: BrowserWindow.getAllWindows() });
      return null;

    case 'desktop_open_path': {
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      const appName = typeof args.app === 'string' ? args.app.trim() : '';
      const validated = await validateLocalPath(targetPath);
      if (process.platform === 'darwin') {
        const openArgs = appName ? ['-a', appName, validated.path] : [validated.path];
        spawn('open', openArgs, { detached: true, stdio: 'ignore' }).unref();
        return null;
      }
      if (appName && process.platform !== 'linux' && process.platform !== 'win32') {
        throw new Error(unsupportedAppSpecificOpenError('paths'));
      }
      const errorMessage = await shell.openPath(validated.path);
      if (errorMessage) {
        throw new Error(`Failed to open path: ${errorMessage}`);
      }
      return null;
    }

    case 'desktop_open_external_url': {
      const target = typeof args.url === 'string' ? args.url.trim() : '';
      if (!target) throw new Error('URL is required');

      const parsed = parseExternalUrl(target);

      const host = findConfiguredHostForUrl(parsed.toString());
      if (host) {
        await openHostWindow(host, sessionRouteFromUrl(parsed.toString()), { reuseOpenWindow: true });
        return null;
      }

      await shell.openExternal(parsed.toString());
      return null;
    }

    case 'desktop_reveal_path': {
      const validated = await validateLocalPath(typeof args.path === 'string' ? args.path.trim() : '');
      if (validated.stats.isDirectory()) {
        const errorMessage = await shell.openPath(validated.path);
        if (errorMessage) {
          throw new Error(`Failed to reveal path: ${errorMessage}`);
        }
        return null;
      }

      shell.showItemInFolder(validated.path);
      return null;
    }

    case 'desktop_open_in_app': {
      const projectPath = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!projectPath || !appId || !appName) {
        throw new Error('Project path, app id, and app name are required');
      }
      const validated = await validateLocalPath(projectPath, 'Project path');
      if (process.platform === 'win32') {
        if (appId === 'finder') {
          await openWindowsFolder(spawn, validated.path);
          return null;
        }
        await runSpecChain(await buildWindowsOpenProjectSpecs({ projectPath: validated.path, appId, appName }), appName);
        return null;
      }
      if (process.platform === 'linux') {
        const entries = await getLinuxDesktopEntries();
        await runLinuxSpecChain(buildLinuxOpenSpecs({
          targetPath: validated.path,
          appId,
          appName,
          targetKind: 'project',
          entries,
        }), appName, { shell });
        return null;
      }
      if (process.platform !== 'darwin') {
        throw new Error(unsupportedAppSpecificOpenError('projects'));
      }
      await runSpecChain(buildOpenProjectSpecs({ projectPath: validated.path, appId, appName }), appName);
      return null;
    }

    case 'desktop_open_in_app_over_ssh':
      return await openWindowProjectInSshEditor(args, {
        window: browserWindow,
        context: hostRoutingContext(),
        liveConnection: (id) => sshManager.connectedSshParsed(id),
        resolveSsh: (destination, sshArgs) => sshManager.dumpSshConfig(destination, sshArgs),
        openExternal: (url) => shell.openExternal(url),
        log: (step, error) => log.warn(`[electron] open in editor over SSH: ${step} failed`, error instanceof Error ? error.message : error),
      });

    case 'desktop_open_file_in_app': {
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!filePath || !appId || !appName) {
        throw new Error('File path, app id, and app name are required');
      }
      const validated = await validateLocalPath(filePath, 'File path');
      if (process.platform === 'win32') {
        if (appId === 'finder') {
          shell.showItemInFolder(validated.path);
          return null;
        }
        await runSpecChain(await buildWindowsOpenFileSpecs({ filePath: validated.path, appId, appName }), appName);
        return null;
      }
      if (process.platform === 'linux') {
        const entries = await getLinuxDesktopEntries();
        await runLinuxSpecChain(buildLinuxOpenSpecs({
          targetPath: validated.path,
          appId,
          appName,
          targetKind: 'file',
          entries,
        }), appName, { shell });
        return null;
      }
      if (process.platform !== 'darwin') {
        throw new Error(unsupportedAppSpecificOpenError('files'));
      }
      await runSpecChain(buildOpenFileSpecs({ filePath: validated.path, appId, appName }), appName);
      return null;
    }

    case 'desktop_filter_installed_apps': {
      if (process.platform === 'win32') {
        return (await buildWindowsInstalledApps(args.apps)).map((app) => app.name);
      }
      if (process.platform === 'linux') {
        return filterLinuxInstalledApps(args.apps);
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_filter_installed_apps is only supported on macOS, Windows, and Linux');
      }
      if (!Array.isArray(args.apps)) return [];
      const results = await Promise.all(
        args.apps.map(async (appName) => (await isAppBundleInstalled(String(appName))) ? String(appName) : null)
      );
      return results.filter(Boolean);
    }

    case 'desktop_fetch_app_icons': {
      if (process.platform === 'win32') {
        return fetchWindowsAppIcons(args.apps);
      }
      if (process.platform === 'linux') {
        return fetchLinuxAppIcons(Array.isArray(args.apps) ? args.apps : []);
      }
      if (process.platform !== 'darwin') {
        throw new Error('desktop_fetch_app_icons is only supported on macOS, Windows, and Linux');
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
      const isCacheStale = !cache
        || cache.version !== INSTALLED_APPS_CACHE_VERSION
        || (now - Number(cache.updatedAt || 0)) > INSTALLED_APPS_CACHE_TTL_SECS;
      const refresh = async () => {
        const apps = await buildPlatformInstalledApps(Array.isArray(args.apps) ? args.apps : []);
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, JSON.stringify({ version: INSTALLED_APPS_CACHE_VERSION, updatedAt: now, apps }, null, 2));
        emitToAllWindows('openchamber:installed-apps-updated', apps);
      };
      if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
        return { apps: [], hasCache: false, isCacheStale: false, supported: false };
      }
      if (!hasCache || isCacheStale || args.force === true) {
        installedAppsRefresh ??= refresh().finally(() => {
          installedAppsRefresh = null;
        });
      }
      return { apps: cachedApps, hasCache, isCacheStale };
    }

    case 'desktop_hosts_get': {
      const config = readDesktopHostsConfig();
      return {
        ...config,
        hosts: config.hosts.map((host) => sshManager.isForwardedApiUrl(host.apiUrl || host.url, host.id)
          ? { ...host, sshForwarded: true }
          : host),
        localOrigin: state.localOrigin || state.sidecarUrl || null,
      };
    }

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
      syncMainWindowInitScript(state.initScript);
      return null;
    }

    case 'desktop_local_client_token_get':
      return readDesktopLocalClientToken();

    case 'desktop_switch_to_local': {
      if (!browserWindow || browserWindow.id !== state.mainWindow?.id) return false;
      if (!state.sidecarUrl || isLocalSender(browserWindow.webContents)) return false;
      void switchToHostById(LOCAL_HOST_ID).catch((error) => {
        log.warn('[electron] failed to switch the main window to Local:', error);
      });
      return true;
    }

    case 'desktop_install_id_get':
      return getOrCreateDesktopInstallId();

    case 'desktop_host_probe':
      return probeDirectHostWithRetry((timeoutMs) => probeHostWithTimeout(
        String(args.url || ''),
        timeoutMs,
        String(args.clientToken || ''),
        args.requestHeaders || {},
        String(args.expectedServerId || ''),
      ));

    case 'desktop_host_update_server': {
      const hostId = String(args.hostId || '');
      const host = (readDesktopHostsConfig().hosts || []).find((entry) => entry?.id === hostId);
      const url = normalizeHostUrl(host?.apiUrl || host?.url || '');
      if (!host || !url) return { status: 'failed', error: null };
      return requestRemoteHostUpdate({
        url,
        clientToken: sanitizeClientTokenForStorage(host.clientToken) || '',
        requestHeaders: host.requestHeaders || {},
        chromiumFetch: (requestUrl, options) => electronNet.fetch(requestUrl, options),
      });
    }

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
      const splash = args.splash && typeof args.splash === 'object' ? args.splash : null;
      if (splash) {
        const colors = {};
        for (const key of ['bgLight', 'fgLight', 'bgDark', 'fgDark']) {
          if (isSplashColor(splash[key])) colors[key] = splash[key];
        }
        if (Object.keys(colors).length === 4) {
          const current = readSettingsRoot().desktopSplashColors;
          const unchanged = current && typeof current === 'object'
            && ['bgLight', 'fgLight', 'bgDark', 'fgDark'].every((key) => current[key] === colors[key]);
          if (!unchanged) {
            mutateSettingsRoot((root) => ({ ...root, desktopSplashColors: colors })).catch((error) => log.warn('[electron] could not save splash colors:', error));
          }
        }
      }
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

    case 'desktop_get_update_channel':
    case 'desktop_set_update_channel':
    case 'desktop_get_auto_update':
    case 'desktop_set_auto_update':
      return handleDesktopUpdatePreferenceCommand({
        command, args, readUpdateChannel, isUpdateChannel, readAutoUpdateEnabled: isDesktopAutoUpdateEnabled,
        isSupported: () => isAutoUpdateSupported({ app, isLinuxPackageInstall }),
        mutateSettingsRoot, onAutoUpdateEnabled: maybeDownloadUpdateInBackground,
      });

    case 'desktop_check_for_updates': {
      assertUpdaterCapability({ packaged: app.isPackaged });
      if (state.updateCheck && readUpdateChannel() !== state.updaterChannel) {
        await state.updateCheck.catch(() => null);
      }
      const channel = readUpdateChannel();
      applyUpdaterChannel(channel);
      const startedOn = state.updaterSource;
      const currentVersion = APP_VERSION;
      const runCheck = () => checkForDesktopUpdate({
        autoUpdater,
        currentVersion,
        pendingUpdate: state.pendingUpdate,
        missingFeedIsError: state.updaterSource === 'mirror',
      });
      const check = (async () => {
        try {
          return await runCheck();
        } catch (error) {
          if (startedOn !== 'mirror') throw error;
          log.warn('[electron] update mirror failed, checking GitHub', error instanceof Error ? error.message : String(error));
          state.updaterMirrorFailedAt = Date.now();
          applyUpdaterChannel(channel, 'github');
          return runCheck();
        }
      })();
      state.updateCheck = check;
      let result;
      try {
        result = await check;
      } finally {
        if (state.updateCheck === check) state.updateCheck = null;
      }
      const { available, updateInfo, nextVersion, pendingUpdate } = result;
      state.pendingUpdate = pendingUpdate;
      void idleUpdateController.noteRelease(pendingUpdate?.downloaded ? {
        version: pendingUpdate.version,
        channel,
      } : null);
      if (available && !pendingUpdate?.downloaded) maybeDownloadUpdateInBackground();
      const body =
        (typeof updateInfo?.releaseNotes === 'string' && updateInfo.releaseNotes.trim() ? updateInfo.releaseNotes : null) ||
        await parseRelevantChangelogNotes(currentVersion, nextVersion);
      return {
        available,
        downloaded: pendingUpdate?.downloaded === true,
        currentVersion,
        version: available ? nextVersion : null,
        body: body || null,
        date:
          (typeof updateInfo?.releaseDate === 'string' && updateInfo.releaseDate) ||
          null,
      };
    }

    case 'desktop_download_and_install_update':
      return downloadDesktopUpdateWithProgress({
        app, autoUpdater, state, assertUpdaterCapability, setTaskbarProgress, emitToAllWindows, mapUpdaterProgressEvent,
      });

    case 'desktop_get_idle_update':
      return idleUpdateController.snapshot();

    case 'desktop_queue_idle_update': {
      assertDownloadedUpdateReady();
      const version = typeof state.pendingUpdate.version === 'string' ? state.pendingUpdate.version : '';
      const channel = state.updaterChannel || readUpdateChannel();
      return await idleUpdateController.queue({ version, channel });
    }

    case 'desktop_cancel_idle_update':
      return await idleUpdateController.cancel();

    case 'desktop_restart': {
      const applyUpdate = Boolean(state.pendingUpdate?.downloaded && app.isPackaged);
      log.info(`[electron] desktop_restart applyUpdate=${applyUpdate} packaged=${app.isPackaged}`);
      if (state.updateInstallPending || state.installingUpdate) return null;
      if (applyUpdate) return await idleUpdateController.beginInstall();
      setImmediate(() => {
        void performConfirmedQuit({ relaunch: true });
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
        if (host?.url && apiUrl && !state.unreachableHosts.has(apiUrl)
          && state.bootOutcome?.sshStartupFallbackHostId !== host.id) {
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
      const hostId = typeof args.hostId === 'string' ? args.hostId.trim() : '';
      const config = readDesktopHostsConfig();
      const host = config.hosts.find((entry) => entry.id === hostId);
      if (!host) throw new Error('Host not found');
      await openHostWindow(host);
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
      const hostForUrl = config.hosts.find((host) => normalizeHostUrl(host.apiUrl || host.url) === targetUrl);
      const requestHeaders = sanitizeRuntimeRequestHeaders(args.requestHeaders || hostForUrl?.requestHeaders || {});
      let windowUrl = targetUrl;
      const runtimeConfig = { apiBaseUrl: targetUrl, clientToken, requestHeaders };
      if (shouldUsePackagedUi()) {
        windowUrl = buildPackagedUiUrl('/index.html');
      }
      const browserWindow = await createAdditionalWindow(windowUrl, { ...runtimeConfig, explicitRuntime: true });
      if (browserWindow && hostForUrl) {
        browserWindow.__ocHostWindowId = hostForUrl.id;
        browserWindow.__ocHostWindowBaseUrl = windowUrl;
      }
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

    case 'desktop_take_pending_host_actions':
      if (!browserWindow || !state.mainWindow || browserWindow.id !== state.mainWindow.id) return [];
      return pendingHostActions.splice(0, pendingHostActions.length);

    case 'desktop_take_pending_extension_installs':
      if (!browserWindow || !state.mainWindow || browserWindow.id !== state.mainWindow.id) return [];
      return takePendingExtensionInstalls();
    case 'desktop_take_pending_session_links':
      if (!browserWindow || !state.mainWindow || browserWindow.id !== state.mainWindow.id) return [];
      mainWindowSessionLinkGate.documentAsked();
      return takePendingSessionDeepLinks();

    case 'desktop_open_host_session': {
      const runtimeKey = readTrimmedString(args.runtimeKey);
      const sessionId = readTrimmedString(args.sessionId);
      const messageId = readTrimmedString(args.messageId);
      if (!runtimeKey || !sessionId) throw new Error('runtimeKey and sessionId are required');
      const host = resolveHostEntryForRuntimeKey(runtimeKey, hostRoutingContext());
      if (!host) {
        log.warn('[electron] open-host-session: no host for runtime key', { runtimeKey });
        return { opened: false };
      }
      await openHostWindow(host, parseSessionRoute(sessionId, messageId || null), { reuseOpenWindow: true });
      return { opened: true };
    }

    case 'desktop_focus_main_window': {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
      const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
      const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      const hasMainWindow = state.mainWindow && !state.mainWindow.isDestroyed();

      if (!hasMainWindow) {
        if (sessionId) pendingDeepLinks.push({ type: 'session', value: sessionId });
        await openMainWindow();
        return { focused: true };
      }

      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      showWindow(state.mainWindow);
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
      return {
        maximized: Boolean(browserWindow && !browserWindow.isDestroyed() && browserWindow.isMaximized()),
        visible: isNativeWindowVisible(browserWindow),
      };

    case 'desktop_set_tray_locale': {
      trayLocaleRouter.setLocale(browserWindow, parseTrayLocale(args?.locale));
      return null;
    }

    case 'desktop_set_locale': {
      if (typeof args.locale === 'string') {
        appMenuLocale = normalizeMenuLocale(args.locale);
        setContextMenuLocale(args.locale);
        if (process.platform === 'darwin') applyApplicationMenu();
      }
      return null;
    }

    case 'desktop_set_menu_shortcuts': {
      const next = normalizeMenuShortcuts(args.shortcuts);
      if (JSON.stringify(next) !== JSON.stringify(menuShortcuts)) {
        menuShortcuts = next;
        applyApplicationMenu();
      }
      return null;
    }

    case 'desktop_show_app_menu': {
      if (!browserWindow || browserWindow.isDestroyed()) {
        return null;
      }

      const locale = typeof args.locale === 'string' ? args.locale : 'en';
      const menu = buildAutoHiddenMenu(locale);
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

const buildMacMenu = (locale = 'en') => {
  const dispatchAction = (action) => dispatchMenuAction(action);
  const t = (key) => menuLabel(locale, key);
  const roleItem = (role, key) => roleMenuItem(locale, role, key);

  return Menu.buildFromTemplate([
    {
      label: t('app.name'),
      submenu: [
        { label: t('about'), click: () => dispatchAction('about') },
        {
          label: t('checkForUpdates'),
          click: () => dispatchCheckForUpdates(),
        },
        { type: 'separator' },
        { label: t('settings'), accelerator: 'Cmd+,', click: () => dispatchAction('settings') },
        { label: t('reloadWebview'), click: () => reloadMenuTargetWindow() },
        { label: t('restart'), click: () => relaunchFromMenu() },
        { label: t('commandPalette'), accelerator: 'Cmd+P', click: () => dispatchAction('command-palette') },
        { type: 'separator' },
        roleItem('services', 'services'),
        { type: 'separator' },
        roleItem('hide', 'hide'),
        roleItem('hideOthers', 'hideOthers'),
        { type: 'separator' },
        roleItem('quit', 'quit'),
      ],
    },
    {
      label: t('file'),
      submenu: [
        { label: t('newWindow'), accelerator: menuKey('new_window', 'Cmd+Shift+Alt+N'), click: () => void handleInvoke(null, 'desktop_new_window') },
        { type: 'separator' },
        { label: t('newSession'), accelerator: 'Cmd+N', click: () => dispatchAction('new-session') },
        { label: t('newWorktree'), accelerator: 'Cmd+Shift+N', click: () => dispatchAction('new-worktree-session') },
        { label: t('newMiniChat'), accelerator: 'Cmd+Alt+N', registerAccelerator: false, click: () => dispatchOpenMiniChat() },
        { type: 'separator' },
        { label: t('addWorkspace'), click: () => dispatchAction('change-workspace') },
        { type: 'separator' },
        { label: t('close'), accelerator: 'CmdOrCtrl+W', click: closeTabOrWindow },
      ],
    },
    {
      label: t('edit'),
      submenu: [
        roleItem('undo', 'undo'),
        roleItem('redo', 'redo'),
        { type: 'separator' },
        roleItem('cut', 'cut'),
        { label: t('copy'), accelerator: 'Cmd+C', click: () => handleCopyAction() },
        { label: t('addSelectionToChat'), accelerator: 'Cmd+L', registerAccelerator: false, click: () => dispatchAddSelectionToChat() },
        roleItem('paste', 'paste'),
        roleItem('selectAll', 'selectAll'),
      ],
    },
    {
      label: t('view'),
      submenu: [
        { label: t('toggleRightSidebar'), accelerator: 'Cmd+B', click: () => dispatchAction('toggle-right-sidebar') },
        { label: t('openGitSidebar'), accelerator: menuKey('open_git_panel', 'Cmd+Shift+G'), click: () => dispatchAction('open-right-sidebar-git') },
        { label: t('openFilesSidebar'), click: () => dispatchAction('open-right-sidebar-files') },
        { type: 'separator' },
        { label: t('toggleTerminalDock'), accelerator: 'Cmd+J', click: () => dispatchAction('toggle-terminal') },
        { label: t('toggleContextPanelExpanded'), accelerator: 'Cmd+Shift+F', click: () => dispatchAction('toggle-context-panel-expanded') },
        { type: 'separator' },
        { label: t('lightTheme'), click: () => dispatchAction('theme-light') },
        { label: t('darkTheme'), click: () => dispatchAction('theme-dark') },
        { label: t('systemTheme'), click: () => dispatchAction('theme-system') },
        { type: 'separator' },
        { label: t('toggleSessionSidebar'), accelerator: 'Cmd+Alt+L', click: () => dispatchAction('toggle-sidebar') },
        { label: t('toggleMemoryDebug'), accelerator: menuKey('toggle_memory_debug', 'Cmd+Shift+D'), click: () => dispatchAction('toggle-memory-debug') },
        { type: 'separator' },
        roleItem('togglefullscreen', 'toggleFullScreen'),
      ],
    },
    {
      label: t('window'),
      submenu: [
        roleItem('minimize', 'minimize'),
        roleItem('zoom', 'zoom'),
        { type: 'separator' },
        { label: t('zoomIn'), accelerator: menuKey('zoom_in', 'CmdOrCtrl+='), click: () => dispatchAction('zoom-in') },
        { label: t('zoomOut'), accelerator: menuKey('zoom_out', 'CmdOrCtrl+-'), click: () => dispatchAction('zoom-out') },
        { label: t('resetZoom'), accelerator: menuKey('zoom_reset', 'CmdOrCtrl+0'), click: () => dispatchAction('zoom-reset') },
        { type: 'separator' },
        { label: t('close'), accelerator: 'CmdOrCtrl+W', click: closeTabOrWindow },
      ],
    },
    {
      label: t('help'),
      submenu: [
        { label: t('keyboardShortcuts'), accelerator: 'Cmd+.', click: () => dispatchAction('help-dialog') },
        { label: t('showDiagnostics'), accelerator: menuKey('show_diagnostics', 'Cmd+Shift+L'), click: () => dispatchAction('download-logs') },
        { label: t('toggleDeveloperTools'), accelerator: menuKey('toggle_developer_tools', 'Cmd+Alt+I'), click: () => openDevToolsForMenuTarget() },
        { type: 'separator' },
        { label: t('clearCache'), click: () => void handleInvoke(null, 'desktop_clear_cache') },
        { type: 'separator' },
        { label: t('reportABug'), click: () => shell.openExternal(GITHUB_BUG_REPORT_URL) },
        { label: t('suggestFeature'), click: () => shell.openExternal(GITHUB_FEATURE_REQUEST_URL) },
        { type: 'separator' },
        { label: t('joinDiscord'), click: () => shell.openExternal(DISCORD_INVITE_URL) },
      ],
    },
  ]);
};

const buildAutoHiddenMenu = (locale = 'en') => {
  const dispatchAction = (action) => dispatchMenuAction(action);
  const t = (key) => menuLabel(locale, key);
  const roleItem = (role, key) => roleMenuItem(locale, role, key);

  return Menu.buildFromTemplate([
    {
      label: t('app.name'),
      submenu: [
        { label: t('about'), click: () => dispatchAction('about') },
        {
          label: t('checkForUpdates'),
          click: () => dispatchCheckForUpdates(),
        },
        { type: 'separator' },
        { label: t('settings'), accelerator: 'Ctrl+,', click: () => dispatchAction('settings') },
        { label: t('reloadWebview'), click: () => reloadMenuTargetWindow() },
        { label: t('restart'), click: () => relaunchFromMenu() },
        { label: t('commandPalette'), accelerator: 'Ctrl+P', click: () => dispatchAction('command-palette') },
        { type: 'separator' },
        roleItem('quit', 'quit'),
      ],
    },
    {
      label: t('file'),
      submenu: [
        { label: t('newWindow'), accelerator: menuKey('new_window', 'Ctrl+Shift+Alt+N'), click: () => void handleInvoke(null, 'desktop_new_window') },
        { type: 'separator' },
        { label: t('newSession'), accelerator: 'Ctrl+N', click: () => dispatchAction('new-session') },
        { label: t('newWorktree'), accelerator: 'Ctrl+Shift+N', click: () => dispatchAction('new-worktree-session') },
        { type: 'separator' },
        { label: t('addWorkspace'), click: () => dispatchAction('change-workspace') },
        { type: 'separator' },
        roleItem('quit', 'quit'),
      ],
    },
    {
      label: t('edit'),
      submenu: [
        roleItem('undo', 'undo'),
        roleItem('redo', 'redo'),
        { type: 'separator' },
        roleItem('cut', 'cut'),
        { label: t('copy'), accelerator: 'Ctrl+C', click: () => handleCopyAction() },
        { label: t('addSelectionToChat'), accelerator: 'Ctrl+L', registerAccelerator: false, click: () => dispatchAddSelectionToChat() },
        roleItem('paste', 'paste'),
        roleItem('selectAll', 'selectAll'),
      ],
    },
    {
      label: t('view'),
      submenu: [
        roleItem('reload', 'reload'),
        roleItem('forceReload', 'forceReload'),
        { label: t('toggleDeveloperTools'), accelerator: menuKey('toggle_developer_tools', 'Ctrl+Alt+I'), click: () => openDevToolsForMenuTarget() },
        { type: 'separator' },
        { label: t('toggleRightSidebar'), accelerator: 'Ctrl+B', click: () => dispatchAction('toggle-right-sidebar') },
        { label: t('openGitSidebar'), accelerator: menuKey('open_git_panel', 'Ctrl+Shift+G'), click: () => dispatchAction('open-right-sidebar-git') },
        { label: t('openFilesSidebar'), click: () => dispatchAction('open-right-sidebar-files') },
        { type: 'separator' },
        { label: t('toggleTerminalDock'), accelerator: 'Ctrl+J', click: () => dispatchAction('toggle-terminal') },
        { label: t('toggleContextPanelExpanded'), accelerator: 'Ctrl+Shift+F', click: () => dispatchAction('toggle-context-panel-expanded') },
        { type: 'separator' },
        { label: t('lightTheme'), click: () => dispatchAction('theme-light') },
        { label: t('darkTheme'), click: () => dispatchAction('theme-dark') },
        { label: t('systemTheme'), click: () => dispatchAction('theme-system') },
        { type: 'separator' },
        { label: t('toggleSessionSidebar'), accelerator: 'Ctrl+Alt+L', click: () => dispatchAction('toggle-sidebar') },
        { label: t('toggleMemoryDebug'), accelerator: menuKey('toggle_memory_debug', 'Ctrl+Shift+D'), click: () => dispatchAction('toggle-memory-debug') },
        { type: 'separator' },
        roleItem('togglefullscreen', 'toggleFullScreen'),
      ],
    },
    {
      label: t('go'),
      submenu: [
        { label: t('back'), accelerator: 'Ctrl+[', click: () => dispatchAction('go-back') },
        { label: t('forward'), accelerator: 'Ctrl+]', click: () => dispatchAction('go-forward') },
        { type: 'separator' },
        { label: t('previousSession'), click: () => dispatchAction('previous-session') },
        { label: t('nextSession'), click: () => dispatchAction('next-session') },
        { type: 'separator' },
        { label: t('previousProject'), accelerator: menuKey('previous_project', 'Ctrl+Alt+Up'), click: () => dispatchAction('previous-project') },
        { label: t('nextProject'), accelerator: menuKey('next_project', 'Ctrl+Alt+Down'), click: () => dispatchAction('next-project') },
      ],
    },
    {
      label: t('window'),
      submenu: [
        roleItem('minimize', 'minimize'),
        { label: t('zoomIn'), accelerator: menuKey('zoom_in', 'Ctrl+='), click: () => dispatchAction('zoom-in') },
        { label: t('zoomOut'), accelerator: menuKey('zoom_out', 'Ctrl+-'), click: () => dispatchAction('zoom-out') },
        { label: t('resetZoom'), accelerator: menuKey('zoom_reset', 'Ctrl+0'), click: () => dispatchAction('zoom-reset') },
        roleItem('togglefullscreen', 'toggleFullScreen'),
        { type: 'separator' },
        { label: t('close'), accelerator: 'CmdOrCtrl+W', click: closeTabOrWindow },
      ],
    },
    {
      label: t('help'),
      submenu: [
        { label: t('keyboardShortcuts'), accelerator: 'Ctrl+.', click: () => dispatchAction('help-dialog') },
        { label: t('showDiagnostics'), accelerator: menuKey('show_diagnostics', 'Ctrl+Shift+L'), click: () => dispatchAction('download-logs') },
        { type: 'separator' },
        { label: t('clearCache'), click: () => void handleInvoke(null, 'desktop_clear_cache') },
        { type: 'separator' },
        { label: t('reportABug'), click: () => shell.openExternal(GITHUB_BUG_REPORT_URL) },
        { label: t('suggestFeature'), click: () => shell.openExternal(GITHUB_FEATURE_REQUEST_URL) },
        { type: 'separator' },
        { label: t('joinDiscord'), click: () => shell.openExternal(DISCORD_INVITE_URL) },
      ],
    },
  ]);
};

const { labels: contextMenuLabels, apply: setContextMenuLocale } = createContextMenuLabels();

contextMenu({
  labels: contextMenuLabels,
  prepend: createCopyLinkMenuHook({
    clipboard,
    ClipboardItem,
    onError: () => log.warn('[context-menu] Failed to copy link to clipboard'),
  }),
  showInspectElement: isDev,
  showSaveImageAs: true,
  showCopyImage: true,
  showCopyLink: true,
});

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'window') {
    guardAttachedWebviews(contents);
    return;
  }
  if (contents.getType() !== 'webview') return;

  browserPanelDriver.run(contents, 'emulate', { pageBackground: true }).catch((error) => {
    log.warn(`[electron] could not give a panel page its default background: ${error?.message || error}`);
  });

  contents.on('before-input-event', (event, input) => {
    const action = browserPanelKeyAction(input, process.platform);
    if (!action) return;
    event.preventDefault();
    runBrowserPanelAction(contents, action);
  });
  contents.on('before-mouse-event', (event, mouse) => {
    const action = browserPanelMouseAction(mouse);
    if (!action) return;
    event.preventDefault();
    if (mouse.type === 'mouseUp') runBrowserPanelAction(contents, action);
  });

  browserPanelWindowOpen.attach(contents);
});

const isLocalSender = (webContents) => {
  try {
    const raw = typeof webContents?.getURL === 'function' ? webContents.getURL() : '';
    if (!raw) return false;
    const url = new URL(raw);
    if (url.protocol === `${UI_PROTOCOL}:` && url.hostname === 'app') return true;
    if (isDev && url.origin === `http://127.0.0.1:${process.env.OPENCHAMBER_HMR_UI_PORT || '5173'}`) return true;
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

ipcMain.handle('openchamber:invoke', async (event, command, args) => {
  if (!isLocalSender(event.sender) && !COMMANDS_SAFE_FOR_REMOTE.has(command)) {
    log.warn(`[ipc] rejected ${command} from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }
  const local = isLocalSender(event.sender);
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await handleInvoke(browserWindow, command, args);
  return !local && command === 'desktop_hosts_get' ? redactHostsConfigForRemote(result) : result;
});

ipcMain.on('openchamber:take-safe-start', (event) => {
  event.returnValue = takeSafeStart(event.sender);
});

ipcMain.on('openchamber:read-runtime-config', (event) => {
  event.returnValue = isRuntimeConfigFrame(event.senderFrame)
    ? {
      localOrigin: state.localOrigin || state.sidecarUrl || '',
      apiBaseUrl: state.apiBaseUrl || state.sidecarUrl || '',
      clientToken: state.clientToken || '',
      requestHeaders: sanitizeRuntimeRequestHeaders(BrowserWindow.fromWebContents(event.sender)?.__ocRuntimeConfig?.requestHeaders || {}),
    }
    : null;
});

ipcMain.handle('openchamber:dialog:open', async (event, options) => {
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


const TRAY_BREATH_FRAMES = [0, 3, 6, 9, 12, 15];
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
  if (process.platform === 'win32' || process.platform === 'linux') {
    const iconPath = process.platform === 'linux'
      ? (getWindowIconPath() || path.join(resourceRoot(), 'icons', 'icon.png'))
      : (getWindowIconPath() || path.join(resourceRoot(), 'icons', 'icon.ico'));
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
    breathIconPaths: TRAY_BREATH_FRAMES.map((i) =>
      path.join(dir, `trayTemplate-breath-${String(i).padStart(2, '0')}.png`)),
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
  if (!['darwin', 'win32', 'linux'].includes(process.platform) || state.trayController) return;
  if (process.platform === 'darwin' && readSettingsRoot().desktopMacMenuBarEnabled === false) return;
  const assets = trayIconAssets();
  if (!fs.existsSync(assets.idleIconPath)) {
    log.warn('[electron] tray icon missing, skipping tray setup', { iconPath: assets.idleIconPath });
    return;
  }
  try {
    state.trayController = createTrayController({
      ...assets, locale: readPreferredLocale(),
      onAction: (action) => { void dispatchTrayAction(action); },
    });
    if (!state.trayFocusListener) {
      state.trayFocusListener = (_event, browserWindow) => {
        if (browserWindow && !browserWindow.isDestroyed()) {
          state.lastFocusedWindowId = browserWindow.id;
        }
      };
      app.on('browser-window-focus', state.trayFocusListener);
    }
  } catch (error) {
    log.warn('[electron] failed to set up tray', error);
    state.trayController = null;
  }
};

const revealMainWindow = async () => {
  let target = state.mainWindow;
  if (!target || target.isDestroyed()) {
    target = await openMainWindow().catch(() => null) || state.mainWindow;
  }
  if (target && !target.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    showWindow(target);
    target.focus();
  }
  return target;
};

const focusMainWindowWithSession = async (sessionId, directory) => {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    showWindow(state.mainWindow);
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

  if (action.type === 'menu-opened') {
    const target = state.mainWindow;
    if (target && !target.isDestroyed()) emitToWindow(target, 'openchamber:tray-action', action);
    return;
  }

  if (action.type === 'quit') {
    app.quit();
    return;
  }

  if (action.type === 'hide-main-window') {
    const target = (state.mainWindow && !state.mainWindow.isDestroyed())
      ? state.mainWindow
      : BrowserWindow.getFocusedWindow();
    if (target && !target.isDestroyed() && target.isVisible()) {
      debounceWindowStatePersist(target, true);
      hideWindow(target);
    }
    return;
  }

  if (action.type === 'toggle-main-window') {
    const target = (state.mainWindow && !state.mainWindow.isDestroyed())
      ? state.mainWindow
      : null;
    if (target && target.isVisible() && !target.isMinimized() && !isWindowHidePending(target)) {
      debounceWindowStatePersist(target, true);
      hideWindow(target);
      return;
    }
    await revealMainWindow();
    return;
  }

  if (action.type === 'respond-permission' || action.type === 'mark-all-read') {
    const target = (state.mainWindow && !state.mainWindow.isDestroyed())
      ? state.mainWindow
      : await revealMainWindow();
    emitToWindow(target, 'openchamber:tray-action', action);
    return;
  }

  if (action.type === 'new-mini-chat') {
    let target = getMenuTargetWindow();
    if (!target) target = await revealMainWindow();
    dispatchOpenMiniChat(target);
    return;
  }

  if (action.type === 'focus-session') {
    const surface = resolveTraySurface();
    if (surface && surface.__ocMiniChat === true && action.sessionId) {
      if (surface.isMinimized()) surface.restore();
      showWindow(surface);
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
};

app.on('window-all-closed', () => {
  if (idleUpdateController.isClosingCountdown()) return;
  if (process.platform === 'darwin' && !state.quitRequested) {
    return;
  }

  if (process.platform !== 'darwin') {
    if (state.updateInstallPending) {
      log.info('[electron] window-all-closed while an update install is pending; leaving the exit to the installer');
      return;
    }
    if (state.installingUpdate) {
      log.info('[electron] window-all-closed after the installer took over; quitting');
      app.quit();
    } else {
      performConfirmedQuit();
    }
  }
});

app.on('before-quit', (event) => {
  state.quitRequested = true;
  closeAllDevTunnels();

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

const handleSecondInstance = (argv) => {
  if (process.platform === 'win32' && Array.isArray(argv) && argv.includes('--mark-all-read')) {
    pendingMarkAllRead = true;
    if (mainWindowTrayActionsReady) {
      pendingMarkAllRead = false;
      void dispatchTrayAction({ type: 'mark-all-read' });
    }
  }
  const urls = Array.isArray(argv)
    ? argv.filter((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`))
    : [];
  if (urls.length > 0) handleDeepLinks(urls);
  if (BrowserWindow.getAllWindows().length > 0) {
    focusForegroundWindow();
  } else {
    void openMainWindow();
  }
};

const handleOpenUrl = (url) => {
  handleDeepLinks([url]);
  if (BrowserWindow.getAllWindows().length === 0) {
    void openMainWindow();
  }
};

app.on('second-instance', (_event, argv) => {
  handleSecondInstance(argv);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleOpenUrl(url);
});

const replayDeferredAppEvents = () => {
  for (const event of takeDeferredAppEvents()) {
    if (event.type === 'open-url') handleOpenUrl(event.url);
    else if (event.type === 'second-instance') handleSecondInstance(event.argv);
  }
};

app.on('activate', async () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length === 0) {
    await openMainWindow();
    return;
  }

  const remembered = resolveTraySurface();
  const targetWindow = (remembered && !remembered.isDestroyed())
    ? remembered
    : (windows.find((window) => window.isVisible() && !window.isMinimized()) || windows[0]);
  if (targetWindow.isMinimized()) targetWindow.restore();
  showWindow(targetWindow);
  targetWindow.focus();
});

const COMPILE_CACHE_SETTLE_DELAY_MS = 5_000;
const scheduleCompileCacheSettle = () => {
  const timer = setTimeout(() => {
    void settleMainProcessCompileCache({ userDataDir: app.getPath('userData') });
  }, COMPILE_CACHE_SETTLE_DELAY_MS);
  timer.unref?.();
};

app.whenReady().then(async () => {
  if (wasEarlyWindowClosed()) return;
  const loginItemSettings = readLoginItemSettings();
  const isBackgroundStart = shouldStartInBackground(loginItemSettings);
  const mainWindowShown = isBackgroundStart ? null : showMainWindowWithSplash();
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
  hardenBrowserPanelSession();
  setupAutoUpdater();

  applyApplicationMenu();
  if (process.platform === 'darwin') {
    void applyDevDockIdentity({ app, electronDir: __dirname, log });
  }
  setupTray();
  applyDesktopMiniChatGlobalShortcut();
  applyDesktopQuakeModeShortcut();

  if ((process.platform === 'darwin' || process.platform === 'win32') && app.isPackaged) {
    const openAtLogin = loginItemSettings?.openAtLogin === true;
    app.setLoginItemSettings({
      openAtLogin,
      ...(process.platform === 'darwin' ? { args: openAtLogin ? [BACKGROUND_START_ARG] : [] } : {}),
      ...(process.platform === 'win32' ? { ...getLoginItemOptions(), enabled: openAtLogin } : {}),
    });
  }

  if (process.platform === 'linux' && app.isPackaged) {
    try {
      const enabled = await readLinuxAutostartEnabled();
      if (enabled) {
        await setLinuxAutostartEnabled({
          enabled: true,
          appName: app.getName(),
          backgroundArg: BACKGROUND_START_ARG,
        });
      }
    } catch (error) {
      log.warn('[electron] failed to reconcile Linux autostart entry', error);
    }
    void reconcileAppImageDesktopEntry()
      .then((result) => log.info('[electron] AppImage launcher entry', result))
      .catch((error) => log.warn('[electron] failed to reconcile AppImage launcher entry', error));
  }

  powerMonitor.on('suspend', () => {
    void idleUpdateController.noteSuspend();
  });
  powerMonitor.on('resume', () => {
    emitToAllWindows('openchamber:system-resume', { timestamp: Date.now() });
    void idleUpdateController.noteResume();
  });

  if (isBackgroundStart) {
    const { localOrigin, bootOutcome, apiBaseUrl, clientToken, requestHeaders } = await resolveInitialUrl();
    state.localOrigin = localOrigin;
    state.apiBaseUrl = apiBaseUrl;
    state.clientToken = clientToken;
    state.bootOutcome = bootOutcome ?? null;
    state.requestHeaders = sanitizeRuntimeRequestHeaders(requestHeaders || {});
    state.startupResolved = !(await shouldSkipLocalServer());
    state.initScript = buildInitScript(localOrigin, state.bootOutcome, apiBaseUrl, clientToken, state.requestHeaders);
    log.info('[electron] started in background without window');
    initialStartup.resolve();
    replayDeferredAppEvents();
    scheduleCompileCacheSettle();
    return;
  }

  const initial = extractInitialDeepLinks();
  if (initial.length > 0) handleDeepLinks(initial);

  await mainWindowShown;
  const { initialUrl, localOrigin, bootOutcome, apiBaseUrl, clientToken, requestHeaders } = await resolveInitialUrl({
    onPlainLocalBoot: startEarlyMainNavigation,
  });
  await activateMainWindow(initialUrl, localOrigin, bootOutcome, { apiBaseUrl, clientToken, requestHeaders });
  initialStartup.resolve();
  replayDeferredAppEvents();
  scheduleCompileCacheSettle();

}).catch((error) => {
  if (state.quitInProgress) return;
  log.error('[electron] startup failed:', error);
  app.exit(1);
});
