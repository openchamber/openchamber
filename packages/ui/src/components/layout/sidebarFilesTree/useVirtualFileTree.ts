import React from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer, type Range } from '@tanstack/react-virtual';

import { buildFileTreeRows, withPinnedRowIndexes } from '../fileTreeRows';
import type { FileNode } from './fileNode';

const FILE_TREE_ROW_ESTIMATE_PX = 28;

export const useVirtualFileTree = ({
  root,
  childrenByDir,
  expandedPathSet,
  loadErrorsByDir,
  selectedPath,
  moveDragPath,
  slidingRowPaths,
  treeListRef,
}: {
  root: string;
  childrenByDir: Record<string, FileNode[]>;
  expandedPathSet: Set<string>;
  loadErrorsByDir: Record<string, string>;
  selectedPath: string | null;
  moveDragPath: string | null;
  slidingRowPaths: readonly string[] | null;
  treeListRef: React.MutableRefObject<HTMLUListElement | null>;
}) => {
  const pendingRevealPathRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    pendingRevealPathRef.current = selectedPath;
  }, [selectedPath]);
  const treeRows = React.useMemo(
    () => (root ? buildFileTreeRows({ root, childrenByDir, expandedPaths: expandedPathSet, loadErrorsByDir }) : []),
    [childrenByDir, expandedPathSet, loadErrorsByDir, root],
  );
  const treeRowIndexByPath = React.useMemo(
    () => new Map(treeRows.flatMap((row, index) => (row.kind === 'node' ? [[row.node.path, index] as const] : []))),
    [treeRows],
  );
  const [treeScrollElement, setTreeScrollElement] = React.useState<HTMLElement | null>(null);
  const [treeListElement, setTreeListElement] = React.useState<HTMLUListElement | null>(null);
  const attachTreeList = React.useCallback((element: HTMLUListElement | null) => {
    treeListRef.current = element;
    setTreeListElement(element);
  }, [treeListRef]);
  const [focusedRowPath, setFocusedRowPath] = React.useState<string | null>(null);
  const pinnedRowIndexes = React.useMemo(
    () => [moveDragPath, focusedRowPath, ...(slidingRowPaths ?? [])].flatMap((path) => (path ? [treeRowIndexByPath.get(path) ?? -1] : [])),
    [focusedRowPath, moveDragPath, slidingRowPaths, treeRowIndexByPath],
  );
  const rangeExtractor = React.useCallback(
    (range: Range) => withPinnedRowIndexes(defaultRangeExtractor(range), pinnedRowIndexes, treeRows.length),
    [pinnedRowIndexes, treeRows.length],
  );
  const [treeListOffset, setTreeListOffset] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!treeScrollElement || !treeListElement) return;
    const offset = treeListElement.getBoundingClientRect().top - treeScrollElement.getBoundingClientRect().top + treeScrollElement.scrollTop;
    setTreeListOffset(Math.max(0, Math.round(offset)));
  }, [treeListElement, treeScrollElement]);
  const measuredRowHeightRef = React.useRef<number | null>(null);
  const treeRowWidthsRef = React.useRef(new Map<string, number>());
  const treeWidthFrameRef = React.useRef<number | null>(null);
  const writeTreeWidth = React.useCallback((list: HTMLElement) => {
    const widest = Math.max(0, ...treeRowWidthsRef.current.values());
    list.style.setProperty('--oc-file-tree-width', `${widest}px`);
  }, []);
  const recordTreeRowWidth = React.useCallback((element: HTMLElement, width: number) => {
    const path = element.dataset.treeRowPath;
    const list = treeListRef.current;
    if (!path || !list || width <= list.clientWidth + 0.5) return;
    if (treeRowWidthsRef.current.get(path) === width) return;
    treeRowWidthsRef.current.set(path, width);
    if (treeWidthFrameRef.current !== null) return;
    treeWidthFrameRef.current = requestAnimationFrame(() => {
      treeWidthFrameRef.current = null;
      if (treeListRef.current) writeTreeWidth(treeListRef.current);
    });
  }, [treeListRef, writeTreeWidth]);
  React.useEffect(() => () => {
    if (treeWidthFrameRef.current !== null) cancelAnimationFrame(treeWidthFrameRef.current);
  }, []);
  React.useLayoutEffect(() => {
    if (!treeListElement) return;
    const widths = treeRowWidthsRef.current;
    for (const path of widths.keys()) {
      if (!treeRowIndexByPath.has(path)) widths.delete(path);
    }
    const scrollLeft = treeScrollElement?.scrollLeft ?? 0;
    treeListElement.style.removeProperty('--oc-file-tree-width');
    const listWidth = treeListElement.clientWidth;
    for (const row of treeListElement.children) {
      const path = row instanceof HTMLElement ? row.dataset.treeRowPath : undefined;
      if (!path) continue;
      const width = row.getBoundingClientRect().width;
      if (width > listWidth + 0.5) widths.set(path, width);
      else widths.delete(path);
    }
    writeTreeWidth(treeListElement);
    if (treeScrollElement) treeScrollElement.scrollLeft = scrollLeft;
  }, [treeListElement, treeRowIndexByPath, treeScrollElement, writeTreeWidth]);
  const treeVirtualizer = useVirtualizer<HTMLElement, HTMLLIElement>({
    count: treeRows.length,
    enabled: treeScrollElement !== null,
    getScrollElement: () => treeScrollElement,
    estimateSize: (index) => (treeRows[index]?.kind === 'node' ? measuredRowHeightRef.current : null) ?? FILE_TREE_ROW_ESTIMATE_PX,
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance);
      if (size === 0) {
        const index = instance.indexFromElement(element);
        return instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? instance.options.estimateSize(index);
      }
      if (element.dataset.treeRowPath) measuredRowHeightRef.current = size;
      if (entry) recordTreeRowWidth(element, entry.borderBoxSize?.[0]?.inlineSize ?? element.getBoundingClientRect().width);
      return size;
    },
    getItemKey: (index) => treeRows[index]?.key ?? index,
    overscan: 12,
    scrollMargin: treeListOffset,
    rangeExtractor,
  });

  const handleTreeFocus = React.useCallback((event: React.FocusEvent<HTMLUListElement>) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tree-row-path]') : null;
    setFocusedRowPath(row?.dataset.treeRowPath ?? null);
  }, []);
  const handleTreeBlur = React.useCallback((event: React.FocusEvent<HTMLUListElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setFocusedRowPath(null);
  }, []);

  React.useEffect(() => {
    const path = pendingRevealPathRef.current;
    if (!path || !treeScrollElement || !treeListElement) return;
    const index = treeRowIndexByPath.get(path);
    if (index === undefined || treeScrollElement.offsetParent === null) return;
    pendingRevealPathRef.current = null;
    treeVirtualizer.scrollToIndex(index, { align: 'auto' });
  });

  return {
    treeRows,
    virtualRows: treeVirtualizer.getVirtualItems(),
    totalSize: treeVirtualizer.getTotalSize(),
    measureRow: treeVirtualizer.measureElement,
    treeListOffset,
    setTreeScrollElement,
    attachTreeList,
    handleTreeFocus,
    handleTreeBlur,
  };
};
