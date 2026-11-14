/**
 * `@/lib/i18n` inside a shared page. The page carries no locale store and no
 * dictionaries beyond the strings its renderer shows (`../messages.generated.ts`);
 * the entry provides `I18nContext` with the reader's locale. Every export the
 * bundled components import from `@/lib/i18n` has to be here.
 */
export { useI18n } from '@/lib/i18n/useI18n';
export { getInlineStartSide, getLocaleDirection, isRightToLeft } from '@/lib/i18n/runtime';
export type { I18nKey, I18nParams, Locale } from '@/lib/i18n/store';

let intlLocale = 'en-US';

export const getCurrentIntlLocale = (): string => intlLocale;

export const setShareIntlLocale = (locale: string): void => {
  intlLocale = locale;
};
