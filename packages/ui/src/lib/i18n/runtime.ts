export type Locale = 'en' | 'zh-CN' | 'uk' | 'es' | 'pt-BR';

export const LOCALES = ['en', 'zh-CN', 'uk', 'es', 'pt-BR'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.simplifiedChinese' | 'common.language.ukrainian' | 'common.language.spanish' | 'common.language.brazilianPortuguese'> = {
  en: 'common.language.english',
  'zh-CN': 'common.language.simplifiedChinese',
  uk: 'common.language.ukrainian',
  es: 'common.language.spanish',
  'pt-BR': 'common.language.brazilianPortuguese',
};

export const LOCALE_STORAGE_KEY = 'openchamber.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

export function normalizeLocale(value: string | undefined | null): Locale {
  if (!value) {
    return DEFAULT_LOCALE;
  }

  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-cn' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en';
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
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | undefined {
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

function getRuntimeLanguage(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as unknown as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { language?: string } } })
    .__OPENCHAMBER_RUNTIME_APIS__?.runtime?.language;
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  const runtimeLanguage = getRuntimeLanguage();
  if (runtimeLanguage) {
    return normalizeLocale(runtimeLanguage);
  }

  if (typeof navigator !== 'undefined') {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const language of languages) {
      const locale = normalizeLocale(language);
      if (locale !== DEFAULT_LOCALE) {
        return locale;
      }
    }
  }

  return DEFAULT_LOCALE;
}
