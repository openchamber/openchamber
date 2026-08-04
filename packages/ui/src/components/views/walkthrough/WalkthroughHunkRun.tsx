import { memo, useMemo } from 'react';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { mergeRunPatch } from '@/lib/walkthrough/model';
import type { WalkthroughHunk } from '@/lib/walkthrough/types';

interface WalkthroughHunkRunProps {
  path: string;
  hunks: WalkthroughHunk[];
  renderSideBySide: boolean;
  wrapLines: boolean;
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
}: WalkthroughHunkRunProps) {
  const fileDiff = useMemo(() => {
    const patch = mergeRunPatch(hunks);
    return patch ? fileDiffFromPatch(path, patch) : undefined;
  }, [hunks, path]);

  if (!fileDiff) return null;

  return (
    <PierreDiffViewer
      original=""
      modified=""
      fileDiff={fileDiff}
      language={getLanguageFromExtension(path) || ''}
      fileName={path}
      renderSideBySide={renderSideBySide}
      wrapLines={wrapLines}
      layout="inline"
    />
  );
});
