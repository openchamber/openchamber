import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { parseRemoteBranchRef } from './existing-branch-refs.js';

const REMOTE_REF_REFRESH_TTL_MS = 2 * 60_000;
const REMOTE_REF_REFRESH_ERROR_TTL_MS = 60_000;
const REMOTE_REF_REFRESH_TIMEOUT_MS = 15_000;
const REMOTE_REF_REFRESH_CACHE_LIMIT = 256;

export interface ParsedRemoteBranchRef {
  remote: string;
  branch: string;
  remoteRef: string;
  fullRef: string;
}

export interface RefreshRemoteRefResult {
  updated: boolean;
  oid: string;
}

export type RemoteBranchFetcher = (
  directory: string,
  target: ParsedRemoteBranchRef,
) => Promise<boolean>;

interface RefreshRemoteRefDeps {
  createRepositoryGitContext: (directory: string) => Promise<{ git: SimpleGit; repoRoot: string }>;
  runGitCommand: (
    cwd: string,
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<{ success: boolean }>;
}

const readCommitOid = async (git: SimpleGit, ref: string) => git
  .raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  .then((value) => String(value || '').trim())
  .catch(() => '');

export function createRemoteRefRefresher({ createRepositoryGitContext, runGitCommand }: RefreshRemoteRefDeps) {
  const inFlight = new Map<string, Promise<RefreshRemoteRefResult>>();
  const cooldown = new Map<string, { lastAttemptAt: number; ttlMs: number; oid: string }>();

  const recordCooldown = (scopeKey: string, entry: { lastAttemptAt: number; ttlMs: number; oid: string }) => {
    cooldown.delete(scopeKey);
    if (cooldown.size >= REMOTE_REF_REFRESH_CACHE_LIMIT) {
      const oldestKey = cooldown.keys().next().value;
      if (oldestKey) cooldown.delete(oldestKey);
    }
    cooldown.set(scopeKey, entry);
  };

  return async function refreshRemoteRef(
    directory: string,
    ref: string,
    { force = false, fetchBranch }: { force?: boolean; fetchBranch?: RemoteBranchFetcher | undefined } = {},
  ): Promise<RefreshRemoteRefResult> {
    const trimmed = String(ref || '').trim();
    if (!trimmed || trimmed.startsWith('refs/heads/')) {
      return { updated: false, oid: '' };
    }
    const remoteRef = parseRemoteBranchRef(trimmed);
    if (!remoteRef || remoteRef.branch === 'HEAD') {
      return { updated: false, oid: '' };
    }

    const { git, repoRoot } = await createRepositoryGitContext(directory);
    const remotes = await git.getRemotes().catch(() => []);
    if (!remotes.some((entry) => entry?.name === remoteRef.remote)) {
      return { updated: false, oid: '' };
    }

    const validRef = await runGitCommand(repoRoot, ['check-ref-format', `refs/heads/${remoteRef.branch}`]);
    if (!validRef.success) {
      return { updated: false, oid: '' };
    }

    const commonDirRaw = await git
      .raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .then((value) => String(value || '').trim())
      .catch(() => '');
    const scopeKey = `${commonDirRaw ? path.resolve(commonDirRaw) : path.resolve(repoRoot)}\0${remoteRef.remote}\0${remoteRef.branch}`;

    const pending = inFlight.get(scopeKey);
    if (pending) {
      return pending;
    }
    const cached = cooldown.get(scopeKey);
    if (!force && cached && Date.now() - cached.lastAttemptAt < cached.ttlMs) {
      return { updated: false, oid: cached.oid };
    }

    const task = (async (): Promise<RefreshRemoteRefResult> => {
      const before = await readCommitOid(git, remoteRef.fullRef);
      let succeeded = false;
      try {
        if (fetchBranch) {
          succeeded = await fetchBranch(directory, remoteRef);
        } else {
          const refspec = `+refs/heads/${remoteRef.branch}:${remoteRef.fullRef}`;
          const result = await runGitCommand(
            repoRoot,
            [
              'fetch',
              '--no-tags',
              '--no-prune',
              '--no-prune-tags',
              '--no-recurse-submodules',
              '--no-write-fetch-head',
              '--',
              remoteRef.remote,
              refspec,
            ],
            { timeoutMs: REMOTE_REF_REFRESH_TIMEOUT_MS },
          );
          succeeded = result.success;
        }
      } catch {
        succeeded = false;
      }

      const after = succeeded ? await readCommitOid(git, remoteRef.fullRef) : before;
      const finishedAt = Date.now();
      recordCooldown(scopeKey, {
        lastAttemptAt: finishedAt,
        ttlMs: succeeded ? REMOTE_REF_REFRESH_TTL_MS : REMOTE_REF_REFRESH_ERROR_TTL_MS,
        oid: after,
      });
      return { updated: Boolean(succeeded && after && after !== before), oid: after };
    })().finally(() => {
      if (inFlight.get(scopeKey) === task) {
        inFlight.delete(scopeKey);
      }
    });

    inFlight.set(scopeKey, task);
    return task;
  };
}
