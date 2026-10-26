import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import type { OverviewWorktreeFacts } from '@/lib/overview/overviewModel';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { getSourceControlStatusKey, selectEntryVisualSummary, useGitHubPrStatusStore, type PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

/** What a worktree branch's change request says, for Clean up. */
export type WorktreeChangeRequest = { pr: OverviewWorktreeFacts['pr']; mergedHeadSha: string | null };

const UNKNOWN: WorktreeChangeRequest = { pr: 'unknown', mergedHeadSha: null };

/**
 * The change request of each worktree branch, read the way the sidebar reads
 * the branches it shows: the directory's repository binding names the account,
 * the status store asks the host once per branch, and the answer lands in the
 * shared store. The sidebar does this only for branches it shows, so the page
 * asks for every linked worktree itself while it is open. A branch whose
 * repository has no connected account stays unknown, and an unknown branch is
 * never offered for removal.
 */
export type WorktreeChangeRequests = {
  changeRequestOf: (path: string) => WorktreeChangeRequest;
  /** The branch's PR badge, by the sidebar's colour rule; null while unknown or without one. */
  summaryOf: (path: string) => PrVisualSummary | null;
  /** The store keys of these branches, for following their open PRs live. */
  keys: readonly string[];
};

export function useWorktreeChangeRequests(
  targets: ReadonlyArray<{ path: string; branch: string }>,
): WorktreeChangeRequests {
  const { sourceControl } = useRuntimeAPIs();
  const [keyByPath, setKeyByPath] = React.useState<ReadonlyMap<string, string>>(new Map());
  const signature = targets.map((target) => `${target.path}\n${target.branch}`).sort().join('\n\n');
  const targetsRef = React.useRef(targets);
  targetsRef.current = targets;

  React.useEffect(() => {
    if (!signature) return;
    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    void (async () => {
      const resolved = await Promise.all(targetsRef.current.map(async (target) => {
        try {
          const load = await runBackgroundNetworkTask(() => repositoryBindingOwner.read(repositoryBindingOwner.scope(target.path), sourceControl));
          const context = load.contexts[0];
          if (!context) return null;
          const auth = useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(context)];
          if (!getSourceControlReadContextAuthState(auth, context).connected) return null;
          return { path: target.path, branch: target.branch, context, key: getSourceControlStatusKey(context, target.branch) };
        } catch {
          return null;
        }
      }));
      if (cancelled || runtimeKey !== getRuntimeKey()) return;
      const store = useGitHubPrStatusStore.getState();
      const toRead: Array<{ context: SourceControlReadContext; branch: string }> = [];
      const next = new Map<string, string>();
      for (const entry of resolved) {
        if (!entry) continue;
        next.set(entry.path, entry.key);
        store.ensureEntry(entry.key);
        store.setParams(entry.key, {
          directory: entry.context.directory,
          branch: entry.branch,
          remoteName: entry.context.primaryRemote,
          canShow: true,
          identity: entry.context,
          readContext: entry.context,
          sourceControl,
          authChecked: true,
          connected: true,
        });
        if (!useGitHubPrStatusStore.getState().entries[entry.key]?.isInitialStatusResolved) toRead.push({ context: entry.context, branch: entry.branch });
      }
      setKeyByPath(next);
      if (toRead.length > 0) await store.refreshTargets(toRead, { silent: true, markInitialResolved: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [signature, sourceControl]);

  const entries = useGitHubPrStatusStore((state) => state.entries);
  const changeRequestOf = React.useCallback((path: string): WorktreeChangeRequest => {
    const key = keyByPath.get(path);
    const entry = key ? entries[key] : undefined;
    // A failed read says nothing about the branch; only an answer does.
    if (!entry?.isInitialStatusResolved || entry.error) return UNKNOWN;
    const changeRequest = entry.status?.changeRequest ?? entry.status?.pr ?? null;
    if (!changeRequest) return { pr: 'none', mergedHeadSha: null };
    return { pr: changeRequest.state, mergedHeadSha: changeRequest.state === 'merged' ? changeRequest.headSha ?? null : null };
  }, [entries, keyByPath]);
  const summaryOf = React.useCallback((path: string): PrVisualSummary | null => {
    const key = keyByPath.get(path);
    return key ? selectEntryVisualSummary(entries, key) : null;
  }, [entries, keyByPath]);
  const keys = React.useMemo(() => [...keyByPath.values()], [keyByPath]);
  return React.useMemo(() => ({ changeRequestOf, summaryOf, keys }), [changeRequestOf, keys, summaryOf]);
}
