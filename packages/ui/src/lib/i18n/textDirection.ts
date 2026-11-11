// A word: letters with their marks and the zero-width non-joiner Persian uses
// inside words.
const WORD = /\p{L}[\p{L}\p{M}‌]*/gu;
const RTL_SCRIPTS = '\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Adlam}\\p{Script=Samaritan}\\p{Script=Mandaic}';
const RTL_LETTER = new RegExp(`^[${RTL_SCRIPTS}]`, 'u');
const HAS_RTL_LETTER = new RegExp(`[${RTL_SCRIPTS}]`, 'u');
const HAS_LETTER = /\p{L}/u;

/** True when the text has a letter of a right-to-left script. */
export const hasRightToLeftText = (text: string): boolean => HAS_RTL_LETTER.test(text);

/**
 * A value inserted into a translated sentence, set apart with the Unicode
 * first-strong isolate pair so its direction cannot reorder the sentence
 * around it: a Persian folder name in an English sentence, or "my-folder (2)"
 * in an Arabic one. Only when right-to-left text is involved and the value has
 * letters; numbers and left-to-right values in left-to-right sentences stay
 * as they are, so copied text and string comparisons see no extra characters.
 */
export const isolateInsertedText = (value: string, sentenceHasRightToLeft: boolean): string => (
  HAS_LETTER.test(value) && (sentenceHasRightToLeft || HAS_RTL_LETTER.test(value))
    ? `⁨${value}⁩`
    : value
);

/**
 * The direction most of the words in these texts run, or undefined when they
 * have none. For a block made of several texts, such as a question with its
 * options: dir="auto" goes by the first letter only, so a Persian option that
 * opens with "PWA" would run left to right among right-to-left neighbours.
 * Words count, not letters: Latin terms quoted in Persian prose are long.
 */
export const dominantTextDirection = (...texts: ReadonlyArray<string | null | undefined>): 'rtl' | 'ltr' | undefined => {
  let rtl = 0;
  let words = 0;
  for (const text of texts) {
    if (!text) continue;
    for (const [word] of text.matchAll(WORD)) {
      words += 1;
      if (RTL_LETTER.test(word)) rtl += 1;
    }
  }
  if (words === 0) return undefined;
  // A tie goes right to left: a mixed line is usually right-to-left prose
  // quoting left-to-right terms.
  return rtl * 2 >= words ? 'rtl' : 'ltr';
};
