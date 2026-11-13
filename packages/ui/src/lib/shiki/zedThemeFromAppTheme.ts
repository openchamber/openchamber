import type { Theme as ZedTheme, ThemeStyle, ThemeSyntaxSettings } from '@pierre/highlights';

import type { Theme } from '@/types/theme';
import { toHexColor } from '../theme/color';
import { resolveSyntaxTokens } from '../theme/syntax';

// Highlights reads Zed themes: one style per token name, where a dotted name
// inherits from its parent (`keyword.control` falls back to `keyword`). This
// table maps every name the Highlights lexers emit to an app syntax role, so
// files, diffs, the editor and chat code all color a token the same way. It
// follows the TextMate rules in `textMateThemeFromAppTheme.ts`, which still
// serve the languages Highlights has no lexer for.

type SyntaxBaseKey = keyof Theme['colors']['syntax']['base'];
type SyntaxTokenKey = keyof ReturnType<typeof resolveSyntaxTokens>;
type SyntaxRole = { base: SyntaxBaseKey } | { token: SyntaxTokenKey } | { diff: 'inserted' | 'deleted' };
type TokenRule = { role?: SyntaxRole; bold?: true; italic?: true };

const base = (key: SyntaxBaseKey): TokenRule => ({ role: { base: key } });
const token = (key: SyntaxTokenKey): TokenRule => ({ role: { token: key } });
const bold = (rule: TokenRule): TokenRule => ({ ...rule, bold: true });

const TOKEN_RULES = {
  attribute: token('tagAttribute'),
  boolean: token('boolean'),
  comment: base('comment'),
  'comment.doc': token('commentDoc'),
  constant: token('constant'),
  'constant.builtin': token('null'),
  constructor: token('className'),
  'diff.minus': { role: { diff: 'deleted' } },
  'diff.plus': { role: { diff: 'inserted' } },
  embedded: base('foreground'),
  emphasis: { italic: true },
  'emphasis.strong': { bold: true },
  enum: token('enum'),
  function: bold(base('function')),
  'function.method': bold(token('method')),
  hint: base('comment'),
  keyword: base('keyword'),
  'keyword.control': token('keywordControl'),
  'keyword.declaration': token('storageModifier'),
  'keyword.import': token('keywordImport'),
  'keyword.jsdoc': base('type'),
  'keyword.operator': token('keywordOperator'),
  label: token('label'),
  link_text: base('string'),
  link_uri: token('url'),
  namespace: token('namespace'),
  number: base('number'),
  operator: base('operator'),
  predictive: base('comment'),
  preproc: token('preprocessor'),
  primary: base('foreground'),
  property: token('variableProperty'),
  'property.json_key': token('key'),
  punctuation: token('punctuation'),
  'punctuation.bracket': token('bracket'),
  'punctuation.bracket.html': token('tagBracket'),
  'punctuation.bracket.jsx': token('tagBracket'),
  'punctuation.delimiter': token('delimiter'),
  'punctuation.delimiter.html': token('tagBracket'),
  'punctuation.delimiter.jsx': token('tagBracket'),
  'punctuation.list_marker': base('type'),
  'punctuation.special': base('keyword'),
  selector: token('tag'),
  'selector.class': token('className'),
  'selector.id': base('function'),
  'selector.pseudo': base('operator'),
  string: base('string'),
  'string.escape': token('stringEscape'),
  'string.regex': token('stringRegex'),
  'string.special': token('stringEscape'),
  'string.special.symbol': token('constant'),
  tag: token('tag'),
  'tag.component.jsx': token('jsxTag'),
  'tag.doctype': base('keyword'),
  'text.jsx': base('foreground'),
  'text.literal': base('string'),
  title: bold(base('keyword')),
  type: base('type'),
  'type.builtin': token('typePrimitive'),
  'type.class': token('className'),
  'type.jsdoc': base('type'),
  variable: base('variable'),
  'variable.jsdoc': token('parameter'),
  'variable.parameter': token('parameter'),
  'variable.special': token('variableBuiltin'),
  variant: token('constant'),
} satisfies Record<string, TokenRule>;

type ZedSyntax = NonNullable<ThemeStyle['syntax']>;

const buildSyntax = (color: (role: SyntaxRole) => string | undefined): ZedSyntax => {
  const syntax: ZedSyntax = {};
  for (const [name, rule] of Object.entries<TokenRule>(TOKEN_RULES)) {
    const settings: ThemeSyntaxSettings = {};
    const value = rule.role ? color(rule.role) : undefined;
    if (value) settings.color = value;
    if (rule.bold) settings.font_weight = 700;
    if (rule.italic) settings.font_style = 'italic';
    syntax[name] = settings;
  }
  return syntax;
};

let colorProbe: CanvasRenderingContext2D | null | undefined;

// Highlights accepts only hex and Display P3 colors and drops anything else.
// A custom theme may author hsl() or oklch(); the canvas converts those where
// a document exists, which is everywhere a file or diff theme is built.
const toThemeColor = (value: string): string | undefined => {
  const hex = toHexColor(value);
  if (hex) return hex;
  if (!('CSS' in globalThis) || !CSS.supports('color', value)) return undefined;
  colorProbe ??= 'document' in globalThis ? document.createElement('canvas').getContext('2d') : null;
  if (!colorProbe) return undefined;
  colorProbe.fillStyle = value;
  return toHexColor(colorProbe.fillStyle) ?? undefined;
};

/** The app theme as a Zed theme with concrete colors, for files, diffs and the editor. */
export function buildZedThemeFromAppTheme(theme: Theme): ZedTheme {
  const syntax = theme.colors.syntax;
  const tokens = resolveSyntaxTokens(syntax);
  const status = theme.colors.status;
  const raw = (role: SyntaxRole): string | undefined => {
    if ('base' in role) return syntax.base[role.base];
    if ('token' in role) return tokens[role.token];
    return role.diff === 'inserted'
      ? syntax.highlights?.diffAdded ?? status.success
      : syntax.highlights?.diffRemoved ?? status.error;
  };
  const color = (role: SyntaxRole) => {
    const value = raw(role);
    return value ? toThemeColor(value) : undefined;
  };

  return {
    name: theme.metadata.id,
    appearance: theme.metadata.variant,
    style: {
      'editor.background': toThemeColor(syntax.base.background),
      'editor.foreground': toThemeColor(syntax.base.foreground),
      syntax: buildSyntax(color),
    },
  };
}

/**
 * Chat code colors through the `--md-syntax-*` and `--md-token-*` variables
 * from `getMarkdownSyntaxVars`, so a theme switch restyles code without
 * tokenizing it again. Unstyled text falls back to the syntax foreground.
 */
export const MARKDOWN_HIGHLIGHTS_THEME: ZedTheme = {
  name: 'openchamber-md',
  appearance: 'dark',
  cssVariables: {
    prefix: '--md-',
    defaults: { foreground: 'var(--md-syntax-foreground)', background: 'transparent' },
  },
  style: {
    syntax: buildSyntax((role) => {
      if ('base' in role) return `syntax-${role.base}`;
      if ('token' in role) return `token-${role.token}`;
      return `syntax-${role.diff}`;
    }),
  },
};
