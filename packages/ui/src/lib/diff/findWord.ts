// Word characters for primary-modifier word lookup: letters, digits, `_` and `$`.
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/**
 * The word under `offset` in `lineText`, expanded to word-character
 * boundaries. `offset` is a position in a diff row's own text — the same space
 * `DiffFindMatch.spanStart` uses. Returns null when the offset is out of range
 * or lands on a non-word character (whitespace or punctuation).
 */
export const findWordAtOffset = (lineText: string, offset: number): { word: string; spanStart: number } | null => {
  if (offset < 0 || offset > lineText.length) return null;
  // A caret past the last character can only belong to the last character.
  const index = offset === lineText.length ? lineText.length - 1 : offset;
  if (index < 0 || !WORD_CHAR.test(lineText[index])) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && WORD_CHAR.test(lineText[start - 1])) start -= 1;
  while (end < lineText.length && WORD_CHAR.test(lineText[end])) end += 1;
  return { word: lineText.slice(start, end), spanStart: start };
};
