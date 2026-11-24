import { downloadPendingDesktopUpdate } from './updater-check.mjs';

const QUIT_INSTALL_FALLBACK_MS = 5_000;

export const readAutoUpdateEnabled = (readSettingsRoot) => (
  readSettingsRoot?.()?.desktopAutoUpdateEnabled !== false
);

const canApplyDesktopUpdate = (app, platform = process.platform) => (
  Boolean(app?.isPackaged)
  && (platform !== 'darwin' || typeof app.isInApplicationsFolder !== 'function' || app.isInApplicationsFolder())
);

export const isAutoUpdateSupported = ({ app, isLinuxPackageInstall, platform = process.platform }) => (
  canApplyDesktopUpdate(app, platform) && !isLinuxPackageInstall?.()
);

export const startBackgroundDesktopUpdateDownload = ({
  app,
  autoUpdater,
  state,
  log,
  readAutoUpdateEnabled: isEnabled,
  isLinuxPackageInstall,
  platform = process.platform,
}) => {
  if (!isAutoUpdateSupported({ app, isLinuxPackageInstall, platform })) return null;
  if (!isEnabled()) return null;
  if (!state.pendingUpdate || state.pendingUpdate.downloaded) return null;
  if (state.updateDownloadPromise) {
    if (state.updateDownloadVersion !== state.pendingUpdate.version && !state.backgroundDownloadRecheckQueued) {
      state.backgroundDownloadRecheckQueued = true;
      state.updateDownloadPromise.finally(() => {
        state.backgroundDownloadRecheckQueued = false;
        void startBackgroundDesktopUpdateDownload({
          app, autoUpdater, state, log, readAutoUpdateEnabled: isEnabled, isLinuxPackageInstall, platform,
        });
      });
    }
    return state.updateDownloadPromise;
  }

  const targetVersion = state.pendingUpdate.version;
  log.info(`[electron] starting background update download version=${targetVersion}`);
  return downloadPendingDesktopUpdate({ autoUpdater, state }).catch((error) => {
    if (state.updaterSource === 'mirror') state.updaterMirrorFailedAt = Date.now();
    log.warn('[electron] background update download failed', error instanceof Error ? error.message : String(error));
  });
};

export const tryInstallUpdateOnQuit = ({
  app,
  autoUpdater,
  state,
  log,
  readAutoUpdateEnabled: isEnabled,
  isLinuxPackageInstall,
  onFallbackExit,
  platform = process.platform,
  fallbackMs = QUIT_INSTALL_FALLBACK_MS,
}) => {
  if (!isAutoUpdateSupported({ app, isLinuxPackageInstall, platform })) return false;
  if (!isEnabled()) return false;
  if (!state.pendingUpdate?.downloaded) return false;

  let finished = false;
  let timer;
  const fallback = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    autoUpdater.off?.('error', fallback);
    state.installingUpdate = false;
    if (error) log.error('[electron] failed to install downloaded update on quit', error);
    else log.warn('[electron] quit-and-install timed out without exiting; exiting normally');
    onFallbackExit?.();
  };

  autoUpdater.once?.('error', fallback);
  try {
    state.installingUpdate = true;
    autoUpdater.autoRunAppAfterInstall = false;
    log.info(`[electron] installing downloaded update on quit version=${state.pendingUpdate.version}`);
    autoUpdater.quitAndInstall(true, false);
    timer = setTimeout(() => fallback(null), fallbackMs);
    timer.unref?.();
    return true;
  } catch (error) {
    clearTimeout(timer);
    autoUpdater.off?.('error', fallback);
    state.installingUpdate = false;
    log.error('[electron] failed to install downloaded update on quit', error);
    return false;
  }
};

export const downloadDesktopUpdateWithProgress = async ({
  app,
  autoUpdater,
  state,
  assertUpdaterCapability,
  setTaskbarProgress,
  emitToAllWindows,
  mapUpdaterProgressEvent,
}) => {
  assertUpdaterCapability({ packaged: app.isPackaged });
  if (!state.pendingUpdate) throw new Error('No pending update');
  setTaskbarProgress(0.01);
  emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
    event: 'Started',
    data: { contentLength: null },
  }));
  try {
    await downloadPendingDesktopUpdate({ autoUpdater, state });
    emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({ event: 'Finished', data: {} }));
    return null;
  } catch (error) {
    if (state.updaterSource === 'mirror') state.updaterMirrorFailedAt = Date.now();
    throw error;
  } finally {
    setTaskbarProgress(-1);
  }
};

export const handleDesktopUpdatePreferenceCommand = async ({
  command,
  args,
  readUpdateChannel,
  isUpdateChannel,
  readAutoUpdateEnabled: isEnabled,
  isSupported,
  mutateSettingsRoot,
  onAutoUpdateEnabled,
}) => {
  if (command === 'desktop_get_update_channel') {
    return { channel: readUpdateChannel() };
  }
  if (command === 'desktop_set_update_channel') {
    if (!isUpdateChannel(args?.channel)) throw new Error('Unknown update channel');
    const channel = args.channel;
    await mutateSettingsRoot((root) => { root.desktopUpdateChannel = channel; });
    return { channel };
  }
  if (command === 'desktop_get_auto_update') {
    return { enabled: isEnabled(), supported: isSupported() };
  }
  if (command === 'desktop_set_auto_update') {
    if (typeof args?.enabled !== 'boolean') throw new Error('Invalid auto-update flag');
    const enabled = args.enabled;
    await mutateSettingsRoot((root) => { root.desktopAutoUpdateEnabled = enabled; });
    if (enabled) onAutoUpdateEnabled?.();
    return { enabled, supported: isSupported() };
  }
  return undefined;
};
