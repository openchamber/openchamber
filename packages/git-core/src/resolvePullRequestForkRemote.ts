import type { GitRunner, PullRequestFork, PullRequestSourceInput } from './types.js';
import { PULL_REQUEST_REMOTE_SUFFIX_LIMIT } from './types.js';

/**
 * Allocate a stable fork remote name and ensure the URL is configured.
 *
 * Why this is non-trivial:
 *  - `upstream` may already be configured (often pointing at the base
 *    repo) so we never reuse it.
 *  - The user-suggested name (`source.fork.remote`) may collide with an
 *    existing user-configured remote — in that case we keep walking
 *    suffixes until we find a free name or hit the safety limit.
 *  - We prefer a remote whose URL already matches the desired fork URL,
 *    so the caller doesn't accidentally overwrite an unrelated remote.
 */
export const resolvePullRequestForkRemote = async (
  runner: GitRunner,
  primaryWorktree: string,
  source: PullRequestSourceInput,
): Promise<PullRequestFork | null> => {
  if (!source?.fork) {
    return null;
  }

  const preferredRemote = source.fork.remote;
  const safeRemoteBase = `${preferredRemote}-pr-${source.pullRequest.number}`;

  for (let suffix = -1; suffix < PULL_REQUEST_REMOTE_SUFFIX_LIMIT; suffix += 1) {
    const candidate = resolveCandidateName(preferredRemote, safeRemoteBase, suffix);

    if (!candidate || candidate === source.baseRemote) {
      continue;
    }

    const configured = await runner.run(primaryWorktree, ['remote', 'get-url', candidate]);
    if (configured.success) {
      if (configured.stdout.trim() === source.fork.url) {
        return { ...source.fork, remote: candidate };
      }
      continue;
    }

    const added = await runner.run(primaryWorktree, ['remote', 'add', candidate, source.fork.url]);
    if (added.success) {
      return { ...source.fork, remote: candidate };
    }

    const rechecked = await runner.run(primaryWorktree, ['remote', 'get-url', candidate]);
    if (rechecked.success && rechecked.stdout.trim() === source.fork.url) {
      return { ...source.fork, remote: candidate };
    }
  }

  return null;
};

/**
 * Compute the candidate fork-remote name for a given suffix iteration.
 *
 *   suffix <  0  → preferred name (no suffix)
 *   suffix === 0 → first suffixed name
 *   suffix  >  0 → `<safe>-<suffix + 1>`
 */
const resolveCandidateName = (
  preferredRemote: string,
  safeRemoteBase: string,
  suffix: number,
): string => {
  if (suffix < 0) {
    return preferredRemote;
  }
  if (suffix === 0) {
    return safeRemoteBase;
  }
  return `${safeRemoteBase}-${suffix + 1}`;
};
