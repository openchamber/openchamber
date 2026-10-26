// Where a dirty branch switch publishes the commit it just made. A tracked
// branch goes to its tracking ref (local `my-topic` tracking `origin/topic`
// pushes to `origin/topic`, so the upstream it re-asserts is the same one); an
// untracked branch publishes under its own name on the fallback remote.
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
    if (remoteName) return { remoteName, destinationRef: `refs/heads/${tracking.slice(remoteName.length + 1)}` };
  }
  return fallbackRemoteName ? { remoteName: fallbackRemoteName, destinationRef: `refs/heads/${branch}` } : null;
};
