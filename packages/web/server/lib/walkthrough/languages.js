// Language the walkthrough prose is written in.
//
// This is the server's own list rather than an import from the UI package: the
// server cannot reach `packages/ui`, and the two lists answer different
// questions anyway. The UI list is "which locales do we have a dictionary
// for"; this one is "which languages may we ask a model to write in", and it
// needs the English endonym-free name that goes into the prompt.
//
// The tags match the UI's `Locale` union so the picker can pass its own value
// straight through. A tag we do not know resolves to English, which is exactly
// what the feature did before the setting existed.

export const DEFAULT_LANGUAGE = 'en';

// Value is what the prompt says to write in. Naming the language in English
// keeps the instruction in the same language as the rest of the system prompt,
// which every model handles more reliably than a switch mid-sentence.
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  uk: 'Ukrainian',
  es: 'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  ko: 'Korean',
  pl: 'Polish',
  ja: 'Japanese',
};

/**
 * Coerce a caller-supplied tag to one we support.
 *
 * Unknown, absent, and malformed all collapse to English rather than failing
 * the request: the language is a preference about prose, and refusing to
 * generate a walkthrough over one is a worse answer than writing it in English.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string' || !value) return DEFAULT_LANGUAGE;
  if (Object.hasOwn(LANGUAGE_NAMES, value)) return value;

  // Tolerate case and separator drift (`uk-UA`, `pt_br`) so a runtime that
  // passes a platform locale does not silently fall back to English.
  const normalized = value.toLowerCase().replace(/_/g, '-');
  const match = Object.keys(LANGUAGE_NAMES).find((tag) => {
    const lower = tag.toLowerCase();
    return lower === normalized || normalized.startsWith(`${lower}-`);
  });
  if (match) return match;

  const base = normalized.split('-')[0];
  const baseMatch = Object.keys(LANGUAGE_NAMES).find((tag) => tag.toLowerCase() === base);
  return baseMatch ?? DEFAULT_LANGUAGE;
}

/** English name of a normalized tag, for the prompt. */
export function languageName(language) {
  return LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES[DEFAULT_LANGUAGE];
}

// The tags this list must agree with live in `packages/ui/src/lib/i18n`, which
// the server cannot import. `languages.test.js` compares the two by reading
// that file, because a locale added on one side only fails silently: the picker
// offers the language and the walkthrough comes back in English.
export const __testing = { LANGUAGE_NAMES };
