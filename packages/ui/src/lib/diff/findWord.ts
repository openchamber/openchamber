const WORD_CHAR = /[\p{L}\p{N}_$]/u;

export const findWordAtOffset = (lineText: string, offset: number): { word: string; spanStart: number } | null => {
  if (offset < 0 || offset > lineText.length) return null;
  const index = offset === lineText.length ? lineText.length - 1 : offset;
  if (index < 0 || !WORD_CHAR.test(lineText[index])) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && WORD_CHAR.test(lineText[start - 1])) start -= 1;
  while (end < lineText.length && WORD_CHAR.test(lineText[end])) end += 1;
  return { word: lineText.slice(start, end), spanStart: start };
};
