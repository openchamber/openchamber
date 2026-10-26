import type { Lang } from '@pierre/highlights';
import { MARKDOWN_HIGHLIGHTS_THEME } from '@/lib/shiki/zedThemeFromAppTheme';

type HighlightsModule = typeof import('@pierre/highlights');

type HighlightsTarget = { highlights: HighlightsModule; lang: Lang };

let loading: Promise<HighlightsModule | null> | undefined;
let loaded: HighlightsModule | null | undefined;

/**
 * Start loading Highlights. The package compiles its WebAssembly at import
 * and needs SIMD, so a failed import means this runtime cannot run it at all.
 */
export const loadHighlights = (): Promise<HighlightsModule | null> => {
  loading ??= import('@pierre/highlights').catch(() => null).then((module) => {
    loaded = module;
    return module;
  });
  return loading;
};

/** Whether the Highlights import has finished, successfully or not. */
export const highlightsSettled = (): boolean => loaded !== undefined;

/** Highlights for a language it has a lexer for, once loaded; null keeps Shiki. */
export const highlightsNow = (lang: string): HighlightsTarget | null => {
  if (!loaded || !loaded.isSupportedLanguage(lang)) return null;
  return { highlights: loaded, lang };
};

/** Like `highlightsNow`, waiting for the module first. */
export const resolveHighlights = async (lang: string): Promise<HighlightsTarget | null> => {
  await loadHighlights();
  return highlightsNow(lang);
};

type StyledToken = { content: string; color?: string; fontStyle?: number };

// Shiki FontStyle bitmask, which Highlights tokens share.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** One token as an inline-styled span, for per-line HTML. */
export const tokenSpan = (token: StyledToken): string => {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) styles.push('font-style:italic');
  if (fontStyle & FONT_STYLE_BOLD) styles.push('font-weight:bold');
  if (fontStyle & FONT_STYLE_UNDERLINE) styles.push('text-decoration:underline');
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  return `<span${style}>${escapeHtml(token.content)}</span>`;
};

const utf8 = new TextDecoder();

/** Whole-block `<pre>` HTML colored through the markdown syntax variables. */
export const highlightsBlockHtml = ({ highlights, lang }: HighlightsTarget, code: string): string =>
  // The returned bytes live in WebAssembly memory until the next call.
  utf8.decode(highlights.codeToHtml(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }));

/** Per-line inner HTML colored through the markdown syntax variables. */
export const highlightsLineHtml = ({ highlights, lang }: HighlightsTarget, code: string): string[] =>
  highlights.codeToTokens(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }).tokens.map((line) => line.map(tokenSpan).join(''));

/** Themed tokens colored through the markdown syntax variables. */
export const highlightsTokens = ({ highlights, lang }: HighlightsTarget, code: string) =>
  highlights.codeToTokens(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }).tokens;
