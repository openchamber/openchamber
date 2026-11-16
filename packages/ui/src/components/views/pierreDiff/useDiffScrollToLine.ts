import { useCallback, type RefObject } from 'react';
import {
  VirtualizedFileDiff,
  type FileDiff as PierreFileDiff,
  type FileDiffMetadata,
  type Virtualizer,
} from '@pierre/diffs';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import { getDiffShadowRoot } from './diffDom';
import { deletionGapToAdditionLine, FIND_CURRENT_ATTR, isWithinHunk, rowMatchesSide } from './findHighlights';
import type { SharedVirtualizer } from './sharedVirtualizer';
import type { DiffAnnotation } from './types';

interface ScrollToLineInput {
  fileDiff: FileDiffMetadata | undefined;
  diffInstanceRef: RefObject<PierreFileDiff<DiffAnnotation> | null>;
  diffContainerRef: RefObject<HTMLDivElement | null>;
  instanceVirtualizerRef: RefObject<Virtualizer | null>;
  sharedVirtualizerRef: RefObject<SharedVirtualizer | null>;
}

export const useDiffScrollToLine = ({
  fileDiff,
  diffInstanceRef,
  diffContainerRef,
  instanceVirtualizerRef,
  sharedVirtualizerRef,
}: ScrollToLineInput) => {
  const scrollToLine = useCallback((target: { lineNumber: number; side: DiffFindSide; align?: 'start' | 'center' }): boolean => {
    const instance = diffInstanceRef.current;
    const { lineNumber, side, align = 'start' } = target;
    if (!instance || lineNumber < 1) return false;

    // `isLineRenderable` wraps the library's additions-only oracle, so a
    // deletions gap line is translated to its additions counterpart first.
    const oracleLine = side === 'additions'
      ? lineNumber
      : deletionGapToAdditionLine(fileDiff?.hunks ?? [], lineNumber);

    const isRenderable = (): boolean => {
      if (isWithinHunk(fileDiff, lineNumber, side)) return true;
      // A partial diff has no file contents, so collapsed gaps never hydrate.
      if (fileDiff?.isPartial) return false;
      return oracleLine !== undefined && instance.isLineRenderable(oracleLine);
    };

    // The rendered row is the authority on where the line is: it is centered
    // directly. A virtualized diff may not have rendered it yet, so the
    // virtualizer is first moved to the line's estimated position (its cached
    // geometry can be stale right after the file expanded), and the next
    // attempt centers the row it renders there.
    const scrollNow = (): boolean => {
      const root = getDiffShadowRoot(diffContainerRef.current);
      for (const row of root?.querySelectorAll(`[data-line="${lineNumber}"]`) ?? []) {
        if (!(row instanceof HTMLElement) || !rowMatchesSide(row, side)) continue;
        // The active mark when it is painted: aligning the whole row would
        // also scroll a wide line sideways, under the line numbers.
        const target = row.querySelector(`mark[${FIND_CURRENT_ATTR}]`) ?? row;
        target.scrollIntoView({ block: align === 'center' ? 'center' : 'start', inline: 'nearest' });
        return true;
      }
      if (!(instance instanceof VirtualizedFileDiff)) return false;
      const position = instance.getLinePosition(lineNumber, side);
      const virtualizer = instanceVirtualizerRef.current ?? sharedVirtualizerRef.current?.virtualizer ?? null;
      if (!position || !virtualizer) return false;
      const scrollRoot = virtualizer.getRoot();
      const viewportHeight = scrollRoot instanceof Document ? globalThis.innerHeight : (scrollRoot?.getBoundingClientRect().height ?? 0);
      const base = (instance.top ?? 0) + position.top;
      // Re-read the scroll height the virtualizer clamps against: it predates
      // a file that just expanded.
      virtualizer.markDOMDirty();
      virtualizer.scrollTo({ top: base - Math.max(0, (viewportHeight - position.height) / 2), behavior: 'auto' });
      return false;
    };

    if (isRenderable()) return scrollNow();
    // A collapsed gap is not rendered until expanded; revealLine is
    // additions-indexed and only works for a full diff. Either way the line is
    // not on screen yet, so the caller tries again on a later frame.
    if (!fileDiff?.isPartial && oracleLine !== undefined) instance.revealLine(oracleLine);
    return false;
  }, [diffContainerRef, diffInstanceRef, fileDiff, instanceVirtualizerRef, sharedVirtualizerRef]);

  return scrollToLine;
};
