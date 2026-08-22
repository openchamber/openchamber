import type { GitHistoryRef } from '@/lib/api/types';
import type { GitHistoryGraphQuery } from '@/stores/useGitStore';
import type { GitRepositoryPaneState } from '@/stores/useUIStore';

type ManualGraphRefGroups = {
  branches: GitHistoryRef[];
  remoteBranches: GitHistoryRef[];
  tags: GitHistoryRef[];
};

type AutoRefreshGitGraphQueryState = {
  items: readonly { id: string }[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  outdated: boolean;
};

type AutoRefreshGitGraphInput = {
  isLoadingRefs: boolean;
  refsError: string | null;
  queryState: AutoRefreshGitGraphQueryState | null;
};

type GitGraphFilterDisabledInput = {
  isLoadingRefs: boolean;
  refsError: string | null;
};

type MergeBaseComparisonRefsInput = {
  current?: Pick<GitHistoryRef, 'id'> | null;
  upstream?: Pick<GitHistoryRef, 'id'> | null;
  base?: Pick<GitHistoryRef, 'id'> | null;
};

type GitGraphPanelRenderStateInput = {
  itemCount: number;
  queryError: string | null;
  refsError: string | null;
  mergeBaseError: string | null;
};

export const groupGraphRefs = (refs: readonly GitHistoryRef[]): ManualGraphRefGroups => ({
  branches: refs.filter((ref) => ref.category === 'branches' && ref.kind !== 'head'),
  remoteBranches: refs.filter((ref) => ref.category === 'remote-branches'),
  tags: refs.filter((ref) => ref.category === 'tags'),
});

export const resolveGraphQuery = (paneState: GitRepositoryPaneState): GitHistoryGraphQuery => {
  if (paneState.graphFilterMode === 'manual' && paneState.graphManualRefIds.length > 0) {
    return { mode: 'manual', refIds: paneState.graphManualRefIds };
  }

  if (paneState.graphFilterMode === 'all') {
    return { mode: 'all' };
  }

  return { mode: 'auto' };
};

export const shouldAutoRefreshGitGraphQuery = ({ isLoadingRefs, refsError, queryState }: AutoRefreshGitGraphInput): boolean => {
  if (!queryState) {
    return !isLoadingRefs && refsError === null;
  }

  return queryState.outdated
    && !queryState.isLoading
    && !queryState.isLoadingMore
    && queryState.error === null;
};

export const isGitGraphFilterDisabled = ({ isLoadingRefs, refsError }: GitGraphFilterDisabledInput): boolean => (
  isLoadingRefs || refsError !== null
);

export const resolveMergeBaseComparisonRefIds = ({ current, upstream, base }: MergeBaseComparisonRefsInput): string[] => {
  const refIds = Array.from(new Set([
    current?.id,
    upstream?.id,
    base?.id,
  ].filter((value): value is string => Boolean(value)))).sort();

  return refIds.length >= 2 ? refIds : [];
};

export const resolveGitGraphPanelRenderState = ({
  itemCount,
  queryError,
  refsError,
  mergeBaseError,
}: GitGraphPanelRenderStateInput) => {
  const showRows = itemCount > 0;

  return {
    showInlineMergeBaseError: showRows && mergeBaseError !== null,
    showRows,
    emptyMessage: showRows ? null : (queryError ?? refsError),
  };
};
