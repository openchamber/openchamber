import React from 'react';

export type Language = 'en' | 'zh';

export interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
}

export const LanguageContext = React.createContext<LanguageContextValue | undefined>(undefined);
