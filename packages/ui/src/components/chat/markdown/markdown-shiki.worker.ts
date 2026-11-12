/// <reference lib="webworker" />

import { bundledLanguages, createHighlighter, hastToHtml, type BundledLanguage, type LanguageRegistration } from 'shiki';
import { sanitizeTemplateCallGrammar } from '../../../lib/shiki/sanitizeTemplateCallGrammar';
import { highlightsBlockHtml, highlightsLineHtml, resolveHighlights, tokenSpan } from './highlightsEngine';
import { createIncrementalCodeHighlighter } from './incrementalCodeHighlight';
import { MARKDOWN_SHIKI_THEME, MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';
import type { CodeTokenTheme, MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';

// Highlights tokenizes every language it has a lexer for. Shiki stays for the
// rest (ini, erb, twig and other grammars Highlights does not ship), and for
// runtimes where Highlights' WebAssembly cannot start.

type StyledToken = { content: string; color?: string; fontStyle?: number };

// CodeMirror themes arrive once per name, so both formats are kept: the
// first request may go to Highlights and a later one to Shiki.
const tokenThemes = new Map<string, CodeTokenTheme>();

// Single shared Shiki highlighter for the worker. Languages load lazily on demand.
let highlighter: ReturnType<typeof createHighlighter> | undefined;

// Serialize work so language loading / tokenization never overlaps.
let queue = Promise.resolve();

const ensureHighlighter = (): ReturnType<typeof createHighlighter> => {
  highlighter ??= createHighlighter({
    // Cast: the theme is a CSS-variable TextMate theme; Shiki accepts the shape.
    themes: [MARKDOWN_SHIKI_THEME_DEFINITION as unknown as Parameters<typeof createHighlighter>[0]['themes'][number]],
    langs: [],
  });
  return highlighter;
};

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    // Warm Highlights only; Shiki starts on the first language it alone knows.
    void resolveHighlights('text');
    return;
  }
  if (request.type === 'highlight') {
    queue = queue.then(() => highlight(request)).catch(() => {});
    return;
  }
  if (request.type === 'highlightTokens') {
    queue = queue.then(() => highlightTokens(request)).catch(() => {});
    return;
  }
  queue = queue.then(() => highlightLines(request)).catch(() => {});
};

type Instance = Awaited<ReturnType<typeof createHighlighter>>;

type BundledLanguageModule = { default: LanguageRegistration[] };

/**
 * Load a language, neutralizing the catastrophic JS/TS `template-call` rule
 * before it reaches the Oniguruma scanner (see sanitizeTemplateCallGrammar).
 *
 * Every bundled language is resolved and sanitized rather than a fixed id
 * list: Shiki keys the JS/TS grammars under aliases too (`js`, `ts`, `cjs`,
 * `mjs`, `mts`, `cts`), and embedding grammars (`vue`, `svelte`, `mdx`,
 * `astro`, `html`) ship them as extra entries in their own module. Sanitizing
 * every entry is free for the rest — `hasCatastrophicTemplateCall` returns the
 * grammar untouched when the rule is absent.
 */
const loadLanguageSafe = async (instance: Instance, lang: BundledLanguage): Promise<void> => {
  // SAFETY: every Shiki bundled-language module default-exports its grammar
  // array; `lang` is narrowed to a bundled id by the caller.
  const mod = (await bundledLanguages[lang]()) as BundledLanguageModule;
  const grammars = mod.default.map((grammar) => sanitizeTemplateCallGrammar(grammar));
  await instance.loadLanguage(...grammars);
};

const resolveLanguage = async (instance: Instance, requested: string): Promise<string> => {
  let lang = requested in bundledLanguages ? requested : 'text';
  if (lang !== 'text' && !instance.getLoadedLanguages().includes(lang)) {
    try {
      await loadLanguageSafe(instance, lang as BundledLanguage);
    } catch {
      lang = 'text';
    }
  }
  return lang;
};

// Related code views can share a highlighted prefix. The bounded grammar state
// lives in this worker; after a restart the next block starts with a full pass.
let incrementalInstance: Instance | undefined;
let incremental: ReturnType<typeof createIncrementalCodeHighlighter> | undefined;

const incrementalFor = (instance: Instance): ReturnType<typeof createIncrementalCodeHighlighter> => {
  if (incremental && incrementalInstance === instance) return incremental;
  incrementalInstance = instance;
  incremental = createIncrementalCodeHighlighter({
    render: (chunk, lang, grammarState) => {
      const hast = instance.codeToHast(chunk, { lang, theme: MARKDOWN_SHIKI_THEME, tabindex: false, grammarState });
      return { html: hastToHtml(hast), grammarState: instance.getLastGrammarState(hast) };
    },
  });
  return incremental;
};

async function highlight(request: Extract<MarkdownWorkerRequest, { type: 'highlight' }>): Promise<void> {
  try {
    const target = await resolveHighlights(request.lang);
    if (target) {
      post({ type: 'highlight', id: request.id, html: highlightsBlockHtml(target, request.code) });
      return;
    }
    const instance = await ensureHighlighter();
    const lang = await resolveLanguage(instance, request.lang);
    const html = (request.fullPass ? null : incrementalFor(instance).highlight(request.code, lang))
      ?? instance.codeToHtml(request.code, {
        lang,
        theme: MARKDOWN_SHIKI_THEME,
        tabindex: false,
      });
    post({ type: 'highlight', id: request.id, html });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

const toTokenRuns = (tokens: StyledToken[][]): Extract<MarkdownWorkerResponse, { type: 'highlightTokens' }>['lines'] =>
  tokens.map((line) => line.map((token) => [token.content.length, token.color ?? '', token.fontStyle ?? 0]));

async function highlightTokens(request: Extract<MarkdownWorkerRequest, { type: 'highlightTokens' }>): Promise<void> {
  try {
    if (request.theme) tokenThemes.set(request.themeName, request.theme);
    const theme = tokenThemes.get(request.themeName);
    const target = await resolveHighlights(request.lang);
    if (target && theme) {
      const { tokens } = target.highlights.codeToTokens(request.code, { lang: target.lang, theme: theme.zed });
      post({ type: 'highlightTokens', id: request.id, lines: toTokenRuns(tokens) });
      return;
    }
    const instance = await ensureHighlighter();
    if (theme && !instance.getLoadedThemes().includes(request.themeName)) {
      // Cast: a resolved TextMate theme object from the app theme registry.
      await instance.loadTheme(theme.textmate as Parameters<typeof instance.loadTheme>[0]);
    }
    const lang = await resolveLanguage(instance, request.lang);
    const { tokens } = instance.codeToTokens(request.code, {
      lang: lang as BundledLanguage,
      theme: request.themeName,
    });
    post({ type: 'highlightTokens', id: request.id, lines: toTokenRuns(tokens) });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function highlightLines(request: Extract<MarkdownWorkerRequest, { type: 'highlightLines' }>): Promise<void> {
  try {
    const target = await resolveHighlights(request.lang);
    if (target) {
      post({ type: 'highlightLines', id: request.id, lines: highlightsLineHtml(target, request.code) });
      return;
    }
    const instance = await ensureHighlighter();
    const lang = await resolveLanguage(instance, request.lang);
    const { tokens } = instance.codeToTokens(request.code, {
      lang: lang as BundledLanguage,
      theme: MARKDOWN_SHIKI_THEME,
    });
    const lines = tokens.map((line) => line.map(tokenSpan).join(''));
    post({ type: 'highlightLines', id: request.id, lines });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

function post(response: MarkdownWorkerResponse): void {
  self.postMessage(response);
}
