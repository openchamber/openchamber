import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en, zhCN } from './locales';

export const UI_LANGUAGE_STORAGE_KEY = 'oc.uiLanguage';
export const UI_STORE_STORAGE_KEY = 'ui-store';

export type UILanguage = 'system' | 'en' | 'zh-CN';
export type ResolvedLanguage = Exclude<UILanguage, 'system'>;

const SUPPORTED_LANGUAGES: ResolvedLanguage[] = ['en', 'zh-CN'];

const isResolvedLanguage = (value: unknown): value is ResolvedLanguage => {
  return value === 'en' || value === 'zh-CN';
};

export const isUILanguage = (value: unknown): value is UILanguage => {
  return value === 'system' || isResolvedLanguage(value);
};

const detectNavigatorLanguage = (): ResolvedLanguage => {
  if (typeof navigator === 'undefined') {
    return 'en';
  }

  const candidate = navigator.language?.toLowerCase() ?? '';
  if (candidate.startsWith('zh')) {
    return 'zh-CN';
  }

  return 'en';
};

export const resolveUILanguage = (language: UILanguage): ResolvedLanguage => {
  if (language === 'system') {
    return detectNavigatorLanguage();
  }

  return language;
};

export const readPersistedUILanguage = (): UILanguage => {
  if (typeof window === 'undefined') {
    return 'system';
  }

  const rawStore = window.localStorage.getItem(UI_STORE_STORAGE_KEY);
  if (rawStore) {
    const parsedLanguage = parseStoreLanguage(rawStore);
    if (parsedLanguage) {
      return parsedLanguage;
    }
  }

  const direct = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
  if (isUILanguage(direct)) {
    return direct;
  }

  return 'system';
};

const parseStoreLanguage = (rawStore: string): UILanguage | null => {
  try {
    const parsed = JSON.parse(rawStore) as { state?: { uiLanguage?: unknown } };
    return isUILanguage(parsed?.state?.uiLanguage) ? parsed.state.uiLanguage : null;
  } catch {
    return null;
  }
};

export const setDocumentLanguage = (language: ResolvedLanguage): void => {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.lang = language;
};

export const initI18n = async (language: UILanguage = readPersistedUILanguage()): Promise<typeof i18n> => {
  const resolvedLanguage = resolveUILanguage(language);

  if (!i18n.isInitialized) {
    await i18n
      .use(initReactI18next)
      .init({
        resources: {
          en: { translation: en },
          'zh-CN': { translation: zhCN },
        },
        lng: resolvedLanguage,
        fallbackLng: 'en',
        supportedLngs: SUPPORTED_LANGUAGES,
        interpolation: {
          escapeValue: false,
        },
        react: {
          useSuspense: false,
        },
      });
  } else if (i18n.language !== resolvedLanguage) {
    await i18n.changeLanguage(resolvedLanguage);
  }

  setDocumentLanguage(resolvedLanguage);
  return i18n;
};

export const applyUILanguage = async (language: UILanguage): Promise<void> => {
  const resolvedLanguage = resolveUILanguage(language);
  if (!i18n.isInitialized) {
    await initI18n(language);
    return;
  }

  if (i18n.language !== resolvedLanguage) {
    await i18n.changeLanguage(resolvedLanguage);
  }
  setDocumentLanguage(resolvedLanguage);
};

export default i18n;
