import React from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { HistoryCommitRow } from './HistoryCommitRow';
import type { GitLogEntry, CommitFileEntry, GitCommitHoverDetailsCache } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { GitCommitHoverPopover } from './GitCommitHoverPopover';
import {
  buildGitHistoryViewModels,
  type GitHistoryGraphItem,
  type GitHistoryItemViewModel,
  type GitHistoryGraphRef,
} from './gitGraph';

const LOG_SIZE_OPTIONS = [
  { labelKey: 'gitView.history.logSize25', value: 25 },
  { labelKey: 'gitView.history.logSize50', value: 50 },
  { labelKey: 'gitView.history.logSize100', value: 100 },
] as const;

interface HistorySectionProps {
  mode?: 'history' | 'graph';
  log: { all: GitLogEntry[] } | null;
  isLogLoading: boolean;
  logMaxCount: number;
  onLogMaxCountChange: (count: number) => void;
  expandedCommitHashes: Set<string>;
  onToggleCommit: (hash: string) => void;
  commitFilesMap: Map<string, CommitFileEntry[]>;
  loadingCommitHashes: Set<string>;
  onCopyHash: (hash: string) => void;
  directory: string | undefined;
  hoverRemoteName?: string | null;
  hoverRemoteUrl?: string | null;
  hoverDetailsCache?: GitCommitHoverDetailsCache | null;
  showHeader?: boolean;
  contentMaxHeightClassName?: string;
  branchDivider?: {
    insertBeforeIndex: number;
    branchName: string;
    direction: 'up' | 'down';
  } | null;
  onConflict?: (result: { conflict: boolean; conflictFiles?: string[]; operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }) => void;
  onActionSuccess?: () => void;
}

export const HistorySection: React.FC<HistorySectionProps> = ({
  mode = 'history',
  log,
  isLogLoading,
  logMaxCount,
  onLogMaxCountChange,
  expandedCommitHashes,
  onToggleCommit,
  commitFilesMap,
  loadingCommitHashes,
  onCopyHash,
  directory,
  hoverRemoteName = null,
  hoverRemoteUrl = null,
  hoverDetailsCache = null,
  showHeader = true,
  contentMaxHeightClassName = 'max-h-[50vh]',
  branchDivider = null,
  onConflict,
  onActionSuccess,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(true);
  const isGraphMode = mode === 'graph';
  const hoverCoordinator = React.useMemo(() => GitCommitHoverPopover.createCoordinator(), []);

  const historyItems = React.useMemo<GitHistoryGraphItem[]>(
    () => (log?.all ?? []).map((entry) => {
      const references: GitHistoryGraphRef[] = entry.refs
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          const isHead = value.startsWith('HEAD -> ');
          const isTag = value.startsWith('tag: ');
          const label = isHead ? value.slice('HEAD -> '.length) : isTag ? value.slice('tag: '.length) : value;
          const kind = isTag ? 'tag' : value.includes('/') ? 'remote' : 'local';
          const category = isTag
            ? 'tags'
            : value.includes('/')
              ? 'remote-branches'
              : 'branches';

          return {
            id: label,
            name: label,
            revision: entry.hash,
            kind,
            category,
          };
        });

        return {
          id: entry.hash,
          displayId: entry.hash.slice(0, 8),
          parentIds: entry.parents,
          subject: entry.message,
          message: entry.body || entry.message,
          author: entry.author_name,
          authorEmail: entry.author_email,
          timestamp: entry.date,
          references,
          statistics: {
            files: entry.filesChanged,
          insertions: entry.insertions,
          deletions: entry.deletions,
        },
      };
    }),
    [log],
  );

  const refs = React.useMemo(() => {
    const current = historyItems
      .flatMap((item) => item.references ?? [])
      .find((ref) => ref.id !== 'HEAD' && ref.category === 'branches');

    return {
      current: current ?? null,
      upstream: null,
      base: null,
    };
  }, [historyItems]);

  const viewModels: GitHistoryItemViewModel[] = React.useMemo(
    () => (isGraphMode
      ? buildGitHistoryViewModels(historyItems, refs, {
          showIncoming: false,
          showOutgoing: false,
          mergeBase: null,
        })
      : []),
    [historyItems, isGraphMode, refs],
  );

  const maxColumns = React.useMemo(
    () => Math.max(1, ...viewModels.map((viewModel) => Math.max(viewModel.inputSwimlanes.length, viewModel.outputSwimlanes.length, 1))),
    [viewModels],
  );

  const viewModelByHash = React.useMemo(
    () => new Map(viewModels.map((viewModel) => [viewModel.historyItem.id, viewModel])),
    [viewModels],
  );

  // Early return AFTER all hooks
  if (!log) {
    return null;
  }

  const hasDivider =
    branchDivider !== null &&
    branchDivider.insertBeforeIndex > 0 &&
    branchDivider.insertBeforeIndex < log.all.length;
  const hasDividerBelowLoaded = branchDivider !== null && branchDivider.insertBeforeIndex === log.all.length;
  const hasSplitHistory = hasDivider || hasDividerBelowLoaded;

  const topEntries = hasDivider
    ? log.all.slice(0, branchDivider.insertBeforeIndex)
    : hasDividerBelowLoaded
      ? log.all
      : [];
  const bottomEntries = hasDivider ? log.all.slice(branchDivider.insertBeforeIndex) : [];

  const dividerIcon = branchDivider?.direction === 'down'
    ? <Icon name="arrow-down-s" className="size-3.5" />
    : <Icon name="arrow-up" className="size-3.5" />;

  const renderCommitList = (entries: GitLogEntry[]) => (
    <ul className="divide-y divide-border/60" data-history-commit-list={mode}>
      {entries.map((entry) => (
        <HistoryCommitRow
          key={entry.hash}
          entry={entry}
          mode={mode}
          viewModel={isGraphMode ? viewModelByHash.get(entry.hash) : undefined}
          totalColumns={isGraphMode ? maxColumns : undefined}
          isExpanded={expandedCommitHashes.has(entry.hash)}
          onToggle={() => onToggleCommit(entry.hash)}
          files={commitFilesMap.get(entry.hash) ?? []}
          isLoadingFiles={loadingCommitHashes.has(entry.hash)}
          onCopyHash={onCopyHash}
          directory={directory}
          hoverCoordinator={hoverCoordinator}
          hoverRemoteName={hoverRemoteName}
          hoverRemoteUrl={hoverRemoteUrl}
          hoverDetailsCache={hoverDetailsCache}
          onConflict={onConflict}
          onActionSuccess={onActionSuccess}
        />
      ))}
    </ul>
  );

  const loadMoreButton = log.all.length >= logMaxCount ? (
    <div className="flex justify-center py-2 border-t border-border/40">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onLogMaxCountChange(logMaxCount + 25)}
        disabled={isLogLoading}
        className="px-3 text-muted-foreground hover:text-foreground"
      >
        {isLogLoading ? (
          <span className="flex items-center gap-1">
            <Icon name="loader-4" className="size-3 animate-spin" />
            {t('gitView.history.loadingMore')}
          </span>
        ) : (
          t('gitView.history.loadMore')
        )}
      </Button>
    </div>
  ) : null;

  const content = (
    <ScrollableOverlay outerClassName={`min-h-0 ${contentMaxHeightClassName}`} className="h-full w-full">
      {log.all.length === 0 ? (
        <div className="flex h-full items-center justify-center p-4">
          <p className="typography-ui-label text-muted-foreground">
            {t('gitView.history.noCommits')}
          </p>
        </div>
      ) : hasSplitHistory && branchDivider ? (
        <>
          <div className="flex flex-col gap-0">
            {topEntries.length > 0 ? (
              <div className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                {renderCommitList(topEntries)}
              </div>
            ) : null}

            <div className="flex items-center gap-2 px-3 py-1.5" aria-hidden>
              <span className="h-px flex-1 bg-border/60" />
              <span className="inline-flex max-w-[80%] items-center gap-1 typography-micro text-muted-foreground">
                <span className="truncate" title={branchDivider.branchName}>{branchDivider.branchName}</span>
                {dividerIcon}
              </span>
              <span className="h-px flex-1 bg-border/60" />
            </div>

            {bottomEntries.length > 0 ? (
              <div className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                {renderCommitList(bottomEntries)}
              </div>
            ) : null}
          </div>
          {loadMoreButton}
        </>
      ) : (
        <>
          {renderCommitList(log.all)}
          {loadMoreButton}
        </>
      )}
    </ScrollableOverlay>
  );

  if (!showHeader) {
    if (hasSplitHistory) {
      return <section className="h-full min-h-0">{content}</section>;
    }
    return (
      <section className="h-full min-h-0 rounded-xl border border-border/60 bg-background/70 overflow-hidden">
        {content}
      </section>
    );
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className="rounded-xl border border-border/60 bg-background/70 overflow-hidden"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 h-10 hover:bg-transparent">
        <h3 className="typography-ui-header font-semibold text-foreground">{t('gitView.history.title')}</h3>
        <div className="flex items-center gap-2">
          {isOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Select
                value={String(logMaxCount)}
                onValueChange={(value) => onLogMaxCountChange(Number(value))}
                disabled={isLogLoading}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto"
                  disabled={isLogLoading}
                >
                  <SelectValue placeholder={t('gitView.history.commitsPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {LOG_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {isOpen ? (
            <Icon name="arrow-up-s" className="size-4 text-muted-foreground" />
          ) : (
            <Icon name="arrow-down-s" className="size-4 text-muted-foreground" />
          )}
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>{content}</CollapsibleContent>
    </Collapsible>
  );
};
