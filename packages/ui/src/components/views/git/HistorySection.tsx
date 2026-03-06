import React from 'react';
import { RiArrowUpSLine, RiArrowDownSLine } from '@remixicon/react';
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
import { HistoryCommitRow } from './HistoryCommitRow';
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';
import { useLanguage } from '@/hooks/useLanguage';

const LOG_SIZE_OPTIONS = [{ value: 25 }, { value: 50 }, { value: 100 }];

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
}) => {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = React.useState(true);

  if (!log) {
    return null;
  }

  const content = (
    <ScrollableOverlay outerClassName="min-h-0 max-h-[50vh]" className="w-full">
      {log.all.length === 0 ? (
        <div className="flex h-full items-center justify-center p-4">
          <p className="typography-ui-label text-muted-foreground">
            {t('historySection.noCommitsFound')}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {log.all.map((entry) => (
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
      )}
    </ScrollableOverlay>
  );

  if (!showHeader) {
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
        <h3 className="typography-ui-header font-semibold text-foreground">{t('historySection.title')}</h3>
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
                  <SelectValue placeholder={t('historySection.commitsPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {LOG_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {t('historySection.commitsCount', { count: option.value })}
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
