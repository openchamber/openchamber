import { describe, expect, test } from 'bun:test';
import { bundledLanguages, createHighlighter, type LanguageRegistration } from 'shiki';

import {
  hasCatastrophicTemplateCall,
  isTemplateCallLanguageId,
  sanitizeTemplateCallGrammar,
  TEMPLATE_CALL_LANGUAGE_IDS,
} from './sanitizeTemplateCallGrammar';

type BundledLanguageModule = { default: LanguageRegistration[] };

const loadBundledGrammar = async (id: (typeof TEMPLATE_CALL_LANGUAGE_IDS)[number]): Promise<LanguageRegistration> => {
  const mod = (await bundledLanguages[id]()) as BundledLanguageModule;
  return mod.default[0];
};

describe('sanitizeTemplateCallGrammar', () => {
  test('detects template-call on bundled JS/TS grammars', async () => {
    for (const id of TEMPLATE_CALL_LANGUAGE_IDS) {
      const grammar = await loadBundledGrammar(id);
      expect(isTemplateCallLanguageId(id)).toBe(true);
      expect(hasCatastrophicTemplateCall(grammar)).toBe(true);
    }
  });

  test('clears template-call patterns without dropping the repository key', async () => {
    const grammar = await loadBundledGrammar('javascript');
    const patched = sanitizeTemplateCallGrammar(grammar);

    expect(hasCatastrophicTemplateCall(patched)).toBe(false);
    expect(patched.repository?.['template-call']).toEqual({ patterns: [] });
    // Original left intact (structured clone / spread, not mutate-in-place).
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

  test('highlights template-literal fixtures within a tight budget after sanitize', async () => {
    const mod = (await bundledLanguages.javascript()) as BundledLanguageModule;
    const patched = mod.default.map((grammar) => sanitizeTemplateCallGrammar(grammar));

    const highlighter = await createHighlighter({
      themes: ['github-dark'],
      langs: patched,
    });

    // Representative content from openchamber/openchamber#2587, scaled to ~14KB.
    const fixture = `const snapshot = { source: \`\${session.source}\`, fetchedAt: \`\${Date.now()}\` };
const label = \`Account \${index + 1}\`;
function render(account) {
  return html\`<div class="\${account.cls}">\${account.name}</div>\`;
}
`.repeat(80);

    expect(fixture.length).toBeGreaterThan(10_000);

    const started = performance.now();
    const html = highlighter.codeToHtml(fixture, { lang: 'javascript', theme: 'github-dark' });
    const elapsedMs = performance.now() - started;
    highlighter.dispose();

    expect(html.length).toBeGreaterThan(0);
    // Catastrophic backtracking hangs for seconds–minutes; healthy tokenize is well under 1s.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});