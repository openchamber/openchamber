import type React from 'react';
import type { ExpansionDirections, FileDiffMetadata } from '@pierre/diffs';
import type { PierreAnnotationData } from '@/components/comments';
import type { PatchHunkAnchor } from '@/lib/diff/patchFileDiff';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';

export type ContextExpansionRequest =
  | { gap: 'before-hunk'; additionStart: number; direction: ExpansionDirections }
  | { gap: 'after-last-hunk' };

export interface DiffHunkActions {
  anchors: readonly PatchHunkAnchor[];
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
  commentOrigin?: DiffCommentOrigin;
  renderSideBySide: boolean;
  wrapLines?: boolean;
  layout?: 'fill' | 'inline';
  enableComments?: boolean;
  hideWhitespace?: boolean;
  hunkActions?: DiffHunkActions;
  onExpandContextRequest?: (request: ContextExpansionRequest) => void;
  pendingContextExpansion?: ContextExpansionRequest | null;
  contextLoading?: boolean;
  onFindWordRequest?: (request: DiffFindWordRequest) => void;
  onUnsavedCommentChange?: (unsaved: boolean) => void;
}

export interface DiffFindWordRequest {
  word: string;
  lineNumber: number;
  side: DiffFindSide;
  spanStart: number;
}

export interface PierreDiffViewerHandle {
  scrollToLine(target: { lineNumber: number; side: DiffFindSide; align?: 'start' | 'center' }): boolean;
  setFindHighlights(
    matches: ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>,
    currentIndex: number,
  ): void;
}
