import React from 'react';
import { defaultRangeExtractor, measureElement, useVirtualizer, type Range } from '@tanstack/react-virtual';

import { buildFileTreeRows, withPinnedRowIndexes } from '../fileTreeRows';
import type { FileNode } from './fileNode';

// A row is one meta line plus its padding (FileRow's block size); rows are
// measured once mounted, and every file and folder row then estimates at the
// measured height.
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
  // A newly selected file is revealed once, as soon as its row exists: its
  // ancestors may still be loading when the selection lands. After that the
  // tree scrolls only when the user scrolls it.
  const pendingRevealPathRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    pendingRevealPathRef.current = selectedPath;
  }, [selectedPath]);
  // Virtualized: only the rows in and near view are in the document. With
  // every expanded folder mounted, a large repository put thousands of
  // elements under the context panel, and each open restyled all of them and
  // added them to the accessibility tree inside the opening animation.
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
  // The list starts below the scroller's own padding.
  const [treeListOffset, setTreeListOffset] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!treeScrollElement || !treeListElement) return;
    const offset = treeListElement.getBoundingClientRect().top - treeScrollElement.getBoundingClientRect().top + treeScrollElement.scrollTop;
    setTreeListOffset(Math.max(0, Math.round(offset)));
  }, [treeListElement, treeScrollElement]);
  const measuredRowHeightRef = React.useRef<number | null>(null);
  // Only some rows are mounted, so the list keeps the width of every row seen
  // wider than the pane, by path: every row's fill and end lane then span the
  // scrolled width, and a wide row out of view keeps the list wide, or the
  // sideways scroll would snap back. A row is as wide as the list or its whole
  // name, so only a row wider than the list tells its own width. Mounted rows
  // report it through the virtualizer's resize observer; the write waits a
  // frame so it never resizes observed rows inside that observer's callback.
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
  // When the rows change, rows that left the tree drop out, and mounted rows
  // measure again from the pane's width, so a name that got shorter narrows
  // the list. Measuring lays the list out narrower for a moment, which clamps
  // the sideways scroll; it is restored before paint.
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
    // Enabled before the scroller exists, the virtualizer would cache offset 0.
    enabled: treeScrollElement !== null,
    getScrollElement: () => treeScrollElement,
    // Rows a folder just showed start at their real height: with a guess they
    // moved once measured, and the rows sliding under an opening folder jumped
    // at the end of the motion.
    estimateSize: (index) => (treeRows[index]?.kind === 'node' ? measuredRowHeightRef.current : null) ?? FILE_TREE_ROW_ESTIMATE_PX,
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance);
      if (element.dataset.treeRowPath) measuredRowHeightRef.current = size;
      if (entry) recordTreeRowWidth(element, entry.borderBoxSize?.[0]?.inlineSize ?? element.getBoundingClientRect().width);
      return size;
    },
    getItemKey: (index) => treeRows[index]?.key ?? index,
    overscan: 12,
    scrollMargin: treeListOffset,
    rangeExtractor,
  });

  // Follows focus inside the tree, so the focused row stays mounted.
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
    // Only the tree's own list: search results take its place while a query runs.
    if (!path || !treeScrollElement || !treeListElement) return;
    const index = treeRowIndexByPath.get(path);
    // A hidden tree has no layout to scroll; reveal once it is shown.
    if (index === undefined || treeScrollElement.offsetParent === null) return;
    pendingRevealPathRef.current = null;
    treeVirtualizer.scrollToIndex(index, { align: 'auto' });
  });

  return { treeRows, treeVirtualizer, treeListOffset, setTreeScrollElement, attachTreeList, handleTreeFocus, handleTreeBlur };
};
