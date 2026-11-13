/** A matched run of a text: `[start, end)` offsets. */
export type MatchRange = readonly [number, number];

export type MatchSegment = { text: string; matched: boolean };

/**
 * Splits a text into plain and matched runs for highlighting. Ranges are
 * `[start, end)` offsets in ascending order; overlaps and offsets past the
 * text are tolerated, because they may come from another process.
 */
export const matchSegments = (text: string, ranges: ReadonlyArray<MatchRange>): MatchSegment[] => {
  const segments: MatchSegment[] = [];
  let cursor = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.min(Math.max(rawStart, cursor), text.length);
    const end = Math.min(Math.max(rawEnd, start), text.length);
    if (end === start) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), matched: false });
    segments.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });
  return segments;
};

/**
 * The part of `ranges` that falls inside `[start, end)` of the matched text,
 * shifted to be relative to `start`: for a row that shows one field of a
 * longer string the matcher ran on.
 */
export const rangesWithin = (ranges: ReadonlyArray<MatchRange>, start: number, end: number): MatchRange[] => {
  const result: MatchRange[] = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    const clippedStart = Math.max(rangeStart, start);
    const clippedEnd = Math.min(rangeEnd, end);
    if (clippedEnd > clippedStart) result.push([clippedStart - start, clippedEnd - start]);
  }
  return result;
};
