import type { Lang } from '@pierre/highlights';
import { LANGUAGE_RELATIVES } from '@/lib/shiki/languageRelatives';
import { MARKDOWN_HIGHLIGHTS_THEME } from '@/lib/shiki/zedThemeFromAppTheme';

type HighlightsModule = typeof import('@pierre/highlights');

type HighlightsInput = { highlights: HighlightsModule; lang: Lang; code: string };

let loading: Promise<HighlightsModule | null> | undefined;
let loaded: HighlightsModule | null | undefined;

export const loadHighlights = (): Promise<HighlightsModule | null> => {
  loading ??= import('@pierre/highlights').catch(() => null).then((module) => {
    loaded = module;
    return module;
  });
  return loading;
};

export const highlightsLanguage = (highlights: HighlightsModule, lang: string): Lang => {
  if (lang === 'ansi') return 'text';
  if (highlights.isSupportedLanguage(lang)) return lang;
  const relative = LANGUAGE_RELATIVES.get(lang);
  return relative && highlights.isSupportedLanguage(relative) ? relative : 'text';
};

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_ESCAPES = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|[@-Z\\\\^_])`,
  'g',
);

export const stripAnsi = (code: string): string => code.replace(ANSI_ESCAPES, '');

export const highlightsNow = (lang: string, code: string): HighlightsInput | null => {
  if (!loaded) return null;
  return { highlights: loaded, lang: highlightsLanguage(loaded, lang), code: lang === 'ansi' ? stripAnsi(code) : code };
};

const utf8 = new TextDecoder();

export const highlightsBlockHtml = ({ highlights, lang, code }: HighlightsInput): string =>
  // external: https://www.npmjs.com/package/@pierre/highlights Returned HTML bytes occupy WebAssembly memory until the next call and must be decoded immediately.
  utf8.decode(highlights.codeToHtml(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }));

export const highlightsTokens = ({ highlights, lang, code }: HighlightsInput) =>
  highlights.codeToTokens(code, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }).tokens;

type StyledToken = ReturnType<typeof highlightsTokens>[number][number];

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

export const highlightsLineHtml = (input: HighlightsInput): string[] =>
  highlightsTokens(input).map((line) => line.map(tokenSpan).join(''));
