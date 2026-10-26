import { buildSyntaxTokenRules } from '@/lib/shiki/textMateThemeFromAppTheme';
import { resolveSyntaxTokens } from '@/lib/theme/syntax';

export const MARKDOWN_SHIKI_THEME = 'openchamber-md';

// The worker shares the file/diff grammar mapping. Only CSS variables change
// when a theme changes, so streamed code does not need to be tokenized again.
const base = {
  background: 'transparent',
  foreground: 'var(--md-syntax-foreground)',
  comment: 'var(--md-syntax-comment)',
  keyword: 'var(--md-syntax-keyword)',
  string: 'var(--md-syntax-string)',
  number: 'var(--md-syntax-number)',
  function: 'var(--md-syntax-function)',
  variable: 'var(--md-syntax-variable)',
  type: 'var(--md-syntax-type)',
  operator: 'var(--md-syntax-operator)',
};
const tokens = Object.fromEntries(Object.keys(resolveSyntaxTokens({ base })).map((key) => [key, `var(--md-token-${key})`]));

export const MARKDOWN_SHIKI_THEME_DEFINITION = {
  name: MARKDOWN_SHIKI_THEME,
  colors: { 'editor.background': 'transparent', 'editor.foreground': base.foreground },
  tokenColors: [
    ...buildSyntaxTokenRules({ base, tokens }),
    { scope: ['markup.bold', 'punctuation.definition.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic', 'punctuation.definition.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.heading', 'markup.heading entity.name'], settings: { foreground: base.keyword, fontStyle: 'bold' } },
    { scope: ['markup.inserted', 'punctuation.definition.inserted'], settings: { foreground: 'var(--md-syntax-inserted)' } },
    { scope: ['markup.deleted', 'punctuation.definition.deleted', 'invalid', 'invalid.illegal'], settings: { foreground: 'var(--md-syntax-deleted)' } },
  ],
};
