import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { ChangeRequest, SourceControlReadContext } from '@/lib/source-control/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { mergeIncompleteSourceControlPage, sourceControlReadContextParts } from '@/lib/source-control/identity';
import type { PageResult } from '@/lib/source-control/types';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestDiffServing, useChangeRequestTerm, useSourceControlProviderServing } from '@/lib/source-control/providers/registry';
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
import { joinProjectPath } from '@/lib/source-control/projectPath';

type PullRequestList =
  | { key: string; status: 'loading' }
  | {
    key: string;
    status: 'ready';
    prs: ChangeRequest[];
    page: number;
    hasMore: boolean;
    error: string | null;
    incompleteProjectIds: string[];
  }
  | { key: string; status: 'error'; message: string };
const NO_PULL_REQUESTS: ChangeRequest[] = [];
const NO_PROJECT_IDS: string[] = [];

type ReadyList = Extract<PullRequestList, { status: 'ready' }>;

const LIST_FRESH_MS = 60_000;
const MAX_SHARED_LISTS = 30;
const sharedLists = new Map<string, { list: ReadyList; readAt: number }>();
export const forgetSharedPullRequestLists = () => sharedLists.clear();
const rememberList = (list: ReadyList) => {
  sharedLists.delete(list.key);
  sharedLists.set(list.key, { list, readAt: Date.now() });
  while (sharedLists.size > MAX_SHARED_LISTS) sharedLists.delete(sharedLists.keys().next().value ?? '');
};

const sourceOf = (pr: ChangeRequest): PullRequestSource => ({
  kind: 'pr', number: pr.number, sourceRepo: { owner: pr.project.owner, repo: pr.project.name },
});

const pullRequestKey = (pr: ChangeRequest) => `${joinProjectPath(pr.project.owner, pr.project.name)}#${pr.number}`;

export const mergePullRequestPage = (
  shown: ChangeRequest[],
  result: PageResult<ChangeRequest>,
  appending: boolean,
) => {
  const items = mergeIncompleteSourceControlPage(shown, result);
  const merged = new Map([...(appending ? shown : []), ...items].map((pr) => [pullRequestKey(pr), pr]));
  return { prs: [...merged.values()], incompleteProjectIds: result.incompleteProjectIds ?? [] };
};

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
  const serving = useSourceControlProviderServing(readContext?.provider);
  const providersUnknown = readContext !== null && serving === 'unknown';
  const diffServing = useChangeRequestDiffServing(readContext?.provider);
  const diffUnavailable = serving === 'served' && diffServing === 'not-served';
  const latestContext = serving === 'served' ? readContext : null;
  const contextKey = latestContext ? JSON.stringify(sourceControlReadContextParts(latestContext)) : '';
  const contextRef = useRef(latestContext);
  contextRef.current = latestContext;
  const context = latestContext;
  const hostProvider = useRepositoryHost(directory)?.provider;
  const provider = context?.provider ?? hostProvider ?? null;
  const changeRequestTerm = useChangeRequestTerm(provider);
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
  const [list, setList] = useState<PullRequestList | null>(() => sharedLists.get(key)?.list ?? null);
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

  const refresh = useCallback(async (previous?: ReadyList) => {
    if (!directory || !enabled || providersUnknown || owner.current.key !== key || !owner.current.enabled) return;
    const id = ++requestId.current;
    const runtime = getRuntimeKey();
    const shownList = listRef.current;
    const shownReady = shownList?.key === key && shownList.status === 'ready' ? shownList : null;
    const shown = previous?.prs ?? shownReady?.prs ?? NO_PULL_REQUESTS;
    if (previous) setLoadingMore(true);
    else {
      setLoadingMore(false);
      if (!shownReady) setList({ key, status: 'loading' });
    }
    try {
      const context = contextRef.current;
      if (!sourceControl) throw new Error(t(changeRequestCopy('session.githubPrPicker.error.runtimeUnavailable', changeRequestTerm)));
      if (!context || !auth.connected) throw new Error(t(changeRequestCopy('session.githubPrPicker.empty.notConnected', changeRequestTerm)));
      const page = previous ? previous.page + 1 : 1;
      const result = await sourceControl.changeRequestsList(context, { page, query: search || undefined });
      if (requestId.current !== id || getRuntimeKey() !== runtime || owner.current.key !== key || !owner.current.enabled) return;
      const merged = mergePullRequestPage(shown, result, Boolean(previous));
      const ready: ReadyList = { key, status: 'ready', ...merged, page, hasMore: result.hasMore, error: null };
      rememberList(ready);
      setList(ready);
    } catch (error) {
      if (requestId.current === id && getRuntimeKey() === runtime && owner.current.key === key && owner.current.enabled) {
        const message = error instanceof Error ? error.message : t(changeRequestCopy('session.githubPrPicker.toast.loadMoreFailed', changeRequestTerm));
        setList(previous ? { ...previous, error: message } : { key, status: 'error', message });
      }
    } finally {
      if (requestId.current === id) setLoadingMore(false);
    }
  }, [auth.connected, changeRequestTerm, directory, enabled, key, providersUnknown, search, sourceControl, t]);

  const revalidate = useCallback(() => {
    const shared = sharedLists.get(key);
    if (shared && listRef.current !== shared.list) setList(shared.list);
    if (shared && Date.now() - shared.readAt < LIST_FRESH_MS) return Promise.resolve();
    return refresh();
  }, [key, refresh]);

  useEffect(() => {
    if (listRef.current?.key !== key || listRef.current.status !== 'ready' || sharedLists.has(key)) void revalidate();
    return () => { requestId.current += 1; };
  }, [key, revalidate]);
  const current = list?.key === key ? list : null;
  return {
    enabled,
    readContext: context,
    provider,
    diffUnavailable,
    selectedSource: providersUnknown ? null : pendingPreference ?? selectedSource,
    prs: current?.status === 'ready' ? current.prs : NO_PULL_REQUESTS,
    query, setQuery,
    loading: enabled && (providersUnknown || !current || current.status === 'loading' || search !== query.trim()),
    loadingMore,
    hasMore: current?.status === 'ready' && current.hasMore,
    incompleteProjectIds: current?.status === 'ready' ? current.incompleteProjectIds : NO_PROJECT_IDS,
    error: current?.status === 'error' ? current.message : current?.status === 'ready' ? current.error : null,
    refresh: () => refresh(),
    revalidate,
    loadMore: () => current?.status === 'ready' && current.hasMore && !loadingMore ? refresh(current) : Promise.resolve(),
    select: (pr: ChangeRequest) => saveSelection(selectionKey, sourceOf(pr)),
  };
}
