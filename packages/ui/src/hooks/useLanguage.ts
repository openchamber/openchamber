import { useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { LanguageContext } from '../contexts/language-context';

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  const { t } = useTranslation();

  const value = useMemo(
    () => ({
      language: context.language,
      setLanguage: context.setLanguage,
      t,
    }),
    [context.language, context.setLanguage, t],
  );

  return value;
}
