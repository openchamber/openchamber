import { z } from 'zod';
import type { Theme } from '../../types/theme';
import { mixColor, onColor, readableText, withOpacity } from './color';
import { resolveSyntaxTokens } from './syntax';

const color = z.string().trim().min(1);
const optionalColors = (keys: string[]) => z.record(z.string(), color).transform((values) => Object.fromEntries(Object.entries(values).filter(([key]) => keys.includes(key))));
const primary = z.object({ base: color, foreground: color.optional(), hover: color.optional(), active: color.optional(), muted: color.optional() });
const surface = z.object({ background: color, foreground: color, muted: color, mutedForeground: color, elevated: color, elevatedForeground: color.optional(), overlay: color.optional(), subtle: color.optional() });
const interactive = z.object({ border: color, selection: color.optional(), selectionForeground: color.optional(), borderHover: color.optional(), borderFocus: color.optional(), focus: color.optional(), focusRing: color.optional(), cursor: color.optional(), hover: color.optional(), active: color.optional() });
const status = z.object({
  error: color, errorForeground: color.optional(), errorBackground: color.optional(), errorBorder: color.optional(),
  warning: color, warningForeground: color.optional(), warningBackground: color.optional(), warningBorder: color.optional(),
  success: color, successForeground: color.optional(), successBackground: color.optional(), successBorder: color.optional(),
  info: color, infoForeground: color.optional(), infoBackground: color.optional(), infoBorder: color.optional(),
});
const syntax = z.object({
  base: z.object({ background: color.optional(), foreground: color.optional(), comment: color, keyword: color, string: color, number: color, function: color, variable: color, type: color, operator: color }),
  tokens: z.record(z.string(), color).optional(),
  highlights: z.record(z.string(), color).optional(),
});
const definition = z.object({
  metadata: z.object({ id: color, name: color, variant: z.enum(['light', 'dark']), description: z.string().default(''), version: z.string().default('1.0.0'), author: z.string().optional(), tags: z.array(z.string()).default([]) }),
  colors: z.object({
    primary, surface, interactive, status, syntax,
    pr: z.object({ open: color.optional(), draft: color.optional(), blocked: color.optional(), merged: color.optional(), closed: color.optional() }).optional(),
    chat: optionalColors(['background', 'userMessageBackground', 'divider']).optional(),
    markdown: optionalColors(['link', 'linkHover', 'inlineCode', 'inlineCodeBackground', 'blockquote', 'blockquoteBorder', 'listMarker', 'bold', 'italic', 'strikethrough', 'hr']).optional(),
    tools: z.object({ border: color.optional(), icon: color.optional(), title: color.optional(), description: color.optional(), edit: optionalColors(['addedBackground', 'removedBackground', 'modifiedBackground', 'lineNumber']).optional() }).optional(),
  }),
  config: z.object({ fonts: z.object({ sans: z.string().optional(), mono: z.string().optional(), heading: z.string().optional() }).optional(), transitions: z.object({ fast: z.string().optional(), normal: z.string().optional(), slow: z.string().optional() }).optional() }).optional(),
});

export type ThemeDefinition = z.input<typeof definition>;

/** One boundary for built-ins, custom files and development reloads. */
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
  return {
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
}

export const themeSchema = definition.transform(resolveTheme);
export const requireTheme = themeSchema.parse;
export const themeListSchema = z.array(themeSchema.nullable().catch(null)).transform((themes) => themes.filter((theme): theme is Theme => theme !== null));

/** Remove only semantic defaults, never equal colors belonging to unrelated roles. */
export function compactTheme(value: ThemeDefinition): ThemeDefinition {
  const source = definition.parse(value);
  const c = source.colors;
  const defaults = requireTheme({ metadata: source.metadata, colors: {
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
    // Resolve without each override, so dependent roles remain correct after pruning.
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
    const inherited = requireTheme({ ...source, colors: { ...c, syntax: { base: c.syntax.base, tokens: c.syntax.tokens, highlights: Object.fromEntries(Object.entries(c.syntax.highlights).filter(([key]) => diffColors.includes(key))) } } });
    c.syntax.highlights = prune(c.syntax.highlights, inherited.colors.syntax.highlights ?? {}, diffColors);
  }
  if (c.pr) {
    const inherited = requireTheme({ ...source, colors: { ...c, pr: undefined } });
    c.pr = prune(c.pr, { ...inherited.colors.pr });
  }
  return source;
}
