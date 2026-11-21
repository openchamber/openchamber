import React from 'react';
import { DirectionProvider } from '@base-ui/react/direction-provider';

import { useI18nStore, formatMessage, type I18nKey, type I18nParams } from './store';
import { I18nContext, type I18nContextValue } from './react-context';
import { getLocaleDirection, LOCALE_LABEL_KEYS, LOCALES } from './runtime';
import { invokeDesktop } from '../desktop';

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const locale = useI18nStore((state) => state.locale);
  const dictionary = useI18nStore((state) => state.dictionary);
  const setLocale = useI18nStore((state) => state.setLocale);
  const direction = getLocaleDirection(locale);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
  }, [direction, locale]);

  React.useEffect(() => {
    invokeDesktop('desktop_set_locale', { locale }).catch((error) => {
      console.warn('[i18n] failed to sync locale to desktop shell', error);
    });
    invokeDesktop('desktop_set_tray_locale', { locale }).catch((error) => {
      console.warn('[i18n] failed to sync locale to desktop tray', error);
    });
  }, [locale]);

  const value = React.useMemo<I18nContextValue>(() => {
    const t = (key: I18nKey, params?: I18nParams) => formatMessage(dictionary, key, params);
    return {
      locale,
      direction,
      locales: LOCALES,
      setLocale,
      label: (targetLocale) => t(LOCALE_LABEL_KEYS[targetLocale]),
      t,
    };
  }, [dictionary, direction, locale, setLocale]);

  return (
    <I18nContext.Provider value={value}>
      <DirectionProvider direction={direction}>{children}</DirectionProvider>
    </I18nContext.Provider>
  );
};
