import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en, vi } from './locales';
import './types';

const getPersistedLanguage = (): string => {
  try {
    const raw = localStorage.getItem('openchamber-ui-store');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.state?.language && typeof parsed.state.language === 'string') {
        return parsed.state.language;
      }
    }
  } catch {
    return 'en';
  }
  return 'en';
};

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      vi: { translation: vi },
    },
    lng: getPersistedLanguage(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

export default i18n;
