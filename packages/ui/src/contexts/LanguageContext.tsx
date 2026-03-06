import React, { useState, useCallback, useMemo, useEffect } from 'react';
import i18n from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { LanguageContext, type Language } from './language-context';

export type { Language, LanguageContextValue } from './language-context';

interface LanguageProviderProps {
  children: React.ReactNode;
}

export function LanguageProvider({ children }: LanguageProviderProps) {
  const storeLanguage = useUIStore(state => state.language);
  const setStoreLanguage = useUIStore(state => state.setLanguage);
  const [language, setLanguage] = useState<Language>(storeLanguage);

  // Sync i18n on mount and when store language changes
  useEffect(() => {
    i18n.changeLanguage(storeLanguage);
  }, [storeLanguage]);

  const setLanguageHandler = useCallback((newLanguage: Language) => {
    setLanguage(newLanguage);
    setStoreLanguage(newLanguage);
    i18n.changeLanguage(newLanguage);
  }, [setStoreLanguage]);

  const value = useMemo(
    () => ({
      language,
      setLanguage: setLanguageHandler,
    }),
    [language, setLanguageHandler],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}
