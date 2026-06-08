import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
import { Icon } from '@/components/icon/Icon';
import { ChangeRow } from './ChangeRow';
import {
  TREE_INDENT_PX,
  buildChangesTree,
  flattenChangesTree,
  type ChangesTreeDirectoryNode,
  type FlattenedTreeRow,
} from './changesTree';
import type { GitStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

export interface ChangesGroupConfig {
  /** Stable id (e.g. 'staged' | 'unstaged'). */
  id: string;
  title: string;
  entries: GitStatus['files'];
  /** Per-file primary action: '+' stages, '-' unstages. */
  actionSymbol: '+' | '-';
  /** aria/title for the bulk header action (stage all / unstage all). */
  actionAllLabel: string;
  getActionLabel: (path: string) => string;
  onActionFile: (path: string) => void;
  onActionAll: (paths: string[]) => void;
  onViewDiff: (path: string) => void;
  onRevertFile: (path: string) => void;
  showRevertActions?: boolean;
  /** Visually mark this group as "ready to commit". */
  accent?: boolean;
}

interface ChangesPanelProps {
  groups: ChangesGroupConfig[];
  diffStats: Record<string, { insertions: number; deletions: number }> | undefined;
  revertingPaths: Set<string>;
  isRevertingAll?: boolean;
  headerBackgroundClassName?: string;
  onVisiblePathsChange?: (paths: string[]) => void;
  /** Reverts every changed path across all groups; rendered once for the panel. */
  onRevertAll?: (paths: string[]) => Promise<void> | void;
}

const CHANGE_LIST_VIRTUALIZE_THRESHOLD = 1000;
const CHANGE_ROW_ESTIMATE_PX = 34;
const VISIBLE_PREFETCH_LIMIT = 30;

const ROW_PADDING_CLASSNAME = 'pl-0 pr-2';

type PanelRow =
  | { type: 'header'; key: string; groupIndex: number }
  | { type: 'file'; key: string; groupIndex: number; file: GitStatus['files'][number]; depth: number }
  | { type: 'directory'; key: string; groupIndex: number; directory: ChangesTreeDirectoryNode; depth: number }
  | { type: 'revert-all'; key: string };

const expandedKey = (groupId: string, path: string): string => `${groupId} ${path}`;

export const ChangesPanel: React.FC<ChangesPanelProps> = ({
  groups,
  diffStats,
  revertingPaths,
  isRevertingAll = false,
  headerBackgroundClassName = 'bg-sidebar',
  onVisiblePathsChange,
  onRevertAll,
}) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const isTreeView = gitChangesViewMode === 'tree';

  const visibleGroups = React.useMemo(() => groups.filter((group) => group.entries.length > 0), [groups]);

  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());
  const [expandedDirectories, setExpandedDirectories] = React.useState<Set<string>>(new Set());
  const [revertAllOpen, setRevertAllOpen] = React.useState(false);

  const trees = React.useMemo(
    () => visibleGroups.map((group) => buildChangesTree(group.entries)),
    [visibleGroups]
  );

  // Auto-expand every top-level directory the first time it appears (mirrors prior
  // ChangesSection behavior) while preserving user-collapsed nested directories.
  const topLevelDirectoryKeys = React.useMemo(() => {
    const keys: string[] = [];
    visibleGroups.forEach((group, index) => {
      Array.from(trees[index]?.children.values() ?? []).forEach((directory) => {
        keys.push(expandedKey(group.id, directory.path));
      });
    });
    return keys;
  }, [trees, visibleGroups]);

  React.useEffect(() => {
    if (!isTreeView) {
      return;
    }
    setExpandedDirectories((previous) => {
      const next = new Set<string>();
      const topLevel = new Set(topLevelDirectoryKeys);
      previous.forEach((key) => {
        const path = key.slice(key.indexOf(' ') + 1);
        if (path.includes('/') || topLevel.has(key)) {
          next.add(key);
        }
      });
      topLevelDirectoryKeys.forEach((key) => next.add(key));
      return next;
    });
  }, [isTreeView, topLevelDirectoryKeys]);

  const rows = React.useMemo<PanelRow[]>(() => {
    const result: PanelRow[] = [];

    visibleGroups.forEach((group, groupIndex) => {
      result.push({ type: 'header', key: `header:${group.id}`, groupIndex });

      if (collapsedGroups.has(group.id)) {
        return;
      }

      if (isTreeView) {
        const expandedForGroup = new Set<string>();
        expandedDirectories.forEach((key) => {
          if (key.startsWith(`${group.id} `)) {
            expandedForGroup.add(key.slice(group.id.length + 1));
          }
        });
        const treeRows = flattenChangesTree(trees[groupIndex], expandedForGroup);
        treeRows.forEach((row: FlattenedTreeRow) => {
          if (row.kind === 'file') {
            result.push({
              type: 'file',
              key: `${group.id}:${row.key}`,
              groupIndex,
              file: row.file,
              depth: row.depth,
            });
          } else {
            result.push({
              type: 'directory',
              key: `${group.id}:${row.key}`,
              groupIndex,
              directory: row.directory,
              depth: row.depth,
            });
          }
        });
        return;
      }

      group.entries.forEach((file) => {
        result.push({
          type: 'file',
          key: `${group.id}:file:${file.path}`,
          groupIndex,
          file,
          depth: 0,
        });
      });
    });

    // Revert-all lives as the final in-flow row beneath the last file, so it
    // scrolls with the list rather than sitting in a section header.
    if (onRevertAll && visibleGroups.length > 0) {
      result.push({ type: 'revert-all', key: 'revert-all' });
    }

    return result;
  }, [collapsedGroups, expandedDirectories, isTreeView, onRevertAll, trees, visibleGroups]);

  const rowCount = rows.length;
  const shouldVirtualize = rowCount >= CHANGE_LIST_VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANGE_ROW_ESTIMATE_PX,
    overscan: 12,
    enabled: shouldVirtualize,
  });

  // Remeasure when the container transitions from display:none (hidden tab) back
  // to visible layout, otherwise stale zero-height measurements render no rows.
  React.useEffect(() => {
    if (!shouldVirtualize) return;
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => rowVirtualizer.measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldVirtualize, rowVirtualizer]);

  const totalSize = rowVirtualizer.getTotalSize();
  const virtualRows = React.useMemo(
    () => (shouldVirtualize && totalSize >= 0 ? rowVirtualizer.getVirtualItems() : []),
    [shouldVirtualize, rowVirtualizer, totalSize]
  );

  React.useEffect(() => {
    if (!onVisiblePathsChange) {
      return;
    }

    const collectFromRow = (row: PanelRow | undefined): string | null =>
      row && row.type === 'file' ? row.file.path : null;

    if (rowCount === 0) {
      onVisiblePathsChange([]);
      return;
    }

    if (!shouldVirtualize) {
      const paths: string[] = [];
      for (const row of rows) {
        if (row.type === 'file') {
          paths.push(row.file.path);
          if (paths.length >= VISIBLE_PREFETCH_LIMIT) break;
        }
      }
      onVisiblePathsChange(paths);
      return;
    }

    onVisiblePathsChange(
      virtualRows
        .map((item) => collectFromRow(rows[item.index]))
        .filter((value): value is string => Boolean(value))
    );
  }, [onVisiblePathsChange, rowCount, rows, shouldVirtualize, virtualRows]);

  const toggleGroupCollapsed = React.useCallback((groupId: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleDirectoryExpanded = React.useCallback((groupId: string, path: string) => {
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      const key = expandedKey(groupId, path);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Every distinct changed path across groups (a partially-staged file appears in
  // both, so dedupe). One revert-all discards all working-tree changes at once.
  const allChangePaths = React.useMemo(() => {
    const seen = new Set<string>();
    visibleGroups.forEach((group) => group.entries.forEach((entry) => seen.add(entry.path)));
    return Array.from(seen);
  }, [visibleGroups]);
  const revertAllCount = allChangePaths.length;

  const handleConfirmRevertAll = React.useCallback(async () => {
    if (!onRevertAll || isRevertingAll || allChangePaths.length === 0) {
      return;
    }
    await onRevertAll(allChangePaths);
    setRevertAllOpen(false);
  }, [allChangePaths, isRevertingAll, onRevertAll]);

  const renderHeader = React.useCallback(
    (group: ChangesGroupConfig, isFirst: boolean) => {
      const collapsed = collapsedGroups.has(group.id);
      const count = group.entries.length;
      return (
        <div
          className={cn(
            'sticky top-0 z-10 flex items-center gap-2 py-2',
            headerBackgroundClassName,
            ROW_PADDING_CLASSNAME,
            !isFirst && 'mt-1 border-t border-border/40'
          )}
        >
          <button
            type="button"
            onClick={() => group.onActionAll(group.entries.map((entry) => entry.path))}
            className="flex size-5 shrink-0 items-center justify-center rounded typography-micro font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={group.actionAllLabel}
            title={group.actionAllLabel}
          >
            {group.actionSymbol}
          </button>

          <button
            type="button"
            onClick={() => toggleGroupCollapsed(group.id)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-expanded={!collapsed}
          >
            <h3 className="truncate typography-ui-header font-semibold text-foreground">{group.title}</h3>
            <span className="typography-meta text-muted-foreground">{count}</span>
            <Icon
              name="arrow-down-s"
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform',
                collapsed && '-rotate-90'
              )}
            />
          </button>
        </div>
      );
    },
    [collapsedGroups, headerBackgroundClassName, toggleGroupCollapsed]
  );

  const renderDirectory = React.useCallback(
    (group: ChangesGroupConfig, directory: ChangesTreeDirectoryNode, depth: number) => {
      const isExpanded = expandedDirectories.has(expandedKey(group.id, directory.path));
      return (
        <div
          className={cn('group flex items-center gap-2 py-1.5 hover:bg-sidebar/40', ROW_PADDING_CLASSNAME)}
          style={{ paddingLeft: `${depth * TREE_INDENT_PX}px` }}
        >
          <button
            type="button"
            onClick={() => toggleDirectoryExpanded(group.id, directory.path)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={
              isExpanded
                ? t('gitView.changes.collapseDirectoryAria', { path: directory.path })
                : t('gitView.changes.expandDirectoryAria', { path: directory.path })
            }
          >
            {isExpanded ? (
              <Icon name="folder-open-fill" className="h-4 w-4 flex-shrink-0 text-primary/60" />
            ) : (
              <Icon name="folder-3-fill" className="h-4 w-4 flex-shrink-0 text-primary/60" />
            )}
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={directory.path}>
              {directory.name}
            </span>
            <span className="ml-auto shrink-0 typography-micro text-muted-foreground">{directory.files.length}</span>
          </button>
          <button
            type="button"
            onClick={() => group.onActionAll(directory.files.map((file) => file.path))}
            className="flex size-5 shrink-0 items-center justify-center rounded typography-micro font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={t(
              group.actionSymbol === '+' ? 'gitView.changes.stageDirectoryAria' : 'gitView.changes.unstageDirectoryAria',
              { path: directory.path }
            )}
            title={t(
              group.actionSymbol === '+' ? 'gitView.changes.stageDirectoryAria' : 'gitView.changes.unstageDirectoryAria',
              { path: directory.path }
            )}
          >
            {group.actionSymbol}
          </button>
        </div>
      );
    },
    [expandedDirectories, t, toggleDirectoryExpanded]
  );

  const renderRow = React.useCallback(
    (row: PanelRow, isFirstRow: boolean) => {
      if (row.type === 'revert-all') {
        return (
          <div className={cn('flex justify-end py-2', ROW_PADDING_CLASSNAME)}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRevertAllOpen(true)}
              disabled={isRevertingAll}
              className="gap-1.5 text-[var(--status-error)] hover:bg-[var(--status-error)]/10 hover:text-[var(--status-error)]"
            >
              <Icon name="arrow-go-back" className="size-3.5" />
              {t('gitView.changes.revertAll')}
            </Button>
          </div>
        );
      }

      const group = visibleGroups[row.groupIndex];
      if (!group) return null;

      if (row.type === 'header') {
        return renderHeader(group, isFirstRow);
      }

      if (row.type === 'directory') {
        return renderDirectory(group, row.directory, row.depth);
      }

      const file = row.file;
      return (
        <ChangeRow
          file={file}
          actionLabel={group.getActionLabel(file.path)}
          actionSymbol={group.actionSymbol}
          onAction={() => group.onActionFile(file.path)}
          stats={diffStats?.[file.path]}
          onViewDiff={() => group.onViewDiff(file.path)}
          onRevert={() => group.onRevertFile(file.path)}
          isReverting={revertingPaths.has(file.path) || isRevertingAll}
          rowPaddingClassName={ROW_PADDING_CLASSNAME}
          indentPx={row.depth * TREE_INDENT_PX}
          actionAtStart={!isTreeView}
          showRevert={group.showRevertActions !== false}
        />
      );
    },
    [diffStats, isRevertingAll, isTreeView, renderDirectory, renderHeader, revertingPaths, t, visibleGroups]
  );

  // A divider is drawn above a file/directory row only when the row directly above
  // it belongs to the same group (so headers never get a spurious top border).
  const showDivider = React.useCallback(
    (index: number): boolean => {
      const row = rows[index];
      const previous = rows[index - 1];
      if (!row || !previous) return false;
      if (row.type !== 'file' && row.type !== 'directory') return false;
      if (previous.type !== 'file' && previous.type !== 'directory') return false;
      return previous.groupIndex === row.groupIndex;
    },
    [rows]
  );

  return (
    <>
      <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        <ScrollShadow
          ref={scrollRef}
          className="overlay-scrollbar-target overlay-scrollbar-container min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto"
        >
          {shouldVirtualize ? (
            <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
              {virtualRows.map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={row.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={item.index}
                    className={cn(
                      'absolute left-0 top-0 w-full',
                      showDivider(item.index) &&
                        'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                    )}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {renderRow(row, item.index === 0)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div role="list" aria-label={t('gitView.changes.changedFilesAria')}>
              {rows.map((row, index) => (
                <div
                  key={row.key}
                  className={cn(
                    'relative',
                    showDivider(index) &&
                      'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                  )}
                >
                  {renderRow(row, index === 0)}
                </div>
              ))}
            </div>
          )}
        </ScrollShadow>
        <OverlayScrollbar containerRef={scrollRef} disableHorizontal />
      </div>

      <Dialog
        open={revertAllOpen}
        onOpenChange={(open) => {
          if (!isRevertingAll && !open) setRevertAllOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('gitView.changes.revertAllDialogTitle')}</DialogTitle>
            <DialogDescription>
              {revertAllCount === 1
                ? t('gitView.changes.revertAllDescriptionSingle', { count: revertAllCount })
                : t('gitView.changes.revertAllDescriptionPlural', { count: revertAllCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevertAllOpen(false)} disabled={isRevertingAll}>
              {t('gitView.common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmRevertAll()}
              disabled={isRevertingAll}
            >
              {isRevertingAll ? t('gitView.changes.reverting') : t('gitView.changes.revertAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
