/**
 * Case-insensitive substring match ranges over a single text string, using
 * the same non-overlapping `String.prototype.indexOf` scan semantics as
 * standard find-in-page (e.g. "aaa" in "aaaa" yields a single [0,3]).
 */
export const findMatchRanges = (text: string, query: string): Array<{ start: number; end: number }> => {
  const normalized = query.trim().toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  if (!normalized) {
    return ranges;
  }
  const lower = text.toLowerCase();
  let cursor = 0;
  while (true) {
    const index = lower.indexOf(normalized, cursor);
    if (index === -1) {
      break;
    }
    ranges.push({ start: index, end: index + normalized.length });
    cursor = index + normalized.length;
  }
  return ranges;
};
