import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubPullRequestSummary } from '@/lib/api/types';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { getFreshestPrStatusForBranch, getGitHubPrStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { useDebouncedValue } from './useDebouncedValue';

type PullRequestList =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; prs: GitHubPullRequestSummary[]; page: number; hasMore: boolean; error: string | null }
  | { key: string; status: 'error'; message: string };
const NO_PULL_REQUESTS: GitHubPullRequestSummary[] = [];

export function usePullRequestComparison(directory: string | null, branch: string | null, enabled: boolean, preferredSource?: PullRequestSource) {
  const { github } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const selectionKey = JSON.stringify([runtimeKey, directory, branch]);
  const selection = usePullRequestSelectionStore((state) => state.selections.get(selectionKey) ?? null);
  const selectedSource = selection?.source ?? null;
  const saveSelection = usePullRequestSelectionStore((state) => state.select);
  const acceptHandoff = usePullRequestSelectionStore((state) => state.acceptHandoff);
  const pendingPreference = preferredSource && selection?.handoff !== preferredSource
    ? preferredSource : null;
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query, 350).trim();
  const key = JSON.stringify([selectionKey, search]);
  const [list, setList] = useState<PullRequestList | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);
  const owner = useRef({ key, enabled });
  owner.current = { key, enabled };
  const githubConnected = useGitHubAuthStore((state) => state.status?.connected ?? false);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const branchPr = useGitHubPrStatusStore((state) => directory && branch
    ? getFreshestPrStatusForBranch(state.entries, directory, branch) : null);

  // Use the existing fork/remote-aware resolver, not a matching head name in
  // the list: another contributor can have a branch with the same name.
  useEffect(() => {
    if (!enabled || !directory || !branch || selectedSource || !githubAuthChecked || !githubConnected) return;
    const store = useGitHubPrStatusStore.getState();
    const statusKey = getGitHubPrStatusKey(directory, branch);
    store.ensureEntry(statusKey);
    store.setParams(statusKey, { directory, branch, remoteName: null, canShow: true, github, githubAuthChecked, githubConnected });
    void store.refreshTargets([{ directory, branch, remoteName: null }]);
  }, [branch, directory, enabled, github, githubAuthChecked, githubConnected, selectedSource]);

  useEffect(() => {
    if (!enabled || !githubConnected || !branchPr?.pr || !branchPr.repo || usePullRequestSelectionStore.getState().selections.has(selectionKey)) return;
    saveSelection(selectionKey, { kind: 'pr', number: branchPr.pr.number,
      sourceRepo: { owner: branchPr.repo.owner, repo: branchPr.repo.repo } });
  }, [branchPr, enabled, githubConnected, saveSelection, selectionKey]);

  useEffect(() => {
    if (preferredSource) acceptHandoff(selectionKey, preferredSource);
  }, [acceptHandoff, preferredSource, selectionKey]);

  const refresh = useCallback(async (previous?: Extract<PullRequestList, { status: 'ready' }>) => {
    if (!directory || !enabled || owner.current.key !== key || !owner.current.enabled) return;
    const id = ++requestId.current;
    const runtime = getRuntimeKey();
    if (previous) setLoadingMore(true);
    else {
      setLoadingMore(false);
      setList({ key, status: 'loading' });
    }
    try {
      if (!github) throw new Error(t('session.githubPrPicker.error.runtimeUnavailable'));
      const page = previous ? previous.page + 1 : 1;
      const result = await github.prsList(directory, { page, query: search || undefined });
      if (!result.connected) throw new Error(t('session.githubPrPicker.empty.notConnected'));
      if (!result.prs || !result.repo) throw new Error(t('session.githubPrPicker.error.repoNotResolvable'));
      if (requestId.current !== id || getRuntimeKey() !== runtime || owner.current.key !== key || !owner.current.enabled) return;
      const repo = result.repo;
      const prs = result.prs.map((pr) => ({ ...pr, sourceRepo: pr.sourceRepo ?? { owner: repo.owner, repo: repo.repo, source: 'repository' } }));
      const merged = new Map([...(previous?.prs ?? []), ...prs].map((pr) => [`${pr.sourceRepo?.owner}/${pr.sourceRepo?.repo}#${pr.number}`, pr]));
      setList({ key, status: 'ready', prs: [...merged.values()], page, hasMore: Boolean(result.hasMore), error: null });
    } catch (error) {
      if (requestId.current === id && getRuntimeKey() === runtime && owner.current.key === key && owner.current.enabled) {
        const message = error instanceof Error ? error.message : t('session.githubPrPicker.toast.loadMoreFailed');
        setList(previous ? { ...previous, error: message } : { key, status: 'error', message });
      }
    } finally {
      if (requestId.current === id) setLoadingMore(false);
    }
  }, [directory, enabled, github, key, search, t]);

  useEffect(() => {
    if (listRef.current?.key !== key || listRef.current.status !== 'ready') void refresh();
    return () => { requestId.current += 1; };
  }, [key, refresh]);
  const current = list?.key === key ? list : null;
  return {
    enabled,
    selectedSource: pendingPreference ?? selectedSource,
    prs: current?.status === 'ready' ? current.prs : NO_PULL_REQUESTS,
    query, setQuery,
    loading: enabled && (!current || current.status === 'loading' || search !== query.trim()),
    loadingMore,
    hasMore: current?.status === 'ready' && current.hasMore,
    error: current?.status === 'error' ? current.message : current?.status === 'ready' ? current.error : null,
    refresh: () => refresh(),
    loadMore: () => current?.status === 'ready' && current.hasMore && !loadingMore ? refresh(current) : Promise.resolve(),
    select: (pr: GitHubPullRequestSummary) => {
      if (!pr.sourceRepo) return;
      saveSelection(selectionKey, { kind: 'pr', number: pr.number, sourceRepo: { owner: pr.sourceRepo.owner, repo: pr.sourceRepo.repo } });
    },
  };
}
