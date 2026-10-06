import { z } from 'zod';
import stripJsonComments from 'strip-json-comments';
import { buildVSCodeThemeFromPalette, type VSCodeThemePalette } from './adapter';
import { compactTheme, type ThemeDefinition } from '../definition';
import { mixColor, onColor, readableText } from '../color';
import { MAX_THEME_IMPORT_BYTES, ThemeImportError } from '../importErrors';

const hex = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);
const tokenSettings = z.object({ foreground: hex.optional() });
const tokenRule = z.object({ scope: z.union([z.string(), z.array(z.string())]).optional(), settings: tokenSettings });
const sourceSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  author: z.string().max(160).optional(),
  description: z.string().max(1024).optional(),
  type: z.enum(['light', 'dark', 'hc', 'hc-black', 'hc-light']).optional(),
  include: z.string().optional(),
  colors: z.record(z.string(), hex.nullable()).default({}),
  tokenColors: z.union([z.array(tokenRule), z.string()]).optional(),
  semanticHighlighting: z.boolean().optional(),
  semanticTokenColors: z.record(z.string(), z.union([hex, tokenSettings])).optional(),
});

type TokenRule = z.output<typeof tokenRule>;
type SemanticColors = NonNullable<z.output<typeof sourceSchema>['semanticTokenColors']>;

function scopeEntries(rules: TokenRule[]) {
  return rules.flatMap((rule) => {
    const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope ?? ''];
    return scopes.flatMap((scope) => scope.split(',').map((value) => ({ scope: value.trim(), color: rule.settings.foreground })));
  });
}

/** General TextMate scopes only. A JS-only rule must not color every language. */
function textMateColor(entries: ReturnType<typeof scopeEntries>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    let best: string | undefined;
    let specificity = -1;
    for (const entry of entries) {
      if (!entry.color || !entry.scope) continue;
      if ((candidate === entry.scope || candidate.startsWith(`${entry.scope}.`)) && entry.scope.length >= specificity) {
        best = entry.color;
        specificity = entry.scope.length;
      }
    }
    if (best) return best;
  }
  return undefined;
}

function semanticColor(colors: SemanticColors, candidates: string[]): string | undefined {
  for (const key of candidates.length ? [...candidates, '*'] : candidates) {
    const entry = colors[key];
    if (entry === undefined) continue;
    const parsed = hex.safeParse(entry);
    if (parsed.success) return parsed.data;
    const settings = tokenSettings.safeParse(entry);
    if (settings.success && settings.data.foreground) return settings.data.foreground;
  }
  return undefined;
}

function formatImportedThemeName(name: string): string {
  // Humanize lowercase slugs, keeping authored capitalization and punctuation.
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(name)) return name;
  return name.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function importVSCodeTheme(text: string, filename: string): ThemeDefinition {
  if (new TextEncoder().encode(text).byteLength > MAX_THEME_IMPORT_BYTES) throw new ThemeImportError('size');
  let source: z.output<typeof sourceSchema>;
  try {
    source = sourceSchema.parse(JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''), { trailingCommas: true })));
  } catch {
    throw new ThemeImportError('invalid');
  }
  const rules = z.array(tokenRule).safeParse(source.tokenColors ?? []);
  if (source.include || !rules.success) throw new ThemeImportError('include');

  const colors: Record<string, string> = {};
  for (const [key, color] of Object.entries(source.colors)) {
    if (color !== null) colors[key] = color;
  }
  const authoredBackground = colors['editor.background'];
  if (!authoredBackground) throw new ThemeImportError('background');
  const dark = source.type ? ['dark', 'hc', 'hc-black'].includes(source.type) : onColor(authoredBackground, '#ffffff') === '#ffffff';
  const variant = dark ? 'dark' : 'light';
  const editorBackground = mixColor(authoredBackground, dark ? '#000000' : '#ffffff', 1);
  const entries = scopeEntries(rules.data);
  const defaultTokenColor = rules.data.filter((rule) => !rule.scope && rule.settings.foreground).at(-1)?.settings.foreground;
  const editorForeground = colors['editor.foreground'] ?? defaultTokenColor ?? colors.foreground ?? onColor(editorBackground, editorBackground);
  colors['editor.background'] = editorBackground;
  colors['editor.foreground'] = editorForeground;

  const highContrast = source.type?.startsWith('hc') ?? false;
  if (highContrast && colors.contrastBorder) colors['widget.border'] = colors.contrastBorder;
  const palette: VSCodeThemePalette = { kind: dark && highContrast ? 'high-contrast' : variant, colors, highContrast };
  const mapped = buildVSCodeThemeFromPalette(palette);
  const semantic = source.semanticHighlighting === false ? {} : source.semanticTokenColors ?? {};
  const pick = (semantics: string[], scopes: string[], fallback: string) => semanticColor(semantic, semantics) ?? textMateColor(entries, scopes) ?? fallback;
  const codeForeground = mapped.colors.syntax.base.foreground;
  const base = {
    background: mapped.colors.syntax.base.background,
    foreground: mapped.colors.syntax.base.foreground,
    comment: pick(['comment'], ['comment', 'comment.line', 'comment.block'], readableText(mixColor(editorForeground, editorBackground, 0.6, editorBackground), editorBackground)),
    keyword: pick(['keyword'], ['keyword', 'storage', 'keyword.control', 'storage.type'], codeForeground),
    string: pick(['string'], ['string', 'string.quoted', 'string.template'], codeForeground),
    number: pick(['number'], ['constant.numeric'], codeForeground),
    function: pick(['function'], ['entity.name.function', 'support.function'], codeForeground),
    variable: pick(['variable'], ['variable.other.readwrite', 'variable'], codeForeground),
    type: pick(['type'], ['entity.name.type', 'support.type', 'support.class'], codeForeground),
    operator: pick(['operator'], ['keyword.operator'], codeForeground),
  };
  const className = pick(['class'], ['entity.name.type.class', 'entity.name.class'], base.type);
  const property = pick(['property'], ['variable.other.property', 'support.type.property-name'], base.variable);
  const syntax = {
    base,
    tokens: {
      className,
      interface: pick(['interface'], ['entity.name.type.interface'], base.type),
      enum: pick(['enum'], ['entity.name.type.enum'], className),
      method: pick(['method'], ['entity.name.function.method'], base.function),
      variableProperty: property,
      parameter: pick(['parameter'], ['variable.parameter'], base.variable),
      constant: pick(['variable.readonly', '*.readonly', 'enumMember'], ['variable.other.constant', 'constant.other'], base.number),
      boolean: pick([], ['constant.language.boolean', 'constant.language'], base.number),
      punctuation: pick([], ['punctuation', 'punctuation.separator'], base.operator),
      stringEscape: pick([], ['constant.character.escape'], base.string),
      commentDoc: pick([], ['comment.block.documentation', 'comment.documentation'], base.comment),
      keywordImport: pick([], ['keyword.control.import', 'keyword.import'], base.keyword),
      tag: pick([], ['entity.name.tag'], base.keyword),
      tagAttribute: pick([], ['entity.other.attribute-name'], property),
    },
    highlights: mapped.colors.syntax.highlights,
  };
  const name = formatImportedThemeName(source.name ?? (filename.replace(/\.(jsonc?|code-theme)$/i, '').replace(/[-_]color[-_]theme$/i, '').trim().slice(0, 160) || 'VS Code'));
  return compactTheme({
    metadata: { id: `vscode-import-${variant}`, name, variant, author: source.author, description: source.description ?? '', version: '1.0.0', tags: ['imported', 'vscode'] },
    colors: {
      ...mapped.colors,
      syntax,
    },
  });
}
