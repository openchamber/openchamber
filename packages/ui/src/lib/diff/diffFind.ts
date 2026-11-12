import type { FileDiffMetadata } from '@pierre/diffs';

export type DiffFindSide = 'additions' | 'deletions';

export interface DiffFindMatch {
  filePath: string;
  side: DiffFindSide;
  /** 1-based line number on that side, matching the library's own numbering. */
  lineNumber: number;
  /** 0-based offset and length of the match inside the line text. */
  spanStart: number;
  spanLength: number;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const escapeRegExp = (value: string): string => value.replace(REGEXP_SPECIALS, '\\$&');

/** Strip a trailing CR/LF so offsets index the line text the diff renders. */
const lineText = (line: string): string => line.replace(/\r?\n$/, '');

/**
 * Every occurrence of `query` in `text`, left to right. Matches never overlap,
 * and offsets are always into the original `text` (case folding only affects
 * the search, not the returned spans).
 */
const findSpans = (
  text: string,
  query: string,
  caseSensitive: boolean,
): Array<{ spanStart: number; spanLength: number }> => {
  const pattern = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
  const spans: Array<{ spanStart: number; spanLength: number }> = [];
  for (const match of text.matchAll(pattern)) {
    spans.push({ spanStart: match.index ?? 0, spanLength: match[0].length });
  }
  return spans;
};

const pushLineMatches = (
  out: DiffFindMatch[],
  filePath: string,
  side: DiffFindSide,
  lineNumber: number,
  line: string,
  query: string,
  caseSensitive: boolean,
): void => {
  if (lineNumber < 1) return;
  const text = lineText(line);
  for (const span of findSpans(text, query, caseSensitive)) {
    out.push({ filePath, side, lineNumber, spanStart: span.spanStart, spanLength: span.spanLength });
  }
};

/**
 * All matches of `query` across the rendered rows of a single file diff, in
 * reading order: hunks first, then lines, and within a change block deletions
 * before additions. `query` is matched verbatim — callers decide whether to
 * trim.
 *
 * Rows are layout-aware. Inline (unified) renders one row per context line,
 * carrying the additions line number, so a context match is emitted once with
 * `side: 'additions'`. Side-by-side renders a context line twice, once per
 * side, so both sides are emitted. Change-block rows are independent in either
 * layout and always keep their own side.
 */
export const findMatchesInFileDiff = (
  fileDiff: FileDiffMetadata,
  filePath: string,
  query: string,
  options: { caseSensitive?: boolean; layout: 'inline' | 'side-by-side' },
): DiffFindMatch[] => {
  if (query.length === 0) return [];
  const caseSensitive = options.caseSensitive ?? false;
  const inline = options.layout === 'inline';
  const matches: DiffFindMatch[] = [];

  for (const hunk of fileDiff.hunks) {
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let offset = 0; offset < content.lines; offset += 1) {
          // Inline renders the context row with the additions line number only;
          // the deletions side has no row to point at.
          if (!inline) {
            pushLineMatches(matches, filePath, 'deletions', deletionLine + offset, fileDiff.deletionLines[content.deletionLineIndex + offset], query, caseSensitive);
          }
          pushLineMatches(matches, filePath, 'additions', additionLine + offset, fileDiff.additionLines[content.additionLineIndex + offset], query, caseSensitive);
        }
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        pushLineMatches(matches, filePath, 'deletions', deletionLine + offset, fileDiff.deletionLines[content.deletionLineIndex + offset], query, caseSensitive);
      }
      deletionLine += content.deletions;

      for (let offset = 0; offset < content.additions; offset += 1) {
        pushLineMatches(matches, filePath, 'additions', additionLine + offset, fileDiff.additionLines[content.additionLineIndex + offset], query, caseSensitive);
      }
      additionLine += content.additions;
    }
  }

  return matches;
};
