import React from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';
import type { GitCommitChangedFile, GitLogEntry, GitHistoryItem } from '@/lib/api/types';
import type { GitCommitHoverDetailsCache } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { GitGraphSegment } from './GitGraphSegment';
import { GitCommitHoverPopover, type GitCommitHoverPopoverCoordinator } from './GitCommitHoverPopover';
import { formatGitCommitHoverRelativeTime, normalizeGitCommitHoverEntry } from './gitCommitHoverModel';
import * as git from '@/lib/gitApi';
import { toast } from '@/components/ui/toast';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import type { GitHistoryGraphRef, GitHistoryItemViewModel } from './gitGraph';
import {
  GitCommitChangedFiles,
  type GitCommitChangedFilesSnapshot,
} from './GitCommitChangedFiles';
import { buildGitHubCommitUrl } from './gitCommitRemote';

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

const PENDING_ACTION_MENU_LABELS = {
  checkout: 'gitView.history.actions.checkoutDetached',
  cherryPick: 'gitView.history.actions.cherryPick',
  revert: 'gitView.history.actions.revert',
  merge: 'gitView.history.actions.merge',
  rebase: 'gitView.history.actions.rebase',
  resetSoft: 'gitView.history.actions.resetSoft',
  resetMixed: 'gitView.history.actions.resetMixed',
  resetHard: 'gitView.history.actions.resetHard',
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
  onCompareWithRemote?: () => void;
  canCompareWithRemote?: boolean;
  onCompareWithMergeBase?: () => void;
  canCompareWithMergeBase?: boolean;
  onCompareWithRef?: () => void;
  activeComparisonLabel?: string | null;
  onClearComparison?: () => void;
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
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
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

function getRefBadgeIcon(ref: GitHistoryGraphRef): IconName | null {
  if (ref.kind === 'remote') {
    return 'cloud';
  }
  return null;
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
  onCompareWithRemote,
  canCompareWithRemote = false,
  onCompareWithMergeBase,
  canCompareWithMergeBase = false,
  onCompareWithRef,
  activeComparisonLabel = null,
  onClearComparison,
}: HistoryCommitRowProps) => {
  const { t, locale } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const isGraphMode = mode === 'graph';
  const isCompactGraph = isGraphMode && compactGraph;
  const detailsContentId = `history-commit-details-${getEntryHash(entry)}`;
  type PendingAction =
    | 'checkout' | 'cherryPick' | 'revert'
    | 'merge' | 'rebase'
    | 'resetSoft' | 'resetMixed' | 'resetHard';

  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [branchDialogOpen, setBranchDialogOpen] = React.useState(false);
  const [tagDialogOpen, setTagDialogOpen] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [newTagName, setNewTagName] = React.useState('');
  const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null);
  const supportsCreateTag = Boolean(runtimeApis.git?.createGitTag);
  const githubUrl = React.useMemo(
    () => buildGitHubCommitUrl(hoverRemoteUrl, getEntryHash(entry)),
    [entry, hoverRemoteUrl],
  );
  const ensureExpanded = React.useCallback(() => {
    if (!isExpanded) {
      onToggle();
    }
  }, [isExpanded, onToggle]);

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
      setBranchDialogOpen(false);
      setNewBranchName('');
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateTag = async () => {
    if (!directory || !newTagName.trim() || !supportsCreateTag) return;
    setActionLoading('createTag');
    try {
      await git.createGitTag(directory, newTagName.trim(), getEntryHash(entry));
      toast.success(t('gitView.toast.tagCreated', { name: newTagName.trim() }));
      setTagDialogOpen(false);
      setNewTagName('');
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

  const handleOpenChanges = React.useCallback(() => {
    ensureExpanded();
  }, [ensureExpanded]);

  const handleOpenOnGitHub = React.useCallback(() => {
    if (!githubUrl) return;
    void openExternalUrl(githubUrl);
  }, [githubUrl]);

  const handleCopyMessage = React.useCallback(() => {
    void copyTextToClipboard(getEntryMessage(entry)).then((result) => {
      if (result.ok) {
        toast.success(t('gitView.toast.commitMessageCopied'));
        return;
      }
      toast.error(t('gitView.toast.copyFailed'));
    });
  }, [entry, t]);

  const handleCompareAction = React.useCallback((callback?: () => void) => {
    if (!callback) return;
    ensureExpanded();
    callback();
  }, [ensureExpanded]);

  const graphBadges: GitHistoryGraphRef[] = viewModel?.historyItem.references ?? [];
  const visibleGraphBadges = graphBadges.filter((badge) => badge.kind !== 'tag');
  const compactGraphBadges = visibleGraphBadges.some((badge) => badge.kind === 'head')
    ? visibleGraphBadges.filter((badge) => badge.kind === 'head')
    : visibleGraphBadges;
  const tagNames = graphBadges.filter((badge) => badge.kind === 'tag' && !badge.color).map((badge) => badge.name).join(', ') || undefined;

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
      title={tagNames}
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
          <GitGraphSegment viewModel={viewModel} totalColumns={isCompactGraph ? undefined : totalColumns} />
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
                {compactGraphBadges.map((badge) => {
                  const iconName = getRefBadgeIcon(badge);
                  return (
                    <span
                      key={badge.id}
                      className={cn(
                        'inline-flex h-4 min-w-0 max-w-40 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0 typography-micro font-medium',
                        getRefBadgeClasses(badge),
                      )}
                      style={badge.color ? { backgroundColor: badge.color } : undefined}
                    >
                      {iconName ? <Icon name={iconName} className="size-3 shrink-0" /> : null}
                      <span className="truncate">{badge.name}</span>
                    </span>
                  );
                })}
              </div>
            ) : null}
            <span className="min-w-0 max-w-[35%] shrink truncate typography-meta text-muted-foreground" title={getEntryAuthorName(entry)}>
              {getEntryAuthorName(entry)}
            </span>
          </div>
        ) : (
          <>
            {isGraphMode && visibleGraphBadges.length > 0 ? (
              <div className="mb-0.5 flex flex-wrap gap-1">
                {visibleGraphBadges.map((badge) => {
                  const iconName = getRefBadgeIcon(badge);
                  return (
                    <span
                      key={badge.id}
                      className={cn(
                        'inline-flex h-4 items-center gap-1 rounded-full border px-1.5 py-0 typography-micro font-medium',
                        getRefBadgeClasses(badge),
                      )}
                      style={badge.color ? { backgroundColor: badge.color } : undefined}
                    >
                      {iconName ? <Icon name={iconName} className="size-3 shrink-0" /> : null}
                      {badge.name}
                    </span>
                  );
                })}
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

  const rowContent = directory && hoverCoordinator ? (
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
          references={graphBadges}
        />
  ) : rowButton;

  return (
    <li data-history-commit-row={getEntryHash(entry)}>
      <ContextMenu>
        <ContextMenuTrigger>{rowContent}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-[220px]">
          <ContextMenuItem onClick={handleOpenChanges}>
            {t('gitView.history.actions.openChanges')}
          </ContextMenuItem>
          {githubUrl ? (
            <ContextMenuItem onClick={handleOpenOnGitHub}>
              {t('gitView.pr.actions.openOnGitHub')}
            </ContextMenuItem>
          ) : null}

          {directory ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setPendingAction('checkout')} disabled={actionLoading !== null}>
                {t('gitView.history.actions.checkoutDetached')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setBranchDialogOpen(true)} disabled={actionLoading !== null}>
                {t('gitView.history.actions.createBranchEllipsis')}
              </ContextMenuItem>
              {supportsCreateTag ? (
                <ContextMenuItem onClick={() => setTagDialogOpen(true)} disabled={actionLoading !== null}>
                  {t('gitView.history.actions.createTagEllipsis')}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem onClick={() => setPendingAction('cherryPick')} disabled={actionLoading !== null}>
                {t('gitView.history.actions.cherryPick')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setPendingAction('revert')} disabled={actionLoading !== null}>
                {t('gitView.history.actions.revert')}
              </ContextMenuItem>
              {(['soft', 'mixed', 'hard'] as const).map((mode) => (
                <ContextMenuItem
                  key={mode}
                  onClick={() => setPendingAction(RESET_PENDING_ACTIONS[mode])}
                  disabled={actionLoading !== null}
                >
                  {t(RESET_LABELS[mode])}
                </ContextMenuItem>
              ))}
              <ContextMenuItem onClick={() => setPendingAction('merge')} disabled={actionLoading !== null}>
                {t('gitView.history.actions.merge')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setPendingAction('rebase')} disabled={actionLoading !== null}>
                {t('gitView.history.actions.rebase')}
              </ContextMenuItem>
            </>
          ) : null}

          {onCompareWithRemote || onCompareWithMergeBase || onCompareWithRef ? (
            <>
              <ContextMenuSeparator />
              {onCompareWithRemote ? (
                <ContextMenuItem
                  onClick={() => handleCompareAction(onCompareWithRemote)}
                  disabled={!canCompareWithRemote}
                >
                  {t('gitView.history.actions.compareWithRemote')}
                </ContextMenuItem>
              ) : null}
              {onCompareWithMergeBase ? (
                <ContextMenuItem
                  onClick={() => handleCompareAction(onCompareWithMergeBase)}
                  disabled={!canCompareWithMergeBase}
                >
                  {t('gitView.history.actions.compareWithMergeBase')}
                </ContextMenuItem>
              ) : null}
              {onCompareWithRef ? (
                <ContextMenuItem onClick={() => handleCompareAction(onCompareWithRef)}>
                  {t('gitView.history.actions.compareWithRef')}
                </ContextMenuItem>
              ) : null}
            </>
          ) : null}

          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyHash(getEntryHash(entry))}>
            {t('gitView.history.copySha')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyMessage}>
            {t('gitView.history.actions.copyMessage')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-4">
          <DialogHeader>
            <DialogTitle>{pendingAction ? t(PENDING_ACTION_MENU_LABELS[pendingAction]) : ''}</DialogTitle>
            <DialogDescription>
              {pendingAction ? t(PENDING_ACTION_CONFIRM_LABELS[pendingAction]) : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPendingAction(null)} disabled={actionLoading !== null}>
              {t('gitView.history.actions.cancelButton')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmPendingAction()} disabled={actionLoading !== null}>
              {actionLoading !== null ? <Icon name="loader-4" className="mr-1 size-3 animate-spin" /> : null}
              {pendingAction === 'resetHard'
                ? t('gitView.history.actions.resetHardConfirmButton')
                : t('gitView.history.actions.confirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={branchDialogOpen} onOpenChange={(open) => { setBranchDialogOpen(open); if (!open) setNewBranchName(''); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-4">
          <DialogHeader>
            <DialogTitle>{t('gitView.history.actions.createBranchEllipsis')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newBranchName}
            onChange={(event) => setNewBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleCreateBranch();
              }
              if (event.key === 'Escape') {
                setBranchDialogOpen(false);
                setNewBranchName('');
              }
            }}
            placeholder={t('gitView.history.actions.createBranchPlaceholder')}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setBranchDialogOpen(false); setNewBranchName(''); }} disabled={actionLoading !== null}>
              {t('gitView.history.actions.cancelButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleCreateBranch()} disabled={!newBranchName.trim() || actionLoading !== null}>
              {actionLoading === 'createBranch' ? <Icon name="loader-4" className="mr-1 size-3 animate-spin" /> : null}
              {t('gitView.history.actions.createBranchConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tagDialogOpen} onOpenChange={(open) => { setTagDialogOpen(open); if (!open) setNewTagName(''); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-4">
          <DialogHeader>
            <DialogTitle>{t('gitView.history.actions.createTagEllipsis')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newTagName}
            onChange={(event) => setNewTagName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleCreateTag();
              }
              if (event.key === 'Escape') {
                setTagDialogOpen(false);
                setNewTagName('');
              }
            }}
            placeholder={t('gitView.history.actions.createTagPlaceholder')}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setTagDialogOpen(false); setNewTagName(''); }} disabled={actionLoading !== null}>
              {t('gitView.history.actions.cancelButton')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleCreateTag()} disabled={!newTagName.trim() || actionLoading !== null}>
              {actionLoading === 'createTag' ? <Icon name="loader-4" className="mr-1 size-3 animate-spin" /> : null}
              {t('gitView.history.actions.createTagConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isExpanded && (
        <div id={detailsContentId} className="border-t border-border/40 px-3 pb-2 pl-8">
          {activeComparisonLabel ? (
            <div className="mb-2 flex items-center gap-2 border-b border-border/30 py-2">
              <span className="min-w-0 flex-1 typography-micro text-muted-foreground">
                {t('gitView.history.actions.comparingWith', { name: activeComparisonLabel })}
              </span>
              {onClearComparison ? (
                <Button variant="ghost" size="xs" className="h-6 shrink-0" onClick={onClearComparison}>
                  {t('gitView.history.actions.clearComparison')}
                </Button>
              ) : null}
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
