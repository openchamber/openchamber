export const checkForDesktopUpdate = async ({ autoUpdater, currentVersion, pendingUpdate, compareVersions }) => {
  let updateResult;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
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
