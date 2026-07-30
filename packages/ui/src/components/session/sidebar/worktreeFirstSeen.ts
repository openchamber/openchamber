import { normalizePath } from './utils';

// In-memory first-seen tracker for worktree directories. Worktree metadata
// carries no creation time, so we record when a path first appears during
// this app run: a worktree created mid-session sorts to the top of its
// project's empty-worktree tail, while everything discovered at startup ties
// (same tick) and falls back to alphabetical order.
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
