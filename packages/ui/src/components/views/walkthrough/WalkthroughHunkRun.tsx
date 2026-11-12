import { memo, useCallback, useMemo } from 'react';
import { PierreDiffViewer, type DiffFindWordRequest, type PierreDiffViewerHandle } from '@/components/views/PierreDiffViewer';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { mergeRunPatch } from '@/lib/walkthrough/model';
import type { WalkthroughHunk } from '@/lib/walkthrough/types';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';

interface WalkthroughHunkRunProps {
  path: string;
  hunks: WalkthroughHunk[];
  renderSideBySide: boolean;
  wrapLines: boolean;
  /** The diff the walkthrough reads, for comments; absent for uncommitted changes. */
  commentOrigin?: DiffCommentOrigin;
  /** Find identity of this run; absent when the run is not searchable. */
  runKey?: string;
  /** Find-in-walkthrough: register this run's rendered viewer handle. */
  registerFindViewerRef?: (runKey: string, handle: PierreDiffViewerHandle | null) => void;
  /** Find-in-walkthrough: a modifier-click on a word, tagged with this run. */
  onFindWordRequest?: (runKey: string, request: DiffFindWordRequest) => void;
}

/**
 * One file's contribution to a stop. Consecutive hunks are merged back into a
 * single patch so the reader sees continuous code rather than a stack of
 * one-hunk cards.
 *
 * Inline comments are on: a review you cannot annotate is a reader, not a tool.
 * They work here because the merged patch keeps the original `@@` headers, so
 * the line numbers a comment captures are the file's real ones and not offsets
 * into an excerpt.
 */
export const WalkthroughHunkRun = memo(function WalkthroughHunkRun({
  path,
  hunks,
  renderSideBySide,
  wrapLines,
  commentOrigin,
  runKey,
  registerFindViewerRef,
  onFindWordRequest,
}: WalkthroughHunkRunProps) {
  const fileDiff = useMemo(() => {
    const patch = mergeRunPatch(hunks);
    return patch ? fileDiffFromPatch(path, patch) : undefined;
  }, [hunks, path]);

  const setViewerRef = useCallback((handle: PierreDiffViewerHandle | null) => {
    if (runKey !== undefined) registerFindViewerRef?.(runKey, handle);
  }, [registerFindViewerRef, runKey]);

  const handleFindWordRequest = useCallback((request: DiffFindWordRequest) => {
    if (runKey !== undefined) onFindWordRequest?.(runKey, request);
  }, [onFindWordRequest, runKey]);

  if (!fileDiff) return null;

  return (
    <PierreDiffViewer
      ref={setViewerRef}
      original=""
      modified=""
      fileDiff={fileDiff}
      language={getLanguageFromExtension(path) || ''}
      fileName={path}
      commentOrigin={commentOrigin}
      renderSideBySide={renderSideBySide}
      wrapLines={wrapLines}
      layout="inline"
      onFindWordRequest={handleFindWordRequest}
    />
  );
});
