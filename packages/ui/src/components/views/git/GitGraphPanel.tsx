import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { CommitFileEntry, GitHistoryRef } from '@/lib/api/types';
import type { RuntimeAPIs } from '@/lib/api/types';
import { HistoryCommitRow } from './HistoryCommitRow';
import { GitGraphSegment } from './GitGraphSegment';
import { buildGitHistoryViewModels } from './gitGraph';
import {
  useGitHistoryQueryState,
  useGitHistoryRefsState,
  useGitStore,
} from '@/stores/useGitStore';
import {
  DEFAULT_GIT_REPOSITORY_PANE_STATE,
  gitRepositoryPanePreferenceKey,
  useUIStore,
} from '@/stores/useUIStore';
import {
  groupGraphRefs,
  isGitGraphFilterDisabled,
  resolveGitGraphPanelRenderState,
  resolveMergeBaseComparisonRefIds,
  resolveGraphQuery,
  shouldAutoRefreshGitGraphQuery,
} from './gitGraphPanelModel';

interface GitGraphPanelProps {
  directory: string;
  git: RuntimeAPIs['git'];
  expandedCommitHashes: Set<string>;
  onToggleCommit: (hash: string) => void;
  commitFilesMap: Map<string, CommitFileEntry[]>;
  loadingCommitHashes: Set<string>;
  onCopyHash: (hash: string) => void;
  onConflict?: (result: { conflict: boolean; conflictFiles?: string[]; operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }) => void;
  onActionSuccess?: () => void;
}

export const GitGraphPanel: React.FC<GitGraphPanelProps> = ({
  directory,
  git,
  expandedCommitHashes,
  onToggleCommit,
  commitFilesMap,
  loadingCommitHashes,
  onCopyHash,
  onConflict,
  onActionSuccess,
}) => {
  const { t } = useI18n();
  const preferenceKey = gitRepositoryPanePreferenceKey(directory);
  const paneState = useUIStore((state) => state.gitRepositoryPaneStates[preferenceKey] ?? DEFAULT_GIT_REPOSITORY_PANE_STATE);
  const setPaneState = useUIStore((state) => state.setGitRepositoryPaneState);
  const ensureHistoryRefs = useGitStore((state) => state.ensureHistoryRefs);
  const fetchHistoryPage = useGitStore((state) => state.fetchHistoryPage);
  const [mergeBase, setMergeBase] = React.useState<string | null>(null);
  const [mergeBaseError, setMergeBaseError] = React.useState<string | null>(null);
  const { refs, refsError, isLoadingRefs } = useGitHistoryRefsState(directory);
  const query = React.useMemo(() => resolveGraphQuery(paneState), [paneState]);
  const queryState = useGitHistoryQueryState(directory, query);
  const currentRef = refs?.current ?? null;
  const upstreamRef = refs?.upstream ?? null;
  const baseRef = refs?.base ?? null;
  const currentRefId = currentRef?.id ?? null;
  const upstreamRefId = upstreamRef?.id ?? null;
  const baseRefId = baseRef?.id ?? null;
  const groupedRefs = React.useMemo(() => groupGraphRefs(refs?.refs ?? []), [refs]);
  const comparisonRefIds = React.useMemo(() => resolveMergeBaseComparisonRefIds({
    current: currentRefId ? { id: currentRefId } : null,
    upstream: upstreamRefId ? { id: upstreamRefId } : null,
    base: baseRefId ? { id: baseRefId } : null,
  }), [
    baseRefId,
    currentRefId,
    upstreamRefId,
  ]);
  const comparisonRequestKey = JSON.stringify([
    currentRefId,
    currentRef?.revision ?? null,
    upstreamRefId,
    upstreamRef?.revision ?? null,
    baseRefId,
    baseRef?.revision ?? null,
  ]);
  const queryItems = React.useMemo(() => queryState?.items ?? [], [queryState?.items]);
  const areFilterControlsDisabled = React.useMemo(
    () => isGitGraphFilterDisabled({ isLoadingRefs, refsError }),
    [isLoadingRefs, refsError],
  );
  const renderState = React.useMemo(() => resolveGitGraphPanelRenderState({
    itemCount: queryItems.length,
    queryError: queryState?.error ?? null,
    refsError,
    mergeBaseError,
  }), [mergeBaseError, queryItems.length, queryState?.error, refsError]);
  const viewModels = React.useMemo(() => {
    if (queryItems.length === 0 || !refs) {
      return [];
    }

    return buildGitHistoryViewModels(queryItems, {
      current: refs.current,
      upstream: refs.upstream,
      base: refs.base,
    }, {
      showIncoming: true,
      showOutgoing: true,
      mergeBase,
    });
  }, [mergeBase, queryItems, refs]);
  const totalColumns = React.useMemo(
    () => Math.max(1, ...viewModels.map((viewModel) => Math.max(viewModel.inputSwimlanes.length, viewModel.outputSwimlanes.length, 1))),
    [viewModels],
  );

  const refresh = React.useCallback(async () => {
    await ensureHistoryRefs(directory, git);
    await fetchHistoryPage(directory, git, query);
  }, [directory, ensureHistoryRefs, fetchHistoryPage, git, query]);

  React.useEffect(() => {
    if (!directory) {
      return;
    }
    if (shouldAutoRefreshGitGraphQuery({ isLoadingRefs, refsError, queryState })) {
      void refresh();
    }
  }, [directory, isLoadingRefs, queryState, refsError, refresh]);

  React.useEffect(() => {
    if (!git.getGitHistoryMergeBase || comparisonRefIds.length < 2) {
      setMergeBase(null);
      setMergeBaseError(null);
      return;
    }

    let cancelled = false;
    setMergeBase(null);
    setMergeBaseError(null);

    void git.getGitHistoryMergeBase(directory, { refs: comparisonRefIds }).then((result) => {
      if (!cancelled) {
        setMergeBase(result.mergeBase);
      }
    }).catch(() => {
      if (!cancelled) {
        setMergeBase(null);
        setMergeBaseError('failed');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [comparisonRefIds, comparisonRequestKey, directory, git]);

  React.useEffect(() => {
    if (!refs || paneState.graphFilterMode !== 'manual') {
      return;
    }

    const valid = paneState.graphManualRefIds.filter((refId) => refs.refs.some((ref) => ref.id === refId));
    if (valid.length === paneState.graphManualRefIds.length) {
      return;
    }

    setPaneState(directory, valid.length > 0
      ? { graphManualRefIds: valid }
      : { graphFilterMode: 'auto', graphManualRefIds: [] });
  }, [directory, paneState.graphFilterMode, paneState.graphManualRefIds, refs, setPaneState]);

  const toggleManualRef = React.useCallback((refId: string) => {
    setPaneState(directory, (current) => {
      const next = current.graphManualRefIds.includes(refId)
        ? current.graphManualRefIds.filter((id) => id !== refId)
        : current.graphManualRefIds.concat(refId).sort();
      return next.length > 0
        ? { graphFilterMode: 'manual', graphManualRefIds: next }
        : { graphFilterMode: 'auto', graphManualRefIds: [] };
    });
  }, [directory, setPaneState]);

  const renderRefGroup = (title: string, refsForGroup: readonly GitHistoryRef[]) => {
    if (refsForGroup.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-col gap-1">
        <div className="typography-micro font-medium text-muted-foreground">{title}</div>
        <div className="flex flex-wrap gap-1">
          {refsForGroup.map((ref) => {
            const selected = paneState.graphManualRefIds.includes(ref.id);
            return (
              <Button
                key={ref.id}
                type="button"
                variant="chip"
                size="xs"
                aria-pressed={selected}
                disabled={areFilterControlsDisabled}
                onClick={() => toggleManualRef(ref.id)}
              >
                {ref.name}
              </Button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section id="git-graph-panel" className="flex h-full min-h-0 flex-col rounded-xl border border-border/60 bg-background/70">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
        <Button type="button" size="xs" variant={paneState.graphFilterMode === 'auto' ? 'secondary' : 'ghost'} onClick={() => setPaneState(directory, { graphFilterMode: 'auto', graphManualRefIds: [] })} disabled={areFilterControlsDisabled}>
          {t('quota.window.auto')}
        </Button>
        <Button type="button" size="xs" variant={paneState.graphFilterMode === 'all' ? 'secondary' : 'ghost'} onClick={() => setPaneState(directory, { graphFilterMode: 'all', graphManualRefIds: [] })} disabled={areFilterControlsDisabled}>
          {t('contextPanel.preview.console.filter.all')}
        </Button>
        <Button type="button" size="xs" variant={paneState.graphFilterMode === 'manual' ? 'secondary' : 'ghost'} onClick={() => setPaneState(directory, { graphFilterMode: 'manual' })} disabled={areFilterControlsDisabled}>
          {t('sessions.sidebar.header.projectSort.manual')}
        </Button>
        <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={() => void refresh()} disabled={isLoadingRefs || queryState?.isLoading || queryState?.isLoadingMore}>
          <Icon name="refresh" className="mr-1 size-3" />
          {t('gitView.history.refresh')}
        </Button>
      </div>

      {paneState.graphFilterMode === 'manual' ? (
        <div className="flex flex-col gap-2 border-b border-border/50 px-3 py-2">
          <div className="typography-micro text-muted-foreground">{t('gitView.graph.manualSelection')}</div>
          {renderRefGroup(t('gitView.graph.localBranches'), groupedRefs.branches)}
          {renderRefGroup(t('gitView.branch.remoteBranches'), groupedRefs.remoteBranches)}
          {renderRefGroup(t('gitView.graph.tags'), groupedRefs.tags)}
        </div>
      ) : null}

      {queryState?.outdated ? (
        <div className="border-b border-border/50 px-3 py-2 typography-micro text-muted-foreground">{t('gitView.graph.outdated')}</div>
      ) : null}

      {renderState.showInlineMergeBaseError ? (
        <div
          id="git-graph-merge-base-error"
          role="alert"
          className="border-b border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2"
        >
          <p className="typography-micro text-[var(--status-warning-foreground)]">{t('gitView.graph.mergeBaseLookupFailed')}</p>
        </div>
      ) : null}

      {refsError && refs ? (
        <div id="git-graph-retained-refs-error" role="alert" className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
          <p className="typography-micro text-muted-foreground">{refsError}</p>
          <Button type="button" size="xs" onClick={() => void refresh()} disabled={isLoadingRefs || queryState?.isLoading || queryState?.isLoadingMore}>
            {t('contextPanel.preview.actions.retry')}
          </Button>
        </div>
      ) : null}

      {refsError && !refs ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="typography-meta text-muted-foreground">{refsError}</p>
          <Button type="button" size="sm" onClick={() => void refresh()}>{t('contextPanel.preview.actions.retry')}</Button>
        </div>
      ) : renderState.showRows ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ul className="divide-y divide-border/60">
            {viewModels.map((viewModel) => {
              if (viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes') {
                return (
                  <li key={viewModel.historyItem.id} data-history-commit-row={viewModel.historyItem.id}>
                    <div className="flex items-start gap-3 px-3 py-2">
                      <div className="-my-2 shrink-0 self-stretch">
                        <GitGraphSegment viewModel={viewModel} totalColumns={totalColumns} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="typography-ui-label font-medium text-foreground line-clamp-1">
                          {viewModel.kind === 'incoming-changes'
                            ? t('gitView.graph.incomingChanges')
                            : t('gitView.graph.outgoingChanges')}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              }

              return (
                <HistoryCommitRow
                  key={viewModel.historyItem.id}
                  entry={viewModel.historyItem}
                  mode="graph"
                  viewModel={viewModel}
                  totalColumns={totalColumns}
                  isExpanded={expandedCommitHashes.has(viewModel.historyItem.id)}
                  onToggle={() => onToggleCommit(viewModel.historyItem.id)}
                  files={commitFilesMap.get(viewModel.historyItem.id) ?? []}
                  isLoadingFiles={loadingCommitHashes.has(viewModel.historyItem.id)}
                  onCopyHash={onCopyHash}
                  directory={directory}
                  onConflict={onConflict}
                  onActionSuccess={onActionSuccess}
                />
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center typography-meta text-muted-foreground">
          {renderState.emptyMessage ?? t('gitView.history.noCommits')}
        </div>
      )}

      {queryState?.hasMore ? (
        <div className="border-t border-border/50 px-3 py-2">
          <Button type="button" variant="ghost" size="xs" onClick={() => void fetchHistoryPage(directory, git, query, { append: true })} disabled={queryState.isLoadingMore}>
            {queryState.isLoadingMore ? t('gitView.history.loadingMore') : t('gitView.history.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
