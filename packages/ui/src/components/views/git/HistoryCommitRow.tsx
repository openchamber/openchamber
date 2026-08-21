import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import type { GitCommitChangedFile, GitLogEntry, GitHistoryItem } from '@/lib/api/types';
import type { GitCommitHoverDetailsCache } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { GitGraphSegment } from './GitGraphSegment';
import { GitCommitHoverPopover, type GitCommitHoverPopoverCoordinator } from './GitCommitHoverPopover';
import { formatGitCommitHoverRelativeTime, normalizeGitCommitHoverEntry } from './gitCommitHoverModel';
import * as git from '@/lib/gitApi';
import { toast } from '@/components/ui/toast';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import type { GitHistoryGraphRef, GitHistoryItemViewModel } from './gitGraph';
import {
  GitCommitChangedFiles,
  type GitCommitChangedFilesSnapshot,
} from './GitCommitChangedFiles';

const PENDING_ACTION_CONFIRM_LABELS = {
  checkout: 'gitView.history.actions.checkoutConfirm',
  cherryPick: 'gitView.history.actions.cherryPickConfirm',
  revert: 'gitView.history.actions.revertConfirm',
  merge: 'gitView.history.actions.mergeConfirm',
  rebase: 'gitView.history.actions.rebaseConfirm',
  resetSoft: 'gitView.history.actions.resetSoftConfirm',
  resetMixed: 'gitView.history.actions.resetMixedConfirm',
  resetHard: 'gitView.history.actions.resetHardConfirm',
} as const;

const RESET_PENDING_ACTIONS = {
  soft: 'resetSoft',
  mixed: 'resetMixed',
  hard: 'resetHard',
} as const;

const RESET_LABELS = {
  soft: 'gitView.history.actions.resetSoft',
  mixed: 'gitView.history.actions.resetMixed',
  hard: 'gitView.history.actions.resetHard',
} as const;

export type GitCommitComparison = {
  directory: string;
  commitHash: string;
  parentHash: string | null;
};

type GitCommitDetailsControllerLike = {
  getCommitSnapshot: (key: GitCommitComparison) => GitCommitChangedFilesSnapshot;
  subscribeCommit: (key: GitCommitComparison, listener: () => void) => () => void;
  retryCommit: (key: GitCommitComparison) => void;
  selectFile: (key: GitCommitComparison, file: GitCommitChangedFile) => void;
};

interface HistoryCommitRowProps {
  entry: GitLogEntry | GitHistoryItem;
  mode?: 'history' | 'graph';
  compactGraph?: boolean;
  viewModel?: GitHistoryItemViewModel;
  totalColumns?: number;
  isExpanded: boolean;
  onToggle: () => void;
  files: GitCommitChangedFile[];
  isLoadingFiles: boolean;
  onCopyHash: (hash: string) => void;
  directory: string | undefined;
  hoverCoordinator?: GitCommitHoverPopoverCoordinator;
  hoverRemoteName?: string | null;
  hoverRemoteUrl?: string | null;
  hoverDetailsCache?: GitCommitHoverDetailsCache | null;
  onConflict?: (result: { conflict: boolean; conflictFiles?: string[]; operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }) => void;
  onActionSuccess?: () => void;
  commitComparison?: GitCommitComparison;
  commitDetailsController?: GitCommitDetailsControllerLike;
  selectedChangedFilePath?: string | null;
  showGraphActions?: boolean;
}

const isGitHistoryItemEntry = (entry: GitLogEntry | GitHistoryItem): entry is GitHistoryItem => 'subject' in entry;

const getEntryHash = (entry: GitLogEntry | GitHistoryItem): string => (isGitHistoryItemEntry(entry) ? entry.id : entry.hash);
const getEntryMessage = (entry: GitLogEntry | GitHistoryItem): string => (isGitHistoryItemEntry(entry) ? entry.subject : entry.message);
const getEntryAuthorName = (entry: GitLogEntry | GitHistoryItem): string => (isGitHistoryItemEntry(entry) ? entry.author : entry.author_name);

function formatCommitDate(date: string, timeFormatPreference: TimeFormatPreference) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) {
    return date;
  }

  return formatDateTimeForPreference(value, timeFormatPreference, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getRefBadgeClasses(ref: GitHistoryGraphRef): string {
  if (ref.color) {
    return 'border-transparent text-[var(--primary-foreground)]';
  }

  if (ref.kind === 'tag') {
    return 'border-border/60 bg-muted/40 text-foreground';
  }

  return 'border-border/60 bg-background/80 text-foreground';
}

export const HistoryCommitRow = React.memo(({
  entry,
  mode = 'history',
  compactGraph = false,
  viewModel,
  totalColumns,
  isExpanded,
  onToggle,
  files,
  isLoadingFiles,
  onCopyHash,
  directory,
  hoverCoordinator,
  hoverRemoteName = null,
  hoverRemoteUrl = null,
  hoverDetailsCache = null,
  onConflict,
  onActionSuccess,
  commitComparison,
  commitDetailsController,
  selectedChangedFilePath = null,
  showGraphActions = true,
}: HistoryCommitRowProps) => {
  const { t, locale } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const isGraphMode = mode === 'graph';
  const isCompactGraph = isGraphMode && compactGraph;
  const detailsContentId = `history-commit-details-${getEntryHash(entry)}`;
  type PendingAction =
    | 'checkout' | 'cherryPick' | 'revert'
    | 'merge' | 'rebase'
    | 'resetSoft' | 'resetMixed' | 'resetHard';

  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [showCreateBranch, setShowCreateBranch] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null);

  const fallbackSnapshot = React.useMemo<GitCommitChangedFilesSnapshot>(() => {
    if (isLoadingFiles) {
      return { status: 'loading' };
    }

    return { status: 'ready', files };
  }, [files, isLoadingFiles]);

  const controllerSnapshot = React.useSyncExternalStore(
    React.useCallback(
      (listener) => {
        if (!commitDetailsController || !commitComparison) {
          return () => {};
        }

        return commitDetailsController.subscribeCommit(commitComparison, listener);
      },
      [commitComparison, commitDetailsController],
    ),
    React.useCallback(() => {
      if (!commitDetailsController || !commitComparison) {
        return fallbackSnapshot;
      }

      return commitDetailsController.getCommitSnapshot(commitComparison);
    }, [commitComparison, commitDetailsController, fallbackSnapshot]),
    React.useCallback(() => {
      if (!commitDetailsController || !commitComparison) {
        return fallbackSnapshot;
      }

      return commitDetailsController.getCommitSnapshot(commitComparison);
    }, [commitComparison, commitDetailsController, fallbackSnapshot]),
  );

  const changedFilesSnapshot = commitDetailsController && commitComparison ? controllerSnapshot : fallbackSnapshot;

  const handleCheckout = async () => {
    if (!directory) return;
    setActionLoading('checkout');
      try {
        await git.checkoutCommit(directory, getEntryHash(entry));
      toast.success(t('gitView.history.actions.detachedHead'));
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateBranch = async () => {
    if (!directory || !newBranchName.trim()) return;
    setActionLoading('createBranch');
    try {
      await git.createBranch(directory, newBranchName.trim(), getEntryHash(entry));
      setShowCreateBranch(false);
      setNewBranchName('');
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCherryPick = async () => {
    if (!directory) return;
    setActionLoading('cherryPick');
    try {
      const result = await git.cherryPick(directory, getEntryHash(entry));
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'cherry-pick' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevert = async () => {
    if (!directory) return;
    setActionLoading('revert');
    try {
      const result = await git.revertCommit(directory, getEntryHash(entry));
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'revert' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReset = async (mode: 'soft' | 'mixed' | 'hard', force = false) => {
    if (!directory || actionLoading !== null) return;
    setActionLoading('reset');
    try {
      await git.resetToCommit(directory, getEntryHash(entry), mode, force);
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  // Single confirm handler dispatches to the right action based on pendingAction
  const confirmPendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    switch (action) {
      case 'checkout':   return handleCheckout();
      case 'cherryPick': return handleCherryPick();
      case 'revert':     return handleRevert();
      case 'merge':      return handleMerge();
      case 'rebase':     return handleRebase();
      case 'resetSoft':  return handleReset('soft');
      case 'resetMixed': return handleReset('mixed');
      case 'resetHard':  return handleReset('hard', true); // force=true: user already confirmed
    }
  };

  const handleMerge = async () => {
    if (!directory) return;
    setActionLoading('merge');
    try {
      const result = await git.merge(directory, { branch: getEntryHash(entry) });
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'merge' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRebase = async () => {
    if (!directory) return;
    setActionLoading('rebase');
    try {
      const result = await git.rebase(directory, { onto: getEntryHash(entry) });
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'rebase' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const graphBadges: GitHistoryGraphRef[] = viewModel?.historyItem.references ?? [];
  const compactGraphBadges = graphBadges.some((badge) => badge.kind === 'head')
    ? graphBadges.filter((badge) => badge.kind === 'head' || badge.kind === 'tag')
    : graphBadges;

  const hoverModel = React.useMemo(() => {
    const normalized = normalizeGitCommitHoverEntry(entry);
    return {
      ...normalized,
      relativeTime: formatGitCommitHoverRelativeTime(normalized.timestamp, { locale }),
    };
  }, [entry, locale]);

  const absoluteTimestamp = React.useMemo(
    () => formatCommitDate(hoverModel.timestamp, timeFormatPreference),
    [hoverModel.timestamp, timeFormatPreference],
  );

  const rowButton = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-controls={isExpanded ? detailsContentId : undefined}
      className={cn(
        'w-full text-left transition-colors',
        isCompactGraph
          ? 'flex h-[22px] items-center gap-1.5 px-2'
          : 'flex items-start gap-3 px-3 py-2',
        isGraphMode
          ? 'hover:bg-[var(--interactive-hover)]/40'
          : isExpanded ? 'bg-sidebar/90' : 'hover:bg-sidebar/40'
      )}
      data-row-hash={hoverModel.hash}
    >
      {isGraphMode && viewModel ? (
        <div className={cn('shrink-0 self-stretch', isCompactGraph ? 'h-[22px]' : '-my-2')}>
          <GitGraphSegment viewModel={viewModel} totalColumns={totalColumns} />
        </div>
      ) : (
        <div
          className="h-2 w-2 translate-y-2 rounded-full shrink-0"
          style={{ backgroundColor: 'var(--status-success)' }}
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1">
        {isCompactGraph ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn(
              'min-w-0 flex-1 truncate typography-ui-label text-foreground',
              viewModel?.kind === 'HEAD' ? 'font-semibold' : 'font-normal',
            )}>
              {getEntryMessage(entry)}
            </span>
            {compactGraphBadges.length > 0 ? (
              <div className="flex max-w-[50%] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap">
                {compactGraphBadges.map((badge) => (
                  <span
                    key={badge.id}
                    className={cn(
                      'inline-flex min-w-0 max-w-40 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0 typography-micro font-medium',
                      getRefBadgeClasses(badge),
                    )}
                    style={badge.color ? { backgroundColor: badge.color } : undefined}
                  >
                    {badge.kind === 'local' || badge.kind === 'remote' || badge.kind === 'head' ? <Icon name="git-branch" className="size-3" /> : null}
                    <span className="truncate">{badge.name}</span>
                  </span>
                ))}
              </div>
            ) : null}
            <span className="min-w-0 max-w-[35%] shrink truncate typography-meta text-muted-foreground" title={getEntryAuthorName(entry)}>
              {getEntryAuthorName(entry)}
            </span>
          </div>
        ) : (
          <>
            {isGraphMode && graphBadges.length > 0 ? (
              <div className="mb-0.5 flex flex-wrap gap-1">
                {graphBadges.map((badge) => (
                  <span
                    key={badge.id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-1.5 py-0 typography-micro font-medium',
                      getRefBadgeClasses(badge),
                    )}
                    style={badge.color ? { backgroundColor: badge.color } : undefined}
                  >
                    {badge.kind === 'local' || badge.kind === 'remote' || badge.kind === 'head' ? <Icon name="git-branch" className="size-3" /> : null}
                    {badge.name}
                  </span>
                ))}
              </div>
            ) : null}

            <p className="typography-ui-label font-medium text-foreground line-clamp-1">
              {getEntryMessage(entry)}
            </p>
            <div className="flex items-center gap-1 typography-meta text-muted-foreground">
              <div className="flex items-center gap-1 min-w-0 truncate">
                <span className="truncate min-w-[3ch]" title={getEntryAuthorName(entry)}>
                  {getEntryAuthorName(entry)}
                </span>
                <span className="shrink-0">·</span>
                <span className="truncate min-w-0" title={absoluteTimestamp}>
                  {absoluteTimestamp}
                </span>
              </div>
              <span className="shrink-0">·</span>
              <code className="shrink-0 font-mono">
                {getEntryHash(entry).slice(0, 8)}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1 shrink-0"
                    aria-label={t('gitView.history.copySha')}
                    title={t('gitView.history.copySha')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopyHash(getEntryHash(entry));
                    }}
                  >
                    <Icon name="file-copy" className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>{t('gitView.history.copySha')}</TooltipContent>
              </Tooltip>
            </div>
          </>
        )}
      </div>
    </button>
  );

  return (
    <li data-history-commit-row={getEntryHash(entry)}>
      {directory && hoverCoordinator ? (
        <GitCommitHoverPopover
          model={hoverModel}
          directory={directory}
          remoteName={hoverRemoteName}
          remoteUrl={hoverRemoteUrl}
          detailsCache={hoverDetailsCache}
          coordinator={hoverCoordinator}
          onCopyHash={onCopyHash}
          absoluteTimestamp={absoluteTimestamp}
          rowButton={rowButton}
          openGitHubLabel={t('gitView.pr.actions.openOnGitHub')}
          copyShaLabel={t('gitView.history.copySha')}
          changedFilesLabel={t(
            hoverModel.statistics.files === 1
              ? 'diffView.summary.changedFilesSingle'
              : 'diffView.summary.changedFilesPlural',
            { count: hoverModel.statistics.files },
          )}
        />
      ) : rowButton}

      {isExpanded && (
        <div id={detailsContentId} className="px-3 pb-2 pl-8 border-t border-border/40">
          {/* Action buttons */}
          {isGraphMode && showGraphActions && pendingAction ? (
            /* Confirmation banner — replaces the button row while an action is pending */
            <div className="flex items-center gap-2 py-2 border-b border-border/30 mb-2">
              <span className="typography-micro text-muted-foreground flex-1 min-w-0">
                {t(PENDING_ACTION_CONFIRM_LABELS[pendingAction])}
              </span>
              <Button
                variant="destructive" size="xs" className="h-6 shrink-0"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); void confirmPendingAction(); }}
              >
                {actionLoading !== null
                  ? <Icon name="loader-4" className="size-3 animate-spin mr-1" />
                  : null}
                {t('gitView.history.actions.confirmButton')}
              </Button>
              <Button
                variant="ghost" size="xs" className="h-6 shrink-0"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); setPendingAction(null); }}
              >
                {t('gitView.history.actions.cancelButton')}
              </Button>
            </div>
          ) : isGraphMode && showGraphActions ? (
            <div className="flex flex-wrap items-center gap-1.5 py-2 border-b border-border/30 mb-2">
              <Button variant="outline" size="xs" className="h-6"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); setPendingAction('checkout'); }}
              >
                {t('gitView.history.actions.checkout')}
              </Button>

              {showCreateBranch ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleCreateBranch();
                      if (e.key === 'Escape') { setShowCreateBranch(false); setNewBranchName(''); }
                    }}
                    placeholder={t('gitView.history.actions.createBranchPlaceholder')}
                    className="h-6 text-xs px-2 rounded border border-border/60 bg-background min-w-0 w-32"
                  />
                  <Button variant="outline" size="xs" className="h-6"
                    disabled={!newBranchName.trim() || actionLoading !== null}
                    onClick={(e) => { e.stopPropagation(); void handleCreateBranch(); }}
                  >
                    {actionLoading === 'createBranch'
                      ? <Icon name="loader-4" className="size-3 animate-spin mr-1" />
                      : null}
                    {t('gitView.history.actions.createBranchConfirm')}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="xs" className="h-6"
                  onClick={(e) => { e.stopPropagation(); setShowCreateBranch(true); }}
                >
                  {t('gitView.history.actions.createBranch')}
                </Button>
              )}

              <Button variant="outline" size="xs" className="h-6"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); setPendingAction('cherryPick'); }}
              >
                {t('gitView.history.actions.cherryPick')}
              </Button>

              <Button variant="outline" size="xs" className="h-6"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); setPendingAction('revert'); }}
              >
                {t('gitView.history.actions.revert')}
              </Button>

              {/* Reset: dropdown first to pick mode, then confirmation banner */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6"
                    disabled={actionLoading !== null}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {actionLoading === 'reset'
                      ? <Icon name="loader-4" className="size-3 animate-spin mr-1" />
                      : null}
                    {t('gitView.history.actions.reset')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-max">
                  {(['soft', 'mixed', 'hard'] as const).map((mode) => (
                    <DropdownMenuItem
                      key={mode}
                        disabled={actionLoading !== null}
                        onSelect={(e) => {
                          e.stopPropagation();
                          setPendingAction(RESET_PENDING_ACTIONS[mode]);
                        }}
                      >
                        {t(RESET_LABELS[mode])}
                      </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="outline" size="xs" className="h-6"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); setPendingAction('merge'); }}
              >
                {t('gitView.history.actions.merge')}
              </Button>

              <Button variant="outline" size="xs" className="h-6"
                disabled={actionLoading !== null}
                onClick={(e) => { e.stopPropagation(); setPendingAction('rebase'); }}
              >
                {t('gitView.history.actions.rebase')}
              </Button>
            </div>
          ) : null}

          <div className="py-2">
            <GitCommitChangedFiles
              snapshot={changedFilesSnapshot}
              selectedPath={selectedChangedFilePath}
              onRetry={commitDetailsController && commitComparison
                ? () => commitDetailsController.retryCommit(commitComparison)
                : undefined}
              onSelectFile={commitDetailsController && commitComparison
                ? (file) => commitDetailsController.selectFile(commitComparison, file)
                : undefined}
            />
          </div>
        </div>
      )}
    </li>
  );
});
