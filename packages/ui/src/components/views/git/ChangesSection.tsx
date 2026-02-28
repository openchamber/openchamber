import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { useLanguage } from '@/hooks/useLanguage';
import { ChangeRow } from './ChangeRow';
import type { GitStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';

interface ChangesSectionProps {
  changeEntries: GitStatus['files'];
  selectedPaths: Set<string>;
  diffStats: Record<string, { insertions: number; deletions: number }> | undefined;
  revertingPaths: Set<string>;
  onToggleFile: (path: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onViewDiff: (path: string) => void;
  onRevertFile: (path: string) => void;
  variant?: 'framed' | 'plain';
  maxListHeightClassName?: string;
  onVisiblePathsChange?: (paths: string[]) => void;
}

const CHANGE_LIST_VIRTUALIZE_THRESHOLD = 120;
const CHANGE_ROW_ESTIMATE_PX = 34;

export const ChangesSection: React.FC<ChangesSectionProps> = ({
  changeEntries,
  selectedPaths,
  diffStats,
  revertingPaths,
  onToggleFile,
  onSelectAll,
  onClearSelection,
  onViewDiff,
  onRevertFile,
  variant = 'framed',
  maxListHeightClassName,
  onVisiblePathsChange,
}) => {
  const { t } = useLanguage();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const selectedCount = selectedPaths.size;
  const totalCount = changeEntries.length;
  const shouldVirtualize = totalCount >= CHANGE_LIST_VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANGE_ROW_ESTIMATE_PX,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  const virtualRows = React.useMemo(
    () => (shouldVirtualize ? rowVirtualizer.getVirtualItems() : []),
    [rowVirtualizer, shouldVirtualize],
  );

  React.useEffect(() => {
    if (!onVisiblePathsChange) {
      return;
    }

    if (totalCount === 0) {
      onVisiblePathsChange([]);
      return;
    }

    if (!shouldVirtualize) {
      onVisiblePathsChange(changeEntries.slice(0, Math.min(30, totalCount)).map((entry) => entry.path));
      return;
    }

    onVisiblePathsChange(virtualRows.map((row) => changeEntries[row.index]?.path).filter((value): value is string => Boolean(value)));
  }, [changeEntries, onVisiblePathsChange, shouldVirtualize, totalCount, virtualRows]);

  const containerClassName =
    variant === 'framed'
      ? 'flex flex-col rounded-xl border border-border/60 bg-background/70'
      : 'flex flex-col flex-1 min-h-0';
  const headerClassName =
    variant === 'framed'
      ? 'flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40'
      : 'flex items-center justify-between gap-2 px-4 py-3 border-b border-border/40';
  const scrollOuterClassName =
    variant === 'framed'
      ? 'flex-1 min-h-0 max-h-[30vh]'
      : `flex-1 min-h-0 ${maxListHeightClassName ?? ''}`.trim();

  return (
    <section className={containerClassName}>
      <header className={headerClassName}>
        <h3 className="typography-ui-header font-semibold text-foreground">{t('changesSection.changes')}</h3>
        <div className="flex items-center gap-2">
          <span className="typography-meta text-muted-foreground">
            {selectedCount}/{totalCount}
          </span>
          {totalCount > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onSelectAll}
              >
                {t('changesSection.all')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onClearSelection}
                disabled={selectedCount === 0}
              >
                {t('changesSection.none')}
              </Button>
            </>
          )}
        </div>
      </header>
      <div className={cn('relative flex flex-col min-h-0 w-full overflow-hidden', scrollOuterClassName)}>
        <ScrollShadow
          ref={scrollRef}
          className="overlay-scrollbar-target overlay-scrollbar-container flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden"
        >
          {shouldVirtualize ? (
            <div
              className="relative w-full divide-y divide-border/60"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {virtualRows.map((row) => {
                const file = changeEntries[row.index];
                if (!file) {
                  return null;
                }

                return (
                  <div
                    key={file.path}
                    ref={rowVirtualizer.measureElement}
                    data-index={row.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <ChangeRow
                      file={file}
                      checked={selectedPaths.has(file.path)}
                      stats={diffStats?.[file.path]}
                      onToggle={() => onToggleFile(file.path)}
                      onViewDiff={() => onViewDiff(file.path)}
                      onRevert={() => onRevertFile(file.path)}
                      isReverting={revertingPaths.has(file.path)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="divide-y divide-border/60" role="list" aria-label={t('gitView.changedFiles')}>
              {changeEntries.map((file) => (
                <ChangeRow
                  key={file.path}
                  file={file}
                  checked={selectedPaths.has(file.path)}
                  stats={diffStats?.[file.path]}
                  onToggle={() => onToggleFile(file.path)}
                  onViewDiff={() => onViewDiff(file.path)}
                  onRevert={() => onRevertFile(file.path)}
                  isReverting={revertingPaths.has(file.path)}
                />
              ))}
            </div>
          )}
        </ScrollShadow>
        <OverlayScrollbar containerRef={scrollRef} disableHorizontal />
      </div>
    </section>
  );
};
