import type { FileDiffMetadata } from '@pierre/diffs';

export type DiffFindSide = 'additions' | 'deletions';

export interface DiffFindMatch {
  filePath: string;
  side: DiffFindSide;
  lineNumber: number;
  spanStart: number;
  spanLength: number;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const escapeRegExp = (value: string): string => value.replace(REGEXP_SPECIALS, '\\$&');

const lineText = (line: string): string => line.replace(/\r?\n$/, '');

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
