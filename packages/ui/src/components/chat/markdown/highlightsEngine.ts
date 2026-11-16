import type { Lang } from '@pierre/highlights';
import { LANGUAGE_RELATIVES } from '@/lib/shiki/languageRelatives';
import { MARKDOWN_HIGHLIGHTS_THEME } from '@/lib/shiki/zedThemeFromAppTheme';

type HighlightsModule = typeof import('@pierre/highlights');

/** Code ready for Highlights: the module, the lexer and the text it tokenizes. */
type HighlightsInput = { highlights: HighlightsModule; lang: Lang; code: string };

let loading: Promise<HighlightsModule | null> | undefined;
let loaded: HighlightsModule | null | undefined;

/**
 * Start loading Highlights. The package compiles its WebAssembly at import
 * and needs SIMD, so a failed import means this runtime cannot run it at all
 * and code stays plain text.
 */
export const loadHighlights = (): Promise<HighlightsModule | null> => {
  loading ??= import('@pierre/highlights').catch(() => null).then((module) => {
    loaded = module;
    return module;
  });
  return loading;
};

/**
 * The lexer for a requested language: its own, a close relative's, or plain
 * text. ANSI is plain text: Highlights' ANSI tokens drop the escape sequences
 * and merge the text around them, so they stop matching the source, and every
 * consumer here positions tokens by source offset.
 */
export const highlightsLanguage = (highlights: HighlightsModule, lang: string): Lang => {
  if (lang === 'ansi') return 'text';
  if (highlights.isSupportedLanguage(lang)) return lang;
  const relative = LANGUAGE_RELATIVES.get(lang);
  return relative && highlights.isSupportedLanguage(relative) ? relative : 'text';
};

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CSI sequences (colors, cursor movement), OSC sequences (titles, hyperlinks)
// and the two-character escapes.
const ANSI_ESCAPES = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|[@-Z\\\\^_])`,
  'g',
);

/** Terminal output without its escape sequences. */
export const stripAnsi = (code: string): string => code.replace(ANSI_ESCAPES, '');

/**
 * What Highlights tokenizes for `code` in `lang`: null until the module has
 * loaded, and for good where it cannot run. ANSI output loses its escapes.
 */
export const highlightsNow = (lang: string, code: string): HighlightsInput | null => {
  if (!loaded) return null;
  return { highlights: loaded, lang: highlightsLanguage(loaded, lang), code: lang === 'ansi' ? stripAnsi(code) : code };
};

const utf8 = new TextDecoder();

/** Whole-block `<pre>` HTML colored through the markdown syntax variables. */
export const highlightsBlockHtml = ({ highlights, lang, code }: HighlightsInput): string =>
  // The returned bytes live in WebAssembly memory until the next call.
  utf8.decode(highlights.codeToHtml(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }));

/** Themed tokens colored through the markdown syntax variables. */
export const highlightsTokens = ({ highlights, lang, code }: HighlightsInput) =>
  highlights.codeToTokens(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }).tokens;

type StyledToken = ReturnType<typeof highlightsTokens>[number][number];

// Highlights' FontStyle bitmask.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const tokenSpan = (token: StyledToken): string => {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) styles.push('font-style:italic');
  if (fontStyle & FONT_STYLE_BOLD) styles.push('font-weight:bold');
  if (fontStyle & FONT_STYLE_UNDERLINE) styles.push('text-decoration:underline');
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  return `<span${style}>${escapeHtml(token.content)}</span>`;
};

/** Per-line inner HTML colored through the markdown syntax variables. */
export const highlightsLineHtml = (input: HighlightsInput): string[] =>
  highlightsTokens(input).map((line) => line.map(tokenSpan).join(''));
