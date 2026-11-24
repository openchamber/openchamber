const UPDATE_INSTALL_GRACE_MS = 15_000;
const UPDATE_SHUTDOWN_TIMEOUT_MS = 40_000;

export const installDownloadedDesktopUpdate = ({
  state,
  autoUpdater,
  log,
  shutdownBackgroundServices,
  isLinuxPackageInstall,
  installLinuxPackage,
  readLinuxPackageType,
  performConfirmedQuit,
}) => new Promise((resolve, reject) => {
  let settled = false;
  let graceTimer;
  let backendStopped = false;

  state.updateInstallPending = true;

  const rollbackQuitState = () => {
    state.updateInstallPending = false;
    state.quitRequested = false;
    state.installingUpdate = false;
  };

  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(graceTimer);
    autoUpdater.off('error', fail);
    rollbackQuitState();
    log.error('[electron] update install failed', error);
    reject(error instanceof Error ? error : new Error(String(error)));
    if (backendStopped) {
      log.info('[electron] relaunching on the current version after the failed install');
      void performConfirmedQuit({ relaunch: true });
    }
  };

  autoUpdater.on('error', fail);

  setImmediate(async () => {
    let shutdownTimer;
    try {
      backendStopped = true;
      await Promise.race([
        shutdownBackgroundServices(),
        new Promise((resolveTimeout) => {
          shutdownTimer = setTimeout(() => {
            log.warn('[electron] background shutdown timed out before update install; continuing');
            resolveTimeout(null);
          }, UPDATE_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
      if (settled) return;
      if (isLinuxPackageInstall()) {
        log.info('[electron] installing the downloaded package');
        autoUpdater.off('error', fail);
        await installLinuxPackage({
          packageType: readLinuxPackageType(),
          file: state.pendingUpdate?.downloadedFile,
          downgrade: state.pendingUpdate?.downgrade === true,
        });
        settled = true;
        autoUpdater.off('error', fail);
        resolve(null);
        log.info('[electron] package installed; restarting into the new version');
        state.updateInstallPending = false;
        void performConfirmedQuit({ relaunch: true });
        return;
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        autoUpdater.off('error', fail);
        resolve(null);
      }, UPDATE_INSTALL_GRACE_MS);
      state.quitRequested = true;
      state.installingUpdate = true;
      state.quitConfirmationPending = false;
      autoUpdater.autoRunAppAfterInstall = true;
      log.info('[electron] handing control to the platform installer');
      autoUpdater.quitAndInstall();
      state.updateInstallPending = false;
    } catch (error) {
      fail(error);
    } finally {
      clearTimeout(shutdownTimer);
    }
  });
});
