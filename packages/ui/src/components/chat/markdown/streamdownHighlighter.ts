import { bundledLanguages, createHighlighterCore, createOnigurumaEngine, type GrammarState, type ThemedToken } from 'shiki';
import { sanitizeTemplateCallGrammar } from '@/lib/shiki/sanitizeTemplateCallGrammar';
import { highlightsTokens, resolveHighlights } from './highlightsEngine';
import { MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';

type Lineage = { language: string; source: string; tokens: ThemedToken[][]; state: GrammarState | undefined };

/**
 * Worker-local highlighter. Highlights tokenizes the languages it has a lexer
 * for in one pass over the whole block, fast enough that a streaming fence
 * needs no carried state. Other languages use Oniguruma, where only complete
 * lines retain grammar state.
 */
export function createStreamdownHighlighter() {
  let pending: ReturnType<typeof createHighlighterCore> | undefined;
  let lineages: Lineage[] = [];
  const loaders = new Map(Object.entries(bundledLanguages));

  return async (code: string, language: string, fullPass = false): Promise<ThemedToken[][]> => {
    const target = await resolveHighlights(language);
    if (target) return highlightsTokens(target, code);
    pending ??= createHighlighterCore({
      themes: [MARKDOWN_SHIKI_THEME_DEFINITION], langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    })
      .catch((error) => { pending = undefined; throw error; });
    const highlighter = await pending;
    const load = loaders.get(language);
    let lang = load ? language : 'text';
    if (load && !highlighter.getLoadedLanguages().includes(language)) {
      try {
        const grammar = await load();
        await highlighter.loadLanguage(...grammar.default.map(sanitizeTemplateCallGrammar));
      } catch {
        lang = 'text';
      }
    }
    const render = (source: string, state?: GrammarState) => highlighter.codeToTokensBase(source, {
      lang, theme: MARKDOWN_SHIKI_THEME_DEFINITION, grammarState: state,
    });
    // CRLF uses a whole pass to preserve Shiki's original UTF-16 offsets.
    if (fullPass || code.includes('\r') || code.length > 256 * 1024) return render(code);
    const stable = code.slice(0, code.lastIndexOf('\n') + 1);
    let previous: Lineage | undefined;
    for (const entry of lineages) {
      if (entry.language === lang && (!previous || entry.source.length > previous.source.length)
        && stable.startsWith(entry.source)) previous = entry;
    }
    let tokens = previous?.tokens ?? [];
    let state: GrammarState | undefined = previous?.state;
    const offset = previous?.source.length ?? 0;
    if (stable.length > offset) {
      const added = render(stable.slice(offset, -1), state);
      state = highlighter.getLastGrammarState(added);
      if (!state && lang !== 'text') return render(code);
      tokens = tokens.concat(added.map((line) => line.map((token) => ({ ...token, offset: token.offset + offset }))));
    }
    const tail = render(code.slice(stable.length), state);
    if (stable) {
      const entry = { language: lang, source: stable, tokens, state };
      lineages = [entry, ...lineages.filter((item) => item !== previous)].slice(0, 8);
    }
    return tokens.concat(tail.map((line) => line.map((token) => ({ ...token, offset: token.offset + stable.length }))));
  };
}
