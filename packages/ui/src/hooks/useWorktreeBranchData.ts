import * as React from 'react';

import type { GitAPI, GitBranch } from '@/lib/api/types';
import { captureRuntimeInstance } from '@/lib/runtime-switch';

const REMOTE_BRANCH_SEARCH_LIMIT = 100;

const isRemoteBranch = (branchName: string) => branchName.startsWith('remotes/');
const withoutRemotePrefix = (branchName: string) => branchName.slice('remotes/'.length);

type BranchGitAPI = Pick<GitAPI, 'getGitBranches'>;

export function useWorktreeBranchData({
  open,
  directory,
  git,
}: {
  open: boolean;
  directory: string | null;
  git: BranchGitAPI | null;
}) {
  const [loadedBranches, setLoadedBranches] = React.useState<{ directory: string; data: GitBranch } | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = React.useState(false);
  const generationRef = React.useRef(0);
  const branchData = directory && loadedBranches?.directory === directory ? loadedBranches.data : null;

  const loadBranches = React.useCallback((remote: 'none' | 'live') => {
    if (!directory || !git) return;
    const generation = ++generationRef.current;
    const isCurrent = captureRuntimeInstance();
    setIsLoadingBranches(true);
    void git.getGitBranches(directory, { remote })
      .then((answer) => {
        if (isCurrent() && generation === generationRef.current) setLoadedBranches({ directory, data: answer });
      })
      .catch((error) => {
        console.error('Failed to fetch branches:', error);
      })
      .finally(() => {
        if (isCurrent() && generation === generationRef.current) setIsLoadingBranches(false);
      });
  }, [directory, git]);

  React.useEffect(() => {
    if (!open) return;
    loadBranches('none');
  }, [open, loadBranches]);

  const searchRemoteBranches = React.useCallback(async (query: string): Promise<string[]> => {
    if (!directory || !git) return [];
    const answer = await git.getGitBranches(directory, {
      remote: 'local',
      query,
      limit: REMOTE_BRANCH_SEARCH_LIMIT,
    });
    const normalizedQuery = query.trim().toLowerCase();
    return answer.all
      .filter(isRemoteBranch)
      .map(withoutRemotePrefix)
      .filter((branchName) => branchName.toLowerCase().includes(normalizedQuery));
  }, [directory, git]);

  const localBranches = React.useMemo(
    () => (branchData?.all ?? []).filter((branchName) => !isRemoteBranch(branchName)).sort(),
    [branchData],
  );
  const remoteBranches = React.useMemo(
    () => (branchData?.all ?? []).filter(isRemoteBranch).map(withoutRemotePrefix).sort(),
    [branchData],
  );

  return {
    localBranches,
    remoteBranches,
    fetchedBranchList: branchData?.all,
    defaultBranches: branchData?.defaultBranches,
    branchDetails: branchData?.branches,
    isLoadingBranches,
    searchRemoteBranches,
    fetchLiveBranches: React.useCallback(() => loadBranches('live'), [loadBranches]),
  };
}
