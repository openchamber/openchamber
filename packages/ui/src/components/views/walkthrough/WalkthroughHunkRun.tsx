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
  commentOrigin?: DiffCommentOrigin;
  runKey?: string;
  registerFindViewerRef?: (runKey: string, handle: PierreDiffViewerHandle | null) => void;
  onFindWordRequest?: (runKey: string, request: DiffFindWordRequest) => void;
}

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
