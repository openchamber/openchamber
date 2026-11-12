/** A finished tokenization: the code it was for and one HTML string per line. */
export type ReadyHighlight = { code: string; language: string; lines: string[] };

const NO_CARRIED_LINES: readonly (string | undefined)[] = [];

/**
 * The previous result's HTML for every line of `code` whose text is unchanged
 * at the same index; undefined where the line changed or is new. Nothing
 * carries across a language change.
 */
export const carryUnchangedLines = (
  previous: ReadyHighlight | null,
  code: string,
  language: string,
): readonly (string | undefined)[] => {
  if (!previous || previous.language !== language) return NO_CARRIED_LINES;
  const before = previous.code.split('\n');
  return code.split('\n').map((line, index) => (before[index] === line ? previous.lines[index] : undefined));
};
