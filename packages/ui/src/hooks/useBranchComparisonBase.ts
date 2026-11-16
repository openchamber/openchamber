import { useEffect, useMemo, useState } from 'react';
import { comparisonBaseBranchName, resolveBranchComparisonBase, type BranchComparisonBaseSource } from '@/components/views/git/baseBranch';
import type { GitBranch } from '@/lib/api/types';
import { getBranchBase } from '@/lib/gitApi';
import type { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { gitBaseBranchEntryKey, useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { getFreshestSourceControlStatusForBranch, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useGitStore } from '@/stores/useGitStore';

export interface BranchComparisonRepository {
  branches: GitBranch | null;
  remoteNames: ReadonlySet<string>;
  primaryRemote: string | null | undefined;
  readContext: SourceControlReadContext | null;
}

export function useBranchComparisonBase(
  directory: string | null,
  branch: string | null,
  enabled: boolean,
  repository: BranchComparisonRepository,
) {
  const { branches, remoteNames, primaryRemote, readContext } = repository;
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const statusFetchedAt = useGitStore((state) => enabled && directory
    ? state.directories.get(directory)?.lastStatusFetch ?? 0
    : 0);
  const key = JSON.stringify([runtimeKey, directory, branch]);
  const overrideKey = directory && branch ? gitBaseBranchEntryKey(directory, branch) : null;
  const override = useGitBaseBranchStore((state) => overrideKey ? state.overrides[overrideKey] ?? null : null);
  const branchStatus = useGitHubPrStatusStore((state) => readContext && branch
    ? getFreshestSourceControlStatusForBranch(state.entries, readContext, branch) : null);
  const pullRequest = branchStatus?.changeRequest ?? branchStatus?.pr ?? null;
  const pullRequestBase = pullRequest?.state === 'open' ? pullRequest.base : null;
  const [detected, setDetected] = useState<{ key: string; base: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !directory || !branch) return;
    let cancelled = false;
    const requestRuntime = getRuntimeKey();
    getBranchBase(directory, branch)
      .then(({ base }) => {
        if (cancelled || getRuntimeKey() !== requestRuntime) return;
        setDetected((previous) => previous?.key === key && previous.base === base ? previous : { key, base });
      })
      .catch(() => {
        if (cancelled || getRuntimeKey() !== requestRuntime) return;
        setDetected((previous) => previous?.key === key ? previous : { key, base: null });
      });
    return () => { cancelled = true; };
  }, [branch, directory, enabled, key, statusFetchedAt]);

  const detectedSettled = detected?.key === key;
  const createdFrom = detectedSettled ? detected.base : null;
  const resolution = useMemo(() => {
    if (!branch || !branches) return null;
    const all = branches.all ?? [];
    return resolveBranchComparisonBase({
      chosen: override,
      pullRequest: pullRequestBase,
      createdFrom,
      defaultBranch: detectedSettled && primaryRemote ? branches.defaultBranches?.[primaryRemote] ?? null : null,
    }, {
      localBranches: all.filter((name) => !name.startsWith('remotes/')),
      remoteBranches: all.filter((name) => name.startsWith('remotes/')).map((name) => name.slice('remotes/'.length)),
      remoteNames,
      primaryRemote,
      headBranch: branch,
    });
  }, [branch, branches, createdFrom, detectedSettled, override, primaryRemote, pullRequestBase, remoteNames]);

  const source: BranchComparisonBaseSource | null = resolution?.source ?? null;
  return {
    base: resolution?.ref ?? null,
    source,
    resolved: Boolean(resolution) || (detectedSettled && branches !== null),
    revision: JSON.stringify([runtimeKey, statusFetchedAt]),
  };
}

export function useBranchPullRequestBase(
  directory: string | null,
  branch: string | null,
  enabled: boolean,
  binding: ReturnType<typeof useRepositoryBinding>,
  branches: GitBranch | null,
  fallback: string,
): string {
  const primaryRemote = binding.contexts[0]?.primaryRemote;
  const remoteNames = useMemo(
    () => new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
    [binding.read],
  );
  const { base, source } = useBranchComparisonBase(directory, branch, enabled, {
    branches, remoteNames, primaryRemote, readContext: binding.contexts[0] ?? null,
  });
  return base && source && source !== 'default' ? comparisonBaseBranchName(base, primaryRemote) : fallback;
}
