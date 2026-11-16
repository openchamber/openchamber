import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { ContextExpansionRequest, DiffAnnotation } from './types';

/**
 * Maps a click inside a partial diff's separator to the hunk below it. Pierre
 * renders no expand buttons for partial diffs, so the separator carries no
 * hunk index; the first rendered line after it does, through `data-line-index`
 * (`unified,split`), which falls inside the hunk's own line range.
 */
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

  // Nothing is expanded in a partial diff, so any rendered line of hunk N
  // sits inside N's own index range.
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

// Context lines git and GitHub put around each change unless asked otherwise.
const PATCH_CONTEXT_LINES = 3;

/**
 * Pierre cannot size the gap after the last hunk of a patch-only diff, so it
 * draws no separator there. Git emits up to the requested context after the
 * last change; fewer context lines, or a no-newline marker, mean the hunk
 * reaches the end of the file. Otherwise more lines may follow, and the row
 * anchored to the hunk's last line offers to load them.
 */
export const getTrailingExpandAnnotation = (fileDiff: FileDiffMetadata): DiffLineAnnotation<DiffAnnotation> | null => {
  if (fileDiff.type === 'new' || fileDiff.type === 'deleted') return null;
  const hunk = fileDiff.hunks.at(-1);
  const lastContent = hunk?.hunkContent.at(-1);
  if (!hunk || lastContent?.type !== 'context' || lastContent.lines < PATCH_CONTEXT_LINES) return null;
  if (hunk.noEOFCRAdditions || hunk.noEOFCRDeletions) return null;
  // The last row is context, so it exists on both sides. Deletions places the
  // row in the left column of a split diff, where Pierre's separators sit.
  return { side: 'deletions', lineNumber: hunk.deletionStart + hunk.deletionCount - 1, metadata: { type: 'trailing-expand' } };
};
