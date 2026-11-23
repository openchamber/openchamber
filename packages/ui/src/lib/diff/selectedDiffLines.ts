import type { FileDiffMetadata } from '@pierre/diffs';
import type { CommentLineSource } from '@/lib/commentAnchor';

type DiffLineSide = 'additions' | 'deletions';

const stripLineEnding = (line: string): string => line.replace(/\r?\n$/, '');

const lineIndexFor = (fileDiff: FileDiffMetadata, side: DiffLineSide, lineNumber: number): number | null => {
  if (!fileDiff.isPartial) return lineNumber - 1;

  for (const hunk of fileDiff.hunks) {
    const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    if (lineNumber < start || lineNumber >= start + count) continue;
    const firstIndex = side === 'additions' ? hunk.additionLineIndex : hunk.deletionLineIndex;
    return firstIndex + (lineNumber - start);
  }
  return null;
};

export const getDiffLinesText = (
  fileDiff: FileDiffMetadata,
  side: DiffLineSide,
  from: number,
  to: number,
): string => {
  const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
  const selected: string[] = [];
  for (let lineNumber = Math.max(1, from); lineNumber <= to; lineNumber += 1) {
    const index = lineIndexFor(fileDiff, side, lineNumber);
    const line = index === null ? undefined : lines[index];
    if (line !== undefined) selected.push(stripLineEnding(line));
  }
  return selected.join('\n');
};

export const diffLineSource = (fileDiff: FileDiffMetadata, side: DiffLineSide): CommentLineSource => {
  const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
  const lineAt = (lineNumber: number): string | undefined => {
    const index = lineIndexFor(fileDiff, side, lineNumber);
    const line = index === null ? undefined : lines[index];
    return line === undefined ? undefined : stripLineEnding(line);
  };
  if (!fileDiff.isPartial) return { first: 1, last: lines.length, lineAt, partial: lines.length === 0 };

  let first = Infinity;
  let last = 0;
  for (const hunk of fileDiff.hunks) {
    const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    if (count === 0) continue;
    first = Math.min(first, start);
    last = Math.max(last, start + count - 1);
  }
  return { first: Number.isFinite(first) ? first : 1, last, lineAt, partial: true };
};
