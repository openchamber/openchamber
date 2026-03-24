import React from 'react';

export type Language = 'en' | 'zh' | 'fr' | 'de' | 'ko' | 'ru';

export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: Language; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ko', label: '한국어' },
  { value: 'ru', label: 'Русский' },
];

export interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
}

export const LanguageContext = React.createContext<LanguageContextValue | undefined>(undefined);
