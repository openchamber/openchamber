import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './locales/de.json';
import en from './locales/en.json';
import fr from './locales/fr.json';
import ko from './locales/ko.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';

const resources = {
  de: { translation: de },
  en: { translation: en },
  fr: { translation: fr },
  ko: { translation: ko },
  ru: { translation: ru },
  zh: { translation: zh },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
