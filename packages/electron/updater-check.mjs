const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

export const checkForDesktopUpdate = async ({ autoUpdater, currentVersion, pendingUpdate, compareVersions }) => {
  let updateResult;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
    // Before the first Linux (or platform) release publishes its feed, electron-updater
    // returns 404 for latest-*.yml. With no pending package, keep the first-release
    // "no update" behavior. A failed feed must preserve an existing package.
    if (isMissingUpdateFeedError(error) && !pendingUpdate) {
      return {
        available: false,
        updateInfo: null,
        updateResult: null,
        nextVersion: currentVersion,
        pendingUpdate: null,
      };
    }
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    throw new Error(`Unable to check for updates${detail}. Check your network connection and try again.`, { cause: error });
  }

  const updateInfo = updateResult?.updateInfo;
  const nextVersion =
    (typeof updateInfo?.version === 'string' && updateInfo.version) ||
    currentVersion;
  const available = compareVersions(nextVersion, currentVersion) > 0;
  // A check must not drop the payload state of the version already on disk:
  // desktop_restart installs only while `downloaded` is set, so replacing this
  // object after a download turns "Restart to Update" into a plain restart.
  const sameVersion = pendingUpdate?.version === nextVersion;
  return {
    available,
    updateInfo,
    updateResult,
    nextVersion,
    pendingUpdate: available
      ? {
          ...(sameVersion ? pendingUpdate : {}),
          version: nextVersion,
          electronUpdate: updateResult,
        }
      : null,
  };
};

export const markDesktopUpdateDownloaded = (pendingUpdate, info) => {
  if (!pendingUpdate || pendingUpdate.version !== info?.version) return;
  pendingUpdate.downloaded = true;
  if (info.downloadedFile) pendingUpdate.downloadedFile = info.downloadedFile;
};

export const downloadPendingDesktopUpdate = async ({ autoUpdater, state }) => {
  const pendingUpdate = state.pendingUpdate;
  if (!pendingUpdate) throw new Error('No pending update');
  if (state.updateDownloadPromise) {
    if (state.updateDownloadVersion !== pendingUpdate.version) {
      throw new Error('Another update download is already in progress. Try again when it finishes.');
    }
    return state.updateDownloadPromise;
  }
  if (!pendingUpdate.electronUpdate) {
    throw new Error('Electron updater metadata is not available for this build');
  }
  if (pendingUpdate.downloaded) return;

  // The promise also resolves for cached payloads, which may emit no event.
  state.updateDownloadPromise = Promise.resolve(autoUpdater.downloadUpdate()).then((files) => {
    markDesktopUpdateDownloaded(state.pendingUpdate, {
      version: pendingUpdate.version,
      downloadedFile: files?.[0],
    });
  });
  state.updateDownloadVersion = pendingUpdate.version;
  try {
    await state.updateDownloadPromise;
  } finally {
    state.updateDownloadPromise = null;
    state.updateDownloadVersion = null;
  }
};
