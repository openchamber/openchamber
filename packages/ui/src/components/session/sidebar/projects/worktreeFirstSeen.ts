import { normalizePath } from '../utils';

const firstSeenAtByPath = new Map<string, number>();

export const recordWorktreesSeen = (paths: Iterable<string | null | undefined>, seenAt: number): void => {
  for (const path of paths) {
    const normalized = normalizePath(path ?? null);
    if (normalized && !firstSeenAtByPath.has(normalized)) {
      firstSeenAtByPath.set(normalized, seenAt);
    }
  }
};

export const getWorktreeFirstSeenAt = (path: string | null | undefined): number => {
  const normalized = normalizePath(path ?? null);
  return normalized ? (firstSeenAtByPath.get(normalized) ?? 0) : 0;
};
