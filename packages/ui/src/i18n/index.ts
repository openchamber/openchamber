import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en'
import zhCN from './locales/zh-CN'

const getStoredLanguage = (): string => {
  if (typeof window === 'undefined') {
    return 'en'
  }

  try {
    const raw = window.localStorage.getItem('ui-store')
    if (!raw) {
      return 'en'
    }

    const parsed = JSON.parse(raw) as {
      state?: {
        language?: unknown
      }
    }

    return typeof parsed.state?.language === 'string' && parsed.state.language
      ? parsed.state.language
      : 'en'
  } catch {
    return 'en'
  }
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
    },
    lng: getStoredLanguage(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  })

export default i18n
