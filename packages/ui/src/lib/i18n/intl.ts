import { useI18nStore } from './store';
import type { Locale } from './runtime';

const INTL_LOCALE_BY_LOCALE: Record<Locale, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  uk: 'uk-UA',
  es: 'es-ES',
  'pt-BR': 'pt-BR',
  ko: 'ko-KR',
  pl: 'pl-PL',
  ja: 'ja-JP',
};

export const getIntlLocale = (locale: Locale): string => INTL_LOCALE_BY_LOCALE[locale] ?? 'en-US';

export const getCurrentIntlLocale = (): string => getIntlLocale(useI18nStore.getState().locale);
