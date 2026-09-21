import React from 'react';
import type { GitAPI, GitIdentitySummary, SourceControlAPI, SourceControlRepositoryRemote } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { gitRemoteHost, isSshRemoteUrl } from '@/lib/source-control/identity';

export type ExistingRepositoryRemote = SourceControlRepositoryRemote & {
  host: string | null;
  /** Whether the remote's own URLs allow a managed transport of each kind. */
  https: boolean;
  ssh: boolean;
};

/**
 * What a directory's own `.git` already states, read once when a repository is
 * about to be added. Every field is what the repository says about itself, so
 * the add screen can offer it instead of asking the person to restate it.
 */
export type ExistingRepositorySummary = {
  directory: string;
  repositoryId: string;
  configRevision: string;
  remotes: ExistingRepositoryRemote[];
  /** The remote a provider association would be anchored to. */
  primaryRemote: ExistingRepositoryRemote | null;
  author: GitIdentitySummary | null;
  /** True when `user.name`/`user.email` are set in this repository, not inherited. */
  authorIsLocal: boolean;
};

type ExistingRepositoryAPIs = {
  sourceControl: Pick<SourceControlAPI, 'repositoryContext'>;
  git: Pick<GitAPI, 'getCurrentGitIdentity' | 'hasLocalIdentity'>;
};

/** `origin` is the conventional anchor; any single remote speaks for itself. */
const choosePrimaryRemote = (remotes: ExistingRepositoryRemote[]): ExistingRepositoryRemote | null =>
  remotes.find((remote) => remote.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : null);

const PROBE_DELAY_MS = 250;

/**
 * Reads the repository at `directory` without binding anything.
 *
 * A repository with no remote is still reported: an identity says who commits
 * as well as which account a repository answers to, and a local-only
 * repository commits like any other. It simply has no remote to associate, so
 * `primaryRemote` is null and the add screen writes the signature alone.
 *
 * A directory that is not a repository, or that cannot be read, resolves to
 * null: the add screen then behaves exactly as it did before. The probe is
 * delayed because `directory` follows what is typed in the path field.
 */
export const useExistingRepositorySummary = (
  directory: string,
  { sourceControl, git }: ExistingRepositoryAPIs,
  enabled: boolean,
): ExistingRepositorySummary | null => {
  const [summary, setSummary] = React.useState<ExistingRepositorySummary | null>(null);

  React.useEffect(() => {
    if (!enabled || !directory) {
      setSummary(null);
      return;
    }
    const runtimeKey = getRuntimeKey();
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const context = await sourceControl.repositoryContext(directory);
          const remotes: ExistingRepositoryRemote[] = context.remotes.map((remote) => ({
            ...remote,
            host: gitRemoteHost(remote.fetch.displayUrl),
            https: [remote.fetch, remote.push].every((endpoint) => endpoint.displayUrl.startsWith('https://')),
            ssh: [remote.fetch, remote.push].every((endpoint) => isSshRemoteUrl(endpoint.displayUrl)),
          }));
          const [author, authorIsLocal] = await Promise.all([
            git.getCurrentGitIdentity(directory).catch(() => null),
            git.hasLocalIdentity?.(directory).catch(() => false) ?? Promise.resolve(false),
          ]);
          if (cancelled || runtimeKey !== getRuntimeKey()) return;
          setSummary({
            directory,
            repositoryId: context.repositoryId,
            configRevision: context.configRevision,
            remotes,
            primaryRemote: choosePrimaryRemote(remotes),
            author: author?.userName || author?.userEmail ? author : null,
            authorIsLocal: authorIsLocal === true,
          });
        } catch {
          if (!cancelled) setSummary(null);
        }
      })();
    }, PROBE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [directory, enabled, git, sourceControl]);

  return summary && summary.directory === directory ? summary : null;
};
