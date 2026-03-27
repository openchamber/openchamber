import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RiCheckboxBlankLine, RiCheckboxLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
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
  onRevertAll?: (paths: string[]) => Promise<void> | void;
  onViewDiff: (path: string) => void;
  onRevertFile: (path: string) => void;
  isRevertingAll?: boolean;
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
  onRevertAll,
  onViewDiff,
  onRevertFile,
  isRevertingAll = false,
  maxListHeightClassName,
  onVisiblePathsChange,
}) => {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const selectedCount = selectedPaths.size;
  const totalCount = changeEntries.length;
  const [confirmRevertAllOpen, setConfirmRevertAllOpen] = React.useState(false);
  const shouldVirtualize = totalCount >= CHANGE_LIST_VIRTUALIZE_THRESHOLD;
  const hasAnySelected = selectedCount > 0;
  const areAllSelected = totalCount > 0 && selectedCount === totalCount;
  const isPartiallySelected = hasAnySelected && !areAllSelected;

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

  const containerClassName = 'flex flex-col flex-1 min-h-0';
  const headerClassName = 'flex items-center justify-between gap-2 px-0 py-3 border-b border-border/40';
  const scrollOuterClassName = `flex-1 min-h-0 pr-0 ${maxListHeightClassName ?? ''}`.trim();
  const rowPaddingClassName = 'pl-0 pr-2';

  const handleConfirmRevertAll = React.useCallback(async () => {
    if (!onRevertAll || isRevertingAll || changeEntries.length === 0) {
      return;
    }

    await onRevertAll(changeEntries.map((entry) => entry.path));
    setConfirmRevertAllOpen(false);
  }, [changeEntries, isRevertingAll, onRevertAll]);

  return (
    <>
      <section className={containerClassName}>
        <header className={headerClassName}>
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="typography-ui-header font-semibold text-foreground">Changes</h3>
            {totalCount > 0 ? (
              <button
                type="button"
                onClick={areAllSelected ? onClearSelection : onSelectAll}
                disabled={isRevertingAll}
                aria-checked={isPartiallySelected ? 'mixed' : hasAnySelected}
                aria-label={areAllSelected ? 'Clear file selection' : 'Select all files'}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground',
                  'hover:bg-interactive-hover/55 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  isRevertingAll && 'cursor-not-allowed opacity-50'
                )}
              >
                {hasAnySelected ? (
                  <RiCheckboxLine className={cn('size-4', isPartiallySelected ? 'text-primary/50' : 'text-primary')} />
                ) : (
                  <RiCheckboxBlankLine className="size-4" />
                )}
                <span className="typography-meta text-muted-foreground">{selectedCount}/{totalCount}</span>
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2 pr-1">
            {totalCount > 0 && onRevertAll ? (
              <Button
                variant="destructive"
                size="xs"
                onClick={() => setConfirmRevertAllOpen(true)}
                disabled={isRevertingAll}
              >
                Revert all
              </Button>
            ) : null}
          </div>
        </header>
        <div className={cn('relative flex flex-col min-h-0 w-full overflow-hidden', scrollOuterClassName)}>
          <ScrollShadow
            ref={scrollRef}
            className="overlay-scrollbar-target overlay-scrollbar-container flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden"
          >
            {shouldVirtualize ? (
              <div
                className="relative w-full"
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
                      className={cn(
                        'absolute left-0 top-0 w-full',
                        row.index > 0 && 'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                      )}
                      style={{ transform: `translateY(${row.start}px)` }}
                    >
                      <ChangeRow
                        file={file}
                        checked={selectedPaths.has(file.path)}
                        stats={diffStats?.[file.path]}
                        onToggle={() => onToggleFile(file.path)}
                        onViewDiff={() => onViewDiff(file.path)}
                        onRevert={() => onRevertFile(file.path)}
                        isReverting={revertingPaths.has(file.path) || isRevertingAll}
                        rowPaddingClassName={rowPaddingClassName}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div role="list" aria-label="Changed files">
                {changeEntries.map((file, index) => (
                  <div
                    key={file.path}
                    className={cn(
                      'relative',
                      index > 0 && 'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                    )}
                  >
                    <ChangeRow
                      file={file}
                      checked={selectedPaths.has(file.path)}
                      stats={diffStats?.[file.path]}
                      onToggle={() => onToggleFile(file.path)}
                      onViewDiff={() => onViewDiff(file.path)}
                      onRevert={() => onRevertFile(file.path)}
                      isReverting={revertingPaths.has(file.path) || isRevertingAll}
                      rowPaddingClassName={rowPaddingClassName}
                    />
                  </div>
                ))}
              </div>
            )}
          </ScrollShadow>
          <OverlayScrollbar containerRef={scrollRef} disableHorizontal />
        </div>
      </section>

      <Dialog open={confirmRevertAllOpen} onOpenChange={(open) => { if (!isRevertingAll) setConfirmRevertAllOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revert all changes?</DialogTitle>
            <DialogDescription>
              This will discard local changes for {totalCount} file{totalCount === 1 ? '' : 's'} in the list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmRevertAllOpen(false)} disabled={isRevertingAll}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleConfirmRevertAll()} disabled={isRevertingAll}>
              {isRevertingAll ? 'Reverting...' : 'Revert all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
