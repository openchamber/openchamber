import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { ChangeRequest, SourceControlReadContext } from '@/lib/source-control/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { mergeIncompleteSourceControlPage, sourceControlReadContextParts } from '@/lib/source-control/identity';
import type { PageResult } from '@/lib/source-control/types';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useRepositoryHost } from '@/components/references/referenceSources';
import { useGitStore } from '@/stores/useGitStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import {
  getFreshestSourceControlStatusForBranch,
  getSourceControlStatusKey,
  useGitHubPrStatusStore,
} from '@/stores/useGitHubPrStatusStore';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { useDebouncedValue } from './useDebouncedValue';

type PullRequestList =
  | { key: string; status: 'loading' }
  | {
    key: string;
    status: 'ready';
    prs: ChangeRequest[];
    page: number;
    hasMore: boolean;
    error: string | null;
    /** Projects (an upstream beside a fork) whose pull requests could not be read this time. */
    incompleteProjectIds: string[];
  }
  | { key: string; status: 'error'; message: string };
const NO_PULL_REQUESTS: ChangeRequest[] = [];
const NO_PROJECT_IDS: string[] = [];

const sourceOf = (pr: ChangeRequest): PullRequestSource => ({
  kind: 'pr', number: pr.number, sourceRepo: { owner: pr.project.owner, repo: pr.project.name },
});

const pullRequestKey = (pr: ChangeRequest) => `${pr.project.owner}/${pr.project.name}#${pr.number}`;

/**
 * Folds one page of pull requests into what the picker already shows. A
 * project the server could not read keeps the records it showed before rather
 * than reading as having none; the page still says which ones failed.
 */
export const mergePullRequestPage = (
  shown: ChangeRequest[],
  result: PageResult<ChangeRequest>,
  appending: boolean,
) => {
  const items = mergeIncompleteSourceControlPage(shown, result);
  const merged = new Map([...(appending ? shown : []), ...items].map((pr) => [pullRequestKey(pr), pr]));
  return { prs: [...merged.values()], incompleteProjectIds: result.incompleteProjectIds ?? [] };
};

/**
 * Lists and remembers the pull request a comparison reviews. Every read goes
 * through the checkout's bound GitHub or GitLab context, so the list and the branch's
 * own pull request come from the account and repository the binding grants,
 * never from whichever account happens to be active.
 */
export function usePullRequestComparison(
  directory: string | null,
  branch: string | null,
  readContext: SourceControlReadContext | null,
  enabled: boolean,
  preferredSource?: PullRequestSource,
) {
  const { sourceControl } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  // The server publishes pull request diffs for GitHub and GitLab only.
  const latestContext = readContext?.provider === 'github' || readContext?.provider === 'gitlab' ? readContext : null;
  const contextKey = latestContext ? JSON.stringify(sourceControlReadContextParts(latestContext)) : '';
  // Callers may hand over a fresh object each render; effects and callbacks key
  // on `contextKey` and read the object through this ref.
  const contextRef = useRef(latestContext);
  contextRef.current = latestContext;
  const context = latestContext;
  // Known even with no working account, so the messages name the right host.
  const hostProvider = useRepositoryHost(directory)?.provider;
  const provider = context?.provider ?? hostProvider ?? null;
  // A rebind to another repository must not carry a selection across.
  const selectionKey = JSON.stringify([runtimeKey, directory, branch, context?.repositoryId ?? null]);
  const selection = usePullRequestSelectionStore((state) => state.selections.get(selectionKey) ?? null);
  const selectedSource = selection?.source ?? null;
  const saveSelection = usePullRequestSelectionStore((state) => state.select);
  const acceptHandoff = usePullRequestSelectionStore((state) => state.acceptHandoff);
  const pendingPreference = preferredSource && selection?.handoff !== preferredSource
    ? preferredSource : null;
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query, 350).trim();
  const key = JSON.stringify([selectionKey, search, contextKey]);
  const [list, setList] = useState<PullRequestList | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);
  const owner = useRef({ key, enabled });
  owner.current = { key, enabled };
  const authEntry = useSourceControlAuthStore((state) => context ? state.entries[getSourceControlAuthKey(context)] : undefined);
  const auth = context ? getSourceControlReadContextAuthState(authEntry, context) : { authChecked: false, connected: false };
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);
  const branchStatus = useGitHubPrStatusStore((state) => context && branch
    ? getFreshestSourceControlStatusForBranch(state.entries, context, branch) : null);

  // Ask for this branch's own pull request through the same bound context.
  // The status store dedupes by signature and throttles by TTL.
  useEffect(() => {
    const context = contextRef.current;
    if (!enabled || !context || !branch || selectedSource || !auth.authChecked || !auth.connected) return;
    const statusKey = getSourceControlStatusKey(context, branch);
    ensurePrStatusEntry(statusKey);
    setPrStatusParams(statusKey, {
      directory: context.directory,
      branch,
      remoteName: context.primaryRemote,
      canShow: true,
      identity: context,
      readContext: context,
      sourceControl,
      authChecked: auth.authChecked,
      connected: auth.connected,
    });
    void refreshPrStatusTargets([{ context, branch }]);
  }, [auth.authChecked, auth.connected, branch, contextKey, enabled, ensurePrStatusEntry, refreshPrStatusTargets, selectedSource, setPrStatusParams, sourceControl]);

  const branchPr = branchStatus?.changeRequest ?? branchStatus?.pr ?? null;
  const branchProject = branchStatus?.project ?? null;
  useEffect(() => {
    if (!enabled || !auth.connected || !branchPr || !branchProject || usePullRequestSelectionStore.getState().selections.has(selectionKey)) return;
    saveSelection(selectionKey, { kind: 'pr', number: branchPr.number,
      sourceRepo: { owner: branchProject.owner, repo: branchProject.name } });
  }, [auth.connected, branchPr, branchProject, enabled, saveSelection, selectionKey]);

  useEffect(() => {
    if (preferredSource) acceptHandoff(selectionKey, preferredSource);
  }, [acceptHandoff, preferredSource, selectionKey]);

  const refresh = useCallback(async (previous?: Extract<PullRequestList, { status: 'ready' }>) => {
    if (!directory || !enabled || owner.current.key !== key || !owner.current.enabled) return;
    const id = ++requestId.current;
    const runtime = getRuntimeKey();
    const shownList = listRef.current;
    const shown = previous?.prs
      ?? (shownList?.key === key && shownList.status === 'ready' ? shownList.prs : NO_PULL_REQUESTS);
    if (previous) setLoadingMore(true);
    else {
      setLoadingMore(false);
      setList({ key, status: 'loading' });
    }
    try {
      const context = contextRef.current;
      if (!sourceControl) throw new Error(t(changeRequestCopy('session.githubPrPicker.error.runtimeUnavailable', provider)));
      if (!context || !auth.connected) throw new Error(t(changeRequestCopy('session.githubPrPicker.empty.notConnected', provider)));
      const page = previous ? previous.page + 1 : 1;
      const result = await sourceControl.changeRequestsList(context, { page, query: search || undefined });
      if (requestId.current !== id || getRuntimeKey() !== runtime || owner.current.key !== key || !owner.current.enabled) return;
      const merged = mergePullRequestPage(shown, result, Boolean(previous));
      setList({ key, status: 'ready', ...merged, page, hasMore: result.hasMore, error: null });
    } catch (error) {
      if (requestId.current === id && getRuntimeKey() === runtime && owner.current.key === key && owner.current.enabled) {
        const message = error instanceof Error ? error.message : t(changeRequestCopy('session.githubPrPicker.toast.loadMoreFailed', provider));
        setList(previous ? { ...previous, error: message } : { key, status: 'error', message });
      }
    } finally {
      if (requestId.current === id) setLoadingMore(false);
    }
  }, [auth.connected, directory, enabled, key, provider, search, sourceControl, t]);

  useEffect(() => {
    if (listRef.current?.key !== key || listRef.current.status !== 'ready') void refresh();
    return () => { requestId.current += 1; };
  }, [key, refresh]);
  const current = list?.key === key ? list : null;
  return {
    enabled,
    readContext: context,
    /** The host the change requests come from, for wording and numbering. */
    provider,
    selectedSource: pendingPreference ?? selectedSource,
    prs: current?.status === 'ready' ? current.prs : NO_PULL_REQUESTS,
    query, setQuery,
    loading: enabled && (!current || current.status === 'loading' || search !== query.trim()),
    loadingMore,
    hasMore: current?.status === 'ready' && current.hasMore,
    /** Projects whose pull requests failed to load; non-empty means the list is partial. */
    incompleteProjectIds: current?.status === 'ready' ? current.incompleteProjectIds : NO_PROJECT_IDS,
    error: current?.status === 'error' ? current.message : current?.status === 'ready' ? current.error : null,
    refresh: () => refresh(),
    loadMore: () => current?.status === 'ready' && current.hasMore && !loadingMore ? refresh(current) : Promise.resolve(),
    select: (pr: ChangeRequest) => saveSelection(selectionKey, sourceOf(pr)),
  };
}
