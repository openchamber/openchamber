const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

export const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

export const hasUpdateArtifact = (updateInfo, artifactExtension) => {
  if (!artifactExtension) return true;
  const extension = `.${artifactExtension.toLowerCase()}`;
  return Array.isArray(updateInfo?.files) && updateInfo.files.some((file) => {
    const url = typeof file?.url === 'string' ? file.url : '';
    return url.split(/[?#]/, 1)[0].toLowerCase().endsWith(extension);
  });
};

export const checkForDesktopUpdate = async ({
  autoUpdater,
  currentVersion,
  pendingUpdate,
  compareVersions,
  artifactExtension = null,
}) => {
  let updateResult;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
    // Before the first Linux (or platform) release publishes its feed, electron-updater
    // returns 404 for latest-*.yml. Treat that as authoritative "no update" instead of
    // surfacing a hard failure that looks like a broken updater.
    if (isMissingUpdateFeedError(error)) {
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
  if (available && !hasUpdateArtifact(updateInfo, artifactExtension)) {
    return {
      available: false,
      updateInfo: null,
      updateResult: null,
      nextVersion: currentVersion,
      pendingUpdate: null,
    };
  }
  return {
    available,
    updateInfo,
    updateResult,
    nextVersion,
    pendingUpdate: available ? { version: nextVersion, electronUpdate: updateResult } : null,
  };
};
