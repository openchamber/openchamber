const WORD = /\p{L}[\p{L}\p{M}‌]*/gu;
const RTL_SCRIPTS = '\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Adlam}\\p{Script=Samaritan}\\p{Script=Mandaic}';
const RTL_LETTER = new RegExp(`^[${RTL_SCRIPTS}]`, 'u');
const HAS_RTL_LETTER = new RegExp(`[${RTL_SCRIPTS}]`, 'u');
const HAS_LETTER = /\p{L}/u;

export const hasRightToLeftText = (text: string): boolean => HAS_RTL_LETTER.test(text);

export const isolateInsertedText = (value: string, sentenceHasRightToLeft: boolean): string => (
  HAS_LETTER.test(value) && (sentenceHasRightToLeft || HAS_RTL_LETTER.test(value))
    ? `⁨${value}⁩`
    : value
);

export type TextDirection = 'rtl' | 'ltr';

const majorityDirection = (words: readonly string[]): TextDirection | undefined => {
  let rtl = 0;
  for (const word of words) {
    if (RTL_LETTER.test(word)) rtl += 1;
  }
  if (words.length === 0) return undefined;
  return rtl * 2 >= words.length ? 'rtl' : 'ltr';
};

export const dominantTextDirection = (...texts: ReadonlyArray<string | null | undefined>): TextDirection | undefined => (
  majorityDirection(texts.flatMap((text) => (text ? Array.from(text.matchAll(WORD), ([word]) => word) : [])))
);

const INLINE_CODE_OR_URL = /`[^`\n]*`|https?:\/\/\S+/g;

export const proseTextDirection = (text: string): TextDirection | undefined => {
  if (!HAS_RTL_LETTER.test(text)) return HAS_LETTER.test(text) ? 'ltr' : undefined;
  return majorityDirection(text.replace(INLINE_CODE_OR_URL, ' ').split(/\s+/).flatMap((token) => {
    const word = token.match(WORD)?.[0];
    return word ? [word] : [];
  }));
};
