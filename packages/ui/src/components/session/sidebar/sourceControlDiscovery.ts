import { normalizePath } from './utils';

export const SOURCE_CONTROL_DISCOVERY_LIMIT = 50;

/**
 * The shown worktree branches whose change-request status is discovered: one
 * branch per directory, in the order they are shown, and at most
 * `SOURCE_CONTROL_DISCOVERY_LIMIT` directories, so a long sidebar never turns
 * into a burst of binding reads.
 */
export const limitSourceControlDiscoveryCandidates = (
  targets: Iterable<{ directory: string; branch: string }>,
): Array<{ directory: string; branch: string }> => {
  const candidates = new Map<string, { directory: string; branch: string }>();
  for (const target of targets) {
    const directory = normalizePath(target.directory);
    const branch = target.branch.trim();
    if (!directory || !branch || candidates.has(directory)) continue;
    candidates.set(directory, { directory, branch });
    if (candidates.size === SOURCE_CONTROL_DISCOVERY_LIMIT) break;
  }
  return [...candidates.values()];
};
