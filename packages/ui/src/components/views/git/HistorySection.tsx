import React from 'react';
import { RiArrowDownSLine, RiArrowUpLine, RiArrowUpSLine } from '@remixicon/react';
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
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SegmentDivider } from '@/components/ui/segment-divider';
import { HistoryCommitRow } from './HistoryCommitRow';
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';

const LOG_SIZE_OPTIONS = [
  { label: '25 commits', value: 25 },
  { label: '50 commits', value: 50 },
  { label: '100 commits', value: 100 },
];

interface HistorySectionProps {
  log: { all: GitLogEntry[] } | null;
  isLogLoading: boolean;
  logMaxCount: number;
  onLogMaxCountChange: (count: number) => void;
  expandedCommitHashes: Set<string>;
  onToggleCommit: (hash: string) => void;
  commitFilesMap: Map<string, CommitFileEntry[]>;
  loadingCommitHashes: Set<string>;
  onCopyHash: (hash: string) => void;
  showHeader?: boolean;
  branchDivider?: {
    insertBeforeIndex: number;
    branchName: string;
    direction: 'up' | 'down';
  } | null;
}

export const HistorySection: React.FC<HistorySectionProps> = ({
  log,
  isLogLoading,
  logMaxCount,
  onLogMaxCountChange,
  expandedCommitHashes,
  onToggleCommit,
  commitFilesMap,
  loadingCommitHashes,
  onCopyHash,
  showHeader = true,
  branchDivider = null,
}) => {
  const [isOpen, setIsOpen] = React.useState(true);

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
    ? <RiArrowDownSLine className="size-3.5" />
    : <RiArrowUpLine className="size-3.5" />;

  const renderCommitList = (entries: GitLogEntry[]) => (
    <ul className="divide-y divide-border/60">
      {entries.map((entry) => (
        <HistoryCommitRow
          key={entry.hash}
          entry={entry}
          isExpanded={expandedCommitHashes.has(entry.hash)}
          onToggle={() => onToggleCommit(entry.hash)}
          files={commitFilesMap.get(entry.hash) ?? []}
          isLoadingFiles={loadingCommitHashes.has(entry.hash)}
          onCopyHash={onCopyHash}
        />
      ))}
    </ul>
  );

  const content = (
    <ScrollableOverlay outerClassName="min-h-0 max-h-[50vh]" className="w-full">
      {log.all.length === 0 ? (
        <div className="flex h-full items-center justify-center p-4">
          <p className="typography-ui-label text-muted-foreground">
            No commits found
          </p>
        </div>
      ) : hasSplitHistory && branchDivider ? (
        <div className="flex flex-col gap-0">
          {topEntries.length > 0 ? (
            <div className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
              {renderCommitList(topEntries)}
            </div>
          ) : null}

          <SegmentDivider
            label={branchDivider.branchName}
            icon={dividerIcon}
          />

          {bottomEntries.length > 0 ? (
            <div className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
              {renderCommitList(bottomEntries)}
            </div>
          ) : null}
        </div>
      ) : (
        renderCommitList(log.all)
      )}
    </ScrollableOverlay>
  );

  if (!showHeader) {
    if (hasSplitHistory) {
      return <section>{content}</section>;
    }
    return (
      <section className="rounded-xl border border-border/60 bg-background/70 overflow-hidden">
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
        <h3 className="typography-ui-header font-semibold text-foreground">History</h3>
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
                  <SelectValue placeholder="Commits" />
                </SelectTrigger>
                <SelectContent>
                  {LOG_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {isOpen ? (
            <RiArrowUpSLine className="size-4 text-muted-foreground" />
          ) : (
            <RiArrowDownSLine className="size-4 text-muted-foreground" />
          )}
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>{content}</CollapsibleContent>
    </Collapsible>
  );
};
