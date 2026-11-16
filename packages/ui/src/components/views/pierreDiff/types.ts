import type React from 'react';
import type { ExpansionDirections, FileDiffMetadata } from '@pierre/diffs';
import type { PierreAnnotationData } from '@/components/comments';
import type { PatchHunkAnchor } from '@/lib/diff/patchFileDiff';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';

/**
 * A click on a collapsed-context expander of a partial (patch-only) diff.
 * `before-hunk` comes from the separator above the hunk that starts at
 * `additionStart` in the new file; `after-last-hunk` from the row below the
 * last hunk. The owner loads the full file and the viewer replays the
 * expansion.
 */
export type ContextExpansionRequest =
  | { gap: 'before-hunk'; additionStart: number; direction: ExpansionDirections }
  | { gap: 'after-last-hunk' };

export interface DiffHunkActions {
  anchors: readonly PatchHunkAnchor[];
  /** `revealed`: the pointer is on the hunk; the actions also show on their own hover and keyboard focus. */
  render: (index: number, revealed: boolean) => React.ReactNode;
}

export type DiffAnnotation =
  | PierreAnnotationData
  | { type: 'hunk-action'; index: number }
  | { type: 'trailing-expand' };

export interface PierreDiffViewerProps {
  original: string;
  modified: string;
  fileDiff?: FileDiffMetadata;
  language: string;
  fileName?: string;
  /** The diff this is, for comments; absent for uncommitted changes. */
  commentOrigin?: DiffCommentOrigin;
  renderSideBySide: boolean;
  wrapLines?: boolean;
  layout?: 'fill' | 'inline';
  enableComments?: boolean;
  /**
   * Shows lines that changed only by whitespace as unchanged. Hunk actions are
   * dropped meanwhile: they act on the whole hunk, whitespace included.
   */
  hideWhitespace?: boolean;
  hunkActions?: DiffHunkActions;
  /**
   * Present when the owner can replace a partial diff with full file contents.
   * Partial diffs then show the same expand affordance as full ones; a click
   * reports the gap instead of expanding, because the lines are not loaded.
   */
  onExpandContextRequest?: (request: ContextExpansionRequest) => void;
  /** Expansion to replay once the diff is no longer partial. Applied once per object. */
  pendingContextExpansion?: ContextExpansionRequest | null;
  /** The owner is fetching the full file for `pendingContextExpansion`. */
  contextLoading?: boolean;
  /**
   * A primary-modifier click on a word (Cmd on macOS, Ctrl elsewhere) reports
   * that word so the owner can open find and jump to the next match.
   */
  onFindWordRequest?: (request: DiffFindWordRequest) => void;
}

/** A primary-modifier click on a word inside a diff line. */
export interface DiffFindWordRequest {
  /** The word under the pointer, expanded to its boundaries. */
  word: string;
  /** 1-based line number of the clicked row, on that row's side. */
  lineNumber: number;
  /** The clicked row's side: deletion and addition rows can share a line number. */
  side: DiffFindSide;
  /** 0-based offset of `word` inside that line's text — the same offset space as DiffFindMatch.spanStart. */
  spanStart: number;
}

/**
 * Read-only handle for find-in-diff. Both members work on the live rendered
 * diff; `setFindHighlights` also re-applies itself after virtualized rebuilds.
 */
export interface PierreDiffViewerHandle {
  /**
   * Bring this side's `lineNumber` into view. False while its row is not
   * rendered yet (the diff is still loading, or a collapsed gap or a
   * virtualized window is being moved to it): call again on a later frame.
   */
  scrollToLine(target: { lineNumber: number; side: DiffFindSide; align?: 'start' | 'center' }): boolean;
  /** Paint matches on the rendered rows, distinguishing `currentIndex`; [] clears. */
  setFindHighlights(
    matches: ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>,
    currentIndex: number,
  ): void;
}
