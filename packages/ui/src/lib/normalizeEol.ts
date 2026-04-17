export const normalizeEol = (value: string): string => String(value || '').replace(/\r\n?/g, '\n');

export const eolEqual = (left: string, right: string): boolean => normalizeEol(left) === normalizeEol(right);

export const splitLines = (value: string): string[] => normalizeEol(value).split('\n');

export const prepareForDiff = <T extends { original: string; modified: string; isBinary?: boolean }>(diff: T): T => {
  if (!diff || diff.isBinary) {
    return diff;
  }

  return {
    ...diff,
    original: normalizeEol(diff.original),
    modified: normalizeEol(diff.modified),
  };
};
