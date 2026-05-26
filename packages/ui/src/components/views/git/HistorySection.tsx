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
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { assignLanes } from './gitGraph';
import type { LanedCommit } from './gitGraph';

const LOG_SIZE_OPTIONS = [
  { labelKey: 'gitView.history.logSize25', value: 25 },
  { labelKey: 'gitView.history.logSize50', value: 50 },
  { labelKey: 'gitView.history.logSize100', value: 100 },
];

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
  showHeader = true,
  contentMaxHeightClassName = 'max-h-[50vh]',
  branchDivider = null,
  onConflict,
  onActionSuccess,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(true);
  const isGraphMode = mode === 'graph';

  const laned: LanedCommit[] = React.useMemo(
    () => (isGraphMode && log ? assignLanes(log.all) : []),
    [isGraphMode, log]
  );

  const maxLanes = React.useMemo(
    () => Math.max(1, ...laned.map((l) => l.lane + 1)),
    [laned]
  );

  const lanedByHash = React.useMemo(
    () => new Map(laned.map((l) => [l.commit.hash, l])),
    [laned]
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
    <ul className="divide-y divide-border/60">
      {entries.map((entry) => (
        <HistoryCommitRow
          key={entry.hash}
          entry={entry}
          mode={mode}
          laned={isGraphMode ? lanedByHash.get(entry.hash) : undefined}
          totalLanes={isGraphMode ? maxLanes : undefined}
          isExpanded={expandedCommitHashes.has(entry.hash)}
          onToggle={() => onToggleCommit(entry.hash)}
          files={commitFilesMap.get(entry.hash) ?? []}
          isLoadingFiles={loadingCommitHashes.has(entry.hash)}
          onCopyHash={onCopyHash}
          directory={directory}
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
                  className="data-[size=sm]:h-auto h-7 min-h-7 w-auto justify-between px-2 py-0"
                  disabled={isLogLoading}
                >
                  <SelectValue placeholder={t('gitView.history.commitsPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {LOG_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {t(option.labelKey as never)}
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
