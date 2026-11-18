import type { ModelJson } from './schema.js';

export const DEFAULT_LANGUAGE = 'en';

const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  nl: 'Dutch',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  uk: 'Ukrainian',
  es: 'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  ko: 'Korean',
  pl: 'Polish',
  ja: 'Japanese',
  tr: 'Turkish',
  ar: 'Arabic',
  he: 'Hebrew',
};

const isLanguageTag = (value: unknown): value is string => typeof value === 'string';
export type Language = keyof typeof LANGUAGE_NAMES;
const isSupportedLanguage = (value: string): value is Language => Object.hasOwn(LANGUAGE_NAMES, value);

export function normalizeLanguage(value: ModelJson | undefined): Language {
  if (!isLanguageTag(value) || !value) return DEFAULT_LANGUAGE;
  if (isSupportedLanguage(value)) return value;

  const normalized = value.toLowerCase().replace(/_/g, '-');
  const match = Object.keys(LANGUAGE_NAMES).filter(isSupportedLanguage).find((tag) => {
    const lower = tag.toLowerCase();
    return lower === normalized || normalized.startsWith(`${lower}-`);
  });
  if (match) return match;

  const base = normalized.split('-')[0];
  const baseMatch = Object.keys(LANGUAGE_NAMES).filter(isSupportedLanguage).find((tag) => tag.toLowerCase() === base);
  return baseMatch ?? DEFAULT_LANGUAGE;
}

export function languageName(language: Language) {
  return LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES[DEFAULT_LANGUAGE];
}

export const __testing = { LANGUAGE_NAMES };
