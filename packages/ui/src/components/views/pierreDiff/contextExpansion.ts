import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { ContextExpansionRequest, DiffAnnotation } from './types';

// external: https://github.com/pierrecomputer/pierre Partial separators have no hunk index; the next rendered line carries unified and split indices.
export const resolveContextExpansionRequest = (
  path: readonly EventTarget[],
  fileDiff: FileDiffMetadata,
): ContextExpansionRequest | null => {
  const separator = path.find((node): node is HTMLElement =>
    node instanceof HTMLElement && node.hasAttribute('data-separator'));
  if (!separator) return null;

  let next: Element | null = separator.nextElementSibling;
  while (next && !next.hasAttribute('data-line-index')) next = next.nextElementSibling;
  const [unifiedRaw, splitRaw] = next?.getAttribute('data-line-index')?.split(',') ?? [];
  const unifiedIndex = Number.parseInt(unifiedRaw ?? '', 10);
  const splitIndex = Number.parseInt(splitRaw ?? '', 10);
  if (Number.isNaN(unifiedIndex) || Number.isNaN(splitIndex)) return null;

  const hunk = fileDiff.hunks.find((candidate) =>
    candidate.unifiedLineStart <= unifiedIndex
    && unifiedIndex < candidate.unifiedLineStart + candidate.unifiedLineCount
    && candidate.splitLineStart <= splitIndex
    && splitIndex < candidate.splitLineStart + candidate.splitLineCount);
  if (!hunk) return null;

  return {
    gap: 'before-hunk',
    additionStart: hunk.additionStart,
    direction: separator.hasAttribute('data-separator-first') ? 'down' : 'both',
  };
};

const PATCH_CONTEXT_LINES = 3;

// external: https://github.com/pierrecomputer/pierre Patch-only diffs have no trailing separator because the remaining gap size is unknown.
export const getTrailingExpandAnnotation = (fileDiff: FileDiffMetadata): DiffLineAnnotation<DiffAnnotation> | null => {
  if (fileDiff.type === 'new' || fileDiff.type === 'deleted') return null;
  const hunk = fileDiff.hunks.at(-1);
  const lastContent = hunk?.hunkContent.at(-1);
  if (!hunk || lastContent?.type !== 'context' || lastContent.lines < PATCH_CONTEXT_LINES) return null;
  if (hunk.noEOFCRAdditions || hunk.noEOFCRDeletions) return null;
  return { side: 'deletions', lineNumber: hunk.deletionStart + hunk.deletionCount - 1, metadata: { type: 'trailing-expand' } };
};
