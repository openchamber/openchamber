const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

const TRANSIENT_RATE_LIMIT_RE =
  /429 Too Many Requests|Too many requests|secondary rate limit/i;

export const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

export const isTransientRateLimitError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TRANSIENT_RATE_LIMIT_RE.test(message);
};

export const checkForDesktopUpdate = async ({ autoUpdater, currentVersion, pendingUpdate, compareVersions }) => {
  let updateResult;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
    // Transient or missing-feed failures should read as "no update", not a broken updater:
    // - before the first platform release publishes its feed, electron-updater gets 404
    //   for latest-*.yml;
    // - GitHub's secondary rate limit can transiently 429 (or drop) the release-asset
    //   fetch when many unauthenticated requests share an IP. It clears on its own and
    //   the next check will retry — do not surface it as a network failure.
    if (isMissingUpdateFeedError(error) || isTransientRateLimitError(error)) {
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
  return {
    available,
    updateInfo,
    updateResult,
    nextVersion,
    pendingUpdate: available ? { version: nextVersion, electronUpdate: updateResult } : null,
  };
};
