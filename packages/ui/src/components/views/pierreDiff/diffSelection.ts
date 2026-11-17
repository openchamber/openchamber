import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { getDiffLinesText } from '@/lib/diff/selectedDiffLines';

export const extractSelectedCode = (
  original: string,
  modified: string,
  fileDiff: FileDiffMetadata | undefined,
  range: SelectedLineRange,
): string => {
  const isOriginal = range.side === 'deletions';
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  if (fileDiff) return getDiffLinesText(fileDiff, isOriginal ? 'deletions' : 'additions', from, to);

  const lines = (isOriginal ? original : modified).split('\n');
  const startLine = Math.max(1, from);
  const endLine = Math.min(lines.length, to);
  if (startLine > endLine) return '';
  return lines.slice(startLine - 1, endLine).join('\n');
};

export const isSameSelection = (left: SelectedLineRange | null, right: SelectedLineRange | null): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.start === right.start && left.end === right.end && left.side === right.side;
};
