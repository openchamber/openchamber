import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { normalizeLanguage, __testing } from './languages.js';

// The languages a walkthrough may be written in have to agree with the locales
// the interface ships, because the picker offers exactly those and the server
// decides what the prompt asks for. The two lists cannot be one list — the
// server cannot import from `packages/ui` — so they are compared here instead.
//
// This exists because German was added to the interface and not here. Nothing
// broke loudly: the picker offered Deutsch, `normalizeLanguage` quietly resolved
// it to English, and a German user paid for a walkthrough written in English
// while the picker still said Deutsch. A drift this quiet needs a test, not
// vigilance.
const RUNTIME_TS = fileURLToPath(new URL('../../../../ui/src/lib/i18n/runtime.ts', import.meta.url));

const interfaceLocales = () => {
  const source = fs.readFileSync(RUNTIME_TS, 'utf8');
  const match = source.match(/export const LOCALES = \[([^\]]*)\]/);
  if (!match) throw new Error(`Could not find LOCALES in ${RUNTIME_TS}`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
};

describe('supported languages', () => {
  it('covers every locale the interface offers', () => {
    const missing = interfaceLocales().filter((locale) => !Object.hasOwn(__testing.LANGUAGE_NAMES, locale));

    expect(missing, `add these to LANGUAGE_NAMES in languages.js: ${missing.join(', ')}`).toEqual([]);
  });

  it('offers nothing the interface cannot label', () => {
    const locales = new Set(interfaceLocales());
    const extra = Object.keys(__testing.LANGUAGE_NAMES).filter((tag) => !locales.has(tag));

    // A language here that the interface does not know is not harmful, but it
    // is unreachable: the picker is built from the interface list.
    expect(extra, `unreachable from the picker: ${extra.join(', ')}`).toEqual([]);
  });

  it('resolves every interface locale to itself rather than to the default', () => {
    for (const locale of interfaceLocales()) {
      expect(normalizeLanguage(locale)).toBe(locale);
    }
  });

  it('names every supported language in English, for the prompt', () => {
    for (const [tag, name] of Object.entries(__testing.LANGUAGE_NAMES)) {
      expect(name, tag).toMatch(/^[A-Z][A-Za-z ]+$/);
    }
  });
});
