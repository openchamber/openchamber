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

/**
 * The candidate list's identity, independent of the order the sidebar shows it
 * in. Discovery restarts its subscriptions and binding reads only when this
 * changes: session activity reorders rows without adding work, and each
 * restart re-read every shown directory's binding (#6084).
 */
export const sourceControlDiscoverySignature = (
  candidates: ReadonlyArray<{ directory: string; branch: string }>,
): string => JSON.stringify(
  [...candidates].sort((left, right) => (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0)),
);

/**
 * How many bindings are read at once over the relay. There every request rides
 * one tunnel, so no browser connection pool needs protecting and each round
 * trip is slow; a binding read still spawns Git on the server, which bounds it.
 */
export const RELAY_BINDING_READ_CONCURRENCY = 8;

/** Runs `read` for every item, at most `limit` at a time. */
export const readWithConcurrency = async <T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<void> => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await read(items[next++]);
  }));
};
