export type Locale = 'en' | 'de' | 'fr' | 'nl' | 'zh-CN' | 'zh-TW' | 'uk' | 'es' | 'pt-BR' | 'ko' | 'pl' | 'ja' | 'tr' | 'ar' | 'he';

export const LOCALES = ['en', 'de', 'fr', 'nl', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja', 'tr', 'ar', 'he'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export type LayoutDirection = 'ltr' | 'rtl';

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar', 'he']);

export function getLocaleDirection(locale: Locale): LayoutDirection {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

export function getInlineStartSide(direction: LayoutDirection): 'left' | 'right' {
  return direction === 'rtl' ? 'right' : 'left';
}

// external: https://developer.mozilla.org/en-US/docs/Web/CSS/:dir WebKit before 16.4 rejects :dir(), so direction follows the nearest explicit dir attribute.
export function isRightToLeft(element: Element): boolean {
  return element.closest('[dir="rtl"], [dir="ltr"]')?.getAttribute('dir') === 'rtl';
}

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.french' | 'common.language.dutch' | 'common.language.simplifiedChinese' | 'common.language.traditionalChinese' | 'common.language.ukrainian' | 'common.language.spanish' | 'common.language.brazilianPortuguese' | 'common.language.korean' | 'common.language.polish' | 'common.language.german' | 'common.language.japanese' | 'common.language.turkish' | 'common.language.arabic' | 'common.language.hebrew'> = {
  en: 'common.language.english',
  fr: 'common.language.french',
  nl: 'common.language.dutch',
  'zh-CN': 'common.language.simplifiedChinese',
  'zh-TW': 'common.language.traditionalChinese',
  uk: 'common.language.ukrainian',
  es: 'common.language.spanish',
  'pt-BR': 'common.language.brazilianPortuguese',
  ko: 'common.language.korean',
  pl: 'common.language.polish',
  de: 'common.language.german',
  ja: 'common.language.japanese',
  tr: 'common.language.turkish',
  ar: 'common.language.arabic',
  he: 'common.language.hebrew',
};

export const LOCALE_STORAGE_KEY = 'openchamber.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

function supportedLocale(value: string | undefined | null): Locale | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-cn' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) {
    return 'zh-CN';
  }
  if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo' || normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  if (normalized === 'fr' || normalized.startsWith('fr-')) {
    return 'fr';
  }
  if (normalized === 'nl' || normalized.startsWith('nl-')) {
    return 'nl';
  }
  if (normalized === 'uk' || normalized.startsWith('uk-') || normalized === 'ua' || normalized.startsWith('ua-')) {
    return 'uk';
  }
  if (normalized === 'es' || normalized.startsWith('es-')) {
    return 'es';
  }
  if (normalized === 'pt' || normalized === 'pt-br' || normalized.startsWith('pt-br-')) {
    return 'pt-BR';
  }
  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return 'ko';
  }
  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return 'ja';
  }
  if (normalized === 'de' || normalized.startsWith('de-')) {
    return 'de';
  }
  if (normalized === 'pl' || normalized.startsWith('pl-')) {
    return 'pl';
  }
  if (normalized === 'tr' || normalized.startsWith('tr-')) {
    return 'tr';
  }
  if (normalized === 'ar' || normalized.startsWith('ar-')) {
    return 'ar';
  }
  if (normalized === 'he' || normalized.startsWith('he-') || normalized === 'iw' || normalized.startsWith('iw-')) {
    return 'he';
  }
  return undefined;
}

export function normalizeLocale(value: string | undefined | null): Locale {
  return supportedLocale(value) ?? DEFAULT_LOCALE;
}

function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredLocale;
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale }));
  } catch {
    return;
  }
}

declare global {
  interface Window {
    __OPENCHAMBER_HOST_LANGUAGE__?: string;
  }
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  const hostLanguage = globalThis.window?.__OPENCHAMBER_HOST_LANGUAGE__;
  if (hostLanguage) {
    return normalizeLocale(hostLanguage);
  }

  for (const language of globalThis.window?.navigator.languages ?? []) {
    const locale = supportedLocale(language);
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}
