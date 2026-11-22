export const dirtySwitchPushTarget = (
  branch: string,
  tracking: string | null | undefined,
  knownRemoteNames: string[],
  fallbackRemoteName: string | null,
): { remoteName: string; destinationRef: string } | null => {
  if (tracking) {
    const remoteName = knownRemoteNames
      .filter((name) => tracking.startsWith(`${name}/`) && tracking.length > name.length + 1)
      .sort((a, b) => b.length - a.length)[0];
    return remoteName ? { remoteName, destinationRef: `refs/heads/${tracking.slice(remoteName.length + 1)}` } : null;
  }
  return fallbackRemoteName ? { remoteName: fallbackRemoteName, destinationRef: `refs/heads/${branch}` } : null;
};
