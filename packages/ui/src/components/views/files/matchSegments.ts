type MatchSegment = { text: string; matched: boolean };

/**
 * Splits a line into plain and matched runs for highlighting. Ranges are
 * `[start, end)` offsets; overlaps and offsets past the text are tolerated,
 * because they come from another process.
 */
export const matchSegments = (text: string, ranges: ReadonlyArray<readonly [number, number]>): MatchSegment[] => {
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
