import { useEffect, useId } from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { getSourceControlStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

/**
 * Asks for the open pull or merge request of the checked-out branch through
 * the folder's bound context. The Git view, Changes and Walkthrough compare a
 * branch against its pull request's base, and the Git header shows its chip;
 * without asking themselves they waited for another surface or the sidebar to
 * have asked, so a stacked branch checked out in the same worktree compared
 * against the default branch until then, and a project's own checkout showed
 * no chip at all. The status
 * store dedupes by signature and throttles by TTL, so several surfaces asking
 * cost one request.
 */
export function useBranchPullRequestRequest(
  directory: string | null,
  branch: string | null,
  binding: ReturnType<typeof useRepositoryBinding>,
): void {
  const { sourceControl } = useRuntimeAPIs();
  const sourceControlAuthEntries = useSourceControlAuthStore((state) => state.entries);
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const beginActiveSourceControlContextsLoad = useGitHubPrStatusStore((state) => state.beginActiveContextsLoad);
  const commitActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.commitActiveContexts);
  const releaseActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.releaseActiveContexts);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);
  const ownerId = useId();

  useEffect(() => {
    if (!directory) return;
    const capturedRuntimeKey = binding.scope.runtimeKey;
    const contextRequestId = beginActiveSourceControlContextsLoad(capturedRuntimeKey, directory, ownerId);
    const activeContexts = binding.contexts.filter((context) => getSourceControlReadContextAuthState(
      sourceControlAuthEntries[getSourceControlAuthKey(context)], context,
    ).connected);
    commitActiveSourceControlContexts(capturedRuntimeKey, directory, ownerId, contextRequestId, activeContexts);
    return () => {
      releaseActiveSourceControlContexts(capturedRuntimeKey, directory, ownerId);
    };
  }, [beginActiveSourceControlContextsLoad, binding.contexts, binding.scope.runtimeKey, commitActiveSourceControlContexts, directory, ownerId, releaseActiveSourceControlContexts, sourceControlAuthEntries]);

  const readContext = binding.contexts[0] ?? null;
  const readAuthEntry = readContext ? sourceControlAuthEntries[getSourceControlAuthKey(readContext)] : undefined;
  const readAuth = readContext
    ? getSourceControlReadContextAuthState(readAuthEntry, readContext)
    : { authChecked: false, connected: false };

  useEffect(() => {
    if (!readContext || !branch) return;
    const key = getSourceControlStatusKey(readContext, branch);
    ensurePrStatusEntry(key);
    setPrStatusParams(key, {
      directory: readContext.directory,
      branch,
      remoteName: readContext.primaryRemote,
      canShow: true,
      identity: readContext,
      readContext,
      sourceControl,
      authChecked: readAuth.authChecked,
      connected: readAuth.connected,
    });
    void refreshPrStatusTargets([{ context: readContext, branch }]);
  }, [branch, ensurePrStatusEntry, readAuth.authChecked, readAuth.connected, readContext, refreshPrStatusTargets, setPrStatusParams, sourceControl]);
}
