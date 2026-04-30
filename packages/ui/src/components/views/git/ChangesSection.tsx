import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RiFolder3Fill, RiFolderOpenFill } from '@remixicon/react';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

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

type ChangesTreeDirectoryNode = {
  id: string;
  path: string;
  name: string;
  children: Map<string, ChangesTreeDirectoryNode>;
  directFiles: GitStatus['files'];
  files: GitStatus['files'];
};

type FlattenedTreeRow =
  | {
      key: string;
      kind: 'directory';
      depth: number;
      directory: ChangesTreeDirectoryNode;
    }
  | {
      key: string;
      kind: 'file';
      depth: number;
      file: GitStatus['files'][number];
    };

const TREE_INDENT_PX = 14;

const normalizePathForTree = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+/, '').trim();

const createDirectoryNode = (path: string, name: string): ChangesTreeDirectoryNode => ({
  id: `dir:${path}`,
  path,
  name,
  children: new Map(),
  directFiles: [],
  files: [],
});

const buildChangesTree = (entries: GitStatus['files']): ChangesTreeDirectoryNode => {
  const root = createDirectoryNode('', '');

  for (const file of entries) {
    const normalized = normalizePathForTree(file.path);
    if (!normalized) {
      continue;
    }

    const segments = normalized.split('/').filter(Boolean);
    const directorySegments = segments.slice(0, -1);
    let current = root;
    current.files.push(file);

    if (directorySegments.length > 0) {
      let currentPath = '';
      for (const segment of directorySegments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const existing = current.children.get(segment);
        if (existing) {
          existing.files.push(file);
          current = existing;
          continue;
        }

        const created = createDirectoryNode(currentPath, segment);
        created.files.push(file);
        current.children.set(segment, created);
        current = created;
      }
    }

    current.directFiles.push(file);
  }

  return root;
};

const flattenChangesTree = (
  root: ChangesTreeDirectoryNode,
  expandedDirectories: Set<string>,
): FlattenedTreeRow[] => {
  const rows: FlattenedTreeRow[] = [];

  const walk = (node: ChangesTreeDirectoryNode, depth: number) => {
    const directories = Array.from(node.children.values()).sort((a, b) => a.path.localeCompare(b.path));
    for (const directory of directories) {
      rows.push({
        key: directory.id,
        kind: 'directory',
        depth,
        directory,
      });

      if (expandedDirectories.has(directory.path)) {
        walk(directory, depth + 1);
      }
    }

    const directFiles = [...node.directFiles].sort((a, b) => a.path.localeCompare(b.path));

    for (const file of directFiles) {
      rows.push({
        key: `file:${normalizePathForTree(file.path)}`,
        kind: 'file',
        depth,
        file,
      });
    }
  };

  walk(root, 0);
  return rows;
};

const getDirectorySelectionState = (
  directory: ChangesTreeDirectoryNode,
  selectedPaths: Set<string>
): 'none' | 'partial' | 'all' => {
  if (directory.files.length === 0) {
    return 'none';
  }

  let selectedCount = 0;
  for (const file of directory.files) {
    if (selectedPaths.has(file.path)) {
      selectedCount += 1;
    }
  }

  if (selectedCount === 0) return 'none';
  if (selectedCount === directory.files.length) return 'all';
  return 'partial';
};

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
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const isTreeView = gitChangesViewMode === 'tree';
  const selectedCount = selectedPaths.size;
  const totalCount = changeEntries.length;
  const [confirmRevertAllOpen, setConfirmRevertAllOpen] = React.useState(false);
  const treeRoot = React.useMemo(() => buildChangesTree(changeEntries), [changeEntries]);
  const [expandedDirectories, setExpandedDirectories] = React.useState<Set<string>>(new Set());

  const topLevelDirectoryPaths = React.useMemo(
    () => Array.from(treeRoot.children.values()).map((directory) => directory.path),
    [treeRoot]
  );

  React.useEffect(() => {
    if (!isTreeView) {
      return;
    }

    setExpandedDirectories((previous) => {
      const next = new Set<string>();
      const validTopLevel = new Set(topLevelDirectoryPaths);

      previous.forEach((path) => {
        if (path.includes('/')) {
          next.add(path);
          return;
        }
        if (validTopLevel.has(path)) {
          next.add(path);
        }
      });

      topLevelDirectoryPaths.forEach((path) => next.add(path));
      return next;
    });
  }, [isTreeView, topLevelDirectoryPaths]);

  const treeRows = React.useMemo(() => flattenChangesTree(treeRoot, expandedDirectories), [expandedDirectories, treeRoot]);
  const rowItems = React.useMemo(() => (isTreeView ? treeRows : changeEntries), [changeEntries, isTreeView, treeRows]);
  const rowCount = rowItems.length;
  const shouldVirtualize = rowCount >= CHANGE_LIST_VIRTUALIZE_THRESHOLD;
  const hasAnySelected = selectedCount > 0;
  const areAllSelected = totalCount > 0 && selectedCount === totalCount;
  const isPartiallySelected = hasAnySelected && !areAllSelected;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANGE_ROW_ESTIMATE_PX,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  // Force virtualizer to remeasure when the scroll container transitions
  // from display:none (hidden tab via keep-alive) back to visible layout.
  // Without this, the virtualizer uses stale zero-height measurements and
  // renders no rows until the user scrolls.
  React.useEffect(() => {
    if (!shouldVirtualize) return;
    const el = scrollRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      rowVirtualizer.measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldVirtualize, rowVirtualizer]);

  // Compute virtual rows with useMemo. We include totalSize as a dependency so
  // that when the ResizeObserver calls measure() — which clears the itemSizeCache
  // and recalculates — the size change invalidates the memo and getVirtualItems()
  // returns fresh rows. Using useMemo avoids calling getVirtualItems() directly in
  // the render body, which can trigger maybeNotify() → onChange() → useReducer
  // dispatch during render (React minified error #185).
  const totalSize = rowVirtualizer.getTotalSize();
  const virtualRows = React.useMemo(
    // totalSize invalidates the memo when the virtualizer recalculates after
    // measure/scroll, ensuring getVirtualItems() returns up-to-date rows.
    // Without it, the stable rowVirtualizer ref would never invalidate the memo
    // and rows would stay empty after measure().
    () => (shouldVirtualize && totalSize >= 0 ? rowVirtualizer.getVirtualItems() : []),
    [shouldVirtualize, rowVirtualizer, totalSize],
  );

  React.useEffect(() => {
    if (!onVisiblePathsChange) {
      return;
    }

    if (rowCount === 0) {
      onVisiblePathsChange([]);
      return;
    }

    const toVisiblePath = (item: GitStatus['files'][number] | FlattenedTreeRow): string | null => {
      if (!isTreeView) {
        return (item as GitStatus['files'][number]).path;
      }

      const treeItem = item as FlattenedTreeRow;
      return treeItem.kind === 'file' ? treeItem.file.path : null;
    };

    if (!shouldVirtualize) {
      onVisiblePathsChange(
        rowItems
          .slice(0, Math.min(30, rowCount))
          .map((item) => toVisiblePath(item))
          .filter((value): value is string => Boolean(value))
      );
      return;
    }

    onVisiblePathsChange(
      virtualRows
        .map((row) => rowItems[row.index])
        .map((item) => (item ? toVisiblePath(item) : null))
        .filter((value): value is string => Boolean(value))
    );
  }, [isTreeView, onVisiblePathsChange, rowCount, rowItems, shouldVirtualize, virtualRows]);

  const containerClassName = 'flex flex-col flex-1 min-h-0';
  const headerClassName = 'flex items-center justify-between gap-2 px-0 py-3 border-b border-border/40';
  const scrollOuterClassName = `flex-1 min-h-0 pr-0 ${maxListHeightClassName ?? ''}`.trim();
  const rowPaddingClassName = 'pl-0 pr-2';

  const toggleDirectoryExpanded = React.useCallback((path: string) => {
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleDirectorySelection = React.useCallback((directory: ChangesTreeDirectoryNode) => {
    const state = getDirectorySelectionState(directory, selectedPaths);
    const shouldSelectAll = state !== 'all';

    for (const file of directory.files) {
      const isSelected = selectedPaths.has(file.path);
      if (shouldSelectAll && !isSelected) {
        onToggleFile(file.path);
      } else if (!shouldSelectAll && isSelected) {
        onToggleFile(file.path);
      }
    }
  }, [onToggleFile, selectedPaths]);

  const renderRow = React.useCallback((item: GitStatus['files'][number] | FlattenedTreeRow) => {
    if (!isTreeView) {
      const file = item as GitStatus['files'][number];
      return (
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
      );
    }

    const row = item as FlattenedTreeRow;

    if (row.kind === 'file') {
      const file = row.file;
      return (
        <ChangeRow
          file={file}
          checked={selectedPaths.has(file.path)}
          stats={diffStats?.[file.path]}
          onToggle={() => onToggleFile(file.path)}
          onViewDiff={() => onViewDiff(file.path)}
          onRevert={() => onRevertFile(file.path)}
          isReverting={revertingPaths.has(file.path) || isRevertingAll}
          rowPaddingClassName={rowPaddingClassName}
          indentPx={row.depth * TREE_INDENT_PX}
        />
      );
    }

    const directory = row.directory;
    const isExpanded = expandedDirectories.has(directory.path);
    const selectionState = getDirectorySelectionState(directory, selectedPaths);

    return (
      <div
        className={cn('group flex items-center gap-2 py-1.5 hover:bg-sidebar/40', rowPaddingClassName)}
        style={{ paddingLeft: `${row.depth * TREE_INDENT_PX}px` }}
      >
        <div className="flex size-5 shrink-0 items-center justify-center">
          <Checkbox
            size="sm"
            checked={selectionState === 'all'}
            indeterminate={selectionState === 'partial'}
            onChange={() => toggleDirectorySelection(directory)}
            ariaLabel={t('gitView.changes.toggleDirectorySelectionAria', { path: directory.path })}
          />
        </div>

        <button
          type="button"
          onClick={() => toggleDirectoryExpanded(directory.path)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={isExpanded
            ? t('gitView.changes.collapseDirectoryAria', { path: directory.path })
            : t('gitView.changes.expandDirectoryAria', { path: directory.path })}
        >
          {isExpanded ? (
            <RiFolderOpenFill className="h-4 w-4 flex-shrink-0 text-primary/60" />
          ) : (
            <RiFolder3Fill className="h-4 w-4 flex-shrink-0 text-primary/60" />
          )}
          <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={directory.path}>
            {directory.name}
          </span>
          <span className="ml-auto shrink-0 typography-micro text-muted-foreground">{directory.files.length}</span>
        </button>
      </div>
    );
  }, [
    diffStats,
    expandedDirectories,
    isRevertingAll,
    isTreeView,
    onRevertFile,
    onToggleFile,
    onViewDiff,
    revertingPaths,
    rowPaddingClassName,
    selectedPaths,
    t,
    toggleDirectoryExpanded,
    toggleDirectorySelection,
  ]);

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
            <h3 className="typography-ui-header font-semibold text-foreground">{t('gitView.changes.title')}</h3>
            {totalCount > 0 ? (
              <div
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded px-1.5',
                  isRevertingAll && 'cursor-not-allowed opacity-50'
                )}
              >
                <Checkbox
                  size="sm"
                  checked={hasAnySelected}
                  indeterminate={isPartiallySelected}
                  disabled={isRevertingAll}
                  onChange={() => (areAllSelected ? onClearSelection() : onSelectAll())}
                  ariaLabel={areAllSelected ? t('gitView.changes.clearSelectionAria') : t('gitView.changes.selectAllAria')}
                />
                <span className="typography-meta text-muted-foreground">{selectedCount}/{totalCount}</span>
              </div>
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
                {t('gitView.changes.revertAll')}
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
                  const item = rowItems[row.index];
                  if (!item) {
                    return null;
                  }

                  const key = isTreeView
                    ? (item as FlattenedTreeRow).key
                    : `file:${(item as GitStatus['files'][number]).path}`;

                  return (
                    <div
                      key={key}
                      ref={rowVirtualizer.measureElement}
                      data-index={row.index}
                      className={cn(
                        'absolute left-0 top-0 w-full',
                        row.index > 0 && 'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                      )}
                      style={{ transform: `translateY(${row.start}px)` }}
                    >
                      {renderRow(item)}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div role="list" aria-label={t('gitView.changes.changedFilesAria')}>
                {rowItems.map((item, index) => (
                  <div
                    key={isTreeView ? (item as FlattenedTreeRow).key : `file:${(item as GitStatus['files'][number]).path}`}
                    className={cn(
                      'relative',
                      index > 0 && 'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                    )}
                  >
                    {renderRow(item)}
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
            <DialogTitle>{t('gitView.changes.revertAllDialogTitle')}</DialogTitle>
            <DialogDescription>
              {totalCount === 1
                ? t('gitView.changes.revertAllDescriptionSingle', { count: totalCount })
                : t('gitView.changes.revertAllDescriptionPlural', { count: totalCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmRevertAllOpen(false)} disabled={isRevertingAll}>
              {t('gitView.common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleConfirmRevertAll()} disabled={isRevertingAll}>
              {isRevertingAll ? t('gitView.changes.reverting') : t('gitView.changes.revertAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
