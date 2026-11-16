import { hasRightToLeftText, isolateInsertedText } from './textDirection';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Fills a message's `{name}` placeholders. A string inserted into a sentence
 * of the other direction is isolated so it keeps its own; numbers have no
 * direction of their own and go in as they are. A placeholder without a value
 * stays as written.
 */
export function formatTemplate(template: string, params?: I18nParams): string {
  if (!params) {
    return template;
  }

  const sentenceHasRightToLeft = hasRightToLeftText(template);
  return template.replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const value = params[rawKey.trim()];
    if (value === null || value === undefined) return match;
    // Numbers have no direction of their own, even written as 1e-7 or NaN;
    // only strings come back from String() unchanged.
    const text = String(value);
    return text === value ? isolateInsertedText(text, sentenceHasRightToLeft) : text;
  });
}
