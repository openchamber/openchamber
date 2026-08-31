import { describe, expect, test } from 'bun:test';
import { bundledLanguages, type BundledLanguage, type LanguageRegistration } from 'shiki';

import { hasCatastrophicTemplateCall, sanitizeTemplateCallGrammar } from './sanitizeTemplateCallGrammar';

type BundledLanguageModule = { default: LanguageRegistration[] };

const loadBundledGrammars = async (id: BundledLanguage): Promise<LanguageRegistration[]> => {
  // SAFETY: `id` is a Shiki bundled-language key and every bundled language
  // module default-exports its grammar array.
  const mod = (await bundledLanguages[id]()) as BundledLanguageModule;
  return mod.default;
};

describe('sanitizeTemplateCallGrammar', () => {
  test('detects template-call on bundled JS/TS grammars', async () => {
    for (const id of ['javascript', 'typescript', 'jsx', 'tsx'] as const) {
      const [grammar] = await loadBundledGrammars(id);
      expect(hasCatastrophicTemplateCall(grammar)).toBe(true);
    }
  });

  test('a bundled alias request yields sanitized grammars too', async () => {
    // `js` is a separate key in bundledLanguages resolving to the same grammar
    // module; the worker sanitizes whatever id was requested, so the alias must
    // come out clean as well.
    const grammars = await loadBundledGrammars('js');
    const patched = grammars.map((grammar) => sanitizeTemplateCallGrammar(grammar));

    expect(grammars.some((grammar) => hasCatastrophicTemplateCall(grammar))).toBe(true);
    expect(patched.some((grammar) => hasCatastrophicTemplateCall(grammar))).toBe(false);
  });

  test('an embedding grammar carries JS/TS entries that are sanitized as well', async () => {
    // `vue` ships the JS/TS grammars alongside its own, so gating on the
    // requested id alone would leave them unpatched.
    const grammars = await loadBundledGrammars('vue');
    const affected = grammars.filter((grammar) => hasCatastrophicTemplateCall(grammar));

    expect(affected.length).toBeGreaterThan(0);
    const patched = grammars.map((grammar) => sanitizeTemplateCallGrammar(grammar));
    expect(patched.some((grammar) => hasCatastrophicTemplateCall(grammar))).toBe(false);
  });

  test('clears template-call patterns without dropping the repository key', async () => {
    const [grammar] = await loadBundledGrammars('javascript');
    const patched = sanitizeTemplateCallGrammar(grammar);

    expect(hasCatastrophicTemplateCall(patched)).toBe(false);
    expect(patched.repository?.['template-call']).toEqual({ patterns: [] });
    // Original left intact (spread, not mutate-in-place).
    expect(hasCatastrophicTemplateCall(grammar)).toBe(true);
  });

  test('is a no-op when template-call is already empty', () => {
    const grammar = {
      name: 'javascript',
      scopeName: 'source.js',
      patterns: [],
      repository: { 'template-call': { patterns: [] } },
    } satisfies LanguageRegistration;
    expect(sanitizeTemplateCallGrammar(grammar)).toBe(grammar);
  });
});
