import React from 'react';
import type { GitAPI, GitIdentitySummary, SourceControlAPI, SourceControlRepositoryRemote } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { gitRemoteHost, isSshRemoteUrl } from '@/lib/source-control/identity';

export type ExistingRepositoryRemote = SourceControlRepositoryRemote & {
  host: string | null;
  https: boolean;
  ssh: boolean;
};

export type ExistingRepositorySummary = {
  directory: string;
  repositoryId: string;
  configRevision: string;
  remotes: ExistingRepositoryRemote[];
  primaryRemote: ExistingRepositoryRemote | null;
  author: GitIdentitySummary | null;
  authorIsLocal: boolean;
};

type ExistingRepositoryAPIs = {
  sourceControl: Pick<SourceControlAPI, 'repositoryContext'>;
  git: Pick<GitAPI, 'getCurrentGitIdentity' | 'hasLocalIdentity'>;
};

const choosePrimaryRemote = (remotes: ExistingRepositoryRemote[]): ExistingRepositoryRemote | null =>
  remotes.find((remote) => remote.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : null);

const PROBE_DELAY_MS = 250;

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
            git.getCurrentGitIdentity ? git.getCurrentGitIdentity(directory).catch(() => null) : Promise.resolve(null),
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
