import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { GitCommitHoverDetailsCache, GitHistoryRef } from '@/lib/api/types';
import type { RuntimeAPIs } from '@/lib/api/types';
import { HistoryCommitRow } from './HistoryCommitRow';
import { GitGraphSegment } from './GitGraphSegment';
import { GitCommitHoverPopover } from './GitCommitHoverPopover';
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
import type { GitCommitDetailsController } from './gitCommitDetailsController';

interface GitGraphPanelProps {
  directory: string;
  git: RuntimeAPIs['git'];
  isActive: boolean;
  readOnly?: boolean;
  commitDetailsController: GitCommitDetailsController;
  onCopyHash: (hash: string) => void;
  hoverRemoteName?: string | null;
  hoverRemoteUrl?: string | null;
  hoverDetailsCache?: GitCommitHoverDetailsCache | null;
  onConflict?: (result: { conflict: boolean; conflictFiles?: string[]; operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }) => void;
  onActionSuccess?: () => void;
}

export const GitGraphPanel: React.FC<GitGraphPanelProps> = ({
  directory,
  git,
  isActive,
  readOnly = false,
  commitDetailsController,
  onCopyHash,
  hoverRemoteName = null,
  hoverRemoteUrl = null,
  hoverDetailsCache = null,
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
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const appendRequestPendingRef = React.useRef(false);
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
  const hoverCoordinator = React.useMemo(() => GitCommitHoverPopover.createCoordinator(), []);
  const [, forceExpandedRefresh] = React.useReducer((count: number) => count + 1, 0);

  React.useEffect(() => commitDetailsController.subscribeExpanded(() => {
    forceExpandedRefresh();
  }), [commitDetailsController]);

  const refresh = React.useCallback(async () => {
    await ensureHistoryRefs(directory, git);
    await fetchHistoryPage(directory, git, query);
  }, [directory, ensureHistoryRefs, fetchHistoryPage, git, query]);

  React.useEffect(() => {
    if (!directory || !isActive) {
      return;
    }
    if (shouldAutoRefreshGitGraphQuery({ isLoadingRefs, refsError, queryState })) {
      void refresh();
    }
  }, [directory, isActive, isLoadingRefs, queryState, refsError, refresh]);

  React.useEffect(() => {
    if (!isActive || !git.getGitHistoryMergeBase || comparisonRefIds.length < 2) {
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
  }, [comparisonRefIds, comparisonRequestKey, directory, git, isActive]);

  React.useEffect(() => {
    if (!isActive) {
      appendRequestPendingRef.current = false;
      return;
    }

    const IntersectionObserverConstructor = globalThis.IntersectionObserver;

    if (!queryState?.hasMore || queryState.outdated || queryState.isLoading || queryState.isLoadingMore || queryState.error || !scrollContainerRef.current || !sentinelRef.current || !IntersectionObserverConstructor) {
      return;
    }

    const observer = new IntersectionObserverConstructor((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting || appendRequestPendingRef.current || !isActive || !queryState.hasMore || queryState.outdated || queryState.isLoading || queryState.isLoadingMore || queryState.error) {
        return;
      }

      appendRequestPendingRef.current = true;
      void fetchHistoryPage(directory, git, query, { append: true, limit: 20 }).finally(() => {
        appendRequestPendingRef.current = false;
      });
    }, {
      root: scrollContainerRef.current,
    });

    observer.observe(sentinelRef.current);

    return () => {
      observer.disconnect();
      appendRequestPendingRef.current = false;
    };
  }, [directory, fetchHistoryPage, git, isActive, query, queryState]);

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
    <section id="git-graph-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border/50 px-2 py-1">
        <Button type="button" size="xs" variant={paneState.graphFilterMode === 'auto' ? 'secondary' : 'ghost'} onClick={() => setPaneState(directory, { graphFilterMode: 'auto', graphManualRefIds: [] })} disabled={areFilterControlsDisabled}>
          {t('quota.window.auto')}
        </Button>
        <Button type="button" size="xs" variant={paneState.graphFilterMode === 'all' ? 'secondary' : 'ghost'} onClick={() => setPaneState(directory, { graphFilterMode: 'all', graphManualRefIds: [] })} disabled={areFilterControlsDisabled}>
          {t('contextPanel.preview.console.filter.all')}
        </Button>
        <Button type="button" size="xs" variant={paneState.graphFilterMode === 'manual' ? 'secondary' : 'ghost'} onClick={() => setPaneState(directory, { graphFilterMode: 'manual' })} disabled={areFilterControlsDisabled}>
          {t('sessions.sidebar.header.projectSort.manual')}
        </Button>
        <Button type="button" size="xs" variant="ghost" className="ml-auto" aria-label={t('gitView.history.refresh')} onClick={() => void refresh()} disabled={isLoadingRefs || queryState?.isLoading || queryState?.isLoadingMore}>
          <Icon name="refresh" className="size-3" />
        </Button>
      </div>

      {paneState.graphFilterMode === 'manual' ? (
        <div className="flex flex-col gap-2 border-b border-border/50 px-2.5 py-1.5">
          <div className="typography-micro text-muted-foreground">{t('gitView.graph.manualSelection')}</div>
          {renderRefGroup(t('gitView.graph.localBranches'), groupedRefs.branches)}
          {renderRefGroup(t('gitView.branch.remoteBranches'), groupedRefs.remoteBranches)}
          {renderRefGroup(t('gitView.graph.tags'), groupedRefs.tags)}
        </div>
      ) : null}

      {renderState.showInlineMergeBaseError ? (
        <div
          id="git-graph-merge-base-error"
          role="alert"
          className="border-b border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-2.5 py-1.5"
        >
          <p className="typography-micro text-[var(--status-warning-foreground)]">{t('gitView.graph.mergeBaseLookupFailed')}</p>
        </div>
      ) : null}

      {refsError && refs ? (
        <div id="git-graph-retained-refs-error" role="alert" className="flex items-center justify-between gap-2 border-b border-border/50 px-2.5 py-1.5">
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
        <div id="git-graph-scroll-container" data-ui="git-graph-scroll-container" ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          <ul>
            {viewModels.map((viewModel) => {
              if (viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes') {
                return (
                  <li key={viewModel.historyItem.id} data-history-commit-row={viewModel.historyItem.id}>
                    <div className="flex h-[22px] items-center gap-1.5 px-2">
                      <div className="h-[22px] shrink-0">
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

              const comparison = {
                directory,
                commitHash: viewModel.historyItem.id,
                parentHash: viewModel.historyItem.parentIds[0] ?? null,
              };

              return (
                <HistoryCommitRow
                  key={viewModel.historyItem.id}
                  entry={viewModel.historyItem}
                  mode="graph"
                  viewModel={viewModel}
                  totalColumns={totalColumns}
                  isExpanded={commitDetailsController.isExpanded(comparison)}
                  onToggle={() => commitDetailsController.toggleExpanded(comparison)}
                  files={[]}
                  isLoadingFiles={false}
                  onCopyHash={onCopyHash}
                  directory={directory}
                  hoverCoordinator={hoverCoordinator}
                  hoverRemoteName={hoverRemoteName}
                  hoverRemoteUrl={hoverRemoteUrl}
                  hoverDetailsCache={hoverDetailsCache}
                  compactGraph={true}
                  showGraphActions={!readOnly}
                  onConflict={onConflict}
                  onActionSuccess={onActionSuccess}
                  commitComparison={comparison}
                  commitDetailsController={commitDetailsController}
                />
              );
            })}
          </ul>
          {queryState?.hasMore ? (
            <div id="git-graph-end-sentinel" data-ui="git-graph-end-sentinel" ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center typography-meta text-muted-foreground">
          {renderState.emptyMessage ?? t('gitView.history.noCommits')}
        </div>
      )}
    </section>
  );
};
