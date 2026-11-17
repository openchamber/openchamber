import { hasRightToLeftText, isolateInsertedText } from './textDirection';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

export function formatTemplate(template: string, params?: I18nParams): string {
  if (!params) {
    return template;
  }

  const sentenceHasRightToLeft = hasRightToLeftText(template);
  return template.replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const value = params[rawKey.trim()];
    if (value === null || value === undefined) return match;
    const text = String(value);
    return text === value ? isolateInsertedText(text, sentenceHasRightToLeft) : text;
  });
}
