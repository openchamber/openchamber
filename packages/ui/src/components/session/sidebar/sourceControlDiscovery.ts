import { normalizePath } from './utils';

export const SOURCE_CONTROL_DISCOVERY_LIMIT = 50;

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

export const sourceControlDiscoverySignature = (
  candidates: ReadonlyArray<{ directory: string; branch: string }>,
): string => JSON.stringify(
  [...candidates].sort((left, right) => (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0)),
);

export const RELAY_BINDING_READ_CONCURRENCY = 8;

export const readWithConcurrency = async <T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<void> => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await read(items[next++]);
  }));
};
