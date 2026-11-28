import { z } from 'zod';
import type { Theme } from '../../types/theme';
import { mixColor, onColor, opaqueColor, readableText, withOpacity } from './color';
import { resolveSyntaxTokens } from './syntax';
import { isThemeBackground } from './transparency';
import { componentColors } from './componentColors';

const COLOR_PATTERN = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\([\w#.,%\s/+()-]*\))$/i;
const LOADS_RESOURCE = /\b(?:url|image|image-set|cross-fade|element)\s*\(|@import/i;
const text = z.string().trim().min(1);
const color = text.refine((value) => COLOR_PATTERN.test(value) && !LOADS_RESOURCE.test(value), 'Expected a CSS colour');
const foreground = color.transform(opaqueColor);
const cssValue = z.string().refine((value) => !/[;{}<>\\]/.test(value) && !LOADS_RESOURCE.test(value), 'Unsupported CSS value');
const optionalColors = (keys: string[]) => z.record(z.string(), color).transform((values) => Object.fromEntries(Object.entries(values)
  .filter(([key]) => keys.includes(key))
  .map(([key, value]) => [key, key.endsWith('Background') || key === 'background' || /Border$|^divider$|^hr$/.test(key) ? value : opaqueColor(value)])));
const primary = z.object({ base: foreground, foreground: foreground.optional(), hover: color.optional(), active: color.optional(), muted: color.optional() });
const surface = z.object({ background: color, foreground, muted: color, mutedForeground: foreground, elevated: color, elevatedForeground: foreground.optional(), overlay: color.optional(), subtle: color.optional() });
const interactive = z.object({ border: color, selection: color.optional(), selectionForeground: foreground.optional(), borderHover: color.optional(), borderFocus: color.optional(), focus: color.optional(), focusRing: color.optional(), cursor: foreground.optional(), hover: color.optional(), active: color.optional() });
const status = z.object({
  error: foreground, errorForeground: foreground.optional(), errorBackground: color.optional(), errorBorder: color.optional(),
  warning: foreground, warningForeground: foreground.optional(), warningBackground: color.optional(), warningBorder: color.optional(),
  success: foreground, successForeground: foreground.optional(), successBackground: color.optional(), successBorder: color.optional(),
  info: foreground, infoForeground: foreground.optional(), infoBackground: color.optional(), infoBorder: color.optional(),
});
const syntax = z.object({
  base: z.object({ background: color.optional(), foreground: foreground.optional(), comment: foreground, keyword: foreground, string: foreground, number: foreground, function: foreground, variable: foreground, type: foreground, operator: foreground }),
  tokens: z.record(z.string(), foreground).optional(),
  highlights: z.record(z.string(), color).transform((values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, isThemeBackground(key) ? value : opaqueColor(value)]))).optional(),
});
const themeMetadata = z.object({ id: text, name: text, variant: z.enum(['light', 'dark']), description: z.string().default(''), version: z.string().default('1.0.0'), author: z.string().optional(), tags: z.array(z.string()).default([]) });
const definition = z.object({
  metadata: themeMetadata,
  colors: z.object({
    primary, surface, interactive, status, syntax,
    pr: z.object({ open: foreground.optional(), draft: foreground.optional(), blocked: foreground.optional(), merged: foreground.optional(), closed: foreground.optional() }).optional(),
    chat: optionalColors(['background', 'userMessageBackground', 'divider']).optional(),
    markdown: optionalColors(['link', 'linkHover', 'inlineCode', 'inlineCodeBackground', 'blockquote', 'blockquoteBorder', 'listMarker', 'bold', 'italic', 'strikethrough', 'hr']).optional(),
    tools: z.object({ border: color.optional(), icon: foreground.optional(), title: foreground.optional(), description: foreground.optional(), edit: optionalColors(['addedBackground', 'removedBackground', 'modifiedBackground', 'lineNumber']).optional() }).optional(),
  }),
  config: z.object({ fonts: z.object({ sans: cssValue.optional(), mono: cssValue.optional(), heading: cssValue.optional() }).optional(), transitions: z.object({ fast: cssValue.optional(), normal: cssValue.optional(), slow: cssValue.optional() }).optional(), backgroundOpacity: z.number().gt(0).lte(1).optional() }).optional(),
});

export type ThemeDefinition = z.input<typeof definition>;

function resolveTheme(source: z.output<typeof definition>): Theme {
  const { metadata, colors: c, config } = source;
  const neutral = metadata.variant === 'dark' ? '#ffffff' : '#000000';
  const p = c.primary.base;
  const s = { ...c.surface, elevatedForeground: c.surface.elevatedForeground ?? c.surface.foreground, overlay: c.surface.overlay ?? withOpacity('#000000', 0.6), subtle: c.surface.subtle ?? c.surface.muted };
  const selection = c.interactive.selection ?? withOpacity(s.foreground, 0.16);
  const base = { ...c.syntax.base, background: c.syntax.base.background ?? s.background, foreground: c.syntax.base.foreground ?? s.foreground };
  const statusFamily = (name: 'error' | 'warning' | 'success' | 'info') => ({
    base: c.status[name],
    foreground: c.status[`${name}Foreground`] ?? onColor(c.status[name], s.background),
    background: c.status[`${name}Background`] ?? withOpacity(c.status[name], 0.125),
    border: c.status[`${name}Border`] ?? withOpacity(c.status[name], 0.314),
  });
  const error = statusFamily('error'), warning = statusFamily('warning'), success = statusFamily('success'), info = statusFamily('info');
  const diffAdded = c.syntax.highlights?.diffAdded ?? success.base;
  const diffRemoved = c.syntax.highlights?.diffRemoved ?? error.base;
  const diffModified = c.syntax.highlights?.diffModified ?? info.base;
  const highlights = {
    diffAdded, diffAddedBackground: withOpacity(diffAdded, 0.125),
    diffRemoved, diffRemovedBackground: withOpacity(diffRemoved, 0.125),
    diffModified, diffModifiedBackground: withOpacity(diffModified, 0.125),
    lineNumber: s.mutedForeground, lineNumberActive: base.foreground,
    ...c.syntax.highlights,
  };
  const resolvedSyntax = { base, tokens: resolveSyntaxTokens({ base, tokens: c.syntax.tokens }), highlights };
  const theme: Theme = {
    metadata,
    colors: {
      primary: { ...c.primary, foreground: c.primary.foreground ?? onColor(p, s.background), hover: c.primary.hover ?? mixColor(p, neutral, 0.9), active: c.primary.active ?? mixColor(p, neutral, 0.8) },
      surface: s,
      interactive: {
        borderHover: mixColor(c.interactive.border, s.foreground, 0.7), borderFocus: p, focus: p, focusRing: withOpacity(p, 0.5), cursor: base.foreground,
        hover: withOpacity(s.foreground, 0.07), active: withOpacity(s.foreground, 0.12),
        ...c.interactive, selection, selectionForeground: c.interactive.selectionForeground ?? readableText(s.foreground, selection, s.background),
      },
      status: {
        error: error.base, errorForeground: error.foreground, errorBackground: error.background, errorBorder: error.border,
        warning: warning.base, warningForeground: warning.foreground, warningBackground: warning.background, warningBorder: warning.border,
        success: success.base, successForeground: success.foreground, successBackground: success.background, successBorder: success.border,
        info: info.base, infoForeground: info.foreground, infoBackground: info.background, infoBorder: info.border,
      },
      pr: { open: success.base, draft: s.mutedForeground, blocked: warning.base, merged: metadata.variant === 'dark' ? '#8957e5' : '#8250df', closed: error.base, ...c.pr },
      syntax: resolvedSyntax,
      chat: c.chat,
      markdown: c.markdown,
      tools: c.tools,
    },
    config,
  };
  return { ...theme, colors: { ...theme.colors, ...componentColors(theme) } };
}

export const themeSchema = definition.transform(resolveTheme);
export const requireTheme = themeSchema.parse;
export const themeListSchema = z.array(themeSchema.nullable().catch(null)).transform((themes) => themes.filter((theme): theme is Theme => theme !== null));
const draftDefinition = definition.extend({ metadata: themeMetadata.extend({ name: z.string() }) });
export const requireThemeDraft = draftDefinition.transform(resolveTheme).parse;

function compactParsedTheme(source: z.output<typeof definition>): ThemeDefinition {
  const c = source.colors;
  const defaults = resolveTheme({ metadata: source.metadata, colors: {
    primary: { base: c.primary.base },
    surface: { background: c.surface.background, foreground: c.surface.foreground, muted: c.surface.muted, mutedForeground: c.surface.mutedForeground, elevated: c.surface.elevated },
    interactive: { border: c.interactive.border },
    status: { error: c.status.error, warning: c.status.warning, success: c.status.success, info: c.status.info },
    syntax: { base: c.syntax.base },
  } });
  const equal = (a: string, b: string | undefined) => a.toLowerCase() === b?.toLowerCase();
  const prune = <T extends { [key: string]: string | undefined }>(values: T, inherited: { [key: string]: string | undefined }, keep: string[] = []): T => {
    const result = { ...values };
    for (const key of Object.keys(result)) {
      const v = result[key];
      if (v !== undefined && !keep.includes(key) && equal(v, inherited[key])) delete result[key];
    }
    return result;
  };
  c.primary = prune(c.primary, { ...defaults.colors.primary }, ['base']);
  c.surface = prune(c.surface, { ...defaults.colors.surface }, ['background', 'foreground', 'muted', 'mutedForeground', 'elevated']);
  c.interactive = prune(c.interactive, { ...defaults.colors.interactive }, ['border']);
  c.status = prune(c.status, { ...defaults.colors.status }, ['error', 'warning', 'success', 'info']);
  c.syntax.base = prune(c.syntax.base, { background: c.surface.background, foreground: c.surface.foreground }, ['comment', 'keyword', 'string', 'number', 'function', 'variable', 'type', 'operator']);
  if (c.syntax.tokens) {
    for (const key of Object.keys(c.syntax.tokens)) {
      const candidate = { ...c.syntax.tokens };
      delete candidate[key];
      const inherited = resolveSyntaxTokens({ base: defaults.colors.syntax.base, tokens: candidate });
      if (equal(c.syntax.tokens[key], new Map(Object.entries(inherited)).get(key))) delete c.syntax.tokens[key];
    }
    if (!Object.keys(c.syntax.tokens).length) delete c.syntax.tokens;
  }
  if (c.syntax.highlights) {
    const diffColors = ['diffAdded', 'diffRemoved', 'diffModified'];
    const inherited = resolveTheme({ ...source, colors: { ...c, syntax: { base: c.syntax.base, tokens: c.syntax.tokens, highlights: Object.fromEntries(Object.entries(c.syntax.highlights).filter(([key]) => diffColors.includes(key))) } } });
    c.syntax.highlights = prune(c.syntax.highlights, inherited.colors.syntax.highlights ?? {}, diffColors);
  }
  if (c.pr) {
    const inherited = resolveTheme({ ...source, colors: { ...c, pr: undefined } });
    c.pr = prune(c.pr, { ...inherited.colors.pr });
  }
  if (c.chat) {
    c.chat = prune(c.chat, { ...resolveTheme({ ...source, colors: { ...c, chat: undefined } }).colors.chat });
    if (!Object.keys(c.chat).length) delete c.chat;
  }
  if (c.markdown) {
    c.markdown = prune(c.markdown, { ...resolveTheme({ ...source, colors: { ...c, markdown: undefined } }).colors.markdown });
    if (!Object.keys(c.markdown).length) delete c.markdown;
  }
  if (c.tools) {
    const { edit, ...values } = c.tools;
    const { edit: inheritedEdit, ...inherited } = { ...resolveTheme({ ...source, colors: { ...c, tools: undefined } }).colors.tools };
    c.tools = prune(values, inherited);
    if (edit) {
      const overrides = prune(edit, inheritedEdit ?? {});
      if (Object.keys(overrides).length) c.tools.edit = overrides;
    }
    if (!Object.keys(c.tools).length) delete c.tools;
  }
  return source;
}

export const compactTheme = (value: ThemeDefinition): ThemeDefinition => compactParsedTheme(definition.parse(value));
export const compactThemeDraft = (value: ThemeDefinition): ThemeDefinition => compactParsedTheme(draftDefinition.parse(value));
