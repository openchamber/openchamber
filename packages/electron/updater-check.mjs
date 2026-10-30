const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

const releaseNumbers = (version) => String(version ?? '').replace(/^v/, '').split('-')[0].split('.')
  .map((part) => Number.parseInt(part, 10) || 0);

/**
 * Whether installing `nextVersion` over `currentVersion` goes back to an
 * older release. Only Stable after Canary does: the release before the one
 * the Canary build leads to (2.5.3 over 2.5.4-canary.20261030.1). The
 * release with the build's own number (2.5.4) is newer than the build.
 */
export const isDowngrade = (nextVersion, currentVersion) => {
  const next = releaseNumbers(nextVersion);
  const current = releaseNumbers(currentVersion);
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] || 0) !== (current[index] || 0)) return (next[index] || 0) < (current[index] || 0);
  }
  return false;
};

export const checkForDesktopUpdate = async ({ autoUpdater, currentVersion, pendingUpdate }) => {
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
  // electron-updater's own verdict. It compares semver and honours
  // `allowDowngrade`, which is how Stable after Canary offers the latest
  // release even though that release is older than the Canary build.
  const available = updateResult?.isUpdateAvailable === true
    && typeof updateInfo?.version === 'string'
    && updateInfo.version.length > 0;
  const nextVersion = available ? updateInfo.version : currentVersion;
  // Linux package managers refuse an older package unless told it is wanted.
  const downgrade = available && isDowngrade(nextVersion, currentVersion);
  return {
    available,
    updateInfo,
    updateResult,
    nextVersion,
    pendingUpdate: available ? { version: nextVersion, electronUpdate: updateResult, downgrade } : null,
  };
};
