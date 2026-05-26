import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getCommitFileDiff, type CommitFileDiffResponse } from '@/lib/gitApi';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import type { LanedCommit } from './gitGraph';
import { GitGraphSegment } from './GitGraphSegment';
import * as git from '@/lib/gitApi';
import { toast } from '@/components/ui/toast';

const HISTORY_DIFF_REQUEST_TIMEOUT_MS = 15000;
const HISTORY_DIFF_LARGE_CHANGED_LINES = 500;
const HISTORY_DIFF_CACHE_MAX_ENTRIES = 12;
const HISTORY_DIFF_CACHE_MAX_TOTAL_SIZE_BYTES = 8 * 1024 * 1024;

type HistoryDiffCacheValue = CommitFileDiffResponse | 'loading' | 'error';

const getHistoryDiffCacheSize = (value: HistoryDiffCacheValue): number => {
  if (typeof value === 'string') {
    return 0;
  }
  return (value.original?.length ?? 0) + (value.modified?.length ?? 0);
};

const trimHistoryDiffCache = (cache: Map<string, HistoryDiffCacheValue>): Map<string, HistoryDiffCacheValue> => {
  if (cache.size <= HISTORY_DIFF_CACHE_MAX_ENTRIES) {
    let totalSize = 0;
    for (const value of cache.values()) {
      totalSize += getHistoryDiffCacheSize(value);
    }
    if (totalSize <= HISTORY_DIFF_CACHE_MAX_TOTAL_SIZE_BYTES) {
      return cache;
    }
  }

  const entries = Array.from(cache.entries()).reverse();
  const next = new Map<string, HistoryDiffCacheValue>();
  let totalSize = 0;
  for (const [key, value] of entries) {
    if (next.size >= HISTORY_DIFF_CACHE_MAX_ENTRIES) {
      continue;
    }
    const entrySize = getHistoryDiffCacheSize(value);
    if (totalSize + entrySize > HISTORY_DIFF_CACHE_MAX_TOTAL_SIZE_BYTES && next.size > 0) {
      continue;
    }
    next.set(key, value);
    totalSize += entrySize;
  }

  return new Map(Array.from(next.entries()).reverse());
};

interface HistoryCommitRowProps {
  entry: GitLogEntry;
  laned?: LanedCommit;
  totalLanes?: number;
  isExpanded: boolean;
  onToggle: () => void;
  files: CommitFileEntry[];
  isLoadingFiles: boolean;
  onCopyHash: (hash: string) => void;
  directory: string | undefined;
  onConflict?: (result: { conflict: boolean; conflictFiles?: string[]; operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }) => void;
  onActionSuccess?: () => void;
}

function formatCommitDate(date: string) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) {
    return date;
  }

  return value.toLocaleString(undefined, {
    hour12: false,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getChangeTypeColor(changeType: string) {
  switch (changeType) {
    case 'A':
      return 'text-[var(--status-success)]';
    case 'D':
      return 'text-[var(--status-error)]';
    case 'M':
      return 'text-[var(--status-warning)]';
    case 'R':
      return 'text-[var(--status-info)]';
    default:
      return 'text-muted-foreground';
  }
}

interface RefBadge {
  label: string;
  isHead: boolean;
  isRemote: boolean;
  isTag: boolean;
}

function parseRefBadges(refs: string): RefBadge[] {
  if (!refs) return [];
  return refs
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const isHead = r.startsWith('HEAD ->');
      const label = isHead ? r.replace('HEAD -> ', '') : r.replace('tag: ', '');
      return {
        label,
        isHead,
        isRemote: !isHead && !r.startsWith('tag: ') && /^[^/]+\//.test(r),
        isTag: r.startsWith('tag: '),
      };
    });
}

export const HistoryCommitRow = React.memo(({
  entry,
  laned,
  totalLanes,
  isExpanded,
  onToggle,
  files,
  isLoadingFiles,
  onCopyHash,
  directory,
  onConflict,
  onActionSuccess,
}: HistoryCommitRowProps) => {
  const { t } = useI18n();
  type PendingAction =
    | 'checkout' | 'cherryPick' | 'revert'
    | 'merge' | 'rebase'
    | 'resetSoft' | 'resetMixed' | 'resetHard';

  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [showCreateBranch, setShowCreateBranch] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [showResetOptions, setShowResetOptions] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null);

  const [openDiffPaths, setOpenDiffPaths] = React.useState<Set<string>>(new Set());
  const [diffCache, setDiffCache] = React.useState<Map<string, HistoryDiffCacheValue>>(new Map());
  const [forceRenderLargePaths, setForceRenderLargePaths] = React.useState<Set<string>>(new Set());

  const handleCheckout = async () => {
    if (!directory) return;
    setActionLoading('checkout');
    try {
      await git.checkoutCommit(directory, entry.hash);
      toast.success(t('gitView.history.actions.detachedHead'));
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateBranch = async () => {
    if (!directory || !newBranchName.trim()) return;
    setActionLoading('createBranch');
    try {
      await git.createBranch(directory, newBranchName.trim(), entry.hash);
      setShowCreateBranch(false);
      setNewBranchName('');
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCherryPick = async () => {
    if (!directory) return;
    setActionLoading('cherryPick');
    try {
      const result = await git.cherryPick(directory, entry.hash);
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'cherry-pick' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevert = async () => {
    if (!directory) return;
    setActionLoading('revert');
    try {
      const result = await git.revertCommit(directory, entry.hash);
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'revert' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReset = async (mode: 'soft' | 'mixed' | 'hard', force = false) => {
    if (!directory || actionLoading !== null) return;
    setActionLoading('reset');
    try {
      await git.resetToCommit(directory, entry.hash, mode, force);
      setShowResetOptions(false);
      onActionSuccess?.();
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
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
      const result = await git.merge(directory, { branch: entry.hash });
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'merge' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRebase = async () => {
    if (!directory) return;
    setActionLoading('rebase');
    try {
      const result = await git.rebase(directory, { onto: entry.hash });
      if (result.conflict) {
        onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'rebase' });
      } else {
        onActionSuccess?.();
      }
    } catch (e: unknown) {
      toast.error(String((e as Error).message));
    } finally {
      setActionLoading(null);
    }
  };

  const loadFileDiff = React.useCallback(async (file: CommitFileEntry) => {
    const key = file.path;
    if (!directory) {
      setDiffCache(prev => new Map(prev).set(key, 'error'));
      return;
    }

    setDiffCache(prev => trimHistoryDiffCache(new Map(prev).set(key, 'loading')));
    try {
      const fetchPromise = getCommitFileDiff(directory, entry.hash, file.path, false);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out after ${HISTORY_DIFF_REQUEST_TIMEOUT_MS}ms`)), HISTORY_DIFF_REQUEST_TIMEOUT_MS);
      });
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      setDiffCache(prev => trimHistoryDiffCache(new Map(prev).set(key, result)));
    } catch {
      setDiffCache(prev => new Map(prev).set(key, 'error'));
    }
  }, [directory, entry.hash]);

  const toggleFileDiff = React.useCallback(async (file: CommitFileEntry) => {
    const key = file.path;

    if (file.changeType === 'R' || file.isBinary) {
      setOpenDiffPaths(prev => {
        const next = new Set(prev);
        if (next.has(key)) { next.delete(key); } else { next.add(key); }
        return next;
      });
      return;
    }

    const cached = diffCache.get(key);
    const isOpen = openDiffPaths.has(key);

    if (isOpen && cached && cached !== 'error') {
      // Close it
      setOpenDiffPaths(prev => { const next = new Set(prev); next.delete(key); return next; });
      return;
    }

    // Open it (or re-fetch on error)
    setOpenDiffPaths(prev => { const next = new Set(prev); next.add(key); return next; });

    if (cached && cached !== 'error') return; // Already loaded

    const changedLines = file.insertions + file.deletions;
    if (changedLines > HISTORY_DIFF_LARGE_CHANGED_LINES && !forceRenderLargePaths.has(key)) {
      return;
    }

    await loadFileDiff(file);
  }, [diffCache, forceRenderLargePaths, loadFileDiff, openDiffPaths]);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
          isExpanded ? 'bg-sidebar/90' : 'hover:bg-sidebar/40'
        )}
      >
        {laned && totalLanes !== undefined ? (
          <div className="shrink-0 self-stretch">
            <GitGraphSegment laned={laned} totalLanes={totalLanes} isExpanded={isExpanded} />
          </div>
        ) : (
          <div
            className="h-2 w-2 translate-y-2 rounded-full shrink-0"
            style={{ backgroundColor: 'var(--status-success)' }}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          {/* Ref badges */}
          {(() => {
            const badges = parseRefBadges(entry.refs);
            return badges.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-0.5">
                {badges.map((badge) => (
                  <span key={badge.label}
                    className={cn(
                      'inline-flex items-center px-1.5 py-0 typography-micro rounded font-medium',
                      badge.isHead
                        ? 'bg-[var(--chart-1)] text-[var(--primary-foreground)]'
                        : badge.isTag
                        ? 'bg-[var(--chart-5)] text-[var(--primary-foreground)]'
                        : 'bg-[var(--interactive-hover)] text-[var(--foreground)]'
                    )}>
                    {badge.label}
                  </span>
                ))}
              </div>
            ) : null;
          })()}

          <p className="typography-ui-label font-medium text-foreground line-clamp-1">
            {entry.message}
          </p>
          <div className="flex items-center gap-1 typography-meta text-muted-foreground">
            <div className="flex items-center gap-1 min-w-0 truncate">
              <span className="truncate min-w-[3ch]" title={entry.author_name}>
                {entry.author_name}
              </span>
              <span className="shrink-0">·</span>
              <span className="truncate min-w-0" title={formatCommitDate(entry.date)}>
                {formatCommitDate(entry.date)}
              </span>
            </div>
            <span className="shrink-0">·</span>
            <code className="shrink-0 font-mono">
              {entry.hash.slice(0, 8)}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyHash(entry.hash);
                  }}
                >
                  <Icon name="file-copy" className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>{t('gitView.history.copySha')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 pl-8 border-t border-border/40">
          {/* Action buttons */}
          {pendingAction ? (
            /* Confirmation banner — replaces the button row while an action is pending */
            <div className="flex items-center gap-2 py-2 border-b border-border/30 mb-2">
              <span className="typography-micro text-muted-foreground flex-1 min-w-0">
                {t(`gitView.history.actions.${pendingAction}Confirm` as never)}
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
          ) : (
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
              <div className="relative inline-flex h-6 items-center">
                <Button variant="outline" size="xs" className="h-6"
                  disabled={actionLoading !== null}
                  onClick={(e) => { e.stopPropagation(); setShowResetOptions((v) => !v); }}
                >
                  {actionLoading === 'reset'
                    ? <Icon name="loader-4" className="size-3 animate-spin mr-1" />
                    : null}
                  {t('gitView.history.actions.reset')}
                </Button>
                {showResetOptions && (
                  <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border/60 rounded shadow-md min-w-max">
                    {(['soft', 'mixed', 'hard'] as const).map((mode) => (
                      <button
                        key={mode} type="button"
                        disabled={actionLoading !== null}
                        className="block w-full text-left px-3 py-1.5 typography-micro hover:bg-[var(--interactive-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowResetOptions(false);
                          setPendingAction(`reset${mode.charAt(0).toUpperCase() + mode.slice(1)}` as PendingAction);
                        }}
                      >
                        {t(`gitView.history.actions.reset${mode.charAt(0).toUpperCase() + mode.slice(1)}` as never)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

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
          )}

          {isLoadingFiles ? (
            <div className="flex items-center gap-2 py-2">
              <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
              <span className="typography-micro text-muted-foreground">{t('gitView.history.loadingFiles')}</span>
            </div>
          ) : files.length === 0 ? (
            <p className="typography-micro text-muted-foreground py-2">{t('gitView.history.noFiles')}</p>
          ) : (
            <ul className="space-y-0.5 py-2">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => toggleFileDiff(file)}
                    className={cn(
                      'w-full flex items-center gap-2 typography-micro text-left cursor-pointer transition-colors rounded px-1',
                      openDiffPaths.has(file.path) ? 'bg-sidebar/90' : 'hover:bg-sidebar/40'
                    )}
                  >
                    <span
                      className={cn(
                        'font-semibold w-3 text-center shrink-0',
                        getChangeTypeColor(file.changeType)
                      )}
                    >
                      {file.changeType}
                    </span>
                    <span className="truncate text-foreground min-w-0" title={file.path}>
                      {file.path}
                    </span>
                    {!file.isBinary && (
                      <span className="shrink-0">
                        <span style={{ color: 'var(--status-success)' }}>
                          +{file.insertions}
                        </span>
                        <span className="text-muted-foreground mx-0.5">/</span>
                        <span style={{ color: 'var(--status-error)' }}>
                          -{file.deletions}
                        </span>
                      </span>
                    )}
                    {file.isBinary && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        {t('gitView.history.binary')}
                      </span>
                    )}
                    <Icon
                      name={openDiffPaths.has(file.path) ? 'arrow-down-s' : 'arrow-right-s'}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                  </button>

                  {openDiffPaths.has(file.path) && (
                    <div className="max-h-[400px] overflow-y-auto rounded border border-border/40 mx-2 mb-1" data-diff-virtual-root data-diff-virtual-content>
                      {file.changeType === 'R' ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.renamedNoDiff')}</div>
                      ) : file.isBinary ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.binaryNoDiff')}</div>
                      ) : (() => {
                        const changedLines = file.insertions + file.deletions;
                        if (!forceRenderLargePaths.has(file.path) && changedLines > HISTORY_DIFF_LARGE_CHANGED_LINES) {
                          return (
                            <div className="flex flex-col items-start gap-1 px-3 py-2 text-sm text-muted-foreground">
                              <div className="typography-ui-label font-semibold text-foreground">
                                {t('gitView.history.largeDiffTitle', { count: changedLines })}
                              </div>
                              <div className="typography-meta text-muted-foreground">
                                {t('gitView.history.largeDiffDescription')}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="h-6 px-0 text-primary hover:bg-transparent hover:underline"
                                onClick={() => {
                                  setForceRenderLargePaths(prev => new Set(prev).add(file.path));
                                  void loadFileDiff(file);
                                }}
                              >
                                {t('gitView.history.renderDiffAnyway')}
                              </Button>
                            </div>
                          );
                        }

                        const cached = diffCache.get(file.path);
                        if (cached === 'loading' || cached === undefined) {
                          return <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.loadingDiff')}</div>;
                        }
                        if (cached === 'error') {
                          return (
                            <button
                              type="button"
                              onClick={() => toggleFileDiff(file)}
                              className="w-full text-left px-3 py-2 text-sm text-muted-foreground hover:bg-[var(--interactive-hover)] transition-colors"
                            >
                              {t('gitView.history.diffError')}
                            </button>
                          );
                        }
                        return (
                            <PierreDiffViewer
                             original={cached.original}
                             modified={cached.modified}
                             language={getLanguageFromExtension(file.path) || ''}
                             fileName={file.path}
                             renderSideBySide={false}
                             layout="inline"
                           />
                        );
                      })()}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
});
